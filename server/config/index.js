/**
 * 配置加载与保存。
 *
 * 优先级：默认值 < data/config.json < 环境变量(.env) < 运行时补丁(setConfig)
 *
 * 授权码（authPass）与 LLM apiKey 允许两种存放方式：
 *   1) .env 里的环境变量（推荐，不落盘到 config.json）
 *   2) data/config.json 里直接写（本机本地使用）
 * 对外输出一律脱敏。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AppError, clampNumber, log } from '../lib/util.js';
import { DEFAULTS } from './defaults.js';

const SECRET_FIELDS = new Set(['authPass', 'apiKey', 'authToken', 'clientSecret']);

let cached = null;
let cachedRoot = null;
let overlay = {};

/* ------------------------------------------------------------ 路径解析 */

export function resolveRoot(rootDir) {
  return path.resolve(rootDir || process.env.MAILBOT_ROOT || process.cwd());
}

export function dataDirOf(config, rootDir) {
  const raw = config?.dataDir || DEFAULTS.dataDir;
  return path.isAbsolute(raw) ? raw : path.resolve(rootDir, raw);
}

export function pathsFor(config, rootDir) {
  const dataDir = dataDirOf(config, rootDir);
  return {
    rootDir,
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    stateFile: path.join(dataDir, 'state.json'),
    reportsDir: path.join(dataDir, 'reports'),
    rawDir: path.join(dataDir, 'raw'),
    /** 草稿附件落盘目录（用户自己添加的待发附件） */
    attachmentsDir: path.join(dataDir, 'attachments'),
  };
}

/* ------------------------------------------------------------ 深合并 */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = isPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (Array.isArray(value)) out[key] = value.map((v) => (isPlainObject(v) ? deepMerge({}, v) : v));
    else if (isPlainObject(value)) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

/** 深拷贝（仅用于配置这种纯 JSON 结构）。 */
export function deepClone(value) {
  if (Array.isArray(value)) return value.map((v) => deepClone(v));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out;
  }
  return value;
}

/* ------------------------------------------------------------ .env */

