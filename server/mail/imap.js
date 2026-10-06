/**
 * IMAP 连接与操作：拉取近 N 小时邮件、读取会话上下文、定位草稿箱、写入草稿。
 *
 * 安全约定：扫描阶段全程只读（EXAMINE），不会修改任何邮件标记；
 * 唯一会写入邮箱的动作是「把 AI 草稿追加到草稿箱」，且可配置关闭。
 */

import { ImapFlow } from 'imapflow';
import { AppError, hoursAgo, log, retry } from '../lib/util.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_GREETING_TIMEOUT_MS = 15_000;
const DEFAULT_SOCKET_TIMEOUT_MS = 120_000;

/** 建客户端。options.readOnly=true 时邮件箱以 EXAMINE 打开，不动 \Seen。 */
export function createClient(instance, options = {}) {
  const { imap } = instance;
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.secure,
    auth: { user: imap.authUser, pass: imap.authPass },
    logger: false,
    // 只读扫描：不向服务器回写已读状态
    disableAutoIdle: true,
    emitLogs: false,
    connectionTimeout: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    greetingTimeout: options.greetingTimeoutMs ?? DEFAULT_GREETING_TIMEOUT_MS,
    socketTimeout: options.socketTimeoutMs ?? DEFAULT_SOCKET_TIMEOUT_MS,
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
  });
  client.on('error', (err) => log.warn(`IMAP 连接错误（${instance.id}）：${err?.message || err}`));
  return client;
}

/** 连接 + 认证。失败时抛出可读的中文错误。 */
export async function connect(instance, options = {}) {
  const client = createClient(instance, options);
  try {
    await client.connect();
    return client;
  } catch (err) {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    throw wrapImapError(err, instance);
  }
}

export function wrapImapError(err, instance) {
  const raw = err?.responseText || err?.message || String(err);
  const code = err?.authenticationFailed ? 'IMAP_AUTH_FAILED' : err?.code || 'IMAP_ERROR';
  let hint = '';
  if (/AUTHENTICATIONFAILED|Invalid credentials|LOGIN failed|auth/i.test(raw)) {
    hint = '账号或授权码不正确。注意：多数企业邮箱需要「客户端专用密码/授权码」，而不是网页登录密码。';
  } else if (/certificate|self signed|unable to verify/i.test(raw)) {
    hint = 'TLS 证书校验失败。若为自建服务器，请确认证书链完整。';
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    hint = '域名解析失败，请检查 IMAP 服务器地址。';
  } else if (/ECONNREFUSED|ETIMEDOUT|timeout/i.test(raw)) {
    hint = '无法连接到服务器，请检查地址、端口与防火墙/网络出口。';
  } else if (/command not supported|not supported/i.test(raw)) {
    hint = '服务器不支持该 IMAP 命令，可尝试关闭相关高级功能。';
  }
  return new AppError(`IMAP 操作失败（${instance.label || instance.id}）：${raw}${hint ? ` — ${hint}` : ''}`, {
    code,
    status: 502,
    detail: { server: `${instance.imap.host}:${instance.imap.port}`, user: instance.imap.authUser },
  });
}

/* ------------------------------------------------------------ 邮箱列表 */

export async function listMailboxes(client) {
  const list = await client.list();
  return list.map((box) => ({
    path: box.path,
    name: box.name,
    delimiter: box.delimiter,
    specialUse: box.specialUse || null,
    flags: [...(box.flags instanceof Set ? box.flags : box.flags || [])],
  }));
}

const DRAFT_CANDIDATES = ['\\Drafts', '\\Draft'];
const DRAFT_NAME_PATTERNS = [/^drafts?$/i, /^草稿(箱)?$/, /^draft$/i, /^已删除的草稿$/];

/**
 * 定位草稿箱路径。优先 RFC 6154 的 \Drafts 特殊用途标记。
 */
export async function findDraftsMailbox(client, preferred) {
  if (preferred) return preferred;
  const boxes = await listMailboxes(client);
  const bySpecial = boxes.find((b) => DRAFT_CANDIDATES.includes(b.specialUse));
  if (bySpecial) return bySpecial.path;
  const byName = boxes.find((b) => DRAFT_NAME_PATTERNS.some((re) => re.test(b.name)));
  if (byName) return byName.path;
  const byPath = boxes.find((b) => DRAFT_NAME_PATTERNS.some((re) => re.test(b.path.split(b.delimiter || '/').pop())));
  return byPath ? byPath.path : null;
}

