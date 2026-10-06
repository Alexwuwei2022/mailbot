/**
 * 短期会话：用 Cookie 取代浏览器里那个"永久令牌"。
 *
 * ## 为什么要换
 *
 * 原来的做法是把访问令牌直接给浏览器：存在 localStorage，SSE 还要拼在 URL 上
 * （`/api/events?token=…`）。这有三个真实问题：
 *
 * 1. URL 里的令牌会进**浏览器历史、代理日志、Referer 头**；
 * 2. localStorage 里的令牌**永不过期**，一台用过就忘的电脑等于长期留了一把钥匙；
 * 3. 服务端无法"登出"——令牌是配置里的常量，只能改配置，改了所有设备一起失效。
 *
 * 换成会话后：Cookie 带 `HttpOnly`（JS 读不到）`SameSite=Strict`（跨站不发），
 * 有**空闲超时**与**绝对超时**，可以单独登出，且关闭浏览器后仍然有效（持久 Cookie，
 * 免得每次开页面都要重新输令牌）。
 *
 * ## 为什么存在内存里
 *
 * 会话是"这台设备此刻有没有通过验证"的临时状态，不是需要长期保存的数据。
 * 放内存意味着**重启服务即全部失效**（要重新输入令牌）——这在安全性上是加分项，
 * 而且省掉了一个必须防篡改的落盘文件。代价是重启后要重登一次，可以接受。
 */

import crypto from 'node:crypto';

/** 默认策略：空闲 12 小时、绝对 7 天、最多 20 个会话 */
export const SESSION_DEFAULTS = { idleHours: 12, absoluteDays: 7, maxSessions: 20 };

export const SESSION_COOKIE = 'mailbot_session';

function policy(config) {
  const web = config?.web || {};
  const num = (v, d) => (Number(v) > 0 ? Number(v) : d);
  return {
    idleMs: num(web.sessionIdleHours, SESSION_DEFAULTS.idleHours) * 3600_000,
    absoluteMs: num(web.sessionAbsoluteDays, SESSION_DEFAULTS.absoluteDays) * 86400_000,
    max: num(web.sessionMaxCount, SESSION_DEFAULTS.maxSessions),
  };
}

/** id → { createdAt, lastSeen, ip, agent } */
const sessions = new Map();

function newId() {
  return crypto.randomBytes(32).toString('base64url');
}

function sweep(now = Date.now(), config) {
  const pol = policy(config);
  for (const [id, s] of sessions.entries()) {
    if (now - s.lastSeen > pol.idleMs || now - s.createdAt > pol.absoluteMs) sessions.delete(id);
  }
}

/**
 * 建一个会话。
 *
 * 超过上限时**淘汰最久未使用**的那个：不限数量的话，一个能拿到令牌的人
 * 可以无限灌会话把内存吃满。
 */
export function createSession({ ip = 'unknown', agent = '' } = {}, config, now = Date.now()) {
  const pol = policy(config);
  sweep(now, config);
  while (sessions.size >= pol.max) {
    let oldest = null;
    let oldestSeen = Infinity;
    for (const [id, s] of sessions.entries()) {
      if (s.lastSeen < oldestSeen) {
        oldestSeen = s.lastSeen;
        oldest = id;
      }
    }
    if (oldest) sessions.delete(oldest);
    else break;
  }
  const id = newId();
  sessions.set(id, { createdAt: now, lastSeen: now, ip, agent: String(agent).slice(0, 120) });
  return { id, ...policyOf(config) };
}

function policyOf(config) {
  const pol = policy(config);
  return { idleMs: pol.idleMs, absoluteMs: pol.absoluteMs };
}

/**
 * 校验并续期。
 *
 * 每次访问都刷新 `lastSeen`（滑动过期）：一直在用的人不该被踢下线；
 * 但**绝对超时不会因为活跃而延长**——会话最长就是那么多天，之后必须重新验证。
 */
export function touchSession(id, config, now = Date.now()) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  const pol = policy(config);
  if (now - s.lastSeen > pol.idleMs) {
    sessions.delete(id);
    return null;
  }
  if (now - s.createdAt > pol.absoluteMs) {
    sessions.delete(id);
    return null;
  }
  s.lastSeen = now;
  return { ...s, id };
}

export function destroySession(id) {
  return id ? sessions.delete(id) : false;
}

/** 登出所有设备（改了令牌之后用得上）。 */
export function destroyAllSessions() {
  const n = sessions.size;
  sessions.clear();
  return n;
}

export function sessionCount(config, now = Date.now()) {
  sweep(now, config);
  return sessions.size;
}

export function listSessions(config, now = Date.now()) {
  sweep(now, config);
  return [...sessions.entries()].map(([id, s]) => ({
    id: `${id.slice(0, 6)}…`,
    createdAt: new Date(s.createdAt).toISOString(),
    lastSeen: new Date(s.lastSeen).toISOString(),
    ip: s.ip,
    agent: s.agent,
  }));
}

export function resetSessions() {
  sessions.clear();
}

/* ------------------------------------------------------------------ Cookie */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function readSessionId(req) {
  return parseCookies(req.headers?.cookie)[SESSION_COOKIE] || '';
}

/**
 * 生成 Set-Cookie 值。
 *
 * `SameSite=Strict` 是这里最要紧的一项：跨站请求根本不带 Cookie，
 * 再叠加同源校验与 Host 校验，CSRF 基本没有立足点。
 * 走 HTTPS 时加 `Secure`（纯 HTTP 下加会让 Cookie 完全失效，所以按协议决定）。
 */
export function sessionCookie(id, { https = false, maxAgeSec = 7 * 86400 } = {}) {
  return [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    https ? 'Secure' : null,
  ]
    .filter(Boolean)
    .join('; ');
}

export function clearCookie({ https = false } = {}) {
  return [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0', https ? 'Secure' : null]
    .filter(Boolean)
    .join('; ');
}
