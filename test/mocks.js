/**
 * 测试用最小 IMAP / SMTP 服务器。
 *
 * 目的：在没有真实邮箱的情况下，用真实协议驱动 imapflow 与 nodemailer，
 * 验证「拉取 → 解析 → 起草 → 写草稿箱 → 发送」的链路确实能跑通。
 */

import net from 'node:net';

import { listenOn, listenRandom } from './lib/port.js';

const CRLF = '\r\n';

/** 逐行读取 socket，支持 IMAP 字面量（{n} 后跟 n 字节）。 */
class LineReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.waiters = [];
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.#pump();
    });
    socket.on('error', () => this.#fail(new Error('socket error')));
    socket.on('close', () => this.#fail(new Error('socket closed')));
  }

  #fail(err) {
    while (this.waiters.length) this.waiters.shift().reject(err);
  }

  #pump() {
    while (this.waiters.length) {
      const waiter = this.waiters[0];
      const result = this.#trySatisfy(waiter);
      if (result === null) break;
      this.waiters.shift();
      waiter.resolve(result);
    }
  }

  #trySatisfy(waiter) {
    if (waiter.mode === 'line') {
      const idx = this.buffer.indexOf('\r\n');
      if (idx < 0) return null;
      const line = this.buffer.subarray(0, idx).toString('utf8');
      this.buffer = this.buffer.subarray(idx + 2);
      return line;
    }
    if (waiter.mode === 'bytes') {
      if (this.buffer.length < waiter.count) return null;
      const out = this.buffer.subarray(0, waiter.count);
      this.buffer = this.buffer.subarray(waiter.count);
      return out;
    }
    return null;
  }

  /**
   * 取一行。先同步尝试消费缓冲区，取不到才挂等待者——
   * 避免「数据先到、等待者后挂」时错过唤醒。
   */
  readLine(timeoutMs = 10_000) {
    const waiter = { mode: 'line' };
    const immediate = this.#trySatisfy(waiter);
    if (immediate !== null) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('读行超时'));
      }, timeoutMs);
      const origResolve = waiter.resolve;
      waiter.resolve = (v) => {
        clearTimeout(timer);
        origResolve(v);
      };
      this.#pump();
    });
  }

  readBytes(count, timeoutMs = 10_000, { consumeTrailingCrlf = false } = {}) {
    const total = consumeTrailingCrlf ? count + 2 : count;
    const waiter = { mode: 'bytes', count: total };
    if (this.buffer.length >= total) {
      const raw = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      return Promise.resolve(consumeTrailingCrlf ? raw.subarray(0, count) : raw);
    }
    return new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error('读字节超时'));
      }, timeoutMs);
      const origResolve = waiter.resolve;
      waiter.resolve = (v) => {
        clearTimeout(timer);
        origResolve(consumeTrailingCrlf ? v.subarray(0, count) : v);
      };
      this.#pump();
    });
  }
}

/** 读一条完整 IMAP 命令，处理其中可能出现的字面量。 */
async function readImapCommand(reader) {
  let command = await reader.readLine();
  for (;;) {
    const m = command.match(/\{(\d+)(\+?)\}$/);
    if (!m) return command;
    const size = Number(m[1]);
    const isLiteralPlus = m[2] === '+';
    // 非 LITERAL+（没有 +）时，客户端会等待服务器的续行响应 "+" 后才发数据
    if (!isLiteralPlus) reader.socket.write(`+ OK${CRLF}`);
    // LITERAL+ 的命令以 CRLF 结尾需要一并吃掉；同步字面量则刚好是 size 字节
    const literal = await reader.readBytes(size, 10_000, { consumeTrailingCrlf: isLiteralPlus });
    if (!isLiteralPlus) return `${command}${CRLF}${literal.toString('utf8')}`;
    const rest = await reader.readLine();
    command += `${CRLF}${literal.toString('utf8')}${CRLF}${rest}`;
    if (!/\{(\d+)\+?\}$/.test(rest)) return command;
  }
}

