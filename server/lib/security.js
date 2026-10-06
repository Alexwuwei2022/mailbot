/**
 * HTTP 安全边界：Host 校验（防 DNS rebinding）、安全响应头、失败登录限速。
 *
 * ## 为什么这三件事必须一起做
 *
 * 这个程序默认只监听 127.0.0.1，于是很容易产生"本机就安全"的错觉。实际有三类攻击
 * 专门打这种本地工具：
 *
 * 1. **DNS rebinding**：攻击者的域名先解析到自己的服务器、再改解析到 127.0.0.1。
 *    浏览器于是把恶意页面的请求发到本机服务上，而且 `Origin` 看起来是"同源"的
 *    （同一域名），同源校验形同虚设。**唯一可靠的判别是 Host 头**：
 *    浏览器必须带上攻击者的域名，而本机服务的正常访问只会是 localhost / IP。
 *    所以规则是：**只接受回环名、IP 字面量、以及用户显式登记过的域名**。
 * 2. **令牌被猜到 / 被暴力试**：局域网里暴露一个"永久令牌"入口，没有失败限速的话，
 *    弱令牌几分钟就能被穷举。因此失败要限速，且失败本身要留痕。
 * 3. **浏览器把我方响应当成别的东西**：缺 `nosniff` / `frame-ancestors` 时，
 *    被 iframe 嵌套（点击劫持）或内容嗅探都可能被利用。安全头很便宜，直接全带上。
 */

import crypto from 'node:crypto';
import os from 'node:os';
import { listSessions, sessionCount, SESSION_DEFAULTS } from './session.js';

/* ------------------------------------------------------------------ Host 校验 */

/** 回环相关的名字：这些永远是"本机访问" */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0']);

/** IPv4 字面量（含私网段）：IP 不能被 DNS rebinding 利用，所以一律放行 */
function isIpLiteral(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((p) => Number(p) >= 0 && Number(p) <= 255);
  }
  // IPv6：带方括号或含冒号
  return /^\[[0-9a-f:]+\]$/.test(host) || /^[0-9a-f:]+$/i.test(host) && host.includes(':');
}

/**
 * Host 头是否可接受。
 *
 * @returns {{ok: boolean, reason?: string, host: string}}
 */
export function checkHost(req, config) {
  const raw = String(req.headers.host || '');
  const host = raw.replace(/:\d+$/, '').toLowerCase();
  if (!host) return { ok: false, host, reason: '缺少 Host 头' };
  if (LOOPBACK_HOSTS.has(host)) return { ok: true, host };
  if (isIpLiteral(host)) return { ok: true, host };

  // 域名：只认用户显式登记过的（用于域名/反向代理访问）
  const allowed = Array.isArray(config?.web?.allowedHosts) ? config.web.allowedHosts : [];
  const hit = allowed.map((h) => String(h).trim().toLowerCase()).filter(Boolean);
  if (hit.includes(host)) return { ok: true, host };

  return {
    ok: false,
    host,
    reason:
      `Host「${raw}」不在允许列表里。若你确实要通过这个域名访问，请把它加入「设置 → 访问与安全 → 允许的域名」；` +
      '若你没配过域名，这通常意味着有人正用 DNS rebinding 把你的浏览器引到本机服务上。',
  };
}

/* ------------------------------------------------------------------ 安全响应头 */

/**
 * 安全响应头。
 *
 * CSP 里 `script-src 'self'`（不含 unsafe-inline）是刻意的：为此把 index.html 里
 * 那段"防主题闪烁"的内联脚本挪到了 `/theme-boot.js`（同步加载，仍然不会闪）。
 * 样式仍允许 inline，因为界面大量使用 `style="…"` 属性。
 */
export function securityHeaders({ https = false } = {}) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
  return {
    'content-security-policy': csp,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
    'cross-origin-opener-policy': 'same-origin',
    // 只有真的走 HTTPS 时才声明 HSTS，否则纯 HTTP 访问会被浏览器升级到打不开
    ...(https ? { 'strict-transport-security': 'max-age=86400' } : {}),
  };
}

/* ------------------------------------------------------------------ 失败登录限速 */

/**
 * 按来源 IP 统计失败次数。
 *
 * 刻意是**内存态**：进程重启即清空。限速的目的是抬高暴力破解成本，
 * 不是永久封禁——把误封的用户挡在门外，比被猜中一次更糟。
 */
const failures = new Map();

export const THROTTLE_DEFAULTS = { maxFailures: 10, windowMinutes: 5, blockMinutes: 5 };

