/**
 * 离线自检：用本地模拟的 IMAP / SMTP / 大模型服务，跑通完整链路。
 * 不需要真实邮箱，也不会对外发送任何邮件。
 *
 *   node test/selftest.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbot-selftest-'));

// 必须在导入业务模块之前设置环境变量
process.env.MAILBOT_DATA_DIR = tmpDir;
process.env.MAILBOT_DEFAULT_INSTANCE = 'test';
process.env.MAILBOT_LOG_LEVEL = process.env.MAILBOT_LOG_LEVEL || 'warn';
// 隔离本机 .env：否则真实凭据会覆盖测试配置
process.env.MAILBOT_NO_DOTENV = '1';
delete process.env.DEEPSEEK_API_KEY;
delete process.env.MAILBOT_LLM_API_KEY;
delete process.env.MAILBOT_IMAP_PASS;
delete process.env.MAILBOT_SMTP_PASS;

const { loadConfig, getConfig, getInstance, getPaths, resetConfigCache, maskConfig, saveConfig, ensureDirs } = await import(
  '../server/config/index.js'
);
const { parseMessage, stripQuoted, makeSnippet } = await import('../server/mail/parse.js');
const { buildMime, textToHtml, ensureReplyPrefix } = await import('../server/mail/compose.js');
const { LlmClient } = await import('../server/llm/client.js');
const { classifyMails, draftReply } = await import('../server/ai/analyze.js');
const { connect, fetchSince, findDraftsMailbox, appendToMailbox, safeLogout } = await import('../server/mail/imap.js');
const { sendMessage, verifyTransport, sendRaw, resetTransportPools } = await import('../server/mail/smtp.js');
const { runScan } = await import('../server/ai/engine.js');
const { buildOverview, buildKnowledge } = await import('../server/ai/insight.js');
const { runDiagnostics } = await import('../server/diagnostics.js');
const { sendDraft, updateDraft } = await import('../server/mail/drafts.js');
const store = await import('../server/store/state.js');
const { startServer } = await import('../server/index.js');
const mocks = await import('./mocks.js');

/* ------------------------------------------------------------ 断言 */

let passed = 0;
const failures = [];
let currentTest = '';

function test(name, fn) {
  currentTest = name;
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed += 1;
      console.log(`  ✓ ${name}`);
    })
    .catch((err) => {
      failures.push({ name, message: err?.stack || String(err) });
      console.log(`  ✗ ${name}\n      ${err?.message || err}`);
    });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败');
}

/**
 * 起一个测试用 HTTP 服务，并在关闭时**断开保活连接**。
 *
 * 为什么需要 closeAllConnections：测试里反复用 `port: 0` 起服务，
 * 操作系统可能把刚释放的端口再次分配给我们。此时 Node 的全局 fetch（undici）
 * 连接池里可能还留着上一位占用者留下的保活连接，
 * 复用时就会随机抛 `TypeError: fetch failed`——本套件曾因此偶发失败。
 * 关掉所有连接即可断掉这个隐患。
 */
async function startTestServer(options) {
  const started = await startServer(options);
  const close = started.server.close.bind(started.server);
  started.server.close = (cb) =>
    close(() => {
      cb?.();
    });
  return {
    ...started,
    async stop() {
      started.server.closeAllConnections?.();
      await new Promise((r) => started.server.close(r));
    },
  };
}

/**
 * 带一次重试的 JSON 请求。
 *
 * 只对**网络层**失败（TypeError: fetch failed）重试一次：这类失败在本套件里
 * 来自连接池复用一个已关闭服务的连接，属于测试环境问题，不是被测代码的问题。
 * HTTP 状态码错误不会被重试。
 */