/* ------------------------------------------------------------ 拉取邮件 */

/**
 * 取邮件头部字段（发件人/收件人/主题/日期），并在本地解析。
 *
 * 为什么不用 IMAP 的 ENVELOPE：实测部分企业邮箱（本例的 imap.example.cn）在大批量
 * `UID FETCH ... ENVELOPE` 时会**成比例丢失响应**——请求 10 封只回 7 封，请求 250 封只回 160 封，
 * 且不报错。而 `BODY[HEADER]` 在 250 封批量下完全可靠。
 * 头部字段很小，本地解析也顺带拿到了比 ENVELOPE 更完整的显示名。
 *
 * 本函数**自己加锁**，调用方不得持锁调用（同一信箱重复加锁会死锁）。
 * 需要「在已持有锁的场景里拉头部」时用下面的 fetchHeadersUnlocked。
 *
 * @returns {Promise<Array>} 形如 fetchSince 的摘要对象（附件信息为粗略判断）
 */
export async function fetchHeaders(instance, { folder, uids, client: injected, onProgress } = {}) {
  const own = !injected;
  const client = injected || (await connect(instance));
  try {
    // 这里不接受「信箱已被打开」的假设——前一步的 search 会释放锁并关闭信箱
    let lock;
    try {
      lock = await client.getMailboxLock(folder, { readOnly: true });
    } catch (err) {
      throw wrapImapError(err, instance);
    }
    try {
      return await fetchHeadersUnlocked(client, { folder, uids, onProgress });
    } finally {
      lock?.release();
    }
  } finally {
    if (own) await safeLogout(client);
  }
}

/**
 * 拉头部并本地解析（**不加锁**：调用方必须已经打开了该信箱）。
 *
 * 单独拆出来，是为了让 `findThreadContext` 这种「调用方持锁」的场景也能用上可靠的头部路径，
 * 而不是回头去用会静默丢信的 ENVELOPE。
 */
async function fetchHeadersUnlocked(client, { folder, uids, onProgress } = {}) {
  const { parseMessage } = await import('./parse.js');
  const list = (uids || []).filter((u) => Number.isFinite(Number(u))).map(Number);
  if (!list.length) return [];
  if (process.env.MAILBOT_DEBUG_HEADERS) {
    log.warn(`fetchHeaders: folder=${folder} uids=${list.length} 首=${list[0]} 末=${list[list.length - 1]}`);
  }

  const out = [];
  let index = 0;
  let yielded = 0;
  for await (const msg of client.fetch(list, { uid: true, headers: true, flags: true, size: true }, { uid: true })) {
    yielded += 1;
    index += 1;
    onProgress?.({ folder, done: index, total: list.length, phase: 'headers' });
    if (process.env.MAILBOT_DEBUG_HEADERS && yielded <= 2) {
      log.warn(`  yield uid=${msg.uid} headers=${msg.headers ? `${msg.headers.length}B` : 'undefined'}`);
    }
    try {
      // 只有头部字节时 simpleParser 会报错（它需要「头部 + 空行」的完整消息结构），
      // 因此补一个空行把它变成「有头无正文」的合法邮件。
      const headerBytes = msg.headers || Buffer.alloc(0);
      const headerText = headerBytes.toString('utf8');
      const withSeparator = headerBytes.length && /\r?\n\r?\n\s*$/.test(headerText)
        ? headerBytes
        : Buffer.concat([headerBytes, Buffer.from('\r\n\r\n', 'utf8')]);
      const parsed = await parseMessage(withSeparator);
      // parsed.date 可能是 Date 也可能是字符串，统一成 ISO
      const dateValue = parsed.date instanceof Date ? parsed.date : parsed.date ? new Date(parsed.date) : null;
      const isoDate = dateValue && !Number.isNaN(dateValue.getTime()) ? dateValue.toISOString() : null;
      out.push({
        uid: msg.uid,
        seq: msg.seq,
        folder,
        messageId: parsed.messageId || null,
        inReplyTo: parsed.inReplyTo || null,
        subject: parsed.subject || '(无主题)',
        date: isoDate,
        from: parsed.from,
        to: parsed.to || [],
        cc: parsed.cc || [],
        replyTo: parsed.replyTo,
        references: parsed.references || [],
        flags: msg.flags instanceof Set ? [...msg.flags] : [...(msg.flags || [])],
        seen: msg.flags instanceof Set ? msg.flags.has('\\Seen') : false,
        answered: msg.flags instanceof Set ? msg.flags.has('\\Answered') : false,
        flagged: msg.flags instanceof Set ? msg.flags.has('\\Flagged') : false,
        size: msg.size ?? null,
        // 只有头部信息，附件需等取到正文时再确认；这里按**头部**里的 MIME 线索粗判
        // （Content-Type: multipart/mixed、filename= 等都在头部，正文此时本来就是空的）
        attachments: /multipart\/mixed|name=|filename=/i.test(headerText) ? [{ filename: null, contentType: null, size: null }] : [],
      });
    } catch (err) {
      log.debug(`解析头部失败 UID=${msg.uid}：${err?.message || err}`);
    }
  }
  out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return out;
}

