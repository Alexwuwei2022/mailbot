/**
 * 手工组装 RFC822 邮件原文（用于 IMAP APPEND 写入草稿箱），
 * 以及把草稿正文转成 HTML（用于 SMTP 发送时的 multipart/alternative）。
 *
 * 之所以自己拼 MIME 而不复用 nodemailer：草稿必须原样落在服务器草稿箱里，
 * 头部（In-Reply-To / References / Date / Message-ID）需要完全可控。
 */

import { fnv1a, splitEmails } from '../lib/util.js';
import { getConfig } from '../config/index.js';
import { formatRfc5322Date } from '../calendar/time.js';
import { safeFilename } from './parse.js';

const CRLF = '\r\n';

/** 取配置里的展示时区（邮件时间一律按它表达）。配置不可用时退回 Asia/Shanghai。 */
export function mailTimeZone() {
  try {
    return getConfig().calendar?.timeZone || 'Asia/Shanghai';
  } catch {
    return 'Asia/Shanghai';
  }
}

/* ------------------------------------------------------------ 编码 */

/** RFC 2047 编码字。纯 ASCII 直接返回。 */
export function encodeHeaderWord(str) {
  const s = String(str ?? '');
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** 长头部按 76 字符软换行（仅用于 RFC2047 编码后的词）。 */
function foldHeader(name, value) {
  const prefix = `${name}: `;
  const maxLen = 76;
  if (prefix.length + value.length <= maxLen) return prefix + value;

  const words = value.split(/(\?=)\s+/).filter((w) => w !== '');
  const lines = [];
  let line = prefix;
  for (const word of words) {
    const piece = word.endsWith('?=') ? `${word} ` : word;
    if (line.length + piece.length > maxLen && line.trim() !== '') {
      lines.push(line.replace(/\s+$/, ''));
      line = ` ${piece}`;
    } else {
      line += piece;
    }
  }
  lines.push(line.replace(/\s+$/, ''));
  return lines.join(CRLF);
}

export function formatAddress(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') {
    const m = addr.match(/^(.*?)\s*<([^>]+)>$/);
    if (m) return formatAddress({ name: m[1].replace(/^"|"$/g, '').trim(), address: m[2].trim() });
    return addr.trim();
  }
  const address = String(addr.address || '').trim();
  const name = String(addr.name || '').trim();
  if (!name) return address;
  const encoded = encodeHeaderWord(name);
  if (encoded !== name) return `${encoded} <${address}>`;
  // 纯 ASCII 名字：包含特殊字符时才加引号
  return /[()<>@,;:\\".\[\]]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>` : `${name} <${address}>`;
}

export function formatAddressList(list) {
  return (Array.isArray(list) ? list : [list]).filter(Boolean).map(formatAddress).join(', ');
}

/* ------------------------------------------------------------ 正文编码 */

function needsBase64(text) {
  // eslint-disable-next-line no-control-regex
  return !/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text);
}

