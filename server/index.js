/**
 * HTTP 服务：REST API + SSE 进度推送 + 静态界面。
 * 默认只监听 127.0.0.1，可另设访问令牌。
 */

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureDirs,
  getConfig,
  getInstance,
  getPaths,
  isConfigLoaded,
  listInstances,
  loadConfig,
  maskConfig,
  migrateSecrets,
  revertSecrets,
  saveConfig,
  secretSources,
  secretsReport,
} from './config/index.js';
import { LLM_PRESETS, PRESETS } from './config/defaults.js';
import { AppError, APP_VERSION, hoursAgo, log, safeJson, toErrorPayload } from './lib/util.js';
import { configHealth, runDiagnostics } from './diagnostics.js';
import {
  checkHost,
  checkThrottle,
  clientIp,
  generateToken,
  lanAddresses,
  recordFailure,
  recordSuccess,
  securityHeaders,
  securityReport,
  throttleStatus,
} from './lib/security.js';
import {
  clearCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  readSessionId,
  sessionCookie,
  sessionCount,
  touchSession,
} from './lib/session.js';
import { resolveTls } from './lib/tls.js';
import { egressReport } from './lib/privacy.js';
import { followUpConfig, runFollowUpScan } from './followup.js';
import { buildTimeline, listProjects, mergeProjects } from './timeline.js';
import { LlmClient, pingLlm } from './llm/client.js';
import { currentRun, clampWindowHours, isRunning, previewScan, progressBus, runScan, cancelRun } from './ai/engine.js';
import { runScheduledScan, schedulerStatus, setNotifyEmitter, startScheduler, stopScheduler } from './schedule.js';
import * as store from './store/state.js';
import {
  deleteDraft,
  getDraft,
  listDrafts,
  regenerateDraft,
  sendDraft,
  sendDrafts,
  syncDraftToMailbox,
  updateDraft,
  addDraftAttachment,
  getDraftAttachment,
  removeDraftAttachment,
  attachmentSummary,
} from './mail/drafts.js';
import { TOPICS, answerQuestion, buildKnowledge, buildMailDetail, buildOverview } from './ai/insight.js';
import { isDirectAction } from './mail/recipient.js';
import { emailActivity, searchEmails } from './ai/search.js';
import { applySignatureToDrafts } from './mail/signature-ops.js';
import { applyQuoteToDrafts } from './mail/quote-ops.js';
import {
  SCOPES as CALENDAR_SCOPES,
  connectionStatus as googleConnectionStatus,
  exchangeCode as exchangeGoogleCode,
  revoke as revokeGoogleAuth,
  setTokenEmail,
  startAuth as startGoogleAuth,
  suggestedRedirectUri,
  validateGoogleConfig,
} from './calendar/google-auth.js';
import { deleteEvent as deleteGoogleEvent, listCalendars as listGoogleCalendars, testConnection as testGoogleConnection } from './calendar/google-api.js';
import { groupEventTopics } from './calendar/topics.js';
import { AUDIT_ACTIONS, auditFile, auditStats, appendAudit, listAudit } from './store/audit.js';
import { buildBackup, importBackup, inspectBackup, listSafetyBackups } from './lib/backup.js';
import { runCalendarReview } from './calendar/review-run.js';
import { REVIEW_PRESETS } from './calendar/time.js';
import {
  acceptEmailSuggestion,
  backfillCalendarAudit,
  updateCalendarEvent,
  cancelPending,
  chatWithCalendar,
  commitPending,
  getCalendarInsight,
  getSession as getCalendarSession,
  getUpcoming,
  newSessionId,
  suggestEventsFromEmails,
} from './calendar/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');
const MAX_BODY_BYTES = 4 * 1024 * 1024;
/**
 * 备份导入的体积上限。
 *
 * 比普通请求体大得多（备份里可能有上百 MB 的邮件原文），但**仍要设上限**：
 * 读进内存的是整个压缩包，不设限就等于给了对方一个"把我内存吃满"的入口。
 */
const MAX_BACKUP_BYTES = 256 * 1024 * 1024;

/* ------------------------------------------------------------ 工具 */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

/**
 * 读取**原始字节**请求体（附件上传用）。
 *
 * 与 readJsonBody 分开是为了给出更贴切的超限提示：
 * JSON 接口说"请求体过大"用户不知道发生了什么，
 * 而附件上传超限必须说清"多大以内、怎么绕过"。
 */
