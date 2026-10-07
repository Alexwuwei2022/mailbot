/**
 * Google OAuth2（Web 应用授权码流程）与令牌管理。
 *
 * 不引入 googleapis（解包 200MB+），直接调用 Google 的 OAuth2 与 Calendar REST 端点。
 *
 * 令牌**存在哪**由 `server/calendar/google-token.js` 决定（本文件只管 OAuth 流程）：
 *   - 默认：`data/google-token.json`（权限 600），格式
 *     `{ refreshToken, accessToken, expiresAt, scope, tokenType, email, savedAt }`
 *   - 迁入保管库之后：系统钥匙串 / DPAPI（config 作用域，日历是全局单账号），
 *     明文文件被删掉；读不到时**明确报错**，不会静默假装"未连接"
 * refresh_token 只在首次授权（或带 prompt=consent）时下发，因此**必须落盘**，
 * 否则每次重启都要重新授权。
 */

import crypto from 'node:crypto';
import { getConfig } from '../config/index.js';
import { AppError, log } from '../lib/util.js';
import { DEFAULT_TIMEOUT_MS, describeNetworkError, httpRequest, resolveProxyFor } from '../lib/http.js';
import { clearToken, readToken, tokenStatus, tryReadToken, writeToken } from './google-token.js';

/** 允许通过环境变量覆盖，测试时指向本地模拟服务器。 */
function oauthBase() {
  return (process.env.MAILBOT_GOOGLE_OAUTH_BASE || 'https://accounts.google.com').replace(/\/+$/, '');
}
function tokenBase() {
  return (process.env.MAILBOT_GOOGLE_TOKEN_BASE || 'https://oauth2.googleapis.com').replace(/\/+$/, '');
}

export function authEndpoint() {
  return `${oauthBase()}/o/oauth2/v2/auth`;
}
export function tokenEndpoint() {
  return `${tokenBase()}/token`;
}
export function revokeEndpoint() {
  return `${tokenBase()}/revoke`;
}

/** 最小权限：只需要管理日程事件（创建/修改/读取）。 */
export const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

/** 进行中的授权会话（state → 会话信息），防止 CSRF 与串号。 */
const pendingAuth = new Map();
const PENDING_TTL_MS = 10 * 60_000;

/* ------------------------------------------------------------ 令牌存取 */

/*
 * 令牌的**存放**（保管库 / 明文文件）与"读不出来怎么报"都在 google-token.js，
 * 这里只做转发，保证：
 *   - 旧数据（只有 data/google-token.json）仍然能被正常读取使用；
 *   - 保管库不可用 / 令牌文件损坏时**抛可识别的错误**（`GOOGLE_TOKEN_*`），
 *     上层据此提示"需要重新授权"，而不是静默当成"未连接"。
 */
export { readToken, tryReadToken, writeToken, clearToken };
export { tokenStatus as tokenStorageStatus } from './google-token.js';

/**
 * 记下"这个 refresh token 已经不被 Google 接受了"。
 *
 * 为什么必须落盘记下来：
 *   1. `connectionStatus()` 要靠它把「已连接」改成「需要重新授权」，否则界面会
 *      一边显示"已连接"一边每个请求都失败；
 *   2. 避免每次操作都去撞一次注定失败的刷新（白等一个网络往返）。
 *
 * **不丢弃令牌本身**：里面的 email/scope 等还能帮用户判断"上次连的是哪个账号"，
 * 而且万一是网络抖动造成的误判，用户重新授权会直接覆盖它。
 * （令牌现在可能住在保管库里，所以这里是"写回它原来在的地方"，不是"写文件"。）
 */
export function markTokenRevoked(reason) {
  const token = readToken();
  if (!token) return null;
  const next = {
    ...token,
    revokedAt: new Date().toISOString(),
    lastRefreshError: String(reason || '').slice(0, 300),
  };
  log.warn(`Google 授权已失效，需要重新连接：${next.lastRefreshError}`);
  return writeToken(next);
}

/* ------------------------------------------------------------ 配置校验 */

export function googleConfig() {
  const { calendar } = getConfig();
  return {
    clientId: calendar.google.clientId || '',
    clientSecret: calendar.google.clientSecret || '',
    redirectUri: calendar.google.redirectUri || '',
  };
}

export function validateGoogleConfig({ requireSecret = true } = {}) {
  const cfg = googleConfig();
  const problems = [];
  if (!cfg.clientId) problems.push('缺少 OAuth 客户端 ID（clientId）');
  if (requireSecret && !cfg.clientSecret) problems.push('缺少 OAuth 客户端密钥（clientSecret）');
  if (!cfg.redirectUri) problems.push('缺少回调地址（redirectUri）');
  if (cfg.redirectUri && !/^https?:\/\/[^\s]+$/.test(cfg.redirectUri)) problems.push('回调地址格式不正确，应为 http(s)://…');
  return { ok: problems.length === 0, problems, config: cfg };
}

