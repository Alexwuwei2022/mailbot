/**
 * Google Calendar REST v3 客户端。
 *
 * 只覆盖本项目需要的端点：
 *   GET    /users/me/calendarList                     列出日历（设置页下拉用）
 *   GET    /calendars/{id}                            日历元信息（校验 calendarId）
 *   GET    /calendars/{id}/events                     列出事件（singleEvents 展开重复日程）
 *   POST   /calendars/{id}/events                     新建事件
 *   PATCH  /calendars/{id}/events/{eventId}           局部更新
 *   DELETE /calendars/{id}/events/{eventId}           删除
 *   POST   /freeBusy                                  空闲/忙碌查询
 *
 * 认证统一走 google-auth.getAccessToken()（自动刷新）。
 */

import { getConfig } from '../config/index.js';
import { AppError, isRetryableNetworkError, log, retry } from '../lib/util.js';
import { DEFAULT_TIMEOUT_MS, describeNetworkError, httpRequest, resolveProxyFor } from '../lib/http.js';
import { getAccessToken, googleNotConfiguredError, validateGoogleConfig } from './google-auth.js';
import { toRfc3339 } from './time.js';

const API_BASE = 'https://www.googleapis.com/calendar/v3';

/** 允许通过环境变量覆盖，测试时指向本地模拟服务器。 */
function apiBase() {
  return (process.env.MAILBOT_GOOGLE_API_BASE || API_BASE).replace(/\/+$/, '');
}

/** 当前配置的 Google 访问代理（可能为 null）。解析失败时返回一个带 error 的对象。 */
export function currentProxy() {
  try {
    return resolveProxyFor(API_BASE, { proxy: getConfig().calendar?.proxy || '' });
  } catch (err) {
    return { error: err.message, code: err.code || 'PROXY_INVALID', raw: String(getConfig().calendar?.proxy || '') };
  }
}

function enc(value) {
  return encodeURIComponent(String(value));
}