function encodeBodyQp(text) {
  // 简化 QP：只编码非 ASCII 与行尾空白，够用且不会破坏中文
  const prepared = text.replace(/\r?\n/g, CRLF);
  return prepared
    .split(CRLF)
    .map((line) => {
      let out = '';
      const bytes = Buffer.from(line, 'utf8');
      for (const b of bytes) {
        if (b === 0x3d) out += '=3D';
        else if (b === 0x20 || b === 0x09) out += String.fromCharCode(b);
        else if (b >= 0x20 && b <= 0x7e) out += String.fromCharCode(b);
        else out += `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      }
      return out.replace(/[ \t]+$/, (m) => m.split('').map((c) => `=${c.charCodeAt(0).toString(16).toUpperCase()}`).join(''));
    })
    .join(CRLF);
}

function encodeBody(text) {
  const body = String(text ?? '').replace(/\r?\n/g, CRLF);
  if (needsBase64(body)) {
    const b64 = Buffer.from(body, 'utf8').toString('base64');
    // 按 76 字符硬折行（不能用字符串替换，'$1\r\n' 里的 \r\n 会被当成普通字符）
    const chunks = [];
    for (let i = 0; i < b64.length; i += 76) chunks.push(b64.slice(i, i + 76));
    return { content: chunks.join(CRLF), encoding: 'base64' };
  }
  return { content: encodeBodyQp(body), encoding: 'quoted-printable' };
}

/* ------------------------------------------------------------ Message-ID */

export function makeMessageId(fromAddress, subject) {
  const domain = String(fromAddress || '').split('@')[1] || 'mailbot.local';
  const seed = `${Date.now()}-${Math.random()}-${subject || ''}`;
  return `<mb.${Date.now().toString(36)}.${fnv1a(seed)}@${domain}>`;
}

export function ensureReplyPrefix(subject) {
  const s = String(subject || '').trim();
  if (!s) return 'Re: (无主题)';
  if (/^(re|答复|回复)\s*[:：]/i.test(s)) return s;
  return `Re: ${s}`;
}

/* ------------------------------------------------------------ 身份 */

/**
 * 把配置里的 identity（字段名是 email）转换成 {name, address}。
 * 配置用 email，MIME/传输层用 address，这里做唯一的一次转换。
 */
export function identitySender(identity) {
  if (!identity) return null;
  if (identity.address) return { name: identity.name || '', address: identity.address };
  const address = String(identity.email || '').trim();
  if (!address) return null;
  return { name: identity.name || '', address };
}

/* ------------------------------------------------------------ 组装 */

/** 生成 MIME 边界。必须是「token」且足够短，否则 SMTP 客户端重新编码时会把参数折行，
 *  部分收件端会因此解析不出 multipart。 */
function makeBoundary() {
  const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
  return `mb${Date.now().toString(36)}x${rand}`;
}

export function buildMime({
  from,
  to,
  cc,
  bcc,
  replyTo,
  subject,
  text,
  html,
  inReplyTo,
  references,
  messageId,
  date = new Date(),
  timeZone,
  /** 附件：[{filename, contentType, content: Buffer}] */
  attachments,
  headers = {},
  listUnsubscribe,
}) {
  if (!from?.address) throw new Error('buildMime: 缺少发件人地址');
  const recipients = splitEmails(to);
  if (recipients.length === 0) throw new Error('buildMime: 缺少收件人');

  const lines = [];
  lines.push(foldHeader('From', formatAddress(from)));
  lines.push(foldHeader('To', formatAddressList(recipients)));
  if (cc && splitEmails(cc).length) lines.push(foldHeader('Cc', formatAddressList(splitEmails(cc))));
  if (bcc && splitEmails(bcc).length) lines.push(foldHeader('Bcc', formatAddressList(splitEmails(bcc))));
  if (replyTo) lines.push(foldHeader('Reply-To', formatAddress(replyTo)));
  lines.push(foldHeader('Subject', encodeHeaderWord(subject || '(无主题)')));
  // Date 用配置时区的数字偏移（+0800）而不是 GMT：绝对时刻相同，
  // 但 Foxmail 等客户端的「已发送」列表会按头部原样显示偏移，
  // 写 GMT 会让中国用户看到早 8 小时的时间。
  lines.push(`Date: ${formatRfc5322Date(date, timeZone || mailTimeZone())}`);
  lines.push(`Message-ID: ${messageId || makeMessageId(from.address, subject)}`);
  if (inReplyTo) lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references?.length) lines.push(foldHeader('References', references.join(' ')));
  lines.push('MIME-Version: 1.0');

  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null || v === '') continue;
    lines.push(foldHeader(k, String(v)));
  }
  if (listUnsubscribe) lines.push(`List-Unsubscribe: ${listUnsubscribe}`);

  const useHtml = typeof html === 'string' && html.trim().length > 0;
  const files = Array.isArray(attachments) ? attachments.filter((a) => a && a.content) : [];
  const altBoundary = useHtml ? makeBoundary() : null;
  const mixedBoundary = files.length ? makeBoundary() : null;

  /*
   * 结构（有附件时）：
   *   multipart/mixed
   *     ├─ multipart/alternative（纯文本 + HTML）或 text/plain
   *     ├─ application/...
   *     └─ ...
   * 没有附件时保持和以前完全一样的输出（不引入多余的 MIME 层级，
   * 因为每加一层都会让一部分老客户端解析失败）。
   */
  const bodyPart = () => {
    const plain = encodeBody(text);
    if (!useHtml) {
      return [
        'Content-Type: text/plain; charset=UTF-8',
        `Content-Transfer-Encoding: ${plain.encoding}`,
        '',
        plain.content,
      ];
    }
    const rich = encodeBody(html);
    return [
      `Content-Type: multipart/alternative; boundary=${altBoundary}`,
      '',
      `--${altBoundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      `Content-Transfer-Encoding: ${plain.encoding}`,
      '',
      plain.content,
      `--${altBoundary}`,
      'Content-Type: text/html; charset=UTF-8',
      `Content-Transfer-Encoding: ${rich.encoding}`,
      '',
      rich.content,
      `--${altBoundary}--`,
    ];
  };

  let contentLines;
  if (!files.length) {
    lines.push(`Content-Type: ${useHtml ? `multipart/alternative; boundary=${altBoundary}` : 'text/plain; charset=UTF-8'}`);
    if (!useHtml) lines.push(`Content-Transfer-Encoding: ${encodeBody(text).encoding}`);
    contentLines = useHtml ? [`--${altBoundary}`, ...bodyPart(), `--${altBoundary}--`, ''] : [bodyPart()[bodyPart().length - 1], ''];
  } else {
    lines.push(`Content-Type: multipart/mixed; boundary=${mixedBoundary}`);
    contentLines = [`--${mixedBoundary}`, ...bodyPart()];
    for (const a of files) {
      const filename = safeFilename(a.filename, 'attachment');
      const type = a.contentType || guessContentType(filename);
      const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content), 'utf8');
      contentLines.push(
        `--${mixedBoundary}`,
        `Content-Type: ${type}; name="${asciiFilename(filename)}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        '',
        wrapBase64(content.toString('base64')),
      );
    }
    contentLines.push(`--${mixedBoundary}--`, '');
  }

  /*
   * 头部与正文之间**必须有且只有一个空行**。
   *
   * 这里曾经是 `lines.push('')` 之后直接 `lines.join(CRLF) + body.join(CRLF)`：
   * 末尾那个空字符串只会补出一个 CRLF，**并没有真正的空行**，
   * 于是首行 boundary 紧贴在 Content-Type 后面。多数客户端会宽容地猜对，
   * 但严格解析器（包括测试里用的 mailparser）会把 multipart 拆错、正文解析成空。
   * 现在显式拼一个空行，结构一定符合 RFC 5322 的「头部空行正文」。
   */
  return Buffer.from([...lines, '', ...contentLines].join(CRLF), 'utf8');
}

/** 把 base64 按 76 字符折行（RFC 2045 要求，行长超限会被部分服务端拒收）。 */
function wrapBase64(b64) {
  return b64.replace(/(.{76})/g, `$1${CRLF}`).replace(new RegExp(`${CRLF}$`), '');
}

/** 内容类型里不能出现裸引号与换行（文件名是用户/邮件可控的）。 */
function asciiFilename(name) {
  return String(name).replace(/[^\x20-\x7e]/g, '_').replace(/["\\\r\n]/g, '_');
}

/** 按扩展名猜 Content-Type（浏览器没给类型时兜底）。 */
function guessContentType(filename) {
  const ext = String(filename).toLowerCase().split('.').pop();
  const map = {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    txt: 'text/plain; charset=UTF-8',
    csv: 'text/csv; charset=UTF-8',
    md: 'text/markdown; charset=UTF-8',
    json: 'application/json',
    zip: 'application/zip',
    rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    eml: 'message/rfc822',
  };
  return map[ext] || 'application/octet-stream';
}

/* ------------------------------------------------------------ HTML 化 */

function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 纯文本 → 简洁 HTML（段落 + 换行），用于 alternate part。 */
export function textToHtml(text) {
  const paragraphs = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const body = paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('\n');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7;color:#1f2328;">${body}</body></html>`;
}