async function fetchJson(url, options, { retries = 1 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
      return { status: res.status, body, headers: res.headers };
    } catch (err) {
      const networkish = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/i.test(String(err?.message || err)) || err?.cause;
      if (attempt >= retries || !networkish) throw err;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function assertIncludes(haystack, needle, message) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${message || '未包含期望内容'}：期望包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(String(haystack).slice(0, 300))}`);  }
}

/* ------------------------------------------------------------ 环境准备 */

const NOW = new Date();
const MAIL_A = mocks.makeRawMail({
  subject: '合同附件二付款条款确认',
  from: { name: '李经理', address: 'lijingli@client.com' },
  body: '王磊你好，\n\n请在本周五前确认合同附件二的付款条款，客户那边在等。\n\n谢谢\n李经理',
  date: new Date(NOW.getTime() - 30 * 60_000),
  messageId: '<mail-a@client.com>',
  // 真实场景里「需要回复的来信」通常本身就是某条会话的回复，用于验证线程头透传
  inReplyTo: '<thread-root@client.com>',
  references: ['<thread-root@client.com>'],
  attachment: { filename: '合同附件二.pdf', contentType: 'application/pdf', content: 'PDF-A' },
});
const MAIL_B = mocks.makeRawMail({
  subject: '系统通知：你的月度报表已生成',
  from: { name: '报表系统', address: 'noreply@system.com' },
  body: '你的 8 月报表已生成，无需回复。\n\n-- 系统自动发送',
  date: new Date(NOW.getTime() - 3 * 3600_000),
  messageId: '<mail-b@system.com>',
});
const MAIL_C = mocks.makeRawMail({
  subject: 'Re: 合同附件二付款条款确认',
  from: { name: '王磊', address: 'bot@example.com' },
  to: { name: '李经理', address: 'lijingli@client.com' },
  body: '李经理你好，\n\n我确认按 30% 预付、70% 验收后支付执行。\n\n王磊',
  date: new Date(NOW.getTime() - 20 * 60_000),
  messageId: '<mail-c@example.com>',
  inReplyTo: '<mail-a@client.com>',
  references: ['<mail-a@client.com>'],
});

const MESSAGES = [
  { uid: 101, raw: MAIL_B, flags: [], internalDate: new Date(NOW.getTime() - 3 * 3600_000).toUTCString() },
  { uid: 102, raw: MAIL_A, flags: [], internalDate: new Date(NOW.getTime() - 30 * 60_000).toUTCString() },
];

function baseInstance(overrides) {
  return {
    id: 'test',
    label: '测试邮箱',
    enabled: true,
    imap: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    smtp: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    identity: { name: '王磊', email: 'bot@example.com', replyTo: '' },
    ...overrides,
  };
}

function configure({ imapPort, smtpPort, llmBaseUrl, extra = {} }) {
  resetConfigCache();
  const config = loadConfig({ rootDir: root, force: true });
  config.instances = [baseInstance({ imap: { host: '127.0.0.1', port: imapPort, secure: false, authUser: 'bot@example.com', authPass: 'secret' }, smtp: { host: '127.0.0.1', port: smtpPort, secure: false, authUser: 'bot@example.com', authPass: 'secret' } })];
  config.defaultInstanceId = 'test';
  config.llm = { ...config.llm, baseUrl: llmBaseUrl, apiKey: 'test-key', model: 'mock-model', jsonMode: true, maxRetries: 1 };
  config.scan = { ...config.scan, windowHours: 24, maxMessages: 50, threadContextCount: 1, bodyCharsForLlm: 3000 };
  config.draft = { ...config.draft, saveToMailbox: true, maxDrafts: 5, concurrency: 2, sendPolicy: 'confirm' };
  config.web = { ...config.web, authToken: 'test-token', allowSend: true };
  Object.assign(config, extra);
  return config;
}

/* ------------------------------------------------------------ 主流程 */

console.log(`\n邮箱数字人 · 离线自检\n数据目录：${tmpDir}\n`);

const imap = await mocks.startMockImap({ messages: MESSAGES });
const smtp = await mocks.startMockSmtp();
const llm = await mocks.startMockLlm({
  handler: (kind, prompt) => {
    if (kind === 'classify') {
      const count = (prompt.match(/^#\d+$/gm) || []).length || 1;
      // 按每封邮件自身的内容判断，避免依赖批次大小
      const subjects = [];
      const re = /^主题：(.*)$/gm;
      let match;
      while ((match = re.exec(prompt)) !== null) subjects.push(match[1]);
      const items = Array.from({ length: count }, (_v, i) => {
        const subject = subjects[i] || '';
        const isNotice = /报表|通知|自动|无需回复/.test(subject) || /无需回复/.test(prompt) && count === 1 && /报表/.test(prompt);
        return {
          index: i + 1,
          type: isNotice ? 'notification' : 'action_required',
          priority: isNotice ? 'low' : 'high',
          needsReply: !isNotice,
          summary: isNotice ? '系统自动生成的月度报表通知。' : '客户要求本周五前确认合同附件二的付款条款。',
          actions: isNotice ? [] : ['核对付款条款', '本周五前回复确认'],
          language: 'zh',
          reason: isNotice ? '系统通知，标注无需回复。' : '对方给出明确截止时间并要求书面确认。',
        };
      });
      return JSON.stringify({ items });
    }
    if (kind === 'draft') {
      return JSON.stringify({
        subject: 'Re: 合同附件二付款条款确认',
        body: '李经理你好，\n\n收到。我确认合同附件二的付款条款按原方案执行，会在本周五前给出书面回复。\n\n如有调整我会提前同步。\n\n王磊',
        reason: '对方要求本周五前确认，直接给出明确答复并承诺书面回复。',
        notes: ['请确认付款比例是否仍为 30%/70%'],
        language: 'zh',
        confidence: 0.85,
      });
    }
    return JSON.stringify({ markdown: '## 一句话总结\n今天需要你确认合同付款条款。' });
  },
});

let activeConfig = configure({ imapPort: imap.port, smtpPort: smtp.port, llmBaseUrl: llm.baseUrl });
ensureDirs();
store.loadState({ force: true });
store.persistState({ prune: false });

/* -------------------------------------------------- 1. 解析与组装 */

await test('MIME 解析：中文主题、正文、附件识别', async () => {
  const parsed = await parseMessage(MAIL_A);
  assertEqual(parsed.subject, '合同附件二付款条款确认', '主题');
  assertIncludes(parsed.body, '本周五前确认', '正文');
  assertEqual(parsed.from.address, 'lijingli@client.com', '发件人');
  assertEqual(parsed.attachments.length, 1, '附件数量');
  assertEqual(parsed.attachments[0].filename, '合同附件二.pdf', '附件名');
});

await test('引用历史剥离与摘要生成', async () => {
  const parsed = await parseMessage(MAIL_A);
  const stripped = stripQuoted(`${parsed.body}\n\n> 这是引用的历史内容\n在 2026年1月1日 写道：\n旧内容`);
  assert(!stripped.includes('引用的历史内容'), '应剥离引用');
  assertIncludes(stripped, '本周五前确认', '应保留新内容');
  const snippet = makeSnippet(parsed.body, 60);
  assert(snippet.length <= 61, `摘要应被截断，实际 ${snippet.length}`);
});

await test('MIME 组装：中文主题编码 + 线程头正确', async () => {
  const raw = buildMime({
    from: { name: '王磊', address: 'bot@example.com' },
    to: 'lijingli@client.com',
    subject: ensureReplyPrefix('合同附件二付款条款确认'),
    text: '收到，本周五前回复。',
    inReplyTo: '<mail-a@client.com>',
    references: ['<mail-a@client.com>'],
    messageId: '<reply-1@example.com>',
  });
  const text = raw.toString('utf8');
  assertIncludes(text, 'Subject: =?UTF-8?B?', '主题应编码');
  assertIncludes(text, 'In-Reply-To: <mail-a@client.com>', '线程头');
  assertIncludes(text, 'References: <mail-a@client.com>', 'References');
  assertIncludes(text, 'Message-ID: <reply-1@example.com>', 'Message-ID');

  // 回环：自己组装的邮件能被自己解析
  const parsed = await parseMessage(raw);
  assertEqual(parsed.subject, 'Re: 合同附件二付款条款确认', '回环主题');
  assertIncludes(parsed.body, '本周五前回复', '回环正文');
  assertEqual(parsed.from.address, 'bot@example.com', '回环发件人');
  assertEqual(parsed.inReplyTo, '<mail-a@client.com>', '回环 In-Reply-To');
});

await test('HTML 备用正文生成', async () => {
  const html = textToHtml('第一段\n\n第二段');
  assertIncludes(html, '<p>第一段</p>', '段落 1');
  assertIncludes(html, '<p>第二段</p>', '段落 2');
});

/* -------------------------------------------------- 2. 大模型客户端 */

await test('大模型客户端：JSON 模式调用成功', async () => {
  const client = new LlmClient({ ...activeConfig.llm });
  const { data, model } = await client.completeJson({
    system: '测试',
    user: '请输出 JSON：{"items":[]}',
    label: '单测',
  });
  assert(data && typeof data === 'object', '应返回对象');
  assertEqual(model, 'mock-model', '模型名');
});

await test('大模型客户端：鉴权失败给出明确错误码', async () => {
  const client = new LlmClient({ ...activeConfig.llm, apiKey: 'wrong' });
  // 模拟服务默认接受任何 key，这里改为直连一个返回 401 的地址
  const http = await import('node:http');
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const bad = new LlmClient({ ...activeConfig.llm, baseUrl: `http://127.0.0.1:${server.address().port}` });
    let code = null;
    try {
      await bad.complete({ system: '', user: 'hi' });
    } catch (err) {
      code = err.code;
    }
    assertEqual(code, 'LLM_AUTH_FAILED', '错误码');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* -------------------------------------------------- 3. 分类与起草 */

const sampleMail = {
  folder: 'INBOX',
  uid: 102,
  messageId: '<mail-a@client.com>',
  subject: '合同附件二付款条款确认',
  from: { name: '李经理', address: 'lijingli@client.com' },
  to: [{ address: 'bot@example.com' }],
  cc: [],
  date: new Date().toISOString(),
  body: '请在本周五前确认合同附件二的付款条款。',
  attachments: [],
};

await test('分类：识别需回复与不需回复', async () => {
  const client = new LlmClient(activeConfig.llm);
  const notice = { ...sampleMail, uid: 101, subject: '系统通知：你的月度报表已生成', body: '报表已生成，无需回复。' };
  const results = await classifyMails({ mails: [sampleMail, notice], client, config: activeConfig });
  assertEqual(results.length, 2, '结果数量');
  assertEqual(results[0].needsReply, true, '第一封需回复');
  assertEqual(results[1].needsReply, false, '通知无需回复');
  assertEqual(results[1].type, 'notification', '通知类型');
});

await test('分类：模型返回非法 JSON 时降级不抛错', async () => {
  const client = new LlmClient(activeConfig.llm);
  const broken = { ...client, completeJson: async () => { throw new Error('boom'); } };
  const results = await classifyMails({ mails: [sampleMail], client: broken, config: activeConfig });
  assertEqual(results.length, 1, '仍应返回占位结果');
  assertEqual(results[0].failed, true, '标记失败');
  assertEqual(results[0].needsReply, false, '降级为不需回复');
});

await test('起草：返回主题/正文/待确认事项', async () => {
  const client = new LlmClient(activeConfig.llm);
  const draft = await draftReply({
    mail: sampleMail,
    classification: { type: 'action_required', priority: 'high', summary: '需确认付款条款' },
    context: [],
    client,
    config: activeConfig,
    instance: getInstance('test'),
  });
  assertIncludes(draft.subject, 'Re:', '主题前缀');
  assertIncludes(draft.body, '付款条款', '正文内容');
  assertEqual(draft.notes.length, 1, '待确认事项');
  assertEqual(draft.confidence, 0.85, '置信度');
});

/* -------------------------------------------------- 4. IMAP */

await test('IMAP：连接、列文件夹、定位草稿箱', async () => {
  const client = await connect(getInstance('test'));
  try {
    const drafts = await findDraftsMailbox(client);
    assertEqual(drafts, 'Drafts', '草稿箱路径');
  } finally {
    await safeLogout(client);
  }
});

await test('IMAP：按时间窗口拉取并读取原文', async () => {
  const client = await connect(getInstance('test'));
  try {
    const list = await fetchSince(getInstance('test'), {
      folder: 'INBOX',
      since: new Date(Date.now() - 24 * 3600_000),
      client,
    });
    assertEqual(list.length, 2, '拉取数量');
    assertEqual(list[0].uid, 101, '第一封 UID');
    assertIncludes(list[1].subject, '合同附件二', '第二封主题');
    const { fetchRawSourceWithin } = await import('../server/mail/imap.js');
    const raw = await fetchRawSourceWithin(client, 102);
    assert(raw && raw.length > 100, '应取到原文');
  } finally {
    await safeLogout(client);
  }
});

await test('IMAP：服务器丢 ENVELOPE 响应时，24 小时拉取一封都不能少', async () => {
  const { fetchSince: fetch } = await import('../server/mail/imap.js');

  // 造 40 封同一窗口内的邮件，并让模拟服务器复现真实缺陷：
  // 大批量 `UID FETCH ... ENVELOPE` 会**确定性丢响应且不报错**（每 4 封只回 1 封）。
  // 真实事故：最近 24 小时命中 46 封，ENVELOPE 只回 39 封，
  // 丢掉的那 7 封里有一封「直接发我 + 高优先级」的重要邮件，界面上完全看不出来。
  const messages = [];
  for (let i = 0; i < 40; i += 1) {
    const date = new Date(Date.now() - (40 - i) * 60_000);
    messages.push({
      uid: 5001 + i,
      raw: mocks.makeRawMail({
        subject: i === 7 ? '综调微服务接口失败率高的汇总' : `窗口内邮件 ${i}`,
        from: i === 7 ? { name: '金敏剑', address: 'jinminjian.sh@chinatelecom.com.cn' } : { name: '同事', address: `p${i}@client.com` },
        body: `第 ${i} 封正文`,
        date,
        messageId: `<win-${i}@client.com>`,
        to: { name: '张三', address: 'bot@example.com' },
      }),
      flags: [],
      internalDate: date.toUTCString(),
    });
  }
  const srv = await mocks.startMockImap({ messages, envelopeBug: true, envelopeBugKeep: 0.25 });
  try {
    const inst = {
      id: 'lossy2',
      imap: { host: '127.0.0.1', port: srv.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    };
    const list = await fetch(inst, { folder: 'INBOX', since: new Date(Date.now() - 24 * 3600_000), maxMessages: 200 });
    assertEqual(list.length, 40, `应一封不漏地拉到 40 封（实际 ${list.length}——说明又走回了会丢包的 ENVELOPE）`);
    assertEqual(list.meta.fetched, 40, 'meta.fetched 应为 40');
    const hit = list.find((m) => m.subject === '综调微服务接口失败率高的汇总');
    assert(hit, '被 ENVELOPE 丢掉的那封重要邮件必须出现');
    assertEqual(hit.from.address, 'jinminjian.sh@chinatelecom.com.cn', '发件人应解析正确');
    assert(hit.date, '发件时间不能为空（否则界面会显示「—」）');
    assertEqual(hit.to.some((a) => a.address === 'bot@example.com'), true, '收件人应解析正确');
    // 一封都不能是「无主题/无时间」的空壳
    const blank = list.filter((m) => !m.subject || m.subject === '(无主题)' || !m.date || !m.from);
    assertEqual(blank.length, 0, `不应出现主题/时间/发件人为空的邮件（实际 ${blank.length} 封）`);
  } finally {
    await srv.close();
  }
});

await test('IMAP：追加草稿到草稿箱', async () => {
  const client = await connect(getInstance('test'));
  try {
    const res = await appendToMailbox(client, 'Drafts', Buffer.from('Subject: t\r\n\r\nx'), ['\\Draft']);
    assert(res && res.path === 'Drafts', '返回路径');
    assertEqual(imap.store.appended.length, 1, '服务器收到 1 封');
    assert(imap.store.appended[0].flags.includes('\\Draft'), '带 \\Draft 标记');
  } finally {
    await safeLogout(client);
  }
});

/* -------------------------------------------------- 5. SMTP */

await test('SMTP：认证通过并能发信', async () => {
  await verifyTransport(getInstance('test'), { pool: false });
  const res = await sendMessage(getInstance('test'), {
    to: ['lijingli@client.com'],
    subject: 'Re: 测试',
    text: '你好，收到。',
  });
  assert(res.messageId, '应返回 messageId');
  assertEqual(smtp.received.length, 1, '服务器收到 1 封');
  assertEqual(smtp.received[0].to[0], 'lijingli@client.com', '收件人');
  assertIncludes(smtp.received[0].raw, 'Subject: =?UTF-8?B?', '主题编码');
});

await test('SMTP：认证失败给出中文提示', async () => {
  const badSmtp = await mocks.startMockSmtp({ failAuth: true });
  try {
    const inst = baseInstance({
      smtp: { host: '127.0.0.1', port: badSmtp.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    });
    let message = '';
    try {
      await verifyTransport(inst, { pool: false });
    } catch (err) {
      message = err.message;
    }
    assertIncludes(message, '认证被拒绝', '应提示认证失败');
  } finally {
    await badSmtp.close();
  }
});

/* -------------------------------------------------- 6. SMTP 认证故障处理 */

await test('SMTP：system busy 给出针对性指引而非泛泛的「授权码错」', async () => {
  const busySmtp = await mocks.startMockSmtp({
    rejectMethods: ['PLAIN', 'LOGIN'],
    authErrorText: '535 Error: authentication failed, system busy',
  });
  try {
    const inst = baseInstance({
      smtp: { host: '127.0.0.1', port: busySmtp.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    });
    let message = '';
    try {
      await verifyTransport(inst, { pool: false });
    } catch (err) {
      message = err.message;
    }
    assertIncludes(message, 'system busy', '应保留服务端原文');
    assertIncludes(message, '反复认证', '应指出反复认证这一常见原因');
    assertIncludes(message, '强制 AUTH LOGIN', '应给出可执行的下一步');
  } finally {
    await busySmtp.close();
  }
});

await test('SMTP：AUTH PLAIN 被拒时自动切换到 LOGIN 并发送成功', async () => {
  const onlyLogin = await mocks.startMockSmtp({
    rejectMethods: ['PLAIN'],
    authErrorText: '535 Error: authentication failed, system busy',
  });
  try {
    const inst = baseInstance({
      smtp: { host: '127.0.0.1', port: onlyLogin.port, secure: false, authUser: 'bot@example.com', authPass: 'secret', authMethod: 'auto' },
    });
    const raw =
      'From: bot@example.com\r\nTo: lijingli@client.com\r\nSubject: t\r\nDate: ' +
      new Date().toUTCString() +
      '\r\nMessage-ID: <auto-switch@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nbody\r\n';
    const res = await sendRaw(inst, raw, { envelope: { from: 'bot@example.com', to: ['lijingli@client.com'] } });
    assertEqual(onlyLogin.received.length, 1, '应最终发送成功');
    assertEqual(res.authMethod, 'LOGIN', '应自动切换到 LOGIN');
    assertEqual(res.switchedAuthMethod, true, '应标记发生了切换');
  } finally {
    await onlyLogin.close();
  }
});

await test('SMTP：连续发送复用同一连接，不重复认证', async () => {
  const counted = await mocks.startMockSmtp();
  try {
    const inst = baseInstance({
      smtp: { host: '127.0.0.1', port: counted.port, secure: false, authUser: 'bot@example.com', authPass: 'secret', authMethod: 'auto' },
    });
    const raw =
      'From: bot@example.com\r\nTo: lijingli@client.com\r\nSubject: t\r\nDate: ' +
      new Date().toUTCString() +
      '\r\nMessage-ID: <pool@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nbody\r\n';
    for (let i = 0; i < 3; i += 1) {
      await sendRaw(inst, raw);
    }
    assertEqual(counted.received.length, 3, '应发出 3 封');
    assertEqual(counted.authAttempts, 1, `3 封邮件应只认证 1 次，实际 ${counted.authAttempts} 次`);
  } finally {
    resetTransportPools();
    await counted.close();
  }
});


/* -------------------------------------------------- 10b. 收件人身份与「需要你关注」 */

await test('收件人：区分「直接发给我」与「抄送我」', async () => {
  const { classifyRecipient } = await import('../server/mail/recipient.js');
  const instance = getInstance('test');
  const base = { from: { address: 'a@client.com' } };

  const direct = classifyRecipient({ ...base, to: [{ address: 'bot@example.com' }], cc: [] }, instance);
  assertEqual(direct.kind, 'direct', '收件人是我 → direct');
  assertEqual(direct.isDirect, true, 'isDirect');

  const cc = classifyRecipient({ ...base, to: [{ address: 'other@client.com' }], cc: [{ address: 'bot@example.com' }] }, instance);
  assertEqual(cc.kind, 'cc', '仅抄送我 → cc');
  assertEqual(cc.isCcOnly, true, 'isCcOnly');
  assertEqual(cc.isDirect, false, '不应算直接发我');

  // 同时在 To 与 Cc 时按「直接发我」处理（我是主要收件人）
  const both = classifyRecipient({ ...base, to: [{ address: 'bot@example.com' }], cc: [{ address: 'bot@example.com' }] }, instance);
  assertEqual(both.kind, 'direct', '同时在 To 与 Cc → 按直接');

  // 自己发出的邮件不参与判断
  const self = classifyRecipient({ from: { address: 'bot@example.com' }, to: [{ address: 'a@client.com' }], cc: [] }, instance);
  assertEqual(self.kind, 'self', '自己发出的 → self');

  // 大小写不敏感
  const upper = classifyRecipient({ ...base, to: [{ address: 'BOT@Example.COM' }], cc: [] }, instance);
  assertEqual(upper.kind, 'direct', '大小写不敏感');
});

await test('分类：直接+高优先才需处理；抄送+高优先归入需关注', async () => {
  const { isCcAttention, isDirectAction } = await import('../server/mail/recipient.js');
  assertEqual(isDirectAction({ recipientKind: 'direct', priority: 'high', needsReply: true }), true, '直接+高+需回复 → 需处理');
  assertEqual(isDirectAction({ recipientKind: 'direct', priority: 'urgent', needsReply: true }), true, '直接+紧急 → 需处理');
  assertEqual(isDirectAction({ recipientKind: 'direct', priority: 'normal', needsReply: true }), false, '直接但普通优先级 → 不占待办');
  assertEqual(isDirectAction({ recipientKind: 'cc', priority: 'high', needsReply: true }), false, '抄送 → 不算需处理');
  // 兼容历史数据（早期记录没有 recipientKind）
  assertEqual(isDirectAction({ priority: 'high', needsReply: true }), true, '旧记录按直接处理，避免丢待办');

  assertEqual(isCcAttention({ recipientKind: 'cc', priority: 'high' }), true, '抄送+高 → 需关注');
  assertEqual(isCcAttention({ recipientKind: 'cc', priority: 'urgent' }), true, '抄送+紧急 → 需关注');
  assertEqual(isCcAttention({ recipientKind: 'cc', priority: 'normal' }), false, '抄送但普通 → 不进需关注');
  assertEqual(isCcAttention({ recipientKind: 'direct', priority: 'high' }), false, '直接发我不算需关注');
});

/* -------------------------------------------------- 7. 端到端：分析 → 起草 → 存草稿箱 */

let runResult = null;

await test('引擎：完整运行（分类 + 起草 + 写草稿箱 + 简报）', async () => {
  const before = imap.store.appended.length;
  runResult = await runScan({ instanceId: 'test', windowHours: 24, force: true, trigger: 'selftest' });
  assertEqual(runResult.analyzed, 2, '分析邮件数');
  assertEqual(runResult.needsReply, 1, '需回复数');
  assertEqual(runResult.drafts, 1, '起草数');
  assert(runResult.reportId, '应生成简报');

  const drafts = store.listDrafts({ instanceId: 'test' });
  assertEqual(drafts.length, 1, '本地草稿数');
  assertEqual(drafts[0].status, 'pending', '草稿状态');
  assertEqual(drafts[0].to, 'lijingli@client.com', '收件人');
  assertIncludes(drafts[0].subject, '付款条款', '主题');
  assert(drafts[0].mailbox?.uid != null, '应写入邮箱草稿箱');
  assertEqual(imap.store.appended.length, before + 1, '服务器新增 1 封草稿');

  const appended = imap.store.appended[imap.store.appended.length - 1];
  assertIncludes(appended.raw, 'In-Reply-To: <thread-root@client.com>', '草稿应透传来信的 In-Reply-To');
  assertIncludes(appended.raw, 'References: <thread-root@client.com> <mail-a@client.com>', '草稿 References 应包含整条链');
  const parsedDraft = await parseMessage(Buffer.from(appended.raw, 'utf8'));
  assertIncludes(parsedDraft.body, '付款条款', '草稿正文可解析');
  assertEqual(parsedDraft.from.address, 'bot@example.com', '草稿发件人');
});

await test('引擎：简报文件落盘且含结论', async () => {
  const report = store.getReport(runResult.reportId);
  assert(report && fs.existsSync(report.file), '简报文件应存在');
  const markdown = store.readReportFile(report.file);
  assertIncludes(markdown, '一句话总结', '简报结构');
  assertIncludes(markdown, '付款条款', '简报内容');
});

await test('总览：统计口径与待处理清单正确', async () => {
  const overview = buildOverview({ instanceId: 'test' });
  assertEqual(overview.stats.total, 2, '邮件总数');
  assertEqual(overview.stats.needsReply, 1, '需回复');
  assertEqual(overview.stats.drafts.pending, 1, '待审核草稿');
  assertEqual(overview.needAction.length, 1, '待处理清单');
  assertEqual(overview.needAction[0].hasDraft, true, '已关联草稿');
  assertEqual(overview.priorityList[0].priority, 'high', '按优先级排序');
});

await test('总览：priorityList 与 needAction 结构一致（否则「值得知悉」会显示成无主题）', async () => {
  const overview = buildOverview({ instanceId: 'test' });
  assert(overview.priorityList.length >= 2, '应有完整优先级清单');

  // 「值得知悉」直接消费 priorityList。原始分析记录把主题/发件人/时间放在 mail 里，
  // 而列表项把它们提到顶层——两者结构不一致时，界面就会整列显示「(无主题) + 发件人为空 + 时间 —」。
  for (const item of overview.priorityList) {
    assert(item.subject, `${item.key} 顶层应有 subject`);
    assert(item.from && (item.from.name || item.from.address), `${item.key} 顶层应有 from`);
    assert(item.date, `${item.key} 顶层应有 date`);
    assert('hasDraft' in item, `${item.key} 应带 hasDraft`);
    assert('draftStatus' in item, `${item.key} 应带 draftStatus`);
  }
  const needKeys = overview.needAction.map((i) => i.key);
  for (const key of needKeys) {
    const same = overview.priorityList.find((i) => i.key === key);
    assert(same, `${key} 应同时出现在 priorityList`);
    assertEqual(same.subject, overview.needAction.find((i) => i.key === key).subject, '两处结构应一致');
  }
});

await test('知识库：主题归类、时间线索与联系人聚合', async () => {
  const kb = buildKnowledge({ instanceId: 'test' });
  assertEqual(kb.keyFacts.total, 2, '条目数');
  assert(kb.entries.some((e) => e.deadlines.length > 0), '应抽出时间线索');
  assert(kb.people.some((p) => p.address === 'lijingli@client.com'), '联系人聚合');
  assert(kb.topics.some((t) => t.id === 'client'), '应命中「客户/商务」主题');
});

/* -------------------------------------------------- 7. 发送（人工确认） */

await test('发送：缺少 confirm 时拒绝', async () => {
  const draft = store.listDrafts({ instanceId: 'test' })[0];
  let code = null;
  try {
    await sendDraft(draft.id, { confirm: false });
  } catch (err) {
    code = err.code;
  }
  assertEqual(code, 'CONFIRM_REQUIRED', '错误码');
});

await test('发送：确认后发出、更新状态、清理草稿箱副本', async () => {
  const draft = store.listDrafts({ instanceId: 'test' })[0];
  updateDraft(draft.id, { body: `${draft.body}\n（人工修改过的正文）` });
  const before = smtp.received.length;
  const out = await sendDraft(draft.id, { confirm: true, deleteMailboxDraft: true, appendToSent: true });
  assertEqual(smtp.received.length, before + 1, 'SMTP 收到 1 封');
  const sent = smtp.received[smtp.received.length - 1];
  assertEqual(sent.to[0], 'lijingli@client.com', '收件人');
  assertIncludes(sent.raw, 'In-Reply-To: <thread-root@client.com>', '线程头');
  // 正文含中文会被 base64 编码，断言前先解析
  const sentParsed = await parseMessage(Buffer.from(sent.raw, 'utf8'));
  if (process.env.SELFTEST_VERBOSE) {
    console.log('   [debug] raw full =', JSON.stringify(sent.raw));
    console.log('   [debug] parsed =', JSON.stringify(sentParsed).slice(0, 600));
  }
  assertIncludes(sentParsed.body, '（人工修改过的正文）', '应发送人工修改后的正文');
  assertIncludes(sentParsed.body, '付款条款', '应保留原草稿内容');
  const updated = store.getDraft(draft.id);
  assertEqual(updated.status, 'sent', '状态应为已发送');
  assert(updated.sentAt, '应有发送时间');
  assert(out.result.notes.some((n) => n.includes('归档') || n.includes('已从服务器草稿箱')), '应有发送后处理说明');

  // 发信是不可撤回的写操作，必须留下台账（含收件人与主题）
  const { listAudit } = await import('../server/store/audit.js');
  const audit = listAudit({ action: 'draft.send' });
  assert(audit.items.length >= 1, '发送后应有 draft.send 台账');
  const rec = audit.items[0];
  assertEqual(rec.group, '邮件', '应归到邮件组');
  assertEqual(rec.ok, true, '成功应标记 ok');
  assertEqual(rec.target, updated.subject, '台账要记下邮件主题');
  assertIncludes(rec.extra.to, 'lijingli@client.com', '台账要能查到收件人');
});

await test('发送：重复发送被拒绝', async () => {
  const draft = store.listDrafts({ instanceId: 'test' })[0];
  let code = null;
  try {
    await sendDraft(draft.id, { confirm: true });
  } catch (err) {
    code = err.code;
  }
  assertEqual(code, 'DRAFT_ALREADY_SENT', '错误码');
});

await test('发送策略 draft_only 时全局禁用', async () => {
  const config = getConfig();
  config.draft.sendPolicy = 'draft_only';
  const draft = store.listDrafts({ instanceId: 'test' })[0];
  let code = null;
  try {
    await sendDraft(draft.id, { confirm: true });
  } catch (err) {
    code = err.code;
  }
  config.draft.sendPolicy = 'confirm';
  assertEqual(code, 'SEND_DISABLED', '错误码');
});

/* -------------------------------------------------- 8. 自检与配置 */

await test('自检：真实模拟服务下全部通过', async () => {
  const result = await runDiagnostics({ instanceId: 'test', deep: true });
  const failed = result.checks.filter((c) => c.status === 'error');
  assertEqual(failed.length, 0, `不应有失败项：${failed.map((f) => `${f.label}:${f.message}`).join('; ')}`);
  assert(result.ok, '整体应为通过');
});

await test('自检：配置缺失时给出可读问题清单', async () => {
  const config = getConfig();
  const backup = JSON.parse(JSON.stringify(config.instances[0]));
  config.instances[0].imap.host = '';
  config.instances[0].imap.authPass = '';
  config.instances[0].smtp.host = '';
  const result = await runDiagnostics({ instanceId: 'test', deep: false });
  config.instances[0] = backup;
  const configCheck = result.checks.find((c) => c.id === 'config');
  assertEqual(configCheck.status, 'error', '配置检查应失败');
  assertIncludes(configCheck.message, 'IMAP 服务器地址为空', '问题清单');
});

await test('配置：授权码脱敏且掩码值不会被覆盖', async () => {
  const masked = maskConfig(getConfig());
  assertEqual(masked.instances[0].imap.authPass, '***', 'IMAP 授权码应脱敏');
  assertEqual(masked.instances[0].smtp.authPass, '***', 'SMTP 授权码应脱敏');
  assertEqual(masked.llm.apiKey, '***', 'API Key 应脱敏');
  const json = JSON.stringify(masked);
  assert(!json.includes('secret'), '输出中不应出现真实授权码');
});

await test('配置：保存到磁盘后掩码回传不破坏原密钥', async () => {
  const before = getConfig().instances[0].imap.authPass;
  const masked = maskConfig(getConfig());
  masked.scan.windowHours = 12;
  const saved = saveConfig(masked);
  assertEqual(saved.scan.windowHours, 12, '窗口时间应更新');
  assertEqual(saved.instances[0].imap.authPass, before, '授权码应保留');
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assertEqual(onDisk.instances[0].imap.authPass, before, '磁盘上应仍是真实值');
  saveConfig({ scan: { windowHours: 24 } });
});

/* -------------------------------------------------- 9. HTTP 服务 */

await test('HTTP：服务启动、鉴权、总览与设置接口', async () => {
  const { url, stop } = await startTestServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const token = getConfig().web.authToken;
  const auth = { 'x-mailbot-token': token };
  try {
    const unauth = await fetch(`${url}/api/overview`);
    assertEqual(unauth.status, 401, '无令牌应 401');

    const meta = await (await fetchJson(`${url}/api/meta`, { headers: auth })).body;
    assert(meta.ok, 'meta.ok');
    assert(Array.isArray(meta.presets) && meta.presets.length > 0, '应返回服务商预设');

    const overview = await (await fetchJson(`${url}/api/overview`, { headers: auth })).body;
    assertEqual(overview.stats.total, 2, '总览邮件数');

    const cfg = await (await fetchJson(`${url}/api/config`, { headers: auth })).body;
    assertEqual(cfg.config.instances[0].imap.authPass, '***', '配置接口应脱敏');

    const page = await fetchJson(`${url}/`);
    assertEqual(page.status, 200, '首页可访问');
    assertIncludes(page.body.raw, '邮箱与日历数字人', '首页内容');
    const css = await fetch(`${url}/styles.css`);
    assertEqual(css.status, 200, '样式表可访问');

    const notFound = await (await fetchJson(`${url}/api/nope`, { headers: auth })).body;
    assertEqual(notFound.code, 'NOT_FOUND', '未知接口 404');

    const sendGuard = await fetch(`${url}/api/drafts/draft_x/send`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assertEqual(sendGuard.status, 428, '无 confirm 应 428');

    // 品牌标志必须能被静态服务取到（否则右上角会是破图）
    const logo = await fetch(`${url}/assets/logo.png`);
    assertEqual(logo.status, 200, 'Logo 可访问');
    assertIncludes(logo.headers.get('content-type'), 'image/png', 'Logo MIME 类型');
    const logoBytes = Buffer.from(await logo.arrayBuffer());
    assert(logoBytes.length > 1000, 'Logo 不应为空文件');
    // PNG magic number：\x89PNG
    assertEqual(logoBytes.subarray(1, 4).toString('ascii'), 'PNG', 'Logo 应是合法 PNG');
  } finally {
    await stop();
  }
});

await test('详情：单封邮件详情不受 24 小时窗口限制，缺记录时也有出路', async () => {
  const { buildMailDetail } = await import('../server/ai/insight.js');
  const { url, stop } = await startTestServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const token = getConfig().web.authToken;
  const auth = { 'x-mailbot-token': token };
  try {
    // 1) 有分析记录 → 返回完整分析（这封是本地已分析的邮件）
    const analysed = store.listAnalyses({ instanceId: 'test', limit: 5 })[0];
    assert(analysed, '前置条件：应有已分析的邮件');
    const ok = await (await fetch(`${url}/api/mails/${encodeURIComponent(analysed.folder)}/${analysed.uid}`, { headers: auth })).json();
    assertEqual(ok.found, true, '应找到');
    assertEqual(ok.analyzed, true, '应标记为已分析');
    assertEqual(ok.analysis.key, analysed.key, '应返回对应分析记录');
    assertIncludes(ok.analysis.typeLabel, '', '应带中文类型标签');
    assert(ok.mail && ok.mail.subject, '应带邮件主题');

    // 2) 没有分析记录、但本地有归档原文 → 解析出主题/正文，而不是「未找到」
    const withRaw = store.listAnalyses({ instanceId: 'test', limit: 5 }).find((r) => store.findRaw(r.folder, r.uid));
    assert(withRaw, '前置条件：应有归档原文');
    store.getState().analyses[`${withRaw.folder}:${withRaw.uid}`] = undefined;
    delete store.getState().analyses[`${withRaw.folder}:${withRaw.uid}`];
    const viaRaw = await buildMailDetail({ folder: withRaw.folder, uid: withRaw.uid, instanceId: 'test' });
    assertEqual(viaRaw.analyzed, false, '应标记为未分析');
    assertEqual(viaRaw.found, true, '有原文时也应算「找得到」');
    assertIncludes(viaRaw.mail.subject || '', '', '应从原文解析出主题');
    assert(viaRaw.rawExcerpt, '应给出正文摘录');
    assertIncludes(viaRaw.note, '还没有做过 AI 分析', '应说明为什么没有分析结论');

    // 3) 既无分析记录也无原文 → found:false，但接口本身仍是 200（不是 404 报错）
    const empty = await (await fetch(`${url}/api/mails/INBOX/999999`, { headers: auth })).json();
    assertEqual(empty.found, false, '应明确返回未找到');
    assertIncludes(empty.note, '立即分析这一封', '应给出可执行的下一步');

    // 4) 没有分析记录的邮件可以就地分析（scope 运行）
    const run = await runScan({ instanceId: 'test', windowHours: 24, force: true, trigger: 'single', scope: { folder: withRaw.folder, uid: withRaw.uid } });
    assertEqual(run.analyzed, 1, '应按 scope 只分析这一封');
    const again = await (await fetch(`${url}/api/mails/${encodeURIComponent(withRaw.folder)}/${withRaw.uid}`, { headers: auth })).json();
    assertEqual(again.analyzed, true, '重新分析后应能取到分析结论');

    // 5) 路径里的非法 UID 不应被当成详情请求
    const bad = await fetch(`${url}/api/mails/INBOX/abc`, { headers: auth });
    assertEqual(bad.status, 404, '非数字 UID 应落到 404');
  } finally {
    await stop();
  }
});

await test('HTTP：SSE 进度通道可建立', async () => {
  const { url, stop } = await startTestServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const token = getConfig().web.authToken;
  const controller = new AbortController();
  try {
    const res = await fetch(`${url}/api/events?token=${encodeURIComponent(token)}`, { signal: controller.signal });
    assertEqual(res.status, 200, 'SSE 状态码');
    assertIncludes(res.headers.get('content-type'), 'text/event-stream', 'SSE 类型');
    const reader = res.body.getReader();
    const { value } = await reader.read();
    assertIncludes(Buffer.from(value).toString('utf8'), 'retry:', 'SSE 首包');
    controller.abort();
  } finally {
    controller.abort();
    await stop();
  }
});

await test('总览：需处理与需关注两套口径互不重叠', async () => {
  // 注意：本用例会触发一次分析（产生草稿），必须放在「引擎完整性」用例之后，
  // 否则会改变 imap.store.appended 的数量导致后续断言失真。
  const runs = await runScan({ instanceId: 'test', windowHours: 24, force: true, trigger: 'selftest-attention' });
  assert(runs.analyzed >= 1, '应完成分析');
  const d = buildOverview({ instanceId: 'test' });
  assertEqual(typeof d.stats.attention, 'number', 'stats 应包含 attention');
  assert(Array.isArray(d.attention), 'overview 应返回 attention 列表');
  // 同一封邮件不能同时出现在两个列表里
  const needKeys = new Set(d.needAction.map((i) => i.key));
  for (const item of d.attention) {
    assert(!needKeys.has(item.key), `${item.key} 不应同时出现在需处理与需关注`);
    assertEqual(item.recipientKind, 'cc', '需关注的条目应标记为抄送');
  }
  for (const item of d.needAction) {
    assertEqual(item.recipientKind, 'direct', '需处理的条目应标记为直接发我');
    assert(['urgent', 'high'].includes(item.priority), '需处理应只含高优先级');
  }
});
/* -------------------------------------------------- 10. 签名 */

const TEST_SIGNATURE = '张三 | 示例事业部\n移动电话：13900000000\n安全提示：\n1) 公司不会通过邮件索要密码或验证码';

await test('签名：追加 / 幂等 / 剥离', async () => {
  const { appendSignature, stripSignature, normalizeSignature } = await import('../server/mail/signature.js');
  assertEqual(normalizeSignature('  a  \n\n\n  b  '), 'a\n\nb', '应清理多余空行与尾随空格');

  const once = appendSignature('您好，收到。', TEST_SIGNATURE);
  assertIncludes(once, '您好，收到。', '应保留正文');
  assert(once.endsWith(TEST_SIGNATURE), '正文末尾应是签名');
  assertIncludes(once, '\n\n张三 | 示例事业部', '正文与签名之间应空一行');

  assertEqual(appendSignature(once, TEST_SIGNATURE), once, '重复追加应幂等');
  assertEqual(stripSignature(once, TEST_SIGNATURE), '您好，收到。', '应能剥离签名');
  assertEqual(appendSignature('', TEST_SIGNATURE), TEST_SIGNATURE, '正文为空时只留签名');
  assertEqual(appendSignature('正文', ''), '正文', '未配置签名时原样返回');
});

await test('签名：起草后自动带上且只出现一次', async () => {
  const config = getConfig();
  const backup = config.draft.signature;
  config.draft.signature = TEST_SIGNATURE;
  try {
    const client = new LlmClient(activeConfig.llm);
    const draft = await draftReply({
      mail: sampleMail,
      classification: { type: 'action_required', priority: 'high', summary: '需确认付款条款' },
      context: [],
      client,
      config,
      instance: getInstance('test'),
    });
    assert(draft.signatureApplied, '应标记已追加签名');
    assertEqual(draft.body.split('13900000000').length - 1, 1, '电话号码应只出现一次');
    assertEqual(draft.body.split(TEST_SIGNATURE).length - 1, 1, '签名块应只出现一次');
    // 顺序：新正文 → 签名 → 引文。签名后面必须只剩引文（或什么都没有）
    const afterSignature = draft.body.slice(draft.body.indexOf(TEST_SIGNATURE) + TEST_SIGNATURE.length).trim();
    if (afterSignature) assertIncludes(afterSignature, '原始邮件', '签名之后只应跟着引文');
  } finally {
    config.draft.signature = backup;
  }
});

await test('签名：草稿箱与发信内容都含签名且不重复', async () => {
  const config = getConfig();
  const backup = config.draft.signature;
  config.draft.signature = TEST_SIGNATURE;
  try {
    // 前面的用例已经把这封草稿发出去了，而引擎不会再为「已有草稿」的邮件起草
    // （见下面的「重复分析」用例）。这里先把本地草稿清掉，模拟「草稿被删除后再分析」，
    // 引擎就会按当前签名重新起草一封。
    for (const d of store.listDrafts({ instanceId: 'test' })) store.removeDraft(d.id);
    const appendedBefore = imap.store.appended.length;
    const reRun = await runScan({ instanceId: 'test', windowHours: 24, force: true, trigger: 'selftest-signature' });
    assertEqual(reRun.drafts, 1, '草稿删除后应重新起草 1 封');
    assertEqual(reRun.skippedDrafts, 0, '没有存量草稿时不应有跳过');
    const all = store.listDrafts({ instanceId: 'test' });
    const pending = all.filter((d) => d.status === 'pending');
    // 同一封邮件重复分析应覆盖同一 id，而不是产生重复记录
    assertEqual(new Set(all.map((d) => d.id)).size, all.length, '不应存在重复 id 的草稿');
    const newDraft = pending[pending.length - 1];
    assert(newDraft, '应生成新草稿');
    assertEqual(newDraft.body.split(TEST_SIGNATURE).length - 1, 1, '草稿里签名只出现一次');
    // 顺序约束：签名之后只能跟引文，不能把签名挤到引文后面
    const after = newDraft.body.slice(newDraft.body.indexOf(TEST_SIGNATURE) + TEST_SIGNATURE.length).trim();
    if (after) assertIncludes(after, '原始邮件', '签名之后只应跟着引文');

    const appended = imap.store.appended[imap.store.appended.length - 1];
    const parsedDraft = await parseMessage(Buffer.from(appended.raw, 'utf8'));
    assertIncludes(parsedDraft.body, '13900000000', '写入草稿箱的 MIME 应含签名');
    assertEqual(parsedDraft.body.split(TEST_SIGNATURE).length - 1, 1, '草稿箱里签名只出现一次');
    assertEqual(imap.store.appended.length, appendedBefore + 1, '草稿箱只新增 1 封');

    const beforeSend = smtp.received.length;
    await sendDraft(newDraft.id, { confirm: true, deleteMailboxDraft: false, appendToSent: false });
    const sent = await parseMessage(Buffer.from(smtp.received[beforeSend].raw, 'utf8'));
    assertIncludes(sent.body, '13900000000', '发信内容应含签名');
    assertEqual(sent.body.split(TEST_SIGNATURE).length - 1, 1, '发信内容里签名只出现一次');
  } finally {
    config.draft.signature = backup;
  }
});

await test('引擎：已发送的邮件重复分析不会再生成待审核草稿', async () => {
  const config = getConfig();
  const draftsBefore = store.listDrafts({ instanceId: 'test' });
  assert(draftsBefore.length > 0, '前置条件：应已有草稿');
  // 造出「已发送」的草稿（上一用例已发送其一，这里确保至少一封是已发送）
  const target = draftsBefore[0];
  if (target.status !== 'sent') await sendDraft(target.id, { confirm: true, deleteMailboxDraft: true, appendToSent: false });

  const before = store.listDrafts({ instanceId: 'test' });
  const sentBefore = before.filter((d) => d.status === 'sent').length;
  assert(sentBefore > 0, '前置条件：应有一封已发送草稿');

  const result = await runScan({ instanceId: 'test', windowHours: 24, force: true, trigger: 'selftest-redraft' });
  assertEqual(result.drafts, 0, '已有草稿的邮件不应再起草');
  assertEqual(result.skippedDrafts, 1, '应报告跳过 1 封已有草稿的邮件');

  const after = store.listDrafts({ instanceId: 'test' });
  assertEqual(after.length, before.length, '草稿总数不应变化');
  assertEqual(after.filter((d) => d.status === 'sent').length, sentBefore, '已发送草稿不能被降级回待审核');
  assertEqual(after.filter((d) => d.status === 'pending').length, 0, '不应出现新的待审核草稿');
  const keptSent = after.find((d) => d.id === target.id);
  assertEqual(keptSent.status, 'sent', '已发送状态应保留');
  assert(keptSent.sentAt, '发送时间应保留');

  // 总览必须据此把按钮语义标成「已发送」，而不是继续显示「查看草稿」
  const overview = buildOverview({ instanceId: 'test' });
  const item = overview.needAction.find((i) => i.key === `${keptSent.source.folder}:${keptSent.source.uid}`);
  assert(item, '总览里应能找到这封邮件');
  assertEqual(item.hasDraft, true, '应关联到草稿');
  assertEqual(item.draftStatus, 'sent', '草稿状态应为已发送');
  assertEqual(item.draftId, keptSent.id, '应带上草稿 id');
  // 简报与统计也要如实反映「跳过」
  assertEqual(overview.stats.drafts.sent >= 1, true, '统计里应有已发送草稿');
});

await test('签名：可为存量草稿补签名，不重复、不动已发送', async () => {
  const { applySignatureToDrafts } = await import('../server/mail/signature-ops.js');
  const { upgradeLegacySignature } = await import('../server/mail/signature.js');
  const config = getConfig();
  const backup = config.draft.signature;
  config.draft.signature = TEST_SIGNATURE;
  try {
    store.addDraft({
      id: 'draft_legacy_1',
      instanceId: 'test',
      status: 'pending',
      to: 'a@b.com',
      subject: 'Re: 旧草稿',
      body: '旧的正文，末尾只有姓名。\n\n顺祝工作顺利。\n\n张三',
      source: { folder: 'INBOX', uid: 999, subject: '旧草稿' },
      createdAt: new Date().toISOString(),
    });
    store.addDraft({
      id: 'draft_legacy_2',
      instanceId: 'test',
      status: 'sent',
      to: 'a@b.com',
      subject: 'Re: 已发送',
      body: '已发送的正文\n\n张三',
      source: { folder: 'INBOX', uid: 998, subject: '已发送' },
      createdAt: new Date().toISOString(),
    });

    const out = applySignatureToDrafts({ ids: ['draft_legacy_1', 'draft_legacy_2'] });
    assertEqual(out.applied.length, 1, '应只处理未发送的那封');
    assertEqual(out.applied[0].id, 'draft_legacy_1', '应处理 pending 草稿');
    assertEqual(out.applied[0].mode, 'replaced', '旧姓名行应被替换而不是追加');

    const patched = store.getDraft('draft_legacy_1');
    assert(patched.body.endsWith(TEST_SIGNATURE), '应已补上签名');
    assertEqual(patched.body.split(TEST_SIGNATURE).length - 1, 1, '签名只出现一次');
    assertIncludes(patched.body, '末尾只有姓名', '原有正文应保留');
    assertIncludes(patched.body, '顺祝工作顺利。', '礼貌收尾应保留');
    assert(!/\n张三$/.test(patched.body.replace(TEST_SIGNATURE, '')), '不应残留孤立的旧姓名行');
    assertEqual(patched.body.split('张三').length - 1, 1, '「张三」应只出现一次');

    const again = applySignatureToDrafts({ ids: ['draft_legacy_1'] });
    assertEqual(again.applied.length, 0, '第二次应跳过');
    assertEqual(again.skipped[0].reason, '已包含当前签名', '应说明跳过原因');

    // 旧姓名识别：不同姓名不应被误替换
    const other = upgradeLegacySignature('正文\n\n李四', TEST_SIGNATURE, '张三');
    assertEqual(other.replaced, false, '非发件人姓名不应被替换');
    const quoted = upgradeLegacySignature(`正文\n\n${TEST_SIGNATURE}`, TEST_SIGNATURE, '张三');
    assertEqual(quoted.replaced, false, '已含签名时不应替换');

    let code = null;
    try {
      config.draft.signature = '';
      applySignatureToDrafts({ ids: ['draft_legacy_1'] });
    } catch (err) {
      code = err.code;
    }
    assertEqual(code, 'SIGNATURE_NOT_CONFIGURED', '未配置签名时应报错');

    for (const id of ['draft_legacy_1', 'draft_legacy_2']) store.removeDraft(id);
    store.persistState();
  } finally {
    config.draft.signature = backup;
  }
});

/* -------------------------------------------------- 11. 回复引文与详情原文 */

await test('引文：中文客户端风格 / > 前缀风格 / 不引"引用历史" / 长度上限', async () => {
  const { buildQuoteBlock } = await import('../server/mail/quote.js');
  const mail = {
    subject: '转发: 集团IT需求',
    from: { name: '李心怡', address: 'lixy167@chinatelecom.cn' },
    to: [{ name: '我', address: 'me@company.com' }],
    cc: [{ address: 'cc@company.com' }],
    date: '2026-09-30T08:52:00.000Z',
  };
  const args = { mail, body: '原始内容第一行\n第二行', timeZone: 'Asia/Shanghai' };

  const zh = buildQuoteBlock(args);
  assertIncludes(zh, '------------------ 原始邮件 ------------------', '应有中文客户端分隔线');
  assertIncludes(zh, '发件人: 李心怡 <lixy167@chinatelecom.cn>', '应带发件人');
  assertIncludes(zh, '发送时间: 2026-09-30 16:52', '时间应按配置时区显示为北京时间');
  assertIncludes(zh, '收件人: 我 <me@company.com>', '应带收件人');
  assertIncludes(zh, '抄送: cc@company.com', '应带抄送');
  assertIncludes(zh, '主题: 转发: 集团IT需求', '应带主题');
  assertIncludes(zh, '原始内容第一行', '应带原文');

  const prefix = buildQuoteBlock({ ...args, style: 'prefix' });
  assertIncludes(prefix, '写道：', '应为「在…写道：」式');
  assertIncludes(prefix, '> 原始内容第一行', '原文每行应加 > 前缀');
  assertIncludes(prefix, '> 第二行', '第二行也要加前缀');
  assert(!prefix.includes('原始邮件 ------'), '前缀风格不应带中文分隔线');

  // 引用历史不重复引用：否则来回几次会把正文堆成几千行
  const nested = buildQuoteBlock({ mail, body: '最新内容\n\n> 更早的引用\n> 再早的引用' });
  assertIncludes(nested, '最新内容');
  assert(!nested.includes('更早的引用'), '不应把引用历史再引用一遍');

  const clipped = buildQuoteBlock({ mail, body: 'x'.repeat(500), maxChars: 100 });
  assertIncludes(clipped, '省略 400 字', '超长引文应截断并标注');
});

await test('引文：幂等、顺序（签名在引文之上）、可关闭、无原文不造空引文', async () => {
  const { appendQuote, attachQuote, hasQuote } = await import('../server/mail/quote.js');
  const mail = { subject: 'S', from: { address: 'a@b.com' }, date: '2026-09-30T00:00:00.000Z' };
  const config = { draft: { quoteOriginal: true, quoteStyle: 'zh-client', quoteMaxChars: 2000 }, calendar: { timeZone: 'Asia/Shanghai' } };

  const signed = '回复正文\n\n张三 | 示例事业部';
  assertEqual(hasQuote(signed), false, '还没引文时应为 false');

  const on = attachQuote({ body: signed, mail, originalBody: '对方原话', config });
  assertEqual(on.quoted, true, '应标记已带引文');
  assertIncludes(on.body, '对方原话');
  assert(on.body.indexOf('张三 | 示例事业部') < on.body.indexOf('原始邮件'), '签名必须在引文之上（邮件礼仪，也保证签名幂等）');

  // 幂等：用户的正文里已经有引文时不能再追加一份
  const twice = appendQuote(on.body, '------------------ 原始邮件 ------------------\n重复', 'zh-client');
  assertEqual(twice.split('------------------ 原始邮件 ------------------').length - 1, 1, '引文只应有一份');
  assertEqual(twice.trimEnd(), on.body.trimEnd(), '重复追加不应改动正文');

  const off = attachQuote({ body: signed, mail, originalBody: '对方原话', config: { draft: { quoteOriginal: false } } });
  assertEqual(off.quoted, false, '关闭引文时不应追加');
  assertEqual(off.body, signed, '关闭引文时正文应原样返回');

  const empty = attachQuote({ body: signed, mail, originalBody: '', config });
  assertEqual(empty.quoted, false, '没有原文时不应造一个空引文块');
});

await test('引文：引擎起草的草稿与草稿箱副本都带原文，且顺序正确', async () => {
  const config = getConfig();
  const backup = { signature: config.draft.signature, quoteOriginal: config.draft.quoteOriginal, quoteStyle: config.draft.quoteStyle };
  config.draft.signature = TEST_SIGNATURE;
  config.draft.quoteOriginal = true;
  config.draft.quoteStyle = 'zh-client';
  try {
    // 清掉历史草稿，让引擎重新起草一封
    for (const d of store.listDrafts({ instanceId: 'test' })) store.removeDraft(d.id);
    const appendedBefore = imap.store.appended.length;
    const run = await runScan({ instanceId: 'test', windowHours: 24, force: true, trigger: 'selftest-quote' });
    assertEqual(run.drafts, 1, '应重新起草 1 封');

    const draft = store.listDrafts({ instanceId: 'test' }).find((d) => d.status === 'pending');
    assert(draft, '应有待审核草稿');
    assertEqual(draft.quoted, true, '草稿应标记已带引文');
    assertIncludes(draft.body, '------------------ 原始邮件 ------------------', '正文应含引文分隔线');
    assertIncludes(draft.body, '发件人:', '引文应带发件人');
    const iSign = draft.body.indexOf(TEST_SIGNATURE);
    const iQuote = draft.body.indexOf('------------------ 原始邮件');
    assert(iSign > 0 && iQuote > 0, '签名与引文都应存在');
    assert(iSign < iQuote, '顺序必须是：新正文 → 签名 → 引文');
    assertEqual(draft.body.split('------------------ 原始邮件 ------------------').length - 1, 1, '引文只应出现一次');
    assertEqual(draft.body.split(TEST_SIGNATURE).length - 1, 1, '签名只应出现一次');

    // 落到邮箱草稿箱的那一份也必须是带引文的完整版本
    assertEqual(imap.store.appended.length, appendedBefore + 1, '草稿箱应新增 1 封');
    const parsed = await parseMessage(Buffer.from(imap.store.appended[imap.store.appended.length - 1].raw, 'utf8'));
    assertIncludes(parsed.body, '------------------ 原始邮件 ------------------', '草稿箱里的 MIME 也应含引文');
    assert(parsed.body.indexOf(TEST_SIGNATURE) < parsed.body.indexOf('------------------ 原始邮件'), '草稿箱里的顺序也应正确');

    // 「插入原文」对已带引文的草稿应跳过
    const { applyQuoteToDrafts } = await import('../server/mail/quote-ops.js');
    const again = await applyQuoteToDrafts({ instanceId: 'test' });
    assertEqual(again.applied.length, 0, '已带引文时不应重复插入');
    assertEqual(again.skipped[0].reason, '已包含引文', '应说明跳过原因');

    // 把引文剥掉后，一键补回
    store.updateDraft(draft.id, { body: `回复正文\n\n${TEST_SIGNATURE}`, quoted: false });
    const applied = await applyQuoteToDrafts({ instanceId: 'test' });
    assertEqual(applied.applied.length, 1, '应补上引文');
    const fixed = store.getDraft(draft.id);
    assertEqual(fixed.quoted, true, '应标记已带引文');
    assertIncludes(fixed.body, '原始邮件', '应含引文');
    assert(fixed.body.indexOf(TEST_SIGNATURE) < fixed.body.indexOf('------------------ 原始邮件'), '补引文后签名仍应在引文之上');
    assertEqual(fixed.body.split(TEST_SIGNATURE).length - 1, 1, '补引文不应让签名重复');

    // 已发送的草稿绝不能被改
    store.updateDraft(draft.id, { status: 'sent', sentAt: new Date().toISOString() });
    const afterSent = await applyQuoteToDrafts({ instanceId: 'test' });
    assertEqual(afterSent.total, 0, '已发送的草稿不应进入处理范围');
  } finally {
    config.draft.signature = backup.signature;
    config.draft.quoteOriginal = backup.quoteOriginal;
    config.draft.quoteStyle = backup.quoteStyle;
  }
});

await test('详情：返回原始正文全文（归档优先）+ 引用历史单独给出', async () => {
  const { loadMailBody, buildMailDetail } = await import('../server/ai/insight.js');
  const record = store.listAnalyses({ instanceId: 'test', limit: 10 }).find((r) => store.findRaw(r.folder, r.uid));
  assert(record, '前置条件：应有归档原文');

  const body = await loadMailBody({ folder: record.folder, uid: record.uid, instanceId: 'test' });
  assertEqual(body.available, true, '应能取到原文');
  assertEqual(body.source, 'archive', '应优先用本地归档');
  assert(body.text && body.text.length > 5, '应有正文');
  assert(body.subject, '应带主题');
  assert(body.from?.address, '应带发件人');
  assert(body.date, '应带时间');
  assertEqual(body.truncated, false, '短邮件不应截断');

  const detail = await buildMailDetail({ folder: record.folder, uid: record.uid, instanceId: 'test' });
  assert(detail.body?.available, '详情里应带原文全文');
  assert(detail.analysis, '同时应带 AI 分析');

  const withoutBody = await buildMailDetail({ folder: record.folder, uid: record.uid, instanceId: 'test', withBody: false });
  assertEqual(withoutBody.body, null, 'withBody=false 时不应加载正文（列表场景更快）');

  const missing = await loadMailBody({ folder: 'INBOX', uid: 999999, instanceId: 'test' });
  assertEqual(missing.available, false, '不存在的邮件应返回 available:false');
  assert(missing.reason, '应说明原因');
});

await test('草稿：标签计数不受筛选影响；同步草稿箱会替换旧副本', async () => {
  const { syncDraftToMailbox } = await import('../server/mail/drafts.js');
  const drafts = store.listDrafts({ instanceId: 'test' });
  assert(drafts.length > 0, '前置条件：应有草稿');
  const target = drafts[0];

  // 第一次同步
  const first = await syncDraftToMailbox(target.id);
  assert(first.mailbox?.uid, '应写入草稿箱');
  const firstUid = first.mailbox.uid;
  const appendedAfterFirst = imap.store.appended.length;

  // 第二次同步：必须先把上一份删掉，不能留孤儿副本
  const second = await syncDraftToMailbox(target.id);
  assert(second.mailbox?.uid, '应再次写入');
  assertEqual(second.replaced?.uid, firstUid, '应报告替换掉的是哪一份');
  assert(second.mailbox.uid !== firstUid, '应是新的一份（IMAP 只能新建，不能原地替换）');
  // 往服务器草稿箱写入也是改外部状态，要留台账
  const syncAudit = (await import('../server/store/audit.js')).listAudit({ action: 'draft.sync' });
  assert(syncAudit.items.length >= 2, `两次同步应各留一条台账（实际 ${syncAudit.items.length}）`);
  assertEqual(syncAudit.items[0].target, target.subject, '台账要记下草稿主题');
  assertEqual(syncAudit.items[0].extra.folder, first.mailbox.folder, '台账要记下写到了哪个文件夹');
  assertEqual(imap.store.appended.length, appendedAfterFirst + 1, '草稿箱只应新增 1 封');
  assertEqual(imap.store.deleted.length >= 1, true, '应调用过删除，清掉旧副本');
  assert(
    imap.store.deleted.some((d) => Number(d.uid) === Number(firstUid)),
    `应删除旧副本 UID=${firstUid}（实际删除：${JSON.stringify(imap.store.deleted)}）`,
  );
});

await test('HTTP：/api/drafts 返回不受筛选影响的计数；详情支持 body=0', async () => {
  const { url, stop } = await startTestServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const token = getConfig().web.authToken;
  const auth = { 'x-mailbot-token': token };
  try {
    const all = await (await fetchJson(`${url}/api/drafts`, { headers: auth })).body;
    assert(all.counts, '应返回 counts');
    assertEqual(all.counts.all, store.listDrafts({ instanceId: 'test' }).length, 'counts.all 应是全量草稿数');
    assert(typeof all.counts.sent === 'number' && typeof all.counts.pending === 'number', '三个标签的数量都应有');
    assertEqual(all.quoteOriginal !== undefined, true, '应带上引文设置，供界面判断横幅');

    const sentOnly = await (await fetchJson(`${url}/api/drafts?status=sent`, { headers: auth })).body;
    assertEqual(sentOnly.counts.all, all.counts.all, '筛选后的 counts 仍是全量口径（否则切标签数字会互相归零）');

    const record = store.listAnalyses({ instanceId: 'test', limit: 5 })[0];
    const withBody = await (await fetchJson(`${url}/api/mails/${record.folder}/${record.uid}`, { headers: auth })).body;
    assert(withBody.body?.available, '默认应返回原文全文');
    const noBody = await (await fetchJson(`${url}/api/mails/${record.folder}/${record.uid}?body=0`, { headers: auth })).body;
    assertEqual(noBody.body, null, 'body=0 时不应加载正文');
  } finally {
    await stop();
  }
});

await test('总览：导航徽标与卡片口径一致（都是当前窗口的需你处理）', async () => {
  const { countsPayloadForTest } = await import('../server/index.js');
  const overview = buildOverview({ instanceId: 'test' });
  const counts = countsPayloadForTest();
  assertEqual(counts.needsAction, overview.needAction.length, '徽标应等于总览卡片的「需你处理」数量');
  assert(
    counts.needsAction <= counts.analyses,
    `徽标不应超过总记录数（needsAction=${counts.needsAction}，analyses=${counts.analyses}）`,
  );
});

/* -------------------------------------------------- 12. 签名位置 / 时区 / 预检 */

await test('签名：判断改为「包含且在引文之上」，位置错了能自愈', async () => {
  const { appendSignature, fixSignatureOrder, inspectSignatureOrder, stripSignature } = await import('../server/mail/signature.js');
  const sign = '张三 | 示例事业部\n移动电话：13900000000';
  const quote = '------------------ 原始邮件 ------------------\n发件人: a@b.com\n\n对方原话';

  // 1) 正常顺序：正文 → 签名 → 引文
  const base = appendSignature('收到，我来跟进。', sign);
  assert(base.indexOf(sign) > 0, '应插入签名');
  const ordered = appendSignature(`${base}\n\n${quote}`, sign);
  assertEqual(ordered, `${base}\n\n${quote}`, '已带签名 + 引文时应原样返回（幂等，不能因签名不在末尾就再插一次）');
  assertEqual(inspectSignatureOrder(ordered, sign).ok, true, '签名在引文之上应判定为合规');

  // 2) 缺签名但已有引文 → 必须插到引文**之前**（而不是文末）
  const inserted = appendSignature(`收到，我来跟进。\n\n${quote}`, sign);
  assert(inserted.indexOf(sign) < inserted.indexOf('原始邮件'), '签名必须插在引文之前');
  assertEqual(inserted.split(sign).length - 1, 1, '签名只应出现一次');

  // 3) 坏顺序（老草稿：签名被引文挤到下面）→ 可检出、可修复
  const bad = `收到，我来跟进。\n\n${quote}\n\n${sign}`;
  const order = inspectSignatureOrder(bad, sign);
  assertEqual(order.present, true, '应能识别出签名存在（旧实现用 endsWith 会判成"没有"）');
  assertEqual(order.ok, false, '签名在引文之下应判定为不合规');
  assertEqual(order.misplaced, true, '应标记为「位置不对」');
  const fixed = fixSignatureOrder(bad, sign);
  assertEqual(fixed.moved, true, '应执行了搬移');
  assertEqual(inspectSignatureOrder(fixed.body, sign).ok, true, '修复后应合规');
  assertEqual(fixed.body.split(sign).length - 1, 1, '修复后签名只应出现一次');
  assert(fixed.body.indexOf(sign) < fixed.body.indexOf('原始邮件'), '修复后签名应在引文之前');
  assertEqual(fixSignatureOrder(fixed.body, sign).moved, false, '已合规时不应再动');

  // 4) 剥离签名要能同时处理「在引文前」与「在引文后」两种位置
  assert(!stripSignature(ordered, sign).includes('13900000000'), '应能剥掉引文之前的签名');
  assert(!stripSignature(bad, sign).includes('13900000000'), '应能剥掉引文之后的签名');

  // 5) 旧版"裸姓名行"升级后也必须落在引文之前
  const legacy = `收到。\n\n张三\n\n${quote}`;
  const { upgradeLegacySignature } = await import('../server/mail/signature.js');
  const upgraded = upgradeLegacySignature(`收到。\n\n张三`, sign, '张三');
  assertEqual(upgraded.replaced, true, '应识别并替换裸姓名行');
  assert(upgraded.body.indexOf(sign) >= 0, '替换后应含完整签名');
  const legacyWithQuote = upgradeLegacySignature(legacy, sign, '张三');
  assert(legacyWithQuote.body.indexOf(sign) < legacyWithQuote.body.indexOf('原始邮件'), '升级后签名应在引文之前');
});

await test('签名：接口为每封草稿给出 hasSignature / signatureMisplaced，且「补签名」对带引文的草稿有效', async () => {
  const { applySignatureToDrafts } = await import('../server/mail/signature-ops.js');
  const { listDrafts } = await import('../server/mail/drafts.js');
  const config = getConfig();
  const backup = config.draft.signature;
  config.draft.signature = TEST_SIGNATURE;
  try {
    // 清场：删掉历史草稿，重新起草一封（此时必然带签名 + 引文）
    for (const d of store.listDrafts({ instanceId: 'test' })) store.removeDraft(d.id);
    await runScan({ instanceId: 'test', windowHours: 24, force: true, trigger: 'selftest-sig-order' });
    const draft = store.listDrafts({ instanceId: 'test' }).find((d) => d.status === 'pending');
    assert(draft, '应有待审核草稿');

    const decorated = listDrafts({ instanceId: 'test' }).find((d) => d.id === draft.id);
    assertEqual(decorated.hasSignature, true, '带签名 + 引文的草稿必须报告 hasSignature=true（这正是之前误报的地方）');
    assertEqual(decorated.signatureMisplaced, false, '位置正确时不应标记 misplaced');
    assertEqual(decorated.quoted, true, '带引文应报告 quoted=true');

    // 把签名搬成"坏顺序"，界面上应能识别出位置问题
    const sign = config.draft.signature.replace(/\r\n/g, '\n').trimEnd();
    const bodyWithoutSign = draft.body.replace(sign, '').replace(/\n{3,}/g, '\n\n').trimEnd();
    store.updateDraft(draft.id, { body: `${bodyWithoutSign}\n\n${sign}` });
    const bad = listDrafts({ instanceId: 'test' }).find((d) => d.id === draft.id);
    assertEqual(bad.hasSignature, false, '签名在引文之下时不应算「已带签名」');
    assertEqual(bad.signatureMisplaced, true, '应标记为位置不对');

    // 一键补签名：这次必须真的改动正文（旧实现在这里是空操作，横幅永远消不掉）
    const res = applySignatureToDrafts({ ids: [draft.id] });
    assertEqual(res.applied.length, 1, '应处理这封草稿');
    assertEqual(res.applied[0].mode, 'reordered', '应识别为「仅调整位置」');
    const after = listDrafts({ instanceId: 'test' }).find((d) => d.id === draft.id);
    assertEqual(after.hasSignature, true, '补完之后必须报告 hasSignature=true（横幅才会消失）');
    assertEqual(after.signatureMisplaced, false, '不应再标记位置问题');
    assert(after.body.indexOf(sign) < after.body.indexOf('原始邮件'), '签名应回到引文之前');
    assertEqual(after.body.split(sign).length - 1, 1, '签名只应出现一次');

    // 再补一次应变成"跳过"，而不是报错或重复插入
    const again = applySignatureToDrafts({ ids: [draft.id] });
    assertEqual(again.applied.length, 0, '已合规后不应重复处理');
    assertEqual(again.skipped[0].reason, '已包含当前签名', '应说明跳过原因');
  } finally {
    config.draft.signature = backup;
  }
});

await test('发送：Date 头按配置时区写 +0800，且与 IMAP internal date / 本地 sentAt 一致', async () => {
  const { buildMime } = await import('../server/mail/compose.js');
  const { formatRfc5322Date } = await import('../server/calendar/time.js');
  const config = getConfig();
  const tz = config.calendar?.timeZone || 'Asia/Shanghai';

  // 1) 格式化本身：同一瞬间在不同时区下的偏移与星期都要正确
  const instant = new Date('2026-10-01T02:44:00Z');
  assertEqual(formatRfc5322Date(instant, 'Asia/Shanghai'), 'Thu, 01 Oct 2026 10:44:00 +0800', '东八区应写 +0800');
  assertEqual(formatRfc5322Date(instant, 'UTC'), 'Thu, 01 Oct 2026 02:44:00 +0000', 'UTC 应写 +0000');
  // 跨时区时星期必须跟着目标时区的日历走，而不是照抄 UTC 的星期
  assertIncludes(formatRfc5322Date(instant, 'America/New_York'), 'Wed, 30 Sep 2026 22:44:00 -0400', '跨日时星期/日期都要按目标时区');
  assert(!formatRfc5322Date(instant, tz).includes('GMT'), '不应再写 GMT——Foxmail 会原样显示成 UTC 时间');

  // 2) 组装出来的 MIME 头部（buildMime 返回 Buffer）
  const rawBuf = buildMime({
    from: { name: '张三', address: 'user@example.cn' },
    to: 'a@b.com',
    subject: '测试主题',
    text: '正文',
    date: instant,
    timeZone: tz,
  });
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf);
  const header = raw.split('\r\n\r\n')[0];
  const dateLine = header.split('\r\n').find((l) => l.startsWith('Date: '));
  assert(dateLine, 'MIME 应带 Date 头');
  assert(dateLine.endsWith('+0800'), `Date 头应以 +0800 结尾（实际 ${dateLine}）`);
  assertIncludes(dateLine, '10:44:00', '时间应是配置时区（北京）的墙上时间');

  // 3) 解析回来必须还是同一个绝对瞬间（换偏移表达不能改变时刻）
  const parsed = await parseMessage(Buffer.from(raw, 'utf8'));
  assertEqual(new Date(parsed.date).getTime(), instant.getTime(), 'Date 头解析回来必须是同一瞬间');

  // 4) internal date 与 sentAt 一致：用固定的 date 传进 appendToMailbox
  const beforeAppend = imap.store.appended.length;
  await appendToMailbox(await connect(getInstance('test')), 'Drafts', Buffer.from(raw), ['\\Draft'], instant);
  const appended = imap.store.appended[imap.store.appended.length - 1];
  assertEqual(imap.store.appended.length, beforeAppend + 1, '应写入一封');
  assert(appended.raw.includes('+0800'), '写入草稿箱的原文也应带 +0800');
});

await test('草稿计数：不受回看窗口限制（旧草稿不会从总览卡片上消失）', async () => {
  const { buildOverview } = await import('../server/ai/insight.js');
  // 造一封「创建时间很早」的待审核草稿
  const old = store.addDraft({
    instanceId: 'test',
    to: 'someone@example.com',
    subject: '很久以前起草的回复',
    body: '正文',
    source: { folder: 'INBOX', uid: 888001, subject: '旧邮件' },
    reason: '测试',
  });
  // addDraft 必须保证有主键，否则这条记录无法被更新/发送/删除，却会计入统计
  assert(old.id, 'addDraft 必须返回带 id 的草稿（缺 id 的记录无法管理）');
  assertEqual(store.getDraft(old.id)?.id, old.id, '按 id 应能取回同一条草稿');
  store.updateDraft(old.id, { createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString() });
  store.persistState();

  const overview = buildOverview({ instanceId: 'test', windowHours: 24 });
  const all = store.listDrafts({ instanceId: 'test' });
  assertEqual(overview.stats.drafts.pending, all.filter((d) => d.status === 'pending' || d.status === 'sending').length, '待审核数应是全量口径');
  assertEqual(overview.stats.drafts.total, all.length, '草稿总数应是全量口径');
  assertEqual(overview.stats.drafts.sent, all.filter((d) => d.status === 'sent').length, '已发送数应是全量口径');
  assert(overview.stats.drafts.pending >= 1, '30 天前创建的待审核草稿也应计入');
  store.removeDraft(old.id);
  store.persistState();
});

await test('窗口：小时数限幅、取信上限随窗口放大、描述人类可读', async () => {
  const { clampWindowHours, describeWindow, maxMessagesFor, MAX_WINDOW_HOURS } = await import('../server/ai/engine.js');
  assertEqual(clampWindowHours(24), 24, '正常值原样返回');
  assertEqual(clampWindowHours(0), 24, '0 视为非法，退回默认 24');
  assertEqual(clampWindowHours(-5), 24, '负数视为非法');
  assertEqual(clampWindowHours(24 * 365), MAX_WINDOW_HOURS, '超过 30 天应被限幅');
  assertEqual(clampWindowHours(24 * 7), 168, '7 天=168 小时');

  assertEqual(describeWindow(24), '最近 24 小时');
  assertEqual(describeWindow(72), '最近 3 天');
  assertEqual(describeWindow(168), '最近 7 天');
  assertEqual(describeWindow(720), '最近 30 天');
  assertEqual(describeWindow(6), '最近 6 小时');
  assert(!describeWindow(168).includes('168 小时'), '整天的窗口不该显示成「最近 168 小时」');

  const base = 60;
  assertEqual(maxMessagesFor(24, base), 60, '24 小时 = 配置值');
  assertEqual(maxMessagesFor(24 * 3, base), 180, '3 天 ×3');
  assertEqual(maxMessagesFor(24 * 7, base), 420, '7 天 ×7');
  assert(maxMessagesFor(24 * 30, base) <= 2000, '再多也不超过硬顶 2000');
  assert(maxMessagesFor(24 * 30, 5000) === 2000, '配置值再大也要被硬顶压住');
});

await test('预检：只读统计窗口内邮件数，不调用模型', async () => {
  const { previewScan } = await import('../server/ai/engine.js');
  const llmBefore = llm.calls.length;
  const preview = await previewScan({ instanceId: 'test', windowHours: 24 });
  assertEqual(llm.calls.length, llmBefore, '预检绝不能调用模型（零 token 成本）');
  assert(preview.windowHours === 24, '应回显窗口');
  assert(preview.windowLabel === '最近 24 小时', '应给出人类可读描述');
  assert(Array.isArray(preview.folders) && preview.folders.length > 0, '应按文件夹给出命中数');
  assert(typeof preview.matched === 'number', '应给出窗口内命中总数');
  assert(preview.taken <= preview.limit, '取出的数量不能超过上限');
  assert(typeof preview.estimatedAnalyze === 'number' && preview.estimatedAnalyze >= 0, '应给出预计要分类的封数');
  assert(preview.estimatedCalls >= 1, '应给出预计模型调用次数');
  /*
   * 预检数字必须与运行时的**真实行为**一致。
   * 旧实现按"已分析比例"估算，会写着"其中 N 封已分析过，不会重复消耗"，
   * 而实际每轮都会把窗口内全部邮件重新分类——拿错数字劝用户花钱。
   */
  assert(typeof preview.reusable === 'number', '应给出真正会复用的封数（已有分析 + 已有草稿）');
  assertEqual(
    preview.estimatedAnalyze,
    Math.max(0, preview.taken - preview.reusable),
    '预计分析数必须等于"取出的封数 - 会复用的封数"',
  );
  assert(preview.reusable <= preview.alreadyDrafted, '复用数不可能超过已有草稿数');
  assert(preview.reusable <= preview.alreadyAnalyzed, '复用数不可能超过已有分析数');
  assertEqual(preview.estimatedCalls, Math.ceil(preview.estimatedAnalyze / preview.batchSize) + 1, '调用次数 = 分类批次 + 1 次简报');

  // 窗口越大，取信上限越高（7 天应当比 24 小时能取更多）
  const week = await previewScan({ instanceId: 'test', windowHours: 24 * 7 });
  assert(week.limit > preview.limit, `7 天的取信上限应更大（24h=${preview.limit}，7d=${week.limit}）`);
  assert(week.matched >= preview.matched, '7 天命中的邮件不应少于 24 小时');
});

/* -------------------------------------------------- 13. 大模型服务商预设 */

await test('大模型预设：主流服务商齐全、字段自洽、与客户端协议一致', async () => {
  const { LLM_PRESETS } = await import('../server/config/defaults.js');
  assert(Array.isArray(LLM_PRESETS) && LLM_PRESETS.length >= 8, `预设数量应足够，实际 ${LLM_PRESETS?.length}`);

  const ids = LLM_PRESETS.map((p) => p.id);
  assertEqual(new Set(ids).size, ids.length, '预设 id 不能重复');
  for (const key of ['deepseek', 'dashscope', 'moonshot', 'zhipu', 'openai', 'ollama']) {
    assert(ids.includes(key), `应包含主流服务商 ${key}`);
  }

  for (const p of LLM_PRESETS) {
    assert(p.label, `${p.id} 缺少 label`);
    assert(p.note, `${p.id} 缺少 note（用户需要知道计费/网络注意事项）`);
    assert(p.baseUrl, `${p.id} 缺少 baseUrl`);
    assert(Array.isArray(p.models) && p.models.length > 0, `${p.id} 缺少常用模型列表`);
    // 模型名必须都是字符串且非空
    for (const m of p.models) assert(typeof m === 'string' && m.trim(), `${p.id} 的模型名不合法：${m}`);
    // defaultModel 必须是 models 里的一项，否则"选服务商"会填出一个它自己都不认识的模型
    assert(p.models.includes(p.defaultModel), `${p.id} 的 defaultModel(${p.defaultModel}) 不在 models 列表里`);
    // baseUrl 必须是 OpenAI 兼容的 http(s) 地址
    assert(/^https?:\/\//.test(p.baseUrl), `${p.id} 的 baseUrl 不是 http(s) 地址`);
    // 需要 Key 的服务商必须给出申请入口
    if (p.needsKey !== false) assert(p.keyUrl, `${p.id} 需要 Key 却没给 keyUrl`);
  }

  // 服务端的 LlmClient 说的是 OpenAI 协议：baseUrl 必须能直接拼 /chat/completions
  const { LlmClient } = await import('../server/llm/client.js');
  for (const p of LLM_PRESETS) {
    const client = new LlmClient({ baseUrl: p.baseUrl, apiKey: 'k', model: p.defaultModel });
    const url = `${client.baseUrl}/chat/completions`;
    assert(!url.includes('//chat') && url.startsWith('http'), `${p.id} 拼出的请求地址不对：${url}`);
  }
});

await test('大模型：本机部署可留空 API Key，公网地址仍必须填写', async () => {
  const { LlmClient } = await import('../server/llm/client.js');
  const local = [
    'http://127.0.0.1:11434/v1',
    'http://localhost:8000/v1',
    'http://192.168.1.20:1234/v1',
    'http://10.0.0.8:8000/v1',
  ];
  for (const baseUrl of local) {
    const c = new LlmClient({ baseUrl, apiKey: '', model: 'qwen2.5:7b' });
    assertEqual(c.keyOptional, true, `${baseUrl} 应被识别为本机/内网地址`);
    assertEqual(c.ready, true, `${baseUrl} 没有 Key 也应当可用`);
    let threw = null;
    try {
      c.assertReady();
    } catch (err) {
      threw = err;
    }
    assert(!threw, `${baseUrl} 不应因为缺 Key 而拒绝运行`);
  }

  // 公网服务仍然必须有 Key，否则只会在调用时收到 401 而看不出原因
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.openai.com/v1', 'https://api.moonshot.cn/v1']) {
    const c = new LlmClient({ baseUrl, apiKey: '', model: 'x' });
    assertEqual(c.keyOptional, false, `${baseUrl} 不应被当成内网地址`);
    assertEqual(c.ready, false, `${baseUrl} 缺少 Key 时不应就绪`);
    let code = null;
    try {
      c.assertReady();
    } catch (err) {
      code = err.code;
    }
    assertEqual(code, 'LLM_NOT_CONFIGURED', `${baseUrl} 缺 Key 应报 LLM_NOT_CONFIGURED`);
  }

  // 伪装成内网的域名不能被放过（例如 127.0.0.1.evil.com）
  const sneaky = new LlmClient({ baseUrl: 'https://127.0.0.1.evil.com/v1', apiKey: '', model: 'x' });
  assertEqual(sneaky.keyOptional, false, '不能只看前缀，必须按解析后的 hostname 精确判断');
});

/* -------------------------------------------------- 14. 附件清单与下载 */

await test('附件：清单与下载共用同一次过滤，序号一一对应', async () => {
  const { visibleAttachments, extractAttachment, parseMessage } = await import('../server/mail/parse.js');
  const { makeRawMail } = await import('./mocks.js');

  const raw = makeRawMail({
    subject: '带附件的邮件',
    from: { name: '客户', address: 'boss@client.com' },
    body: '请查收附件。',
    attachments: [
      { filename: '报价单.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: Buffer.from('XLSX-CONTENT-1') },
      { filename: '合同.pdf', contentType: 'application/pdf', content: Buffer.from('PDF-CONTENT-2') },
      { filename: '说明.txt', contentType: 'text/plain', content: Buffer.from('TXT-CONTENT-3') },
    ],
    // 内嵌图片必须被过滤掉，且**不能**打乱上面三个附件的序号
    inlineImage: { filename: 'logo.png', contentType: 'image/png', content: Buffer.from('PNGDATA'), contentId: 'logo@local' },
  });

  // 1) 列表：详情里给出的清单
  const parsed = await parseMessage(raw);
  const list = visibleAttachments(parsed.attachments);
  assertEqual(list.length, 3, `内嵌图片不应算附件，应列出 3 个（实际 ${list.length}）`);
  assertEqual(list[0].filename, '报价单.xlsx', '第一个附件名');
  assertEqual(list[2].filename, '说明.txt', '第三个附件名');

  // 2) 下载：同一个下标必须取到同一个附件（这是最容易错位的地方）
  for (const [i, expect] of [
    [0, 'XLSX-CONTENT-1'],
    [1, 'PDF-CONTENT-2'],
    [2, 'TXT-CONTENT-3'],
  ]) {
    const att = await extractAttachment(raw, i);
    assert(att, `下标 ${i} 应能取到附件`);
    assertEqual(att.content.toString('utf8'), expect, `下标 ${i} 取到的内容必须是同一个附件`);
    assertEqual(att.total, 3, '应报告附件总数');
  }

  // 3) 越界与非法下标应返回 null，而不是抛错或取到别的文件
  for (const bad of [-1, 3, 99, 'abc', null]) {
    const att = await extractAttachment(raw, bad);
    assertEqual(att, null, `非法下标 ${bad} 应返回 null`);
  }

  // 4) 内容长度必须与返回的 size 一致（否则下载头会与实际不符）
  const one = await extractAttachment(raw, 1);
  assertEqual(one.size, one.content.length, 'size 应与内容长度一致');
  assertEqual(one.contentType, 'application/pdf', '应带上原始 MIME 类型');
  assertEqual(parsed.attachments.length, 3, 'parseMessage 的附件列表也已经滤掉内嵌图片');
});

await test('附件：文件名做安全收敛，路径成分与控制字符都被剥离', async () => {
  const { safeFilename } = await import('../server/mail/parse.js');

  // 路径穿越与绝对路径：只能留最后一段
  assertEqual(safeFilename('../../etc/passwd'), 'passwd', '不应保留上级目录');
  assertEqual(safeFilename('..\\..\\Windows\\system32\\cmd.exe'), 'cmd.exe', '反斜杠路径同样要收敛');
  assertEqual(safeFilename('/etc/shadow'), 'shadow', '绝对路径只留文件名');
  assertEqual(safeFilename('C:\\Users\\x\\report.docx'), 'report.docx', 'Windows 绝对路径同样处理');

  // 点开头（隐藏文件）与非法字符
  assertEqual(safeFilename('.bashrc'), 'bashrc', '不应生成隐藏文件');
  assertEqual(safeFilename('..'), 'attachment', '纯点点应回落到兜底名');
  assertEqual(safeFilename('a:b|c?d*e"f<g>h.txt'), 'a_b_c_d_e_f_g_h.txt', '非法字符应被替换');

  // 控制字符、换行（可用于头注入）必须清掉
  assert(!safeFilename('evil\r\nX-Injected: 1.txt').includes('\n'), '不应保留换行');
  assert(!safeFilename('evil\r\nX-Injected: 1.txt').includes('\r'), '不应保留回车');
  assert(!safeFilename('a\u0000b.txt').includes('\u0000'), '不应保留 NUL');

  // 空值与超长
  assertEqual(safeFilename(''), 'attachment', '空名应回落兜底');
  assertEqual(safeFilename(null), 'attachment', 'null 应回落兜底');
  assertEqual(safeFilename('   '), 'attachment', '纯空白应回落兜底');
  assert(safeFilename('x'.repeat(500)).length <= 180, '超长名应被截断');
  assert(safeFilename('e\u0301\u4e2d\u6587.pdf').includes('.pdf'), '正常中文名应保留扩展名');
});

await test('附件：HTTP 接口返回原始字节、正确的下载头，越界 404', async () => {
  const { makeRawMail } = await import('./mocks.js');
  const { server, url, stop } = await startTestServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const auth = { 'x-mailbot-token': getConfig().web.authToken };
  const folder = 'INBOX';
  const uid = 777001;
  const raw = makeRawMail({
    subject: '附件接口测试',
    from: { name: '客户', address: 'boss@client.com' },
    body: '正文',
    attachments: [
      { filename: '中文 名称 空格.xlsx', contentType: 'application/vnd.ms-excel', content: Buffer.from('BYTES-1') },
      { filename: '../../escape.pdf', contentType: 'application/pdf', content: Buffer.from('BYTES-2') },
    ],
  });
  const rawFile = store.saveRaw(folder, uid, null, raw);
  assert(rawFile, '前置条件：归档写入应成功');
  try {
    const r1 = await fetch(`${url}/api/mails/${folder}/${uid}/attachments/0`, { headers: auth });
    assertEqual(r1.status, 200, '应返回 200');
    assertEqual(Buffer.from(await r1.arrayBuffer()).toString('utf8'), 'BYTES-1', '应返回附件原始字节');
    assertIncludes(r1.headers.get('content-type'), 'excel', '应带上 MIME 类型');
    assertIncludes(r1.headers.get('content-disposition'), 'attachment;', '应是下载而不是内联');
    // 中文名：既要 ASCII 兜底，也要 RFC 5987 的 UTF-8 名
    const cd = r1.headers.get('content-disposition');
    assertIncludes(cd, "filename*=UTF-8''", '应带 RFC 5987 编码名');
    assertIncludes(decodeURIComponent(cd), '中文 名称 空格.xlsx', '中文名应能还原');
    assert(!cd.includes('\n') && !cd.includes('\r'), '下载头不应含换行（防头注入）');

    // 文件名带路径时，下载名必须被收敛（不能出现目录分隔符）
    const r2 = await fetch(`${url}/api/mails/${folder}/${uid}/attachments/1`, { headers: auth });
    assertEqual(r2.status, 200, '应返回 200');
    const cd2 = r2.headers.get('content-disposition');
    const decoded2 = decodeURIComponent(cd2);
    assert(!/filename\*?=[^;]*\.\.\//.test(decoded2), `下载名不应保留上级目录（实际 ${decoded2}）`);
    assertIncludes(decoded2, 'escape.pdf', '应保留收敛后的文件名');
    assertEqual(Buffer.from(await r2.arrayBuffer()).toString('utf8'), 'BYTES-2', '第二个附件内容应正确');

    // 越界与非法序号
    for (const bad of ['2', '99']) {
      const r = await fetch(`${url}/api/mails/${folder}/${uid}/attachments/${bad}`, { headers: auth });
      assertEqual(r.status, 404, `越界下标 ${bad} 应 404`);
    }
    // 不存在的邮件（该 UID 没有归档）
    const missing = await fetch(`${url}/api/mails/${folder}/999999/attachments/0`, { headers: auth });
    assertEqual(missing.status, 404, '邮件不存在应 404');
  } finally {
    try {
      fs.unlinkSync(rawFile);
    } catch {
      /* 忽略 */
    }
    await stop();
  }
});

/* -------------------------------------------------- 15. 草稿附件与发送 */

await test('附件：编码后体积算法与预算判定', async () => {
  const { encodedSizeOf, totalEncodedSize } = await import('../server/store/attachments.js');
  // base64 膨胀约 1/3：3 字节 → 4 字符；再叠加每 76 字符一行的换行开销
  assertEqual(encodedSizeOf(0), 0, '空内容应为 0');
  assert(encodedSizeOf(3) >= 4 && encodedSizeOf(3) <= 8, `3 字节编码后应是 4 字符 + 少量换行开销（实际 ${encodedSizeOf(3)}）`);
  const e3000 = encodedSizeOf(3000);
  assert(e3000 >= 4000 && e3000 <= 4200, `3000 字节编码后应约 4000（实际 ${e3000}）`);
  // 关键结论：15 MB 的附件编码后就超过 20 MB 的企业邮箱上限
  const single = encodedSizeOf(15 * 1024 * 1024);
  assert(single > 20_000_000, `15 MB 编码后应超过 20 MB 上限（实际 ${single}）——这正是必须在发送前拦截的原因`);
  assertEqual(totalEncodedSize([]), 0, '没有附件应为 0');
  assert(totalEncodedSize([{ size: 3 }, { size: 3 }]) > encodedSizeOf(6), '每个分部的固定开销也要计入');
});

await test('附件：单封草稿的增删与预算联动，发送超限被硬拦截', async () => {
  const drafts = await import('../server/mail/drafts.js');
  const cfg = getConfig();
  const backup = { max: cfg.draft.attachmentMaxBytes, count: cfg.draft.maxAttachments };
  cfg.draft.attachmentMaxBytes = 1_000_000; // 1 MB，便于构造超限
  cfg.draft.maxAttachments = 3;
  const draft = store.addDraft({
    instanceId: 'test',
    to: 'boss@client.com',
    subject: '带附件的回复',
    body: '请查收附件。',
    source: { folder: 'INBOX', uid: 11, subject: '来信' },
    reason: '测试附件',
  });
  store.persistState();
  const id = draft.id;
  try {
    // 1) 正常情况下加两个附件
    const a1 = drafts.addDraftAttachment(id, { filename: '报价单.xlsx', contentType: 'application/vnd.ms-excel', buffer: Buffer.from('X'.repeat(1000)) });
    assertEqual(a1.draft.attachments.length, 1, '应加上一个附件');
    assert(a1.attachment.id, '应返回附件 id');
    assertEqual(a1.attachment.filename, '报价单.xlsx', '文件名应保留');
    assertEqual(a1.budget.count, 1, '预算里应统计到 1 个');
    assertEqual(a1.budget.overBudget, false, '1 KB 不该超限');

    // 文件名穿越在落盘时也要收敛
    const a2 = drafts.addDraftAttachment(id, { filename: '../../evil.sh', contentType: 'text/x-sh', buffer: Buffer.from('rm -rf /') });
    assertEqual(a2.attachment.filename, 'evil.sh', '落盘名应去掉路径成分');
    assert(!String(a2.attachment.file).includes('/') && !String(a2.attachment.file).includes('\\'), '落盘文件名不应含路径分隔符');

    // 2) 落盘内容可读回，且与写进去的一致
    const back = drafts.getDraftAttachment(id, a1.attachment.id);
    assertEqual(back.content.toString('utf8'), 'X'.repeat(1000), '读回的内容必须一致');
    assertEqual(back.attachment.size, 1000, '大小应记录正确');

    // 3) 单个就超限 → 直接拒绝
    let code = null;
    try {
      drafts.addDraftAttachment(id, { filename: 'huge.bin', contentType: 'application/octet-stream', buffer: Buffer.alloc(2_000_000) });
    } catch (err) {
      code = err.code;
    }
    assertEqual(code, 'ATTACHMENT_TOO_LARGE', '单个超限应 413');
    assertEqual(drafts.getDraft(id).attachments.length, 2, '被拒绝的附件不应留下记录');

    // 4) 数量上限
    drafts.addDraftAttachment(id, { filename: 'third.txt', contentType: 'text/plain', buffer: Buffer.from('3') });
    let countCode = null;
    try {
      drafts.addDraftAttachment(id, { filename: 'fourth.txt', contentType: 'text/plain', buffer: Buffer.from('4') });
    } catch (err) {
      countCode = err.code;
    }
    assertEqual(countCode, 'TOO_MANY_ATTACHMENTS', `超过 ${cfg.draft.maxAttachments} 个应被拒绝`);

    // 5) 删除：记录与文件都要消失
    const filePath = path.join(getPaths().attachmentsDir, drafts.getDraft(id).attachments[0].file);
    assert(fs.existsSync(filePath), '前置条件：附件文件应存在');
    drafts.removeDraftAttachment(id, drafts.getDraft(id).attachments[0].id);
    assert(!fs.existsSync(filePath), '删除附件后文件也应被删除');
    assertEqual(drafts.getDraft(id).attachments.length, 2, '记录数应减少');

    // 6) 发送前超限拦截：把上限压到很小
    cfg.draft.attachmentMaxBytes = 100;
    let sendCode = null;
    try {
      await drafts.sendDraft(id, { confirm: true });
    } catch (err) {
      sendCode = err.code;
    }
    assertEqual(sendCode, 'ATTACHMENT_BUDGET_EXCEEDED', '超限发送应被拦截（而不是等 SMTP 报错）');
    cfg.draft.attachmentMaxBytes = 1_000_000;

    // 7) 删除草稿时附件文件一并清理，不留孤儿
    const remaining = drafts.getDraft(id).attachments.map((a) => path.join(getPaths().attachmentsDir, a.file));
    drafts.deleteDraft(id);
    for (const f of remaining) assert(!fs.existsSync(f), `删除草稿后附件文件应被清理：${f}`);
    assertEqual(store.getDraft(id), null, '草稿记录应已删除');
    // 删除草稿会连带清理附件文件，属于"改了本地/服务器状态"，也要留台账
    const delAudit = (await import('../server/store/audit.js')).listAudit({ action: 'draft.delete' });
    assert(delAudit.items.some((r) => r.target === draft.subject), `删除草稿应留下台账（含主题「${draft.subject}」）`);
  } finally {
    cfg.draft.attachmentMaxBytes = backup.max;
    cfg.draft.maxAttachments = backup.count;
    if (store.getDraft(id)) store.removeDraft(id);
    store.persistState();
  }
});

await test('附件：发送的 MIME 带 multipart/mixed，收件侧能解析出正文与附件', async () => {
  const drafts = await import('../server/mail/drafts.js');
  const { parseMessage, extractAttachment } = await import('../server/mail/parse.js');
  const draft = store.addDraft({
    instanceId: 'test',
    to: 'boss@client.com',
    subject: '附件往返测试',
    body: '正文在这里。',
    source: { folder: 'INBOX', uid: 11, subject: '来信' },
    reason: '测试附件往返',
  });
  store.persistState();
  const id = draft.id;
  try {
    drafts.addDraftAttachment(id, { filename: '数据.csv', contentType: 'text/csv', buffer: Buffer.from('a,b\n1,2\n') });
    drafts.addDraftAttachment(id, { filename: '图片.png', contentType: 'image/png', buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) });
    const before = smtp.received.length;
    const out = await drafts.sendDraft(id, { confirm: true, deleteMailboxDraft: false, appendToSent: false });
    assertEqual(smtp.received.length, before + 1, 'SMTP 应收到邮件');
    assertEqual(out.draft.status, 'sent', '状态应为已发送');

    const raw = smtp.received[smtp.received.length - 1].raw;
    assertIncludes(raw, 'multipart/mixed', '有附件时应使用 multipart/mixed');
    assertIncludes(raw, "filename*=UTF-8''", '中文附件名应带 RFC 5987 编码');
    const parsed = await parseMessage(Buffer.from(raw, 'utf8'));
    assertIncludes(parsed.body, '正文在这里', '正文必须仍能被解析出来（MIME 层级不能把正文弄丢）');
    assertEqual(parsed.attachments.length, 2, '收件侧应解析出 2 个附件');
    assertEqual(parsed.attachments[0].filename, '数据.csv', '第一个附件名');
    const csv = await extractAttachment(Buffer.from(raw, 'utf8'), 0);
    assertEqual(csv.content.toString('utf8'), 'a,b\n1,2\n', '附件内容应逐字节一致');
    const png = await extractAttachment(Buffer.from(raw, 'utf8'), 1);
    assertEqual(Buffer.compare(png.content, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])), 0, '二进制附件应逐字节一致');

    // 发送成功后本地附件内容会被清理（记录保留），避免 data/attachments 无限增长
    const after = store.getDraft(id);
    assertEqual(after.attachments.length, 2, '元数据应保留，便于回看发了什么');
    assert(after.attachmentsCleanedAt, '应记录清理时间');
    const stillThere = after.attachments.filter((a) => fs.existsSync(path.join(getPaths().attachmentsDir, a.file)));
    assertEqual(stillThere.length, 0, '发送成功后附件文件应被清理');
  } finally {
    if (store.getDraft(id)) store.removeDraft(id);
    store.persistState();
  }
});

await test('附件：ensureDirs 会一并建好附件目录', async () => {
  const { ensureDirs, getPaths } = await import('../server/config/index.js');
  const paths = ensureDirs();
  // 上传附件时才建目录，会把"权限/路径有问题"推迟到用户点上传那一刻；
  // 启动阶段就建立，能更早暴露问题。
  assert(fs.existsSync(paths.attachmentsDir), `attachmentsDir 应被创建：${paths.attachmentsDir}`);
  assert(fs.statSync(paths.attachmentsDir).isDirectory(), 'attachmentsDir 应是目录');
  assertEqual(paths.attachmentsDir, getPaths().attachmentsDir, '两次取到的路径应一致');
  assert(paths.attachmentsDir.endsWith('attachments'), '目录名应为 attachments');
});

/* -------------------------------------------------- 16. 日历回顾分析 */

await test('日程分类：两个视角——"占不占时间"与"算不算工作"分开判定', async () => {
  const { classifyEvent, classifyEvents, looksLikeMeetingTitle, otherAttendees, lifeKindOf } = await import('../server/calendar/classify.js');
  const base = { status: 'confirmed', allDay: false, eventType: 'default', transparency: 'opaque', attendees: [] };

  /*
   * 用户记日历的目的是"把这段时间标记为忙碌"，所以生活事务**占用时间**、要统计，
   * 只是**不算工作**。旧实现用单一 excluded 把整条丢掉，导致"时间去哪了"变成纯工作口径。
   */

  // 1) 真正"一条都不算"的四种：已取消 / 不占忙 / 我已拒绝 / 办公地点标注
  assertEqual(classifyEvent({ ...base, summary: '已取消的会', status: 'cancelled' }).occupies, false, '已取消应不计占用');
  assertEqual(classifyEvent({ ...base, summary: '生日提醒', transparency: 'transparent' }).occupies, false, '自己标了不占忙就不该计入');
  assertEqual(classifyEvent({ ...base, summary: '在家办公', eventType: 'workingLocation' }).occupies, false, '办公地点标注跨全天，计入会虚增');
  const declinedByMe = { ...base, summary: '分享会', attendees: [{ email: 'me@x.com', self: true, responseStatus: 'declined' }, { email: 'a@x.com', responseStatus: 'accepted' }] };
  assertEqual(classifyEvent(declinedByMe).occupies, false, '我拒绝的会应不计占用');
  const declinedByOther = { ...base, summary: '分享会', attendees: [{ email: 'me@x.com', self: true, responseStatus: 'accepted' }, { email: 'a@x.com', responseStatus: 'declined' }] };
  assertEqual(classifyEvent(declinedByOther).occupies, true, '别人拒绝不代表我不参加');

  // 2) **生活事务要计入占用，但不计入工作**（本次修正的核心）
  for (const t of ['和老婆孩子过结婚纪念日午餐', '北沿公园散步', '百岁羽毛球馆打羽毛球', '处理两笔还款（建设银行&浦发银行）']) {
    const r = classifyEvent({ ...base, summary: t });
    assertEqual(r.kind, 'life', `「${t}」应归类为生活`);
    assertEqual(r.occupies, true, `「${t}」占用了时间，必须计入总占用`);
    assertEqual(r.isWork, false, `「${t}」不是工作，不得计入工作负荷`);
    assert(r.lifeKind, `「${t}」应给出生活子类`);
  }
  assertEqual(lifeKindOf('北沿公园散步'), '运动健身', '散步应归到运动健身');
  assertEqual(lifeKindOf('和老婆孩子过结婚纪念日午餐'), '家庭陪伴', '纪念日应归到家庭陪伴');
  assertEqual(lifeKindOf('处理两笔还款（建设银行&浦发银行）'), '个人事务', '还款应归到个人事务');
  assertEqual(lifeKindOf('随便写点什么'), '其他生活事务', '没命中的应有兜底类别');

  // 3) 休假：占时间但不占工作，单独归"休假/外出"
  const ooo = classifyEvent({ ...base, summary: '年假', eventType: 'outOfOffice' });
  assertEqual(ooo.kind, 'ooo', '休假应单独归类');
  assertEqual(ooo.occupies, true, '休假期间人不在，这段时间是被占的');
  assertEqual(ooo.isWork, false, '休假不是工作');

  // 4) 专注时间：既占时间也算工作
  const focus = classifyEvent({ ...base, summary: '专注：写方案', eventType: 'focusTime' });
  assertEqual(focus.kind, 'focus', '专注时间应单独归类');
  assertEqual(focus.occupies, true, '专注时间占时间');
  assertEqual(focus.isWork, true, '专注时间算工作');

  // 5) 有参会人 → 会议
  const withOthers = { ...base, summary: '随便写点什么', attendees: [{ email: 'me@x.com', self: true }, { email: 'a@x.com' }] };
  assertEqual(classifyEvent(withOthers).kind, 'meeting', '有他人参与就是会议');
  assertEqual(otherAttendees(withOthers).length, 1, '统计他人时不应把自己算进去');

  // 6) **真实用法**：没有参会人，但标题写着"与某某讨论" → 也要算会议
  const c = classifyEvent({ ...base, summary: '与王梓核对综调网络拓扑图' });
  assertEqual(c.kind, 'meeting', '标题像会议时应按会议计（否则会把天天开会的人算成"0 场会"）');
  assertEqual(c.byTitle, true, '应标注这是按标题识别的');
  assert(looksLikeMeetingTitle('与局方负责人讨论综维改革后续重点工作'), '「与…讨论」应被识别');
  assert(!looksLikeMeetingTitle('设计企业邮箱及Google日历数字人'), '纯工作标题不应被误判成会议');

  // 7) 独自工作：占时间也算工作
  const work = classifyEvent({ ...base, summary: '设计开发个人记账web端应用' });
  assertEqual(work.kind, 'work', '独自工作应归类为 work');
  assertEqual(work.isWork, true, '独自工作算工作负荷');

  // 8) 汇总：占用 / 工作 / 生活 三个数要分得开
  const summary = classifyEvents([
    { ...base, summary: '与A讨论方案' }, // 会议（工作）
    { ...base, summary: '散步' }, // 生活（占用，非工作）
    { ...base, summary: '年假', eventType: 'outOfOffice' }, // 休假（占用，非工作）
    { ...base, summary: '写设计文档' }, // 工作
    { ...base, summary: '在家办公', eventType: 'workingLocation' }, // 丢弃
  ]);
  assertEqual(summary.occupied, 4, '应留下 4 条占用时间的条目');
  assertEqual(summary.workCount, 2, '其中 2 条算工作');
  assertEqual(summary.lifeCount, 2, '其中 2 条是生活/休假');
  assertEqual(summary.excluded, 1, '办公地点标注应被丢弃');
  assertEqual(summary.meetingsByTitle, 1, '应按标题识别出 1 场会议');
  assertEqual(summary.meetingsByAttendees, 0, '没有一场是靠参会人识别的');
});

await test('回顾区间：按配置时区确定性解析，上个月是自然月不是 30 天', async () => {
  const { resolveReviewRange, buildPastWindows } = await import('../server/calendar/time.js');
  const now = new Date('2026-10-01T02:30:00Z'); // 北京时间 10-01 10:30
  const tz = 'Asia/Shanghai';

  const last30 = resolveReviewRange({ preset: 'last-30d', now, timeZone: tz });
  assertEqual(last30.from, '2026-09-02', '过去 30 天应含今天往前 29 天');
  assertEqual(last30.to, '2026-10-01', '应含今天');
  assertEqual(last30.days, 30, '天数应为 30');

  const lastMonth = resolveReviewRange({ preset: 'last-month', now, timeZone: tz });
  assertEqual(lastMonth.from, '2026-09-01', '上个月应从 9/1 开始');
  assertEqual(lastMonth.to, '2026-09-30', '上个月应到 9/30 结束');
  assertEqual(lastMonth.days, 30, '9 月是 30 天');
  assert(lastMonth.from !== last30.from, '「上个月」与「过去 30 天」必须是不同区间');

  const q = resolveReviewRange({ preset: 'last-quarter', now, timeZone: tz });
  assertEqual(q.from, '2026-07-01', '现在是 Q4，上季度应是 Q3');
  assertEqual(q.to, '2026-09-30', '上季度应到 9/30');
  assertEqual(q.days, 92, 'Q3 共 92 天');

  const year = resolveReviewRange({ preset: 'last-year', now, timeZone: tz });
  assertEqual(year.days, 365, '过去一年应是 365 天（含今天）');

  const custom = resolveReviewRange({ preset: 'custom', from: '2026-09-01', to: '2026-09-30', now, timeZone: tz });
  assertEqual(custom.from, '2026-09-01', '自定义起点');
  assertEqual(custom.to, '2026-09-30', '自定义终点按"含当天"展示');
  assertEqual(custom.days, 30, '自定义天数应含首尾');

  // 右开区间：上个月的 end 必须正好是本月 1 号 0 点，否则会把本月数据算进来
  assertEqual(lastMonth.end.toISOString(), '2026-09-30T16:00:00.000Z', '右开边界应是 10-01 00:00（北京）');
  assertEqual(buildPastWindows(last30, tz).length, 30, '按天切分应得到 30 天');
  assertEqual(buildPastWindows(last30, tz)[0].key, '2026-09-02', '第一天应是区间起点');

  const bad = resolveReviewRange({ preset: 'custom', from: '不是日期', to: '', now, timeZone: tz });
  assert(bad.days >= 1, '非法自定义区间应回落到默认区间而不是抛错');
});

await test('回顾聚合：两个视角——总占用含生活，工作负荷不含生活', async () => {
  const { aggregateCalendar, describeExcluded } = await import('../server/calendar/review.js');
  const { resolveReviewRange } = await import('../server/calendar/time.js');
  const tz = 'Asia/Shanghai';
  const now = new Date('2026-10-01T02:30:00Z');
  const range = resolveReviewRange({ preset: 'last-month', now, timeZone: tz });
  const at = (d, h, m = 0) => new Date(Date.UTC(2026, 8, d, h - 8, m)).toISOString();
  const mk = (id, summary, start, end, extra = {}) => ({
    id, summary, start, end, attendees: [], status: 'confirmed', allDay: false, eventType: 'default', transparency: 'opaque', ...extra,
  });
  const ev = [
    // 同一时间两场会：占用时长只能算一次（并集）
    mk('a', '与甲讨论A', at(2, 10), at(2, 12)),
    mk('b', '与乙讨论B', at(2, 11), at(2, 13)),
    mk('c', '设计开发排期', at(3, 20), at(3, 23)), // 晚间独自工作
    mk('d', '和老婆孩子过结婚纪念日午餐', at(4, 12), at(4, 13)), // 生活：**计入占用**，不计入工作
    mk('e', '年假', at(5, 0), at(7, 0), { eventType: 'outOfOffice' }), // 休假 2 天：按天计，不进小时口径
    mk('f', '整理分析架构文档', at(26, 14), at(26, 17)), // 周末独自工作（9/26 是周六）
    mk('g', '在家办公', at(7, 0), at(8, 0), { eventType: 'workingLocation' }), // 标注 → 丢弃
  ];
  const agg = aggregateCalendar({ events: ev, range, timeZone: tz });

  assertEqual(agg.source.totalEntries, 7, '总条数');
  assertEqual(agg.source.excluded, 1, '只有办公地点标注应被丢弃');
  assertEqual(agg.source.occupied, 6, '其余 6 条都占用了时间（含生活与休假）');
  assertEqual(agg.source.workCount, 4, '其中 4 条算工作（2 会议 + 2 独自工作）');
  assertEqual(agg.source.lifeCount, 2, '其中 2 条是生活/休假');
  assertIncludes(describeExcluded(agg.source), '办公地点', '丢弃说明里应写明原因');

  assertEqual(agg.totals.meetingCount, 2, '两场会议（按标题识别）');
  assertEqual(agg.totals.meetingHours, 3, `会议时长按并集应是 3 小时而不是 4，实际 ${agg.totals.meetingHours}`);
  assertEqual(agg.totals.workBlockCount, 2, '两段独自工作');

  // 两个视角的核心断言：总占用含生活，工作负荷不含生活
  assertEqual(agg.totals.lifeHours, 1, `生活事务应单独统计（1 小时），实际 ${agg.totals.lifeHours}`);
  assertEqual(agg.totals.lifeEntryCount, 1, '生活条目数应为 1（休假另算）');
  assertEqual(agg.totals.oooDays, 2, '48 小时的休假应按 2 天计');
  // 休假既不进生活小时数、也不进总占用小时数（否则 48 小时会把所有数字压平）
  assertEqual(agg.totals.lifeHours, 1, '休假不得计入生活小时数');
  assertEqual(agg.totals.workBusyHours, 9, `工作占用应是 3（会议并集）+3（晚间）+3（周末）=9 小时，实际 ${agg.totals.workBusyHours}`);
  assertEqual(agg.totals.busyHours, 10, `总占用应是 9 工作 + 1 生活 = 10 小时（休假按天另计），实际 ${agg.totals.busyHours}`);
  assert(agg.totals.busyHours > agg.totals.workBusyHours, '总占用必须大于工作占用（差额就是生活）');
  assert(agg.totals.busyHours > agg.totals.workBusyHours, '总占用必须大于工作占用（差额就是生活/休假）');
  assertEqual(agg.totals.lifeShareOfBusy > 0, true, '生活占总占用比例应大于 0');

  // 生活分类
  assert(agg.lifeKinds.some((l) => l.name === '家庭陪伴'), `生活分类应含"家庭陪伴"（实际 ${agg.lifeKinds.map((l) => l.name).join('、')}）`);

  // 晚间/周末要涵盖独自工作与生活，否则"晚上写代码""周末陪家人"会被漏掉
  assertEqual(agg.structure.eveningWork.length, 1, '晚间独自工作应被统计（只看"晚间会议"就会漏掉）');
  assertEqual(agg.structure.eveningCount >= 1, true, '晚间占用合计应至少 1');
  assertEqual(agg.structure.weekendWork.length, 1, '周末独自工作应被统计');
  // 跨天的休假只能算 1 条，不能因为跨了周六周日就变成 2 条
  assertEqual(agg.structure.weekendLife.length, 1, '跨天休假在周末统计里只应算 1 条');
  assertEqual(agg.structure.weekendCount, 2, '周末占用合计 = 1 条独自工作 + 1 条休假');

  const all = agg.timeline.flatMap((d) => d.items);
  assert(all.some((i) => i.summary === '与甲讨论A'), '清单应含会议');
  // 关键修正：生活事务**要**出现在清单里（旧实现把它整条丢掉了）
  assert(all.some((i) => i.summary.includes('纪念日')), '生活事务应出现在清单里（用户要看它占了多少时间）');
  assert(all.some((i) => i.kind === 'life'), '清单条目应标注 kind=life');
  assert(!all.some((i) => i.summary === '在家办公'), '办公地点标注不应出现在清单里');
  assertEqual(agg.source.meetingsByTitle, 2, '两场会议都靠标题识别');

  const empty = aggregateCalendar({ events: [], range, timeZone: tz });
  assertEqual(empty.totals.meetingCount, 0, '没有数据时应为 0');
  assertEqual(empty.timeline.length, 0, '没有数据时清单为空');
  assertEqual(empty.totals.workloadHours, 0, '工作负荷为 0');
});

await test('回顾报告：md 含叙述结构 + 统计附录 + 日程清单', async () => {
  const { buildReviewAppendix, buildReviewTimeline } = await import('../server/calendar/review-run.js');
  const { aggregateCalendar } = await import('../server/calendar/review.js');
  const { resolveReviewRange } = await import('../server/calendar/time.js');
  const tz = 'Asia/Shanghai';
  const now = new Date('2026-10-01T02:30:00Z');
  const range = resolveReviewRange({ preset: 'last-7d', now, timeZone: tz });
  const at = (d, h) => new Date(Date.UTC(2026, 8, d, h - 8)).toISOString();
  const agg = aggregateCalendar({
    events: [{ id: 'x', summary: '与客户讨论合同', start: at(28, 10), end: at(28, 11), attendees: [], status: 'confirmed', allDay: false, eventType: 'default', transparency: 'opaque' }],
    range,
    timeZone: tz,
  });
  const appendix = buildReviewAppendix(agg);
  assertIncludes(appendix, '附录 A', '应有统计附录');
  assertIncludes(appendix, '| 会议场次 |', '附录应是 markdown 表格');
  assertIncludes(appendix, '排除', '附录要写明口径与排除情况');
  assertIncludes(appendix, '按周', '附录应含按周趋势');
  const timeline = buildReviewTimeline(agg);
  assertIncludes(timeline, '附录 B', '应有日程清单附录');
  assertIncludes(timeline, '与客户讨论合同', '清单应含日程标题');
  assertIncludes(timeline, '10:00-11:00', '清单应含时间段');
});

await test('日历分页：单页装不下时必须翻页，且如实上报截断', async () => {
  const { startMockGoogle } = await import('./mocks-google.js');
  const { listAllEvents } = await import('../server/calendar/google-api.js');
  const { loadConfig } = await import('../server/config/index.js');

  // 12 条日程，每页最多 5 条 → 必须翻 3 页才取全
  const events = Array.from({ length: 12 }, (_v, i) => ({
    summary: `日程 ${i + 1}`,
    start: `2026-09-${String(i + 1).padStart(2, '0')}T10:00:00+08:00`,
    end: `2026-09-${String(i + 1).padStart(2, '0')}T11:00:00+08:00`,
  }));
  const google = await startMockGoogle({ events });
  const backup = {
    clientId: process.env.MAILBOT_GOOGLE_CLIENT_ID,
    secret: process.env.MAILBOT_GOOGLE_CLIENT_SECRET,
    apiBase: process.env.MAILBOT_GOOGLE_API_BASE,
    tokenBase: process.env.MAILBOT_GOOGLE_TOKEN_BASE,
  };
  process.env.MAILBOT_GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com';
  process.env.MAILBOT_GOOGLE_CLIENT_SECRET = 'test-secret';
  process.env.MAILBOT_GOOGLE_API_BASE = google.apiBase;
  process.env.MAILBOT_GOOGLE_TOKEN_BASE = google.tokenBase;
  loadConfig({ rootDir: root, force: true });
  try {
    // 必须先有授权令牌，否则连不上。这里直接写令牌——
    // 走完整 OAuth 流程需要回调地址等配置，那部分由 calendar-selftest 覆盖；
    // 本用例只关心"分页取数"，用一个有效令牌把授权这层绕开。
    const auth = await import('../server/calendar/google-auth.js');
    auth.writeToken({
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      scope: 'https://www.googleapis.com/auth/calendar',
      tokenType: 'Bearer',
    });
    assert(auth.connectionStatus().connected, '前置条件：应已写入授权令牌');

    const window = { timeMin: '2026-09-01T00:00:00+08:00', timeMax: '2026-10-01T00:00:00+08:00' };
    // 第一页只给 5 条
    const one = await (await import('../server/calendar/google-api.js')).listEvents({ ...window, maxResults: 5 });
    assertEqual(one.items.length, 5, '单页应只返回 5 条');
    assert(one.nextPageToken, '还有数据时必须返回 nextPageToken（否则客户端无从知道要翻页）');

    const all = await listAllEvents({ ...window, maxTotal: 100, perPage: 5 });
    assertEqual(all.items.length, 12, `必须取全 12 条（实际 ${all.items.length}）—— 少了就是丢页`);
    assert(all.pages >= 3, `应至少翻 3 页（实际 ${all.pages}）`);
    assertEqual(all.truncated, false, '取全了不应标记截断');
    // 顺序不能因为翻页而乱掉
    assertEqual(all.items[0].summary, '日程 1', '第一条应是最早的');
    assertEqual(all.items[11].summary, '日程 12', '最后一条应是最晚的');

    // 自设上限时：取到上限就停，并且**必须**标记截断（不许假装取完）
    const capped = await listAllEvents({ ...window, maxTotal: 7, perPage: 5 });
    assert(capped.items.length <= 7, `不应超过自设上限（实际 ${capped.items.length}）`);
    assertEqual(capped.truncated, true, '因为上限而少取时必须标记 truncated=true');
  } finally {
    for (const [key, value] of Object.entries({
      MAILBOT_GOOGLE_CLIENT_ID: backup.clientId,
      MAILBOT_GOOGLE_CLIENT_SECRET: backup.secret,
      MAILBOT_GOOGLE_API_BASE: backup.apiBase,
      MAILBOT_GOOGLE_TOKEN_BASE: backup.tokenBase,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await google.close();
    loadConfig({ rootDir: root, force: true });
  }
});

await test('归属增强：从标题解析人名（真实标题）+ 时长分层 + 线上/线下', async () => {
  const { extractPeopleFromTitle, durationBucket, locationKind, DURATION_BUCKETS } = await import('../server/calendar/classify.js');

  // 真实标题：这个用户从不填参会者，名字全写在标题里
  const cases = [
    ['与家诚、柳鑫讨论App壳定时上传视频流', ['家诚', '柳鑫']],
    ['与局方负责人讨论综维改革后续重点工作', ['局方负责人']],
    ['与NOC及OSS中心人员讨论政企集团检查', ['NOC', 'OSS中心人员']],
    ['与薛主任讨论综调系统业务场景端到端链路图', ['薛主任']],
    ['与储德进、徐文兵、雷鸿伟讨论光交箱箱体编号识别模块', ['储德进', '徐文兵', '雷鸿伟']],
    ['与王梓核对综调网络拓扑图', ['王梓']],
  ];
  for (const [title, expected] of cases) {
    const got = extractPeopleFromTitle(title);
    assertEqual(got.join('、'), expected.join('、'), `「${title}」应解析出 ${expected.join('、')}（实际 ${got.join('、') || '空'}）`);
  }

  // 反例：不是"与某人开会"的标题不能凭空造出人名
  for (const title of ['设计企业邮箱及Google日历数字人', '百岁羽毛球馆打羽毛球', '整理分析综调系统架构及装维场景端到端链路图', '周会', '与大家讨论一下']) {
    const got = extractPeopleFromTitle(title);
    assertEqual(got.length, 0, `「${title}」不该解析出人名（实际 ${got.join('、')}）`);
  }
  // 超长的一段话不能当成一个人名
  assertEqual(extractPeopleFromTitle('与综维决策分析系统立项材料编写小组全体成员讨论方案').length, 0, '过长的整段不应当作人名');

  // 时长分层
  assertEqual(durationBucket(15).id, 'short', '15 分钟 → 很短');
  assertEqual(durationBucket(30).id, 'short', '30 分钟 → 很短（含边界）');
  assertEqual(durationBucket(45).id, 'normal', '45 分钟 → 常规');
  assertEqual(durationBucket(90).id, 'long', '90 分钟 → 较长');
  assertEqual(durationBucket(150).id, 'xlong', '150 分钟 → 超长');
  assertEqual(DURATION_BUCKETS.length, 4, '应是 4 档');

  // 线上/线下：地点为空必须是 unknown，不能猜成线下
  assertEqual(locationKind({ location: '腾讯会议 123456' }), 'virtual', '会议软件地点 → 线上');
  assertEqual(locationKind({ location: '', hangoutLink: 'https://meet.google.com/x' }), 'virtual', '有 Meet 链接 → 线上');
  assertEqual(locationKind({ location: '柳林路158号6楼小会议室' }), 'onsite', '有实际地点 → 线下');
  assertEqual(locationKind({ location: '' }), 'unknown', '没填地点应是 unknown（猜成线下会让统计失真）');
});

await test('回顾聚合增强：人名榜来源标注、时长分层、地点分组', async () => {
  const { aggregateCalendar } = await import('../server/calendar/review.js');
  const { resolveReviewRange } = await import('../server/calendar/time.js');
  const tz = 'Asia/Shanghai';
  const now = new Date('2026-10-01T02:30:00Z');
  const range = resolveReviewRange({ preset: 'last-month', now, timeZone: tz });
  const at = (d, h, m = 0) => new Date(Date.UTC(2026, 8, d, h - 8, m)).toISOString();
  const mk = (id, summary, start, end, extra = {}) => ({
    id, summary, start, end, attendees: [], status: 'confirmed', allDay: false, eventType: 'default', transparency: 'opaque', location: '', ...extra,
  });
  const agg = aggregateCalendar({
    events: [
      // 无参会者、名字在标题里 → via=title
      mk('a', '与王梓核对综调网络拓扑图', at(2, 10), at(2, 11)),
      mk('b', '与王梓、刘少豪讨论立项材料', at(3, 10), at(3, 13)),
      // 有参会者 → via=attendee
      mk('c', '随便写点什么', at(4, 10), at(4, 11), { attendees: [{ email: 'me@x.com', self: true }, { email: 'li@x.com', displayName: '李工' }] }),
      // 线上 / 线下
      mk('d', '与客户对接', at(7, 10), at(7, 11), { location: '腾讯会议 888' }),
      mk('e', '与客户面谈', at(8, 10), at(8, 11), { location: '信息园区B1楼2楼会议室' }),
    ],
    range, timeZone: tz,
  });

  const wangzi = agg.topPeople.find((p) => p.name === '王梓');
  assert(wangzi, '应能统计到标题里的人名');
  assertEqual(wangzi.via, 'title', '来源应标注为"标题"');
  assertEqual(wangzi.count, 2, '王梓应出现 2 次');
  assertEqual(wangzi.hours, 4, '王梓合计 1+3=4 小时');
  const li = agg.topPeople.find((p) => p.name === '李工');
  assertEqual(li?.via, 'attendee', '有参会者时来源应标注为 attendee');

  // 同一条活动跨天时不应重复计人
  const sumCounts = agg.topPeople.reduce((s, p) => s + p.count, 0);
  assert(sumCounts >= 4, '人名计数应覆盖所有会议');

  // 时长分层：1h(常规) ×2、3h(超长) ×1、1h(常规) ×1、1h(常规) ×1
  const bucketOf = (id) => agg.durations.find((d) => d.id === id);
  assertEqual(bucketOf('xlong').count, 1, '3 小时的活动应落在超长档');
  assertEqual(bucketOf('normal').count, 4, '1 小时的应落在常规档');
  assertEqual(agg.durations.reduce((s, d) => s + d.count, 0), 5, '分层总数应等于计时条目数');

  // 地点：线上 1 / 线下 1 / 未填 3
  assertEqual(agg.locations.counts.virtual, 1, '线上 1 条');
  assertEqual(agg.locations.counts.onsite, 1, '线下 1 条');
  assertEqual(agg.locations.counts.unknown, 3, '未填地点 3 条');
  assertEqual(agg.locations.top[0].name, '信息园区B1楼2楼会议室', 'Top 地点应列出具体地点');
});

await test('导出报告：含字符条形图附录（任何文本查看器可读）', async () => {
  const { buildReviewCharts } = await import('../server/calendar/review-run.js');
  const { aggregateCalendar } = await import('../server/calendar/review.js');
  const { resolveReviewRange } = await import('../server/calendar/time.js');
  const tz = 'Asia/Shanghai';
  const now = new Date('2026-10-01T02:30:00Z');
  const range = resolveReviewRange({ preset: 'last-30d', now, timeZone: tz });
  const at = (d, h, m = 0) => new Date(Date.UTC(2026, 8, d, h - 8, m)).toISOString();
  const mk = (id, summary, start, end, extra = {}) => ({
    id, summary, start, end, attendees: [], status: 'confirmed', allDay: false, eventType: 'default', transparency: 'opaque', location: '', ...extra,
  });
  const agg = aggregateCalendar({
    events: [
      mk('a', '与王梓核对拓扑图', at(28, 10), at(28, 12)),
      mk('b', '设计开发排期', at(29, 14), at(29, 17)),
    ],
    range, timeZone: tz,
  });
  const charts = buildReviewCharts(agg);
  assertIncludes(charts, '附录 C', '应有图表附录');
  assertIncludes(charts, '按周工作负荷', '应有按周负荷图');
  assertIncludes(charts, '时间构成', '应有时间构成图');
  assertIncludes(charts, '█', '应用字符条绘制');
  assertIncludes(charts, '占用时间最多的人', '应有人名榜');
  assertIncludes(charts, '王梓', '人名榜应含解析出的人名');
  assertIncludes(charts, '活动时长分布', '应有时长分层图');
  assertIncludes(charts, '地点', '应有地点分组');
  assert(!charts.includes('```'), '不应使用代码围栏（纯文本查看器里会显示成反引号）');
  // 数字必须在条之前，这样即使字体不等宽、条错位，数字仍可读
  const weekLine = charts.split('\n').find((l) => l.includes('█') && l.includes('h ') );
  assert(weekLine && /^\d/.test(weekLine.trim()), '每行应以数字开头');

  // 零数据：不能崩，也不能画出一条假图
  const emptyAgg = aggregateCalendar({ events: [], range, timeZone: tz });
  const emptyCharts = buildReviewCharts(emptyAgg);
  assertIncludes(emptyCharts, '附录 C', '零数据也应有附录（说明没有数据）');
  assert(!emptyCharts.includes('████████████████████████'), '零数据不应画出满格条');
});

await test('本地文件错误不得被误报成 Google 网络/代理问题', async () => {
  const { wrapGoogleError } = await import('../server/calendar/google-api.js');
  // 真实踩过：写令牌临时文件 EPERM，却被提示"请配置代理"
  const err = Object.assign(new Error("EPERM: operation not permitted, open 'D:\\data\\google-token.json.tmp'"), {
    code: 'EPERM',
    path: 'D:\\data\\google-token.json.tmp',
  });
  const wrapped = wrapGoogleError(err, '列出日程');
  assertEqual(wrapped.code, 'LOCAL_IO_ERROR', '应归类为本地 IO 错误');
  assert(!wrapped.message.includes('代理'), '不应该提代理（会把人往错的方向带）');
  assertIncludes(wrapped.message, '不是网络问题', '应明确说明不是网络问题');
  assertIncludes(wrapped.message, '权限', '应指向权限/只读/安全软件');

  const noSpace = wrapGoogleError(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }), '列出日程');
  assertEqual(noSpace.code, 'LOCAL_IO_ERROR', '磁盘满是本地问题');
  assertIncludes(noSpace.message, '磁盘', '应指向磁盘空间');

  // 真正的网络错误仍然要给出代理指引（不能被这次修复误伤）
  const netErr = Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' });
  const netWrapped = wrapGoogleError(netErr, '列出日程');
  assertEqual(netWrapped.code, 'GOOGLE_NETWORK_ERROR', '网络错误仍应归类为网络问题');
});

/* -------------------------------------------------- 17. 操作审计 */

await test('操作审计：追加式台账可按类别/动作/关键词/失败筛选', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { appendAudit, listAudit, auditStats, auditFile } = await import('../server/store/audit.js');

  const file = auditFile();
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    if (fs.existsSync(file)) fs.rmSync(file);
    // 台账文件不存在时也不能报错
    assertEqual(listAudit({}).items.length, 0, '没有文件时应返回空列表');

    appendAudit('calendar.event.create', { target: '与王梓核对拓扑图', source: '从邮件生成', extra: { start: '2026-10-06 15:00' } });
    appendAudit('draft.send', { target: '月度报告提交', source: '界面确认发送', extra: { to: 'wang@client.com' } });
    appendAudit('draft.send', { target: '失败的邮件', ok: false, error: 'SMTP 535 鉴权失败' });
    appendAudit('calendar.event.delete', { target: '旧会议' });

    const all = listAudit({});
    assertEqual(all.items.length, 4, '应记到 4 条');
    // 新的在前
    assertEqual(all.items[0].target, '旧会议', '最新的应排在最前');

    // 按类别
    assertEqual(listAudit({ group: '日历' }).items.length, 2, '日历类应 2 条');
    assertEqual(listAudit({ group: '邮件' }).items.length, 2, '邮件类应 2 条');
    // 按动作
    assertEqual(listAudit({ action: 'draft.send' }).items.length, 2, '发送类应 2 条');
    // 按关键词（标题/主题）
    assertEqual(listAudit({ q: '王梓' }).items.length, 1, '应能按标题里的关键词搜到');
    assertEqual(listAudit({ q: 'Client.COM' }).items.length, 1, '关键词应不区分大小写，并能搜到收件人');
    // 只看失败
    const failed = listAudit({ ok: false });
    assertEqual(failed.items.length, 1, '只看失败应 1 条');
    assertIncludes(failed.items[0].error, '535', '失败原因要保留');

    // 统计
    const stats = auditStats();
    assertEqual(stats.total, 4, '总数');
    assertEqual(stats.byGroup.日历, 2, '日历计数');
    assertEqual(stats.byAction['draft.send'], 2, '动作计数');
    assert(stats.lastAt, '应给出最近一次时间');

    // 截断：limit 小于命中数时要标记 truncated
    const limited = listAudit({ limit: 2 });
    assertEqual(limited.items.length, 2, 'limit 生效');
    assertEqual(limited.truncated, true, '被截断要如实标记');
    assertEqual(limited.total, 4, '同时给出命中总数');

    // 写坏的行不能让整个列表挂掉
    fs.appendFileSync(file, '{这不是合法 JSON}\n', 'utf8');
    assertEqual(listAudit({}).items.length, 4, '坏行应被跳过，其余记录照常返回');
  } finally {
    if (backup === null) {
      if (fs.existsSync(file)) fs.rmSync(file);
    } else {
      fs.writeFileSync(file, backup, 'utf8');
    }
  }
});

await test('操作审计：审计失败绝不影响主流程', async () => {
  const { appendAudit } = await import('../server/store/audit.js');
  // 传一个无法序列化的 extra（循环引用）——JSON.stringify 会抛错
  const circular = {};
  circular.self = circular;
  const out = appendAudit('draft.send', { target: '循环引用', extra: circular });
  assertEqual(out, null, '写不进去时应返回 null 而不是抛错（发信已经完成了）');
});

/* -------------------------------------------------- 18. 待办闭环 */

await test('状态迁移：v1 老状态补齐到 v2 且不丢字段', async () => {
  const { migrateState, STATE_VERSION_FOR_TEST } = await import('../server/store/state.js');
  const v1 = {
    version: 1,
    runs: [{ id: 'r1' }],
    analyses: { 'INBOX:1': { folder: 'INBOX', uid: 1, needsReply: true } },
    drafts: [{ id: 'd1' }],
    reports: [{ id: 'rep1' }],
    calendar: { sessions: [{ id: 's1', messages: [{ role: 'user', content: 'hi' }] }] },
  };
  const mig = migrateState(v1);
  assertEqual(mig.from, 1, '应识别出老版本');
  assertEqual(mig.to, STATE_VERSION_FOR_TEST, '应迁移到当前版本');
  assertEqual(v1.version, STATE_VERSION_FOR_TEST, '版本号应被更新');
  assert(v1.tasks && typeof v1.tasks === 'object', '应补上 tasks');
  // 老数据一个都不能少
  assertEqual(v1.runs.length, 1, 'runs 保留');
  assertEqual(v1.drafts.length, 1, 'drafts 保留');
  assertEqual(v1.reports.length, 1, 'reports 保留');
  assertEqual(Object.keys(v1.analyses).length, 1, 'analyses 保留');
  assertEqual(v1.calendar.sessions[0].messages.length, 1, '会话消息保留');
  // 幂等：再迁移一次不应报错或改变内容
  const again = migrateState(v1);
  assertEqual(again.from, STATE_VERSION_FOR_TEST, '已是最新版本');
  // 畸形数据兜底（手改坏了也不能崩）
  const broken = { version: 2, analyses: null, drafts: 'oops', tasks: [1, 2], calendar: { sessions: [{ id: 'x' }] } };
  migrateState(broken);
  assertEqual(Array.isArray(broken.drafts), true, 'drafts 应被修正为数组');
  assertEqual(broken.analyses !== null, true, 'analyses 应为对象');
  assertEqual(Array.isArray(broken.tasks), false, 'tasks 应为对象（不是数组）');
  assertEqual(broken.calendar.sessions[0].messages.length, 0, '会话 messages 应兜底为空数组');
});

await test('待办状态：标记后从清单移出、可恢复，稍后提醒到期自动回来', async () => {
  const store = await import('../server/store/state.js');
  const { buildOverview } = await import('../server/ai/insight.js');
  const key = 'INBOX:9001';
  const other = 'INBOX:9002';
  const at = new Date().toISOString();
  store.upsertAnalyses([
    { folder: 'INBOX', uid: 9001, type: 'action_required', priority: 'high', needsReply: true, summary: '甲', analyzedAt: at, instanceId: 'test',
      mail: { subject: '要处理的事', from: { address: 'a@b.com', name: '甲' }, to: [{ address: 'me@x.com' }], cc: [], date: at } },
    { folder: 'INBOX', uid: 9002, type: 'action_required', priority: 'high', needsReply: true, summary: '乙', analyzedAt: at, instanceId: 'test',
      mail: { subject: '另一件事', from: { address: 'c@d.com', name: '乙' }, to: [{ address: 'me@x.com' }], cc: [], date: at } },
  ]);
  const ovNow = () => buildOverview({ instanceId: 'test', windowHours: 24 });
  const needKeys = () => ovNow().needAction.map((x) => x.key);
  assert(needKeys().includes(key) && needKeys().includes(other), '前置条件：两件都在清单里');
  // 自检是共享状态的：用**相对**数量断言，别被前面用例留下的待办干扰
  const base = ovNow().stats.needsReply;

  // 已处理 → 移出清单，但仍能翻回去
  store.setTask(key, { status: 'done', note: '回过了' });
  let ov = ovNow();
  assert(!ov.needAction.some((x) => x.key === key), '已处理的应移出清单');
  assertEqual(ov.stats.needsReply, base - 1, '统计只数未处理的（徽标要能清零）');
  assert(ov.taskGroups.done.some((x) => x.key === key), '应出现在「已处理」组里');
  assertEqual(ov.taskStates[key].note, '回过了', '备注应保留');

  // 忽略 → 同样移出，但归到「已忽略」
  store.setTask(other, { status: 'ignored' });
  ov = ovNow();
  assert(!ov.needAction.some((x) => x.key === other), '被忽略的应移出清单');
  assertEqual(ov.stats.needsReply, base - 2, '待办数应再少一个');
  assert(ov.taskGroups.ignored.some((x) => x.key === other), '应归到「已忽略」');

  // 稍后提醒（未来）→ 隐藏；过期 → 自动回到清单
  store.setTask(key, { status: 'snoozed', snoozeUntil: new Date(Date.now() + 3_600_000).toISOString() });
  ov = ovNow();
  assert(!ov.needAction.some((x) => x.key === key), '未到时间的稍后提醒应隐藏');
  assert(ov.taskGroups.snoozed.some((x) => x.key === key), '应归到「稍后提醒」');
  store.setTask(key, { status: 'snoozed', snoozeUntil: new Date(Date.now() - 1000).toISOString() });
  ov = ovNow();
  assert(ov.needAction.some((x) => x.key === key), '到时间的稍后提醒必须自动回来（否则永远出不来）');
  // 时间字段被写坏也要能回来，不能永远卡在稍后里
  store.setTask(key, { status: 'snoozed', snoozeUntil: '不是时间' });
  ov = ovNow();
  assert(ov.needAction.some((x) => x.key === key), '提醒时间非法时应回到清单');

  // 恢复为待办 → 记录被删除（不为"点了一下又撤销"留下垃圾）
  store.setTask(key, { status: 'open' });
  assert(!store.getState().tasks[key], '回到 open 应删掉状态记录');
  ov = ovNow();
  assert(ov.needAction.some((x) => x.key === key), '恢复后应回到清单');
  assertEqual(ov.stats.needsReply, base - 1, '恢复一件后应比基线少 1（另一件仍被忽略）');

  // 清理
  store.setTask(other, { status: 'open' });
  delete store.getState().analyses[key];
  delete store.getState().analyses[other];
  store.persistState();
});

await test('待办状态：分析记录被收敛后不留孤儿标记', async () => {
  const store = await import('../server/store/state.js');
  store.upsertAnalyses([{ folder: 'INBOX', uid: 9100, type: 'action_required', needsReply: true, analyzedAt: new Date().toISOString(), mail: { subject: 'x' } }]);
  store.setTask('INBOX:9100', { status: 'ignored' });
  assert(store.listTasks().some((t) => t.key === 'INBOX:9100'), '前置条件：有标记');
  delete store.getState().analyses['INBOX:9100'];
  store.persistState();
  assert(!store.listTasks().some((t) => t.key === 'INBOX:9100'), '分析记录没了，标记也应清掉（否则 state 无限增长）');
});

await test('定时分析：成功路径会记录结果（能算出拉取/分析/待办数）', async () => {
  const cfg = getConfig();
  const saved = JSON.parse(JSON.stringify(cfg.schedule || {}));
  const store = await import('../server/store/state.js');
  const { runScheduledScan, schedulerStatus } = await import('../server/schedule.js');
  const { partsInZone } = await import('../server/calendar/time.js');
  const tz = cfg.calendar?.timeZone || 'Asia/Shanghai';
  const p = partsInZone(new Date(), tz);
  const nowSlot = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  try {
    cfg.schedule = { enabled: true, times: [nowSlot], days: [0, 1, 2, 3, 4, 5, 6], windowHours: 24 };
    store.setScheduleState({ lastSlot: null, lastRunAt: null, lastResult: null, lastError: null });

    const out = await runScheduledScan();
    assertEqual(out.skipped, false, '应真的执行');
    assert(!out.error, `本次模拟邮箱可用，不应失败（实际 ${out.error || ''}）`);
    const st = schedulerStatus();
    assert(st.lastRunAt, '应记录执行时间');
    assert(st.lastResult, '应记录本次结果');
    assertEqual(typeof st.lastResult.fetched, 'number', '应记下拉取封数');
    assertEqual(typeof st.lastResult.analyzed, 'number', '应记下分析封数');
    assertEqual(st.lastError, null, '成功时不该有错误');
    assertEqual(st.enabled, true, '状态应反映已开启');
  } finally {
    store.setScheduleState({ lastSlot: null, lastRunAt: null, lastResult: null, lastError: null });
    cfg.schedule = saved;
  }
});

/* -------------------------------------------------- 19. 需留意 / 窗口口径 */

await test('需留意：判定必须收敛，不能把「需留意」变成第二个收件箱', async () => {
  const { isWorthNoting } = await import('../server/mail/recipient.js');
  const base = { needsReply: false, priority: 'high', type: 'notification', worthNoting: true };
  assertEqual(isWorthNoting(base), true, '有期限的通知应进「需留意」');
  assertEqual(isWorthNoting({ ...base, priority: 'urgent' }), true, '紧急也应进');
  // 低优先级不占首页注意力
  assertEqual(isWorthNoting({ ...base, priority: 'low' }), false, '低优先级不进');
  // 纯知会与垃圾不进
  assertEqual(isWorthNoting({ ...base, type: 'fyi' }), false, '纯知会不进');
  assertEqual(isWorthNoting({ ...base, type: 'spam' }), false, '垃圾邮件不进');
  // 与「需要你处理」互斥：需要回复的已在上面那份清单里，不能两处都出现
  assertEqual(isWorthNoting({ ...base, needsReply: true, recipientKind: 'direct' }), false, '需要回复的不进（避免重复）');
  // 历史记录没有 worthNoting 字段 → 一律 false（不改变旧数据行为）
  assertEqual(isWorthNoting({ needsReply: false, priority: 'high', type: 'notification' }), false, '老记录（无字段）不进');
  assertEqual(isWorthNoting(null), false, '空值安全');
});

await test('分类：worthNoting 与 needsReply 互斥，垃圾邮件一律不进', async () => {
  const { classifyMails } = await import('../server/ai/analyze.js');
  const mail = { folder: 'INBOX', uid: 1, messageId: '<x@y>', subject: 's', body: 'b' };
  const mails = [mail, { ...mail, uid: 2 }, { ...mail, uid: 3 }, { ...mail, uid: 4 }];
  // 走真实分类管道（只把模型调用换成桩），这样归一化规则是真的被执行到的
  const client = {
    ...new LlmClient(activeConfig.llm),
    completeJson: async () => ({
      data: {
        items: [
          { index: 1, type: 'notification', priority: 'high', needsReply: false, worthNoting: true, summary: 'a' },
          { index: 2, type: 'action_required', priority: 'high', needsReply: true, worthNoting: true, summary: 'b' },
          { index: 3, type: 'spam', priority: 'high', needsReply: false, worthNoting: true, summary: 'c' },
          { index: 4, type: 'notification', priority: 'normal', needsReply: false, summary: '漏填的' },
        ],
      },
      model: 'test-model',
    }),
  };
  const rows = await classifyMails({ mails, client, config: activeConfig });
  assertEqual(rows[0].worthNoting, true, '不需回复 + 有期限应保留');
  assertEqual(rows[1].worthNoting, false, '需要回复的必须清掉 worthNoting（互斥）');
  assertEqual(rows[2].worthNoting, false, '垃圾邮件不进');
  assertEqual(rows[3].worthNoting, false, '模型漏填时默认 false（宁可少提醒）');
});

await test('精确窗口：IMAP SINCE 只精确到天，多带的邮件必须滤掉', async () => {
  const { filterByExactWindow } = await import('../server/ai/engine.js');
  const now = Date.now();
  const since = now - 24 * 3600_000;
  const mails = [
    { uid: 1, date: new Date(now - 3600_000).toISOString() },
    { uid: 2, date: new Date(now - 23 * 3600_000).toISOString() },
    { uid: 3, date: new Date(now - 30 * 3600_000).toISOString() },
    { uid: 4, date: new Date(now - 43 * 3600_000).toISOString() },
    { uid: 5 },
    { uid: 6, date: '不是时间' },
    { uid: 7, date: new Date(since).toISOString() },
  ];
  const { kept, dropped } = filterByExactWindow(mails, since);
  assertEqual(dropped, 2, '应滤掉 2 封窗口外的');
  assertEqual(
    kept.map((m) => m.uid).join(','),
    '1,2,5,6,7',
    `保留的应是窗口内与时间未知的（实际 ${kept.map((m) => m.uid)}）`,
  );
  // 边界参数异常时不应把邮件全丢掉
  assertEqual(filterByExactWindow(mails, NaN).kept.length, mails.length, '窗口非法时应原样保留');
});

await test('简报输入：统计是"程序算出的事实"，并被要求不得自造数量', async () => {
  const { buildReportPrompt, REPORT_SYSTEM } = await import('../server/llm/prompts.js');
  const prompt = buildReportPrompt({
    stats: { total: 5, needsReply: 0, attention: 0 },
    analyses: [
      {
        priority: 'high',
        type: 'meeting',
        needsReply: false,
        worthNoting: true,
        summary: '10月8日技术架构会',
        mail: { subject: '会议通知', from: { address: 'a@b.com' }, date: '2026-10-05' },
      },
      {
        priority: 'high',
        type: 'action_required',
        needsReply: true,
        summary: '要回信',
        mail: { subject: '请确认', from: { address: 'c@d.com' }, date: '2026-10-05' },
      },
    ],
    windowHours: 24,
    drafts: 0,
  });
  // 「需回复 0」这个事实必须明确给到模型
  assertIncludes(prompt, '需回复（对应界面的「需要你处理」）：0 封', '应把本地口径的数字明确写进输入');
  assertIncludes(prompt, '窗口内共 5 封邮件', '应说明是"窗口内"而不是"本次拉取"');
  assertIncludes(prompt, '[需留意]', '需留意的邮件应打标，供模型区分');
  // 约束：数字不得改写、需回复为 0 时该节只能写「无」
  assertIncludes(REPORT_SYSTEM, '不得自行加减', '应禁止模型自造数量');
  assertIncludes(REPORT_SYSTEM, '需回复为 0 时，这一节只写「无」', '应禁止用通知类填充「需要你处理」');
  assertIncludes(REPORT_SYSTEM, '对不上就是自相矛盾', '应说明为什么不能乱写数字');
});

await test('复用：已有草稿的邮件不再重复分类（真的省下模型调用）', async () => {
  /*
   * 这是"预检低估花费"的另一半修法：光把文案改准还不够，
   * 已经处置过（有草稿）的邮件不该每轮都重新分类一遍。
   * 复用条件故意收得很紧：**已有分析记录 且 已有草稿**——
   * 否则分类提示词演进（如新增 worthNoting）后，老邮件永远拿不到新字段。
   */
  const { runScan } = await import('../server/ai/engine.js');
  const store = await import('../server/store/state.js');
  const { previewScan } = await import('../server/ai/engine.js');

  // 造一封"已有分析 + 已有草稿"的邮件：直接对窗口内第一封邮件塞一条草稿
  const analyzed = store.listAnalyses({ instanceId: 'test', limit: 50 });
  assert(analyzed.length > 0, '前置条件：应已有分析记录');
  const target = analyzed[0];
  const draftId = `draft_reuse_${target.uid}`;
  store.addDraft({
    id: draftId,
    instanceId: 'test',
    status: 'sent',
    subject: 'Re: 复用测试',
    to: target.mail?.from?.address || 'a@b.com',
    body: '已处理',
    createdAt: new Date().toISOString(),
    sentAt: new Date().toISOString(),
    source: { folder: target.folder, uid: target.uid, messageId: target.mail?.messageId || null },
  });

  // 预检应把它算进"会复用"
  const preview = await previewScan({ instanceId: 'test', windowHours: 24 });
  assert(preview.reusable >= 1, `预检应算出至少 1 封可复用（实际 ${preview.reusable}）`);

  // 真跑一轮：LLM 的 classify 调用数应少于窗口内邮件数
  const before = llm.calls.filter((c) => c.kind === 'classify').length;
  const result = await runScan({ instanceId: 'test', windowHours: 24, trigger: 'test' });
  const after = llm.calls.filter((c) => c.kind === 'classify').length;
  assert(result.reused >= 1, `运行结果应报告复用封数（实际 ${result.reused}）`);
  assertEqual(result.reused + (result.analyzed - result.reused), result.analyzed, 'analyzed 应包含复用的那封');
  // 复用的那封不该产生模型调用：真正送给模型的封数 = analyzed - reused
  const classifyCalls = after - before;
  assert(
    classifyCalls <= result.analyzed - result.reused,
    `分类调用数（${classifyCalls}）不应超过真正需要分类的封数（${result.analyzed - result.reused}）`,
  );

  // 复用的邮件必须**仍然**出现在列表里（漏了 folder/uid 会静默丢掉它）
  const kept = store.getAnalysis(target.folder, target.uid);
  assert(kept, '复用的邮件必须仍然有分析记录（否则会从清单里消失）');
  assertEqual(kept.uid, target.uid, '复用记录的 uid 必须是本轮的（漏了会导致 upsert 被跳过）');

  // 清理
  store.removeDraft(draftId);
  store.persistState();
});

await test('存储：占用体检能认出孤儿归档，清理只删没人引用的文件', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { getPaths } = await import('../server/config/index.js');
  const store = await import('../server/store/state.js');
  const p = getPaths();
  fs.mkdirSync(p.rawDir, { recursive: true });

  /*
   * 造三个归档：
   *   A. 有分析记录指向 → 必须保留
   *   B. 没人指向 → 孤儿，该删
   *   C. 有分析记录但文件很旧 + 设了保留期 → 该按保留期删
   */
  const withOwner = { folder: 'INBOX', uid: 77001, messageId: '<own@x>' };
  store.upsertAnalyses([{ ...withOwner, type: 'fyi', needsReply: false, analyzedAt: new Date().toISOString(), mail: { subject: '有主的' } }]);
  const ownedFile = path.join(p.rawDir, store.rawFileName(withOwner.folder, withOwner.uid, withOwner.messageId));
  const orphanFile = path.join(p.rawDir, 'INBOX__77002__deadbeef.eml');
  fs.writeFileSync(ownedFile, 'X'.repeat(2048));
  fs.writeFileSync(orphanFile, 'Y'.repeat(1024));

  const stats = store.storageStats();
  assertEqual(stats.orphan.count, 1, `应认出 1 个孤儿（实际 ${stats.orphan.count}）`);
  assertEqual(stats.orphan.bytes, 1024, '孤儿占用应统计出来');
  assert(stats.raw.count >= 2, '原文总数应包含有主与孤儿');

  // 只清孤儿：有主的必须留下
  const out = store.cleanupRawArchives({ includeOrphans: true, retentionDays: 0 });
  assertEqual(out.orphans, 1, '应删掉 1 个孤儿');
  assertEqual(fs.existsSync(orphanFile), false, '孤儿文件应被删除');
  assertEqual(fs.existsSync(ownedFile), true, '有主的文件绝不能被删（那才是可查询的历史）');

  // 保留期清理：把有主文件的时间改成 100 天前，设 30 天保留 → 该删
  const old = Date.now() - 100 * 86_400_000;
  fs.utimesSync(ownedFile, new Date(old), new Date(old));
  const out2 = store.cleanupRawArchives({ includeOrphans: true, retentionDays: 30 });
  assertEqual(out2.expired, 1, '超期的有主文件应按保留期删除');
  assertEqual(fs.existsSync(ownedFile), false, '超期文件应被删除');
  // 结论类历史仍在（这才是关键：清原文不等于清历史）
  assert(store.getAnalysis('INBOX', 77001), '清理原文后分析记录必须还在');

  // 保留天数为 0 = 永久保留：不删有主文件
  fs.writeFileSync(ownedFile, 'Z'.repeat(512));
  const out3 = store.cleanupRawArchives({ includeOrphans: true, retentionDays: 0 });
  assertEqual(out3.expired, 0, '保留天数为 0 时不得按时间删除');
  assertEqual(fs.existsSync(ownedFile), true, '永久保留时文件应还在');

  // 清理
  try {
    fs.unlinkSync(ownedFile);
  } catch {
    /* ignore */
  }
  delete store.getState().analyses['INBOX:77001'];
  store.persistState();
});

await test('存储：分析记录上限可配置（旧版本写死 3000）', async () => {
  const store = await import('../server/store/state.js');
  const config = getConfig();
  const backup = config.retention ? { ...config.retention } : null;
  try {
    config.retention = { ...(config.retention || {}), maxAnalyses: 3 };
    assertEqual(store.maxAnalysesLimit(), 3, '应读取配置里的上限');

    /*
     * 造 5 条**最新**的记录（时间排在将来，确保它们是最新的那一批），
     * 这样无论自检此前已经积累了别的记录，收敛结果都是确定的。
     */
    const at = (min) => new Date(Date.now() + min * 60_000).toISOString();
    const keys = [];
    for (let i = 0; i < 5; i += 1) {
      const uid = 88000 + i;
      keys.push(`INBOX:${uid}`);
      store.getState().analyses[`INBOX:${uid}`] = { folder: 'INBOX', uid, type: 'fyi', analyzedAt: at(i), mail: { subject: `s${i}` } };
    }
    store.persistState();
    const total = Object.keys(store.getState().analyses).length;
    assertEqual(total, 3, `分析记录应收敛到配置的上限 3（实际 ${total}）`);
    assertEqual(!!store.getState().analyses['INBOX:88004'], true, '最新的必须保留');
    assertEqual(!!store.getState().analyses['INBOX:88000'], false, '最旧的应被删掉');
    for (const k of keys) delete store.getState().analyses[k];
  } finally {
    if (backup) config.retention = backup;
    store.persistState();
  }
});

/* -------------------------------------------------- 20. 备份与恢复 */

await test('ZIP：自写读写能往返（含中文名、空文件、二进制），且损坏能被发现', async () => {
  const { createZip, readZip, crc32, isSafeEntryName } = await import('../server/lib/zip.js');
  // CRC32 对标准向量，确保不是"自己和自己一致"的假通过
  assertEqual(crc32(Buffer.from('abc')).toString(16), '352441c2', 'CRC32 应与标准值一致');

  const entries = [
    { name: 'manifest.json', data: '{"a":1}' },
    { name: 'reports/日报 2026-10-06.md', data: '# 简报\n'.repeat(100) },
    { name: 'empty.txt', data: '' },
    { name: 'bin.dat', data: Buffer.from([0, 1, 2, 250, 255]) },
  ];
  const zip = createZip(entries);
  const back = readZip(zip);
  assertEqual(back.length, entries.length, '条目数应一致');
  // 名字可能被排序，按名字取回逐个比内容
  for (const e of entries) {
    const got = back.find((x) => x.name === e.name);
    assert(got, `应能读回「${e.name}」`);
    assertEqual(got.data.toString('binary'), Buffer.from(e.data).toString('binary'), `「${e.name}」内容应一致`);
  }
  // 压缩确实生效（100 行重复文本应明显变小）
  assert(zip.length < Buffer.byteLength(entries[1].data), '重复文本应被压缩');

  // 损坏检测：翻转数据区一个字节必须报错，而不是静默给出坏数据
  const broken = Buffer.from(zip);
  broken[45] ^= 0xff;
  let code = null;
  try {
    readZip(broken);
  } catch (err) {
    code = err.message;
  }
  assert(code, '数据损坏必须被发现');
  // 非 zip / 截断
  for (const bad of [Buffer.from('这不是 zip'.repeat(20)), zip.subarray(0, 30)]) {
    let msg = null;
    try {
      readZip(bad);
    } catch (err) {
      msg = err.message;
    }
    assert(msg, '非 zip 或截断内容应报错');
  }
  // zip-slip 防护（导入的是外部文件，必须假设它恶意）
  assertEqual(isSafeEntryName('../evil'), false, '上级目录应被拒');
  assertEqual(isSafeEntryName('/abs'), false, '绝对路径应被拒');
  assertEqual(isSafeEntryName('C:\\x'), false, 'Windows 绝对路径应被拒');
  assertEqual(isSafeEntryName('ok/name.txt'), true, '正常文件名应通过');
});

await test('备份：导出默认抹掉密钥、可选用包含；导入保留本机密钥并自动留退路', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { getPaths, loadConfig } = await import('../server/config/index.js');
  const backup = await import('../server/lib/backup.js');
  const { readZip } = await import('../server/lib/zip.js');
  const p = getPaths();

  // 当前（本机）配置里放几个"密钥"，并确保磁盘上的 config.json 里有它们
  const config = getConfig();
  const backupConfig = JSON.parse(JSON.stringify(config));
  const diskFile = p.configFile;
  const diskBefore = fs.existsSync(diskFile) ? fs.readFileSync(diskFile, 'utf8') : null;
  try {
    const onDisk = diskBefore ? JSON.parse(diskBefore) : { instances: [], llm: {}, web: {}, calendar: { google: {} } };
    onDisk.instances = (onDisk.instances?.length ? onDisk.instances : config.instances).map((i) => ({
      ...i,
      imap: { ...(i.imap || {}), authPass: 'DISK-IMAP-SECRET' },
      smtp: { ...(i.smtp || {}), authPass: 'DISK-SMTP-SECRET' },
    }));
    onDisk.llm = { ...(onDisk.llm || {}), apiKey: 'DISK-LLM-SECRET' };
    onDisk.calendar = { ...(onDisk.calendar || {}), google: { clientSecret: 'DISK-GOOGLE-SECRET' } };
    fs.mkdirSync(path.dirname(diskFile), { recursive: true });
    fs.writeFileSync(diskFile, JSON.stringify(onDisk, null, 2));
    loadConfig({ force: true });

    // 1) 默认导出：密钥必须被抹掉
    const plain = backup.buildBackup({ now: new Date() });
    const plainFiles = readZip(plain.buffer);
    const plainCfg = JSON.parse(plainFiles.find((f) => f.name === 'config.json').data.toString('utf8'));
    assertEqual(plainCfg.instances[0].imap.authPass, '', '默认导出不得包含邮箱授权码');
    assertEqual(plainCfg.llm.apiKey, '', '默认导出不得包含 API Key');
    assertEqual(plainCfg.calendar.google.clientSecret, '', '默认导出不得包含 Google 密钥');
    assert(!plainFiles.some((f) => f.name === '.env'), '默认导出不得包含 .env');
    assert(!plainFiles.some((f) => f.name.startsWith('raw/')), '默认导出不得包含邮件原文');
    assert(plain.manifest.excluded.length >= 2, 'manifest 必须如实列出"没有包含什么"');
    assert(plainFiles.some((f) => f.name === 'README.txt'), '包内应有 README 说明');
    assert(plainFiles.some((f) => f.name === 'manifest.json'), '包内应有 manifest');

    // 2) 显式包含：这次才有
    const withSecrets = backup.buildBackup({ includeSecrets: true, now: new Date() });
    const wsCfg = JSON.parse(readZip(withSecrets.buffer).find((f) => f.name === 'config.json').data.toString('utf8'));
    assertEqual(wsCfg.llm.apiKey, 'DISK-LLM-SECRET', '显式要求时应包含密钥');

    // 3) 检查（不落盘）：能读懂清单
    const info = backup.inspectBackup(plain.buffer);
    assertEqual(info.manifest.format, 'mailbot-backup', '应识别为本程序的备份');
    assert(info.restorable.includes('state.json'), '应认出 state.json 可恢复');

    // 4) 导入：覆盖数据、**保留本机密钥**、并留下退路
    const stateBefore = fs.readFileSync(p.stateFile, 'utf8');
    const out = backup.importBackup(plain.buffer, { confirm: true, now: new Date() });
    assert(out.restored.includes('state.json'), '应恢复了 state.json');
    assert(out.safetyBackup, '导入前必须自动备份当前数据（可回滚）');
    assert(fs.existsSync(out.safetyBackup), '退路文件应真的存在');
    // 关键：备份里密钥是空的，导入后磁盘上必须仍是本机原来的值
    const afterCfg = JSON.parse(fs.readFileSync(p.configFile, 'utf8'));
    const diskAuth = afterCfg.instances?.[0]?.imap?.authPass;
    assert(diskAuth === 'DISK-IMAP-SECRET', `导入后应保留本机密钥（实际 ${JSON.stringify(diskAuth)}）`);
    assertEqual(afterCfg.llm?.apiKey, 'DISK-LLM-SECRET', 'API Key 也应保留本机值');

    // 5) 没有 confirm 时必须拒绝
    let code = null;
    try {
      backup.importBackup(plain.buffer, {});
    } catch (err) {
      code = err.code;
    }
    assertEqual(code, 'CONFIRM_REQUIRED', '导入必须显式确认');

    // 6) 不是本程序的包要明确报错，而不是"恢复"出一堆垃圾
    const alien = (await import('../server/lib/zip.js')).createZip([{ name: 'hello.txt', data: 'x' }]);
    let alienCode = null;
    try {
      backup.inspectBackup(alien);
    } catch (err) {
      alienCode = err.code;
    }
    assertEqual(alienCode, 'BACKUP_BAD_FORMAT', '外来 zip 应被拒');

    // 还原现场
    fs.writeFileSync(p.stateFile, stateBefore);
    if (diskBefore === null) fs.rmSync(p.configFile, { force: true });
    else fs.writeFileSync(p.configFile, diskBefore);
    loadConfig({ force: true });
    (await import('../server/store/state.js')).resetStateCache();
    (await import('../server/store/state.js')).loadState({ force: true });
  } finally {
    Object.assign(config, backupConfig);
  }
});

/* ------------------------------------------------------------ 收尾 */

await imap.close();
await smtp.close();
await llm.close();

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
}
console.log(`\n测试数据目录：${tmpDir}`);

process.exitCode = failures.length ? 1 : 0;