async function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) {
      throw new AppError(`附件超过上限（${(maxBytes / 1048576).toFixed(0)} MB），已中止上传`, {
        code: 'ATTACHMENT_TOO_LARGE',
        status: 413,
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new AppError('请求体过大', { code: 'BODY_TOO_LARGE', status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed;
  } catch (err) {
    throw new AppError(`请求体不是合法 JSON：${err.message}`, { code: 'BAD_JSON', status: 400 });
  }
}

function authorized(req, config, url) {
  const token = config.web.authToken;
  if (!token) return true;
  // 新路径：短期会话 Cookie（HttpOnly，浏览器 JS 读不到，也不会进 URL/历史）
  const sessionId = readSessionId(req);
  if (sessionId && touchSession(sessionId, config)) return true;
  /*
   * 兼容路径：授权头 / ?token=。
   * `?token=` 只保留给 CLI 与脚本（浏览器已改用会话 Cookie）；
   * 它会把令牌写进浏览器历史与代理日志，所以界面上不再使用。
   */
  const header = req.headers['x-mailbot-token'] || req.headers.authorization || '';
  const provided = String(header).replace(/^Bearer\s+/i, '').trim() || url?.searchParams.get('token') || '';
  return provided && provided === token;
}

/**
 * 返回 null 表示放行；否则返回一个"已经能直接发出去"的响应描述。
 *
 * 两件事在这里统一做掉，避免每个路由各写一遍：
 *   ① **Host 白名单**（防 DNS rebinding）——对**所有**请求生效，静态资源也一起；
 *   ② **令牌校验 + 失败限速**——只对 `/api/*` 生效。
 *
 * ② 为什么不能连静态资源一起管：登录页自己就是静态资源（`index.html` + `main.js`），
 * 如果它们也要令牌，用户就**永远无法登录**（页面都加载不出来，输入框都看不到）。
 * 静态资源是本程序自己的代码、不含任何用户数据，明文放行没有风险；
 * 真正需要挡的是下面的 `/api/*`（那里才有邮件、日程与凭据）。
 * OAuth 回调也必须放行：它是 Google 把浏览器重定向回来的入口，靠 `state` 防 CSRF，
 * 而不是靠会话（用户可能换了浏览器或会话已过期）。
 */
function gateRequest(req, res, url, config) {
  const hostCheck = checkHost(req, config);
  if (!hostCheck.ok) {
    log.warn(`拒绝可疑 Host：${req.headers.host}（${hostCheck.reason}）`);
    return {
      status: 421,
      payload: { ok: false, code: 'HOST_NOT_ALLOWED', message: hostCheck.reason, host: hostCheck.host },
    };
  }

  const isApi = url.pathname.startsWith('/api/');
  /*
   * 必须放行的三类：
   *   - OAuth 回调：Google 把浏览器重定向回来的入口，靠 state 防 CSRF；
   *   - `/api/session`：**登录本身**与会话状态查询。登录页要靠它判断"要不要登录"，
   *     它要是也要求凭据，就死锁了（没登录 → 401 → 无法登录）；
   *     这个路由自己会校验令牌并做失败限速。
   *   - 登出：只是清掉自己的 Cookie，没有副作用可言。
   */
  const exempt =
    url.pathname === '/api/calendar/oauth/callback' ||
    url.pathname === '/api/session' ||
    url.pathname === '/api/session/logout';
  if (!isApi || exempt) return null;

  const token = config.web.authToken;
  if (!token) return null; // 没设令牌 = 本机随便用（默认只监听 127.0.0.1）

  const ip = clientIp(req, config);
  const blocked = checkThrottle(ip, config);
  if (blocked.blocked) {
    return {
      status: 429,
      payload: { ok: false, code: 'TOO_MANY_ATTEMPTS', message: blocked.reason },
      retryAfterSec: blocked.retryAfterSec,
    };
  }

  if (authorized(req, config, url)) {
    recordSuccess(ip);
    return null;
  }

  // 没带任何凭据：不算"猜错"，不计入限速（否则刷新页面就会被自己封掉）
  const header = req.headers['x-mailbot-token'] || req.headers.authorization || '';
  const sessionId = readSessionId(req);
  const hasCredential = !!(String(header).trim() || url?.searchParams.get('token') || sessionId);
  if (!hasCredential) {
    return {
      status: 401,
      payload: { ok: false, code: 'UNAUTHORIZED', message: '需要先输入访问令牌登录' },
    };
  }

  const rec = recordFailure(ip, config);
  appendAudit('auth.fail', {
    target: `${req.method} ${url.pathname}`,
    source: ip,
    ok: false,
    extra: { count: rec.count, blocked: rec.blocked },
  });
  if (rec.blocked) {
    log.warn(`来源 ${ip} 连续 ${rec.count} 次令牌错误，已临时拒绝（${rec.retryAfterSec}s）`);
    return {
      status: 429,
      payload: {
        ok: false,
        code: 'TOO_MANY_ATTEMPTS',
        message: `令牌连续输错 ${rec.count} 次，已暂时拒绝来自 ${ip} 的请求，请 ${Math.ceil(rec.retryAfterSec / 60)} 分钟后再试`,
      },
      retryAfterSec: rec.retryAfterSec,
    };
  }
  return {
    status: 401,
    payload: { ok: false, code: 'UNAUTHORIZED', message: `访问令牌不正确（已失败 ${rec.count} 次，超过 ${throttleStatus(config).config.maxFailures} 次将临时拒绝）` },
  };
}

/**
 * 同源校验。
 *
 * 服务默认只监听 127.0.0.1，但浏览器发出的请求可以被恶意页面跨源发起（配合 DNS rebinding，
 * 攻击者还能让 Host 头变成自己的域名）。一旦信任 Host 头去拼 OAuth 回调地址，
 * 授权码就会被打到攻击者域名上。因此对会对「有副作用的写操作 / 明文凭据」的接口，
 * 只接受来自本机已知来源的请求。
 *
 * 非浏览器客户端（CLI、curl）通常不带 Origin，则只校验 Host 是否为本机回环地址。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function isSameOrigin(req, config) {
  const hostHeader = String(req.headers.host || '');
  const hostName = hostHeader.replace(/:\d+$/, '').toLowerCase();
  // Host 不是本机时，仅当管理员显式允许局域网访问（host=0.0.0.0）才放行
  const lanAllowed = config.web.host && !LOOPBACK_HOSTS.has(config.web.host);
  if (!LOOPBACK_HOSTS.has(hostName) && !lanAllowed) return false;

  const origin = req.headers.origin;
  if (!origin || origin === 'null') return true; // 非浏览器或同源 GET
  try {
    const originUrl = new URL(origin);
    const originIsLoopback = LOOPBACK_HOSTS.has(originUrl.hostname.toLowerCase());
    if (originIsLoopback) return true;
    return lanAllowed && originUrl.hostname.toLowerCase() === hostName;
  } catch {
    return false;
  }
}

function instanceIdFrom(url) {
  if (!url?.searchParams) return undefined;
  return url.searchParams.get('instance') || url.searchParams.get('instanceId') || undefined;
}

/* ------------------------------------------------------------ 日历辅助 */

/** 只允许回环地址作为 OAuth 回调，避免授权码被打到第三方域名。 */
function safeRedirectUri(req, config, requested, actualPort) {
  const fallback = suggestedRedirectUri({ port: actualPort });
  const candidate = String(requested || '').trim();
  if (!candidate) {
    // 没有显式配置时，用「与当前请求同源」的地址，并强制限定为本机回环
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const port = hostHeader.includes(':') ? hostHeader.split(':').pop() : String(config.web.port);
    const host = hostHeader.replace(/:\d+$/, '') || '127.0.0.1';
    if (!LOOPBACK_HOSTS.has(host)) return fallback;
    return `http://${host === '::1' ? '[::1]' : host}:${port}/api/calendar/oauth/callback`;
  }
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.toLowerCase();
    const lanAllowed = config.web.host && !LOOPBACK_HOSTS.has(config.web.host);
    if (!LOOPBACK_HOSTS.has(hostname) && !lanAllowed) {
      throw new AppError(
        `回调地址必须指向本机（当前：${candidate}）。这是为了防止 Google 授权码被发送到非本机地址。`,
        { code: 'REDIRECT_URI_REJECTED', status: 400 },
      );
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AppError('回调地址必须是 http(s) 地址', { code: 'REDIRECT_URI_REJECTED', status: 400 });
    }
    return candidate;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`回调地址格式不正确：${candidate}`, { code: 'REDIRECT_URI_REJECTED', status: 400 });
  }
}

function calendarStatusPayload(actualPort) {
  const status = googleConnectionStatus();
  const config = getConfig();
  const enabled = config.calendar.enabled;
  return {
    ...status,
    enabled,
    ready: enabled && status.configured && status.connected,
    calendarId: config.calendar.calendarId,
    timeZone: config.calendar.timeZone,
    // 用实际监听端口推导，避免「建议地址」与真实地址不一致
    suggestedRedirectUri: config.calendar.google.redirectUri || suggestedRedirectUri({ port: actualPort }),
    lookaheadDays: config.calendar.lookaheadDays,
    sendUpdates: config.calendar.sendUpdates,
  };
}

/**
 * OAuth 回调：不经过 Bearer 鉴权（浏览器重定向带不了自定义头），安全性由 state + PKCE 保证。
 */
async function handleOAuthCallback(req, res, url) {
  const params = url.searchParams;
  const error = params.get('error');
  const code = params.get('code');
  const state = params.get('state');

  if (error) {
    const { title, detail, steps } = explainOAuthError(error, params.get('error_description'));
    log.warn(`Google 授权被拒：${error}${params.get('error_description') ? ` — ${params.get('error_description')}` : ''}`);
    return sendOAuthResult(res, false, detail, { title, steps });
  }
  if (!code || !state) {
    return sendOAuthResult(res, false, '回调参数不完整（缺少 code 或 state）。请重新点击「连接 Google 日历」。', {
      title: '授权回调参数不完整',
    });
  }

  try {
    const token = await exchangeGoogleCode(code, state);
    // 顺手把账号邮箱记下来，界面上显示「已连接 xxx@gmail.com」
    try {
      const { listCalendars } = await import('./calendar/google-api.js');
      const calendars = await listCalendars();
      const primary = calendars.find((c) => c.primary);
      if (primary?.id) setTokenEmail(primary.id);
    } catch {
      /* 拿不到邮箱不影响授权结果 */
    }
    void token;
    return sendOAuthResult(res, true, '已完成 Google 日历授权');
  } catch (err) {
    log.warn(`OAuth 回调处理失败：${err?.message || err}`);
    return sendOAuthResult(res, false, err?.message || String(err), { title: '授权换取令牌失败' });
  }
}

/**
 * 把 Google 的授权错误翻译成可执行的中文指引。
 *
 * access_denied 在「OAuth 同意屏幕处于测试状态」时几乎总是同一个原因：
 * 用来登录的 Google 账号不在「测试用户」名单里——这在 Google 侧判定，
 * 与本地配置无关，所以必须在界面上直接告诉用户去哪里加人。
 */
function explainOAuthError(error, description) {
  const code = String(error || '').trim();
  if (code === 'access_denied') {
    return {
      title: 'Google 拒绝了本次授权（access_denied）',
      detail:
        '你的 OAuth 同意屏幕还处于「测试」状态，只有被加入「测试用户」名单的 Google 账号才能授权。' +
        '你现在用来登录的这个账号不在名单里。',
      steps: [
        '打开 Google Cloud Console → API 和服务 → OAuth 同意屏幕',
        '在「测试用户」区域点「添加用户」，填入你刚才登录用的那个 Gmail 地址（一字不差）',
        '保存后等约 1 分钟生效，回到本页重新点击「连接 Google 日历」',
        '注意：登录时务必选择你添加过的那个账号，换账号会再次被拒',
        '如需长期使用（且不再受 7 天令牌限制），可在同一页面点「发布应用」',
      ],
    };
  }
  if (code === 'invalid_client' || code === 'unauthorized_client') {
    return {
      title: 'OAuth 客户端不被接受',
      detail: 'Google 不认识这个客户端 ID，或回调地址与登记的不一致。',
      steps: [
        '确认「设置 → 日历数字人」里的客户端 ID / 密钥来自同一个 OAuth 客户端',
        '确认 Google Cloud 里登记的「授权重定向 URI」与本系统显示的建议回调地址完全一致（含端口与路径）',
      ],
    };
  }
  if (code === 'redirect_uri_mismatch') {
    return {
      title: '回调地址不匹配（redirect_uri_mismatch）',
      detail: 'Google Cloud 里登记的授权重定向 URI 与本系统使用的地址不一致。',
      steps: [
        '以「设置 → 日历数字人」显示的建议回调地址为准，一字不差地填到 Google Cloud 的「授权重定向 URI」',
        '注意 http/https、端口号、路径都要完全一致',
      ],
    };
  }
  const suffix = description ? ` — ${description}` : '';
  return {
    title: `Google 返回授权错误：${code}${suffix}`,
    detail: '授权未完成。可先按下面的方向检查，再重新点击「连接 Google 日历」。',
    steps: [
      '确认 OAuth 同意屏幕已配置完成（应用名、支持邮箱、测试用户）',
      '确认客户端类型是「Web 应用」，且回调地址与设置页一致',
      '确认在 Google 页面登录的账号就是被批准的测试用户',
    ],
  };
}

/** 回调结果页：给用户看结论与下一步，并用 postMessage 通知原窗口后自动关闭。 */
function sendOAuthResult(res, ok, message, { title, steps } = {}) {
  const esc = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c]);
  const safe = esc(message);
  const heading = esc(title || (ok ? 'Google 日历授权成功' : 'Google 日历授权失败'));
  const stepsHtml = Array.isArray(steps) && steps.length
    ? `<ol style="text-align:left;margin:16px 0 0;padding-left:22px;color:#3f4650;font-size:13.5px;line-height:1.9">${steps
        .map((s) => `<li>${esc(s)}</li>`)
        .join('')}</ol>`
    : '';
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${heading}</title>
<style>body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;background:#f6f7f9;color:#1b1f24;
display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;box-sizing:border-box}
.card{background:#fff;border:1px solid #e4e6ea;border-radius:12px;
padding:26px 30px;max-width:600px;box-shadow:0 4px 16px rgba(16,24,40,.08)}
h1{font-size:16.5px;margin:0 0 10px;color:${ok ? '#1f7a4d' : '#c0392b'};line-height:1.5}
p{margin:0;color:#5b636d;font-size:14px;line-height:1.75}
.icon{font-size:32px;margin-bottom:10px;text-align:center}
.hint{margin-top:16px;color:#8a929c;font-size:12.5px}</style></head><body>
<div class="card"><div class="icon">${ok ? '✅' : '❌'}</div>
<h1>${heading}</h1><p>${safe}</p>${stepsHtml}
<p class="hint">${ok ? '此窗口会自动关闭，请回到「日历」页面继续操作。' : '修好后回到「日历」页面重新点击「连接 Google 日历」。'}</p></div>
<script>
try { if (window.opener) window.opener.postMessage({ type: 'mailbot-google-oauth', ok: ${ok ? 'true' : 'false'} }, '*'); } catch (e) {}
setTimeout(function () { try { window.close(); } catch (e) {} }, ${ok ? 1200 : 6000});
</script></body></html>`;
  res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

/* ------------------------------------------------------------ 静态文件 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(WEB_DIR, rel);
  if (!target.startsWith(WEB_DIR)) {
    sendText(res, 403, 'Forbidden');
    return true;
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return false;
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=60',
  });
  fs.createReadStream(target).pipe(res);
  return true;
}

/* ------------------------------------------------------------ 路由 */

async function handleApi(req, res, url, actualPort, ctx = {}) {
  // ctx：{ https, tls } —— 由 createServer 传入，避免这个函数去引用它拿不到的 server 变量
  const isHttps = ctx.https === true;
  const config = getConfig();
  const method = req.method.toUpperCase();
  const route = `${method} ${url.pathname}`;

  /* ---- 元信息 ---- */
  if (route === 'GET /api/meta') {
    const p = getPaths();
    return sendJson(res, 200, {
      ok: true,
      version: APP_VERSION,
      /** 运行环境版本：报问题时"你用的什么 Node"是最常被问到的一句 */
      node: process.version,
      dataDir: p.dataDir,
      defaultInstanceId: config.defaultInstanceId,
      /** 展示时区：界面所有时间都按它渲染，避免浏览器时区与邮箱时区不一致 */
      timeZone: config.calendar?.timeZone || 'Asia/Shanghai',
      presets: PRESETS,
      /** 主流大模型服务商预设（全是 OpenAI 兼容协议） */
      llmPresets: LLM_PRESETS,
      topics: TOPICS,
      secretSources: secretSources(),
      running: isRunning(config.defaultInstanceId),
      counts: countsPayload(),
    });
  }

  /* ---- 配置 ---- */
  if (route === 'GET /api/config') {
    return sendJson(res, 200, { ok: true, config: maskConfig(config), presets: PRESETS, secretSources: secretSources() });
  }

  if (route === 'PUT /api/config') {
    const patch = await readJsonBody(req);
    const next = saveConfig(patch);
    /*
     * 定时器要跟着配置立刻起停，而不是等下次重启：
     * 用户在这里打开开关，就该马上生效（否则他会以为没生效又去点一次）。
     */
    if (next.schedule?.enabled) startScheduler();
    else stopScheduler();
    return sendJson(res, 200, {
      ok: true,
      config: maskConfig(next),
      message: '配置已保存',
      restartHint: next.web.port !== config.web.port ? '端口已变更，需重启服务后生效' : null,
    });
  }

  /** 定时任务的运行状态（设置页显示"定时器活着吗、上次跑了什么"）。 */
  if (route === 'GET /api/schedule') {
    return sendJson(res, 200, { ok: true, ...schedulerStatus() });
  }

  /** 立刻按定时任务的方式跑一次（设置页的"立即试一次"，不受时间点限制）。 */
  if (route === 'POST /api/schedule/run') {
    const out = await runScheduledScan({ trigger: 'schedule-manual', force: true });
    return sendJson(res, 200, { ok: true, ...out, status: schedulerStatus() });
  }

  if (route === 'GET /api/instances') {
    return sendJson(res, 200, {
      ok: true,
      instances: listInstances().map((i) => ({
        id: i.id,
        label: i.label,
        enabled: i.enabled,
        isDefault: i.isDefault,
        imap: { host: i.imap.host, port: i.imap.port, secure: i.imap.secure, authUser: i.imap.authUser, hasPass: !!i.imap.authPass },
        smtp: { host: i.smtp.host, port: i.smtp.port, secure: i.smtp.secure, authUser: i.smtp.authUser, hasPass: !!i.smtp.authPass },
        identity: i.identity,
      })),
    });
  }

  /* ---- 自检 ---- */
  if (route === 'POST /api/diagnostics') {
    const body = await readJsonBody(req);
    const id = body.instanceId || instanceIdFrom(url);
    const result = await runDiagnostics({ instanceId: id, deep: !!body.deep });
    return sendJson(res, 200, { ok: result.ok, result });
  }

  if (route === 'POST /api/llm/test') {
    const client = new LlmClient(config.llm);
    const r = await pingLlm(client);
    return sendJson(res, 200, { ok: true, result: r });
  }

  /* ---- 运行分析 ---- */
  if (route === 'POST /api/runs') {
    const body = await readJsonBody(req);
    const id = body.instanceId || instanceIdFrom(url);
    const started = Date.now();
    const scope = body.scope?.uid
      ? { folder: String(body.scope.folder || config.scan.folders[0] || 'INBOX'), uid: Number(body.scope.uid) }
      : null;
    const result = await runScan({
      instanceId: id,
      windowHours: body.windowHours,
      force: !!body.force,
      trigger: body.trigger || (scope ? 'single' : 'manual'),
      scope,
    });
    return sendJson(res, 200, { ok: true, result, elapsedMs: Date.now() - started });
  }

  /**
   * 待办闭环：给「需要你处理」里的某封邮件打状态。
   *
   * 这是**本地状态**（不写 Google、不发邮件），所以**不进操作台账**——
   * 台账只记"改了外部系统"的动作，掺进本地点击会让它失去意义。
   */
  const taskMatch = url.pathname.match(/^\/api\/tasks\/(.+)$/);
  if (taskMatch && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
    const key = decodeURIComponent(taskMatch[1]);
    if (!/^[^:]+:\d+$/.test(key)) {
      throw new AppError(`待办标识不合法：${key}（应形如 INBOX:12345）`, { code: 'INVALID_TASK_KEY', status: 400 });
    }
    if (method === 'DELETE') {
      return sendJson(res, 200, { ok: true, task: store.setTask(key, { status: 'open' }), message: '已恢复为待办' });
    }
    const body = await readJsonBody(req);
    const task = store.setTask(key, {
      status: body.status,
      snoozeUntil: body.snoozeUntil,
      note: body.note,
    });
    const label = { done: '已标记为已处理', snoozed: '已设为稍后提醒', ignored: '已忽略', open: '已恢复为待办' }[task.status] || '已更新';
    return sendJson(res, 200, { ok: true, task, message: label });
  }

  /** 待办一览（按状态分组，便于"已处理/稍后/已忽略"里翻回去）。 */
  if (route === 'GET /api/tasks') {
    return sendJson(res, 200, { ok: true, tasks: store.listTasks(), statuses: store.TASK_STATUSES });
  }

  if (route === 'GET /api/runs') {
    return sendJson(res, 200, { ok: true, runs: store.listRuns(30) });
  }

  /**
   * 操作审计：改了外部系统（Google 日历 / 邮箱）的写操作台账。
   *
   * 只读接口。记录**追加**在 `data/audit.jsonl`，永久保留（用户选择），
   * 因此这里支持筛选与分页式截断，并在响应里给出文件路径供备份。
   */
  if (route === 'GET /api/audit') {
    const out = listAudit({
      limit: url.searchParams.get('limit') || 200,
      action: url.searchParams.get('action') || undefined,
      group: url.searchParams.get('group') || undefined,
      q: url.searchParams.get('q') || undefined,
      since: url.searchParams.get('since') || undefined,
      ok: url.searchParams.has('ok') ? url.searchParams.get('ok') === '1' : undefined,
    });
    return sendJson(res, 200, {
      ok: true,
      ...out,
      stats: auditStats(),
      actions: AUDIT_ACTIONS,
    });
  }

  /* ---- 会话（浏览器用短期 Cookie 取代永久令牌） ---- */

  /** 会话状态：是否需要登录、当前会话数、策略。 */
  if (route === 'GET /api/session') {
    const needLogin = !!config.web.authToken && !(readSessionId(req) && touchSession(readSessionId(req), config));
    return sendJson(res, 200, {
      ok: true,
      needLogin,
      hasToken: !!config.web.authToken,
      sessions: sessionCount(config),
      policy: {
        idleHours: config.web.sessionIdleHours,
        absoluteDays: config.web.sessionAbsoluteDays,
        max: config.web.sessionMaxCount,
      },
    });
  }

  /**
   * 用访问令牌换一个会话 Cookie。
   *
   * 令牌只在这一步出现一次，之后浏览器只带 HttpOnly Cookie：
   * 令牌不再进 localStorage、不进 URL、不进浏览器历史。
   */
  if (route === 'POST /api/session') {
    const body = await readJsonBody(req);
    const token = String(body.token || '');
    const expected = config.web.authToken;
    if (!expected) {
      return sendJson(res, 200, { ok: true, message: '未设置访问令牌，无需登录', needLogin: false });
    }
    const ip = clientIp(req, config);
    const blocked = checkThrottle(ip, config);
    if (blocked.blocked) {
      const res2 = { ok: false, code: 'TOO_MANY_ATTEMPTS', message: blocked.reason };
      res.setHeader('retry-after', String(blocked.retryAfterSec));
      return sendJson(res, 429, res2);
    }
    if (token !== expected) {
      const rec = recordFailure(ip, config);
      appendAudit('auth.fail', { target: 'POST /api/session', source: ip, ok: false, extra: { count: rec.count } });
      /*
       * 达到阈值后必须返回 **429**（而不是继续 401）：
       * 状态码是客户端唯一能自动识别的信号——401 会被理解成"令牌错了，再试一次"，
       * 429 + Retry-After 才表示"别再试了"。只改提示文案而状态码不变，
       * 等于让暴力破解可以一直试下去。
       */
      if (rec.blocked) {
        res.setHeader('retry-after', String(rec.retryAfterSec));
        return sendJson(res, 429, {
          ok: false,
          code: 'TOO_MANY_ATTEMPTS',
          message: `令牌连续输错 ${rec.count} 次，已暂时拒绝来自 ${ip} 的登录，请 ${Math.ceil(rec.retryAfterSec / 60)} 分钟后再试`,
        });
      }
      return sendJson(res, 401, {
        ok: false,
        code: 'BAD_TOKEN',
        message: `访问令牌不正确（已失败 ${rec.count} 次，超过 ${throttleStatus(config).config.maxFailures} 次将临时拒绝）`,
      });
    }
    recordSuccess(ip);
    const s = createSession({ ip, agent: req.headers['user-agent'] || '' }, config);
    const https = isHttps;
    res.setHeader(
      'set-cookie',
      sessionCookie(s.id, { https, maxAgeSec: Math.floor(Math.min(s.idleMs, s.absoluteMs) / 1000) }),
    );
    appendAudit('auth.login', { target: 'POST /api/session', source: ip, extra: { sessions: sessionCount(config) } });
    return sendJson(res, 200, { ok: true, message: '已登录', needLogin: false });
  }

  /** 登出（只影响当前浏览器）。 */
  if (route === 'POST /api/session/logout' || route === 'DELETE /api/session') {
    const id = readSessionId(req);
    const gone = destroySession(id);
    res.setHeader('set-cookie', clearCookie({ https: isHttps }));
    if (gone) appendAudit('auth.logout', { target: 'POST /api/session/logout', source: clientIp(req, config) });
    return sendJson(res, 200, { ok: true, message: gone ? '已登出' : '当前没有登录会话' });
  }

  /** 安全状态：绑定地址、暴露风险、令牌强度、会话、HTTPS。 */
  if (route === 'GET /api/security') {
    return sendJson(res, 200, { ok: true, ...securityReport({ config, port: actualPort, https: isHttps, tls: ctx.tls || null }) });
  }

  /**
   * 设置/重新生成访问令牌。
   *
   * 这是**唯一**能改令牌的接口，改动后：
   *   - 所有已登录会话立即失效（旧浏览器不该还能用）；
   *   - 新令牌写进配置（走 saveConfig，于是也会遵守密钥保管策略）；
   *   - 当前这次请求的浏览器**不**自动登录，必须用新令牌重新登录——
   *     否则"改了令牌却只有自己还连着"，会让人误以为改动没生效。
   */
  if (route === 'POST /api/security/token') {
    const body = await readJsonBody(req);
    const want = body.authToken === undefined || body.authToken === null ? '' : String(body.authToken);
    const next = want === '__generate__' ? generateToken() : want.trim();
    if (next && next.length < 8) {
      throw new AppError('访问令牌太短（至少 8 位）；建议直接用「生成新令牌」', { code: 'TOKEN_TOO_WEAK', status: 400 });
    }
    saveConfig({ web: { authToken: next } });
    const killed = destroyAllSessions();
    res.setHeader('set-cookie', clearCookie({ https: isHttps }));
    appendAudit('security.token', {
      target: next ? '已设置访问令牌' : '已清空访问令牌',
      source: clientIp(req, getConfig()),
      extra: { sessionsInvalidated: killed, length: next.length },
    });
    return sendJson(res, 200, {
      ok: true,
      authToken: next,
      sessionsInvalidated: killed,
      message: next
        ? `已更新访问令牌，${killed} 个已登录会话已失效，请用新令牌重新登录`
        : '已清空访问令牌：此后任何能访问该地址的人都可以直接使用（不建议在局域网暴露时这么做）',
    });
  }

  /**
   * 数据去向：按**当前配置**逐项说明哪些内容会离开这台机器、发到哪里。
   *
   * 这不是一份写死的说明书——模型地址、代理、日历开关一变，报告内容跟着变。
   */
  if (route === 'GET /api/egress') {
    return sendJson(res, 200, { ok: true, ...egressReport({ config }) });
  }

  /* ---- 跟催（我承诺了什么 / 等谁回复） ---- */

  /** 列表 + 计数。默认只给未关闭的（终态默认折叠在界面里）。 */
  if (route === 'GET /api/followups') {
    const kind = url.searchParams.get('kind') || undefined;
    const status = url.searchParams.get('status') || undefined;
    const items = store.listFollowUps({ kind, status });
    return sendJson(res, 200, {
      ok: true,
      items,
      summary: store.summarizeFollowUps(),
      /** 全部状态都要给：界面上要能折叠显示"已完成/已忽略" */
      all: store.listFollowUps(),
      config: followUpConfig(),
    });
  }

  /**
   * 跑一次跟催扫描。
   *
   * 会调用模型（仅用于从我发出的邮件里提取承诺），所以要求显式确认——
   * 与"分析邮件"同样的规矩：花钱的动作必须先让用户知道。
   */
  if (route === 'POST /api/followups/scan') {
    const body = await readJsonBody(req);
    const cfg = followUpConfig();
    if (!cfg.enabled) throw new AppError('跟催功能已在设置里关闭', { code: 'FOLLOWUP_DISABLED', status: 400 });
    const willCallLlm = cfg.extractCommitments && !!config.llm.apiKey;
    if (willCallLlm && body.confirm !== true) {
      return sendJson(res, 428, {
        ok: false,
        code: 'CONFIRM_REQUIRED',
        message: '扫描会用模型读你最近发出的邮件来提取承诺（"等谁回复"部分不花钱）：请传入 confirm=true',
      });
    }
    // 「等谁回复」不需要模型；只有提取承诺才构造客户端
    const client = willCallLlm ? new LlmClient(config.llm) : null;
    const out = await runFollowUpScan({ client, store });
    appendAudit('followup.scan', {
      target: `新增 ${out.created} 条 / 自动关闭 ${out.autoClosed} 条`,
      source: '界面扫描',
      extra: { waiting: out.waiting, commitments: out.commitments, llmError: out.llmError },
    });
    return sendJson(res, 200, {
      ok: true,
      ...out,
      summary: store.summarizeFollowUps(),
      message:
        `扫描完成：在等回复 ${out.waiting} 条、我的承诺 ${out.commitments} 条` +
        (out.created ? `，新增 ${out.created} 条` : '，没有新增') +
        (out.autoClosed ? `，自动关闭 ${out.autoClosed} 条（对方已回复）` : '') +
        (out.llmError ? `；但提取承诺失败：${out.llmError}` : ''),
    });
  }

  /** 改一条跟催的状态（复用待办的四个状态）。 */
  if (req.method === 'PATCH' || req.method === 'PUT') {
    const m = /^\/api\/followups\/([^/]+)$/.exec(url.pathname);
    if (m) {
      const body = await readJsonBody(req);
      const id = decodeURIComponent(m[1]);
      const next = store.setFollowUp(id, {
        status: body.status,
        snoozeUntil: body.snoozeUntil,
        closeReason: body.closeReason,
      });
      if (!next) throw new AppError('找不到这条跟催记录（可能已被清理）', { code: 'FOLLOWUP_NOT_FOUND', status: 404 });
      appendAudit('followup.status', {
        target: next.title || id,
        source: '界面操作',
        extra: { status: next.status, kind: next.kind, snoozeUntil: next.snoozeUntil || null },
      });
      return sendJson(res, 200, { ok: true, item: next, summary: store.summarizeFollowUps() });
    }
  }

  /* ---- 按项目时间线 ---- */

  /** 项目清单：从分析记录/草稿/跟催里的 project 标签 + 用户登记表推导。 */
  if (route === 'GET /api/projects') {
    const projects = listProjects({
      analyses: store.listAnalyses({ limit: 5000 }),
      drafts: store.listDrafts({}),
      followUps: store.getFollowUpMap(),
      registry: store.getProjectRegistry(),
    });
    const listed = store.listAnalyses({ limit: 5000 });
    const unclassified = listed.filter((a) => !a.project).length;
    return sendJson(res, 200, { ok: true, projects, unclassified });
  }

  /** 一个项目的时间线（邮件 + 我发出的 + 跟催 + 日程）。 */
  if (route === 'GET /api/timeline') {
    const project = url.searchParams.get('project') || '';
    const entries = buildTimeline({
      project,
      analyses: store.listAnalyses({ limit: 5000 }),
      drafts: store.listDrafts({}),
      followUps: store.getFollowUpMap(),
      audit: listAudit({ limit: 2000 }).items || [],
    });
    return sendJson(res, 200, {
      ok: true,
      project,
      entries,
      counts: entries.reduce((acc, e) => ({ ...acc, [e.kind]: (acc[e.kind] || 0) + 1 }), {}),
      /** 日程只来自本地操作留痕：别人直接在日历服务上建的看不到，界面要如实说明 */
      calendarNote: '日程来自本程序的操作记录；别人在 Google 日历上直接创建的日程不会出现在这里',
    });
  }

  /** 重命名 / 合并项目：会改写历史记录，并要求确认。 */
  if (route === 'POST /api/projects/rename') {
    const body = await readJsonBody(req);
    const from = String(body.from || '').trim();
    const to = String(body.to || '').trim();
    if (!from || !to) throw new AppError('请同时提供原项目名 from 与目标项目名 to', { code: 'PROJECT_NAME_REQUIRED', status: 400 });
    if (body.confirm !== true) {
      throw new AppError('合并会改写历史记录的标签：请传入 confirm=true', { code: 'CONFIRM_REQUIRED', status: 428 });
    }
    const moved = store.rewriteProjectTags({ from, to });
    const merged = mergeProjects({
      from,
      to,
      analyses: [],
      drafts: [],
      followUps: {},
      registry: store.getProjectRegistry(),
    });
    store.replaceProjects(merged.registry);
    appendAudit('project.rename', {
      target: `${from} → ${to}`,
      source: '界面操作',
      extra: { movedAnalyses: moved },
    });
    return sendJson(res, 200, {
      ok: true,
      moved,
      message: moved ? `已把「${from}」的 ${moved} 条记录并入「${to}」，并把旧名记成别名` : `已把「${from}」记成「${to}」的别名（当前没有需要改写的记录）`,
      projects: listProjects({
        analyses: store.listAnalyses({ limit: 5000 }),
        drafts: store.listDrafts({}),
        followUps: store.getFollowUpMap(),
        registry: store.getProjectRegistry(),
      }),
    });
  }
  /* ---- 密钥存储（系统钥匙串） ---- */

  /** 密钥现状：每一项**现在在哪**、是不是明文、有没有降级。 */
  if (route === 'GET /api/secrets') {
    return sendJson(res, 200, { ok: true, ...secretsReport() });
  }

  /**
   * 把明文密钥迁到保管库。
   *
   * 会真正改动配置文件（把密钥清空），所以要求确认；
   * 内部还会"先写保管库 → 读回逐项比对 → 比对通过才动文件"，失败不留半个状态。
   */
  if (route === 'POST /api/secrets/migrate') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      throw new AppError('迁移会把配置文件里的密钥搬走并清空：请传入 confirm=true。', {
        code: 'CONFIRM_REQUIRED',
        status: 428,
      });
    }
    const result = migrateSecrets({ mode: String(body.mode || 'auto') });
    appendAudit('secrets.migrate', {
      target: result.backend,
      source: '设置页',
      extra: { migrated: result.migrated, envCleared: result.envCleared },
    });
    return sendJson(res, 200, { ok: true, ...result, status: secretsReport() });
  }

  /** 从保管库搬回明文（用户不想用了的退路）。 */
  if (route === 'POST /api/secrets/revert') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      throw new AppError('迁回会让密钥重新以明文保存：请传入 confirm=true。', { code: 'CONFIRM_REQUIRED', status: 428 });
    }
    const result = revertSecrets();
    appendAudit('secrets.revert', { target: 'config.json', source: '设置页', extra: { restored: result.restored } });
    return sendJson(res, 200, { ok: true, ...result, status: secretsReport() });
  }

  /* ---- 备份与恢复 ---- */

  /**
   * 导出备份（zip）。
   *
   * 默认**不含密钥、不含邮件原文**：凭据散落在压缩包里是最容易出事的一类泄漏，
   * 而原文动辄上百 MB。要连它们一起搬的人显式传参。
   */
  if (route === 'GET /api/backup/export') {
    const includeSecrets = url.searchParams.get('secrets') === '1';
    const includeRaw = url.searchParams.get('raw') === '1';
    const out = buildBackup({ includeSecrets, includeRaw });
    appendAudit('backup.export', {
      target: out.filename,
      source: includeSecrets ? '界面导出（含密钥）' : '界面导出',
      extra: { bytes: out.buffer.length, includeSecrets, includeRaw, counts: out.manifest.counts },
    });
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${out.filename}"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
      'content-length': out.buffer.length,
      'cache-control': 'no-store',
    });
    return res.end(out.buffer);
  }

  /** 检查备份包内容（**不落盘**）：先让用户看清里面有什么、缺什么，再决定是否导入。 */
  if (route === 'POST /api/backup/inspect') {
    const body = await readRawBody(req, MAX_BACKUP_BYTES);
    return sendJson(res, 200, { ok: true, ...inspectBackup(body) });
  }

  /**
   * 导入备份（会**覆盖当前数据**）。
   *
   * 三重保护：①接口要求 `confirm=true`；②导入前自动把当前数据备份到 `data/backups/`；
   * ③只按白名单落盘。并且密钥取"备份里有就用备份的、没有就保留磁盘上现有的"。
   */
  if (route === 'POST /api/backup/import') {
    const body = await readRawBody(req, MAX_BACKUP_BYTES);
    const out = importBackup(body, { confirm: url.searchParams.get('confirm') === '1' });
    appendAudit('backup.import', {
      target: out.manifest?.createdAt ? `来自 ${out.manifest.createdAt} 的备份` : '备份导入',
      source: '界面导入',
      extra: {
        restored: out.restored,
        skipped: out.skipped,
        safetyBackup: out.safetyBackup ? path.basename(out.safetyBackup) : null,
        includeSecrets: !!out.manifest?.includeSecrets,
      },
    });
    return sendJson(res, 200, { ok: true, ...out, message: `已恢复 ${out.restored.length} 个文件` });
  }

  /** 导入前的自动备份列表（可回滚）。 */
  if (route === 'GET /api/backup/list') {
    return sendJson(res, 200, { ok: true, backups: listSafetyBackups() });
  }

  /**
   * 一屏体检：**纯本地、不连网**，回答"现在能不能开始用、还差哪一步"。
   *
   * 与「运行自检」（会真的连 IMAP / 调模型）分工不同：这个每次进页面都会调用，
   * 必须快且不受凭据影响。
   */
  if (route === 'GET /api/health') {
    return sendJson(res, 200, { ok: true, ...configHealth() });
  }

  /** 存储占用体检（含"孤儿归档"：没有任何分析记录指向的原文）。 */
  if (route === 'GET /api/storage') {
    return sendJson(res, 200, { ok: true, ...store.storageStats() });
  }

  /**
   * 清理归档原文。
   *
   * 两类，风险完全不同：孤儿（无任何记录指向，删了不影响任何可查询的历史）与超期原文。
   * 必须显式 `confirm=true`——这是**不可逆**的删除。
   */
  if (route === 'POST /api/storage/cleanup') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      throw new AppError('清理归档是不可逆操作：请传入 confirm=true。', { code: 'CONFIRM_REQUIRED', status: 428 });
    }
    const mode = body.mode === 'retention' ? 'retention' : 'orphans';
    const retentionDays = mode === 'retention' ? Number(body.retentionDays) || store.rawRetentionDays() : 0;
    const before = store.storageStats();
    const out = store.cleanupRawArchives({ includeOrphans: body.includeOrphans !== false, retentionDays });
    /*
     * 删除原文是**不可逆的数据损失**，与"点一下待办"不同，值得进台账：
     * 事后要能回答"我的邮件原文是什么时候没的"。
     */
    appendAudit('storage.cleanup', {
      target: `清理归档原文（${mode === 'retention' ? `保留 ${retentionDays} 天` : '仅孤儿'}）`,
      source: '界面清理存储',
      extra: {
        orphans: out.orphans,
        expired: out.expired,
        freedBytes: out.bytes,
        kept: out.kept,
        failed: out.failed,
        rawBefore: before.raw,
      },
    });
    return sendJson(res, 200, {
      ok: true,
      ...out,
      before: before.raw,
      after: store.storageStats(),
      message: `已删除 ${out.orphans + out.expired} 个归档文件，释放约 ${Math.round((out.bytes / 1024 / 1024) * 10) / 10} MB`,
    });
  }

  /** 审计原始文件（JSONL，永久保留，供用户自己备份/用 Excel 打开）。 */
  if (route === 'GET /api/audit/download') {
    const file = auditFile();
    /*
     * 没有记录时**不能**返回 200 + 空 body：浏览器会老老实实下载一个 0 字节文件，
     * 用户打开一看是空的，只会以为"功能坏了"。这里明确报 404 并说明原因，
     * 界面据此提示"还没有记录可下载"。
     */
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
      return sendJson(res, 404, {
        ok: false,
        code: 'AUDIT_EMPTY',
        message: '还没有操作记录可下载。发送邮件、创建或删除日程后才会产生台账；也可以点「补录历史」从 Google 日历补回本程序创建的日程。',
      });
    }
    const stat = fs.statSync(file);
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-disposition': `attachment; filename="audit.jsonl"; filename*=UTF-8''${encodeURIComponent('操作审计.jsonl')}`,
      'content-length': stat.size,
    });
    return fs.createReadStream(file).pipe(res);
  }

  /**
   * 从 Google 日历补录历史台账。
   *
   * 「创建日程」的审计是本轮才加的，之前批量建的日程本地没有任何痕迹。
   * 但那些事件在 Google 上带着 `mailbotSource` 扩展属性，可以据此回填，
   * 让台账不至于从"功能上线那天"才开始。
   *
   * 只读 Google + 只追加本地文件，不会新建/修改任何日程。
   */
  if (route === 'POST /api/audit/backfill') {
    const out = await backfillCalendarAudit();
    return sendJson(res, 200, { ok: true, ...out });
  }

  /* 分析前预检：只读连一次邮箱数封数，不花 token（放宽窗口前先让用户看到代价） */
  if (route === 'GET /api/runs/preview') {
    const id = instanceIdFrom(url) || config.defaultInstanceId;
    const preview = await previewScan({ instanceId: id, windowHours: url.searchParams.get('windowHours') });
    return sendJson(res, 200, { ok: true, ...preview });
  }

  const runMatch = url.pathname.match(/^\/api\/runs\/([\w-]+)$/);
  if (runMatch && method === 'GET') {
    const run = store.getRun(runMatch[1]);
    if (!run) throw new AppError('运行记录不存在', { code: 'RUN_NOT_FOUND', status: 404 });
    return sendJson(res, 200, { ok: true, run, progress: currentRun(run.instanceId)?.runId === run.id ? 'running' : null });
  }

  if (route === 'POST /api/runs/cancel') {
    const body = await readJsonBody(req);
    const id = body.instanceId || config.defaultInstanceId;
    const cancelled = cancelRun(id);
    return sendJson(res, 200, { ok: true, cancelled });
  }

  /* ---- 总览 / 24 小时结论 ---- */
  if (route === 'GET /api/overview') {
    const payload = buildOverview({
      instanceId: instanceIdFrom(url),
      windowHours: clampWindowHours(url.searchParams.get('hours') || config.scan.windowHours),
    });
    return sendJson(res, 200, { ok: true, ...payload });
  }

  /* ---- 邮件与草稿 ---- */
  /**
   * 下载某封邮件的附件（按列表下标）。
   *
   * 只读：从本地归档解析；归档缺失时才只读回源一次。**不做任何写操作**，
   * 也不会把附件"预先下载到服务器"——分析时抓正文已经把原文（含附件）存在本地了。
   *
   * 安全要点：
   *   - 文件名只用于 Content-Disposition，绝不参与任何服务端路径；
   *   - 同时给出 ASCII 兜底名与 RFC 5987 的 UTF-8 名，中文名在旧客户端也不会乱码；
   *   - 下标越界一律 404，不泄露"一共有几个附件"以外的信息。
   */
  const attMatch = url.pathname.match(/^\/api\/mails\/([^/]+)\/(\d+)\/attachments\/(\d+)$/);
  if (attMatch && method === 'GET') {
    const folder = decodeURIComponent(attMatch[1]);
    const uid = Number(attMatch[2]);
    const index = Number(attMatch[3]);
    const { loadRawFor } = await import('./ai/insight.js');
    const { extractAttachment } = await import('./mail/parse.js');
    const loaded = await loadRawFor({ folder, uid, instanceId: instanceIdFrom(url) });
    if (!loaded.raw) throw new AppError(loaded.reason || '取不到这封邮件的原文，无法下载附件', { code: 'MAIL_SOURCE_MISSING', status: 404 });
    const att = await extractAttachment(loaded.raw, index);
    if (!att) throw new AppError('附件不存在（可能序号已变化）', { code: 'ATTACHMENT_NOT_FOUND', status: 404 });

    const asciiName = att.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
      'content-type': att.contentType || 'application/octet-stream',
      'content-length': String(att.content.length),
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      // 归档内容是固定的，短时间内重复点击不必重解析
      'cache-control': 'private, max-age=300',
      'x-attachment-name': encodeURIComponent(att.filename),
      'x-attachment-source': loaded.source,
    });
    res.end(att.content);
    return;
  }

  /* 单封邮件详情：不受 24 小时窗口限制（对话查邮件可能检索到很久以前的邮件） */
  const mailDetailMatch = url.pathname.match(/^\/api\/mails\/([^/]+)\/(\d+)$/);
  if (mailDetailMatch && method === 'GET') {
    const detail = await buildMailDetail({
      folder: decodeURIComponent(mailDetailMatch[1]),
      uid: Number(mailDetailMatch[2]),

      instanceId: instanceIdFrom(url),
      // 正文按需加载：列表页不需要，详情弹窗才要（避免每次都去解析归档/回源 IMAP）
      withBody: url.searchParams.get('body') !== '0',
    });
    return sendJson(res, 200, { ok: true, ...detail });
  }

  if (route === 'GET /api/drafts') {
    const instanceId = instanceIdFrom(url);
    const drafts = listDrafts({
      instanceId,
      status: url.searchParams.get('status') || undefined,
      since: url.searchParams.get('since') || undefined,
    });
    // 标签计数必须是**不受当前筛选影响**的全量统计，否则切到「已发送」后
    // 「待审核」的数字会变成 0，看起来像草稿丢了。
    const all = store.listDrafts({ instanceId });
    const counts = {
      pending: all.filter((d) => d.status === 'pending' || d.status === 'sending').length,
      failed: all.filter((d) => d.status === 'failed').length,
      sent: all.filter((d) => d.status === 'sent').length,
      all: all.length,
    };
    // 带上当前签名与引文设置，界面据此判断哪些草稿还没补签名 / 还没带引文
    return sendJson(res, 200, {
      ok: true,
      drafts,
      counts,
      signature: config.draft.signature || '',
      quoteOriginal: config.draft.quoteOriginal !== false,
      quoteStyle: config.draft.quoteStyle || 'zh-client',
      // 附件限制交给界面做实时提示（编码后体积预算、最多几个）
      attachmentMaxBytes: config.draft.attachmentMaxBytes,
      maxAttachments: config.draft.maxAttachments,
      attachmentUsage: attachmentSummary(),
    });
  }

  /* 把原始邮件引文补进已有草稿（必须放在 /api/drafts/:id 之前，否则会被当成 id） */
  if (route === 'POST /api/drafts/apply-quote') {
    const body = await readJsonBody(req);
    const out = await applyQuoteToDrafts({
      ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      instanceId: body.instanceId || instanceIdFrom(url),
    });
    const message = out.applied.length
      ? `已为 ${out.applied.length} 封草稿补上原始邮件引文${out.skipped.length ? `，跳过 ${out.skipped.length} 封` : ''}`
      : `没有需要处理的草稿（共 ${out.total} 封）`;
    return sendJson(res, 200, { ok: true, ...out, message });
  }

  /* 把配置里的签名补进已有草稿（必须放在 /api/drafts/:id 之前，否则会被当成 id） */
  if (route === 'POST /api/drafts/apply-signature') {
    const body = await readJsonBody(req);
    const out = applySignatureToDrafts({
      ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      instanceId: body.instanceId || instanceIdFrom(url),
    });
    const message = out.applied.length
      ? `已为 ${out.applied.length} 封草稿补上签名${out.skipped.length ? `，跳过 ${out.skipped.length} 封` : ''}`
      : `没有需要处理的草稿（共 ${out.total} 封）`;
    return sendJson(res, 200, { ok: true, ...out, message });
  }

  const draftMatch = url.pathname.match(/^\/api\/drafts\/([\w.-]+)$/);
  if (draftMatch) {
    const id = decodeURIComponent(draftMatch[1]);
    if (method === 'GET') return sendJson(res, 200, { ok: true, draft: getDraft(id) });
    if (method === 'PATCH') {
      const patch = await readJsonBody(req);
      const draft = updateDraft(id, patch);
      return sendJson(res, 200, { ok: true, draft, message: '草稿已保存' });
    }
    if (method === 'DELETE') {
      const out = deleteDraft(id);
      return sendJson(res, 200, {
        ok: true,
        ...out,
        message: out.freedAttachments ? `草稿已删除，并清理了 ${out.freedAttachments} 个附件文件` : '草稿已删除',
      });
    }
  }

  /* ---- 草稿附件 ---- */

  /**
   * 上传附件。
   *
   * **请求体就是文件原始字节**，文件名走 `?filename=`，类型走 `Content-Type`。
   * 这样不必实现 multipart 解析器（本项目零依赖 HTTP 层），
   * 前端 `fetch(url, { body: file })` 一行就能发。
   */
  const attUploadMatch = url.pathname.match(/^\/api\/drafts\/([\w.-]+)\/attachments$/);
  if (attUploadMatch && method === 'POST') {
    const id = decodeURIComponent(attUploadMatch[1]);
    const filename = url.searchParams.get('filename') || req.headers['x-filename'] || 'attachment';
    const buffer = await readRawBody(req, config.draft.attachmentMaxBytes + 1024 * 1024);
    const out = addDraftAttachment(id, {
      filename: decodeURIComponent(String(filename)),
      contentType: req.headers['content-type'],
      buffer,
    });
    return sendJson(res, 200, { ok: true, ...out, message: `已添加附件：${out.attachment.filename}` });
  }

  /** 下载/核对某个附件（发出去之前可以自己下回来看看）。 */
  const attGetMatch = url.pathname.match(/^\/api\/drafts\/([\w.-]+)\/attachments\/([\w.-]+)$/);
  if (attGetMatch && method === 'GET') {
    const { attachment, content } = getDraftAttachment(decodeURIComponent(attGetMatch[1]), decodeURIComponent(attGetMatch[2]));
    const asciiName = String(attachment.filename).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, {
      'content-type': attachment.contentType || 'application/octet-stream',
      'content-length': String(content.length),
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      'cache-control': 'no-store',
    });
    res.end(content);
    return;
  }

  if (attGetMatch && method === 'DELETE') {
    const out = removeDraftAttachment(decodeURIComponent(attGetMatch[1]), decodeURIComponent(attGetMatch[2]));
    return sendJson(res, 200, { ok: true, ...out, message: '附件已删除' });
  }

  const regenerateMatch = url.pathname.match(/^\/api\/drafts\/([\w.-]+)\/regenerate$/);  if (regenerateMatch && method === 'POST') {
    const body = await readJsonBody(req);
    const out = await regenerateDraft(decodeURIComponent(regenerateMatch[1]), body.instruction);
    return sendJson(res, 200, { ok: true, ...out, message: '已重新起草' });
  }

  const syncMatch = url.pathname.match(/^\/api\/drafts\/([\w.-]+)\/sync$/);
  if (syncMatch && method === 'POST') {
    const out = await syncDraftToMailbox(decodeURIComponent(syncMatch[1]));
    return sendJson(res, 200, { ok: true, ...out, message: out.mailbox ? `已写入 ${out.mailbox.folder}` : '服务器未确认' });
  }

  const sendMatch = url.pathname.match(/^\/api\/drafts\/([\w.-]+)\/send$/);
  if (sendMatch && method === 'POST') {
    const body = await readJsonBody(req);
    const out = await sendDraft(decodeURIComponent(sendMatch[1]), {
      confirm: body.confirm === true,
      deleteMailboxDraft: body.deleteMailboxDraft !== false,
      appendToSent: body.appendToSent,
    });
    return sendJson(res, 200, { ok: true, ...out, message: `已发送至 ${out.draft.to}` });
  }

  if (route === 'POST /api/drafts/send-batch') {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    if (!ids.length) throw new AppError('未选择要发送的草稿', { code: 'NO_DRAFTS_SELECTED', status: 400 });
    const results = await sendDrafts(ids, {
      confirm: body.confirm === true,
      deleteMailboxDraft: body.deleteMailboxDraft !== false,
      appendToSent: body.appendToSent,
    });
    const okCount = results.filter((r) => r.ok).length;
    return sendJson(res, 200, { ok: true, results, message: `成功发送 ${okCount}/${results.length} 封` });
  }

  /* ---- 报告 ---- */
  if (route === 'GET /api/reports') {
    return sendJson(res, 200, { ok: true, reports: store.listReports(40) });
  }

  const reportMatch = url.pathname.match(/^\/api\/reports\/([\w-]+)$/);
  if (reportMatch && method === 'GET') {
    const report = store.getReport(reportMatch[1]);
    if (!report) throw new AppError('报告不存在', { code: 'REPORT_NOT_FOUND', status: 404 });
    const markdown = store.readReportFile(report.file);
    if (url.searchParams.get('format') === 'raw') {
      return sendText(res, 200, markdown || '（文件已不存在）', 'text/markdown; charset=utf-8');
    }
    return sendJson(res, 200, { ok: true, report, markdown });
  }

  /* ---- 知识库问答 ---- */
  if (route === 'GET /api/knowledge') {
    const knowledge = buildKnowledge({
      instanceId: instanceIdFrom(url),
      windowHours: Number(url.searchParams.get('hours') || config.scan.windowHours),
      topic: url.searchParams.get('topic') || undefined,
    });
    return sendJson(res, 200, { ok: true, ...knowledge });
  }

  if (route === 'POST /api/knowledge/ask') {
    const body = await readJsonBody(req);
    if (!body.question || !String(body.question).trim()) {
      throw new AppError('请填写问题', { code: 'QUESTION_REQUIRED', status: 400 });
    }
    const out = await answerQuestion({
      instanceId: body.instanceId || instanceIdFrom(url),
      question: String(body.question),
      topic: body.topic || undefined,
      windowHours: body.windowHours,
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  /* ---- 对话式邮件检索 ---- */
  if (route === 'POST /api/search/emails') {
    const body = await readJsonBody(req);
    // 按需回补可能耗时较久，通过 SSE 把进度推给界面
    const out = await searchEmails({
      query: body.query ?? body.message,
      instanceId: body.instanceId || instanceIdFrom(url),
      limit: body.limit,
      onProgress: (p) => progressBus.emit('event', { type: 'search:progress', at: new Date().toISOString(), ...p }),
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (route === 'GET /api/search/activity') {
    const out = emailActivity({
      instanceId: instanceIdFrom(url),
      days: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : 30,
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  /* ---- 日历知识库 ---- */
  /**
   * 日历回顾分析（对话式）：把「请分析过去 30 天的日历并给优化建议」变成一份报告。
   *
   * 只读：只列日程、不改任何东西。报告落盘后可用 `/api/reports/:id?format=raw` 导出 md。
   */
  if (route === 'POST /api/calendar/review') {
    const body = await readJsonBody(req);
    const out = await runCalendarReview({
      query: body.query,
      preset: body.preset,
      from: body.from,
      to: body.to,
      now: body.now ? new Date(body.now) : new Date(),
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  /** 回顾区间预设（界面上的示例与下拉用）。 */
  if (route === 'GET /api/calendar/review/presets') {
    return sendJson(res, 200, {
      ok: true,
      presets: REVIEW_PRESETS,
      review: config.calendar.review,
      examples: [
        '请详细分析过去 30 天的日历，并给出工作优化建议',
        '上个月我开了多少会？时间都花在哪了',
        '过去一年我的时间分配有什么问题',
        '看看上季度有没有晚间和周末会议',
      ],
    });
  }

  if (route === 'GET /api/calendar/knowledge') {    const now = url.searchParams.get('now') ? new Date(url.searchParams.get('now')) : new Date();
    const insight = await getCalendarInsight({
      now,
      lookaheadDays: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : undefined,
      withAnalysis: url.searchParams.get('analysis') !== '0',
    });
    const events = insight.days.flatMap((d) => d.events);
    return sendJson(res, 200, {
      ok: true,
      ...insight,
      knowledge: {
        totalEvents: events.length,
        byDay: insight.days.map((d) => ({ day: d.key, label: d.label, count: d.count, busyHours: d.busyHours })),
        meetings: events.filter((e) => !e.allDay).length,
        allDay: events.filter((e) => e.allDay).length,
        withLocation: events.filter((e) => e.location).length,
        participants: [...new Set(events.flatMap((e) => e.attendees || []))].length,
        fromEmails: events.filter((e) => e.mailbotRef).length,
        topics: groupEventTopics(events),
      },
    });
  }

  /* ---- 日历数字人 ---- */
  if (url.pathname === '/api/calendar/status') {
    return sendJson(res, 200, { ok: true, ...calendarStatusPayload(actualPort) });
  }

  if (route === 'GET /api/calendar/config-hint') {
    const redirectUri = config.calendar.google.redirectUri || suggestedRedirectUri();
    return sendJson(res, 200, {
      ok: true,
      suggestedRedirectUri: redirectUri,
      scopes: CALENDAR_SCOPES,
      setupSteps: [
        '打开 Google Cloud Console，新建（或选择）一个项目',
        '在「API 和服务 → 库」中启用 Google Calendar API',
        '在「OAuth 同意屏幕」中配置：用户类型选「外部」，把本账号加入测试用户',
        '在「凭据 → 创建凭据 → OAuth 客户端 ID」中选择「Web 应用」',
        `把授权重定向 URI 填为：${redirectUri}`,
        '把生成的客户端 ID 与客户端密钥填入本页，保存后点「连接 Google 日历」完成授权',
      ],
      note: 'OAuth 同意屏幕处于「测试」状态时，refresh token 有效期为 7 天；长期使用请在同意屏幕页面点击「发布应用」。',
    });
  }

  if (route === 'POST /api/calendar/auth-url') {
    const body = await readJsonBody(req);
    const redirectUri = safeRedirectUri(req, config, body.redirectUri, actualPort);
    const out = startGoogleAuth({ redirectUri });
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (route === 'POST /api/calendar/disconnect') {
    const out = await revokeGoogleAuth();
    return sendJson(res, 200, { ok: true, ...out, message: '已断开 Google 日历连接' });
  }

  if (route === 'POST /api/calendar/test') {
    const out = await testGoogleConnection();
    return sendJson(res, 200, { ok: true, ...out, message: `连接正常：${out.calendar.summary}` });
  }

  if (route === 'GET /api/calendar/cals') {
    const calendars = await listGoogleCalendars();
    return sendJson(res, 200, { ok: true, calendars });
  }

  if (route === 'GET /api/calendar/insight') {
    const now = url.searchParams.get('now') ? new Date(url.searchParams.get('now')) : new Date();
    const out = await getCalendarInsight({
      now,
      lookaheadDays: url.searchParams.get('days') ? Number(url.searchParams.get('days')) : undefined,
      withAnalysis: url.searchParams.get('analysis') !== '0',
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (route === 'GET /api/calendar/upcoming') {
    const out = await getUpcoming({ limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined });
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (route === 'POST /api/calendar/events') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      throw new AppError('写入日历需要人工确认：请传入 confirm=true。', { code: 'CONFIRM_REQUIRED', status: 428 });
    }
    const sessionId = body.sessionId || newSessionId();
    // 允许直接给结构化事件（不经过对话）
    if (!body.sessionId && body.event) {
      const out = await acceptEmailSuggestion({ suggestion: { event: body.event, mail: body.mail || null }, instanceId: body.instanceId });
      return sendJson(res, 200, { ok: true, ...out, message: `已写入日历：${out.event.summary}` });
    }
    const out = await commitPending({ sessionId, override: body.override });
    return sendJson(res, 200, { ok: true, ...out, message: `已写入日历：${out.event.summary}` });
  }

  if (route === 'POST /api/calendar/events/cancel') {
    const body = await readJsonBody(req);
    return sendJson(res, 200, { ok: true, ...cancelPending({ sessionId: body.sessionId }) });
  }

  const calendarEventMatch = url.pathname.match(/^\/api\/calendar\/events\/([\w@.-]+)$/);
  if (calendarEventMatch && method === 'DELETE') {
    const eventId = decodeURIComponent(calendarEventMatch[1]);
    const out = await deleteGoogleEvent(eventId);
    appendAudit('calendar.event.delete', {
      // 标题优先用 Google 回传的；没有就退回界面传来的（历史日程可能已被改动）
      target: out.summary || url.searchParams.get('summary') || eventId,
      source: '界面删除日程',
      extra: { eventId, alreadyGone: !!out.alreadyGone },
    });
    return sendJson(res, 200, { ok: true, ...out, message: out.alreadyGone ? '该日程已不存在' : '已删除日程' });
  }

  /**
   * 修改已有日程。与"写入前编辑"不同：这条改的是**已经写进 Google 的**日程。
   * 只发 PATCH，body 里没有的字段（如参会人）保持不动。
   */
  if (calendarEventMatch && (method === 'PATCH' || method === 'PUT')) {
    const eventId = decodeURIComponent(calendarEventMatch[1]);
    const body = await readJsonBody(req);
    const out = await updateCalendarEvent({
      eventId,
      patch: body?.patch || body || {},
      instanceId: instanceIdFrom(url),
    });
    return sendJson(res, 200, { ok: true, ...out, message: `已保存修改：${out.event.summary}` });
  }

  if (route === 'POST /api/calendar/chat') {
    const body = await readJsonBody(req);
    const sessionId = body.sessionId || newSessionId();
    const out = await chatWithCalendar({ sessionId, message: body.message });
    return sendJson(res, 200, { ok: true, ...out });
  }

  const calendarSessionMatch = url.pathname.match(/^\/api\/calendar\/sessions\/([\w-]+)$/);
  if (calendarSessionMatch && method === 'GET') {
    const session = getCalendarSession(decodeURIComponent(calendarSessionMatch[1]));
    if (!session) throw new AppError('会话不存在或已过期', { code: 'SESSION_NOT_FOUND', status: 404 });
    return sendJson(res, 200, { ok: true, session });
  }

  if (route === 'POST /api/calendar/from-emails') {
    const body = await readJsonBody(req);
    const out = await suggestEventsFromEmails({
      instanceId: body.instanceId || instanceIdFrom(url),
      ids: Array.isArray(body.ids) ? body.ids.map(String) : undefined,
      windowHours: body.windowHours,
    });
    return sendJson(res, 200, { ok: true, ...out });
  }

  if (route === 'POST /api/calendar/from-emails/accept') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      throw new AppError('写入日历需要人工确认：请传入 confirm=true。', { code: 'CONFIRM_REQUIRED', status: 428 });
    }
    const out = await acceptEmailSuggestion({
      instanceId: body.instanceId || instanceIdFrom(url),
      suggestion: body.suggestion,
      override: body.override,
    });
    return sendJson(res, 200, { ok: true, ...out, message: `已写入日历：${out.event.summary}` });
  }

  /* ---- 状态 ---- */
  if (route === 'GET /api/status') {
    return sendJson(res, 200, {
      ok: true,
      running: isRunning(config.defaultInstanceId),
      current: currentRun(config.defaultInstanceId),
      counts: countsPayload(),
      lastRun: store.lastRun({}) || null,
    });
  }

  if (route === 'POST /api/state/reset') {
    const body = await readJsonBody(req);
    if (body.confirm !== true) {
      throw new AppError('重置本地数据需要 confirm=true', { code: 'CONFIRM_REQUIRED', status: 428 });
    }
    const p = getPaths();
    if (fs.existsSync(p.stateFile)) fs.renameSync(p.stateFile, `${p.stateFile}.bak-${Date.now()}`);
    store.resetStateCache();
    store.loadState({ force: true });
    store.persistState();
    return sendJson(res, 200, { ok: true, message: '本地分析数据已重置（原文件已备份）' });
  }

  return null;
}

function countsPayload() {  const config = getConfig();
  const state = store.getState();
  const id = instanceIdFrom(null) || config.defaultInstanceId;
  const pendingDrafts = state.drafts.filter((d) => d.status === 'pending' || d.status === 'failed');

  /**
   * 导航徽标必须与总览卡片**同一口径**：都取当前回看窗口内的、需要我处理的邮件数。
   *
   * 早期这里统计的是「全部历史里 needsReply 为真的记录数」，会随着分析次数单调增长
   * （实测卡片显示 2、徽标显示 40），用几天就变成一个没有意义的数字。
   */
  const since = hoursAgo(config.scan.windowHours);
  let needsAction = 0;
  try {
    const windowRecords = store.listAnalyses({ instanceId: id, since, limit: 2000 });
    needsAction = windowRecords.filter((a) => isDirectAction(a) && a.type !== 'spam').length;
  } catch {
    needsAction = 0;
  }

  /*
   * 跟催徽标只显示**超期**数，而不是"未完成总数"。
   *
   * 跟催项天然是"慢慢积累"的（我答应的事、我在等的回复），
   * 把全部未完成都算成徽标会让它永远挂着一个数字——和"需留意不能变成第二个收件箱"
   * 同一个道理：**只在该提醒的时候提醒**，超期才是真的该动手了。
   */
  let followUpOverdue = 0;
  try {
    followUpOverdue = store.summarizeFollowUps().overdue;
  } catch {
    followUpOverdue = 0;
  }

  return {
    analyses: Object.keys(state.analyses).length,
    needsAction,
    // 保留旧字段名以免破坏已有调用方；语义已改为「当前窗口的需你处理」
    needsReply: needsAction,
    drafts: state.drafts.length,
    pendingDrafts: pendingDrafts.length,
    sentDrafts: state.drafts.filter((d) => d.status === 'sent').length,
    runs: state.runs.length,
    followUpOverdue,
  };
}

/** 供测试断言「导航徽标与总览卡片同口径」用（正常运行时不需要）。 */
export function countsPayloadForTest() {
  return countsPayload();
}

/* ------------------------------------------------------------ SSE */

function handleEvents(req, res, url) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(`retry: 3000\n\n`);

  const filterRun = url.searchParams.get('runId');
  const listener = (payload) => {
    if (filterRun && payload.runId !== filterRun) return;
    res.write(`event: progress\ndata: ${safeJson(payload)}\n\n`);
  };
  progressBus.on('event', listener);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      /* ignore */
    }
  }, 20_000);

  const cleanup = () => {
    clearInterval(heartbeat);
    progressBus.off('event', listener);
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

/* ------------------------------------------------------------ 入口 */

/**
 * 建 HTTP 服务。
 *
 * `tls` 传入证书材料时用 HTTPS，否则用 HTTP——**由调用方决定**，
 * 这里不自己读配置：证书解析失败必须让启动失败，而不是悄悄退回明文。
 */
export function createServer({ rootDir, tls = null } = {}) {
  // rootDir 只在启动早期用于定位数据目录；已经有内存配置时不要重置，否则会丢掉 CLI/测试注入的配置
  if (rootDir && !isConfigLoaded()) loadConfig({ rootDir });
  ensureDirs();
  store.loadState({ force: true });

  const handler = async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const config = getConfig();
    // 实际监听端口（port=0 时由系统分配），用于推导回调地址与同源判断
    const actualPort = server.address()?.port || config.web.port;

    // 安全响应头：所有响应都带（含静态资源与错误页）
    for (const [k, v] of Object.entries(securityHeaders({ https: server.__mailbotHttps === true }))) {
      res.setHeader(k, v);
    }

    try {
      // Host 白名单 + 登录失败限速：放在最前面，静态资源也一并受保护
      const gate = gateRequest(req, res, url, config);
      if (gate) {
        if (gate.retryAfterSec) res.setHeader('retry-after', String(gate.retryAfterSec));
        sendJson(res, gate.status, gate.payload);
        return;
      }

      // 允许本机浏览器直连（同源），无需 CORS；仅对 SSE 做必要处理
      if (url.pathname === '/api/events') {
        handleEvents(req, res, url);
        return;
      }

      // OAuth 回调由 Google 从浏览器重定向回来，浏览器会带上 Origin（accounts.google.com），
      // 因此这一步要放在同源校验之前，只靠 state 校验 CSRF。
      if (url.pathname === '/api/calendar/oauth/callback') {
        const handled = await handleOAuthCallback(req, res, url);
        if (handled === null) sendText(res, 404, 'Not Found');
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        // 同源校验：仅对可能产生副作用或泄露凭据的接口收紧
        /*
         * 同源校验：对可能产生副作用或泄露凭据的接口收紧。
         *
         * `/api/backup/export` 是 GET，但它**能导出全部数据（含密钥）**，
         * 所以必须一并纳入——第三方页面即使读不到响应，也不该能触发它下载。
         */
        const needsSameOrigin =
          req.method !== 'GET' ||
          url.pathname === '/api/config' ||
          url.pathname === '/api/calendar/status' ||
          url.pathname === '/api/backup/export';
        if (needsSameOrigin && !isSameOrigin(req, config)) {
          sendJson(res, 403, {
            ok: false,
            code: 'CROSS_ORIGIN_BLOCKED',
            message: '已拒绝跨源请求（防止凭据被第三方页面读取）。请通过本机浏览器界面访问。',
          });
          return;
        }
        const handled = await handleApi(req, res, url, actualPort, { https: server.__mailbotHttps, tls: server.__mailbotTls });
        if (handled === null) {
          sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: `接口不存在：${req.method} ${url.pathname}` });
        }
        return;
      }

      if (serveStatic(req, res, url.pathname)) return;
      // 前端是单页应用，未命中的路径回落到 index.html
      if (!path.extname(url.pathname)) {
        if (serveStatic(req, res, '/index.html')) return;
      }
      sendText(res, 404, 'Not Found');
    } catch (err) {
      const payload = toErrorPayload(err);
      const status = err instanceof AppError ? err.status : 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname} 失败：${err?.stack || err}`);
      else log.warn(`${req.method} ${url.pathname} → ${payload.code}：${payload.message}`);
      if (!res.headersSent) sendJson(res, status, payload);
      else res.end();
    } finally {
      if (!res.headersSent) return;
      log.debug(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  };

  const server = tls
    ? https.createServer({ key: tls.key, cert: tls.cert }, handler)
    : http.createServer(handler);
  server.__mailbotHttps = !!tls;
  server.__mailbotTls = tls;

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    log.debug(`clientError: ${err.message}`);
  });

  return server;
}