export function loadDotEnv(rootDir) {
  // 测试或需要固定配置的场景可以显式禁用 .env，避免本机真实凭据污染进程环境
  if (process.env.MAILBOT_NO_DOTENV) return;
  const file = path.join(rootDir, '.env');
  if (!fs.existsSync(file)) return;
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.warn(`读取 .env 失败：${err.message}`);
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // 真实环境变量优先级更高，不覆盖
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/* ------------------------------------------------------------ 环境变量覆盖 */

function toBool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function applyEnv(config) {
  const env = process.env;
  const first = () => config.instances[0];

  const setDefault = (fn) => {
    const inst = first();
    if (inst) fn(inst);
  };

  if (env.MAILBOT_DEFAULT_INSTANCE) config.defaultInstanceId = env.MAILBOT_DEFAULT_INSTANCE;

  setDefault((inst) => {
    if (env.MAILBOT_IMAP_HOST) inst.imap.host = env.MAILBOT_IMAP_HOST;
    if (env.MAILBOT_IMAP_PORT) inst.imap.port = Number(env.MAILBOT_IMAP_PORT) || inst.imap.port;
    if (env.MAILBOT_IMAP_SECURE !== undefined) inst.imap.secure = toBool(env.MAILBOT_IMAP_SECURE, inst.imap.secure);
    if (env.MAILBOT_IMAP_USER) inst.imap.authUser = env.MAILBOT_IMAP_USER;
    if (env.MAILBOT_IMAP_PASS) inst.imap.authPass = env.MAILBOT_IMAP_PASS;

    if (env.MAILBOT_SMTP_HOST) inst.smtp.host = env.MAILBOT_SMTP_HOST;
    if (env.MAILBOT_SMTP_PORT) inst.smtp.port = Number(env.MAILBOT_SMTP_PORT) || inst.smtp.port;
    if (env.MAILBOT_SMTP_SECURE !== undefined) inst.smtp.secure = toBool(env.MAILBOT_SMTP_SECURE, inst.smtp.secure);
    if (env.MAILBOT_SMTP_USER) inst.smtp.authUser = env.MAILBOT_SMTP_USER;
    if (env.MAILBOT_SMTP_PASS) inst.smtp.authPass = env.MAILBOT_SMTP_PASS;
    if (env.MAILBOT_SMTP_AUTH_METHOD) inst.smtp.authMethod = env.MAILBOT_SMTP_AUTH_METHOD;

    if (env.MAILBOT_EMAIL) inst.identity.email = env.MAILBOT_EMAIL;
    if (env.MAILBOT_SENDER_NAME) inst.identity.name = env.MAILBOT_SENDER_NAME;
  });

  if (env.DEEPSEEK_API_KEY) config.llm.apiKey = env.DEEPSEEK_API_KEY;
  if (env.MAILBOT_LLM_API_KEY) config.llm.apiKey = env.MAILBOT_LLM_API_KEY;
  if (env.MAILBOT_LLM_BASE_URL) config.llm.baseUrl = env.MAILBOT_LLM_BASE_URL;
  if (env.MAILBOT_LLM_MODEL) config.llm.model = env.MAILBOT_LLM_MODEL;

  if (env.MAILBOT_WEB_HOST) config.web.host = env.MAILBOT_WEB_HOST;
  if (env.MAILBOT_WEB_PORT) config.web.port = Number(env.MAILBOT_WEB_PORT) || config.web.port;
  if (env.MAILBOT_WEB_TOKEN) config.web.authToken = env.MAILBOT_WEB_TOKEN;

  if (env.MAILBOT_WINDOW_HOURS) config.scan.windowHours = Number(env.MAILBOT_WINDOW_HOURS) || config.scan.windowHours;
  if (env.MAILBOT_DATA_DIR) config.dataDir = env.MAILBOT_DATA_DIR;

  // 日历（Google Calendar）
  if (env.MAILBOT_CALENDAR_ENABLED !== undefined) {
    config.calendar.enabled = toBool(env.MAILBOT_CALENDAR_ENABLED, config.calendar.enabled);
  }
  if (env.MAILBOT_GOOGLE_CLIENT_ID) config.calendar.google.clientId = env.MAILBOT_GOOGLE_CLIENT_ID;
  if (env.GOOGLE_CLIENT_ID) config.calendar.google.clientId = env.GOOGLE_CLIENT_ID;
  if (env.MAILBOT_GOOGLE_CLIENT_SECRET) config.calendar.google.clientSecret = env.MAILBOT_GOOGLE_CLIENT_SECRET;
  if (env.GOOGLE_CLIENT_SECRET) config.calendar.google.clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (env.MAILBOT_GOOGLE_REDIRECT_URI) config.calendar.google.redirectUri = env.MAILBOT_GOOGLE_REDIRECT_URI;
  if (env.MAILBOT_CALENDAR_ID) config.calendar.calendarId = env.MAILBOT_CALENDAR_ID;
  if (env.MAILBOT_TIMEZONE) config.calendar.timeZone = env.MAILBOT_TIMEZONE;
  if (env.MAILBOT_CALENDAR_SEND_UPDATES) config.calendar.sendUpdates = env.MAILBOT_CALENDAR_SEND_UPDATES;
  if (env.MAILBOT_CALENDAR_LOOKAHEAD_DAYS) {
    config.calendar.lookaheadDays = Number(env.MAILBOT_CALENDAR_LOOKAHEAD_DAYS) || config.calendar.lookaheadDays;
  }
}

/* ------------------------------------------------------------ 规范化 */

/**
 * 把 patch 合并进 base，但**忽略 base 里的空值字段**。
 * 用于身份/凭据这类「留空即表示复用」的字段：否则默认值里的空串会顶掉
 * 用户只配置了 IMAP 时应当继承到 SMTP 的账号与授权码。
 */
function mergeKeepingNonEmpty(base, patch) {
  const out = { ...(patch || {}) };
  for (const [key, value] of Object.entries(base || {})) {
    const patchValue = out[key];
    const patchEmpty = patchValue === undefined || patchValue === null || patchValue === '';
    if (patchEmpty && value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}

function normalizeInstance(inst, index) {
  const out = deepMerge(DEFAULTS.instances[0], inst || {});
  out.id = String(out.id || `instance${index + 1}`).trim();
  out.label = String(out.label || out.id);
  out.enabled = out.enabled !== false;

  out.imap = deepMerge(DEFAULTS.instances[0].imap, out.imap);
  // SMTP 与发件身份的凭据/身份字段：留空表示「复用 IMAP 或默认值」，不能被空串覆盖
  out.smtp = mergeKeepingNonEmpty(DEFAULTS.instances[0].smtp, out.smtp);
  out.identity = mergeKeepingNonEmpty(DEFAULTS.instances[0].identity, out.identity);

  out.imap.host = String(out.imap.host || '').trim();
  out.smtp.host = String(out.smtp.host || '').trim();
  out.imap.port = clampNumber(out.imap.port, 1, 65535, 993);
  out.smtp.port = clampNumber(out.smtp.port, 1, 65535, 465);
  out.imap.secure = out.imap.secure !== false;
  out.smtp.secure = out.smtp.secure !== false;
  out.imap.authUser = String(out.imap.authUser || '').trim();
  out.smtp.authUser = String(out.smtp.authUser || '').trim();
  out.imap.authPass = String(out.imap.authPass ?? '');
  out.smtp.authPass = String(out.smtp.authPass ?? '');
  // SMTP 认证方式归一化：auto / PLAIN / LOGIN
  const rawMethod = String(out.smtp.authMethod || 'auto').trim().toUpperCase();
  out.smtp.authMethod = ['PLAIN', 'LOGIN'].includes(rawMethod) ? rawMethod : 'auto';
  out.identity.email = String(out.identity.email || out.imap.authUser || '').trim();
  out.identity.name = String(out.identity.name || '').trim();
  out.identity.replyTo = String(out.identity.replyTo || '').trim();
  // 未单独配置 SMTP 认证时，复用 IMAP 的账号与授权码
  if (!out.smtp.authUser) out.smtp.authUser = out.imap.authUser;
  if (!out.smtp.authPass) out.smtp.authPass = out.imap.authPass;
  return out;
}

export function normalize(raw) {
  // 必须深拷贝 DEFAULTS：deepMerge 对嵌套对象是浅拷贝，直接改会污染默认值
  const config = deepMerge(deepClone(DEFAULTS), raw || {});
  if (!Array.isArray(config.instances) || config.instances.length === 0) {
    config.instances = [deepMerge(DEFAULTS.instances[0], {})];
  }
  config.instances = config.instances.map(normalizeInstance);

  config.scan.windowHours = clampNumber(config.scan.windowHours, 1, 24 * 30, 24);
  config.scan.maxMessages = clampNumber(config.scan.maxMessages, 1, 2000, 60);
  config.scan.threadContextCount = clampNumber(config.scan.threadContextCount, 0, 10, 3);
  config.scan.bodyCharsForLlm = clampNumber(config.scan.bodyCharsForLlm, 500, 60_000, 4000);
  config.scan.snippetChars = clampNumber(config.scan.snippetChars, 60, 2000, 240);
  config.scan.folders = (Array.isArray(config.scan.folders) ? config.scan.folders : ['INBOX'])
    .map((f) => String(f || '').trim())
    .filter(Boolean);
  if (config.scan.folders.length === 0) config.scan.folders = ['INBOX'];

  config.draft.maxDrafts = clampNumber(config.draft.maxDrafts, 1, 200, 15);
  config.draft.concurrency = clampNumber(config.draft.concurrency, 1, 8, 3);
  if (!['formal', 'concise', 'warm'].includes(config.draft.tone)) config.draft.tone = 'formal';
  if (!['auto', 'zh', 'en'].includes(config.draft.language)) config.draft.language = 'auto';
  if (!['confirm', 'auto', 'draft_only'].includes(config.draft.sendPolicy)) config.draft.sendPolicy = 'confirm';
  // 引文：默认开启，风格只允许两种，长度上限兜住不要被历史堆满
  config.draft.quoteOriginal = config.draft.quoteOriginal !== false;
  if (!['zh-client', 'prefix'].includes(config.draft.quoteStyle)) config.draft.quoteStyle = 'zh-client';
  config.draft.quoteMaxChars = clampNumber(config.draft.quoteMaxChars, 200, 20_000, 2000);
  /*
   * 附件发送上限（按 base64 编码后的字节算）。
   *
   * 为什么卡在编码后：SMTP 传输的是 base64 文本，体积会膨胀约 1/3。
   * 一个 18 MB 的文件编码后是 24 MB，多数企业邮箱上限 20 MB —— 一定被拒收。
   * 与其让用户在发送那一刻收到一句看不懂的 SMTP 报错，不如在界面上就拦住。
   */
  config.draft.attachmentMaxBytes = clampNumber(config.draft.attachmentMaxBytes, 1_000_000, 50_000_000, 20_000_000);
  /** 单封草稿最多几个附件（防止误选整个文件夹） */
  config.draft.maxAttachments = clampNumber(config.draft.maxAttachments, 1, 50, 10);

  config.llm.baseUrl = String(config.llm.baseUrl || DEFAULTS.llm.baseUrl).replace(/\/+$/, '');
  config.llm.model = String(config.llm.model || DEFAULTS.llm.model);
  config.llm.classifyBatchSize = clampNumber(config.llm.classifyBatchSize, 1, 50, 12);
  config.llm.maxRetries = clampNumber(config.llm.maxRetries, 0, 8, 3);
  config.llm.temperature = clampNumber(config.llm.temperature, 0, 2, 0.3);

  config.web.port = clampNumber(config.web.port, 1, 65535, 8787);
  config.web.host = String(config.web.host || '127.0.0.1').trim();

  if (config.web.allowSend === null || config.web.allowSend === undefined) {
    // 默认：允许发送，但必须逐封人工确认（draft.sendPolicy === 'confirm'）
    config.web.allowSend = config.draft.sendPolicy !== 'draft_only';
  } else {
    config.web.allowSend = config.web.allowSend !== false;
  }

  const ids = new Set();
  for (const inst of config.instances) {
    let id = inst.id;
    let n = 2;
    while (ids.has(id)) id = `${inst.id}-${n++}`;
    inst.id = id;
    ids.add(id);
  }

  if (!ids.has(config.defaultInstanceId)) config.defaultInstanceId = config.instances[0].id;

  /* 日历 */
  config.calendar.enabled = config.calendar.enabled === true;
  config.calendar.google.clientId = String(config.calendar.google.clientId || '').trim();
  config.calendar.google.clientSecret = String(config.calendar.google.clientSecret || '').trim();
  config.calendar.google.redirectUri = String(config.calendar.google.redirectUri || '').trim();
  config.calendar.calendarId = String(config.calendar.calendarId || 'primary').trim() || 'primary';
  // 访问 Google 的 HTTP 代理：空 = 直连；只影响 Google 请求
  config.calendar.proxy = String(config.calendar.proxy || '').trim();
  config.calendar.timeZone = String(config.calendar.timeZone || 'Asia/Shanghai').trim() || 'Asia/Shanghai';
  // 校验时区名，无效时退回默认，避免 Intl 抛错
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: config.calendar.timeZone });
  } catch {
    log.warn(`无效时区「${config.calendar.timeZone}」，已退回 Asia/Shanghai`);
    config.calendar.timeZone = 'Asia/Shanghai';
  }
  if (!['none', 'all', 'externalOnly'].includes(config.calendar.sendUpdates)) config.calendar.sendUpdates = 'none';
  config.calendar.lookaheadDays = clampNumber(config.calendar.lookaheadDays, 1, 60, 7);
  config.calendar.upcomingLimit = clampNumber(config.calendar.upcomingLimit, 1, 250, 20);
  config.calendar.maxFromEmails = clampNumber(config.calendar.maxFromEmails, 1, 50, 10);
  config.calendar.reminders = (Array.isArray(config.calendar.reminders) ? config.calendar.reminders : [10])
    .map((n) => clampNumber(n, 0, 40_320, 10))
    .filter((n, i, arr) => arr.indexOf(n) === i)
    .slice(0, 5);

  /* 回顾分析口径（决定"忙碌时长/深度工作时间/晚间会议"怎么算） */
  config.calendar.review = deepMerge(DEFAULTS.calendar.review, config.calendar.review || {});
  const review = config.calendar.review;
  const isHhmm = (v) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
  if (!isHhmm(review.workdayStart)) review.workdayStart = '09:00';
  if (!isHhmm(review.workdayEnd)) review.workdayEnd = '19:00';
  review.workdays = (Array.isArray(review.workdays) ? review.workdays : [1, 2, 3, 4, 5])
    .map((n) => Number(n))
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    .filter((n, i, arr) => arr.indexOf(n) === i);
  if (!review.workdays.length) review.workdays = [1, 2, 3, 4, 5];
  review.eveningAfterHour = clampNumber(review.eveningAfterHour, 0, 23, 19);
  review.longMeetingMin = clampNumber(review.longMeetingMin, 30, 600, 120);
  review.backToBackGapMin = clampNumber(review.backToBackGapMin, 0, 120, 10);
  review.deepBlockMin = clampNumber(review.deepBlockMin, 30, 480, 90);
  review.topN = clampNumber(review.topN, 3, 30, 8);
  review.maxEvents = clampNumber(review.maxEvents, 100, 20_000, 5000);
  review.maxRangeDays = clampNumber(review.maxRangeDays, 7, 1100, 366);

  /* 检索 */
  config.search = deepMerge(DEFAULTS.search, config.search || {});
  config.search.backfillMax = clampNumber(config.search.backfillMax, 0, 300, 40);

  return config;
}