function throttleConfig(config) {
  const web = config?.web || {};
  return {
    maxFailures: Number(web.authMaxFailures) > 0 ? Number(web.authMaxFailures) : THROTTLE_DEFAULTS.maxFailures,
    windowMinutes: Number(web.authWindowMinutes) > 0 ? Number(web.authWindowMinutes) : THROTTLE_DEFAULTS.windowMinutes,
    blockMinutes: Number(web.authBlockMinutes) > 0 ? Number(web.authBlockMinutes) : THROTTLE_DEFAULTS.blockMinutes,
  };
}

/** 请求来源 IP（默认不信任 X-Forwarded-For，只有显式开启才用）。 */
export function clientIp(req, config) {
  if (config?.web?.trustProxy) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return String(req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

/** 现在是否被限速。返回 {blocked, retryAfterSec, reason} */
export function checkThrottle(ip, config, now = Date.now()) {
  const cfg = throttleConfig(config);
  const rec = failures.get(ip);
  if (!rec) return { blocked: false };
  if (rec.blockedUntil && rec.blockedUntil > now) {
    return {
      blocked: true,
      retryAfterSec: Math.ceil((rec.blockedUntil - now) / 1000),
      reason: `失败次数过多（${rec.count} 次），已暂时拒绝来自 ${ip} 的请求`,
    };
  }
  // 窗口滚过去了就重新计数
  if (now - rec.firstAt > cfg.windowMinutes * 60_000) failures.delete(ip);
  return { blocked: false };
}

/** 记一次失败，返回 {blocked, count, retryAfterSec} */
export function recordFailure(ip, config, now = Date.now()) {
  const cfg = throttleConfig(config);
  const rec = failures.get(ip) || { count: 0, firstAt: now, blockedUntil: 0 };
  if (now - rec.firstAt > cfg.windowMinutes * 60_000) {
    rec.count = 0;
    rec.firstAt = now;
    rec.blockedUntil = 0;
  }
  rec.count += 1;
  if (rec.count >= cfg.maxFailures) rec.blockedUntil = now + cfg.blockMinutes * 60_000;
  failures.set(ip, rec);
  return {
    blocked: rec.blockedUntil > now,
    count: rec.count,
    retryAfterSec: rec.blockedUntil > now ? Math.ceil((rec.blockedUntil - now) / 1000) : 0,
  };
}

/** 成功一次就清零：正常用户偶尔输错不该积累到被封。 */
export function recordSuccess(ip) {
  failures.delete(ip);
}

/** 供界面/测试查看（不含敏感信息）。 */
export function throttleStatus(config, now = Date.now()) {
  const cfg = throttleConfig(config);
  const list = [];
  for (const [ip, rec] of failures.entries()) {
    list.push({
      ip,
      count: rec.count,
      blocked: !!(rec.blockedUntil && rec.blockedUntil > now),
      retryAfterSec: rec.blockedUntil > now ? Math.ceil((rec.blockedUntil - now) / 1000) : 0,
    });
  }
  return { config: cfg, entries: list };
}

export function resetThrottle() {
  failures.clear();
}

/* ------------------------------------------------------------------ 令牌强度 */

/**
 * 评估访问令牌强度。返回 {level, score, advice}。
 *
 * 只做**基于熵的粗略判断**（长度 + 字符集），不做字典查表——
 * 目的是拦住"123456"这种，而不是给密码打分。
 */
export function tokenStrength(token) {
  const t = String(token || '');
  if (!t) return { level: 'none', score: 0, advice: '尚未设置访问令牌：任何能访问该地址的人都能直接使用，请立刻生成一个' };
  const len = t.length;
  let charset = 0;
  if (/[a-z]/.test(t)) charset += 26;
  if (/[A-Z]/.test(t)) charset += 26;
  if (/\d/.test(t)) charset += 10;
  if (/[^A-Za-z0-9]/.test(t)) charset += 32;
  const bits = len * Math.log2(Math.max(charset, 2));
  if (/^(.)\1+$/.test(t) || /^(123456|password|admin|mailbot|000000)/i.test(t)) {
    return { level: 'weak', score: 0, bits: Math.round(bits), advice: '这个令牌太好猜了，请重新生成' };
  }
  if (bits >= 128) return { level: 'strong', score: bits, advice: '足够强' };
  if (bits >= 80) return { level: 'ok', score: bits, advice: '可用；若要暴露到局域网建议 32 位以上随机串' };
  return { level: 'weak', score: bits, advice: '太短了，建议至少 32 位随机字符（可直接点「生成新令牌」）' };
}

/** 生成一个强令牌（32 字节 → base64url，约 43 字符）。 */
export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/* ------------------------------------------------------------------ 安全状态报告 */

/** 本机的局域网 IPv4 地址（用来**如实**告诉用户"别人能从哪访问到你"）。 */
export function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const [name, list] of Object.entries(ifaces || {})) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal) out.push({ iface: name, address: info.address });
    }
  }
  return out;
}

