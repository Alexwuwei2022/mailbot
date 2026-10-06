/**
 * 回复引文：把原始邮件附在回复正文之后（签名之下）。
 *
 * 为什么必须做：收件人看到一封没有任何原文的回复，会不知道你在回哪一句——
 * 尤其在企业邮箱里这是"不规范"的观感。Foxmail / Outlook 中文版默认就会带引文。
 *
 * 三条硬性约束：
 *   1. **顺序必须是「新正文 → 签名 → 引文」**。签名必须在引文之上，否则一是不符合邮件礼仪，
 *      二是会把签名挤进引用块里，破坏「签名只出现一次」的幂等保证。
 *   2. **只引用"新内容"**（已剥离引用历史的部分）。直接引用整封原文会把
 *      「引用里的引用」一层层滚进去，正文迅速变成几千行的历史堆积。
 *   3. **幂等**：再次追加同一封的引文不产生第二份（用户可能手点两次，或重新生成过）。
 */

import { splitQuoted } from './parse.js';
import { formatInZone } from '../calendar/time.js';

/** 支持的引文风格。 */
export const QUOTE_STYLES = ['zh-client', 'prefix'];

/** 中文客户端风格的分隔线（也是幂等判断的标记）。 */
export const ZH_MARKER = '------------------ 原始邮件 ------------------';

function addr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return a.name ? `${a.name} <${a.address}>` : a.address || '';
}

function addrList(list) {
  return (Array.isArray(list) ? list : []).map(addr).filter(Boolean).join('；');
}

function fmtTime(value, timeZone) {
  if (!value) return '';
  try {
    return formatInZone(value, timeZone, { withWeekday: true });
  } catch {
    return String(value);
  }
}

/**
 * 生成引文块（不含前导空行的处理，由 appendQuote 负责）。
 *
 * @param {object} options
 * @param {object} options.mail 原始邮件（subject/from/to/cc/date）
 * @param {string} options.body 原始邮件正文（可含引用历史，会被自行剥离）
 * @param {string} [options.timeZone] 按此时区格式化时间
 * @param {string} [options.style] zh-client | prefix
 * @param {number} [options.maxChars] 引文字符上限（超出从尾部截断并标注）
 * @returns {string} 可直接追加到正文之后的文本（开头不带空行）
 */
export function buildQuoteBlock({ mail = {}, body = '', timeZone = 'Asia/Shanghai', style = 'zh-client', maxChars = 2000 } = {}) {
  const { fresh } = splitQuoted(body);
  const original = clipQuote(fresh || body, maxChars);
  const when = fmtTime(mail.date, timeZone);
  const from = addr(mail.from);
  const to = addrList(mail.to);
  const cc = addrList(mail.cc);
  const subject = mail.subject || '(无主题)';

  if (style === 'prefix') {
    const lines = [
      `在 ${when || '（时间未知）'}，${from || '（发件人未知）'} 写道：`,
      ...original.split('\n').map((line) => (line.trim() ? `> ${line}` : '>')),
    ];
    return lines.join('\n');
  }

  // 默认：中文客户端风格
  const lines = [ZH_MARKER, `发件人: ${from || '（未知）'}`, `发送时间: ${when || '（未知）'}`];
  if (to) lines.push(`收件人: ${to}`);
  if (cc) lines.push(`抄送: ${cc}`);
  lines.push(`主题: ${subject}`, '', original);
  return lines.join('\n');
}

/** 引文裁剪：超长时保留头部（诉求通常在前半部分）。 */
function clipQuote(text, maxChars) {
  const s = String(text || '').trim();
  const max = Number(maxChars) > 0 ? Number(maxChars) : 2000;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…（原文较长，此处省略 ${s.length - max} 字）`;
}

/** 引文标记（用于幂等判断）。 */
function markerOf(style) {
  return style === 'prefix' ? ' 写道：' : ZH_MARKER;
}

/** 正文里是否已经带了引文。 */
export function hasQuote(body, style = 'zh-client') {
  const text = String(body || '');
  if (style === 'prefix') return /\n\s*在 .+ 写道：/.test(text) || /^在 .+ 写道：/m.test(text);
  return text.includes(ZH_MARKER);
}

/**
 * 把引文追加到正文末尾（幂等）。
 * @returns {string}
 */
export function appendQuote(body, quote, style = 'zh-client') {
  const base = String(body || '').replace(/\s+$/, '');
  const block = String(quote || '').replace(/\s+$/, '');
  if (!block) return base;
  if (hasQuote(base, style)) return base;
  return `${base}\n\n${block}\n`;
}

/**
 * 组装完整的回复正文：新正文 → 签名 → 引文。
 *
 * @param {object} options
 * @param {string} options.body 已经带好签名的正文
 * @param {object} options.mail 原始邮件
 * @param {string} [options.originalBody] 原始邮件正文
 * @param {object} [options.config] 完整配置（读 draft.quoteOriginal / quoteStyle / quoteMaxChars）
 * @param {string} [options.timeZone]
 * @returns {{body: string, quoted: boolean, quoteStyle: string|null, quoteMarker: string|null}}
 */
export function attachQuote({ body, mail, originalBody, config, timeZone }) {
  const draftConfig = config?.draft || {};
  const style = QUOTE_STYLES.includes(draftConfig.quoteStyle) ? draftConfig.quoteStyle : 'zh-client';
  const enabled = draftConfig.quoteOriginal !== false;
  if (!enabled) return { body: String(body || ''), quoted: false, quoteStyle: null, quoteMarker: null };

  const text = String(originalBody || '').trim();
  // 原文没内容时不要造一个空引文块
  if (!text) return { body: String(body || ''), quoted: false, quoteStyle: style, quoteMarker: null };

  const quote = buildQuoteBlock({
    mail,
    body: text,
    timeZone: timeZone || config?.calendar?.timeZone || 'Asia/Shanghai',
    style,
    maxChars: draftConfig.quoteMaxChars,
  });
  const merged = appendQuote(body, quote, style);
  return {
    body: merged,
    quoted: hasQuote(merged, style),
    quoteStyle: style,
    quoteMarker: markerOf(style),
  };
}