/** SASL PLAIN 载荷：base64(\0user\0pass)。 */
function decodePlainSasl(token) {
  const decoded = Buffer.from(String(token || '').trim(), 'base64').toString('utf8');
  const parts = decoded.split('\u0000');
  return { user: parts[1] ?? parts[0], pass: parts[2] ?? parts[1] };
}

/* ------------------------------------------------------------ IMAP */

/**
 * @param {object} options
 * @param {Array} options.messages 形如 { uid, raw, flags, internalDate }
 * @param {Array} options.mailboxes
 */
/**
 * @param {object} options
 * @param {boolean} [options.envelopeBug] 复现真实服务器的缺陷行为：
 *   `UID FETCH ... ENVELOPE` 会**确定性丢失部分响应**（实测某企业邮箱 60 封只回 41 封），
 *   而 `BODY[HEADER]` 才是可靠的。用于验证「改用头部解析」确实修好了这个问题。
 * @param {number} [options.envelopeBugKeep] 缺失比例（默认丢一半）
 */
export async function startMockImap({
  messages = [],
  mailboxes,
  user = 'bot@example.com',
  pass = 'secret',
  port = 0,
  envelopeBug = false,
  envelopeBugKeep = 0.5,
} = {}) {
  const boxes =
    mailboxes ||
    [
      { path: 'INBOX', name: 'INBOX', specialUse: null, flags: [] },
      { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', flags: [] },
      { path: 'Sent', name: 'Sent', specialUse: null, flags: [] },
    ];

  const store = { messages: [...messages], appended: [], deleted: [], log: [] };
  const sockets = new Set();

  /*
   * 并发连接探针：用来**实测**「同一账号上到底同时有几条 IMAP 连接」。
   *
   * 为什么要记在 mock 里，而不是靠读代码推断：多个入口（分析 / 检索回补 / 正文回源 /
   * 草稿同步 / 诊断）各自开连接，光看调用图很容易漏；只有服务器这一侧数出来的
   * 「同时活跃连接数峰值」才是证据。峰值 ≤ 1 就等价于「同账号被串行化了」。
   */
  const stats = { active: 0, total: 0, maxConcurrent: 0, events: [] };
  const mark = (type) => {
    stats.events.push({ at: Date.now(), type, active: stats.active });
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    stats.active += 1;
    stats.total += 1;
    if (stats.active > stats.maxConcurrent) stats.maxConcurrent = stats.active;
    mark('open');
    /*
     * 会话结束的判定要**确定**，不能只等 TCP 的 'close'：
     * 客户端 `logout()` 收到 OK 就认为连接没了并马上去建下一条，而服务端的 'close'
     * 往往晚几毫秒才到——那会让「先关后开」被误记成「两条同时活跃」，
     * 峰值统计就会偶发变成 2（本套用例曾因此变成随机失败）。
     * 因此在处理 LOGOUT 时就先记一次结束，'end'/'close' 只作为异常断开的兜底。
     */
    let sessionClosed = false;
    const markClosed = () => {
      if (sessionClosed) return;
      sessionClosed = true;
      sockets.delete(socket);
      stats.active -= 1;
      mark('close');
    };
    const reader = new LineReader(socket);
    let selected = null;

    const write = (line) => {
      if (process.env.MAILBOT_TEST_DEBUG) console.error(`[mock-imap] > ${line}`);
      socket.write(`${line}${CRLF}`);
    };

    (async () => {
      write(`* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN UIDPLUS] mock imap ready`);      for (;;) {
        let command;
        try {
          command = await readImapCommand(reader);
        } catch {
          break;
        }
        store.log.push(command.split(CRLF)[0]);

        const tagMatch = command.match(/^(\S+)\s+([\s\S]+)$/);
        if (!tagMatch) continue;
        const [, tag, body] = tagMatch;
        const upper = body.toUpperCase();

        if (upper.startsWith('CAPABILITY')) {
          write('* CAPABILITY IMAP4rev1 AUTH=PLAIN AUTH=LOGIN NAMESPACE UIDPLUS');
          write(`${tag} OK CAPABILITY completed`);
          continue;
        }
        // 服务端广告 NAMESPACE 后，imapflow 就不再从文件夹层级里"猜"命名空间前缀
        if (upper.startsWith('NAMESPACE')) {
          write('* NAMESPACE (("" "/")) NIL NIL');
          write(`${tag} OK NAMESPACE completed`);
          continue;
        }
        if (upper.startsWith('AUTHENTICATE')) {
          const mech = (body.split(/\s+/)[1] || '').toUpperCase();
          if (mech !== 'PLAIN') {
            write(`${tag} NO Unsupported authentication mechanism`);
            continue;
          }
          if (body.split(/\s+/).length > 2) {
            // 初始响应随命令一起发来（SASL-IR）
            const { user: u, pass: p } = decodePlainSasl(body.split(/\s+/)[2]);
            write(u === user && p === pass ? `${tag} OK AUTHENTICATE completed` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
            continue;
          }
          write('+ ');
          const token = await reader.readLine();
          const { user: u, pass: p } = decodePlainSasl(token);
          write(u === user && p === pass ? `${tag} OK AUTHENTICATE completed` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
          continue;
        }
        if (upper.startsWith('LOGIN')) {
          const m = body.match(/LOGIN\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?/i);
          const [, u, p] = m || [];
          if (u === user && p === pass) write(`${tag} OK LOGIN completed`);
          else write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials`);
          continue;
        }
        if (upper.startsWith('LIST')) {
          for (const b of boxes) {
            const flags = b.specialUse ? `\\HasNoChildren ${b.specialUse}` : '\\HasNoChildren';
            write(`* LIST (${flags}) "/" "${b.path}"`);
          }
          write(`${tag} OK LIST completed`);
          continue;
        }        if (upper.startsWith('STATUS')) {
          const m = body.match(/STATUS\s+"?([^"\s]+)"?/i);
          const path = m?.[1];
          const box = boxes.find((b) => b.path === path);
          const count = path === selected ? store.messages.length : 0;
          void box;
          write(`* STATUS "${path}" (MESSAGES ${count} UIDNEXT ${count + 1} UIDVALIDITY 1 UNSEEN 0)`);
          write(`${tag} OK STATUS completed`);
          continue;
        }
        if (upper.startsWith('EXAMINE') || upper.startsWith('SELECT')) {
          const m = body.match(/(?:EXAMINE|SELECT)\s+"?([^"\s]+)"?/i);
          const path = m?.[1];
          const box = boxes.find((b) => b.path === path);
          if (!box) {
            write(`${tag} NO Mailbox does not exist`);
            continue;
          }
          selected = path;
          const isInbox = path === 'INBOX';
          const count = isInbox ? store.messages.length : 0;
          write(`* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)`);
          write(`* OK [PERMANENTFLAGS (\\Seen \\Draft \\Deleted)] Flags permitted`);
          write(`* ${count} EXISTS`);
          write(`* 0 RECENT`);
          write(`* OK [UIDVALIDITY 1] UIDs valid`);
          write(`* OK [UIDNEXT ${count + 1}] Predicted next UID`);
          write(`${tag} OK [READ-${upper.startsWith('EXAMINE') ? 'ONLY' : 'WRITE'}] ${path} selected`);
          continue;
        }
        if (upper.startsWith('UID SEARCH') || upper.startsWith('SEARCH')) {
          const ids = selected === 'INBOX' ? store.messages.map((m) => m.uid) : [];
          write(`* SEARCH ${ids.join(' ')}${ids.length ? ' ' : ''}`.trimEnd());
          write(`${tag} OK SEARCH completed`);
          continue;
        }
        if (upper.startsWith('UID FETCH') || upper.startsWith('FETCH')) {
          const rest = body.replace(/^UID\s+/i, '');
          const m = rest.match(/FETCH\s+([\d,:*]+)\s+(.*)$/i);
          const set = m?.[1] || '*';
          const query = m?.[2] || '';
          // 客户端请求头部字段时，只回头部。
          // 关键：请求里的 `BODY.PEEK[...]` 是**请求侧修饰符**，按 RFC 服务器必须回 `BODY[...]`。
          // imapflow 只把 `body[header]` 映射到 msg.headers（`body.peek[header]` 会被整条丢弃，
          // 且不报错——这正好复现了「静默丢响应」的现场），所以这里必须把 .PEEK 去掉。
          const headerAttrMatch = query.match(/(BODY(?:\.PEEK)?\[[^\]]*\])/i);
          const headerAttr = (headerAttrMatch ? headerAttrMatch[1] : 'BODY[HEADER]').replace(/\.PEEK/i, '');
          const wantHeaders = /HEADER/i.test(query) && !/BODY\[\]|RFC822(?!\.SIZE)/i.test(query);
          let targets =
            selected === 'INBOX'
              ? store.messages.filter((msg) => matchUidSet(set, msg.uid))
              : [];
          // 复现真实服务器缺陷：只请求 ENVELOPE（且不是头部查询）时丢失部分响应。
          // 注意是「确定性」丢失——同一批 UID 每次缺的都是同一批，与真实观测一致。
          if (envelopeBug && !wantHeaders && /ENVELOPE/i.test(query)) {
            const keep = new Set(
              targets.filter((_m, i) => i % Math.max(2, Math.round(1 / envelopeBugKeep)) === 0).map((m) => m.uid),
            );
            targets = targets.filter((m) => keep.has(m.uid));
          }
          if (process.env.MAILBOT_TEST_DEBUG) {
            console.error(`[mock-imap] FETCH set=${String(set).slice(0, 60)} headers=${wantHeaders} 匹配到 ${targets.length} 封`);
          }
          // 注意：imapflow 仅在 FETCH 响应含字面量（{n}）时才把它当作 untagged FETCH 处理，
          // 因此这里总是带一个字面量：请求头部就回 BODY[HEADER]，否则回 BODY[]。
          targets.forEach((msg, index) => {
            const parsed = parseEnvelope(msg.raw);
            if (wantHeaders) {
              // 头部查询：只回必要字段 + BODY[HEADER]，贴近真实服务器
              const text = msg.raw.toString('utf8');
              const headerEnd = text.search(/\r?\n\r?\n/);
              const headerText = headerEnd >= 0 ? text.slice(0, headerEnd + 2) : text;
              const headerBuf = Buffer.from(`${headerText}\r\n`, 'utf8');
              const hmeta = [`UID ${msg.uid}`, `FLAGS (${(msg.flags || []).join(' ')})`, `RFC822.SIZE ${msg.raw.length}`].join(' ');
              write(`* ${index + 1} FETCH (${hmeta} ${headerAttr} {${headerBuf.length}}`);
              socket.write(headerBuf);
              socket.write(`)\r\n`);
              return;
            }
            const meta = [
              `UID ${msg.uid}`,
              `FLAGS (${(msg.flags || []).join(' ')})`,
              `RFC822.SIZE ${msg.raw.length}`,
              // ENVELOPE 必须给满 10 个字段，第 9 个是 In-Reply-To
              `ENVELOPE ("${msg.internalDate}" "${escapeQuoted(parsed.subject)}" (${addressEnvelope(parsed.from)}) NIL NIL (${addressEnvelope(parsed.to)}) NIL NIL NIL "${escapeQuoted(parsed.messageId || '')}" "${escapeQuoted(parsed.inReplyTo || '')}")`,
              `BODYSTRUCTURE ("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "7BIT" ${msg.raw.length} 1)`,
            ].join(' ');
            write(`* ${index + 1} FETCH (${meta} BODY[] {${msg.raw.length}}`);
            socket.write(msg.raw);
            socket.write(`)\r\n`);
          });
          write(`${tag} OK FETCH completed`);
          continue;
        }
        if (upper.startsWith('APPEND')) {
          // 形如：APPEND Drafts (\Draft) "26-Sep-2026 14:47:39 +0000" {15}
          const m = body.match(
            /APPEND\s+"?([^"\s]+)"?\s*(?:\(([^)]*)\))?\s*(?:"[^"]*")?\s*\{(\d+)\+?\}/i,
          );
          if (!m) {
            if (process.env.MAILBOT_TEST_DEBUG) console.error(`[mock-imap] APPEND 语法未识别：${body}`);
            write(`${tag} BAD APPEND syntax`);
            continue;
          }
          const [, path, flagStr, sizeStr] = m;
          const literalStart = command.indexOf(CRLF) + 2;
          const literal = command.slice(literalStart, literalStart + Number(sizeStr));
          store.appended.push({ path, flags: (flagStr || '').split(/\s+/).filter(Boolean), raw: literal });
          write(`${tag} OK [APPENDUID 1 ${store.appended.length}] APPEND completed`);
          continue;
        }
        // 注意：ImapFlow 发的是 `UID STORE ...`，所以不能只用 startsWith('STORE') 判断
        const storeMatch = body.match(/(?:^|\s)STORE\s+([\d,:*]+)\s+\+?FLAGS(?:\.SILENT)?\s+\(([^)]*)\)/i);
        if (storeMatch) {
          // 记录「标记 \Deleted」的请求：deleteMessage 走的是 messageDelete（STORE +FLAGS \Deleted）
          if (/\\Deleted/i.test(storeMatch[2])) {
            for (const uid of String(storeMatch[1]).split(',')) {
              const n = Number(uid);
              if (Number.isFinite(n)) store.deleted.push({ path: selected, uid: n });
            }
          }
          write(`${tag} OK STORE completed`);
          continue;
        }
        if (/^(?:UID\s+)?EXPUNGE\b/i.test(body)) {
          // 真正把已标记删除的邮件从信箱里移除，模拟服务器行为
          const removed = new Set(store.deleted.filter((d) => d.path === selected).map((d) => Number(d.uid)));
          if (removed.size) store.messages = store.messages.filter((m) => !removed.has(Number(m.uid)));
          write(`* ${store.messages.length} EXPUNGE`);
          write(`${tag} OK EXPUNGE completed`);
          continue;
        }
        if (upper.startsWith('CLOSE')) {
          selected = null;
          write(`${tag} OK CLOSE completed`);
          continue;
        }
        if (upper.startsWith('LOGOUT')) {
          write('* BYE logging out');
          write(`${tag} OK LOGOUT completed`);
          // 客户端收到这个 OK 就认为连接结束了，这里同步把它算作"不再活跃"
          markClosed();
          socket.end();
          break;
        }
        if (upper.startsWith('NOOP') || upper.startsWith('ID') || upper.startsWith('ENABLE')) {
          if (upper.startsWith('ID')) write('* ID NIL');
          write(`${tag} OK completed`);
          continue;
        }
        write(`${tag} OK completed`);
      }
    })().catch((err) => {
      if (process.env.MAILBOT_TEST_DEBUG) console.error('[mock-imap] 处理异常：', err?.stack || err);
      socket.destroy();
    });

    socket.on('end', markClosed);
    socket.on('close', markClosed);
  });

  /*
   * 端口 0（默认）表示"让系统挑一个"：那条路径走 listenRandom——它除了重试读 `address()`，
   * 还会避开 fetch/浏览器禁用端口。IMAP 是裸 socket，本身不受那份名单限制；
   * 让所有 mock 都走同一条"抽一个能用的端口"的路径，就不必逐个判断谁会被 fetch 打到。
   */
  const actualPort = port === 0 ? await listenRandom(server) : await listenOn(server, port);

  return {
    port: actualPort,
    host: '127.0.0.1',
    store,
    /** 并发探针：{ active, total, maxConcurrent, events }（events 含每条连接的开/关与当时活跃数） */
    stats,
    /** 同时活跃的连接数峰值（测试里最常用的那个数） */
    get maxConcurrent() {
      return stats.maxConcurrent;
    },
    /** 把峰值清零，便于「先跑基线、再测并发」两段分开断言 */
    resetConcurrency() {
      stats.maxConcurrent = stats.active;
      stats.events.length = 0;
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
  };
}