/**
 * 安全现状：绑定在哪、谁能访问、令牌强不强、会话怎么管、有没有 HTTPS。
 *
 * 这个报告的立场是"**把风险说出来**"，不是给个绿灯就完事：
 * 监听 0.0.0.0 时它会直接列出局域网可达地址，并逐项检查（令牌强度、HTTPS、域名白名单）。
 */
export function securityReport({ config, port, https = false, tls = null } = {}) {
  const web = config?.web || {};
  const host = String(web.host || '127.0.0.1');
  const loopbackOnly = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const token = String(web.authToken || '');
  const strength = tokenStrength(token);
  const scheme = https ? 'https' : 'http';
  const lans = loopbackOnly ? [] : lanAddresses();

  const checks = [];
  if (loopbackOnly) {
    checks.push({
      level: 'ok',
      title: '只监听本机',
      detail: `绑定在 ${host}：只有这台电脑上的程序能访问，这是最安全的默认值`,
    });
  } else {
    checks.push({
      level: token ? 'warn' : 'error',
      title: '监听地址不止本机',
      detail:
        `绑定在 ${host}：同一网络里的其他设备可以访问这个服务。` +
        (token ? '已设置访问令牌。' : '**当前没有访问令牌**，任何能连上的人都能使用！'),
    });
    for (const l of lans) {
      checks.push({ level: 'warn', title: '局域网可达地址', detail: `${scheme}://${l.address}:${port}（网卡 ${l.iface}）` });
    }
  }

  if (!token) {
    checks.push({ level: 'error', title: '访问令牌为空', detail: strength.advice });
  } else {
    checks.push({
      level: strength.level === 'strong' ? 'ok' : strength.level === 'ok' ? 'warn' : 'error',
      title: `访问令牌强度：${strength.level === 'strong' ? '强' : strength.level === 'ok' ? '可用' : '弱'}`,
      detail: `${strength.bits ? `约 ${strength.bits} 位熵。` : ''}${strength.advice}`,
    });
  }

  checks.push(
    https
      ? {
          level: tls?.selfSigned ? 'warn' : 'ok',
          title: tls?.selfSigned ? 'HTTPS（自签证书）' : 'HTTPS（自有证书）',
          detail: tls?.selfSigned
            ? `传输已加密，但浏览器会提示"不受信任"（自签证书无法证明身份）。指纹 ${tls.fingerprint256}`
            : `传输已加密，证书指纹 ${tls?.fingerprint256 || '—'}`,
        }
      : {
          level: loopbackOnly ? 'ok' : 'warn',
          title: '未启用 HTTPS',
          detail: loopbackOnly
            ? '只监听本机时，明文流量不出本机，风险很低'
            : '局域网内的流量是**明文**：同网段的人可以在链路上看到内容（含令牌）。建议启用 HTTPS',
        },
  );

  const allowed = Array.isArray(web.allowedHosts) ? web.allowedHosts.filter(Boolean) : [];
  checks.push({
    level: 'ok',
    title: 'Host 白名单（防 DNS rebinding）',
    detail: allowed.length
      ? `已额外允许域名：${allowed.join('、')}。其余域名一律拒绝——即使有人把域名解析到本机也进不来`
      : '只接受 localhost、回环地址与 IP 字面量。域名一律拒绝（这正是 DNS rebinding 无法绕过的原因）',
  });

  checks.push({
    level: 'ok',
    title: '会话策略',
    detail:
      `登录后浏览器只拿 Cookie（HttpOnly + SameSite=Strict），空闲 ${web.sessionIdleHours || SESSION_DEFAULTS.idleHours} 小时过期、` +
      `最长 ${web.sessionAbsoluteDays || SESSION_DEFAULTS.absoluteDays} 天必须重新登录；重启服务即全部失效。当前会话数 ${sessionCount(config)}`,
  });

  return {
    host,
    port,
    loopbackOnly,
    scheme,
    https,
    tls: tls ? { source: tls.source, selfSigned: !!tls.selfSigned, fingerprint256: tls.fingerprint256, notAfter: tls.notAfter || null } : null,
    token: { set: !!token, strength: strength.level, bits: strength.bits || 0, advice: strength.advice },
    allowedHosts: allowed,
    trustProxy: !!web.trustProxy,
    lanAddresses: lans,
    sessions: { count: sessionCount(config), list: listSessions(config) },
    throttle: throttleStatus(config),
    checks,
    /** 至少这条要显眼：有任何一个 error 就是"现在就该处理" */
    worst: checks.some((c) => c.level === 'error') ? 'error' : checks.some((c) => c.level === 'warn') ? 'warn' : 'ok',
  };
}
