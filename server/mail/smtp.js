/**
 * SMTP 发送。默认关闭自动发送：只有前端逐封确认后才会走到这里。
 *
 * 关于连接复用（重要）：
 * 不少企业邮箱（尤其腾讯企业邮箱）在同一账号「短时间内反复认证」时会直接返回
 * `535 Error: authentication failed, system busy`。逐封新建连接再关闭必然踩到这一点，
 * 因此这里对每个邮箱实例维护一个长驻的 nodemailer 连接池，AUTH 只做一次。
 */

import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { AppError, log, retry } from '../lib/util.js';
import { identitySender, textToHtml } from './compose.js';

export const AUTH_METHODS = [
  { id: 'auto', label: '自动协商（默认）' },
  { id: 'PLAIN', label: '强制 AUTH PLAIN' },
  { id: 'LOGIN', label: '强制 AUTH LOGIN' },
];

/** 长驻连接池：key 只含连接与凭据，凭据变化会自动换一条新连接。 */
const pools = new Map();
const POOL_IDLE_MS = 5 * 60_000;

function poolKey(instance, authMethod) {
  const { smtp } = instance;
  const fingerprint = [smtp.host, smtp.port, smtp.secure ? 'ssl' : 'plain', smtp.authUser, smtp.authPass, authMethod].join('\u0000');
  return `${instance.id}:${crypto.createHash('sha1').update(fingerprint).digest('hex').slice(0, 12)}`;
}

/** 关闭并清空连接池。改配置后、退出前调用。 */
export function resetTransportPools({ instanceId } = {}) {
  let closed = 0;
  for (const [key, entry] of pools) {
    if (instanceId && entry.instanceId !== instanceId) continue;
    try {
      entry.transport.close();
      closed += 1;
    } catch {
      /* ignore */
    }
    pools.delete(key);
  }
  if (closed) log.debug(`已关闭 ${closed} 个 SMTP 连接池`);
  return closed;
}

/* ------------------------------------------------------------ 建连接 */

function transportOptions(instance, options = {}) {
  const { smtp, identity } = instance;
  const authMethod = options.authMethod || smtp.authMethod || 'auto';
  const auth = { user: smtp.authUser, pass: smtp.authPass };
  // nodemailer 10 读 auth.method，7.x 读 auth.authMethod；两个都设以兼容
  if (authMethod !== 'auto') {
    auth.method = authMethod;
    auth.authMethod = authMethod;
  }
  // nodemailer 只有在拿到 auth 对象时才会去认证；空凭据时置空，避免抛 EDNS
  const useAuth = !!(smtp.authUser && smtp.authPass);
  return {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: useAuth ? auth : undefined,
    // EHLO 名称用本机域名，避免暴露内网主机名
    name: identity.email ? identity.email.split('@')[1] : undefined,
    pool: options.pool !== false,
    maxConnections: options.maxConnections ?? 2,
    maxMessages: options.maxMessages ?? 100,
    connectionTimeout: options.connectionTimeoutMs ?? 20_000,
    greetingTimeout: options.greetingTimeoutMs ?? 15_000,
    socketTimeout: options.socketTimeoutMs ?? 60_000,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: options.logger ?? false,
    debug: options.debug ?? false,
  };
}

export function createTransport(instance, options = {}) {
  return nodemailer.createTransport(transportOptions(instance, options));
}

/** 取长驻连接池里的 transport（按需创建）。 */
function pooledTransport(instance) {
  const key = poolKey(instance, instance.smtp.authMethod || 'auto');
  const existing = pools.get(key);
  if (existing) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = setTimeout(() => {
      try {
        existing.transport.close();
      } catch {
        /* ignore */
      }
      pools.delete(key);
      log.debug(`SMTP 连接池空闲回收：${instance.label || instance.id}`);
    }, POOL_IDLE_MS);
    existing.idleTimer.unref?.();
    return existing.transport;
  }
  const transport = createTransport(instance, { pool: true });
  const entry = { transport, instanceId: instance.id, idleTimer: null };
  entry.idleTimer = setTimeout(() => {
    try {
      transport.close();
    } catch {
      /* ignore */
    }
    pools.delete(key);
  }, POOL_IDLE_MS);
  entry.idleTimer.unref?.();
  pools.set(key, entry);
  return transport;
}

/* ------------------------------------------------------------ 错误解释 */

