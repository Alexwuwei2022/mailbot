/**
 * 极简 HTTP(S) 客户端 + **代理支持**（零依赖）。
 *
 * 为什么不直接用全局 `fetch`：
 *   1. Node 的 `fetch`（undici）**不读** `HTTP_PROXY` / `HTTPS_PROXY`，也不看 Windows/macOS 的
 *      系统代理设置。于是会出现「浏览器能打开 Google，本程序却报 fetch failed」这种看起来矛盾的现象。
 *   2. `fetch` 失败时只抛一句 `TypeError: fetch failed`，把真正的底层原因
 *      （`ENOTFOUND` / `ETIMEDOUT` / `ECONNRESET` / 证书错误）藏在 `err.cause` 里，
 *      使用者完全无法据此排查。
 *
 * 所以这里直接用 `node:https` / `node:http`，并支持通过 HTTP 代理的 `CONNECT` 隧道访问 HTTPS 目标，
 * 同时把底层错误码原样保留下来（`describeNetworkError` 会把它翻译成中文可执行提示）。
 *
 * 代理地址的来源（按优先级）：
 *   1. 显式传入的 `proxy`（来自配置 `calendar.proxy`）
 *   2. 环境变量 `MAILBOT_GOOGLE_PROXY`
 *   3. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` / `all_proxy`
 * 回环地址（127.0.0.1 / localhost / ::1）与命中 `NO_PROXY` 的主机永远直连。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export const DEFAULT_TIMEOUT_MS = 30_000;

/** 回环地址：本机模拟服务器、本地代理自身的探测等一律直连。 */
function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost') || /^127\./.test(h);
}

/** 解析代理地址字符串，支持 `http://user:pass@host:port` 或裸 `host:port`。 */
export function parseProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    const err = new Error(`代理地址无法解析：${raw}。正确写法如 http://127.0.0.1:7890`);
    err.code = 'PROXY_INVALID';
    throw err;
  }
  const protocol = url.protocol.replace(':', '').toLowerCase();
  if (protocol === 'socks' || protocol === 'socks5' || protocol === 'socks4' || protocol === 'socks5h') {
    const err = new Error(
      `暂不支持 SOCKS 代理（${raw}）。请在代理软件里开启「HTTP 代理」端口（如 127.0.0.1:7890）并填那一个。`,
    );
    err.code = 'PROXY_SOCKS_UNSUPPORTED';
    throw err;
  }
  if (protocol !== 'http' && protocol !== 'https') {
    const err = new Error(`不支持的代理协议「${protocol}」，只支持 http://（绝大多数代理软件提供的都是 HTTP 端口）`);
    err.code = 'PROXY_INVALID';
    throw err;
  }
  if (!url.hostname) {
    const err = new Error(`代理地址缺少主机名：${raw}`);
    err.code = 'PROXY_INVALID';
    throw err;
  }
  return {
    protocol,
    host: url.hostname,
    port: Number(url.port || (protocol === 'https' ? 443 : 80)),
    auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || '')}` : '',
    raw,
  };
}

/** NO_PROXY：逗号分隔的主机后缀列表，`*` 表示全部直连。 */
function matchesNoProxy(hostname, noProxy) {
  const list = String(noProxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  const h = String(hostname || '').toLowerCase();
  return list.some((entry) => entry === '*' || h === entry || h.endsWith(`.${entry}`) || h.endsWith(entry));
}

/**
 * 决定某个目标是否走代理。
 *
 * 规则（顺序很重要）：
 *   1. 命中 NO_PROXY → 直连；
 *   2. **显式配置的代理**（界面里填的 `calendar.proxy`）一律生效，回环地址也不例外——
 *      否则「填了代理却不生效」会变成新的困惑源；
 *   3. 回环地址（127.0.0.1 / localhost / ::1）直连：本机模拟服务、本地探测不该被代理劫持；
 *   4. 其余情况看环境变量。
 *
 * @returns {object|null} 代理配置；null 表示直连
 */
export function resolveProxyFor(target, { proxy, noProxy, env = process.env } = {}) {
  const hostname = typeof target === 'string' ? new URL(target).hostname : target.hostname;
  if (matchesNoProxy(hostname, noProxy ?? env.NO_PROXY ?? env.no_proxy)) return null;
  const explicit = String(proxy || '').trim();
  if (explicit) return parseProxy(explicit);
  if (isLoopback(hostname)) return null;
  const raw =
    env.MAILBOT_GOOGLE_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    '';
  return parseProxy(raw);
}

/** 当前生效的代理（不针对具体目标，仅用于界面/自检展示）。 */
export function activeProxy(proxy) {
  try {
    return resolveProxyFor('https://www.googleapis.com', { proxy });
  } catch (err) {
    return { error: err.message, code: err.code || 'PROXY_INVALID', raw: String(proxy || '') };
  }
}

/* ------------------------------------------------------------ 请求 */

function proxyAuthHeader(proxy) {
  return proxy.auth ? { 'proxy-authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}` } : {};
}

