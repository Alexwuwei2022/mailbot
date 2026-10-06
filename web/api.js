/**
 * 后端 API 封装。
 *
 * ## 凭据怎么带
 *
 * 浏览器**不再持有访问令牌**：登录时用令牌换一个 HttpOnly 的会话 Cookie，
 * 之后每个请求靠 Cookie 自动认证。这么做是因为旧做法有三个真问题：
 * 令牌存在 localStorage 里永不过期；SSE 还得把它拼进 URL（于是进了浏览器历史与代理日志）；
 * 服务端也无法"登出某一台设备"。
 *
 * 下面保留 `getToken/setToken` 只是为了兼容旧版本留在 localStorage 里的令牌：
 * 若还存在，会在登录时直接用它换会话，然后**立刻从 localStorage 删掉**。
 */
const TOKEN_KEY = 'mailbot.token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}
export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

/**
 * 请求头。
 *
 * 正常情况下**什么都不用带**（Cookie 自动随请求发送）。
 * 但命令行/脚本场景仍可能用令牌，所以 localStorage 里若还有旧令牌就带上——
 * 登录成功后会把它清掉，这条路径自然消失。
 */
export function authHeaders(extra = {}) {
  const legacy = getToken();
  return { ...(legacy ? { 'x-mailbot-token': legacy } : {}), ...extra };
}

/** 用访问令牌换一个会话 Cookie；成功后清掉 localStorage 里的旧令牌。 */
export async function login(token) {
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: String(token || '') }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ApiError(payload?.message || `登录失败（HTTP ${res.status}）`, payload?.code || 'LOGIN_FAILED', res.status);
  }
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略 */
  }
  return payload;
}

export async function logout() {
  const res = await fetch('/api/session/logout', { method: 'POST', headers: authHeaders() });
  return res.json().catch(() => ({ ok: true }));
}

/** 会话状态：是否需要登录。 */
export function session() {
  return request('GET', '/api/session');
}

export class ApiError extends Error {
  constructor(message, code, status, detail) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

async function request(method, path, body, options = {}) {
  const headers = authHeaders();
  // rawBody：直接把调用方给的 Blob/File/ArrayBuffer 当请求体发（附件上传用）
  if (options.rawBody) {
    if (options.contentType) headers['content-type'] = options.contentType;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : options.rawBody ? body : JSON.stringify(body),
    signal: options.signal,
  });

  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();

  if (!res.ok) {
    const message = (payload && payload.message) || `请求失败（HTTP ${res.status}）`;
    const err = new ApiError(message, payload?.code || 'HTTP_ERROR', res.status, payload?.detail);
    /*
     * 401 要能被上层识别成"该登录了"。
     * 用状态码 + 由 app 层统一处理，比让每个视图各写一遍友好得多：
     * 会话过期后用户点任何地方都会自然地回到登录页，而不是看到一堆红色报错。
     */
    if (res.status === 401) err.needsLogin = true;
    throw err;
  }
  return payload;
}

/**
 * 下载二进制（备份 zip）。用 Blob 而不是跳链接：访问令牌在请求头里，
 * 普通链接带不上（配了令牌就会 401）。
 */
async function downloadBlob(path) {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) {
    let message = `请求失败（HTTP ${res.status}）`;
    try {
      const data = await res.json();
      message = data?.message || message;
    } catch {
      /* 非 JSON 就用默认文案 */
    }
    throw new ApiError(message, 'DOWNLOAD_FAILED', res.status);
  }
  const disposition = res.headers.get('content-disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  const plain = /filename="([^"]+)"/i.exec(disposition);
  const filename = star ? decodeURIComponent(star[1]) : plain ? plain[1] : 'backup.zip';
  return { blob: await res.blob(), filename };
}

