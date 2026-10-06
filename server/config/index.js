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
import {
  applyToConfig,
  autoDecision,
  clearVault,
  collectFromConfig,
  decodeVault,
  encodeVault,
  listBackends,
  readVault,
  resetVaultCache,
  resolveMode,
  SECRET_SLOTS,
  stripFromConfig,
  writeVault,
} from '../lib/secrets.js';

const SECRET_FIELDS = new Set(['authPass', 'apiKey', 'authToken', 'clientSecret']);

let cached = null;
let cachedRoot = null;
/**
 * 由 `.env` **文件**载入的环境变量名。
 *
 * 为什么要区分：真实的环境变量是用户在别处显式设的（比如容器编排），
 * 我们无权去动；而 `.env` 文件是程序自己的配置文件，迁移密钥时才允许清空它。
 */
const envFromFile = new Set();
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
  for (const line of text.split(/\r?\n/)) {    const trimmed = line.trim();
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
    if (process.env[key] === undefined) {
      process.env[key] = value;
      // 记下来源：只有"确实由 .env 文件提供"的键，迁移时才允许清空
      envFromFile.add(key);
    }
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
  /*
   * 密钥保管：把钥匙串里的密钥补进来。
   *
   * 顺序与优先级刻意如此：`.env` 先应用，钥匙串**只填空着的字段**，于是优先级为
   *   .env（显式设置，真值判断）> config.json / 钥匙串
   * 也就是说：
   *   - 迁移之后 config.json 里是空的 → 钥匙串的值填进来 ✓
   *   - 你手动往 config.json 里贴了密钥 → 以你手写的为准（不做"偷偷搬走"这种事）
   *   - 读钥匙串失败 → 只记警告并继续（**绝不能因为钥匙串读不出来就让程序起不来**）
   */
  vaultState = applyVault(merged);
  const finalConfig = normalize(merged);

  cached = finalConfig;
  cachedRoot = root;
  return finalConfig;
}

/**
 * 上一次加载时钥匙串的状态（供界面与自检展示）。
 * 失败要被**看见**，而不是静默当成"没配密钥"——那会让用户以为密钥丢了。
 */
let vaultState = { mode: 'config', backend: 'config', ok: true, applied: 0, error: null };

export function vaultStatus() {
  return { ...vaultState };
}

/** 读钥匙串并补进配置（同步，进程内缓存）。 */
function applyVault(config) {
  const mode = config.vault?.mode || 'config';
  if (mode === 'config') return { mode, backend: 'config', ok: true, applied: 0, error: null };
  const res = readVault(mode, { dataDir: dataDirOf(config, cachedRoot || resolveRoot()) });
  if (!res.ok) {
    log.warn(`密钥保管读取失败（本次未注入密钥，你的密钥没有被删除）：${res.error}`);
    return { mode, backend: res.backend || null, ok: false, applied: 0, error: res.error };
  }
  const decoded = decodeVault(res.data);
  if (!decoded.ok) {
    log.warn(`密钥保管内容无法解析：${decoded.error}`);
    return { mode, backend: res.backend, ok: false, applied: 0, error: decoded.error };
  }
  const { applied } = applyToConfig(config, decoded.secrets);
  return { mode, backend: res.backend, ok: true, applied, stored: Object.keys(decoded.secrets).length };
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

  /*
   * 密钥保管：把密钥抽进保管库，配置文件里只留空。
   *
   * 两条铁律：
   *   1. **写成功才抹掉明文**。写不进去就照旧明文落盘（并记警告）——
   *      "保管库没写成、明文又抹了"等于直接把用户的密钥弄丢。
   *   2. **不搬运来自环境变量的密钥**。`.env` / 真实环境变量里的值是用户刻意放在那里的，
   *      一次保存就把它们抄进保管库（或抄进 config.json）都不对。
   */
  const secretsMode = current.vault?.mode || 'config';
  if (secretsMode !== 'config') {
    const resolved = resolveMode(secretsMode);
    // 保存配置时两类环境变量来源都排除：那是用户刻意放在环境里的，不该被"顺手搬走"
    const skip = envProvidedSlots();
    const secrets = collectFromConfig(next, { exclude: skip });
    if (Object.keys(secrets).length) {
      const res = writeVault(resolved, { dataDir: dataDirOf(current, root) }, encodeVault(secrets));
      if (res.ok) {
        stripFromConfig(next);
      } else {
        log.warn(`密钥写不进保管库（${res.error}）；本次仍以明文写入配置文件，密钥没有丢`);
      }
    }
  }

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

/* ------------------------------------------------------------ 密钥保管（系统钥匙串） */

/** `.env` 里提供了值的键 → 对应的密钥槽位（用于"这个密钥来自 .env"与避免抄写） */
const ENV_SECRET_SLOTS = {
  imap: ['MAILBOT_IMAP_PASS'],
  smtp: ['MAILBOT_SMTP_PASS'],
  llm: ['DEEPSEEK_API_KEY', 'MAILBOT_LLM_API_KEY'],
  web: ['MAILBOT_WEB_TOKEN'],
  google: ['GOOGLE_CLIENT_SECRET', 'MAILBOT_GOOGLE_CLIENT_SECRET'],
};

/**
 * 当前由环境变量提供值的密钥槽位。
 *
 * 两种来源必须分开对待：
 *   - `onlyFile: true`  → 只算 `.env` **文件**提供的。那是我们自己的配置文件，
 *     迁移时应当把它的值搬进保管库并把那一行清空（否则明文还留在文件里，等于没搬）。
 *   - `onlyFile: false` → 连真实环境变量一起算。那是用户在别处显式设的（容器/系统环境），
 *     程序无权也不该去动。**迁移与保存都不能把这类值抄进保管库或 config.json**：
 *     环境变量优先级最高，抄一份只会让同一密钥存在两处，还让人以为"已经搬走了"。
 */
function envProvidedSlots({ onlyFile = false } = {}) {
  const out = new Set();
  for (const [slot, keys] of Object.entries(ENV_SECRET_SLOTS)) {
    const hit = keys.some((k) => {
      if (!process.env[k]) return false;
      return onlyFile ? envFromFile.has(k) : true;
    });
    if (hit) out.add(slot);
  }
  return out;
}

function readDiskConfig(file) {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  } catch {
    return {};
  }
}

