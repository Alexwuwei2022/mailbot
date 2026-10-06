/**
 * 通用工具：日志、错误、时间、JSON 提取、限流并发、重试。
 */

export const APP_NAME = 'mailbot';
export const APP_VERSION = '1.0.0';

/* ------------------------------------------------------------------ 日志 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };
let currentLevel = LEVELS[process.env.MAILBOT_LOG_LEVEL] ?? LEVELS.info;

export function setLogLevel(level) {
  if (typeof level === 'string' && LEVELS[level] !== undefined) currentLevel = LEVELS[level];
}

function ts() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function emit(level, args) {
  if (LEVELS[level] < currentLevel) return;
  const tag = level.toUpperCase().padEnd(5);
  const line = `[${ts()}] ${tag} ${args
    .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : safeJson(a)))
    .join(' ')}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (...a) => emit('debug', a),
  info: (...a) => emit('info', a),
  warn: (...a) => emit('warn', a),
  error: (...a) => emit('error', a),
};

/* ------------------------------------------------------------------ 错误 */

export class AppError extends Error {
  constructor(message, { code = 'APP_ERROR', status = 500, detail } = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export function toErrorPayload(err) {
  if (err instanceof AppError) {
    return { ok: false, code: err.code, message: err.message, detail: err.detail ?? null };
  }
  const message = err?.message || String(err);
  return { ok: false, code: err?.code || 'INTERNAL_ERROR', message, detail: null };
}

/** 服务端日志里绝不落授权码 / apiKey 明文。 */
export function redactConnectionFields(input) {
  if (!input || typeof input !== 'object') return input;
  const out = { ...input };
  for (const k of Object.keys(out)) {
    if (/(pass|password|auth|secret|token|key)/i.test(k)) out[k] = out[k] ? '***' : out[k];
  }
  return out;
}

/* ------------------------------------------------------------------ 时间 */

export function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function iso(value) {
  const d = toDate(value);
  return d ? d.toISOString() : null;
}

export function hoursAgo(hours) {
  return new Date(Date.now() - hours * 3600_000);
}

export function formatLocal(value) {
  const d = toDate(value);
  if (!d) return '未知时间';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ JSON */

export function safeJson(value, space = 0) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[circular]';
          seen.add(v);
        }
        if (v instanceof Error) return { name: v.name, message: v.message };
        return v;
      },
      space,
    );
  } catch {
    return '"[unserializable]"';
  }
}

/**
 * 从模型输出里稳健地取出 JSON 对象/数组。
 * 依次尝试：整体解析 → 去掉 ```json 围栏 → 截取首个平衡的 {...} / [...]。
 */
export function extractJson(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  if (!raw) return null;

  const direct = tryParse(raw);
  if (direct !== undefined) return direct;

  const fenced = raw.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fenced) {
    const inner = tryParse(fenced[1].trim());
    if (inner !== undefined) return inner;
  }

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']'],
  ]) {
    const start = raw.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const candidate = tryParse(raw.slice(start, i + 1));
          if (candidate !== undefined) return candidate;
          break;
        }
      }
    }
  }
  return null;
}

function tryParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ 文本 */

export function truncate(text, max) {
  const s = typeof text === 'string' ? text : String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（已截断，原长 ${s.length} 字符）`;
}

export function normalizeWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripHtml(html) {
  return normalizeWhitespace(
    String(html ?? '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/gi, "'"),
  );
}

export function splitEmails(value) {
  if (!value) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;]/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

export function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

/* ------------------------------------------------------------------ 并发 */

/** 以固定并发跑一批任务，失败返回 null 而不是中断整批。 */
export async function mapLimit(items, limit, worker) {
  const list = [...items];
  const results = new Array(list.length).fill(null);
  let cursor = 0;
  const width = Math.max(1, Math.min(limit || 1, list.length || 1));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= list.length) return;
        try {
          results[index] = await worker(list[index], index);
        } catch (err) {
          log.warn(`任务 #${index} 失败：${err?.message || err}`);
          results[index] = null;
        }
      }
    }),
  );
  return results;
}

/** 指数退避重试。shouldRetry 返回 false 时立即抛出。 */
export async function retry(fn, { attempts = 3, baseMs = 600, maxMs = 12_000, label = '操作', shouldRetry } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      const retryable = shouldRetry ? shouldRetry(err) : true;
      if (!retryable || i === attempts - 1) break;
      const wait = Math.min(maxMs, baseMs * 2 ** i) * (0.75 + Math.random() * 0.5);
      log.warn(`${label} 第 ${i + 1} 次失败（${err?.message || err}），${Math.round(wait)}ms 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

export function isRetryableNetworkError(err) {
  if (!err) return false;
  const code = err.code || err.cause?.code;
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true;
  const status = err.status || err.statusCode;
  return status === 429 || (typeof status === 'number' && status >= 500);
}

/* ------------------------------------------------------------------ 其他 */

let idCounter = 0;
export function newId(prefix = 'id') {
  idCounter = (idCounter + 1) % 100000;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

/** 生成用于邮件线程匹配的稳定字符串哈希。 */
export function fnv1a(input) {
  let hash = 0x811c9dc5;
  const s = String(input ?? '');
  for (let i = 0; i < s.length; i += 1) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function firstDefined(...values) {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj?.[k] !== undefined) out[k] = obj[k];
  return out;
}