/* ------------------------------------------------------------ 读写 */

/**
 * 解析配置文件路径。dataDir 可能来自三处：环境变量 > config.json > 默认值，
 * 而配置文件本身又放在 dataDir 里，所以需要分阶段解析。
 */
function resolveConfigFile(root, attempt = 0) {
  const probe = normalize({});
  if (process.env.MAILBOT_DATA_DIR) probe.dataDir = process.env.MAILBOT_DATA_DIR;
  let file = pathsFor(probe, root).configFile;
  if (fs.existsSync(file)) {
    try {
      const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (disk?.dataDir && disk.dataDir !== probe.dataDir && attempt < 1) {
        // 配置文件里又指明了新目录，则按新目录再找一次
        const next = pathsFor({ dataDir: disk.dataDir }, root).configFile;
        if (next !== file) {
          const resolved = process.env.MAILBOT_DATA_DIR ? file : next;
          return resolved;
        }
      }
    } catch {
      /* 解析错误留给调用方统一处理 */
    }
  }
  return file;
}

export function loadConfig({ rootDir, force = false } = {}) {
  const root = resolveRoot(rootDir);
  if (cached && cachedRoot === root && !force) return cached;

  loadDotEnv(root);
  const configFile = resolveConfigFile(root);
  let fileConfig = {};
  if (fs.existsSync(configFile)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    } catch (err) {
      throw new AppError(`配置文件解析失败：${configFile}（${err.message}）`, {
        code: 'CONFIG_PARSE_ERROR',
      });
    }
  }

  const merged = normalize(deepMerge(fileConfig, overlay));
  applyEnv(merged);
  const finalConfig = normalize(merged);

  cached = finalConfig;
  cachedRoot = root;
  return finalConfig;
}