async function apiFetch(pathname, { method = 'GET', query, body, expect = 'json', headers } = {}) {
  const token = await getAccessToken();
  const url = new URL(`${apiBase()}${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  let res;
  try {
    res = await httpRequest(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(headers || {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      // 只对 Google 请求生效：邮件与大模型走国内网络，不应被代理影响
      proxy: getConfig().calendar?.proxy || '',
    });
  } catch (err) {
    if (err?.code === 'ETIMEDOUT') {
      throw new AppError(`Google Calendar 请求超时（>${DEFAULT_TIMEOUT_MS / 1000}s）`, {
        code: 'GOOGLE_TIMEOUT',
        status: 504,
      });
    }
    // 把底层错误码（ENOTFOUND / ECONNREFUSED / ECONNRESET / 代理相关）翻成可执行提示，
    // 而不是只丢一句 "fetch failed"
    const info = describeNetworkError(err, { target: 'Google Calendar', proxyUsed: currentProxy() });
    const e = new Error(`Google Calendar ${info.message}`);
    e.code = info.code;
    e.networkHint = info.hint;
    e.proxyAdvice = info.advice;
    throw e;
  }

  const text = res.text;
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }

  // 失败状态必须先判错，否则 expect:'none'（DELETE）会把 403/404 当成成功
  if (!res.ok) {
    const message = data?.error?.message || text.slice(0, 300) || res.statusText;
    const first = data?.error?.errors?.[0] || {};
    const reason = first.reason || data?.error?.status || '';
    const err = new Error(`HTTP ${res.status} ${message}`);
    err.status = res.status;
    err.reason = reason;
    // Google 在「API 未启用」这类错误里会直接给出启用链接，必须保留下来给用户
    err.extendedHelp = first.extendedHelp || data?.error?.details?.find?.((d) => d?.links)?.links?.[0]?.url || '';
    err.googleDetail = data?.error || null;
    throw err;
  }

  if (res.status === 204 || expect === 'none') return { ok: true, status: res.status, data: null };
  return { ok: true, status: res.status, data };
}

/**
 * 把 Google 的错误翻译成可执行的中文提示。
 */
export function wrapGoogleError(err, action = 'Calendar 操作') {
  if (err instanceof AppError) return err;
  const status = err?.status;
  const raw = err?.message || String(err);
  const reason = err?.reason || '';
  const activationUrl = err?.extendedHelp || '';
  let hint = '';

  // 「API 未启用」必须单独识别：它也是 403，但和权限/calendarId 完全是两回事，
  // 归到「权限被拒」会把用户引向错误的排查方向（这道题很容易踩）。
  const apiDisabled =
    reason === 'SERVICE_DISABLED' ||
    reason === 'accessNotConfigured' ||
    /has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(raw);

  if (apiDisabled) {
    const projectMatch = raw.match(/project[\/\s]+(\d{6,})/i) || raw.match(/project=(\d{6,})/i);
    const project = projectMatch ? projectMatch[1] : null;
    const link = activationUrl || (project ? `https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=${project}` : '');
    hint =
      '该 Google Cloud 项目里还没有启用「Google Calendar API」。' +
      (project ? `项目编号 ${project}。` : '') +
      `请打开 ${link || 'Google Cloud Console → API 和服务 → 库'} 点击「启用」，等 1-2 分钟生效后重试。`;
    return new AppError(`${action}失败：Google Calendar API 未启用。`, {
      code: 'GOOGLE_API_DISABLED',
      status: 502,
      detail: { googleStatus: status || 403, reason: reason || 'SERVICE_DISABLED', project, activationUrl: link || null, hint },
    });
  }

  if (status === 401) {
    hint = '访问令牌无效或已被撤销，请重新点击「连接 Google 日历」授权。';
  } else if (status === 403) {
    if (/insufficient|scope/i.test(raw) || reason === 'insufficientPermissions') {
      hint = '授权范围不足。请重新连接并同意「管理日历事件」权限。';
    } else if (/rateLimitExceeded|quotaExceeded|userRateLimitExceeded/i.test(raw) || reason.includes('ateLimit')) {
      hint = '触发 Google 接口配额限制，请稍后重试（可降低「起草并发数」）。';
    } else {
      hint = '权限被拒。请确认该 Google 账号可写入目标日历（calendarId 是否正确）。';
    }
  } else if (status === 404) {
    hint = '目标日历或事件不存在。请检查「calendarId」，或该日程已被删除。';
  } else if (status === 400) {
    if (/timeZone|time zone/i.test(raw)) hint = '时区或时间格式不合法，请检查「时区」设置。';
    else if (/Invalid Value|start|end/i.test(raw)) hint = '开始/结束时间不合法，请确认结束时间晚于开始时间。';
  } else if (isRetryableNetworkError(err)) {
    hint = '网络或服务端临时故障，已自动重试；若持续失败请检查网络出口。';
  }

  /*
   * 本地文件系统错误必须单独处理。
   *
   * 实测踩过：令牌需要刷新时，写 `google-token.json` 的临时文件失败（EPERM，磁盘只读、
   * ACL 或杀软拦截），结果被归到下面的"网络层失败"分支，提示用户
   * 「请到设置里填写代理端口」——把人往完全错误的方向带，白折腾一圈。
   * 本地 IO 与"连不上 Google"没有任何关系，必须分开报。
   */
  const LOCAL_IO_CODES = new Set(['EPERM', 'EACCES', 'EROFS', 'ENOSPC', 'EDQUOT', 'EBUSY', 'EMFILE', 'ENFILE', 'EISDIR', 'ENOTDIR']);
  if (LOCAL_IO_CODES.has(String(err?.code || ''))) {
    const isDisk = ['ENOSPC', 'EDQUOT'].includes(String(err.code));
    return new AppError(
      `${action}失败：${raw} — ` +
        (isDisk
          ? '这看起来是**磁盘空间/配额不足**，不是网络问题。请清理磁盘空间后重试。'
          : '这看起来是**本地文件读写被拒绝**（权限、只读、或被安全软件拦截），不是网络问题。' +
            '请检查数据目录（`data/`）的写入权限；若开着杀毒/安全软件，请把数据目录加入白名单。'),
      {
        code: 'LOCAL_IO_ERROR',
        status: 500,
        detail: { ioCode: err.code || null, path: err?.path || null, action: 'local-file' },
      },
    );
  }

  // 网络层失败（根本没能连上 Google）单独成一类：它和「被拒绝」「配额」完全不同，
  // 提示必须落到「本机到 Google 的出口」和「代理」这两个可执行动作上。
  if (!status && (err?.code || err?.networkHint || err?.proxyAdvice)) {
    const proxy = currentProxy();
    const where = err.proxyAdvice || (proxy && !proxy.error && proxy.raw
      ? `当前已配置代理 ${proxy.raw}，请确认代理软件正在运行、且允许访问 Google。`
      : '当前没有配置代理。若这台机器需要借助代理/VPN 才能访问 Google，请到「设置 → 日历数字人 → 网络代理」填写代理软件的 HTTP 端口（如 http://127.0.0.1:7890）。');
    return new AppError(`${action}失败：${raw} — ${where}`, {
      code: 'GOOGLE_NETWORK_ERROR',
      status: 502,
      detail: {
        networkCode: err?.code || null,
        hint: err?.networkHint || null,
        proxy: proxy?.raw || null,
        proxyError: proxy?.error || null,
        advice: where,
      },
    });
  }

  const code = status === 401 ? 'GOOGLE_UNAUTHORIZED' : status === 403 ? 'GOOGLE_FORBIDDEN' : 'GOOGLE_ERROR';
  return new AppError(`${action}失败：${raw}${hint ? ` — ${hint}` : ''}`, {
    code,
    status: 502,
    detail: { googleStatus: status || null, reason: reason || null, activationUrl: activationUrl || null, hint },
  });
}

/**
 * 带重试的调用。
 *
 * 写操作必须区分**幂等**与**非幂等**：
 *   - GET：可安全重试；
 *   - DELETE / PATCH：本身幂等，但重试仍可能掩盖真实错误，因此只对「请求未送达」类
 *     网络错误重试；
 *   - POST（创建日程）：**绝不重试**。首次请求可能已经在服务端成功，只是响应没回来，
 *     重试会创建出重复日程——这比失败更糟。
 */
function withRetry(fn, label, { method = 'GET' } = {}) {
  // POST：只执行一次，不做任何重试
  if (method === 'POST') return Promise.resolve().then(() => fn());
  if (method === 'DELETE' || method === 'PATCH' || method === 'PUT') {
    return retry(fn, {
      attempts: 2,
      label,
      shouldRetry: (err) => {
        // 只有「连接根本没建立 / 请求写出去之前就失败」才安全重试
        const code = err?.code || err?.cause?.code;
        return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(code);
      },
    });
  }
  return retry(fn, {
    attempts: 3,
    label,
    shouldRetry: (err) => {
      // 配置类/确定性的网络失败重试没有意义，只会白等：
      // 域名解析不了、端口没人监听、代理拒绝隧道——这些不重试也一样。
      const code = err?.code || err?.cause?.code || '';
      if (['ENOTFOUND', 'ECONNREFUSED', 'PROXY_CONNECT_FAILED', 'PROXY_AUTH_REQUIRED', 'PROXY_INVALID', 'PROXY_SOCKS_UNSUPPORTED'].includes(code)) {
        return false;
      }
      return isRetryableNetworkError(err);
    },
  });
}

/* ------------------------------------------------------------ 日历 */

export async function listCalendars() {
  try {
    const { data } = await withRetry(() => apiFetch('/users/me/calendarList', { query: { maxResults: 250 } }), '列出日历');
    return (data?.items || []).map((c) => ({
      id: c.id,
      summary: c.summary,
      description: c.description || '',
      primary: !!c.primary,
      accessRole: c.accessRole,
      timeZone: c.timeZone || null,
      backgroundColor: c.backgroundColor || null,
    }));
  } catch (err) {
    throw wrapGoogleError(err, '列出日历');
  }
}

export async function getCalendarMeta(calendarId) {
  const id = calendarId || getConfig().calendar.calendarId;
  try {
    const { data } = await withRetry(() => apiFetch(`/calendars/${enc(id)}`), '读取日历信息');
    return { id: data.id, summary: data.summary, timeZone: data.timeZone || null, description: data.description || '' };
  } catch (err) {
    throw wrapGoogleError(err, '读取日历信息');
  }
}

/* ------------------------------------------------------------ 事件 */

/**
 * 把 Google 事件对象规整成界面/模型都好用的形态。
 */
export function normalizeEvent(item) {
  const startRaw = item.start?.dateTime || item.start?.date || null;
  const endRaw = item.end?.dateTime || item.end?.date || null;
  const allDay = !!item.start?.date && !item.start?.dateTime;
  return {
    id: item.id,
    status: item.status || 'confirmed',
    summary: item.summary || '(无标题)',
    description: item.description || '',
    location: item.location || '',
    start: startRaw,
    end: endRaw,
    allDay,
    startTimeZone: item.start?.timeZone || null,
    endTimeZone: item.end?.timeZone || null,
    /*
     * 以下几个字段决定"这条日程算不算工作负荷"（见 calendar/classify.js）：
     *   - eventType: default / focusTime / outOfOffice / workingLocation / fromGmail
     *   - transparency: opaque（占忙，默认）/ transparent（不占忙）
     *   - visibility: default / public / private / confidential
     * 之前完全没取这些字段，于是「在家办公」「休假」「不占忙的提醒」都会被算成忙碌时间。
     */
    eventType: item.eventType || 'default',
    transparency: item.transparency || 'opaque',
    visibility: item.visibility || 'default',
    attendees: (item.attendees || []).map((a) => ({
      email: a.email,
      displayName: a.displayName || '',
      responseStatus: a.responseStatus || null,
      organizer: !!a.organizer,
      self: !!a.self,
      resource: !!a.resource,
    })),
    organizer: item.organizer ? { email: item.organizer.email, displayName: item.organizer.displayName || '' } : null,
    htmlLink: item.htmlLink || null,
    hangoutLink: item.hangoutLink || null,
    recurringEventId: item.recurringEventId || null,
    created: item.created || null,
    updated: item.updated || null,
    /** 本系统写入时带上的来源标记，便于识别「由邮件生成」 */
    mailbotSource: item.extendedProperties?.private?.mailbotSource || null,
    mailbotRef: item.extendedProperties?.private?.mailbotRef || null,
  };
}

/**
 * 列出事件。
 * @param {object} options { calendarId, timeMin, timeMax, maxResults, singleEvents, orderBy, q, timeZone }
 */
export async function listEvents(options = {}) {
  const { calendar } = getConfig();
  const calendarId = options.calendarId || calendar.calendarId;
  const query = {
    timeMin: options.timeMin ? toRfc3339(options.timeMin) : undefined,
    timeMax: options.timeMax ? toRfc3339(options.timeMax) : undefined,
    maxResults: Math.min(2500, options.maxResults || 250),
    singleEvents: options.singleEvents === false ? 'false' : 'true',
    orderBy: options.orderBy || 'startTime',
    timeZone: options.timeZone || calendar.timeZone,
    q: options.q || undefined,
    pageToken: options.pageToken || undefined,
    showDeleted: 'false',
  };
  try {
    const { data } = await withRetry(
      () => apiFetch(`/calendars/${enc(calendarId)}/events`, { query }),
      '列出日程',
    );
    return {
      calendarId,
      timeZone: data?.timeZone || calendar.timeZone,
      items: (data?.items || []).map(normalizeEvent),
      nextPageToken: data?.nextPageToken || null,
      nextSyncToken: data?.nextSyncToken || null,
      updated: data?.updated || null,
    };
  } catch (err) {
    throw wrapGoogleError(err, '列出日程');
  }
}

/**
 * 取完一个时间段的**全部**日程（自动翻页）。
 *
 * 为什么必须有它：Google 单页最多 2500 条，超额会返回 `nextPageToken`。
 * 之前的实现直接丢弃这个 token——查一年日历时（重复日程展开成实例后轻易上千条）
 * 会**静默少掉一大半**，而报告看起来完全正常。这类"缺数据却看不出来"的问题最难排查，
 * 所以这里既翻页、也如实上报是否截断。
 *
 * @param {object} options { timeMin, timeMax, calendarId, timeZone, maxTotal, perPage, onProgress }
 * @returns {Promise<{calendarId, timeZone, items, pages, fetched, truncated, maxTotal}>}
 */
export async function listAllEvents(options = {}) {
  const maxTotal = Math.max(1, Number(options.maxTotal) || 5000);
  const perPage = Math.min(2500, Number(options.perPage) || 2500);
  const items = [];
  let pageToken = null;
  let pages = 0;
  let calendarId = options.calendarId || getConfig().calendar.calendarId;
  let timeZone = options.timeZone || getConfig().calendar.timeZone;
  let truncated = false;

  // 硬性翻页上限：即便服务端一直给 token 也不能无限循环
  for (let i = 0; i < 20; i += 1) {
    const page = await listEvents({
      calendarId,
      timeZone,
      timeMin: options.timeMin,
      timeMax: options.timeMax,
      maxResults: perPage,
      pageToken,
      singleEvents: options.singleEvents,
      orderBy: options.orderBy,
      q: options.q,
    });
    pages += 1;
    calendarId = page.calendarId;
    timeZone = page.timeZone;
    items.push(...page.items);
    options.onProgress?.({ pages, fetched: items.length });
    pageToken = page.nextPageToken;
    if (!pageToken) break;
    if (items.length >= maxTotal) {
      // 到达自设上限：如实标记截断，而不是假装取完了
      truncated = true;
      break;
    }
  }
  if (items.length > maxTotal) items.length = maxTotal;

  return { calendarId, timeZone, items, pages, fetched: items.length, truncated, maxTotal };
}

/**
 * 把内部事件草稿转成 Google 请求体。
 * 关键点：不带偏移的本地时间必须显式带 timeZone，否则 Google 会按 UTC 解释。
 */
export function toGoogleEventBody(draft, { timeZone } = {}) {
  const tz = timeZone || getConfig().calendar.timeZone;
  const body = { summary: draft.summary || '(无标题)' };
  if (draft.description) body.description = draft.description;
  if (draft.location) body.location = draft.location;

  if (draft.allDay) {
    // 全天事件用 date（YYYY-MM-DD），且 end.date 是「次日」（Google 的排他语义）
    body.start = { date: draft.allDayStart };
    body.end = { date: draft.allDayEnd };
  } else {
    body.start = { dateTime: toRfc3339(draft.start), timeZone: draft.timeZone || tz };
    body.end = { dateTime: toRfc3339(draft.end), timeZone: draft.timeZone || tz };
  }

  if (Array.isArray(draft.attendees) && draft.attendees.length) {
    body.attendees = draft.attendees.map((a) => (typeof a === 'string' ? { email: a } : { email: a.email, displayName: a.displayName || undefined }));
  }
  if (draft.reminders?.length) {
    body.reminders = { useDefault: false, overrides: draft.reminders.map((m) => ({ method: 'popup', minutes: Number(m) })) };
  }
  const priv = {};
  if (draft.source) priv.mailbotSource = String(draft.source);
  if (draft.ref) priv.mailbotRef = String(draft.ref);
  if (Object.keys(priv).length) body.extendedProperties = { private: priv };
  return body;
}

export async function createEvent(draft, options = {}) {
  const { calendar } = getConfig();
  const calendarId = options.calendarId || calendar.calendarId;
  const sendUpdates = options.sendUpdates || calendar.sendUpdates || 'none';
  const body = toGoogleEventBody(draft, { timeZone: options.timeZone || calendar.timeZone });
  try {
    const { data } = await withRetry(
      () =>
        apiFetch(`/calendars/${enc(calendarId)}/events`, {
          method: 'POST',
          query: { sendUpdates, conferenceDataVersion: undefined },
          body,
        }), '创建日程', { method: 'POST' });
    log.info(`已创建日程：${data.summary} @ ${data.start?.dateTime || data.start?.date}`);
    return normalizeEvent(data);
  } catch (err) {
    throw wrapGoogleError(err, '创建日程');
  }
}

export async function updateEvent(eventId, patch, options = {}) {
  const { calendar } = getConfig();
  const calendarId = options.calendarId || calendar.calendarId;
  const sendUpdates = options.sendUpdates || calendar.sendUpdates || 'none';
  const body = {};
  if (patch.summary !== undefined) body.summary = patch.summary;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.start !== undefined || patch.end !== undefined) {
    if (patch.allDay) {
      body.start = { date: patch.allDayStart };
      body.end = { date: patch.allDayEnd };
    } else {
      const tz = patch.timeZone || calendar.timeZone;
      if (patch.start) body.start = { dateTime: toRfc3339(patch.start), timeZone: tz };
      if (patch.end) body.end = { dateTime: toRfc3339(patch.end), timeZone: tz };
    }
  }
  try {
    const { data } = await withRetry(
      () => apiFetch(`/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'PATCH', query: { sendUpdates }, body }),
      '更新日程', { method: 'PATCH' });
    return normalizeEvent(data);
  } catch (err) {
    throw wrapGoogleError(err, '更新日程');
  }
}