/**
 * 只取满足条件的 UID 列表（不拉信封，开销很小）。
 *
 * 供「按需回补」先拿到全量候选：若直接按 SINCE 拉信封并截断成「最新 N 封」，
 * 会把时间范围中段/较早的邮件整段丢掉（真实案例：一个月 356 封只取了最新 212 封，
 * 目标发件人的 10 封全在更早的位置）。
 */
export async function searchUids(instance, { folder, since, before, client: injected } = {}) {
  const own = !injected;
  const client = injected || (await connect(instance));
  try {
    let lock;
    try {
      lock = await client.getMailboxLock(folder, { readOnly: true });
    } catch (err) {
      throw wrapImapError(err, instance);
    }
    try {
      const query = {};
      if (since) query.since = since instanceof Date ? since : new Date(since);
      if (before) query.before = before instanceof Date ? before : new Date(before);
      const res = await client.search(Object.keys(query).length ? query : { all: true }, { uid: true });
      return { uids: res || [], total: client.mailbox?.exists ?? 0 };
    } finally {
      lock.release();
    }
  } finally {
    if (own) await safeLogout(client);
  }
}

/**
 * 拉取指定文件夹中的邮件。
 * 三种用法：
 *   1) 默认按 since 之后的最新 maxMessages 封；
 *   2) `uids` 精确指定若干封（回补用，避免「取最新 N 封」造成的时间中段截断）；
 *   3) `newestFirst=false` 时取最旧的 N 封。
 *
 * **为什么不用 IMAP 的 ENVELOPE**（这里踩过大坑）：
 *   实测 `imap.example.cn` 对 `UID FETCH ... ENVELOPE` 会**确定性丢响应且不报错**：
 *   最近 24 小时命中 46 封，ENVELOPE 只回 39 封——**少的 7 封里就有一封高优先级、
 *   直接发给我的重要邮件**，于是「分析最近 24 小时」静默漏信，用户完全看不出来。
 *   更糟的是丢法不固定，偶尔还会让某些邮件的主题/发件人/时间解析成空，
 *   在界面上表现为「(无主题) + 时间 —」。
 *   而 `BODY[HEADER]` 在同一台服务器上 46/46、250/250 全部可靠，本地解析还能拿到完整显示名。
 *   因此这里统一走「先取 UID 列表 → 再拉头部 → 本地解析」，ENVELOPE 一条都不再请求。
 *
 * @returns {Promise<Array>} 邮件摘要数组（按时间升序）
 */