export function getConfig() {
  if (!cached) return loadConfig();
  return cached;
}

/** 内存里是否已经有配置（用于避免重复加载把注入的配置冲掉）。 */
export function isConfigLoaded() {
  return cached !== null;
}

export function getPaths() {
  return pathsFor(getConfig(), cachedRoot || resolveRoot());
}

export function getInstance(instanceId) {
  const config = getConfig();
  const id = instanceId || config.defaultInstanceId;
  const inst = config.instances.find((i) => i.id === id);
  if (!inst) {
    throw new AppError(`未找到邮箱实例「${id}」`, { code: 'INSTANCE_NOT_FOUND', status: 400 });
  }
  return inst;
}

export function listInstances() {
  const config = getConfig();
  return config.instances.map((i) => ({ ...i, isDefault: i.id === config.defaultInstanceId }));
}

/** 运行时覆盖（仅内存，用于 CLI 参数 / 测试注入）。 */
export function setConfig(patch = {}) {
  overlay = deepMerge(overlay, patch);
  cached = null;
  return loadConfig();
}

export function resetConfigCache() {
  overlay = {};
  cached = null;
}

export function ensureDirs() {
  const p = getPaths();
  // attachmentsDir 一并建好：上传附件时才创建目录，会在"目录权限有问题"时
  // 把错误推迟到用户点上传那一刻，而在启动时建立则能更早暴露问题。
  for (const dir of [p.dataDir, p.reportsDir, p.rawDir, p.attachmentsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return p;
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 保存配置。密钥字段的特殊语义：
 *   - 传 '***' → 保留原有值（界面展示的就是脱敏值）
 *   - 传空字符串 → 显式清空
 *   - 不传     → 保持磁盘上的原值
 * 优先从磁盘上的 config.json 取原值；磁盘上没有（密钥只存在于内存或 .env）时，
 * 回退到当前内存配置，避免「没保存过密钥 → 一保存就被清空」。
 */
export function saveConfig(patch = {}) {
  const root = cachedRoot || resolveRoot();
  const current = getConfig();
  const p = pathsFor(current, root);
  let existing = {};
  if (fs.existsSync(p.configFile)) {
    try {
      existing = JSON.parse(fs.readFileSync(p.configFile, 'utf8'));
    } catch {
      existing = {};
    }
  }
  const fallback = {
    instances: current.instances,
    llm: { apiKey: current.llm.apiKey },
    web: { authToken: current.web.authToken },
    calendar: { google: { clientSecret: current.calendar?.google?.clientSecret } },
  };
  const cleaned = stripMaskedSecrets(patch, existing, fallback);
  const next = deepMerge(existing, cleaned);
  atomicWriteJson(p.configFile, next);
  cached = null;
  const reloaded = loadConfig({ force: true });
  // 连接参数可能已变（主机/账号/授权码/认证方式），旧连接池必须丢弃
  onConfigReload?.();
  return reloaded;
}

let onConfigReload = null;

/** 注册「配置变更后」的回调（避免 config 层反向依赖 mail 层）。 */
export function setConfigReloadHook(fn) {
  onConfigReload = typeof fn === 'function' ? fn : null;
}

/** 把 patch 里的 '***' 替换成磁盘上的真实值（磁盘没有时才退回内存值）。 */
function stripMaskedSecrets(patch, existing, fallback) {
  if (Array.isArray(patch)) {
    const oldList = Array.isArray(existing) ? existing : [];
    const fbList = Array.isArray(fallback) ? fallback : [];
    return patch.map((item, idx) => {
      const match =
        (item && typeof item === 'object' && item.id ? oldList.find((o) => o && o.id === item.id) : undefined) ??
        oldList[idx];
      const fb =
        (item && typeof item === 'object' && item.id ? fbList.find((o) => o && o.id === item.id) : undefined) ??
        fbList[idx];
      return stripMaskedSecrets(item, match, fb);
    });
  }
  if (!patch || typeof patch !== 'object') return patch;
  const out = {};
  for (const [key, value] of Object.entries(patch)) {
    if (SECRET_FIELDS.has(key)) {
      if (value === '***') {
        // 磁盘上的值才是权威：内存值可能来自 .env 或运行时生成，不能顶掉已保存的密钥
        const keep = existing?.[key] || fallback?.[key];
        if (keep) out[key] = keep; // 都没有 → 视为「未配置」，不写入
        continue;
      }
      if (value === undefined) continue;
      out[key] = value;
      continue;
    }
    if (value && typeof value === 'object') {
      out[key] = stripMaskedSecrets(value, existing?.[key], fallback?.[key]);
      continue;
    }
    out[key] = value;
  }
  return out;
}

/* ------------------------------------------------------------ 脱敏输出 */

function maskInstance(inst) {
  registerSecret(inst.imap.authPass);
  registerSecret(inst.smtp.authPass);
  return {
    ...inst,
    imap: { ...inst.imap, authPass: inst.imap.authPass ? '***' : '' },
    smtp: { ...inst.smtp, authPass: inst.smtp.authPass ? '***' : '' },
  };
}

/* 记录已知密钥明文，供界面回显判断用（如「未配置」vs「已配置」） */
const secretVault = { llmApiKey: '' };

function registerSecret(value) {
  if (value) lastSeenSecrets.add(value);
}
const lastSeenSecrets = new Set();

export function maskConfig(config = getConfig()) {
  secretVault.llmApiKey = config.llm.apiKey || '';
  registerSecret(config.llm.apiKey);
  registerSecret(config.web.authToken);
  const out = {
    ...config,
    instances: config.instances.map(maskInstance),
    llm: { ...config.llm, apiKey: config.llm.apiKey ? '***' : '' },
    web: { ...config.web, authToken: config.web.authToken ? '***' : '' },
    calendar: {
      ...config.calendar,
      google: {
        ...config.calendar.google,
        clientSecret: config.calendar.google.clientSecret ? '***' : '',
      },
    },
  };
  return out;
}

/** 环境变量里是否提供了密钥（界面用来提示「来自 .env」）。 */
export function secretSources() {
  return {
    imapPassFromEnv: !!process.env.MAILBOT_IMAP_PASS,
    smtpPassFromEnv: !!process.env.MAILBOT_SMTP_PASS,
    llmKeyFromEnv: !!(process.env.DEEPSEEK_API_KEY || process.env.MAILBOT_LLM_API_KEY),
    googleSecretFromEnv: !!(process.env.GOOGLE_CLIENT_SECRET || process.env.MAILBOT_GOOGLE_CLIENT_SECRET),
  };
}

/* ------------------------------------------------------------ 校验 */

export function validateInstance(inst) {
  const problems = [];
  if (!inst) return ['缺少实例配置'];
  if (!inst.imap.host) problems.push('IMAP 服务器地址为空');
  if (!inst.imap.authUser) problems.push('IMAP 账号为空');
  if (!inst.imap.authPass) problems.push('IMAP 授权码为空');
  if (!inst.smtp.host) problems.push('SMTP 服务器地址为空');
  if (!inst.smtp.authUser) problems.push('SMTP 账号为空');
  if (!inst.smtp.authPass) problems.push('SMTP 授权码为空');
  if (!inst.identity.email) problems.push('发件人邮箱为空');
  if (inst.imap.secure && [143, 25].includes(inst.imap.port)) {
    problems.push(`IMAP 端口 ${inst.imap.port} 通常对应非加密连接，但 secure=true，请确认`);
  }
  if (!inst.imap.secure && [993, 465].includes(inst.imap.port)) {
    problems.push(`IMAP 端口 ${inst.imap.port} 通常对应 SSL 连接，但 secure=false，请确认`);
  }
  return problems;
}

export function validateLlm(config = getConfig()) {
  const problems = [];
  if (!config.llm.apiKey) problems.push('大模型 API Key 为空（可在 .env 里配 DEEPSEEK_API_KEY）');
  if (!config.llm.baseUrl) problems.push('大模型 baseUrl 为空');
  if (!config.llm.model) problems.push('大模型 model 为空');
  return problems;
}