function matchUidSet(set, uid) {
  for (const part of String(set).split(',')) {
    if (part === '*') return true;
    const [a, b] = part.split(':');
    if (b === undefined) {
      if (Number(a) === uid) return true;
      continue;
    }
    const start = a === '*' ? -Infinity : Number(a);
    const end = b === '*' ? Infinity : Number(b);
    if (uid >= start && uid <= end) return true;
  }
  return false;
}

function escapeQuoted(text) {
  return String(text || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function addressEnvelope(addr) {
  if (!addr?.address) return 'NIL';
  const [mailbox, host] = addr.address.split('@');
  return `("${escapeQuoted(addr.name || '')}" NIL "${mailbox}" "${host || ''}")`;
}

function parseEnvelope(raw) {
  const text = raw.toString('utf8');
  const header = text.split(/\r?\n\r?\n/)[0];
  const get = (name) => {
    const m = header.match(new RegExp(`^${name}:\\s*(.*)$`, 'im'));
    return m ? m[1].trim() : '';
  };
  const addrOf = (value) => {
    if (!value) return null;
    const m = value.match(/^(.*?)\s*<([^>]+)>/);
    if (m) return { name: m[1].replace(/^"|"$/g, ''), address: m[2] };
    return { name: '', address: value.trim() };
  };
  return {
    subject: decodeMimeWords(get('Subject')),
    messageId: get('Message-ID'),
    inReplyTo: get('In-Reply-To'),
    from: addrOf(get('From')),
    to: addrOf(get('To')),
  };
}

function decodeMimeWords(value) {
  return String(value || '').replace(/=\?UTF-8\?B\?([^?]+)\?=/gi, (_m, b64) =>
    Buffer.from(b64, 'base64').toString('utf8'),
  );
}

/* ------------------------------------------------------------ SMTP */

export async function startMockSmtp({  user = 'bot@example.com',
  pass = 'secret',
  port = 0,
  failAuth = false,
  /** 按机制拒绝，模拟腾讯企业邮箱「AUTH PLAIN 回 535 system busy」这类行为，例如 ['PLAIN'] */
  rejectMethods = [],
  /** 自定义 535 文案 */
  authErrorText = '535 5.7.8 Authentication credentials invalid',
} = {}) {
  const received = [];
  const sockets = new Set();
  let authAttempts = 0;
  const rejected = new Set(rejectMethods.map((m) => String(m).toUpperCase()));

  const server = net.createServer((socket) => {
    sockets.add(socket);
    const reader = new LineReader(socket);
    const write = (line) => socket.write(`${line}${CRLF}`);
    let inData = false;
    let dataLines = [];
    let envelope = { from: null, to: [] };

    (async () => {
      write('220 mock smtp ready');
      for (;;) {
        let line;
        try {
          line = await reader.readLine();
        } catch {
          break;
        }
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ ...envelope, raw: dataLines.join(CRLF) });
            envelope = { from: null, to: [] };
            dataLines = [];
            write('250 OK queued');
            continue;
          }
          dataLines.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        const [verb, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (verb.toUpperCase()) {
          case 'EHLO':
            write('250-mock smtp');
            write('250-AUTH LOGIN PLAIN');
            write('250-8BITMIME');
            write('250 SIZE 20971520');
            break;
          case 'HELO':
            write('250 mock smtp');
            break;
          case 'AUTH': {
            authAttempts += 1;
            const mech = (arg || '').split(' ')[0].toUpperCase();
            if (process.env.MAILBOT_TEST_DEBUG) console.error(`[mock-smtp] AUTH mech=${mech} rejected=${rejected.has(mech)} arg=${JSON.stringify(arg.slice(0, 40))}`);
            if (rejected.has(mech)) {
              // 仍需把 SASL 交互走完，避免客户端停在半路（真实服务器也是先 334 再拒）
              if (mech === 'LOGIN') {
                write('334 VXNlcm5hbWU6');
                await reader.readLine();
                write('334 UGFzc3dvcmQ6');
                await reader.readLine();
              } else if (mech === 'PLAIN' && !arg.includes(' ')) {
                write('334 ');
                await reader.readLine();
              }
              write(authErrorText);
              break;
            }
            if (mech === 'LOGIN') {
              write('334 VXNlcm5hbWU6');
              const u = Buffer.from(await reader.readLine(), 'base64').toString('utf8');
              write('334 UGFzc3dvcmQ6');
              const p = Buffer.from(await reader.readLine(), 'base64').toString('utf8');
              if (failAuth || u !== user || p !== pass) write('535 5.7.8 Authentication credentials invalid');
              else write('235 2.7.0 Authentication successful');
            } else if (mech === 'PLAIN') {
              const token = arg.includes(' ') ? arg.split(' ')[1] : await reader.readLine();
              const decoded = Buffer.from(token || '', 'base64').toString('utf8');
              const [, u, p] = decoded.split('\0');
              if (failAuth || u !== user || p !== pass) write('535 5.7.8 Authentication credentials invalid');
              else write('235 2.7.0 Authentication successful');
            } else {
              write('504 5.5.4 Unrecognized authentication type');
            }
            break;
          }
          case 'MAIL':
            envelope.from = (arg.match(/<([^>]*)>/) || [])[1] || arg;
            write('250 OK');
            break;
          case 'RCPT':
            envelope.to.push((arg.match(/<([^>]*)>/) || [])[1] || arg);
            write('250 OK');
            break;
          case 'DATA':
            inData = true;
            write('354 End data with <CR><LF>.<CR><LF>');
            break;
          case 'RSET':
            envelope = { from: null, to: [] };
            dataLines = [];
            write('250 OK');
            break;
          case 'QUIT':
            write('221 Bye');
            socket.end();
            return;
          default:
            write('250 OK');
        }
      }
    })().catch(() => socket.destroy());

    socket.on('close', () => sockets.delete(socket));
  });

  // 端口 0 → 让系统挑，并避开 fetch 禁用端口（同 startMockImap 的说明）
  const actualPort = port === 0 ? await listenRandom(server) : await listenOn(server, port);
  return {
    port: actualPort,
    host: '127.0.0.1',
    received,
    get authAttempts() {
      return authAttempts;
    },
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(resolve);
      }),
  };
}

