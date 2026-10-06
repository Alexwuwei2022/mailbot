/**
 * 邮件正文解析：把 RFC822 原文解析成结构化对象（纯文本正文、附件、头部）。
 */

import { simpleParser } from 'mailparser';
import { normalizeWhitespace, stripHtml, truncate } from '../lib/util.js';

/**
 * @param {Buffer|string} source RFC822 原文
 * @returns {Promise<object>}
 */
/**
 * 只取原始 HTML 正文（给"渲染 HTML"用）。
 *
 * 为什么不把 html 塞进 parseMessage 的返回值：那个结果会被**写进分析记录**，
 * 邮件 HTML 动辄几十 KB，全量存进 state.json 会让它迅速膨胀。
 * 所以这里单独开一个函数，由详情接口按需调用（用户点"渲染 HTML"时才取）。
 *
 * @returns {{html: string, hasHtml: boolean}}
 */
export async function extractHtmlBody(raw) {
  if (!raw) return { html: '', hasHtml: false };
  try {
    const parsed = await simpleParser(raw, {
      skipHtmlToText: true,
      skipTextToHtml: true,
      skipImageLinks: true,
    });
    const html = typeof parsed.html === 'string' ? parsed.html : '';
    return { html, hasHtml: !!html.trim() };
  } catch {
    // 解析失败就当作没有 HTML：界面会退回纯文本，不影响阅读
    return { html: '', hasHtml: false };
  }
}

export async function parseMessage(source) {
  const parsed = await simpleParser(source, {
    skipHtmlToText: false,
    skipTextToHtml: true,
    skipImageLinks: true,
  });

  const text = normalizeWhitespace(parsed.text || '');
  const html = typeof parsed.html === 'string' ? parsed.html : '';
  const body = text || stripHtml(html);

  return {
    subject: parsed.subject || '',
    date: parsed.date ? parsed.date.toISOString() : null,
    messageId: parsed.messageId || null,
    inReplyTo: parsed.inReplyTo || null,
    references: normalizeReferences(parsed.references),
    from: addressOf(parsed.from),
    to: addressList(parsed.to),
    cc: addressList(parsed.cc),
    bcc: addressList(parsed.bcc),
    replyTo: addressOf(parsed.replyTo),
    headers: headersToObject(parsed.headers),
    body,
    bodyFormat: text ? 'text' : html ? 'html' : 'empty',
    /*
     * 只给一个布尔标记，**不把 HTML 正文塞进返回值**：这个结果会被写进分析记录，
     * 而 HTML 动辄几十 KB。客户端据此决定要不要显示「渲染 HTML」按钮，
     * 真正取正文走 extractHtmlBody()。
     */
    hasHtml: !!html.trim(),
    attachments: (parsed.attachments || []).map((a) => ({
      filename: a.filename || null,
      contentType: a.contentType || null,
      size: a.size ?? null,
      contentId: a.contentId || null,
      contentDisposition: a.contentDisposition || null,
      related: !!a.related,
    })).filter((a) => !isInlineAttachment(a)),
  };
}

/**
 * 判断是否是"正文内嵌"的附件（例如签名里的图片），而不是真附件。
 *
 * 规则比早期更宽一点，原因是真实邮件里内嵌图片有两种写法：
 *   1. `multipart/related` 里带 Content-ID（mailparser 会置 `related: true`）——最常见；
 *   2. 直接放在 `multipart/mixed` 里，靠 `Content-Disposition: inline` + Content-ID 标记。
 * 只认第一种会让第二种混进附件清单（用户会看到一个 logo.png 当成附件）。
 *
 * 反向保护：只要有 Content-ID 但声明是 `attachment`，仍按真附件处理——
 * 宁可在清单里多一项，也不要把用户真正要的文件藏起来。
 */