/**
 * 凭据来源说明。用于把「明明填了却说缺失」这类困惑解释清楚：
 * 服务端只读已保存的配置（config.json / .env），界面里尚未保存的输入不会被采纳。
 */
export function describeGoogleCredentialSources() {
  const cfg = googleConfig();
  const fromEnv = {
    clientId: !!(process.env.GOOGLE_CLIENT_ID || process.env.MAILBOT_GOOGLE_CLIENT_ID),
    clientSecret: !!(process.env.GOOGLE_CLIENT_SECRET || process.env.MAILBOT_GOOGLE_CLIENT_SECRET),
    redirectUri: !!process.env.MAILBOT_GOOGLE_REDIRECT_URI,
  };
  const source = (value, envFlag) => (envFlag ? '.env' : value ? 'config.json' : '未配置');
  return {
    clientId: source(cfg.clientId, fromEnv.clientId),
    clientSecret: source(cfg.clientSecret, fromEnv.clientSecret),
    redirectUri: source(cfg.redirectUri, fromEnv.redirectUri),
  };
}

/** 未配置时的统一错误（带上来源与操作指引）。 */
export function googleNotConfiguredError(problems) {
  const sources = describeGoogleCredentialSources();
  const missing = [];
  if (sources.clientId === '未配置') missing.push('客户端 ID');
  if (sources.clientSecret === '未配置') missing.push('客户端密钥');
  if (sources.redirectUri === '未配置') missing.push('回调地址');
  const hint = missing.length
    ? `服务端只读取已保存的配置，目前 ${missing.join('、')} 未保存：请在「设置 → 日历数字人」填好后点「保存配置」（点「测试连接」也会先自动保存）。`
    : '请确认填写内容非空且格式正确。';
  return new AppError(`Google 日历未配置完成：${problems.join('；')}。${hint}`, {
    code: 'GOOGLE_NOT_CONFIGURED',
    status: 400,
    detail: { problems, sources },
  });
}

/** 回调地址默认值：按当前 Web 服务地址推导，方便用户直接回填到 Google Cloud。 */
export function suggestedRedirectUri({ host, port } = {}) {
  const { web } = getConfig();
  const h = host || (web.host === '0.0.0.0' ? '127.0.0.1' : web.host) || '127.0.0.1';
  const p = port || web.port;
  return `http://${h}:${p}/api/calendar/oauth/callback`;
}

/* ------------------------------------------------------------ 授权开始 */

/**
 * 生成授权 URL 并登记 state。
 * @returns {{url: string, state: string, redirectUri: string, scopes: string[]}}
 */
export function startAuth({ redirectUri } = {}) {
  const cfg = googleConfig();
  const configured = redirectUri || cfg.redirectUri;
  const { ok, problems } = validateGoogleConfig({ requireSecret: false });
  if (!ok && !configured) {
    throw googleNotConfiguredError(problems);
  }
  if (!configured) {
    throw new AppError('缺少回调地址（redirectUri）', { code: 'GOOGLE_NOT_CONFIGURED', status: 400 });
  }

  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

  pendingAuth.set(state, { createdAt: Date.now(), redirectUri: configured, codeVerifier });
  // 清理过期会话
  for (const [key, value] of pendingAuth) {
    if (Date.now() - value.createdAt > PENDING_TTL_MS) pendingAuth.delete(key);
  }

  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: configured,
    response_type: 'code',
    scope: SCOPES.join(' '),
    // offline + consent：确保每次都能拿到 refresh_token
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return { url: `${authEndpoint()}?${params.toString()}`, state, redirectUri: configured, scopes: SCOPES };
}

export function consumeAuthState(state) {
  const session = pendingAuth.get(state);
  if (!session) return null;
  pendingAuth.delete(state);
  if (Date.now() - session.createdAt > PENDING_TTL_MS) return null;
  return session;
}

/* ------------------------------------------------------------ 换取令牌 */

async function postForm(endpoint, form, label) {
  const started = Date.now();
  let res;
  try {
    // Google 的 OAuth 端点同样需要走代理（与 Calendar API 共用 calendar.proxy）
    res = await httpRequest(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      proxy: getConfig().calendar?.proxy || '',
    });
  } catch (err) {
    if (err?.code === 'ETIMEDOUT') {
      throw new AppError(`${label}超时（>${DEFAULT_TIMEOUT_MS / 1000}s）— 本机到 Google 的网络出口不通。`, {
        code: 'GOOGLE_TIMEOUT',
        status: 504,
      });
    }
    const info = describeNetworkError(err, { target: 'Google', proxyUsed: safeProxy() });
    throw new AppError(`${label}失败：${info.message} — ${info.advice}`, {
      code: 'GOOGLE_NETWORK_ERROR',
      status: 502,
      detail: { networkCode: info.code, hint: info.hint, proxy: info.proxyUsed, advice: info.advice },
    });
  }
  const text = res.text;
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应 */
  }
  return { ok: res.ok, status: res.status, json, text, elapsedMs: Date.now() - started };
}

