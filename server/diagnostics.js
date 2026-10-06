/**
 * 自检：逐项验证邮箱配置与大模型连通性，给出可读的中文结论。
 */

import { getConfig, getInstance, validateInstance, validateLlm } from './config/index.js';
import { LlmClient, pingLlm } from './llm/client.js';
import { connect, findDraftsMailbox, listMailboxes, safeLogout } from './mail/imap.js';
import { verifyTransport } from './mail/smtp.js';
import { hoursAgo } from './lib/util.js';
import { describeNetworkError, httpRequest, resolveProxyFor } from './lib/http.js';

/**
 * 探测本机到 Google 的网络出口。
 *
 * 用 Google 的 `generate_204`（固定返回 204，无内容）作为探针：它不消耗 API 配额、不需要令牌，
 * 因此能把「网络不通」和「凭据/权限问题」彻底分开——这正是「邮件正常、日历报错」时最需要区分的一件事。
 */
async function probeGoogle({ proxy = '', timeoutMs = 8000 } = {}) {
  const endpoint = `${(process.env.MAILBOT_GOOGLE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, '')}/generate_204`;
  try {
    // 探针直连本地模拟服务器时不需要走代理
    const usedProxy = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(endpoint) ? '' : proxy;
    const res = await httpRequest(endpoint, { method: 'GET', timeoutMs, proxy: usedProxy });
    const via = res.viaProxy ? `经代理 ${res.viaProxy.raw}` : '直连';
    // 关键：只要**收到了响应**就说明网络出口是通的。
    // 401/403/404 之类只说明请求本身不合规，不影响「能不能连上 Google」这个结论——
    // 自检要回答的是「出口通不通」，不是「我这次请求合不合法」。
    if (res.status < 500) {
      const note = res.status >= 200 && res.status < 400 ? '' : `（HTTP ${res.status}，但网络出口是通的）`;
      return { ok: true, elapsedMs: res.elapsedMs, message: `可达（${res.elapsedMs}ms，${via}）${note}` };
    }
    return { ok: false, code: `HTTP_${res.status}`, message: `Google 返回 HTTP ${res.status}，${via}；网络通了但上游异常，请稍后重试` };
  } catch (err) {
    const info = describeNetworkError(err, { target: 'Google', proxyUsed: safeProxyInfo(proxy) });
    return { ok: false, code: info.code, message: `${info.message} — ${info.advice}` };
  }
}

function safeProxyInfo(proxy) {
  try {
    return resolveProxyFor('https://www.googleapis.com', { proxy: proxy || '' });
  } catch {
    return null;
  }
}

/**
 * @param {object} options { instanceId, deep }
 */