/** 以二进制请求体上传一个文件（备份 zip），返回 JSON。 */
async function uploadZip(path, file) {
  const res = await fetch(path, {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/zip' }),
    body: file,
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.includes('application/json') ? await res.json().catch(() => null) : await res.text();
  if (!res.ok) {
    const message = (payload && payload.message) || `请求失败（HTTP ${res.status}）`;
    throw new ApiError(message, payload?.code || 'HTTP_ERROR', res.status, payload?.detail);
  }
  return payload;
}

export const api = {
  meta: () => request('GET', '/api/meta'),
  status: () => request('GET', '/api/status'),

  getConfig: () => request('GET', '/api/config'),
  saveConfig: (patch) => request('PUT', '/api/config', patch),

  instances: () => request('GET', '/api/instances'),
  diagnostics: (instanceId, deep = true) => request('POST', '/api/diagnostics', { instanceId, deep }),
  testLlm: () => request('POST', '/api/llm/test', {}),

  run: (payload) => request('POST', '/api/runs', payload),
  /**
   * 分析前预检：只读数一封封邮件，不调用模型。
   * @param {number} windowHours
   */
  runPreview: (windowHours) => request('GET', `/api/runs/preview${query({ windowHours })}`),
  runs: () => request('GET', '/api/runs'),
  /** 定时任务（主动性）：状态 + 立即试一次 */
  scheduleStatus: () => request('GET', '/api/schedule'),
  runScheduleNow: () => request('POST', '/api/schedule/run', {}),
  /** 数据去向（按当前配置推导）与仅本地模式开关（走 saveConfig 的 llm.localOnly） */
  egress: () => request('GET', '/api/egress'),

  /** 跟催：列表 / 扫描（会调模型，接口侧要求 confirm）/ 改状态 */
  followups: (params) => request('GET', `/api/followups${query(params || {})}`),
  followUpsScan: () => request('POST', '/api/followups/scan', { confirm: true }),
  setFollowUpStatus: (id, status, snoozeUntil) =>
    request('PATCH', `/api/followups/${encodeURIComponent(id)}`, { status, snoozeUntil }),

  /** 会话与安全 */
  session: () => request('GET', '/api/session'),
  security: () => request('GET', '/api/security'),
  setAuthToken: (authToken) => request('POST', '/api/security/token', { authToken }),

  /** 密钥存储：现状 / 迁入保管库 / 迁回明文（后两者会改配置文件，接口侧强制 confirm） */
  secrets: () => request('GET', '/api/secrets'),
  secretsMigrate: (mode) => request('POST', '/api/secrets/migrate', { confirm: true, mode }),
  secretsRevert: () => request('POST', '/api/secrets/revert', { confirm: true }),

  /** 一屏体检（纯本地、不连网）：回答"能不能开始用、还差哪一步" */
  health: () => request('GET', '/api/health'),

  /** 存储占用体检 + 归档清理（清理不可逆，接口侧强制 confirm） */
  storage: () => request('GET', '/api/storage'),
  storageCleanup: (payload) => request('POST', '/api/storage/cleanup', { confirm: true, ...payload }),

  /**
   * 备份：导出（拿 Blob 自己触发下载）、检查、导入、自动备份列表。
   *
   * 导出/导入不能用 `request()`：前者返回 zip（不是 JSON），后者要发**二进制**请求体。
   */
  exportBackup: (options = {}) => downloadBlob(`/api/backup/export${query({ secrets: options.secrets ? 1 : 0, raw: options.raw ? 1 : 0 })}`),
  inspectBackup: (file) => uploadZip('/api/backup/inspect', file),
  importBackup: (file) => uploadZip('/api/backup/import?confirm=1', file),
  backups: () => request('GET', '/api/backup/list'),

  /** 待办闭环：给「需要你处理」里的邮件打状态（本地状态，不写外部系统） */
  taskSetStatus: (key, payload) => request('POST', `/api/tasks/${encodeURIComponent(key)}`, payload),
  taskRestore: (key) => request('DELETE', `/api/tasks/${encodeURIComponent(key)}`),
  tasks: () => request('GET', '/api/tasks'),

  /** 操作审计（写外部系统的台账）：支持类别/动作/关键词/只看失败 */
  audit: (params = {}) => request('GET', `/api/audit${query(params)}`),
  /** 从 Google 日历补录历史台账（只读 Google，只追加本地文件） */
  auditBackfill: (options = {}) => request('POST', '/api/audit/backfill', {}, options),
  cancel: (instanceId) => request('POST', '/api/runs/cancel', { instanceId }),

  overview: (params = {}) => request('GET', `/api/overview${query(params)}`),
  /**
   * 单封邮件详情：不受 24 小时窗口限制，供总览/检索页的「完整详情」共用。
   * @param {string} folder
   * @param {number} uid
   * @param {object} [options] { withBody=false } 不要原文全文（更快）
   */
  mailDetail: (folder, uid, options = {}) =>
    request('GET', `/api/mails/${encodeURIComponent(folder)}/${encodeURIComponent(uid)}${query({ body: options.withBody === false ? '0' : '' })}`),

  /**
   * 附件下载地址（按 `visibleAttachments()` 的下标）。
   *
   * 只返回 URL 而不代下载：调用方可能是 File System Access API
   * （需要自己 fetch 再写入用户选定的文件），也可能是普通下载链接。
   */
  attachmentUrl: (folder, uid, index) =>
    `/api/mails/${encodeURIComponent(folder)}/${encodeURIComponent(uid)}/attachments/${encodeURIComponent(index)}`,

  drafts: (params = {}) => request('GET', `/api/drafts${query(params)}`),
  draft: (id) => request('GET', `/api/drafts/${encodeURIComponent(id)}`),
  updateDraft: (id, patch) => request('PATCH', `/api/drafts/${encodeURIComponent(id)}`, patch),
  deleteDraft: (id) => request('DELETE', `/api/drafts/${encodeURIComponent(id)}`),
  regenerateDraft: (id, instruction) =>
    request('POST', `/api/drafts/${encodeURIComponent(id)}/regenerate`, { instruction }),
  syncDraft: (id) => request('POST', `/api/drafts/${encodeURIComponent(id)}/sync`, {}),

  /**
   * 上传附件。
   *
   * 请求体就是**文件的原始字节**（不是 multipart）：文件名走查询参数、类型走 Content-Type。
   * 这样前端只需要把 File 对象直接当 body 传，后端也不必实现 multipart 解析。
   */
  uploadDraftAttachment: (id, file) =>
    request(
      'POST',
      `/api/drafts/${encodeURIComponent(id)}/attachments${query({ filename: file.name })}`,
      file,
      { rawBody: true, contentType: file.type || 'application/octet-stream' },
    ),
  deleteDraftAttachment: (id, attachmentId) =>
    request('DELETE', `/api/drafts/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`),
  draftAttachmentUrl: (id, attachmentId) =>
    `/api/drafts/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachmentId)}`,
  sendDraft: (id, options = {}) => request('POST', `/api/drafts/${encodeURIComponent(id)}/send`, { confirm: true, ...options }),
  sendBatch: (ids, options = {}) => request('POST', '/api/drafts/send-batch', { ids, confirm: true, ...options }),
  applySignature: (payload = {}) => request('POST', '/api/drafts/apply-signature', payload),
  /** 给已有的未发送草稿补上原始邮件引文（先有草稿、后开引文时用） */
  applyQuote: (payload = {}) => request('POST', '/api/drafts/apply-quote', payload),

  reports: () => request('GET', '/api/reports'),
  report: (id) => request('GET', `/api/reports/${encodeURIComponent(id)}`),

  knowledge: (params = {}) => request('GET', `/api/knowledge${query(params)}`),
  ask: (payload) => request('POST', '/api/knowledge/ask', payload),

  /* 对话式邮件检索 */
  searchEmails: (payload) => request('POST', '/api/search/emails', payload),
  emailActivity: (params = {}) => request('GET', `/api/search/activity${query(params)}`),

  /* 日历知识库 */
  calendarKnowledge: (params = {}) => request('GET', `/api/calendar/knowledge${query(params)}`),
  /** 日历回顾分析（对话式）：返回统计 + AI 叙述 + 可导出的报告 id */
  calendarReview: (payload) => request('POST', '/api/calendar/review', payload),
  calendarReviewPresets: () => request('GET', '/api/calendar/review/presets'),

  /* 日历数字人 */
  calendarStatus: () => request('GET', '/api/calendar/status'),
  calendarConfigHint: () => request('GET', '/api/calendar/config-hint'),
  calendarAuthUrl: (redirectUri) => request('POST', '/api/calendar/auth-url', { redirectUri }),
  calendarDisconnect: () => request('POST', '/api/calendar/disconnect', {}),
  calendarTest: () => request('POST', '/api/calendar/test', {}),
  calendarList: () => request('GET', '/api/calendar/cals'),
  calendarInsight: (params = {}) => request('GET', `/api/calendar/insight${query(params)}`),
  calendarUpcoming: (params = {}) => request('GET', `/api/calendar/upcoming${query(params)}`),
  calendarChat: (payload) => request('POST', '/api/calendar/chat', payload),
  calendarSession: (id) => request('GET', `/api/calendar/sessions/${encodeURIComponent(id)}`),
  calendarCommit: (payload) => request('POST', '/api/calendar/events', { confirm: true, ...payload }),
  calendarCancelPending: (sessionId) => request('POST', '/api/calendar/events/cancel', { sessionId }),
  calendarDeleteEvent: (eventId) => request('DELETE', `/api/calendar/events/${encodeURIComponent(eventId)}`),
  /** 修改已有日程（只发 PATCH：未提供的字段保持不动，参会人不会被清掉） */
  calendarUpdateEvent: (eventId, patch) => request('PATCH', `/api/calendar/events/${encodeURIComponent(eventId)}`, patch),
  calendarFromEmails: (payload = {}) => request('POST', '/api/calendar/from-emails', payload),
  calendarAcceptSuggestion: (payload) => request('POST', '/api/calendar/from-emails/accept', { confirm: true, ...payload }),
};

function query(params) {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (!entries.length) return '';
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`;
}

/**
 * 订阅运行进度（SSE），返回取消函数。
 *
 * 不再把令牌拼进 URL：EventSource 会自动带上同源的会话 Cookie。
 * 旧做法（`?token=…`）会让令牌留在浏览器历史与服务端访问日志里。
 */
export function subscribeProgress(onEvent) {
  const source = new EventSource('/api/events');
  source.addEventListener('progress', (ev) => {
    try {
      onEvent(JSON.parse(ev.data));
    } catch {
      /* ignore */
    }
  });
  source.addEventListener('error', () => {
    // EventSource 会自动重连，这里只提示
    onEvent({ type: 'stream:error' });
  });
  return () => source.close();
}