/** 当前代理配置（解析失败时返回带 error 的对象，供提示使用）。 */
function safeProxy() {
  try {
    return resolveProxyFor('https://oauth2.googleapis.com', { proxy: getConfig().calendar?.proxy || '' });
  } catch (err) {
    return { error: err.message, code: err.code || 'PROXY_INVALID', raw: String(getConfig().calendar?.proxy || '') };
  }
}

/**
 * 用授权码换取令牌。
 */
export async function exchangeCode(code, state) {
  const session = consumeAuthState(state);
  if (!session) {
    throw new AppError('授权状态无效或已过期，请重新点击「连接 Google 日历」。', {
      code: 'OAUTH_STATE_INVALID',
      status: 400,
    });
  }
  const { ok, problems, config } = validateGoogleConfig();
  if (!ok) {
    throw googleNotConfiguredError(problems);
  }

  const form = new URLSearchParams({
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: session.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: session.codeVerifier,
  });
  const res = await postForm(tokenEndpoint(), form, '换取 Google 令牌');
  if (!res.ok || !res.json?.access_token) {
    const reason = res.json?.error_description || res.json?.error || res.text.slice(0, 200);
    throw new AppError(`Google 授权失败（HTTP ${res.status}）：${reason}`, {
      code: 'OAUTH_EXCHANGE_FAILED',
      status: 502,
      detail: { redirectUri: session.redirectUri },
    });
  }
  return saveTokenResponse(res.json, { scope: res.json.scope });
}

/**
 * 用 refresh_token 刷新 access_token。
 */
export async function refreshAccessToken(token) {
  const { ok, problems, config } = validateGoogleConfig();
  if (!ok) {
    throw googleNotConfiguredError(problems);
  }
  if (!token?.refreshToken) {
    throw new AppError('缺少 refresh_token，请重新连接 Google 日历。', { code: 'OAUTH_NO_REFRESH_TOKEN', status: 401 });
  }
  const form = new URLSearchParams({
    refresh_token: token.refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
  });
  const res = await postForm(tokenEndpoint(), form, '刷新 Google 令牌');
  if (!res.ok || !res.json?.access_token) {
    const reason = res.json?.error_description || res.json?.error || res.text.slice(0, 200);
    /*
     * `invalid_grant` = 授权已被撤销或过期，**必须重新授权**。
     *
     * 把这件事记到 token 文件里（`markTokenRevoked`），这样：
     *   - 界面不再谎称「已连接」，而是提示需要重新连接；
     *   - 后续请求直接快速失败，不再每次白撞一次注定失败的刷新。
     */
    if (res.json?.error === 'invalid_grant') {
      markTokenRevoked(reason);
      throw new AppError(refreshRevokedMessage({ lastRefreshError: reason }), { code: 'OAUTH_REFRESH_REVOKED', status: 401 });
    }
    throw new AppError(`Google 令牌刷新失败（HTTP ${res.status}）：${reason}`, { code: 'OAUTH_REFRESH_FAILED', status: 401 });
  }
  // 刷新响应通常不含 refresh_token，需保留原有的
  return saveTokenResponse({ ...res.json, refresh_token: token.refreshToken }, { scope: token.scope });
}

function saveTokenResponse(json, { scope } = {}) {
  const expiresIn = Number(json.expires_in) || 3600;
  const previous = readToken() || {};
  const token = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || previous.refreshToken || null,
    // 提前 2 分钟视为过期，避免边界上刚好过期
    expiresAt: new Date(Date.now() + Math.max(60, expiresIn - 120) * 1000).toISOString(),
    scope: json.scope || scope || previous.scope || SCOPES.join(' '),
    tokenType: json.token_type || previous.tokenType || 'Bearer',
    email: previous.email || null,
    savedAt: new Date().toISOString(),
  };
  writeToken(token);
  return token;
}

/**
 * 取一个可用的 access_token（必要时自动刷新）。
 */