/**
 * 发起一次 HTTP(S) 请求。
 *
 * @param {string|URL} url
 * @param {object} options
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {string|Buffer} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.proxy] 显式代理地址（覆盖环境变量）
 * @param {string} [options.noProxy]
 * @returns {Promise<{ok:boolean,status:number,statusText:string,headers:object,text:string,viaProxy:object|null,elapsedMs:number}>}
 */
export async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    proxy,
    noProxy,
    env = process.env,
  } = options;

  const target = url instanceof URL ? url : new URL(String(url));
  const isHttps = target.protocol === 'https:';
  if (!isHttps && target.protocol !== 'http:') {
    const err = new Error(`不支持的协议：${target.protocol}`);
    err.code = 'UNSUPPORTED_PROTOCOL';
    throw err;
  }

  const proxyCfg = resolveProxyFor(target, { proxy, noProxy, env });
  const started = Date.now();
  const requestOptions = {
    method,
    headers: { ...headers },
    timeout: timeoutMs,
  };
  if (body !== undefined && body !== null) {
    requestOptions.headers['content-length'] = Buffer.byteLength(body);
  }

  const res = await new Promise((resolve, reject) => {
    const fail = (err) => reject(err);

    const onResponse = (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: response.headers || {},
          buffer,
          text: buffer.toString('utf8'),
        });
      });
      response.on('error', (err) => fail(err));
    };

    const attachTimeout = (req) => {
      req.setTimeout(timeoutMs, () => {
        const err = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
      req.on('error', (err) => fail(err));
      return req;
    };

    /* ---------- 直连 ---------- */
    if (!proxyCfg) {
      const mod = isHttps ? https : http;
      const req = attachTimeout(
        mod.request(
          {
            ...requestOptions,
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            headers: { ...requestOptions.headers, host: target.host },
          },
          onResponse,
        ),
      );
      if (body !== undefined && body !== null) req.write(body);
      req.end();
      return;
    }

    /* ---------- 经代理：HTTPS 走 CONNECT 隧道 ---------- */
    if (isHttps) {
      const connectMod = proxyCfg.protocol === 'https' ? https : http;
      const targetPort = target.port || 443;
      const connectReq = attachTimeout(
        connectMod.request({
          host: proxyCfg.host,
          port: proxyCfg.port,
          method: 'CONNECT',
          path: `${target.hostname}:${targetPort}`,
          headers: { host: `${target.hostname}:${targetPort}`, ...proxyAuthHeader(proxyCfg) },
          timeout: timeoutMs,
        }),
      );
      connectReq.on('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          const err = new Error(`代理拒绝建立隧道（HTTP ${response.statusCode}）`);
          err.code = response.statusCode === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_FAILED';
          fail(err);
          return;
        }
        const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
          const req = https.request(
            {
              ...requestOptions,
              hostname: target.hostname,
              port: targetPort,
              path: `${target.pathname}${target.search}`,
              headers: { ...requestOptions.headers, host: target.host },
              /*
               * 这里**不能写 `agent: false`**（曾经有，是个隐蔽的真 bug）。
               *
               * Node 的 ClientRequest 构造函数里：
               *   agent === false  →  agent = new Agent()   （一个一次性 Agent）
               *   agent == null    →  只有在 `createConnection` 不是函数时才用全局 Agent
               * 而 `createConnection` 只在**没有 agent** 时才会被调用（见 _http_client.js：
               * `if (this.agent) this.agent.addRequest(...) else { ...options.createConnection(...) }`）。
               *
               * 所以 `agent: false` 会让 Node 建一个一次性 Agent、**直接忽略我们的 createConnection**，
               * 于是刚建好的 CONNECT 隧道 socket 被丢掉，它自己去直连 Google ——
               * 在国内的表现就是 ECONNRESET 或 30 秒超时，而日志看起来"代理已连上"。
               *
               * 本机实测（Node v24.14.1，纯回环，目标用永不解析的域名以区分两种行为）：
               *   agent:false + createConnection → ERROR: ECONNRESET   （createConnection 被忽略）
               *   不传 agent   + createConnection → RESPONSE: LIVE      （生效）
               *   agent:null   + createConnection → RESPONSE: LIVE      （生效）
               */
              createConnection: () => tlsSocket,
            },
            onResponse,
          );
          req.setTimeout(timeoutMs, () => {
            const err = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
            err.code = 'ETIMEDOUT';
            req.destroy(err);
          });
          req.on('error', (err) => fail(err));
          if (body !== undefined && body !== null) req.write(body);
          req.end();
        });
        tlsSocket.on('error', (err) => fail(err));
      });
      connectReq.end();
      return;
    }

    /* ---------- 经代理：HTTP 用绝对 URI 直接请求代理 ---------- */
    const req = attachTimeout(
      http.request(
        {
          ...requestOptions,
          host: proxyCfg.host,
          port: proxyCfg.port,
          path: target.href,
          headers: { ...requestOptions.headers, host: target.host, ...proxyAuthHeader(proxyCfg) },
        },
        onResponse,
      ),
    );
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  });

  // 407 只会来自代理：必须当成「代理问题」抛出，否则会被上层误判成「Google 拒绝了请求」。
  if (res.status === 407 || res.headers['proxy-authenticate']) {
    const err = new Error('代理要求身份验证（HTTP 407）');
    err.code = 'PROXY_AUTH_REQUIRED';
    err.proxy = proxyCfg?.raw || null;
    throw err;
  }

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    buffer: res.buffer,
    text: res.text,
    viaProxy: proxyCfg,
    elapsedMs: Date.now() - started,
  };
}

