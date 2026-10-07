/**
 * 大模型客户端：DeepSeek 官方 API（OpenAI 兼容 /chat/completions）。
 * 只依赖 Node 内置 fetch，方便替换成任意兼容服务。
 */

import { AppError, extractJson, isRetryableNetworkError, log, retry, safeJson, truncate } from '../lib/util.js';
import { errorChain, requestFailureDetail } from '../lib/http.js';
import { assertEgressAllowed } from '../lib/privacy.js';

const RETRY_HINT = '（服务端返回 429/5xx，已自动重试；若持续失败请检查额度或稍后再试）';

export class LlmClient {
  constructor(config) {
    this.baseUrl = String(config.baseUrl || '').replace(/\/+$/, '');
    this.apiKey = config.apiKey || '';
    this.model = config.model || 'deepseek-chat';
    this.temperature = config.temperature ?? 0.3;
    this.maxTokens = config.maxTokens ?? 4096;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    this.maxRetries = config.maxRetries ?? 3;
    this.jsonMode = config.jsonMode !== false;
    /*
     * 仅本地模式的硬拦截放在**构造函数**里：这是所有模型调用唯一的必经之路，
     * 放在这里就不存在"某个调用点忘了检查"。而且是构造时就抛错——
     * 用户点「测试」会立刻看到原因，而不是等分析跑到一半才失败。
     */
    assertEgressAllowed(config, this.baseUrl);
  }

  /**
   * 本机地址的大模型服务（Ollama / vLLM / LM Studio）通常**不需要 API Key**。
   * 判断依据只认 loopback 与私有网段，避免把"忘了填 Key"的公网地址也放过去。
   */
  get keyOptional() {
    try {
      const { hostname } = new URL(this.baseUrl);
      return (
        hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1' ||
        hostname === '0.0.0.0' ||
        /^10\./.test(hostname) ||
        /^192\.168\./.test(hostname) ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
      );
    } catch {
      return false;
    }
  }

  get ready() {
    return !!(this.baseUrl && this.model) && (!!this.apiKey || this.keyOptional);
  }

  assertReady() {
    if (!this.baseUrl) throw new AppError('未配置大模型 baseUrl', { code: 'LLM_NOT_CONFIGURED', status: 400 });
    if (!this.apiKey && !this.keyOptional) {
      throw new AppError('未配置大模型 API Key。可在 .env 中设置 DEEPSEEK_API_KEY，或在「模型设置」里填写。', {
        code: 'LLM_NOT_CONFIGURED',
        status: 400,
      });
    }
  }