export function wrapSmtpError(err, instance) {
  const raw = err?.response || err?.message || String(err);
  const code = err?.code || 'SMTP_ERROR';
  const host = instance.smtp?.host || '';
  const method = instance.smtp?.authMethod || 'auto';
  let hint = '';

  if (/system busy/i.test(raw)) {
    // 腾讯企业邮箱特有：AUTH 被拒、认证过于频繁、或同账号已有登录会话
    hint =
      '服务器以「system busy」拒绝了认证，常见于：① 同一账号短时间内反复认证；② 该账号在其它客户端有登录会话；' +
      '③ SMTP 未开启或授权码未生效。建议：关闭邮件客户端里的同账号会话后稍等 1 分钟重试；' +
      '仍失败则到邮箱后台重新生成客户端专用密码，并在「设置 → 认证方式」改为「强制 AUTH LOGIN」再试。';
  } else if (/535|534|Invalid login|Username and Password not accepted|authentication failed|认证失败/i.test(raw)) {
    hint =
      '认证被拒绝。请确认 SMTP 账号与授权码一致，且使用的是「客户端专用密码 / 授权码」而不是网页登录密码。' +
      (method === 'auto' ? '若确认无误仍失败，可在「设置 → 认证方式」切换为「强制 AUTH LOGIN」再试。' : '');
    if (/exmail\.qq\.com/i.test(host)) {
      hint += '腾讯企业邮箱需在「邮箱设置 → 客户端设置」中开启 SMTP 并生成专用密码。';
    } else if (/office365|outlook/i.test(host)) {
      hint += 'Microsoft 365 多数租户已禁用基本认证，需管理员为该账号开启 SMTP AUTH。';
    } else if (/gmail/i.test(host)) {
      hint += 'Gmail 需先开启两步验证，再使用「应用专用密码」。';
    }
  } else if (/550|553|sender|From address|not allowed to send/i.test(raw)) {
    hint = '服务器拒绝发件人地址，请确认「发件人邮箱」与 SMTP 账号属于同一域名。';
  } else if (/certificate|self signed|unable to verify/i.test(raw)) {
    hint = 'TLS 证书校验失败，请确认服务器证书；自签证书需在服务器侧修复证书链。';
  } else if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN/i.test(raw)) {
    hint = '无法连接 SMTP 服务器，请检查地址、端口、加密方式与网络出口。';
  } else if (/5\d\d/.test(raw)) {
    hint = '服务器拒绝了本次投递，请核对上面的原始错误信息。';
  }

  return new AppError(`SMTP 发信失败（${instance.label || instance.id}）：${raw}${hint ? ` — ${hint}` : ''}`, {
    code,
    status: 502,
    detail: { server: `${host}:${instance.smtp?.port}`, authUser: instance.smtp?.authUser, authMethod: method },
  });
}

/** 网络/服务端临时故障才重试；认证与信封错误重试没有意义（还会加剧 system busy）。 */
function shouldRetrySend(err) {
  const code = err?.code || '';
  if (['EAUTH', 'EENVELOPE', 'EMESSAGE', 'EDNS'].includes(code)) return false;
  const raw = String(err?.response || err?.message || '');
  if (/system busy|authentication failed|535|534|Invalid login/i.test(raw)) return false;
  return true;
}

/* ------------------------------------------------------------ 自检 */

/**
 * 验证 SMTP 连接与认证。使用一次性连接（不入池），避免自检占用长连接。
 * @returns {Promise<{ok: true, authMethod: string|null}>}
 */
export async function verifyTransport(instance, options = {}) {
  const transport = createTransport(instance, { ...options, pool: false });
  try {
    await transport.verify();
    return { ok: true, authMethod: options.authMethod || instance.smtp?.authMethod || 'auto' };
  } catch (err) {
    throw wrapSmtpError(err, instance);
  } finally {
    transport.close();
  }
}

/* ------------------------------------------------------------ 发送 */

/**
 * 从原始邮件头里解析出信封收发件人（nodemailer 对 raw 邮件的解析偶有取不到收件人的情况，
 * 这里显式推导一次作为兜底，避免"没有收件人"这类失败）。
 */
function envelopeFromRaw(raw, instance) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
  const headerEnd = text.search(/\r?\n\r?\n/);
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const get = (name) => {
    const m = header.match(new RegExp(`^${name}:\\s*([\\s\\S]*?)(?=\\r?\\n[^\\s]|$)`, 'im'));
    return m ? m[1].replace(/\r?\n\s+/g, ' ').trim() : '';
  };
  const addresses = (value) => (value.match(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w-]+(?:\.[\w-]+)+/g) || []).map((a) => a.trim());
  const to = [...addresses(get('To')), ...addresses(get('Cc')), ...addresses(get('Bcc'))];
  const from = addresses(get('From'))[0] || identitySender(instance.identity)?.address;
  return { from, to };
}

/**
 * 发送一封已经组装好的 MIME 原文。
 *
 * 走 raw 通道而不是让 nodemailer 重新构建 MIME：这样「发出去的邮件」与
 * 「写进草稿箱的邮件」字节一致，也避免库在重新编码时折行导致部分收件端解析异常。
 * 连接复用实例级连接池，避免逐封重新 AUTH 触发服务端限流。
 *
 * @param {object} instance
 * @param {Buffer|string} raw RFC822 原文
 * @param {object} options { envelope: {from, to}, label }
 */