/** 便捷方法：发 JSON（或表单）并解析 JSON 响应。 */
export async function httpJson(url, { body, json, form, headers, ...rest } = {}) {
  const finalHeaders = { accept: 'application/json', ...(headers || {}) };
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    finalHeaders['content-type'] = 'application/json';
  } else if (form !== undefined) {
    payload = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString();
    finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
  }
  const res = await httpRequest(url, { ...rest, headers: finalHeaders, body: payload });
  let data = null;
  try {
    data = res.text ? JSON.parse(res.text) : null;
  } catch {
    /* 非 JSON */
  }
  return { ...res, data };
}

/* ------------------------------------------------------------ 错误翻译 */

const NETWORK_HINTS = {
  ENOTFOUND: 'DNS 解析失败——本机找不到这个域名。可能是没有外网 DNS 出口，或域名被污染。',
  EAI_AGAIN: 'DNS 解析暂时失败（EAI_AGAIN）。请检查本机 DNS / 网络是否稳定。',
  ECONNREFUSED: '连接被拒绝——目标端口或代理端口没有服务在监听。若填了代理，请确认代理软件正在运行且端口正确。',
  ETIMEDOUT: '连接超时——本机到这个地址的网络出口不通。国内网络访问 Google 必须走代理。',
  ECONNRESET: '连接被重置——常见于网络中间设备阻断了该连接。',
  EPIPE: '连接被对端提前关闭。',
  EHOSTUNREACH: '主机不可达。',
  ENETUNREACH: '网络不可达。',
  CERT_HAS_EXPIRED: '证书已过期。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务器证书——如果代理在做 TLS 中间人，请改用 HTTP 代理的 CONNECT 模式或把代理根证书加入系统信任。',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器证书是自签名的，无法验证。',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配——通常是代理在中间替换了证书。',
  PROXY_AUTH_REQUIRED: '代理要求身份验证（407）。请在代理地址里写成 http://用户名:密码@主机:端口。',
  PROXY_CONNECT_FAILED: '代理拒绝为这个地址建立隧道。请确认代理允许访问该域名。',
  PROXY_INVALID: '代理地址格式不对，正确写法如 http://127.0.0.1:7890。',
  PROXY_SOCKS_UNSUPPORTED: '不支持 SOCKS 代理，请填代理软件的 HTTP 端口。',
};

/**
 * 把底层网络错误翻译成「原因 + 下一步怎么做」。
 * @param {Error} err
 * @param {object} options { target, proxyUsed }
 */
export function describeNetworkError(err, { target = 'Google', proxyUsed = null } = {}) {
  const code = err?.code || err?.cause?.code || '';
  const rawMessage = err?.message || String(err);
  const hint = NETWORK_HINTS[code] || '';
  const proxyNote = proxyUsed
    ? `当前已配置代理 ${proxyUsed.raw}，请确认代理软件正在运行、且允许访问 ${target}。`
    : `当前**没有**配置代理。如果这台机器需要借助代理/VPN 才能访问 ${target}，` +
      '请到「设置 → 日历数字人 → 网络代理」填写代理软件提供的 HTTP 端口（如 http://127.0.0.1:7890）。';
  return {
    code: code || 'NETWORK_ERROR',
    message: `${rawMessage}${hint ? `（${hint}）` : ''}`,
    hint,
    proxyUsed: proxyUsed?.raw || null,
    advice: proxyNote,
  };
}