export async function fetchSince(
  instance,
  { folder, since, maxMessages = 100, client: injected, onProgress, uids: explicitUids, newestFirst = true } = {},
) {
  const own = !injected;
  const client = injected || (await connect(instance));
  const sinceDate = since instanceof Date ? since : hoursAgo(24);
  try {
    // 第一步只取 UID 列表（很轻，且不会丢）：显式指定时直接用，否则 SEARCH SINCE
    const explicit = !!(explicitUids && explicitUids.length);
    let uids;
    let total = 0;
    {
      let lock;
      try {
        lock = await client.getMailboxLock(folder, { readOnly: true });
      } catch (err) {
        throw wrapImapError(err, instance);
      }
      try {
        total = client.mailbox?.exists ?? 0;
        if (!total) return Object.assign([], { meta: { folder, total: 0, matched: 0, fetched: 0, truncated: false } });
        if (explicit) {
          uids = explicitUids.filter((u) => Number.isFinite(Number(u))).map(Number);
        } else {
          uids = (await client.search({ since: sinceDate }, { uid: true })) || [];
        }
      } finally {
        lock.release();
      }
    }
    if (!uids.length) return Object.assign([], { meta: { folder, total, matched: 0, fetched: 0, truncated: false } });

    // 截断：UID 单调递增。显式指定 UID 时不截断，交由调用方按自己的预算处理。
    const sliced = explicit || uids.length <= maxMessages ? uids : newestFirst ? uids.slice(-maxMessages) : uids.slice(0, maxMessages);
    const truncated = !explicit && uids.length > sliced.length;

    // 第二步分批拉头部（fetchHeaders 自己加锁，因此这里绝不能持锁调用）
    const summaries = [];
    const batchSize = 250;
    for (let i = 0; i < sliced.length; i += batchSize) {
      const batch = sliced.slice(i, i + batchSize);
      const part = await fetchHeaders(instance, { folder, uids: batch, client });
      summaries.push(...part);
      onProgress?.({ folder, done: Math.min(i + batch.length, sliced.length), total: sliced.length });
    }
    summaries.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
    return Object.assign(summaries, {
      meta: { folder, total, matched: uids.length, fetched: summaries.length, truncated },
    });
  } finally {
    if (own) await safeLogout(client);
  }
}

function decodeParameter(value) {
  if (!value) return null;
  if (typeof value !== 'string') return null;
  // RFC 2231 编码（filename*0*=utf-8''...）极少见，做基础处理
  const m = value.match(/^utf-8''(.+)$/i);
  return m ? safeDecodeURIComponent(m[1]) : value;
}

function safeDecodeURIComponent(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ------------------------------------------------------------ 正文 */

/** 取单封邮件完整 RFC822 原文（Buffer）。 */
export async function fetchRawSource(client, uid, folder) {
  const lock = await client.getMailboxLock(folder, { readOnly: true });
  try {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) throw new AppError(`未找到邮件 UID=${uid}`, { code: 'MAIL_NOT_FOUND', status: 404 });
    return msg.source;
  } finally {
    lock.release();
  }
}

/** 在已打开的信箱里按 UID 取原文，避免重复加锁。 */
export async function fetchRawSourceWithin(client, uid) {
  const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
  if (!msg || !msg.source) return null;
  return msg.source;
}

/**
 * 找同一会话的历史邮件：优先 In-Reply-To / References 链，其次同主题。
 * 仅在已打开的信箱内查询，只读。
 */
export async function findThreadContext(client, summary, limit = 3) {
  if (!limit || limit <= 0) return [];
  const out = [];
  const seen = new Set([summary.messageId].filter(Boolean));

  const references = [];
  if (summary.inReplyTo) references.push(summary.inReplyTo);
  // 拉取本封的 References 头以补全整条链
  try {
    const head = await client.fetchOne(String(summary.uid), { headers: true }, { uid: true });
    const rawHeaders = head?.headers ? head.headers.toString('utf8') : '';
    const refLine = rawHeaders.match(/^references:\s*([\s\S]*?)(?=\r?\n\S|$)/im);
    if (refLine) {
      for (const id of refLine[1].match(/<[^>]+>/g) || []) references.push(id.trim());
    }
  } catch {
    /* 忽略：拿不到 References 就退回同主题匹配 */
  }

  // 注意：本函数由调用方持锁调用，因此只能用不加锁的头部路径。
  // 这里刻意不用 client.fetch(..., {envelope:true})：那台服务器会静默丢响应，
  // 表现就是「会话上下文偶尔少几封」。
  const pushByUids = async (uids) => {
    if (!uids?.length) return;
    const heads = await fetchHeadersUnlocked(client, { folder: summary.folder, uids });
    for (const s of heads) {
      if (out.length >= limit) break;
      if (seen.has(s.messageId)) continue;
      if (s.messageId) seen.add(s.messageId);
      out.push(s);
    }
  };

  for (const ref of [...new Set(references)].slice(-4)) {
    if (out.length >= limit) break;
    try {
      const found = await client.search({ header: { 'Message-ID': ref } }, { uid: true });
      if (!found || !found.length) continue;
      await pushByUids([found[found.length - 1]]);
    } catch (err) {
      log.debug(`References 查询失败（${ref}）：${err?.message || err}`);
    }
  }

  if (out.length < limit && summary.subject) {
    const base = normalizeSubject(summary.subject);
    if (base) {
      try {
        const found = await client.search({ subject: base }, { uid: true });
        const candidates = (found || []).filter((u) => u !== summary.uid).slice(-limit * 2);
        const heads = await fetchHeadersUnlocked(client, { folder: summary.folder, uids: candidates });
        for (const s of heads) {
          if (out.length >= limit) break;
          // 服务端的 SUBJECT 检索是子串匹配，这里用归一化后的主题再精筛一次
          if (normalizeSubject(s.subject || '') !== base) continue;
          if (seen.has(s.messageId)) continue;
          if (s.messageId) seen.add(s.messageId);
          out.push(s);
        }
      } catch (err) {
        log.debug(`同主题查询失败：${err?.message || err}`);
      }
    }
  }

  out.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return out.slice(-limit);
}