  /**
   * 调用 chat/completions。
   * @returns {Promise<{ text: string, usage: object|null, model: string }>}
   */
  async complete({ system, user, temperature, maxTokens, jsonMode, label = 'LLM 请求' } = {}) {
    this.assertReady();
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: user });

    const useJson = jsonMode ?? this.jsonMode;
    const body = {
      model: this.model,
      messages,
      temperature: temperature ?? this.temperature,
      max_tokens: maxTokens ?? this.maxTokens,
      stream: false,
    };
    if (useJson) body.response_format = { type: 'json_object' };

    const result = await retry(
      async () => this.#request(body, label),
      {
        attempts: this.maxRetries + 1,
        label,
        shouldRetry: isRetryableNetworkError,
      },
    );
    return result;
  }

  /** 要求模型返回 JSON 对象；解析失败时抛出带原文的错误。 */
  async completeJson({ system, user, temperature, maxTokens, label } = {}) {
    const { text, usage, model } = await this.complete({ system, user, temperature, maxTokens, label });
    const parsed = extractJson(text);
    if (parsed === null || typeof parsed !== 'object') {
      throw new AppError(`${label || '模型输出'} 不是合法 JSON：${truncate(text, 400)}`, {
        code: 'LLM_BAD_JSON',
        status: 502,
      });
    }
    return { data: parsed, usage, model, raw: text };
  }

  async #request(body, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // 失败信息里必须出现**确切的地址**：排查 "fetch failed" 时第一个要回答的就是"打的是哪个 URL"
    const endpoint = `${this.baseUrl}/chat/completions`;
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new AppError(`${label} 超时（>${Math.round(this.timeoutMs / 1000)}s）`, {
          code: 'LLM_TIMEOUT',
          status: 504,
        });
      }
      /*
       * 这里曾经只留一句 `网络错误：fetch failed`——`fetch` 的真正原因（`bad port` /
       * `ECONNREFUSED` / 连接被重置）全在 `err.cause` 里，整条链都在这一行被丢掉，
       * 于是 CI 上红一次就要从"是不是端口"重新猜一遍。现在：
       *   - message 里带上 method + 确切 URL + 最底层原因（服务端日志与 API 响应都能看到）；
       *   - `.cause` 保留原始错误（含它的 cause 链）；
       *   - `.diagnostic` 是完整现场，测试 harness 会原样打印出来。
       * 注意：**不加任何重试**——重试判定仍只看 `code`，一个字没改。
       */
      const chain = errorChain(err);
      const root = chain.length > 1 ? chain[chain.length - 1] : null;
      const rootText = root ? `${root.name || 'Error'}: ${root.message}` : String(err?.message || err);
      /*
       * `bad port` 是 fetch/浏览器规范在**建立连接之前**就拒掉的端口（连错误码都没有），
       * 和网络出口、API Key 都无关——不点明的话，用户只会看到一句莫名其妙的 "bad port"。
       */
      const badPortNote = /bad port/i.test(String(err?.cause?.message || ''))
        ? '——该端口被 fetch/浏览器规范列为**禁用端口**（连接不会被发起），请把模型服务换到其它端口'
        : '';
      const e = new Error(
        `网络错误：${err?.message || err}（POST ${endpoint} 失败；最底层原因：${rootText}）${badPortNote}`,
      );
      /*
       * 给一个稳定的错误码：`fetch failed` 本身没有 code，落到接口层就成了
       * `INTERNAL_ERROR`（500），既看不出是"大模型连不上"，也没法按码分流。
       * 注意重试判定不受影响：`isRetryableNetworkError` 只认那几个连接类错误码，
       * `LLM_NETWORK_ERROR` 不在其中（与修复前 code 为空时的结论一致）。
       */
      e.code = err?.cause?.code || err?.code || 'LLM_NETWORK_ERROR';
      e.cause = err;
      e.diagnostic = requestFailureDetail(err, {
        url: endpoint,
        method: 'POST',
        phase: `${label}：大模型请求失败`,
        extra: { baseUrl: this.baseUrl, model: this.model, timeoutMs: this.timeoutMs },
      });
      e.detail = { requestUrl: endpoint, requestMethod: 'POST', errorChain: chain };
      throw e;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`HTTP ${res.status} ${res.statusText} ${truncate(text, 500)}`);
      err.status = res.status;
      if (res.status === 401 || res.status === 403) {
        throw new AppError(`大模型鉴权失败（HTTP ${res.status}）：请检查 API Key。${truncate(text, 300)}`, {
          code: 'LLM_AUTH_FAILED',
          status: 502,
        });
      }
      if (res.status === 402) {
        throw new AppError('大模型账户余额不足（HTTP 402），请充值后重试。', { code: 'LLM_NO_BALANCE', status: 502 });
      }
      if (res.status === 400 && body.response_format) {
        // 有些兼容服务不支持 response_format，去掉后重试一次
        log.warn(`${label}：服务端不支持 json_object，改为普通模式重试`);
        const { response_format: _drop, ...fallback } = body;
        void _drop;
        return this.#request(fallback, label);
      }
      if (res.status === 429 || res.status >= 500) err.message += RETRY_HINT;
      throw err;
    }

    const json = await res.json().catch(() => null);
    if (!json) throw new AppError(`${label} 返回内容无法解析为 JSON`, { code: 'LLM_BAD_RESPONSE', status: 502 });

    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? '';
    if (!text) {
      log.debug(`LLM 空响应：${safeJson(json).slice(0, 500)}`);
      throw new AppError(`${label} 返回空内容`, { code: 'LLM_EMPTY', status: 502 });
    }
    return { text, usage: json.usage || null, model: json.model || this.model };
  }
}

/** 探活：发一条极短请求确认 Key / 模型可用。 */
export async function pingLlm(config) {
  const client = new LlmClient(config);
  const started = Date.now();
  const { model, usage } = await client.complete({
    system: '你是一个连通性测试助手，只回复 JSON。',
    user: '返回 {"ok":true}',
    maxTokens: 32,
    temperature: 0,
    label: '模型连通性测试',
  });
  return { ok: true, model, latencyMs: Date.now() - started, usage };
}