export function isInlineAttachment(a) {
  if (!a) return false;
  const hasContentId = !!(a.contentId || a.cid);
  if (!hasContentId) return false;
  if (a.related) return true;
  const disposition = String(a.contentDisposition || a.disposition || '').toLowerCase();
  return disposition === 'inline';
}

/**
 * 对用户可见的附件（排除正文内嵌图片）。
 *
 * **列表与下载必须共用这一个函数**：否则界面按一种顺序编号、下载按另一种顺序取，
 * 点第 3 个附件会下到第 5 个——这类错位极难被用户说清楚，只能从实现上杜绝。
 */
export function visibleAttachments(attachments) {
  return (attachments || []).filter((a) => !isInlineAttachment(a) && !a.inline);
}

/**
 * 把任意来源的文件名收敛成可安全落盘/落头的文件名。
 *
 * 邮件里的文件名是**对方可控**的，可能带 `../`、绝对路径、控制字符或超长内容。
 * 处理原则：
 *   - 只取最后一段路径（去掉任何目录成分）；
 *   - 去掉控制字符与 Windows 非法字符；
 *   - 去掉开头的点（避免 `.`、`..`、`.bashrc` 这类名字）；
 *   - 限长，空则给一个兜底名。
 * 这只用于**展示与下载名**，绝不会用作用户可控的服务端路径。
 */
export function safeFilename(name, fallback = 'attachment') {
  const last = String(name ?? '')
    .replace(/[\r\n\t]/g, ' ')
    .split(/[\\/]/)
    .pop();
  const cleaned = String(last ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned.slice(0, 180) || fallback;
}

/**
 * 取出指定序号的附件内容（含 Buffer）。
 *
 * 与 `parseMessage` 分开是因为：解析只是要给界面看元数据，
 * 而附件内容可能有几十 MB，不该在每次打开详情时都驻留内存。
 *
 * @param {Buffer|string} source RFC822 原文
 * @param {number} index `visibleAttachments()` 列表里的下标
 * @returns {Promise<{filename: string, contentType: string, size: number, content: Buffer, inline: boolean, total: number}|null>}
 */
export async function extractAttachment(source, index) {
  const parsed = await simpleParser(source, {
    skipHtmlToText: true,
    skipTextToHtml: true,
    skipImageLinks: true,
  });
  const list = visibleAttachments(
    (parsed.attachments || []).map((a) => ({
      filename: a.filename || null,
      contentType: a.contentType || null,
      size: a.size ?? null,
      contentId: a.contentId || null,
      contentDisposition: a.contentDisposition || null,
      related: !!a.related,
      content: a.content,
    })),
  );
  // 注意 Number(null) === 0、Number('') === 0：必须先挡掉空值，
  // 否则"没传下标"会被当成"第 0 个附件"，静默下错文件。
  if (index === null || index === undefined || index === '' || typeof index === 'boolean') return null;
  const n = Number(index);
  if (!Number.isInteger(n) || n < 0 || n >= list.length) return null;
  const a = list[n];
  const content = Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content ?? ''), 'utf8');
  return {
    filename: safeFilename(a.filename, `附件-${n + 1}`),
    contentType: a.contentType || 'application/octet-stream',
    size: content.length,
    content,
    inline: a.inline,
    total: list.length,
  };
}

export function normalizeReferences(refs) {  if (!refs) return [];
  const list = Array.isArray(refs) ? refs : [refs];
  const out = [];
  for (const item of list) {
    for (const id of String(item).match(/<[^>]+>/g) || []) out.push(id.trim());
  }
  return [...new Set(out)];
}

/**
 * mailparser 的地址字段在不同输入下形态不同：
 *   - 单个地址时返回 AddressObject，真实地址在 .value[] 里，.text 是格式化后的字符串
 *   - 多个地址时返回 AddressObject[]（元素的 .value[] 也可能是数组）
 * 这里统一取第一个真实地址，绝不从 .text 里拆分（姓名里也会出现尖括号）。
 */