export function normalizeSubject(subject) {
  return String(subject || '')
    .replace(/^((re|fw|fwd|答复|转发|回复)\s*[:：]\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ------------------------------------------------------------ 写入草稿 */

/**
 * 把 MIME 原文追加到草稿箱。返回 { path, uid } 或 null。
 */
export async function appendToMailbox(client, path, raw, flags = ['\\Draft'], date = new Date()) {
  const res = await retry(
    // 第 4 个参数是 IMAP 的 internal date（绝对瞬间）。显式传入而不是让服务器取"现在"，
    // 这样「Date 头 / internal date / 本地 sentAt」三者是同一时刻，便于核对与测试。
    () => client.append(path, raw, flags, date),
    { attempts: 3, label: `追加邮件到 ${path}` },
  );
  if (!res) return null;
  return { path: res.destination || path, uid: res.uid ?? null, seq: res.seq ?? null };
}

/**
 * 删除指定邮件（先标记 \Deleted，再尽力 expunge 掉）。
 *
 * 为什么要 expunge：只打 \Deleted 标记时，邮件在多数客户端里看不见，但**仍然占着**，
 * 而且一旦在别的客户端「显示已删除邮件」就会冒出来。草稿副本这种"过程产物"应当真正清掉。
 *
 * 只对**这一个 UID** 做 UID EXPUNGE（需要服务器的 UIDPLUS 扩展）：
 * 绝不能用裸 `EXPUNGE`——那会把信箱里所有被标记删除的邮件一起清掉，
 * 可能连带删掉用户在客户端里标记的其他邮件。不支持 UIDPLUS 时保留 \Deleted 标记即可。
 */
export async function deleteMessage(client, folder, uid) {
  const lock = await client.getMailboxLock(folder);
  try {
    await client.messageDelete(String(uid), { uid: true });
    // 只有服务器支持 UIDPLUS 才敢 expunge：不支持时服务端会把 range 参数忽略掉，
    // 退化成「清空整个信箱里所有 \Deleted 邮件」，那可能连带删掉用户在客户端标记的邮件。
    const supportsUidPlus = typeof client.capabilities?.has === 'function' && client.capabilities.has('UIDPLUS');
    if (supportsUidPlus) {
      try {
        await client.messageExpunge(String(uid), { uid: true });
      } catch (err) {
        log.debug(`UID EXPUNGE 失败（已保留 \\Deleted 标记）：${err?.message || err}`);
      }
    } else {
      log.debug('服务器不支持 UIDPLUS，仅标记 \\Deleted，不做全局 expunge（避免误删其它邮件）');
    }
    return true;
  } finally {
    lock.release();
  }
}

export async function safeLogout(client) {
  if (!client) return;
  try {
    if (client.usable) await client.logout();
    else await client.close();
  } catch (err) {
    log.debug(`IMAP 关闭异常：${err?.message || err}`);
  }
}