/** 读一次保管库里的密钥表（同步、带缓存）。 */
function vaultSecrets(config, root) {
  const mode = config?.vault?.mode || 'config';
  const resolved = resolveMode(mode);
  if (resolved === 'config') return { resolved, secrets: {}, error: null };
  const res = readVault(mode, { dataDir: dataDirOf(config, root) });
  if (!res.ok) return { resolved, secrets: {}, error: res.error };
  const decoded = decodeVault(res.data);
  return { resolved, secrets: decoded.ok ? decoded.secrets : {}, error: decoded.ok ? null : decoded.error };
}

/**
 * 密钥现状报告：每一个密钥**现在到底在哪**。
 *
 * 这个函数存在的意义就是"别让用户猜"。密钥这种东西，
 * 界面必须能回答"它存在哪、是不是明文、换了电脑会怎样"。
 */
export function secretsReport() {
  const config = getConfig();
  const root = cachedRoot || resolveRoot();
  const p = pathsFor(config, root);
  const disk = readDiskConfig(p.configFile);
  const mode = config.vault?.mode || 'config';
  const decision = autoDecision();
  const { resolved, secrets: inVault, error } = vaultSecrets(config, root);
  const envSlots = envProvidedSlots();
  const instances = Array.isArray(config.instances) ? config.instances : [];

  const locOf = (slotKey, instanceId) => {
    if (envSlots.has(slotKey)) {
      const fromFile = ENV_SECRET_SLOTS[slotKey].some((k) => envFromFile.has(k));
      return fromFile ? 'envFile' : 'envReal';
    }
    if (instanceId) {
      const diskInst = (disk.instances || []).find((i) => i.id === instanceId);
      if (diskInst?.[slotKey]?.authPass) return 'config';
    } else if (disk[slotKey]?.apiKey || disk[slotKey]?.authToken || disk.calendar?.google?.clientSecret) {
      return 'config';
    }
    if (inVault[`${slotKey}:${instanceId || 'default'}`] || inVault[slotKey]) return 'vault';
    return 'none';
  };

  const items = [];
  for (const inst of instances) {
    for (const slotKey of ['imap', 'smtp']) {
      const slot = SECRET_SLOTS.find((s) => s.key === slotKey);
      const value = slotKey === 'imap' ? inst.imap?.authPass : inst.smtp?.authPass;
      items.push({
        key: `${slotKey}:${inst.id || 'default'}`,
        label: `${slot.label}${instances.length > 1 ? `（${inst.label || inst.id}）` : ''}`,
        location: locOf(slotKey, inst.id || 'default'),
        set: !!value,
      });
    }
  }
  for (const slot of SECRET_SLOTS) {
    if (slot.external || slot.key === 'imap' || slot.key === 'smtp') continue;
    const value = slot.get(config);
    items.push({ key: slot.key, label: slot.label, location: locOf(slot.key), set: !!value });
  }

  const plaintext = items.filter((i) => i.set && (i.location === 'config' || i.location === 'envFile' || i.location === 'envReal'));
  return {
    mode,
    resolved,
    /** auto 模式下是否发生了"加密 → 未加密"的降级 */
    degraded: mode === 'auto' ? decision.degraded : false,
    degradeReason: mode === 'auto' ? decision.reason : null,
    backends: listBackends(),
    currentBackend: listBackends().find((b) => b.id === resolved) || null,
    vaultOk: !error,
    vaultError: error,
    vaultCount: Object.keys(inVault).length,
    /** 上一次加载时钥匙串的注入情况 */
    lastLoad: vaultStatus(),
    items,
    plaintextCount: plaintext.length,
    /** 还没纳入保管的敏感文件（如实列出，不含糊） */
    notCovered: fs.existsSync(path.join(p.dataDir, 'google-token.json'))
      ? ['Google 刷新令牌仍存在 data/google-token.json（文件权限 600，尚未纳入保管库）']
      : [],
  };
}