export async function runDiagnostics({ instanceId, deep = false } = {}) {
  const config = getConfig();
  const checks = [];
  const push = (id, label, status, message, extra) => {
    checks.push({ id, label, status, message, ...(extra ? { extra } : {}) });
    return status;
  };

  /* 1. 配置完整性 */
  let instance = null;
  try {
    instance = getInstance(instanceId);
  } catch (err) {
    push('instance', '邮箱实例', 'error', err.message);
    return { ok: false, checks, instanceId: instanceId || null };
  }

  const problems = validateInstance(instance);
  push(
    'config',
    '邮箱配置完整性',
    problems.length ? 'error' : 'ok',
    problems.length ? problems.join('；') : `IMAP ${instance.imap.host}:${instance.imap.port}（${instance.imap.secure ? 'SSL' : '明文/STARTTLS'}），SMTP ${instance.smtp.host}:${instance.smtp.port}（${instance.smtp.secure ? 'SSL' : 'STARTTLS'}）`,
  );

  const llmProblems = validateLlm(config);
  push(
    'llm-config',
    '大模型配置',
    llmProblems.length ? 'error' : 'ok',
    llmProblems.length ? llmProblems.join('；') : `${config.llm.model} @ ${config.llm.baseUrl}`,
  );

  /* 2. IMAP */
  let imap = null;
  let draftsMailbox = null;
  try {
    imap = await connect(instance);
    const boxes = await listMailboxes(imap);
    draftsMailbox = await findDraftsMailbox(imap, config.draft.draftsMailbox);
    push(
      'imap',
      'IMAP 连接与认证',
      'ok',
      `连接成功，共 ${boxes.length} 个文件夹`,
      {
        mailboxes: boxes.map((b) => ({ path: b.path, name: b.name, specialUse: b.specialUse })),
        draftsMailbox,
      },
    );
    push(
      'imap-drafts',
      '草稿箱定位',
      draftsMailbox ? 'ok' : 'warn',
      draftsMailbox ? `将把 AI 草稿写入：${draftsMailbox}` : '未找到草稿箱（\\Drafts），草稿将只保存在本地',
    );

    if (deep) {
      try {
        const lock = await imap.getMailboxLock(config.scan.folders[0] || 'INBOX', { readOnly: true });
        try {
          const since = hoursAgo(config.scan.windowHours);
          const uids = await imap.search({ since }, { uid: true });
          push(
            'imap-window',
            `近 ${config.scan.windowHours} 小时邮件量`,
            'ok',
            `${config.scan.folders[0] || 'INBOX'} 中有 ${uids?.length || 0} 封（单次上限 ${config.scan.maxMessages} 封）`,
          );
        } finally {
          lock.release();
        }
      } catch (err) {
        push('imap-window', '邮件量探测', 'warn', `探测失败：${err?.message || err}`);
      }
    }
  } catch (err) {
    push('imap', 'IMAP 连接与认证', 'error', err.message, err.detail);
  } finally {
    if (imap) await safeLogout(imap);
  }

  /* 3. SMTP：先按配置的认证方式验，失败时逐个换方式试，直接给出可用的那一种 */
  const configuredMethod = instance.smtp.authMethod || 'auto';
  const methodOrder = configuredMethod === 'auto' ? ['auto', 'LOGIN', 'PLAIN'] : [configuredMethod, 'auto', 'LOGIN', 'PLAIN'];
  const triedMethods = [];
  let smtpOk = false;
  let lastSmtpError = null;

  for (const method of [...new Set(methodOrder)]) {
    try {
      await verifyTransport(instance, { pool: false, authMethod: method });
      smtpOk = true;
      const label = method === 'auto' ? '自动协商' : `AUTH ${method}`;
      if (method === configuredMethod) {
        push('smtp', 'SMTP 连接与认证', 'ok', `${instance.smtp.host}:${instance.smtp.port} 认证通过（${label}）`);
      } else {
        push(
          'smtp',
          'SMTP 连接与认证',
          'warn',
          `按配置的「${configuredMethod === 'auto' ? '自动协商' : configuredMethod}」认证失败，但以「${label}」认证成功。` +
            `请到「设置 → 认证方式」固定为 ${method}。（上次错误：${lastSmtpError?.message || '认证被拒绝'}）`,
        );
      }
      break;
    } catch (err) {
      triedMethods.push(method);
      lastSmtpError = err;
    }
  }

  if (!smtpOk) {
    push(
      'smtp',
      'SMTP 连接与认证',
      'error',
      `已尝试 ${triedMethods.map((m) => (m === 'auto' ? '自动协商' : `AUTH ${m}`)).join('、')}，均失败：${lastSmtpError?.message || '认证被拒绝'}`,
      lastSmtpError?.detail,
    );
    if (instance.smtp.host && instance.smtp.port === 587 && instance.smtp.secure) {
      push('smtp-port', 'SMTP 加密方式提示', 'warn', '端口 587 通常应使用 STARTTLS（把「加密方式」设为 STARTTLS / 明文）而不是 SSL。');
    }
  }

  /* 4. 大模型 */
  if (!llmProblems.length) {
    try {
      const client = new LlmClient(config.llm);
      const r = await pingLlm(client);
      push('llm', '大模型调用', 'ok', `${r.model} 响应正常（${r.latencyMs}ms）`);
    } catch (err) {
      push('llm', '大模型调用', 'error', err.message);
    }
  } else {
    push('llm', '大模型调用', 'skipped', '缺少 API Key，已跳过');
  }

  /* 5. Google 网络出口（日历）——「邮件正常但日历报 fetch failed」几乎都出在这一步 */
  const calendar = config.calendar || {};
  if (!calendar.enabled) {
    push('google-network', 'Google 网络出口', 'skipped', '未启用日历数字人，已跳过');
  } else {
    let proxyInfo = null;
    let proxyBroken = false;
    try {
      proxyInfo = resolveProxyFor('https://www.googleapis.com', { proxy: calendar.proxy || '' });
    } catch (err) {
      proxyBroken = true;
      push('google-network', 'Google 网络出口', 'error', `代理配置有误：${err.message}`);
    }
    if (!proxyBroken) {
      const probe = await probeGoogle({ proxy: calendar.proxy || '' });
      push('google-network', 'Google 网络出口', probe.ok ? 'ok' : 'error', probe.message, {
        networkCode: probe.code || null,
        proxy: proxyInfo?.raw || null,
        elapsedMs: probe.elapsedMs || null,
      });
      if (calendar.proxy && probe.ok) {
        push('google-proxy', 'Google 代理', 'ok', `已通过代理 ${calendar.proxy} 访问 Google`);
      }
    }
  }

  /* 6. 发送策略提示 */
  push(
    'policy',
    '发送策略',
    config.draft.sendPolicy === 'draft_only' ? 'warn' : 'ok',
    config.draft.sendPolicy === 'draft_only'
      ? '当前只存草稿、不发送'
      : config.draft.sendPolicy === 'confirm'
        ? '草稿需在界面逐封确认后发送（推荐）'
        : 'auto：允许自动发送，请确认这是你想要的',
  );

  /* 7. 连接复用提示：说明为什么连续发送不会反复认证 */
  push('smtp-pool', 'SMTP 连接复用', 'ok', '同一邮箱的发送复用一条已认证连接，避免反复 AUTH 触发服务端限流（system busy）');

  const ok = checks.every((c) => c.status === 'ok' || c.status === 'skipped');
  return { ok, instanceId: instance.id, checks, draftsMailbox };
}