/* ------------------------------------------------------------ 假大模型 */

/**
 * 假装成 OpenAI 兼容的 /chat/completions。
 * handler(kind, body) 可自定义回复；默认按 prompt 内容返回分类或起草结果。
 */
export async function startMockLlm({ port = 0, handler } = {}) {
  const http = await import('node:http');
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* ignore */
      }
      const prompt = parsed.messages?.map((m) => m.content).join('\n') || '';
      const kind = /"items"/.test(prompt) && /分类取值/.test(prompt)
        ? 'classify'
        : /知识库助手/.test(prompt) || /"insufficient"/.test(prompt)
          ? 'qa'
          : /"confidence"/.test(prompt) && /"body"/.test(prompt)
            ? 'draft'
            : 'other';
      // 连 kind 一起记：测试要断言"某类调用发生了几次"（例如复用是否真的省下了分类调用）
      calls.push({ ...parsed, kind });
      const content = handler ? handler(kind, prompt, parsed) : defaultResponse(kind, prompt);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          model: parsed.model || 'mock-model',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        }),
      );
    });
  });
  // 端口 0 → 让系统挑，并避开 fetch 禁用端口（大模型是**用 fetch 打的**，这条尤其关键）
  const actualPort = port === 0 ? await listenRandom(server) : await listenOn(server, port);
  return {
    port: actualPort,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    calls,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function defaultResponse(kind, prompt) {
  if (kind === 'classify') {
    // 依据邮件里出现的 主题 行生成条目，覆盖所有需要回复的邮件
    const count = (prompt.match(/^#\d+$/gm) || []).length || 1;
    const items = Array.from({ length: count }, (_v, i) => ({
      index: i + 1,
      type: 'action_required',
      priority: i === 0 ? 'urgent' : 'high',
      needsReply: true,
      summary: `第 ${i + 1} 封邮件需要确认交付时间。`,
      actions: ['确认交付时间', '回复对方'],
      language: 'zh',
      reason: '对方给出明确请求并要求回复。',
    }));
    return JSON.stringify({ items });
  }
  if (kind === 'draft') {
    return JSON.stringify({
      subject: 'Re: 测试主题',
      body: '您好，\n\n收到，我确认按约定时间交付。\n\n如有变更我会提前告知。\n\n王磊',
      reason: '对方要求确认交付时间，直接给出明确答复。',
      notes: ['请确认交付时间是否为周三'],
      language: 'zh',
      confidence: 0.82,
    });
  }
  return JSON.stringify({ ok: true });
}

/* ------------------------------------------------------------ 测试邮件 */

export function makeRawMail({
  subject = '测试主题',
  from = { name: '张三', address: 'zhangsan@client.com' },
  to = { name: '王磊', address: 'bot@example.com' },
  body = '你好，请确认本周三能否交付。\n\n谢谢',
  messageId = `<test-${Math.random().toString(36).slice(2)}@client.com>`,
  date = new Date(),
  inReplyTo,
  references,
  attachment,
  /** 多个附件：[{filename, contentType, content}] */
  attachments,
  /** 内嵌图片（有 Content-ID，应为"不算真附件"）：{filename, contentType, content, contentId} */
  inlineImage,
} = {}) {
  const lines = [
    `From: ${from.name ? `=?UTF-8?B?${Buffer.from(from.name).toString('base64')}?= ` : ''}<${from.address}>`,
    `To: <${to.address}>`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: ${messageId}`,
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references?.length ? `References: ${references.join(' ')}` : null,
    'MIME-Version: 1.0',
  ].filter(Boolean);

  if (attachments?.length || attachment || inlineImage) {
    const list = attachments?.length ? attachments : attachment ? [attachment] : [];
    const boundary = `----=_mix_${Math.random().toString(36).slice(2)}`;
    const inner = `----=_alt_${Math.random().toString(36).slice(2)}`;
    lines.push(`Content-Type: multipart/mixed; boundary="${boundary}"`, '');
    lines.push(
      `--${boundary}`,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    );
    // 内嵌图片（有 Content-ID + inline）：用来验证"不算真附件"的过滤
    if (inlineImage) {
      lines.push(
        `--${boundary}`,
        `Content-Type: ${inlineImage.contentType || 'image/png'}; name="${inlineImage.filename || 'logo.png'}"`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${inlineImage.contentId || 'logo@local'}>`,
        `Content-Disposition: inline; filename="${inlineImage.filename || 'logo.png'}"`,
        '',
        Buffer.from(inlineImage.content || 'PNG').toString('base64'),
      );
    }
    for (const a of list) {
      lines.push(
        `--${boundary}`,
        `Content-Type: ${a.contentType || 'application/pdf'}; name="${a.filename}"`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${a.filename}"`,
        '',
        Buffer.from(a.content || 'PDF-DATA').toString('base64'),
      );
    }
    lines.push(`--${boundary}--`, '');
    void inner;
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '');
    lines.push(Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'));
    lines.push('');
  }
  return Buffer.from(lines.join(CRLF), 'utf8');
}

export function defaultMailboxes() {
  return [
    { path: 'INBOX', name: 'INBOX', specialUse: null, flags: [] },
    { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', flags: [] },
  ];
}