/**
 * 把明文密钥迁进保管库。
 *
 * 顺序是刻意的，**任何一步失败都不会留下半个状态**：
 *   ①收集 → ②写保管库 → ③**读回逐项比对** → ④比对通过才动配置文件（清空 + 写 mode + 清 .env 的值）
 * 步骤 ①②③ 失败时配置文件**一个字节都没改**；④之后才真正"搬走"。
 */
export function migrateSecrets({ mode = 'auto' } = {}) {
  const config = getConfig();
  const root = cachedRoot || resolveRoot();
  const p = pathsFor(config, root);
  const resolved = resolveMode(mode);
  if (resolved === 'config') {
    throw new AppError('请选择一个具体的保管后端（如 dpapi / keychain / libsecret / file）', {
      code: 'SECRETS_BAD_BACKEND',
      status: 400,
    });
  }
  const backend = listBackends().find((b) => b.id === resolved);
  if (!backend?.available) {
    throw new AppError(`该保管后端在本机不可用：${backend?.label || resolved}`, { code: 'SECRETS_BACKEND_UNAVAILABLE', status: 400 });
  }

  // ① 收集"当前真正在用"的密钥。
  //    排除**真实环境变量**提供的（那是用户在别处设的，改不了它，抄一份只会重复）；
  //    但 `.env` 文件提供的要收进来——把它搬走、并把那一行清空，才是迁移的意义。
  const fileEnvSlots = envProvidedSlots({ onlyFile: true });
  const realEnvOnly = new Set([...envProvidedSlots()].filter((s) => !fileEnvSlots.has(s)));
  const secrets = collectFromConfig(config, { exclude: realEnvOnly });
  if (!Object.keys(secrets).length) {
    throw new AppError('没有可迁移的密钥（授权码 / API Key 都还没填）', { code: 'SECRETS_NOTHING_TO_MIGRATE', status: 400 });
  }

  // ② 写入保管库（失败即中止，不动任何文件）
  const dataDir = dataDirOf(config, root);
  const written = writeVault(resolved, { dataDir }, encodeVault(secrets));
  if (!written.ok) {
    throw new AppError(`写入保管库失败，未改动任何配置：${written.error}`, { code: 'SECRETS_WRITE_FAILED', status: 500 });
  }

  // ③ 读回逐项比对——不比对就等于没验证，"搬过去打不开"是最糟的结果
  resetVaultCache();
  const readBack = readVault(resolved, { dataDir, force: true });
  if (!readBack.ok) {
    clearVault(resolved, { dataDir });
    throw new AppError(`保管库写进去了却读不回来，已回滚：${readBack.error}`, { code: 'SECRETS_VERIFY_FAILED', status: 500 });
  }
  const decoded = decodeVault(readBack.data);
  const mismatch = Object.keys(secrets).filter((k) => decoded.secrets?.[k] !== secrets[k]);
  if (!decoded.ok || mismatch.length) {
    clearVault(resolved, { dataDir });
    throw new AppError(`保管库内容校验不一致（${mismatch.join('、') || decoded.error}），已回滚，密钥仍在原处`, {
      code: 'SECRETS_VERIFY_FAILED',
      status: 500,
    });
  }

  // ④ 校验通过，这才开始"搬走"
  const diskBefore = fs.existsSync(p.configFile) ? fs.readFileSync(p.configFile, 'utf8') : null;
  try {
    const next = { ...readDiskConfig(p.configFile) };
    next.vault = { ...(next.vault || {}), mode: resolved };
    stripFromConfig(next);
    // 顺带把 .env 里那些**确实由文件提供**的密钥清空（键名保留，加注释说明为什么是空的）
    const envResult = blankEnvSecrets(root, envFromFile);
    atomicWriteJson(p.configFile, next);
    resetVaultCache();
    cached = null;
    loadConfig({ force: true, rootDir: root });
    onConfigReload?.();
    return {
      ok: true,
      backend: resolved,
      migrated: Object.keys(secrets).length,
      items: Object.keys(secrets),
      envCleared: envResult.cleared,
      message: `已把 ${Object.keys(secrets).length} 项密钥迁到「${backend.label}」`,
    };
  } catch (err) {
    // 走到这一步才可能"改了一半"：尽力把配置文件还原，保管库里的副本保留（多一份总比少一份好）
    if (diskBefore !== null) {
      try {
        fs.writeFileSync(p.configFile, diskBefore, 'utf8');
      } catch {
        /* 尽力而为 */
      }
    }
    throw err;
  }
}