export async function getAccessToken({ force = false } = {}) {
  const token = readToken();
  if (!token) {
    throw new AppError(
      '尚未连接 Google 日历。请到「设置 → 日历」或日历页点击「连接 Google 日历」。' +
        (validateGoogleConfig().ok ? '（凭据已配置，只差授权这一步）' : ''),
      {
        code: 'GOOGLE_NOT_CONNECTED',
        status: 401,
      },
    );
  }
  const notExpired = token.expiresAt && new Date(token.expiresAt).getTime() > Date.now();
  if (!force && token.accessToken && notExpired) return token.accessToken;
  /*
   * 已经被判定失效的 refresh token 不要再撞一次：
   * 注定失败，白等一个网络往返，还会把日志刷满。直接把"怎么修"告诉用户。
   */
  if (token.revokedAt) {
    throw new AppError(refreshRevokedMessage(token), { code: 'OAUTH_REFRESH_REVOKED', status: 401 });
  }
  const refreshed = await refreshAccessToken(token);
  return refreshed.accessToken;
}

/** 授权失效时统一的说明文案（含**最可能的原因**与具体操作）。 */
function refreshRevokedMessage(token) {
  return (
    'Google 授权已失效，需要重新连接。' +
    '最常见的原因是：Google Cloud 里这个应用的**发布状态仍是「测试」**——' +
    '测试状态下 refresh token 只有 **7 天**有效期，到期后必须重新授权。' +
    '到「设置 → 日历」点「连接 Google 日历」即可恢复；' +
    '若想以后不再每 7 天重来一次，把 OAuth 同意屏幕的发布状态改为「已发布」（生产）。' +
    (token?.lastRefreshError ? `（Google 返回：${token.lastRefreshError}）` : '')
  );
}

/** 撤销授权并清除本地令牌。 */
export async function revoke() {
  const token = readToken();
  if (token?.refreshToken || token?.accessToken) {
    try {
      await postForm(revokeEndpoint(), new URLSearchParams({ token: token.refreshToken || token.accessToken }), '撤销 Google 授权');
    } catch (err) {
      log.warn(`撤销 Google 授权失败（已清除本地令牌）：${err?.message || err}`);
    }
  }
  clearToken();
  return { ok: true };
}

/** 连接状态（供界面展示）。 */
export function connectionStatus() {
  /*
   * 读令牌可能失败（保管库换了机器/换了账户解不开、令牌文件被写坏）。
   * 这里**不抛**（这个函数被日历页与状态接口调用，抛出去整页就白了），
   * 但也**绝不谎称"未连接"**：把失败如实放进 `tokenError`，界面据此显示
   * "需要重新授权 / 保管库读不出来"。
   */
  const read = tryReadToken();
  const token = read.ok ? read.token : null;
  const cfg = validateGoogleConfig();
  const { calendar } = getConfig();
  /*
   * ⚠️ `connected` 曾经只看"文件里有没有 refreshToken"。
   *
   * 但 refresh token **会失效**：同意屏幕处于「测试」发布状态时 Google 只给它
   * **7 天**寿命，用户也可能在账号里撤销授权。这时文件里明明有 token、页面显示「已连接」，
   * 而每个请求都失败——**界面承诺与实际能力对不上**，用户只能困惑。
   *
   * 刷新失败（invalid_grant）会被 `markTokenRevoked` 记在令牌里，这里据此说实话。
   */
  const revoked = !!token?.revokedAt;
  return {
    enabled: calendar.enabled,
    configured: cfg.ok,
    configProblems: cfg.problems,
    connected: !!token?.refreshToken && !revoked,
    /** 授权已失效，必须重新点「连接 Google 日历」 */
    needsReauth: revoked,
    revokedAt: token?.revokedAt || null,
    lastRefreshError: token?.lastRefreshError || null,
    email: token?.email || null,
    scope: token?.scope || null,
    expiresAt: token?.expiresAt || null,
    savedAt: token?.savedAt || null,
    /** 令牌读不出来时的可识别错误（保管库不可用 / 文件损坏）；正常时为 null */
    tokenError: read.ok ? null : { code: read.code, message: read.error },
    /** 令牌住在哪（供界面与诊断说实话，不需要用户去猜） */
    tokenStorage: (() => {
      try {
        return tokenStatus();
      } catch {
        return null;
      }
    })(),
    calendarId: calendar.calendarId,
    timeZone: calendar.timeZone,
    /** 访问 Google 用的代理（空表示直连）；界面据此提示「网络不通时该填什么」 */
    proxy: calendar.proxy || '',
  };
}

export function setTokenEmail(email) {
  const token = readToken();
  if (!token) return null;
  token.email = email;
  /*
   * 重新授权成功后要**清掉失效标记**，否则界面会一直说"需要重新连接"。
   * （写到这里的 token 一定来自一次成功的授权码交换。）
   */
  delete token.revokedAt;
  delete token.lastRefreshError;
  return writeToken(token);
}