export async function deleteEvent(eventId, options = {}) {
  const { calendar } = getConfig();
  const calendarId = options.calendarId || calendar.calendarId;
  const sendUpdates = options.sendUpdates || calendar.sendUpdates || 'none';
  try {
    // DELETE 不带查询参数：部分代理/网关会因此把 204 变成 200，反而让响应体解析出问题
    await withRetry(
      () =>
        apiFetch(`/calendars/${enc(calendarId)}/events/${enc(eventId)}`, {
          method: 'DELETE',
          expect: 'none',
          headers: sendUpdates !== 'none' ? { 'x-mailbot-send-updates': sendUpdates } : undefined,
        }), '删除日程', { method: 'DELETE' });
    return { ok: true, id: eventId };
  } catch (err) {
    const wrapped = wrapGoogleError(err, '删除日程');
    // 已经不存在，视为成功（幂等）
    const status = wrapped.detail?.googleStatus;
    if (status === 404 || status === 410) return { ok: true, id: eventId, alreadyGone: true };
    throw wrapped;
  }
}

/**
 * 校验连接是否真的可用（设置页「测试连接」用）。
 *
 * 先看凭据、再看授权，这样能把「凭据没填」和「凭据填了但还没授权」区分开，
 * 否则用户配好凭据点测试只会看到「尚未连接」，不知道该做什么。
 */
export async function testConnection() {
  const cfg = validateGoogleConfig();
  if (!cfg.ok) {
    throw googleNotConfiguredError(cfg.problems);
  }
  const { connectionStatus } = await import('./google-auth.js');
  if (!connectionStatus().connected) {
    throw new AppError(
      'Google 凭据已配置完成，但还没有完成授权。请到「日历」页点「连接 Google 日历」，在 Google 页面同意授权后再测试。',
      { code: 'GOOGLE_NOT_CONNECTED', status: 401, detail: { stage: 'oauth-not-granted' } },
    );
  }
  const meta = await getCalendarMeta();
  let calendars = [];
  try {
    calendars = await listCalendars();
  } catch (err) {
    log.debug(`列出日历失败（不影响连接判定）：${err?.message || err}`);
  }
  return { ok: true, calendar: meta, calendarCount: calendars.length, calendars: calendars.slice(0, 50) };
}