/** 从保管库搬回明文（"我不想用它了"的退路）。 */
export function revertSecrets() {
  const config = getConfig();
  const root = cachedRoot || resolveRoot();
  const p = pathsFor(config, root);
  const mode = config.vault?.mode || 'config';
  const resolved = resolveMode(mode);
  if (resolved === 'config') {
    throw new AppError('当前密钥本来就在配置文件里，无需迁回', { code: 'SECRETS_ALREADY_PLAIN', status: 400 });
  }
  const dataDir = dataDirOf(config, root);
  const { secrets } = vaultSecrets(config, root);
  if (!Object.keys(secrets).length) {
    throw new AppError('保管库里没有密钥，无需迁回', { code: 'SECRETS_EMPTY_VAULT', status: 400 });
  }
  // 先写回明文（成功后才清保管库，否则"两边都没有"就真丢了）
  const next = { ...readDiskConfig(p.configFile) };
  next.vault = { ...(next.vault || {}), mode: 'config' };
  applyToConfig(next, secrets);
  atomicWriteJson(p.configFile, next);
  clearVault(resolved, { dataDir });
  resetVaultCache();
  cached = null;
  loadConfig({ force: true, rootDir: root });
  onConfigReload?.();
  return {
    ok: true,
    restored: Object.keys(secrets).length,
    message: `已把 ${Object.keys(secrets).length} 项密钥写回配置文件（明文），并清空了保管库`,
    warning: '现在密钥又是明文了：请勿把 config.json 放进网盘 / 提交到代码仓库',
  };
}

/**
 * 把 `.env` 里由文件提供的密钥值清空（键名保留），并加一行说明。
 * 只动值，不删键——删了键下次用户就看不出这里曾经能填密钥。
 */
function blankEnvSecrets(root, keys) {
  const file = path.join(root, '.env');
  const cleared = [];
  if (!fs.existsSync(file)) return { cleared };
  let text = fs.readFileSync(file, 'utf8');
  for (const key of keys) {
    const re = new RegExp(`^(${key}\\s*=).*$`, 'm');
    if (!re.test(text)) continue;
    text = text.replace(re, '$1');
    cleared.push(key);
  }
  if (cleared.length) {
    if (!/密钥已迁移到系统保管库/.test(text)) {
      text = `${text.replace(/\s*$/, '\n')}\n# 下面这些密钥的值已迁移到系统保管库（见程序「设置 → 密钥存储」），此处留空即可\n`;
    }
    fs.writeFileSync(file, text, 'utf8');
    // 让当前进程也别再用旧值：删掉从 .env 载入的那些
    for (const key of cleared) {
      delete process.env[key];
      envFromFile.delete(key);
    }
  }
  return { cleared };
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