export async function startServer({ rootDir, port, host } = {}) {
  const config = getConfig();
  const listenPort = port ?? config.web.port;
  const listenHost = host ?? config.web.host;

  /*
   * HTTPS：在监听之前就把证书定下来。
   *
   * 这里刻意**不做任何降级**：配置了 HTTPS 却拿不到证书/私钥就抛错、启动失败。
   * "以为走的是 HTTPS、其实在明文传令牌"是比"启动不起来"严重得多的结果。
   */
  let tls = null;
  try {
    tls = await resolveTls({ config, dataDir: getPaths().dataDir, rootDir: getPaths().rootDir });
  } catch (err) {
    throw new AppError(`HTTPS 启动失败：${err.message}`, { code: 'TLS_SETUP_FAILED' });
  }
  const server = createServer({ rootDir, tls });

  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err?.code === 'EADDRINUSE') {
        reject(
          new AppError(
            `端口 ${listenPort} 已被占用。可能已经有一个邮箱数字人在运行；` +
              `请打开 http://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${listenPort} 直接使用，` +
              `或用 --port 指定其它端口。`,
            { code: 'PORT_IN_USE', status: 500 },
          ),
        );
        return;
      }
      if (err?.code === 'EACCES') {
        reject(new AppError(`没有权限监听端口 ${listenPort}（1024 以下端口通常需要管理员权限）。`, { code: 'PORT_DENIED', status: 500 }));
        return;
      }
      reject(err);
    });
    server.listen(listenPort, listenHost, resolve);
  });

  /*
   * 取实际端口。
   *
   * `listen(0)` 时端口由系统分配，理论上回调触发时就已经写进 `address()`；
   * 但实测（Windows + 连续多次起停）偶发拿到 null / 0，于是返回的 URL 会是
   * `http://127.0.0.1:0`，下游 fetch 只会报一句莫名其妙的 "bad port"。
   * 这里等一下再取一次，仍取不到就**明确报错**，而不是交出一个坏 URL。
   */
  let addr = server.address();
  for (let i = 0; i < 20 && (!addr || !addr.port); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    addr = server.address();
  }
  if (!addr || !addr.port) {
    throw new AppError('服务已监听但拿不到端口号（可能是系统资源紧张）：请重试，或改用固定端口', {
      code: 'PORT_UNRESOLVED',
    });
  }
  const actualPort = addr.port;
  const scheme = server.__mailbotHttps ? 'https' : 'http';
  const url = `${scheme}://${listenHost === '0.0.0.0' ? '127.0.0.1' : listenHost}:${actualPort}`;
  log.info(`邮箱与日历数字人已启动：${url}`);
  /*
   * 监听地址不止本机时**必须**在日志里说清楚：这是"别人也能连上"的那一刻，
   * 用户不该靠翻设置页才发现。
   */
  if (listenHost === '0.0.0.0' || listenHost === '::') {
    const lans = lanAddresses();
    log.warn(`正在监听所有网卡（${listenHost}）：同一网络内的设备都能访问这个服务`);
    for (const l of lans) log.warn(`  局域网可达：${scheme}://${l.address}:${actualPort}（网卡 ${l.iface}）`);
    if (!config.web.authToken) log.error('  ⚠️ 当前**没有设置访问令牌**：任何能连上的人都能直接使用，请立刻在设置里生成一个');
    if (!server.__mailbotHttps) log.warn('  局域网内流量是明文（含访问令牌），建议在「访问与安全」里启用 HTTPS');
  }
  if (server.__mailbotHttps && server.__mailbotTls?.selfSigned) {
    log.warn('HTTPS 用的是自签证书：浏览器会提示"不受信任"，选择继续访问即可（传输仍是加密的）');
  }
  if (!config.llm.apiKey) log.warn('尚未配置大模型 API Key，分析功能不可用（可在 .env 设置 DEEPSEEK_API_KEY）');
  if (!config.instances.some((i) => i.imap.authPass)) log.warn('尚未配置邮箱授权码，请到界面「邮箱设置」中填写');

  /*
   * 把 SSE 广播注入定时任务模块：定时分析跑完后要能推一条 `notify` 给页面。
   * 用注入而不是让 schedule.js 直接 import index.js，避免循环依赖。
   */
  setNotifyEmitter((payload) => progressBus.emit('event', { type: 'notify', at: new Date().toISOString(), ...payload }));
  if (config.schedule?.enabled) {
    startScheduler();
    log.info(`定时分析已开启：${(config.schedule.times || []).join('、')}（星期 ${(config.schedule.days || []).join(',')}，时区 ${config.calendar?.timeZone}）`);
  }
  return { server, url, port: actualPort, host: listenHost };
}