export async function sendRaw(instance, raw, options = {}) {
  if (typeof raw?.then === 'function') {
    throw new AppError('sendRaw 收到了 Promise 而不是 MIME 原文（调用方需先 await 组装结果）', {
      code: 'RAW_IS_PROMISE',
      status: 500,
    });
  }

  const derived = envelopeFromRaw(raw, instance);
  const explicit = options.envelope?.to?.length ? options.envelope : null;
  const envelope = {
    from: explicit?.from || derived.from,
    to: explicit?.to || derived.to,
  };
  if (!envelope.from || !envelope.to?.length) {
    throw new AppError('无法确定收件人，邮件未发送（请检查草稿的收件人字段）。', {
      code: 'ENVELOPE_INCOMPLETE',
      status: 400,
    });
  }

  // 先按配置的认证方式发；若被服务端以认证问题拒绝，自动换另一种方式再试一次。
  const configured = instance.smtp?.authMethod || 'auto';
  const attempts = [configured];
  if (configured === 'auto') attempts.push('LOGIN', 'PLAIN');

  let lastErr = null;
  for (let i = 0; i < attempts.length; i += 1) {
    const authMethod = attempts[i];
    const isFallback = i > 0;
    // 回退尝试必须用「不入池的全新连接」：仅 clear 连接池时，nodemailer 可能仍复用
    // 已经认证失败的底层连接，导致换了认证方式却还是原机制。
    const usePool = options.pool !== false && !isFallback;
    try {
      const transport = usePool
        ? pooledTransport({ ...instance, smtp: { ...instance.smtp, authMethod } })
        : createTransport(instance, { pool: false, authMethod });
      const info = await retry(() => transport.sendMail({ raw, envelope }), {
        attempts: isFallback ? 1 : 3,
        label: options.label || 'SMTP 发送',
        shouldRetry: shouldRetrySend,
      });
      if (isFallback) {
        log.warn(`SMTP 以 ${authMethod} 认证成功（已自动切换，建议在「设置 → 认证方式」固定为该方式）`);
      }
      log.info(`已发送：${info.messageId} → ${(info.accepted || []).join(',')}`);
      if (!usePool) transport.close();
      return {
        messageId: info.messageId,
        accepted: info.accepted || [],
        rejected: info.rejected || [],
        response: info.response || '',
        authMethod,
        switchedAuthMethod: isFallback,
      };
    } catch (err) {
      lastErr = err;
      const authProblem = /system busy|535|534|Invalid login|authentication failed|认证失败|EAUTH/i.test(
        String(err?.response || err?.message || ''),
      );
      if (!authProblem || i === attempts.length - 1) break;
      log.warn(`SMTP 使用 ${authMethod} 认证失败，尝试下一种认证方式`);
    }
  }

  if (lastErr instanceof AppError) throw lastErr;
  throw wrapSmtpError(lastErr, instance);
}

/**
 * 发送一封回复（结构化字段，由 nodemailer 组装 MIME）。
 * 预览类场景用；正式发送请优先用 sendRaw 以保持内容一致。
 */
export async function sendMessage(instance, message, options = {}) {
  const transport = options.pool === false ? createTransport(instance, { pool: false }) : pooledTransport(instance);
  try {
    const from = message.from?.address ? message.from : identitySender(instance.identity);
    if (!from?.address) {
      throw new AppError('发件人邮箱未配置，无法发送（请在「邮箱设置 → 发件身份」中填写）。', {
        code: 'SENDER_NOT_CONFIGURED',
        status: 400,
      });
    }
    const payload = {
      from: from.name ? { name: from.name, address: from.address } : from.address,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html || textToHtml(message.text),
      inReplyTo: message.inReplyTo || undefined,
      references: message.references?.length ? message.references : undefined,
      headers: message.headers || undefined,
      replyTo: message.replyTo || instance.identity.replyTo || undefined,
    };
    if (message.cc) payload.cc = message.cc;
    if (message.bcc) payload.bcc = message.bcc;

    const info = await retry(() => transport.sendMail(payload), {
      attempts: 3,
      label: 'SMTP 发送',
      shouldRetry: shouldRetrySend,
    });
    log.info(`已发送：${info.messageId} → ${Array.isArray(message.to) ? message.to.join(',') : message.to}`);
    return {
      messageId: info.messageId,
      accepted: info.accepted || [],
      rejected: info.rejected || [],
      response: info.response || '',
    };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw wrapSmtpError(err, instance);
  } finally {
    // 池化连接不在这里关闭；非池化连接用完即关
    if (options.pool === false) transport.close();
  }
}