function pickAddress(obj) {
  if (!obj) return null;
  if (Array.isArray(obj)) return pickAddress(obj[0]);
  const nested = obj.value;
  if (Array.isArray(nested) && nested.length) {
    const first = nested.find((v) => v && (v.address || v.name));
    if (first) return { name: first.name || '', address: String(first.address || '').toLowerCase().trim() };
  }
  if (typeof nested === 'string' && nested.includes('@')) {
    return { name: obj.name || '', address: nested.toLowerCase().trim() };
  }
  if (obj.address) return { name: obj.name || '', address: String(obj.address).toLowerCase().trim() };
  if (nested && typeof nested === 'object' && nested.address) {
    return { name: nested.name || obj.name || '', address: String(nested.address).toLowerCase().trim() };
  }
  return null;
}

function addressOf(obj) {
  const picked = pickAddress(obj);
  if (!picked || !picked.address) return null;
  return picked;
}

function addressList(obj) {
  if (!obj) return [];
  const objects = Array.isArray(obj) ? obj : [obj];
  const out = [];
  for (const o of objects) {
    if (Array.isArray(o?.value) && o.value.length > 1) {
      for (const v of o.value) {
        if (v?.address) out.push({ name: v.name || '', address: String(v.address).toLowerCase().trim() });
      }
      continue;
    }
    const picked = pickAddress(o);
    if (picked?.address) out.push(picked);
  }
  return out;
}

function headersToObject(headers) {
  const out = {};
  if (!headers) return out;
  const entries = typeof headers.entries === 'function' ? [...headers.entries()] : [];
  for (const [key, value] of entries) {
    out[key] = typeof value === 'string' ? value : value?.text || String(value);
  }
  return out;
}

/**
 * 把正文切成「新内容」与「引用历史」两段。
 *
 * 判断方式与 stripQuoted 完全一致（> 开头块、常见分隔线、`在…写道：`、`发件人:` 行），
 * 区别只是**两段都要**：模型只需要新内容，而「查看原始邮件」要把引用历史单独折叠展示，
 * 起草回复时也只引用新内容（否则会「引用里的引用」滚雪球）。
 */
export function splitQuoted(body) {
  const lines = String(body || '').replace(/\r\n/g, '\n').split('\n');
  const fresh = [];
  const quoted = [];
  let cut = false;
  for (const line of lines) {
    const t = line.trim();
    if (cut) {
      quoted.push(line);
      continue;
    }
    if (
      /^>/.test(t) ||
      /^-{2,}\s*(原始邮件|Original Message|转发邮件|Forwarded message)/i.test(t) ||
      /^(在\s.+写道：|On .+wrote:|发件人[:：]\s*$)/i.test(t) ||
      /^_{5,}$/.test(t)
    ) {
      cut = true;
      quoted.push(line);
      continue;
    }
    fresh.push(line);
  }
  return {
    fresh: normalizeWhitespace(fresh.join('\n')) || normalizeWhitespace(body),
    // 引用历史保留原始换行与缩进，展示时才好看
    quoted: quoted.join('\n').trim(),
  };
}

/** 去掉引用历史（> 开头块、常见分隔线）得到「新内容」，供模型聚焦。 */
export function stripQuoted(body) {
  return splitQuoted(body).fresh;
}

/** 生成列表页用的一行摘要。 */
export function makeSnippet(body, max = 240) {
  const oneLine = String(body || '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(oneLine, max).replace(/\n…（已截断.*$/, '…');
}

/** 送给模型的正文字符裁剪（保留头部，避免丢失诉求）。 */
export function clipForLlm(body, maxChars) {
  if (body.length <= maxChars) return body;
  const head = Math.floor(maxChars * 0.7);
  const tail = maxChars - head;
  return `${body.slice(0, head)}\n\n…（中间省略 ${body.length - maxChars} 字）…\n\n${body.slice(-tail)}`;
}
