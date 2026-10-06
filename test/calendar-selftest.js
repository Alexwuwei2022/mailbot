/**
 * 日历数字人离线自检。
 *
 * 全程离线：Google Calendar / OAuth 端点由本地模拟服务器提供（真实 HTTP + 真实 REST 语义），
 * 大模型由 mock LLM 提供。覆盖：时区换算 → OAuth → REST CRUD → 对话建日程 → 邮件转日程 → 日程分析。
 *
 *   node test/calendar-selftest.js
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbot-cal-'));

process.env.MAILBOT_DATA_DIR = tmpDir;
process.env.MAILBOT_LOG_LEVEL = process.env.MAILBOT_LOG_LEVEL || 'warn';
process.env.MAILBOT_NO_DOTENV = '1';
delete process.env.MAILBOT_GOOGLE_API_BASE;
delete process.env.MAILBOT_GOOGLE_OAUTH_BASE;
delete process.env.MAILBOT_GOOGLE_TOKEN_BASE;

const { loadConfig, resetConfigCache, getConfig } = await import('../server/config/index.js');
const time = await import('../server/calendar/time.js');
const auth = await import('../server/calendar/google-auth.js');
const gapi = await import('../server/calendar/google-api.js');
const service = await import('../server/calendar/service.js');
const store = await import('../server/store/state.js');
const mocks = await import('./mocks-google.js');
/** 邮件侧模拟器（IMAP/SMTP 与邮件构造工具） */
const mailMocks = await import('./mocks.js');

/* ------------------------------------------------------------ 断言 */

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, message: err?.stack || String(err) });
    console.log(`  ✗ ${name}\n      ${err?.message || err}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function assertIncludes(hay, needle, msg) {
  if (!String(hay).includes(needle)) throw new Error(`${msg || '未包含'}：期望包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(String(hay).slice(0, 240))}`);
}

/**
 * 删除临时目录。Windows 上刚写过的文件偶尔还被句柄占着（EPERM），
 * 直接 rmSync 会让「清理失败」变成一个和被测逻辑无关的假失败，因此这里容忍并重试。
 */
function rmTempDir(dir) {
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // 等一小会儿让句柄释放后再试（Atomics.wait 是同步睡眠，不占用 CPU）
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      } catch {
        /* ignore */
      }
    }
  }
  // 仍然失败就留给系统临时目录清理：不影响测试结论
}

/* ------------------------------------------------------------ 环境 */

// 固定「现在」：2026-09-27（周日）14:30 北京时间 → 06:30 UTC
const NOW = new Date('2026-09-27T06:30:00Z');
const TZ = 'Asia/Shanghai';

const google = await mocks.startMockGoogle({
  events: [
    // 今天 10:00–11:00（北京）
    { summary: '周会', start: '2026-09-27T10:00:00+08:00', end: '2026-09-27T11:00:00+08:00', location: '会议室 A' },
    // 今天 10:30–11:30，与上一条重叠
    { summary: '客户沟通', start: '2026-09-27T10:30:00+08:00', end: '2026-09-27T11:30:00+08:00' },
    // 明天 09:00–09:30
    { summary: '站会', start: '2026-09-28T09:00:00+08:00', end: '2026-09-28T09:30:00+08:00' },
    // 明天全天
    { summary: '出差', allDay: true, start: '2026-09-28', end: '2026-09-29' },
  ],
});

// 大模型：按提示词判断意图，返回结构化结果
let llmCalls = [];
const llm = await mocks2StartMockLlm({
  handler: (prompt) => {
    // 邮件分类（自动补分析时会走到这里）：按提示词里的编号生成条目
    if (prompt.includes('资深企业邮件助理') || (/"items"/.test(prompt) && /分类取值/.test(prompt))) {
      const count = (prompt.match(/^#\d+$/gm) || []).length || 1;
      return JSON.stringify({
        items: Array.from({ length: count }, (_v, i) => ({
          index: i + 1,
          type: 'action_required',
          priority: 'high',
          needsReply: true,
          summary: '邮件里要求 9 月 30 日前提交材料。',
          action: '在 9 月 30 日前提交材料',
          reason: '邮件明确写了截止时间',
        })),
      });
    }
    // 检索结果分析
    if (prompt.includes('检索结果分析师')) {
      const n = (prompt.match(/^### \d+\. /gm) || []).length;
      return `## 结论\n共找到 ${n} 封相关邮件，其中包含需要你处理的事项。\n\n## 相关邮件\n- [2026-09-30] 王经理：月度报告提交提醒 — 需在 9 月 30 日前提交\n\n## 需要注意\n1. 9 月 30 日为截止日期`;
    }
    // 检索意图解析
    if (prompt.includes('检索意图解析器')) {
      const q = prompt.split('## 用户的检索要求')[1] || '';
      // 注意分支顺序：更具体的条件必须排在前面，否则「抄送给我的重要邮件」会被「重要」抢走
      if (/抄送/.test(q)) {
        return JSON.stringify({
          understood: '查找仅抄送给我的邮件',
          action: 'search',
          needMore: false,
          filters: { dateFrom: '2026-08-28', dateTo: '2026-09-27', recipientKind: 'cc', limit: 30 },
          sort: 'date_desc',
        });
      }
      if (/张总|张/.test(q) && /合同/.test(q)) {
        return JSON.stringify({
          understood: '查找发件人含「张总」且主题或内容含「合同」的邮件',
          action: 'search',
          needMore: false,
          filters: { dateFrom: '2026-08-28', dateTo: '2026-09-27', from: ['张总', 'zhang'], subject: ['合同'], content: ['合同'], limit: 30 },
          sort: 'date_desc',
        });
      }
      if (/高优先级|重要/.test(q)) {
        return JSON.stringify({
          understood: '查找需要我处理的高优先级邮件',
          action: 'search',
          needMore: false,
          filters: { dateFrom: '2026-08-28', dateTo: '2026-09-27', priorities: ['urgent', 'high'], needsReply: true, limit: 30 },
          sort: 'priority',
        });
      }
      if (/多久|十年|随意/.test(q)) {
        return JSON.stringify({ understood: '时间范围过长', action: 'search', needMore: false, filters: { dateFrom: '2015-01-01', dateTo: '2026-09-27' }, sort: 'date_desc' });
      }
      if (/不知道/.test(q)) {
        return JSON.stringify({ understood: '', action: 'search', needMore: true, question: '你想找哪个发件人、或者哪个关键词的邮件？' });
      }
      // 时区边界用例：只查「9 月」，而目标邮件的时间戳落在 8/31 UTC
      if (/边界/.test(q)) {
        return JSON.stringify({
          understood: '查找 9 月里「边界测试」发来的邮件',
          action: 'search',
          needMore: false,
          filters: { dateFrom: '2026-09-01', dateTo: '2026-09-30', from: ['边界'], limit: 30 },
          sort: 'date_desc',
        });
      }
      return JSON.stringify({
        understood: '关键词检索',
        action: 'search',
        needMore: false,
        filters: { dateFrom: '2026-08-28', dateTo: '2026-09-27', content: [q.trim().slice(0, 8) || 'xx'], limit: 30 },
        sort: 'date_desc',
      });
    }
    // 邮件转日程
    if (prompt.includes('邮件时间信息提取器')) {
      if (/没有任何时间|无时间信息/.test(prompt)) return JSON.stringify({ events: [], note: '邮件里没有明确时间' });
      return JSON.stringify({
        events: [
          {
            summary: '提交月度报告（来自：王经理）',
            startLocal: '2026-09-30 17:00',
            durationMinutes: 60,
            description: '来自邮件：wang@client.com　请于 9 月 30 日前提交月度报告',
            confidence: 0.9,
            evidence: '请于 9 月 30 日前提交月度报告',
            kind: 'deadline',
          },
        ],
      });
    }
    // 日程分析
    if (prompt.includes('日程分析师')) {
      return '## 一句话总结\n今天有两场时间重叠的会议，需要调整。\n\n## 今日与明日\n今天 10:00 周会与 10:30 客户沟通重叠。\n\n## 未来 7 天概览\n明天以站会与全天出差为主。\n\n## 需要注意\n1. 今天两场会议时间重叠';
    }
    // 对话解析
    if (prompt.includes('时间解析器')) {
      const lastUser = prompt.split('## 用户本轮输入')[1] || '';
      if (/下周三.*评审|评审.*下周三/.test(lastUser)) {
        return JSON.stringify({
          action: 'create',
          needMore: false,
          event: { summary: '项目评审会', startLocal: '2026-09-30 14:00', durationMinutes: 90, location: '会议室 B', attendees: [{ email: 'li@client.com', displayName: '李工' }] },
          confidence: 0.9,
          reason: '用户要求下周三下午两点开评审会',
          assumptions: ['未说明结束时间，按 90 分钟处理'],
        });
      }
      if (/明天下午三点|明天.*15点|明天下午3点/.test(lastUser)) {
        return JSON.stringify({
          action: 'create',
          needMore: false,
          event: { summary: '和客户的电话沟通', startLocal: '2026-09-28 15:00', durationMinutes: 30 },
          confidence: 0.85,
          reason: '明天下午三点与客户通话',
          assumptions: ['未说明结束时间，按 30 分钟处理'],
        });
      }
      if (/安排个事|开个会$|随便安排/.test(lastUser)) {
        return JSON.stringify({ action: 'create', needMore: true, question: '这个日程安排在什么时间？大概需要多久？' });
      }
      if (/看看|有什么安排|这周怎么样/.test(lastUser)) {
        return JSON.stringify({ action: 'list', needMore: false, reason: '用户想查看日程安排' });
      }
      if (/明天.*9[:：]15|临时讨论/.test(lastUser)) {
        return JSON.stringify({
          action: 'create',
          needMore: false,
          event: { summary: '临时讨论', startLocal: '2026-09-28 09:15', durationMinutes: 30 },
          confidence: 0.8,
          reason: '明天 9:15 临时讨论',
        });
      }
      return JSON.stringify({ action: 'create', needMore: true, question: '请告诉我日程的时间。' });
    }
    return JSON.stringify({ ok: true });
  },
});

// 简易 mock LLM（与 test/mocks.js 的 startMockLlm 同构，避免跨文件环境变量耦合）
async function mocks2StartMockLlm({ handler }) {
  const http = await import('node:http');
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
      llmCalls.push(parsed);
      const prompt = parsed.messages?.map((m) => m.content).join('\n') || '';
      const content = handler(prompt);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'mock',
          model: parsed.model || 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

process.env.MAILBOT_GOOGLE_API_BASE = google.apiBase;
process.env.MAILBOT_GOOGLE_OAUTH_BASE = google.oauthBase;
process.env.MAILBOT_GOOGLE_TOKEN_BASE = google.tokenBase;

resetConfigCache();
loadConfig({ rootDir: root, force: true });
const config = getConfig();
config.calendar.enabled = true;
config.calendar.timeZone = TZ;
config.calendar.calendarId = 'primary';
config.calendar.lookaheadDays = 7;
config.calendar.maxFromEmails = 5;
config.calendar.google.clientId = 'test-client-id.apps.googleusercontent.com';
config.calendar.google.clientSecret = 'test-client-secret';
config.calendar.google.redirectUri = 'http://127.0.0.1:8799/api/calendar/oauth/callback';
config.llm = { ...config.llm, baseUrl: llm.baseUrl, apiKey: 'test', model: 'mock', maxRetries: 1 };
store.loadState({ force: true });
store.persistState({ prune: false });

console.log(`\n日历数字人 · 离线自检\n数据目录：${tmpDir}\n模拟 Google：${google.apiBase}\n`);

/* -------------------------------------------------- 1. 时区与时间解析 */

await test('时区：本地墙钟时间 ↔ 真实瞬间（含东八区）', () => {
  const d = time.zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 15, minute: 0 }, TZ);
  assertEqual(d.toISOString(), '2026-09-28T07:00:00.000Z', '北京 15:00 应为 UTC 07:00');
  const p = time.partsInZone(d, TZ);
  assertEqual(p.hour, 15, '回读小时');
  assertEqual(time.offsetMinutes(d, TZ), 480, '东八区偏移应为 +480 分钟');
});

await test('时区：按天切分不受跨时区影响', () => {
  // 北京时间 2026-09-28 00:30 → UTC 是 2026-09-27 16:30，必须仍算作 9-28
  const late = time.zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 0, minute: 30 }, TZ);
  assertEqual(time.dayKey(late, TZ), '2026-09-28', '本地日期应为 9-28');
  assertEqual(time.startOfDay(late, TZ).toISOString(), '2026-09-27T16:00:00.000Z', '当天起点应为 UTC 16:00');
  const next = time.addDays(late, 1, TZ);
  assertEqual(time.dayKey(next, TZ), '2026-09-29', '加一天');
});

await test('时区：跨夏令时的日期加减不偏移', () => {
  // 美国东部 2026-03-08 是夏令时切换日；用纽约时区验证按天加不会得到 23/25 小时错位
  const nyTz = 'America/New_York';
  const before = time.zonedTimeToUtc({ year: 2026, month: 3, day: 7, hour: 12 }, nyTz);
  const after = time.addDays(before, 1, nyTz);
  assertEqual(time.dayKey(after, nyTz), '2026-03-08', '应跨到 3-08');
  const p = time.partsInZone(after, nyTz);
  assertEqual(p.hour, 12, '墙钟时间应保持 12 点');
});

await test('解析：RFC3339 / 本地日期时间 / 纯日期 / 带偏移', () => {
  const a = time.parseCalendarTime('2026-09-28T15:00', TZ);
  assertEqual(a.date.toISOString(), '2026-09-28T07:00:00.000Z', '无偏移按配置时区解释');
  const b = time.parseCalendarTime('2026-09-28 15:00', TZ);
  assertEqual(b.date.toISOString(), a.date.toISOString(), '空格分隔也应识别');
  const c = time.parseCalendarTime('2026-09-28', TZ);
  assertEqual(c.allDay, true, '纯日期应标记为全天');
  assertEqual(c.date.toISOString(), '2026-09-27T16:00:00.000Z', '纯日期取当天 00:00');
  const d = time.parseCalendarTime('2026-09-28T15:00:00+08:00', TZ);
  assertEqual(d.hadOffset, true, '应识别显式偏移');
  assertEqual(d.date.toISOString(), '2026-09-28T07:00:00.000Z', '带偏移应等价');
  assertEqual(time.parseCalendarTime('不是时间', TZ), null, '非法输入返回 null');
});

await test('时区：非法时区名被拒绝', () => {
  assertEqual(time.isValidTimeZone('Asia/Shanghai'), true, '合法时区');
  assertEqual(time.isValidTimeZone('Mars/Olympus'), false, '非法时区');
});

await test('时间窗口：今天/明天/未来 7 天区间正确', () => {
  const w = time.buildWindows(NOW, TZ, 7);
  assertEqual(time.dayKey(w.today.start, TZ), '2026-09-27', '今天');
  assertEqual(time.dayKey(w.tomorrow.start, TZ), '2026-09-28', '明天');
  assertEqual(w.days.length, 7, '天数');
  assertEqual(time.dayKey(w.range.end, TZ), '2026-10-04', '窗口结束');
  const ctx = time.nowContext(NOW, TZ);
  assertEqual(ctx.tomorrowDate, '2026-09-28', '上下文里的明天日期');
  assertEqual(ctx.weekday, '周日', '星期');
});

/* -------------------------------------------------- 2. OAuth */

await test('OAuth：未配置时报出可读问题', () => {
  const saved = config.calendar.google.clientId;
  config.calendar.google.clientId = '';
  const res = auth.validateGoogleConfig();
  config.calendar.google.clientId = saved;
  assertEqual(res.ok, false, '应判定未配置');
  assertIncludes(res.problems.join('；'), 'clientId', '问题清单');
});

await test('OAuth：授权 URL 含必要参数与 PKCE', () => {
  const out = auth.startAuth();
  assertIncludes(out.url, 'access_type=offline', '需 offline 才能拿 refresh_token');
  assertIncludes(out.url, 'prompt=consent', '需 consent 才会每次都发 refresh_token');
  assertIncludes(out.url, 'code_challenge_method=S256', 'PKCE');
  assertIncludes(out.url, 'scope=', 'scope');
  assert(out.state && out.state.length >= 16, 'state 应足够随机');
  assertEqual(auth.consumeAuthState(out.state) !== null, true, 'state 应可消费');
  assertEqual(auth.consumeAuthState(out.state), null, 'state 只能消费一次');
});

await test('OAuth：授权码换取令牌并落盘', async () => {
  const { state } = auth.startAuth();
  const token = await auth.exchangeCode('mock-code', state);
  assertEqual(token.accessToken, 'mock-access-token', 'access_token');
  assertEqual(token.refreshToken, 'mock-refresh-token', 'refresh_token');
  assert(token.expiresAt, '应有过期时间');
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'google-token.json'), 'utf8'));
  assertEqual(onDisk.refreshToken, 'mock-refresh-token', '令牌应落盘');
});

await test('OAuth：自动刷新，且不会丢掉 refresh_token', async () => {
  const token = auth.readToken();
  // 手动把过期时间设为过去，触发刷新
  auth.writeToken({ ...token, expiresAt: new Date(Date.now() - 60_000).toISOString(), accessToken: 'stale' });
  const fresh = await auth.getAccessToken();
  assertEqual(fresh, 'mock-access-token-refreshed', '应刷新出新令牌');
  assertEqual(auth.readToken().refreshToken, 'mock-refresh-token', 'refresh_token 必须保留');
});

await test('OAuth：state 无效时拒绝换取令牌', async () => {
  let code = null;
  try {
    await auth.exchangeCode('mock-code', 'bogus-state');
  } catch (err) {
    code = err.code;
  }
  assertEqual(code, 'OAUTH_STATE_INVALID', '错误码');
});

await test('连接状态：已连接 / 配置完整', () => {
  const status = auth.connectionStatus();
  assertEqual(status.connected, true, '应显示已连接');
  assertEqual(status.configured, true, '配置应完整');
  assertEqual(status.calendarId, 'primary', 'calendarId');
});

/* -------------------------------------------------- 3. REST 客户端 */

await test('REST：列出日历与元信息', async () => {
  const calendars = await gapi.listCalendars();
  assert(calendars.length >= 2, '应返回日历列表');
  assert(calendars.some((c) => c.primary), '应含主日历');
  const meta = await gapi.getCalendarMeta('primary');
  assertEqual(meta.summary, '主要日历', '日历名');
});

await test('REST：按时间窗口列出并规整事件', async () => {
  const w = time.buildWindows(NOW, TZ, 7);
  const list = await gapi.listEvents({ timeMin: w.range.start, timeMax: w.range.end });
  assertEqual(list.items.length, 4, '应取到 4 条');
  const first = list.items[0];
  assert(first.id, '应有 id');
  assert(first.summary, '应有标题');
  assert(first.start, '应有开始时间');
});

await test('REST：创建日程（含时区与线程化字段）', async () => {
  const start = time.zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 10, minute: 0 }, TZ);
  const end = time.zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 11, minute: 0 }, TZ);
  const created = await gapi.createEvent({
    summary: 'REST 创建测试',
    start,
    end,
    location: '线上',
    description: 'desc',
    attendees: ['li@client.com'],
    reminders: [15],
    source: 'manual',
  });
  assertEqual(created.summary, 'REST 创建测试', '标题');
  assert(created.id, '应有 id');
  const sent = google.store.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events')).pop();
  assertEqual(sent.body.start.timeZone, TZ, '请求体必须带 timeZone');
  assertEqual(sent.body.reminders.overrides[0].minutes, 15, '提醒');
  assertEqual(sent.query.sendUpdates, 'none', 'sendUpdates 默认 none');
});

await test('REST：结束早于开始会被服务端拒绝并翻译成中文', async () => {
  const start = time.zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 11 }, TZ);
  const end = time.zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 10 }, TZ);
  let message = '';
  try {
    await gapi.createEvent({ summary: 'x', start, end });
  } catch (err) {
    message = err.message;
  }
  assertIncludes(message, '创建日程失败', '应有中文前缀');
  assertIncludes(message, '结束时间', '应指出时间问题');
});

await test('REST：删除日程幂等（不存在也算成功）', async () => {
  const created = await gapi.createEvent({
    summary: '待删除',
    start: time.zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 14 }, TZ),
    end: time.zonedTimeToUtc({ year: 2026, month: 9, day: 29, hour: 15 }, TZ),
  });
  const out1 = await gapi.deleteEvent(created.id);
  assertEqual(out1.ok, true, '删除成功');
  let out2 = null;
  let err2 = null;
  try {
    out2 = await gapi.deleteEvent(created.id);
  } catch (err) {
    err2 = err;
  }
  assertEqual(err2, null, `重复删除不应抛错（实际：${err2?.message}）`);
  assertEqual(out2.alreadyGone, true, '重复删除应视为已不存在');
});

await test('REST：401 时给出「重新授权」提示，并把"授权已失效"记下来', async () => {
  auth.writeToken({ ...auth.readToken(), accessToken: null, expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  // 让刷新失败以触发 401 路径
  const savedBase = process.env.MAILBOT_GOOGLE_TOKEN_BASE;
  const bad = await mocks.startMockGoogle({ failAuth: true });
  process.env.MAILBOT_GOOGLE_TOKEN_BASE = bad.tokenBase;
  let message = '';
  let code = null;
  try {
    await gapi.listEvents({ timeMin: NOW, timeMax: time.addDays(NOW, 1, TZ) });
  } catch (err) {
    message = err.message;
    code = err.code;
  }
  process.env.MAILBOT_GOOGLE_TOKEN_BASE = savedBase;
  await bad.close();
  assertEqual(code, 'OAUTH_REFRESH_REVOKED', '应识别为授权被撤销');
  // 提示必须**可执行**，并且说清最可能的原因（测试状态下 refresh token 只有 7 天）
  assertIncludes(message, '重新连接', '应说明要重新连接');
  assertIncludes(message, '连接 Google 日历', '应指出具体点哪个按钮');
  assertIncludes(message, '7 天', '应说明"测试发布状态只有 7 天"这个最常见原因');

  /*
   * 失效必须**被记下来**：否则界面会一边显示「已连接」一边每个请求都失败。
   * （这一条以前不存在——`connected` 只看文件里有没有 refresh_token。）
   */
  assertEqual(auth.connectionStatus().needsReauth, true, '应标记为需要重新授权');
  assertEqual(auth.connectionStatus().connected, false, '失效后不应再说"已连接"');
  // 后续请求应**快速失败**（不再去撞注定失败的刷新），错误码保持一致
  let fastCode = null;
  try {
    await gapi.listEvents({ timeMin: NOW, timeMax: time.addDays(NOW, 1, TZ) });
  } catch (err) {
    fastCode = err.code;
  }
  assertEqual(fastCode, 'OAUTH_REFRESH_REVOKED', '后续请求也应报同一个错');

  /*
   * 恢复：走**真实的重新授权路径**（授权码交换会写 token，随后 setTokenEmail），
   * 它必须把失效标记清掉，否则界面会一直说"需要重新连接"。
   */
  const t = auth.readToken();
  auth.writeToken({ ...t, accessToken: 'mock-access-token', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
  auth.setTokenEmail('mock@example.com');
  assertEqual(auth.connectionStatus().needsReauth, false, '重新授权后应清除失效标记');
  assertEqual(auth.connectionStatus().connected, true, '重新授权后应恢复为已连接');
});

/* -------------------------------------------------- 4. 事件草稿解析 */

await test('草稿：本地时间按配置时区解释（不会差 8 小时）', () => {
  const { event } = service.resolveEventDraft(
    { summary: '测试', startLocal: '2026-09-28 15:00', durationMinutes: 30 },
    { timeZone: TZ },
  );
  assertEqual(event.start.toISOString(), '2026-09-28T07:00:00.000Z', '开始');
  assertEqual(event.end.toISOString(), '2026-09-28T07:30:00.000Z', '结束');
  assertEqual(event.durationMinutes, 30, '时长');
});

await test('草稿：缺标题/时间被判定为信息不足', () => {
  const a = service.resolveEventDraft({ startLocal: '2026-09-28 15:00' }, { timeZone: TZ });
  assertEqual(a.ok, false, '缺标题应失败');
  assertIncludes(a.hardProblems.join('；'), '标题', '问题应指出标题');
  const b = service.resolveEventDraft({ summary: 'x' }, { timeZone: TZ });
  assertEqual(b.ok, false, '缺时间应失败');
  assertIncludes(b.hardProblems.join('；'), '开始时间', '问题应指出时间');
});

await test('草稿：结束早于开始时按默认时长兜底', () => {
  const { event, problems } = service.resolveEventDraft(
    { summary: 'x', startLocal: '2026-09-28 15:00', endLocal: '2026-09-28 14:00', durationMinutes: 45 },
    { timeZone: TZ },
  );
  assertEqual(event.durationMinutes, 45, '应按默认时长');
  assertIncludes(problems.join('；'), '早于开始时间', '应给出提示');
});

await test('草稿：全天事件的结束日期自动取次日', () => {
  const { event } = service.resolveEventDraft({ summary: '出差', allDay: true, allDayStart: '2026-09-28' }, { timeZone: TZ });
  assertEqual(event.allDay, true, '应标记全天');
  assertEqual(event.allDayStart, '2026-09-28', '开始日期');
  assertEqual(event.allDayEnd, '2026-09-29', '结束日期应为次日（排他语义）');
});

await test('草稿：非法参与者邮箱被丢弃', () => {
  const { event } = service.resolveEventDraft(
    { summary: 'x', startLocal: '2026-09-28 15:00', attendees: ['li@client.com', 'not-an-email', { email: 'a@b.com' }] },
    { timeZone: TZ },
  );
  assertEqual(event.attendees.length, 2, '应只保留合法邮箱');
  assertEqual(event.attendees[1].email, 'a@b.com', '对象形式也应支持');
});

/* -------------------------------------------------- 5. 统计与冲突 */

await test('统计：冲突检测与忙闲时长', () => {
  const events = [
    { id: '1', summary: 'A', start: '2026-09-27T10:00:00+08:00', end: '2026-09-27T11:00:00+08:00', allDay: false },
    { id: '2', summary: 'B', start: '2026-09-27T10:30:00+08:00', end: '2026-09-27T11:30:00+08:00', allDay: false },
    { id: '3', summary: 'C', start: '2026-09-27T14:00:00+08:00', end: '2026-09-27T15:00:00+08:00', allDay: false },
  ];
  const conflicts = service.detectConflicts(events);
  assertEqual(conflicts.length, 1, '应检测到 1 组冲突');
  assertEqual(conflicts[0].overlapMinutes, 30, '重叠时长');

  const grouped = service.groupEventsByDay(
    events.map((e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) })),
    { now: NOW, timeZone: TZ, lookaheadDays: 7 },
  );
  assertEqual(grouped.days[0].count, 3, '今天应有 3 条');
  assertEqual(grouped.stats.totalHours, 3, '按日程累加为 3 小时');
  // B(10:30-11:30) 与 A(10:00-11:00) 重叠，并集应为 10:00-11:30 + 14:00-15:00 = 2.5 小时
  assertEqual(grouped.stats.busyHours, 2.5, '忙碌时长按并集算应为 2.5 小时');
  assertEqual(grouped.stats.today, 3, '今日条数');
  assertEqual(grouped.stats.tomorrow, 0, '明日条数');
});

/* -------------------------------------------------- 6. 对话建日程 */

await test('对话：信息完整 → 生成待确认草稿（不直接写入）', async () => {
  const before = google.store.events.length;
  const out = await service.chatWithCalendar({ sessionId: 's1', message: '帮我下周三下午两点安排项目评审会，地点会议室B，李工参加', now: NOW });
  assertEqual(out.kind, 'confirm', '应进入确认态');
  assertEqual(out.event.summary, '项目评审会', '标题');
  assertEqual(out.event.startLocal, '2026-09-30 14:00', '开始时间（本地）');
  assertEqual(out.event.endLocal, '2026-09-30 15:30', '结束时间（默认 90 分钟）');
  assertEqual(out.event.location, '会议室 B', '地点');
  assertEqual(out.event.attendees[0], 'li@client.com', '参与者');
  assertEqual(google.store.events.length, before, '未确认前不得写入日历');
  assertIncludes(out.assistant, '请确认', '应提示确认');
});

await test('对话：信息不足 → 追问而不是瞎编', async () => {
  const out = await service.chatWithCalendar({ sessionId: 's2', message: '帮我随便安排个事', now: NOW });
  assertEqual(out.kind, 'question', '应追问');
  assertEqual(out.needMore, true, 'needMore');
  assertIncludes(out.assistant, '时间', '追问内容应聚焦缺失信息');
});

await test('对话：确认后写入日历并清空待确认', async () => {
  const before = google.store.events.length;
  const out = await service.commitPending({ sessionId: 's1' });
  assertEqual(google.store.events.length, before + 1, '应新增 1 条');
  assertEqual(out.event.summary, '项目评审会', '写回的日程');
  assert(out.event.id, '应返回日历事件 id');
  const session = service.getSession('s1');
  assertEqual(session.pending, null, '待确认应已清空');
  let code = null;
  try {
    await service.commitPending({ sessionId: 's1' });
  } catch (err) {
    code = err.code;
  }
  assertEqual(code, 'NO_PENDING_ACTION', '重复确认应被拒绝');
});

await test('对话：冲突会被检测并在确认文本里提示', async () => {
  const out = await service.chatWithCalendar({ sessionId: 's3', message: '明天 9:15 加一个临时讨论，30 分钟', now: NOW });
  assertEqual(out.kind, 'confirm', '应进入确认态');
  assert(out.conflicts.length >= 1, '应与「站会」冲突');
  assertIncludes(out.assistant, '冲突', '应提示冲突');
});

await test('对话：查看类请求 → 返回日程分析', async () => {
  const out = await service.chatWithCalendar({ sessionId: 's4', message: '看看我这两天有什么安排', now: NOW });
  assertEqual(out.kind, 'list', '应识别为查看');
  assertIncludes(out.assistant, '一句话总结', '应返回分析');
  assert(out.analysis?.stats, '应带统计');
  assertEqual(out.analysis.stats.today >= 2, true, '今日统计');
});

await test('对话：取消待确认', () => {
  const out = service.cancelPending({ sessionId: 's3' });
  assertEqual(out.cleared, true, '应清除');
  assertEqual(service.getSession('s3').pending, null, '待确认应为空');
});

await test('对话：未启用时给出明确提示', async () => {
  config.calendar.enabled = false;
  let code = null;
  try {
    await service.chatWithCalendar({ sessionId: 's5', message: '明天开会', now: NOW });
  } catch (err) {
    code = err.code;
  }
  config.calendar.enabled = true;
  assertEqual(code, 'CALENDAR_DISABLED', '错误码');
});

/* -------------------------------------------------- 7. 邮件转日程 */

await test('邮件转日程：从分析结果提取建议（不写日历）', async () => {
  // 造一条已分析邮件
  store.upsertAnalyses([
    {
      folder: 'INBOX',
      uid: 5001,
      instanceId: 'default',
      type: 'action_required',
      priority: 'high',
      needsReply: true,
      summary: '客户要求 9 月 30 日前提交月度报告。',
      mail: {
        uid: 5001,
        folder: 'INBOX',
        subject: '月度报告提交提醒',
        from: { name: '王经理', address: 'wang@client.com' },
        to: [{ address: 'me@company.com' }],
        cc: [],
        date: '2026-09-27T02:00:00.000Z',
        snippet: '请于 9 月 30 日前提交月度报告',
        messageId: '<mail-5001@client.com>',
      },
    },
    {
      folder: 'INBOX',
      uid: 5002,
      instanceId: 'default',
      type: 'newsletter',
      priority: 'low',
      needsReply: false,
      summary: '营销邮件，应被排除。',
      mail: { uid: 5002, folder: 'INBOX', subject: '促销', from: { address: 'ad@shop.com' }, date: '2026-09-27T02:00:00.000Z' },
    },
  ]);
  store.persistState();

  const before = google.store.events.length;
  const out = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW });
  assertEqual(out.scanned, 1, '应只扫描需要处理的那封（排除营销）');
  assertEqual(out.suggestions.length, 1, '应产出 1 条建议');
  const sug = out.suggestions[0];
  assertEqual(sug.event.summary, '提交月度报告（来自：王经理）', '标题');
  assertEqual(sug.event.date, '2026-09-30', '日期');
  assertIncludes(sug.evidence, '9 月 30 日', '应带证据');
  assertEqual(sug.mail.key, 'INBOX:5001', '应关联来源邮件');
  assertEqual(google.store.events.length, before, '未确认前不写入日历');
});

await test('邮件转日程：确认后写入并带上来源标记', async () => {
  const out = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW });
  const before = google.store.events.length;
  const accepted = await service.acceptEmailSuggestion({ suggestion: out.suggestions[0], instanceId: 'default' });
  assertEqual(google.store.events.length, before + 1, '应写入 1 条');
  assertEqual(accepted.event.summary, '提交月度报告（来自：王经理）', '标题');
  const written = google.store.events[google.store.events.length - 1];
  assertEqual(written.extendedProperties.private.mailbotSource, 'email', '应标记来源为邮件');
  assertEqual(written.extendedProperties.private.mailbotRef, 'INBOX:5001', '应记录邮件引用');
});

await test('邮件转日程：写入前可用 override 改主题/时间/地点', async () => {
  const out = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW });
  const sug = out.suggestions[0];
  const before = google.store.events.length;
  // 邮件里抽出来的时间常常"差一点"：主题要改清楚、时间要顺延、地点要补上
  const accepted = await service.acceptEmailSuggestion({
    suggestion: sug,
    instanceId: 'default',
    override: {
      summary: '客户方案评审会（已改）',
      allDay: false,
      startLocal: '2026-10-06 15:00',
      endLocal: '2026-10-06 16:30',
      location: '17 楼会议室',
      description: '带上第二版方案',
    },
  });
  assertEqual(google.store.events.length, before + 1, '应写入 1 条');
  assertEqual(accepted.event.summary, '客户方案评审会（已改）', '标题应取 override 的值');
  assertEqual(accepted.event.location, '17 楼会议室', '地点应取 override 的值');
  assertEqual(accepted.event.startLocal, '2026-10-06 15:00', '开始时间应取 override 的值');
  assertEqual(accepted.event.endLocal, '2026-10-06 16:30', '结束时间应取 override 的值');
  assertEqual(accepted.event.description, '带上第二版方案', '说明应取 override 的值');
  // 改了内容也要保留来源标记，否则"由邮件生成"的溯源会断
  const written = google.store.events[google.store.events.length - 1];
  assertEqual(written.extendedProperties.private.mailbotSource, 'email', '改内容后仍应标记来源为邮件');
  assertEqual(written.extendedProperties.private.mailbotRef, 'INBOX:5001', '仍应记录邮件引用');

  // 只给部分 override 时，其余字段应沿用原建议
  const partial = await service.acceptEmailSuggestion({
    suggestion: out.suggestions[0],
    instanceId: 'default',
    override: { summary: '只改标题' },
  });
  assertEqual(partial.event.summary, '只改标题', '标题用 override');
  assertEqual(partial.event.date, sug.event.date, '没改的日期应沿用原建议');
});

await test('邮件转日程：override 把时间改成非法值时明确报错', async () => {
  const out = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW });
  let err = null;
  try {
    await service.acceptEmailSuggestion({
      suggestion: out.suggestions[0],
      instanceId: 'default',
      override: { summary: '', startLocal: '不是时间', endLocal: '' },
    });
  } catch (e) {
    err = e;
  }
  assert(err, '应报错');
  assertEqual(err.code, 'INVALID_EVENT', '错误码');
});

await test('邮件转日程：默认只扫最近 24 小时，更早的邮件不会被列出来', async () => {
  /*
   * 用户实测发现：按钮写着「扫描最近 24 小时邮件」，却把几周前的邮件也列了出来。
   * 根因是只有调用方显式传 windowHours 才过滤，而界面从来不传。
   * 这里把"窗口"本身当成被测对象：24 小时内的进、24 小时外的出。
   */
  const inWindow = new Date(NOW.getTime() - 3 * 3600_000); // 3 小时前
  const outWindow = new Date(NOW.getTime() - 30 * 3600_000); // 30 小时前
  store.upsertAnalyses([
    {
      folder: 'INBOX',
      uid: 5101,
      instanceId: 'default',
      type: 'action_required',
      priority: 'high',
      needsReply: true,
      summary: '窗口内：请于 9 月 30 日前提交',
      mail: { uid: 5101, folder: 'INBOX', subject: '窗口内的邮件', from: { address: 'a@x.com' }, to: [], cc: [], date: inWindow.toISOString(), snippet: '请于 9 月 30 日前提交' },
    },
    {
      folder: 'INBOX',
      uid: 5102,
      instanceId: 'default',
      type: 'action_required',
      priority: 'high',
      needsReply: true,
      summary: '窗口外：请于 9 月 30 日前提交',
      mail: { uid: 5102, folder: 'INBOX', subject: '两周前的邮件', from: { address: 'b@x.com' }, to: [], cc: [], date: outWindow.toISOString(), snippet: '请于 9 月 30 日前提交旧事项' },
    },
  ]);

  const out = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW });
  assertEqual(out.window.hours, 24, '默认窗口应是 24 小时');
  assert(out.window.sinceLabel, '应回传窗口起点（界面要显示，便于核对）');
  const uids = out.suggestions.map((s) => s.mail.uid);
  assert(uids.includes(5101), `24 小时内的邮件应被列出（实际 ${uids.join(',')}）`);
  assert(!uids.includes(5102), '30 小时前的邮件不应出现在建议里');

  // 窗口内没有邮件时，提示要区分"没分析过"与"都不是会议类"，并说明窗口起点
  const empty = await service.suggestEventsFromEmails({ instanceId: 'default', now: new Date(NOW.getTime() + 90 * 24 * 3600_000) });
  assertEqual(empty.suggestions.length, 0, '很久之后再看，窗口内应无邮件');
  assertIncludes(empty.note, '24 小时', '提示里要写明窗口');
  assertIncludes(empty.note, '更早', '应告诉用户窗口外还有可提取的邮件，避免"数据不见了"的错觉');

  // 显式放大窗口时，旧邮件才应出现（说明过滤是按窗口走的，不是被永久丢掉）
  const wide = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW, windowHours: 72 });
  assertEqual(wide.window.hours, 72, '应尊重显式传入的窗口');
  assert(wide.suggestions.some((s) => s.mail.uid === 5102), '放大到 72 小时后，30 小时前的邮件应出现');
});

await test('邮件转日程：窗口内没有已分析邮件时，自动补一次分析再提取', async () => {
  /*
   * 用户选择的行为：点「扫描最近 24 小时邮件」时，如果窗口内还没有分析过的邮件，
   * 自动先跑一次 24 小时分析（runScan 会跳过已分析的，不会重复花钱），再提取日程。
   * 否则用户点下去只会得到空列表——那不是他要的结果，是流程少了一步。
   */
  const recent = new Date(Date.now() - 30 * 60_000); // 半小时前收到
  const srv = await mailMocks.startMockImap({
    messages: [
      {
        uid: 6201,
        raw: mailMocks.makeRawMail({
          subject: '下周评审安排',
          from: { name: '李工', address: 'li@client.com' },
          to: [{ name: '我', address: 'bot@example.com' }],
          body: '请于 9 月 30 日前提交评审材料。',
          date: recent,
          messageId: '<auto-1@client.com>',
        }),
        flags: [],
        internalDate: recent.toUTCString(),
      },
    ],
  });

  /*
   * 这里**不切数据目录、也不 resetConfigCache**：
   * 那会换掉 `getConfig()` 的对象身份，让后面还持着旧 `config` 引用的用例失效
   * （表现为"未保存凭据"那条突然读到 config.json）。
   * 直接临时清空内存里的分析记录即可构造"窗口内没有已分析邮件"这个前提。
   */
  const live = getConfig();
  const st = store.getState();
  const savedAnalyses = st.analyses;
  const savedInstances = live.instances;
  const savedDefault = live.defaultInstanceId;
  st.analyses = {};
  live.instances = [
    {
      id: 'auto',
      label: '自动补分析邮箱',
      imap: { host: '127.0.0.1', port: srv.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
      smtp: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
      identity: { name: '王磊', email: 'bot@example.com' },
    },
  ];
  live.defaultInstanceId = 'auto';
  try {
    const out = await service.suggestEventsFromEmails({ instanceId: 'auto' });
    assert(out.autoAnalyzed, '应自动补跑一次邮件分析');
    assertEqual(out.autoAnalyzed.ok, true, `自动分析应成功（${out.autoAnalyzed.error || ''}）`);
    assert(out.autoAnalyzed.analyzed >= 1, `应新分析至少 1 封（实际 ${out.autoAnalyzed.analyzed}）`);
    assertEqual(out.window.hours, 24, '窗口仍应是 24 小时');
    assert(out.suggestions.length >= 1, `自动分析后应能提取出日程建议（实际 ${out.suggestions.length}）`);
    assertEqual(out.suggestions[0].mail.subject, '下周评审安排', '建议应来自刚分析的那封邮件');
  } finally {
    live.instances = savedInstances;
    live.defaultInstanceId = savedDefault;
    st.analyses = savedAnalyses;
    store.persistState();
    await srv.close();
  }
});

await test('邮件转日程：自动分析失败时如实说明，不影响接口可用', async () => {
  const live = getConfig();
  const st = store.getState();
  const savedAnalyses = st.analyses;
  const savedInstances = live.instances;
  const savedDefault = live.defaultInstanceId;
  st.analyses = {};
  // 指向一个没人监听的端口：自动分析必然失败
  live.instances = [
    {
      id: 'bad',
      label: '连不上的邮箱',
      imap: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
      smtp: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
      identity: { name: '王磊', email: 'bot@example.com' },
    },
  ];
  live.defaultInstanceId = 'bad';
  try {
    const out = await service.suggestEventsFromEmails({ instanceId: 'bad' });
    assert(out.autoAnalyzed, '应记录自动分析的结果');
    assertEqual(out.autoAnalyzed.ok, false, '连不上时应如实标记失败');
    assert(out.autoAnalyzed.error, '应带上失败原因');
    assertIncludes(out.note, '自动分析未能完成', '提示里要说明自动分析失败');
    assertEqual(out.suggestions.length, 0, '不该因此抛出异常，只是没有建议');
  } finally {
    live.instances = savedInstances;
    live.defaultInstanceId = savedDefault;
    st.analyses = savedAnalyses;
    store.persistState();
  }
});

await test('邮件转日程：抽到的时间点会被规整成可用的时间块（整点/半点 + 至少 30 分钟）', async () => {
  const { normalizeMailEventTimes } = await import('../server/calendar/service.js');
  const tz = TZ;
  /*
   * 实测模型会把"时间点"当成日程：17:00→17:05、10:52:12→10:52:17 这种 5 分钟条目。
   * 规整规则：截止类**向下取整**（提醒不晚于邮件里说的时间），其余就近取整；时长至少 30 分钟。
   */
  const deadline = normalizeMailEventTimes({ summary: 'x', kind: 'deadline', startLocal: '2026-10-04 17:00', endLocal: '2026-10-04 17:05' }, { timeZone: tz });
  assertEqual(deadline.startLocal, '2026-10-04 17:00', '整点保持不变');
  assertEqual(deadline.endLocal, '2026-10-04 17:30', '5 分钟应补成 30 分钟');
  assertEqual(deadline.durationMinutes, 30, '时长应为 30');
  assertEqual(deadline.__adjusted, true, '应标记"调整过"');

  // 10:52 是"之后无法登录"，向下取整到 10:30 —— 提醒不能晚于邮件里说的时间
  const floor = normalizeMailEventTimes({ summary: 'y', kind: 'deadline', startLocal: '2026-10-16 10:52', endLocal: '2026-10-16 10:52' }, { timeZone: tz });
  assertEqual(floor.startLocal, '2026-10-16 10:30', '截止类应向下取整到半点');

  // 会议类就近取整：14:20 → 14:30
  const near = normalizeMailEventTimes({ summary: 'z', kind: 'meeting', startLocal: '2026-10-06 14:20', endLocal: '2026-10-06 15:20' }, { timeZone: tz });
  assertEqual(near.startLocal, '2026-10-06 14:30', '会议应就近取整');
  assertEqual(near.durationMinutes, 60, '模型给出的 1 小时不应被压成 30 分钟');

  // 本来就是整点、时长也够 → 不动，且不标记调整
  const keep = normalizeMailEventTimes({ summary: 'w', kind: 'meeting', startLocal: '2026-10-06 09:00', endLocal: '2026-10-06 11:00' }, { timeZone: tz });
  assertEqual(keep.startLocal, '2026-10-06 09:00', '整点应保持');
  assertEqual(keep.endLocal, '2026-10-06 11:00', '2 小时应保持');
  assertEqual(keep.__adjusted, false, '没改动就不该标记');

  // 全天事项没有"几点"的问题
  const allDay = normalizeMailEventTimes({ summary: 'v', allDay: true, allDayStart: '2026-10-06' }, { timeZone: tz });
  assertEqual(allDay.allDay, true, '全天事项应原样返回');
  assertEqual(allDay.startLocal, undefined, '全天事项不应被塞入 startLocal');
});

await test('邮件转日程：写入后留下操作台账（含标题、来源邮件、是否改过）', async () => {
  const { listAudit } = await import('../server/store/audit.js');
  const before = listAudit({ action: 'calendar.event.create' }).items.length;
  const out = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW });
  await service.acceptEmailSuggestion({
    suggestion: out.suggestions[0],
    instanceId: 'default',
    override: { summary: '评审材料提交（改过）' },
  });
  const after = listAudit({ action: 'calendar.event.create' });
  assertEqual(after.items.length, before + 1, '每写一条日程就应多一条台账');
  const rec = after.items[0];
  assertEqual(rec.label, '创建日程', '动作名称');
  assertEqual(rec.group, '日历', '应归到日历组');
  assertEqual(rec.target, '评审材料提交（改过）', '台账要记下具体标题');
  assertEqual(rec.source, '从邮件生成', '来源要能区分"对话建的"还是"邮件生成的"');
  assertEqual(rec.ok, true, '成功应标记 ok');
  // 来源邮件主题必须与这条建议来自的那封一致（便于事后回查"这条日程是哪封邮件来的"）
  assertEqual(rec.extra.mailSubject, out.suggestions[0].mail.subject, '要能回查到来源邮件主题');
  assert(rec.extra.mailSubject, '来源邮件主题不应为空');
  assertEqual(rec.extra.edited, true, '改过内容要标记出来');
});

await test('操作台账：从会话记录与 Google 标记两路补录历史，且可重复执行', async () => {
  const fs = await import('node:fs');
  const audit = await import('../server/store/audit.js');
  const file = audit.auditFile();
  if (fs.existsSync(file)) fs.rmSync(file); // 从零开始，验证补录本身

  /*
   * 为什么需要两个来源：
   *   ① 修复前**对话建日程**不给事件打来源标记，Google 上认不出来，
   *      但会话里留下了「已写入日历：<标题>　<时间>」的消息；
   *   ② 「从邮件生成」的事件带 mailbotSource，可以直接从 Google 认出来。
   * 少任何一个来源都会漏掉一批历史。
   */
  const sessionId = 'cal_backfill_test';
  store.startCalendarSession({ id: sessionId });
  store.appendCalendarMessage(sessionId, {
    role: 'assistant',
    content: '已写入日历：与王梓核对拓扑图　2026-10-06 15:00',
    at: '2026-10-03T06:10:00.000Z',
  });
  // 标题里含全角空格：不能被误切成"标题 + 时间"
  store.appendCalendarMessage(sessionId, {
    role: 'assistant',
    content: '已写入日历：季度总结 会前准备　2026-10-07 09:00',
    at: '2026-10-03T06:12:00.000Z',
  });
  // 不是创建消息，应被忽略
  store.appendCalendarMessage(sessionId, { role: 'assistant', content: '已删除日程：旧会议', at: '2026-10-03T06:13:00.000Z' });

  // Google 侧：一条带来源标记的事件
  const markerId = 'ev_backfill_marked';
  google.store.events.push({
    id: markerId,
    summary: '由邮件生成的日程',
    start: { dateTime: '2026-10-09T17:00:00+08:00' },
    end: { dateTime: '2026-10-09T17:30:00+08:00' },
    created: '2026-10-03T02:43:00.000Z',
    extendedProperties: { private: { mailbotSource: 'email', mailbotRef: 'INBOX:5001' } },
  });

  const out = await service.backfillCalendarAudit();
  assert(out.fromChat >= 2, `应从容话记录补录至少 2 条（实际 ${out.fromChat}）`);
  assert(out.fromCalendar >= 1, `应从 Google 标记补录至少 1 条（实际 ${out.fromCalendar}）`);
  assertEqual(out.calendar.error, null, 'Google 这一路正常时不应有错误');
  assertEqual(out.added, out.fromChat + out.fromCalendar, 'added 应是两路之和');

  const list = audit.listAudit({ action: 'calendar.event.create', limit: 200 });
  const chatRec = list.items.find((r) => r.target === '与王梓核对拓扑图');
  assert(chatRec, '应补录出会话里的那条日程');
  assertEqual(chatRec.source, '由会话记录补录', '来源应标明是会话记录补录的');
  assertEqual(chatRec.extra.start, '2026-10-06 15:00', '开始时间应解析出来');
  // 时间线要用"当时"的时间，而不是补录这一刻
  assertEqual(chatRec.at, '2026-10-03T06:10:00.000Z', '应使用消息时间作为记录时间');
  // 标题含全角空格时不能被切坏
  assert(list.items.some((r) => r.target === '季度总结 会前准备'), '标题里的全角空格不应导致被截断');
  const calRec = list.items.find((r) => r.extra?.eventId === markerId);
  assert(calRec, '应补录出 Google 上带标记的事件');
  assertEqual(calRec.at, '2026-10-03T02:43:00.000Z', '应用事件自身的 created 时间');
  assertEqual(calRec.extra.mailRef, 'INBOX:5001', '应带上邮件引用');

  // 可重复执行：第二遍不应重复写入
  const again = await service.backfillCalendarAudit();
  assertEqual(again.added, 0, '重复补录不应新增');
  assert(again.skipped >= 3, `重复补录应全部跳过（实际 ${again.skipped}）`);

  // 清理：移除测试用的会话与事件，避免影响后续用例
  const s = store.getState();
  s.calendar.sessions = s.calendar.sessions.filter((x) => x.id !== sessionId);
  google.store.events = google.store.events.filter((e) => e.id !== markerId);
  if (fs.existsSync(file)) fs.rmSync(file);
});

await test('操作台账：访问 Google 不通时，本地记录照样补上并如实说明原因', async () => {
  /*
   * 用户实测过"点了补录几分钟没反应"：那时是**先查 Google 再补本地**，
   * 网络一卡就把整件事拖死——而本地会话记录明明一瞬间就能补完。
   * 现在 Google 只是"尽力而为"的第二来源，失败也不影响第一来源。
   */
  const fs = await import('node:fs');
  const audit = await import('../server/store/audit.js');
  const file = audit.auditFile();
  if (fs.existsSync(file)) fs.rmSync(file);

  const sessionId = 'cal_backfill_offline';
  store.startCalendarSession({ id: sessionId });
  store.appendCalendarMessage(sessionId, {
    role: 'assistant',
    content: '已写入日历：离线也能补录的日程　2026-10-08 10:00',
    at: '2026-10-03T07:00:00.000Z',
  });

  // 把 Google 指向没人监听的端口，并让超时很短
  const savedBase = process.env.MAILBOT_GOOGLE_API_BASE;
  process.env.MAILBOT_GOOGLE_API_BASE = 'http://127.0.0.1:1/calendar/v3';
  const cfg = getConfig();
  const savedRetries = cfg.llm?.maxRetries;
  try {
    const started = Date.now();
    const out = await service.backfillCalendarAudit({ googleTimeoutMs: 3000 });
    const ms = Date.now() - started;
    assert(ms < 15_000, `Google 不通时必须快速返回，不能干等（实际 ${ms}ms）`);
    assert(out.fromChat >= 1, `本地记录仍应补上（实际 ${out.fromChat}）`);
    assertEqual(out.fromCalendar, 0, 'Google 不通时这一路应为 0');
    assert(out.calendar.error, '应如实带上 Google 失败的原因');
    assertEqual(out.added >= 1, true, '整体仍应有补录结果');
    const list = audit.listAudit({ action: 'calendar.event.create', limit: 50 });
    assert(list.items.some((r) => r.target === '离线也能补录的日程'), '本地那条应真的写进了台账');
  } finally {
    if (savedBase === undefined) delete process.env.MAILBOT_GOOGLE_API_BASE;
    else process.env.MAILBOT_GOOGLE_API_BASE = savedBase;
    if (savedRetries !== undefined) cfg.llm.maxRetries = savedRetries;
    const s2 = store.getState();
    s2.calendar.sessions = s2.calendar.sessions.filter((x) => x.id !== sessionId);
    if (fs.existsSync(file)) fs.rmSync(file);
  }
});

await test('修改日程：接通 updateEvent（以前只能删了重建）', async () => {
  /*
   * `google-api.js` 里的 updateEvent 早就写好了，却**从未被任何地方调用**——
   * 结果是想改会议时间只能删了重建。这里把它接通并验证。
   */
  const created = await service.acceptEmailSuggestion({
    suggestion: { event: { summary: '要被改的会', startLocal: '2026-10-06 15:00', endLocal: '2026-10-06 15:30' }, mail: null },
    instanceId: 'default',
  });
  const id = created.event.id;

  const out = await service.updateCalendarEvent({
    eventId: id,
    patch: { summary: '改后的会', startLocal: '2026-10-06 16:00', endLocal: '2026-10-06 17:00', location: '3 楼会议室', description: '带材料' },
  });
  assertEqual(out.ok, true, '应返回成功');
  assertEqual(out.event.summary, '改后的会', '标题应被改掉');
  assertEqual(out.event.startLocal, '2026-10-06 16:00', '开始时间应被改掉');
  assertEqual(out.event.endLocal, '2026-10-06 17:00', '结束时间应被改掉');
  assertEqual(out.event.location, '3 楼会议室', '地点应被写入');
  assertEqual(out.event.durationMinutes, 60, '时长应为 1 小时');

  const stored = google.store.events.find((e) => e.id === id);
  assertEqual(stored.summary, '改后的会', 'Google 上的标题应已更新');
  assertEqual(stored.location, '3 楼会议室', 'Google 上的地点应已更新');

  /*
   * 手动填的时间**不能被整点/半点规整**：规整只针对"邮件里抽出来的时间点"，
   * 用户亲手填的 16:07 必须原样执行。
   */
  const odd = await service.updateCalendarEvent({
    eventId: id,
    patch: { summary: '改后的会', startLocal: '2026-10-06 16:07', endLocal: '2026-10-06 16:52' },
  });
  assertEqual(odd.event.startLocal, '2026-10-06 16:07', '手动改的时间不得被取整');
  assertEqual(odd.event.endLocal, '2026-10-06 16:52', '手动改的结束时间不得被取整');

  // 结束早于开始：必须明确报错，不能悄悄按默认时长兜底
  let code = null;
  try {
    await service.updateCalendarEvent({ eventId: id, patch: { summary: 'x', startLocal: '2026-10-06 17:00', endLocal: '2026-10-06 16:00' } });
  } catch (err) {
    code = err.code;
    assertIncludes(err.message, '结束时间必须晚于开始时间', '应给出人话解释');
  }
  assertEqual(code, 'INVALID_EVENT', '结束早于开始应被拒绝');

  // 缺标题应被拒绝
  code = null;
  try {
    await service.updateCalendarEvent({ eventId: id, patch: { summary: '   ', startLocal: '2026-10-06 17:00', endLocal: '2026-10-06 18:00' } });
  } catch (err) {
    code = err.code;
  }
  assertEqual(code, 'INVALID_EVENT', '缺标题应被拒绝');

  // 不存在的 id：报错而不是静默成功
  code = null;
  try {
    await service.updateCalendarEvent({ eventId: 'ev_not_exist', patch: { summary: 'x', startLocal: '2026-10-06 17:00', endLocal: '2026-10-06 18:00' } });
  } catch (err) {
    code = err.code || err.message;
  }
  assert(code, '改不存在的日程应当报错');

  const { listAudit } = await import('../server/store/audit.js');
  const audit = listAudit({ action: 'calendar.event.update' });
  assert(audit.items.length >= 1, '改日程应留台账');
  assertEqual(audit.items[0].label, '修改日程', '动作名称');
  assert(audit.items[0].extra.fields.includes('startLocal'), '应记录改了哪些字段');
});

await test('修改日程：全天与定时可以互相切换', async () => {
  const created = await service.acceptEmailSuggestion({
    suggestion: { event: { summary: '要变全天的会', startLocal: '2026-10-06 15:00', endLocal: '2026-10-06 15:30' }, mail: null },
    instanceId: 'default',
  });
  const id = created.event.id;

  const allDay = await service.updateCalendarEvent({ eventId: id, patch: { summary: '要变全天的会', allDay: true, allDayStart: '2026-10-08' } });
  assertEqual(allDay.event.allDay, true, '应变成全天');
  assertEqual(allDay.event.date, '2026-10-08', '日期应为 10-08');

  const timed = await service.updateCalendarEvent({
    eventId: id,
    patch: { summary: '又变回定时', allDay: false, startLocal: '2026-10-09 09:00', endLocal: '2026-10-09 09:30' },
  });
  assertEqual(timed.event.allDay, false, '应变回定时');
  assertEqual(timed.event.startLocal, '2026-10-09 09:00', '开始时间');
});

await test('修改日程：由邮件生成的日程改完后仍保留来源标记', async () => {
  const out = await service.suggestEventsFromEmails({ instanceId: 'default', now: NOW });
  const accepted = await service.acceptEmailSuggestion({ suggestion: out.suggestions[0], instanceId: 'default' });
  const id = accepted.event.id;
  const before = google.store.events.find((e) => e.id === id);
  assertEqual(before.extendedProperties.private.mailbotSource, 'email', '前置条件：带来源标记');
  const refBefore = before.extendedProperties.private.mailbotRef;
  assert(refBefore, '前置条件：应带邮件引用');

  await service.updateCalendarEvent({ eventId: id, patch: { summary: '改过的邮件日程', startLocal: '2026-10-20 10:00', endLocal: '2026-10-20 10:30' } });
  const after = google.store.events.find((e) => e.id === id);
  // PATCH 只发改动字段，扩展属性不应被清掉——否则"这条是哪封邮件来的"就丢了
  assertEqual(after.extendedProperties.private.mailbotSource, 'email', '改完后来源标记应保留');
  assertEqual(after.extendedProperties.private.mailbotRef, refBefore, '邮件引用也应保留');
});

await test('邮件转日程：没有时间信息时给出说明而不是硬编', async () => {
  store.upsertAnalyses([
    {
      folder: 'INBOX',
      uid: 5003,
      instanceId: 'default',
      type: 'fyi',
      priority: 'normal',
      needsReply: false,
      summary: '纯知会，无时间。',
      mail: { uid: 5003, folder: 'INBOX', subject: '没有任何时间信息', from: { address: 'a@b.com' }, date: '2026-09-27T02:00:00.000Z', snippet: '无时间信息' },
    },
  ]);
  store.persistState();
  const out = await service.suggestEventsFromEmails({ instanceId: 'default', ids: ['INBOX:5003'], now: NOW });
  assertEqual(out.suggestions.length, 0, '不应产出建议');
  assertIncludes(out.note, '没有找到', '应说明原因');
});

/* -------------------------------------------------- 8. 日程分析 */

await test('分析：今日/明日/近 7 天统计与模型分析', async () => {
  const out = await service.getCalendarInsight({ now: NOW, lookaheadDays: 7 });
  assertEqual(out.days.length, 7, '应返回 7 天');
  assertEqual(out.today.key, '2026-09-27', '今天');
  assertEqual(out.tomorrow.key, '2026-09-28', '明天');
  assert(out.today.events.length >= 2, '今天应有日程');
  assert(out.tomorrow.events.length >= 1, '明天应有日程');
  assertEqual(out.tomorrow.events[0].allDay, true, '全天事件应排在最前');
  assert(out.stats.total >= 4, '总数');
  assert(out.conflicts.length >= 1, '应检测到冲突');
  assertIncludes(out.analysis, '一句话总结', '应含分析');
  assertEqual(out.analysisError, null, '不应有分析错误');
});

await test('分析：7 天内无安排时如实说明', async () => {
  const empty = await mocks.startMockGoogle({});
  const savedBase = process.env.MAILBOT_GOOGLE_API_BASE;
  process.env.MAILBOT_GOOGLE_API_BASE = empty.apiBase;
  try {
    const out = await service.getCalendarInsight({ now: NOW, lookaheadDays: 7, withAnalysis: false });
    assertEqual(out.stats.total, 0, '应无日程');
    assertEqual(out.today.count, 0, '今天无安排');
  } finally {
    process.env.MAILBOT_GOOGLE_API_BASE = savedBase;
    await empty.close();
  }
});

await test('即将到来：只返回未来日程', async () => {
  const out = await service.getUpcoming({ now: NOW, limit: 10 });
  assert(out.items.length >= 1, '应有即将到来的日程');
  for (const item of out.items) {
    assert(item.startLocal || item.allDay, '每条都应有时间');
  }
});

await test('配置：未保存凭据时报错能指出「未保存」而不是让人困惑', async () => {
  const savedId = config.calendar.google.clientId;
  const savedSecret = config.calendar.google.clientSecret;
  const savedUri = config.calendar.google.redirectUri;
  config.calendar.google.clientId = '';
  config.calendar.google.clientSecret = '';
  config.calendar.google.redirectUri = '';
  try {
    const sources = auth.describeGoogleCredentialSources();
    assertEqual(sources.clientId, '未配置', '应识别为未配置');
    const err = auth.googleNotConfiguredError(auth.validateGoogleConfig().problems);
    assertIncludes(err.message, '未保存', '应说明是「未保存」');
    assertIncludes(err.message, '保存配置', '应给出可执行操作');
    assertEqual(err.detail.sources.clientId, '未配置', 'detail 应带来源');
  } finally {
    config.calendar.google.clientId = savedId;
    config.calendar.google.clientSecret = savedSecret;
    config.calendar.google.redirectUri = savedUri;
  }
});

await test('配置：回传掩码值不会清空 Google 密钥', async () => {
  const { maskConfig, saveConfig } = await import('../server/config/index.js');
  // 先把当前凭据落到磁盘（模拟用户已保存过）
  const live = getConfig();
  saveConfig({
    calendar: {
      enabled: live.calendar.enabled,
      calendarId: live.calendar.calendarId,
      timeZone: live.calendar.timeZone,
      lookaheadDays: live.calendar.lookaheadDays,
      google: {
        clientId: live.calendar.google.clientId,
        clientSecret: live.calendar.google.clientSecret,
        redirectUri: live.calendar.google.redirectUri,
      },
    },
    llm: { baseUrl: live.llm.baseUrl, apiKey: live.llm.apiKey, model: live.llm.model },
  });

  const masked = maskConfig(getConfig());
  assertEqual(masked.calendar.google.clientSecret, '***', '密钥应脱敏');

  // 关键场景：界面把脱敏后的配置整体回传，密钥是 '***'
  const roundTripped = saveConfig(masked);
  assertEqual(roundTripped.calendar.google.clientSecret, 'test-client-secret', '回传掩码值必须保留原密钥，不能被清空');
  assertEqual(roundTripped.calendar.google.clientId, 'test-client-id.apps.googleusercontent.com', 'clientId 应保留');
  // 磁盘上也必须是真实值，而不是 '***'
  const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8'));
  assertEqual(onDisk.calendar.google.clientSecret, 'test-client-secret', '磁盘上应为真实密钥');
  assert(!JSON.stringify(onDisk).includes('"***"'), '磁盘上不应出现掩码占位');

  const sources = auth.describeGoogleCredentialSources();
  assertEqual(sources.clientId, 'config.json', 'clientId 来源应为 config.json');
  assertEqual(sources.clientSecret, 'config.json', 'clientSecret 来源应为 config.json');
});

await test('错误：API 未启用时给出启用链接，而不是误报「权限不足」', async () => {
  const disabled = await mocks.startMockGoogle({ apiDisabled: true, projectNumber: '386604958647' });
  const savedBase = process.env.MAILBOT_GOOGLE_API_BASE;
  process.env.MAILBOT_GOOGLE_API_BASE = disabled.apiBase;
  try {
    let err = null;
    try {
      await gapi.createEvent({
        summary: '测试',
        start: time.zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 10 }, TZ),
        end: time.zonedTimeToUtc({ year: 2026, month: 9, day: 28, hour: 11 }, TZ),
      });
    } catch (e) {
      err = e;
    }
    assert(err, '应抛出错误');
    assertEqual(err.code, 'GOOGLE_API_DISABLED', '错误码应专指 API 未启用');
    assertIncludes(err.message, '未启用', '消息应说清原因');
    assertIncludes(err.message, '启用', '应提示去启用');
    assertEqual(err.detail.project, '386604958647', '应解析出项目编号');
    assertIncludes(err.detail.activationUrl, 'calendar-json.googleapis.com', '应带上 Google 给的启用链接');
    assertIncludes(err.detail.activationUrl, 'project=386604958647', '链接应带项目号');
    // 关键：不能误导成「权限不足 / calendarId 不对」
    assert(!err.message.includes('calendarId 是否正确'), '不应把 API 未启用误报为 calendarId 问题');
    assert(!err.message.includes('权限被拒'), '不应把 API 未启用误报为权限被拒');
    assertEqual(err.detail.reason, 'SERVICE_DISABLED', '应保留 Google 的 reason');
  } finally {
    process.env.MAILBOT_GOOGLE_API_BASE = savedBase;
    await disabled.close();
  }
});

await test('错误：API 未启用时「测试连接」也应给出启用指引', async () => {
  const disabled = await mocks.startMockGoogle({ apiDisabled: true, projectNumber: '999888777666' });
  const savedBase = process.env.MAILBOT_GOOGLE_API_BASE;
  process.env.MAILBOT_GOOGLE_API_BASE = disabled.apiBase;
  try {
    let err = null;
    try {
      await gapi.testConnection();
    } catch (e) {
      err = e;
    }
    assert(err, '应抛出错误');
    assertEqual(err.code, 'GOOGLE_API_DISABLED', '错误码');
    assertEqual(err.detail.project, '999888777666', '项目号应可选解析');
  } finally {
    process.env.MAILBOT_GOOGLE_API_BASE = savedBase;
    await disabled.close();
  }
});

/* -------------------------------------------------- 9. HTTP 接口 */

await test('HTTP：日历回顾分析（对话式）→ 统计 + AI 叙述 + 可导出 md', async () => {
  const { startServer } = await import('../server/index.js');
  const { server, url } = await startServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const H = { 'content-type': 'application/json' };
  const base = url;
  try {
    // 预设接口：界面上的示例与口径都来自这里
    const presets = await (await fetch(`${base}/api/calendar/review/presets`, { headers: H })).json();
    assertEqual(presets.ok, true, 'presets.ok');
    assert(presets.presets.length >= 5, '应给出回顾区间预设');
    assert(presets.examples.length >= 3, '应给出示例问法');
    assert(presets.review.workdayStart, '应下发工作时段口径');

    // 空问题 → 400，而不是拿默认区间糊弄过去
    const empty = await fetch(`${base}/api/calendar/review`, { method: 'POST', headers: H, body: JSON.stringify({ query: '' }) });
    assertEqual(empty.status, 400, '空问题应 400');

    // 正常一次回顾：mock LLM 会先给意图 JSON，再给五段式叙述
    const res = await fetch(`${base}/api/calendar/review`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ query: '请详细分析过去 30 天的日历，并给出工作优化建议' }),
    });
    const out = await res.json();
    assert(out.ok, `回顾失败：${out.message}`);
    assert(out.understood?.rangeLabel, '应回显理解到的区间');
    assert(out.understood?.from && out.understood?.to, '应给出确定的起止日期');
    assert(Array.isArray(out.understood.focus) && out.understood.focus.length > 0, '应给出关注点');
    // 统计必须由程序算出来，字段齐全
    assert(out.totals && typeof out.totals.meetingCount === 'number', '应返回会议数');
    assert(typeof out.totals.workloadHours === 'number', '应返回工作负荷');
    assert(out.source && typeof out.source.excluded === 'number', '应说明排除了多少条');
    assert(out.structure && typeof out.structure.deepBlockCount === 'number', '应返回结构性指标');
    assert(Array.isArray(out.weekly), '应返回按周趋势');
    assert(Array.isArray(out.timeline), '应返回日程清单（导出用）');
    assert(Array.isArray(out.durations) && out.durations.length === 4, '应返回时长分层（4 档）');
    assert(out.locations?.counts, '应返回地点分组（线上/线下/未填）');
    assert(Array.isArray(out.dayStats), '应返回逐日统计（热力图用）');
    assert(out.analysis, '应返回分析叙述');
    assert(out.reportId, '应返回报告 id 以便导出');

    // 报告可导出，且内容包含叙述 + 图表 + 统计附录 + 日程清单四部分
    const raw = await (await fetch(`${base}/api/reports/${encodeURIComponent(out.reportId)}?format=raw`, { headers: H })).text();
    assertIncludes(raw, '日程回顾分析', '导出应以报告标题开头');
    assertIncludes(raw, '附录 A', '导出应含统计附录');
    assertIncludes(raw, '附录 B', '导出应含日程清单');
    assertIncludes(raw, '附录 C', '导出应含图表附录');
    assertIncludes(raw, '█', '图表应用字符条绘制（任何文本查看器可读）');
    assert(!raw.includes('```'), '不应使用代码围栏');
    assertIncludes(raw, '排除', '导出应写明口径（排除了哪些条目）');

    // 指定 preset 时不应再调用模型解析意图（省一次调用），但仍然给出统计
    const direct = await (
      await fetch(`${base}/api/calendar/review`, { method: 'POST', headers: H, body: JSON.stringify({ preset: 'last-7d' }) })
    ).json();
    assert(direct.ok, '直接指定区间也应成功');
    assertEqual(direct.understood.preset, 'last-7d', '应使用指定区间');
    assert(direct.range.days === 7, '应为 7 天');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test('HTTP：台账为空时不返回空文件（曾导致下载到 0 字节）', async () => {
  const fs = await import('node:fs');
  const audit = await import('../server/store/audit.js');
  const file = audit.auditFile();
  const backup = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const { startServer } = await import('../server/index.js');
  const { server, url } = await startServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const H = { 'content-type': 'application/json' };
  try {
    // 场景一：没有台账文件
    if (fs.existsSync(file)) fs.rmSync(file);
    const empty = await fetch(`${url}/api/audit/download`, { headers: H });
    assertEqual(empty.status, 404, '没有记录时应返回 404，而不是 200 + 空 body');
    const emptyBody = await empty.json();
    assertEqual(emptyBody.code, 'AUDIT_EMPTY', '应给出明确的错误码');
    assertIncludes(emptyBody.message, '还没有操作记录', '应说明为什么没有内容');
    assertIncludes(emptyBody.message, '补录历史', '应给出可执行的下一步');

    // 场景二：文件存在但为 0 字节（曾经就是这样下载出 0 B 文件的）
    fs.writeFileSync(file, '', 'utf8');
    const zero = await fetch(`${url}/api/audit/download`, { headers: H });
    assertEqual(zero.status, 404, '0 字节文件同样要报 404');

    // 场景三：有记录时正常下载，且内容非空
    audit.appendAudit('draft.send', { target: '测试邮件', source: '单元测试', extra: { to: 'a@b.com' } });
    const okRes = await fetch(`${url}/api/audit/download`, { headers: H });
    assertEqual(okRes.status, 200, '有记录时应能下载');
    const text = await okRes.text();
    assert(text.length > 0, '下载内容不应为空');
    assertIncludes(text, '测试邮件', '下载内容应含台账记录');
    assertEqual(JSON.parse(text.trim().split('\n')[0]).action, 'draft.send', '应是可解析的 JSONL');

    // 列表接口：空态与筛选
    const list = await (await fetch(`${url}/api/audit?action=draft.send`, { headers: H })).json();
    assertEqual(list.ok, true, '台账接口应可用');
    assert(list.items.length >= 1, '应能按动作筛选出记录');
    assertEqual(list.items[0].target, '测试邮件', '筛出的应是刚写的那条');
    assert(list.stats.total >= 1, '应给出统计');
    assert(list.actions['draft.send'], '应回传动作字典供界面做下拉');
  } finally {
    await new Promise((r) => server.close(r));
    if (backup === null) {
      if (fs.existsSync(file)) fs.rmSync(file);
    } else {
      fs.writeFileSync(file, backup, 'utf8');
    }
  }
});

await test('HTTP：日历接口、OAuth 回调与跨源防护', async () => {
  const { startServer } = await import('../server/index.js');
  const { server, url } = await startServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const H = { 'content-type': 'application/json' };
  const base = url;
  try {
    // 状态
    const status = await (await fetch(`${base}/api/calendar/status`, { headers: H })).json();
    assertEqual(status.ok, true, 'status.ok');
    assertEqual(status.ready, true, '应显示已就绪');
    assert(status.suggestedRedirectUri.includes('/api/calendar/oauth/callback'), '应给出回调地址建议');

    // 配置指引
    const hint = await (await fetch(`${base}/api/calendar/config-hint`, { headers: H })).json();
    assert(hint.setupSteps.length >= 5, '应给出分步指引');
    assertIncludes(hint.setupSteps.join(' '), 'Calendar API', '指引应提到启用 API');

    // 未确认不得写入（428）
    const noConfirm = await fetch(`${base}/api/calendar/events`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ sessionId: 'x' }),
    });
    assertEqual(noConfirm.status, 428, '未确认应返回 428');

    // 「测试连接」用的是服务端已保存的配置：清空后必须报「未保存」并可执行
    // 注意：saveConfig 会重建配置对象，必须用 getConfig() 取「当前」对象，
    // 不能复用文件顶部那个旧引用，否则改的是已经没人读的对象。
    const liveGoogle = getConfig().calendar.google;
    const restore = { clientId: liveGoogle.clientId, clientSecret: liveGoogle.clientSecret, redirectUri: liveGoogle.redirectUri };
    liveGoogle.clientId = '';
    liveGoogle.clientSecret = '';
    liveGoogle.redirectUri = '';
    const notConfigured = await fetch(`${base}/api/calendar/test`, { method: 'POST', headers: H, body: '{}' });
    assertEqual(notConfigured.status, 400, '未配置时应 400');
    const ncBody = await notConfigured.json();
    assertEqual(ncBody.code, 'GOOGLE_NOT_CONFIGURED', '错误码');
    assertIncludes(ncBody.message, '未保存', '应说明「未保存」');
    assertIncludes(ncBody.message, '保存配置', '应给出操作指引');
    assertEqual(ncBody.detail.sources.clientId, '未配置', 'detail 应带来源');
    Object.assign(liveGoogle, restore);

    // 恢复配置后「测试连接」应能通过
    const tested = await (await fetch(`${base}/api/calendar/test`, { method: 'POST', headers: H, body: '{}' })).json();
    assertEqual(tested.ok, true, '配置完整后应测试通过');
    assertEqual(tested.calendar.summary, '主要日历', '应返回目标日历信息');

    // 对话 → 确认写入
    const chat = await (
      await fetch(`${base}/api/calendar/chat`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ message: '下周三下午两点项目评审会，会议室B，李工参加' }),
      })
    ).json();
    assertEqual(chat.ok, true, `chat.ok（实际：${chat.code || ''} ${chat.message || ''}）`);
    assertEqual(chat.kind, 'confirm', '应进入确认态');
    const commit = await (
      await fetch(`${base}/api/calendar/events`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ sessionId: chat.sessionId, confirm: true }),
      })
    ).json();
    assertEqual(commit.ok, true, 'commit.ok');
    assert(commit.event.id, '应返回事件 id');

    // 会话可回读
    const session = await (await fetch(`${base}/api/calendar/sessions/${chat.sessionId}`, { headers: H })).json();
    assertEqual(session.session.pending, null, '确认后待确认应为空');
    assert(session.session.messages.length >= 2, '应保留对话记录');

    // 邮件转日程
    const sug = await (await fetch(`${base}/api/calendar/from-emails`, { method: 'POST', headers: H, body: JSON.stringify({ instanceId: 'default' }) })).json();
    assert(Array.isArray(sug.suggestions), '应返回建议数组');

    // 洞察
    const insight = await (await fetch(`${base}/api/calendar/insight?days=7`, { headers: H })).json();
    assertEqual(insight.days.length, 7, '洞察应返回 7 天');

    // 跨源防护：伪造 Origin 必须被拒
    const cross = await fetch(`${base}/api/calendar/chat`, {
      method: 'POST',
      headers: { ...H, origin: 'http://evil.example.com' },
      body: JSON.stringify({ message: '明天开会' }),
    });
    assertEqual(cross.status, 403, `跨源请求应被拒（实际 ${cross.status}）`);
    const crossBody = await cross.json();
    assertEqual(crossBody.code, 'CROSS_ORIGIN_BLOCKED', '错误码');

    // 同源来源应放行
    const sameOrigin = await fetch(`${base}/api/calendar/status`, { headers: { ...H, origin: `http://127.0.0.1:${new URL(base).port}` } });
    assertEqual(sameOrigin.status, 200, '同源应放行');

    // OAuth 回调：错误参数应返回可读的失败页而不是 JSON
    const callback = await fetch(`${base}/api/calendar/oauth/callback?error=access_denied`);
    assertEqual(callback.status, 400, '回调失败应 400');
    const html = await callback.text();
    assertIncludes(html, '拒绝了本次授权', '应给出针对性的标题');
    assertIncludes(html, 'access_denied', '应带上 Google 的错误原因');
    assertIncludes(html, 'postMessage', '应通知原窗口');

    // access_denied 必须给出「测试用户」这条可执行指引，而不是回显原始文案
    assertIncludes(html, '测试用户', '应指出测试用户限制');
    assertIncludes(html, 'OAuth 同意屏幕', '应指明去哪个页面修');
    assertIncludes(html, '<ol', '应给出编号步骤');
    assert((html.match(/<li>/g) || []).length >= 4, '步骤应足够具体');

    // 其它授权错误也要有对应指引
    const mismatch = await (await fetch(`${base}/api/calendar/oauth/callback?error=redirect_uri_mismatch`)).text();
    assertIncludes(mismatch, '回调地址不匹配', 'redirect_uri_mismatch 应有专门说明');
    assertIncludes(mismatch, '一致', '应提示两边保持一致');

    // 回调缺参
    const badCallback = await fetch(`${base}/api/calendar/oauth/callback?code=x`);
    assertEqual(badCallback.status, 400, '缺 state 应 400');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test('HTTP：授权 URL 只为回环地址签发', async () => {
  const { startServer } = await import('../server/index.js');
  const { server, url } = await startServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const H = { 'content-type': 'application/json' };
  try {
    const ok = await (
      await fetch(`${url}/api/calendar/auth-url`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({ redirectUri: 'http://127.0.0.1:9999/api/calendar/oauth/callback' }),
      })
    ).json();
    assertEqual(ok.ok, true, '回环地址应放行');
    // 注意：测试环境把 OAuth 端点也指向了本地 mock，因此断言路径与参数而非域名
    assertIncludes(ok.url, '/o/oauth2/v2/auth', '应指向 OAuth 授权端点');
    assertIncludes(ok.url, 'response_type=code', '应为授权码流程');
    assertIncludes(ok.url, encodeURIComponent('https://www.googleapis.com/auth/calendar.events'), '应包含 calendar.events 权限');

    // 非回环地址必须被拒（防止授权码被打到第三方）
    const bad = await fetch(`${url}/api/calendar/auth-url`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ redirectUri: 'https://evil.example.com/callback' }),
    });
    assertEqual(bad.status, 400, '非回环地址应被拒');
    const badBody = await bad.json();
    assertEqual(badBody.code, 'REDIRECT_URI_REJECTED', '错误码');
    assertIncludes(badBody.message, '本机', '应说明原因');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

/* -------------------------------------------------- 10. 对话式邮件检索 */

/** 造一批带不同发件人/主题/时间的分析记录，用于检索测试。 */
function seedSearchableEmails() {
  // 注意：必须相对**固定的 NOW**（2026-09-27）而不是真实时钟。
  // 用 Date.now() 会与 mock LLM 返回的固定日期区间（2026-08-28 ~ 2026-09-27）错位——
  // 一旦真实日期跨月（例如到了 10 月），day(3) 就会掉出这个区间，测试会毫无理由地失败。
  const day = (offset) => new Date(NOW.getTime() - offset * 86_400_000).toISOString();
  const mk = (uid, { subject, from, to, cc, date, priority, needsReply, type, snippet, recipientKind = 'direct' }) => ({
    folder: 'INBOX',
    uid,
    instanceId: 'default',
    type: type || 'action_required',
    priority: priority || 'normal',
    needsReply: needsReply !== false,
    recipientKind,
    summary: `${subject} 的要点`,
    actions: needsReply === false ? [] : ['处理一下'],
    mail: {
      uid,
      folder: 'INBOX',
      subject,
      from,
      to: to || [{ address: 'me@company.com' }],
      cc: cc || [],
      date,
      snippet: snippet || subject,
      messageId: `<seed-${uid}@x.com>`,
      hasAttachments: false,
      attachments: [],
    },
    analyzedAt: date,
  });

  return [
    mk(7001, {
      subject: '合同附件二付款条款确认',
      from: { name: '客户张总', address: 'zhang@client.com' },
      date: day(3),
      priority: 'urgent',
      recipientKind: 'direct',
      snippet: '请确认合同附件二的付款条款',
    }),
    mk(7002, {
      subject: '月度报告提交提醒',
      from: { name: '王经理', address: 'wang@client.com' },
      date: day(5),
      priority: 'high',
      recipientKind: 'direct',
      snippet: '请于月底前提交月度报告',
    }),
    mk(7003, {
      subject: '合同模板更新（抄送）',
      from: { name: '法务部', address: 'legal@company.com' },
      to: [{ address: 'others@company.com' }],
      cc: [{ address: 'me@company.com' }],
      date: day(7),
      priority: 'high',
      needsReply: false,
      type: 'fyi',
      recipientKind: 'cc',
      snippet: '合同模板已更新，供参考',
    }),
    mk(7004, {
      subject: '系统通知：账单已生成',
      from: { name: '账单系统', address: 'noreply@system.com' },
      date: day(9),
      priority: 'low',
      needsReply: false,
      type: 'notification',
      recipientKind: 'direct',
      snippet: '账单已生成，无需回复',
    }),
    // 超出默认 30 天窗口，用于验证时间过滤
    mk(7005, {
      subject: '上上个月的合同讨论',
      from: { name: '客户张总', address: 'zhang@client.com' },
      date: day(70),
      priority: 'normal',
      recipientKind: 'direct',
      snippet: '关于合同的早期讨论',
    }),
  ];
}

await test('检索：按发件人 + 主题关键词过滤（含时间范围）', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  store.upsertAnalyses(seedSearchableEmails());
  store.persistState();

  const out = await searchEmails({ query: '张总上个月发过哪些关于合同的邮件', instanceId: 'default' });
  assertEqual(out.action, 'search', '意图应为检索');
  assertIncludes(out.understood, '合同', '应复述理解');
  assertEqual(out.filters.dateFrom, '2026-08-28', '应解析出起始日期');
  assertEqual(out.filters.dateTo, '2026-09-27', '应解析出结束日期');
  // 只有近 30 天内的那封张总合同邮件应命中（更早的那封被时间过滤掉）
  assertEqual(out.items.length, 1, `应命中 1 封（实际 ${out.items.map((i) => i.subject).join('、')}）`);
  assertIncludes(out.items[0].subject, '合同附件二', '命中的应是近期的合同邮件');
  assertIncludes(out.assistant, '结论', '应返回分析');
});

await test('检索：按优先级 + 需回复过滤', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  const out = await searchEmails({ query: '近一个月需要我处理的高优先级邮件', instanceId: 'default' });
  const subjects = out.items.map((i) => i.subject);
  assert(subjects.some((s) => s.includes('合同附件二')), '应包含紧急合同邮件');
  assert(subjects.some((s) => s.includes('月度报告')), '应包含高优先级报告提醒');
  assert(!subjects.some((s) => s.includes('账单')), '低优先级通知不应命中');
  for (const it of out.items) {
    assert(['urgent', 'high'].includes(it.priority), '结果应只有高优先级');
    assertEqual(it.needsReply, true, '结果应都是需回复的');
    // 旧数据（早于收件人判定功能）没有 recipientKind，不能因此被排除；
    // 有判定的则必须是通过「直接发我」进来的，抄送件不得出现在待处理里。
    assert(
      it.recipientKind === 'direct' || it.recipientKind === 'unknown',
      `需处理里不应出现抄送件（实际 ${it.recipientKind}）`,
    );
  }
  assert(
    out.items.some((it) => it.recipientKind === 'direct'),
    '至少应命中一封判定为「直接发我」的邮件',
  );
});

await test('检索：按收件方式（仅抄送）过滤', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  const out = await searchEmails({ query: '这个月抄送给我的重要邮件', instanceId: 'default' });
  assert(out.items.length >= 1, '应命中抄送邮件');
  for (const it of out.items) {
    assertEqual(it.recipientKind, 'cc', '应只返回抄送邮件');
    assertEqual(it.recipientLabel, '抄送给我', '标签应正确');
  }
});

await test('检索：无结果时说明原因与覆盖范围，不编造', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  const out = await searchEmails({ query: '完全不存在的东西 xyzzy', instanceId: 'default' });
  assertEqual(out.items.length, 0, '不应有结果');
  assertIncludes(out.assistant, '没有找到', '应说明未找到');
  assertIncludes(out.assistant, '2026-', '应给出时间范围');
  assertIncludes(out.assistant, '已分析', '应说明本地覆盖范围与局限');
});

await test('检索：意图不明确时反问而不是瞎猜', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  const out = await searchEmails({ query: '不知道要找啥', instanceId: 'default' });
  assertEqual(out.needMore, true, '应进入追问');
  assert(out.assistant.length > 5, '应给出追问内容');
  assertEqual(out.items.length, 0, '追问时不应返回结果');
});

await test('检索：过长时间范围被收敛到一年内', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  const out = await searchEmails({ query: '帮我找十年的邮件', instanceId: 'default' });
  const from = out.filters.dateFrom;
  const to = out.filters.dateTo;
  const days = (new Date(to).getTime() - new Date(from).getTime()) / 86_400_000;
  assert(days <= 366, `时间范围应不超过一年（实际 ${Math.round(days)} 天）`);
});

await test('检索：无时间条件时使用默认 30 天并可被识别', async () => {
  const { normalizeFilters } = await import('../server/ai/search.js');
  const now = new Date('2026-09-27T06:30:00Z');
  const f = normalizeFilters({ from: ['张总'] }, { now, timeZone: TZ });
  assertEqual(f.dateFrom, '2026-08-28', '默认回看 30 天');
  assertEqual(f.dateTo, '2026-09-27', '到今天');
  assertEqual(f.explicitRange, false, '应标记为默认范围');
});

await test('检索：非法筛选值被丢弃，不会导致查询异常', async () => {
  const { normalizeFilters, applyFilters } = await import('../server/ai/search.js');
  const now = new Date('2026-09-27T06:30:00Z');
  const f = normalizeFilters(
    { types: ['不存在的类型', 'notification'], priorities: ['urgent', 'bogus'], recipientKind: '奇怪的', limit: 99999 },
    { now, timeZone: TZ },
  );
  assertEqual(f.types.join(','), 'notification', '非法类型应被过滤');
  assertEqual(f.priorities.join(','), 'urgent', '非法优先级应被过滤');
  assertEqual(f.recipientKind, 'any', '非法收件方式应回退为 any');
  assertEqual(f.limit, 200, 'limit 应被夹到上限');
  // 不应抛错
  const res = applyFilters(seedSearchableEmails(), f);
  assert(Array.isArray(res), '应返回数组');
});

/* -------------------------------------------------- 11. 检索按需回补 */

await test('检索回补：本地未覆盖的时间段会按需拉取并分析，从而查到邮件', async () => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { searchEmails } = await import('../server/ai/search.js');
    const { saveConfig, maskConfig, resetConfigCache } = await import('../server/config/index.js');

  // 再造一个邮箱实例，里面有 9 月初的历史邮件（本地从未分析过）
  const older = '2026-09-05T02:00:00.000Z';
  const historyImap = await mailMocks.startMockImap({
    messages: [
      {
        uid: 9001,
        raw: mailMocks.makeRawMail({
          subject: '合同条款确认（9 月初）',
          from: { name: '张总', address: 'zhang@client.com' },
          body: '请确认合同条款。',
          date: new Date(older),
          messageId: '<hist-1@client.com>',
        }),
        flags: [],
        internalDate: new Date(older).toUTCString(),
      },
      {
        uid: 9002,
        raw: mailMocks.makeRawMail({
          subject: '合同附件补充说明',
          from: { name: '张总', address: 'zhang@client.com' },
          body: '补充一下合同附件。',
          date: new Date('2026-09-06T02:00:00.000Z'),
          messageId: '<hist-2@client.com>',
        }),
        flags: [],
        internalDate: new Date('2026-09-06T02:00:00.000Z').toUTCString(),
      },
    ],
  });

  const savedPath = process.env.MAILBOT_DATA_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbot-backfill-'));
  try {
    // 用一个干净的数据目录，确保「本地没有这些邮件」是真实前提
    process.env.MAILBOT_DATA_DIR = scratch;
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
    // 注意：必须改 getConfig() 返回的**当前**对象。若只改 loadConfig 的返回值，
    // 后续 resetConfigCache 会让服务端读到另一个对象，实例配置就「丢失」了
    // （表现为回补时报 No password configured）。
    const live = getConfig();
    live.instances = [
      {
        id: 'bf',
        label: '回补邮箱',
        imap: { host: '127.0.0.1', port: historyImap.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
        smtp: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
        identity: { name: '王磊', email: 'bot@example.com' },
      },
    ];
    live.defaultInstanceId = 'bf';
    live.calendar.timeZone = TZ;
    live.llm = { ...live.llm, baseUrl: llm.baseUrl, apiKey: 'test', model: 'mock', maxRetries: 1 };
    live.search = { backfillMax: 20 };
    store.loadState({ force: true });
    store.persistState({ prune: false });
    saveConfig(maskConfig(getConfig()));

    // 前提校验：本地确实没有任何已分析邮件
    assertEqual(store.listAnalyses({ instanceId: 'bf', limit: 10 }).length, 0, '开始前本地应为空');

    const out = await searchEmails({
      query: '张总上个月发过哪些关于合同的邮件',
      instanceId: 'bf',
      now: new Date('2026-09-27T06:30:00Z'),
    });

    assertEqual(out.stats.backfill?.attempted, true, '应触发按需回补');
    assert(out.stats.backfill.fetched >= 2, `应拉取到历史邮件（实际 ${out.stats.backfill.fetched}）`);
    assert(out.stats.backfill.analyzed >= 2, `应完成分析（实际 ${out.stats.backfill.analyzed}）`);
    assertEqual(out.items.length >= 2, true, `应命中历史邮件（实际 ${out.items.length} 封）`);
    const subjects = out.items.map((i) => i.subject).join('｜');
    assertIncludes(subjects, '合同', '命中的应是合同相关邮件');
    // 回补落库后，收件人身份也要判定出来
    const stored = store.listAnalyses({ instanceId: 'bf', limit: 10 });
    assert(stored.length >= 2, '回补结果应落库');
    assert(
      stored.every((r) => typeof r.recipientKind === 'string' && r.recipientKind !== 'unknown'),
      '回补的邮件也应判定收件人身份',
    );
    assertEqual(out.stats.backfill.failed, false, '不应标记为失败');
  } finally {
    process.env.MAILBOT_DATA_DIR = savedPath;
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
    rmTempDir(scratch);
    await historyImap.close();
  }
});

await test('检索回补：本次会话已分析过的邮件不重复拉取', async () => {
  const { backfillNeeded } = await import('../server/ai/backfill.js');
  const records = [
    { mail: { date: '2026-09-05T02:00:00.000Z' } },
    { mail: { date: '2026-09-27T02:00:00.000Z' } },
  ];
  // 覆盖已足够时不需要回补
  const covered = backfillNeeded(records, { dateFrom: '2026-09-06', dateTo: '2026-09-27' }, TZ);
  assertEqual(covered.needed, false, '范围已被覆盖时不应回补');
  // 范围更早时需要回补，并给出缺口的起点
  const missing = backfillNeeded(records, { dateFrom: '2026-09-01', dateTo: '2026-09-27' }, TZ);
  assertEqual(missing.needed, true, '范围更早时应回补');
  assertEqual(missing.missingFrom, '2026-09-01', '应报出缺口起点');
  assertIncludes(missing.reason, '2026-09-05', '原因里应包含本地最早日期');
  // 本地为空时也需要回补
  assertEqual(backfillNeeded([], { dateFrom: '2026-09-01', dateTo: '2026-09-27' }, TZ).needed, true, '本地为空应回补');
  // 本地最早邮件的 UTC 日期是 8/31，但北京时间是 9/1：按本地时区看，9 月已经被覆盖了
  const boundary = [{ mail: { date: '2026-08-31T17:51:00.000Z' } }];
  assertEqual(
    backfillNeeded(boundary, { dateFrom: '2026-09-01', dateTo: '2026-09-27' }, TZ).needed,
    false,
    '日期边界必须按配置时区判断：UTC 8/31 在北京已是 9/1',
  );
});

await test('检索回补：服务器丢 ENVELOPE 响应时，改用头部查询照样查全', async () => {
  const { fetchHeaders } = await import('../server/mail/imap.js');

  // 造 40 封同一发件人的邮件，并让模拟服务器复现真实缺陷：
  // 大批量 `ENVELOPE` 查询会确定性丢响应（约每 4 封只回 1 封）。
  const messages = [];
  for (let i = 0; i < 40; i += 1) {
    const date = new Date(Date.UTC(2026, 8, 10, 2, i));
    messages.push({
      uid: 7000 + i,
      raw: mailMocks.makeRawMail({
        subject: `丢包复现 ${i}`,
        from: { name: '李明', address: 'liming@client.com' },
        body: `第 ${i} 封正文`,
        date,
        messageId: `<loss-${i}@client.com>`,
      }),
      flags: [],
      internalDate: date.toUTCString(),
    });
  }
  const srv = await mailMocks.startMockImap({ messages, envelopeBug: true, envelopeBugKeep: 0.25 });
  try {
    const instance = {
      id: 'lossy',
      imap: { host: '127.0.0.1', port: srv.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    };
    const got = await fetchHeaders(instance, { folder: 'INBOX', uids: messages.map((m) => m.uid) });
    assertEqual(got.length, 40, `头部查询应完整返回 40 封（实际 ${got.length}——说明又走回了会丢包的 ENVELOPE）`);
    assert(
      got.every((m) => m.from?.address === 'liming@client.com' && m.date),
      '每封都应从头部解析出发件人与时间',
    );
    assertEqual(got[0].subject, '丢包复现 0', '主题也应解析正确');
  } finally {
    await srv.close();
  }
});

await test('检索回补：日期边界按配置时区判断（UTC 8/31 属于北京 9/1）', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  const os = await import('node:os');
  const path = await import('node:path');
  const { saveConfig, maskConfig, resetConfigCache } = await import('../server/config/index.js');

  // 这封邮件的时间戳是 UTC 8/31 17:51 —— 北京时间已经是 9/1 01:51。
  const rawDate = '2026-08-31T17:51:00.000Z';
  const tzImap = await mailMocks.startMockImap({
    messages: [
      {
        uid: 9501,
        raw: mailMocks.makeRawMail({
          subject: '边界邮件：9 月第一封',
          from: { name: '边界测试', address: 'boundary@client.com' },
          body: '时间戳在 UTC 8 月 31 日，但北京时间是 9 月 1 日。',
          date: new Date(rawDate),
          messageId: '<tz-1@client.com>',
        }),
        flags: [],
        internalDate: new Date(rawDate).toUTCString(),
      },
    ],
  });

  const savedPath = process.env.MAILBOT_DATA_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbot-tz-'));
  try {
    process.env.MAILBOT_DATA_DIR = scratch;
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
    const live = getConfig();
    live.instances = [
      {
        id: 'tz',
        label: '时区边界邮箱',
        imap: { host: '127.0.0.1', port: tzImap.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
        smtp: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
        identity: { name: '王磊', email: 'bot@example.com' },
      },
    ];
    live.defaultInstanceId = 'tz';
    live.calendar.timeZone = TZ;
    live.llm = { ...live.llm, baseUrl: llm.baseUrl, apiKey: 'test', model: 'mock', maxRetries: 1 };
    live.search = { backfillMax: 20 };
    store.loadState({ force: true });
    store.persistState({ prune: false });
    saveConfig(maskConfig(getConfig()));

    // 旧逻辑按 UTC 取前 10 位，会把这封邮件算成 8/31 并从「9 月」里剔除
    assertEqual(String(rawDate).slice(0, 10), '2026-08-31', '该邮件的 UTC 日期确实是 8/31');

    const out = await searchEmails({ query: '边界测试这个月发来的邮件', instanceId: 'tz', now: NOW });
    assertEqual(out.filters.dateFrom, '2026-09-01', '检索范围应只有 9 月');
    assertEqual(out.stats.backfill?.attempted, true, '应触发按需回补');
    assert(out.items.length >= 1, `应命中这封边界邮件（实际 ${out.items.length} 封）`);
    assertIncludes(out.items[0].subject, '边界邮件', '命中的应是边界邮件');
    assertEqual(out.items[0].day, '2026-09-01', '结果里的日期应按本地时区显示为 9/1');
    assertIncludes(out.assistant, '封相关邮件', '应给出检索结论');
  } finally {
    process.env.MAILBOT_DATA_DIR = savedPath;
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
    rmTempDir(scratch);
    await tzImap.close();
  }
});

await test('检索回补：配置为 0 时关闭，并给出可执行提示', async () => {
  const { searchEmails } = await import('../server/ai/search.js');
  const os = await import('node:os');
  const path = await import('node:path');
    const { saveConfig, maskConfig, resetConfigCache } = await import('../server/config/index.js');

  const imap2 = await mailMocks.startMockImap({
    messages: [
      {
        uid: 9101,
        raw: mailMocks.makeRawMail({ subject: '旧邮件', from: { name: '张总', address: 'zhang@client.com' }, date: new Date('2026-09-04T02:00:00.000Z') }),
        flags: [],
        internalDate: new Date('2026-09-04T02:00:00.000Z').toUTCString(),
      },
    ],
  });
  const savedPath = process.env.MAILBOT_DATA_DIR;
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbot-nobf-'));
  try {
    process.env.MAILBOT_DATA_DIR = scratch;
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
    const live = getConfig();
    live.instances = [
      {
        id: 'nobf',
        label: '关闭回补',
        imap: { host: '127.0.0.1', port: imap2.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
        smtp: { host: '127.0.0.1', port: 1, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
        identity: { name: '王磊', email: 'bot@example.com' },
      },
    ];
    live.defaultInstanceId = 'nobf';
    live.calendar.timeZone = TZ;
    live.llm = { ...live.llm, baseUrl: llm.baseUrl, apiKey: 'test', model: 'mock', maxRetries: 1 };
    live.search = { backfillMax: 0 };
    store.loadState({ force: true });
    store.persistState({ prune: false });
    saveConfig(maskConfig(getConfig()));

    const out = await searchEmails({ query: '张总上个月发过哪些关于合同的邮件', instanceId: 'nobf', now: new Date('2026-09-27T06:30:00Z') });
    assertEqual(out.stats.backfill, null, '关闭时不应回补');
    assertEqual(out.items.length, 0, '本地为空且关闭回补，应查不到');
    assertIncludes(out.assistant, '按需回补当前是关闭的', '应说明关闭了回补');
    assertIncludes(out.assistant, '按需回补上限', '应给出可执行的调整项');
  } finally {
    process.env.MAILBOT_DATA_DIR = savedPath;
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
    rmTempDir(scratch);
    await imap2.close();
  }
});

/* ------------------------------------------------------------ 代理（访问 Google） */

await test('代理：地址解析（空/裸地址/带凭据/NO_PROXY/回环/SOCKS 拒绝）', async () => {
  const { parseProxy, resolveProxyFor } = await import('../server/lib/http.js');

  assertEqual(parseProxy(''), null, '空字符串 = 直连');
  assertEqual(parseProxy('   '), null, '空白 = 直连');

  const bare = parseProxy('127.0.0.1:7890');
  assertEqual(bare.host, '127.0.0.1', '裸 host:port 应自动补 http://');
  assertEqual(bare.port, 7890, '端口');
  assertEqual(bare.auth, '', '无凭据');

  const withAuth = parseProxy('http://user:p%40ss@10.0.0.1:3128');
  assertEqual(withAuth.auth, 'user:p@ss', 'URL 编码的密码应被解码');
  assertEqual(withAuth.port, 3128, '端口');

  // SOCKS 必须给出明确指引，而不是静默失败
  let socksCode = null;
  try {
    parseProxy('socks5://127.0.0.1:1080');
  } catch (err) {
    socksCode = err.code;
  }
  assertEqual(socksCode, 'PROXY_SOCKS_UNSUPPORTED', '应提示改用 HTTP 端口');

  // 显式配置的代理一律生效（含回环目标，测试正是靠这条走通代理链路的）
  assertEqual(resolveProxyFor('http://127.0.0.1:9/x', { proxy: 'http://127.0.0.1:7890' })?.port, 7890, '显式代理应生效');
  // 环境变量探测来的代理则跳过回环地址，免得把本机模拟服务代理走
  assertEqual(resolveProxyFor('http://127.0.0.1:9/x', { proxy: '', env: { HTTPS_PROXY: 'http://1.2.3.4:8080' } }), null, '回环地址直连');
  assertEqual(resolveProxyFor('https://www.googleapis.com/x', { proxy: '', env: { HTTPS_PROXY: 'http://1.2.3.4:8080' } })?.host, '1.2.3.4', '外网地址应走环境变量代理');
  // NO_PROXY 优先
  assertEqual(
    resolveProxyFor('https://www.googleapis.com/x', { proxy: 'http://1.2.3.4:8080', noProxy: 'googleapis.com' }),
    null,
    'NO_PROXY 命中的主机应直连',
  );
});

await test('代理：请求真的经过代理转发（HTTP 目标走绝对 URI）', async () => {
  const { listEvents } = await import('../server/calendar/google-api.js');
  const proxy = await mocks.startMockProxy();
  const savedBase = process.env.MAILBOT_GOOGLE_API_BASE;
  const live = getConfig();
  const savedProxy = live.calendar.proxy;
  try {
    // 让 API 指向本地模拟 Google；代理也指向本地模拟代理。
    // 这样「是否真的走了代理」可以直接从代理服务器的请求记录上看出来。
    process.env.MAILBOT_GOOGLE_API_BASE = google.apiBase;
    live.calendar.proxy = proxy.url;
    const before = proxy.requests.length;
    const list = await listEvents({ timeMin: new Date('2026-09-27T00:00:00Z'), timeMax: new Date('2026-09-28T00:00:00Z') });
    assert(Array.isArray(list.items), '应返回事件数组');
    const seen = proxy.requests.slice(before);
    assert(seen.length > 0, '代理服务器应收到请求（否则说明代理没生效）');
    assertEqual(seen[0].kind, 'http', 'HTTP 目标走绝对 URI 转发');
    assertIncludes(seen[0].target, '127.0.0.1', '代理收到的应是完整目标地址');

    // 代理要求认证但没带凭据 → 明确的 407 提示
    const authProxy = await mocks.startMockProxy({ auth: 'u:p' });
    try {
      live.calendar.proxy = authProxy.url;
      let code = null;
      let message = '';
      try {
        await listEvents({ timeMin: new Date('2026-09-27T00:00:00Z'), timeMax: new Date('2026-09-28T00:00:00Z') });
      } catch (err) {
        code = err.code;
        message = err.message;
      }
      assertEqual(code, 'GOOGLE_NETWORK_ERROR', '应归类为网络错误');
      assertIncludes(message, '407', '应带出代理返回的状态码');
      assertIncludes(message, '用户名:密码', '应告诉用户怎么写带凭据的代理地址');

      // 带上凭据后应能正常通过
      live.calendar.proxy = `http://u:p@127.0.0.1:${authProxy.port}`;
      const okList = await listEvents({ timeMin: new Date('2026-09-27T00:00:00Z'), timeMax: new Date('2026-09-28T00:00:00Z') });
      assert(Array.isArray(okList.items), '带凭据时应成功');
    } finally {
      await authProxy.close();
    }
  } finally {
    live.calendar.proxy = savedProxy;
    if (savedBase === undefined) delete process.env.MAILBOT_GOOGLE_API_BASE;
    else process.env.MAILBOT_GOOGLE_API_BASE = savedBase;
    await proxy.close();
  }
  return '绝对 URI 转发 + 407 凭据提示';
});

await test('代理：HTTPS 目标走 CONNECT 隧道；代理拒绝时给出可执行中文提示', async () => {
  const { listEvents } = await import('../server/calendar/google-api.js');
  const { httpRequest, describeNetworkError } = await import('../server/lib/http.js');

  // 1) 直接验证 CONNECT 隧道确实被建立（目标用 https，代理固定回 502）
  const refusing = await mocks.startMockProxy({ connectStatus: 502 });
  try {
    const info = await httpRequest('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      proxy: refusing.url,
      timeoutMs: 5000,
    }).then(
      () => ({ ok: true }),
      (err) => describeNetworkError(err, { target: 'Google', proxyUsed: { raw: refusing.url } }),
    );
    assertEqual(info.ok, undefined, '代理拒绝时应失败');
    assertEqual(info.code, 'PROXY_CONNECT_FAILED', `应识别为代理拒绝隧道（实际 ${info.code}）`);
    assertIncludes(info.advice, refusing.url, '提示里应带上当前代理地址');
    assertEqual(refusing.requests[0]?.kind, 'connect', '代理应收到 CONNECT');
    assertIncludes(refusing.requests[0]?.target || '', ':443', 'CONNECT 目标应是 443 端口');
  } finally {
    await refusing.close();
  }

  // 2) 代理端口没人监听 → ECONNREFUSED，且提示指向「代理软件没运行/端口不对」
  const { server: deadServer } = await (async () => {
    const net = await import('node:net');
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return { server: { port: p } };
  })();
  const live = getConfig();
  const saved = live.calendar.proxy;
  try {
    live.calendar.proxy = `http://127.0.0.1:${deadServer.port}`;
    let out = null;
    try {
      await listEvents({ timeMin: new Date('2026-09-27T00:00:00Z'), timeMax: new Date('2026-09-28T00:00:00Z') });
    } catch (err) {
      out = err;
    }
    assert(out, '应抛错');
    assertEqual(out.code, 'GOOGLE_NETWORK_ERROR', '应归类为网络错误');
    assertIncludes(out.message, 'ECONNREFUSED', '应带出真实底层错误码');
    assertIncludes(out.message, '代理软件', '应提示检查代理软件是否在运行');
  } finally {
    live.calendar.proxy = saved;
  }
  return 'CONNECT 目标 :443 · 502 → PROXY_CONNECT_FAILED · 端口不通 → ECONNREFUSED';
});

await test('自检：日历启用时会探测 Google 网络出口并给出结论', async () => {
  const { runDiagnostics } = await import('../server/diagnostics.js');
  const live = getConfig();
  const savedEnabled = live.calendar.enabled;
  const savedProxy = live.calendar.proxy;
  const savedBase = process.env.MAILBOT_GOOGLE_API_BASE;
  try {
    // 用本地模拟 Google 充当「可达」的出口
    process.env.MAILBOT_GOOGLE_API_BASE = google.oauthBase;
    live.calendar.enabled = true;
    live.calendar.proxy = '';
    const ok = await runDiagnostics({ instanceId: live.defaultInstanceId });
    const probe = ok.checks.find((c) => c.id === 'google-network');
    assert(probe, `应有 Google 网络出口检查项（实际检查项：${ok.checks.map((c) => c.id).join('、')}）`);
    assertEqual(probe.status, 'ok', `网络可达时应通过（实际：${probe.status} / ${probe.message}）`);
    assertIncludes(probe.message, '可达', '应给出耗时结论');

    // 指向一个没人监听的端口 → 必须报错并给出「配代理」的指引，而不是一句 fetch failed
    process.env.MAILBOT_GOOGLE_API_BASE = 'http://127.0.0.1:1';
    const bad = await runDiagnostics({ instanceId: live.defaultInstanceId });
    const badProbe = bad.checks.find((c) => c.id === 'google-network');
    assertEqual(badProbe.status, 'error', '不通时应报错');
    assertIncludes(badProbe.message, '网络代理', '应指引到「设置 → 网络代理」');
    assertEqual(bad.ok, false, '整体自检应为未通过');
  } finally {
    if (savedBase === undefined) delete process.env.MAILBOT_GOOGLE_API_BASE;
    else process.env.MAILBOT_GOOGLE_API_BASE = savedBase;
    live.calendar.enabled = savedEnabled;
    live.calendar.proxy = savedProxy;
  }
});

await test('定时分析：到点才跑、同一时刻只跑一次、失败不占坑重试刷屏', async () => {
  const { shouldRunNow } = await import('../server/schedule.js');
  const S = { enabled: true, times: ['08:30'], days: [1, 2, 3, 4, 5] };
  // 北京时间用 UTC 换算：北京 08:30 = UTC 00:30
  const mon0830 = new Date('2026-10-05T00:30:00Z');
  const mon0829 = new Date('2026-10-05T00:29:00Z');
  const sun0830 = new Date('2026-10-04T00:30:00Z');

  assertEqual(shouldRunNow({ now: mon0830, schedule: S }).run, true, '工作日到点应跑');
  assertEqual(shouldRunNow({ now: mon0829, schedule: S }).reason, 'not-now', '没到点不跑');
  assertEqual(shouldRunNow({ now: sun0830, schedule: S }).reason, 'weekday', '周末不跑');
  assertEqual(shouldRunNow({ now: mon0830, schedule: { ...S, enabled: false } }).reason, 'disabled', '关闭时永不跑');
  assertEqual(shouldRunNow({ now: mon0830, schedule: { ...S, times: [] } }).reason, 'no-times', '没设时刻不跑');
  assertEqual(shouldRunNow({ now: mon0830, schedule: S, busy: true }).reason, 'busy', '已有分析在跑时不并发');
  // 幂等：同一分钟（哪怕进程重启或 tick 抖动）只跑一次
  assertEqual(shouldRunNow({ now: mon0830, schedule: S, lastSlot: '2026-10-05 08:30' }).reason, 'already-ran', '同一时刻不重复跑');
  assertEqual(shouldRunNow({ now: mon0830, schedule: S, lastSlot: '2026-10-04 08:30' }).run, true, '换了一天应照常跑');
});

await test('定时分析：通知只在"确实有事"时发，且失败不影响结果', async () => {
  const cfg = getConfig();
  const saved = { email: cfg.notify?.email, inApp: cfg.notify?.inApp };
  try {
    // 关掉自寄简报，只验"该不该提醒"的判断
    cfg.notify = { ...(cfg.notify || {}), email: false, inApp: true };
    const { notifyRun } = await import('../server/schedule.js');

    const quiet = await notifyRun({ counts: { fetched: 2, analyzed: 2, needsReply: 0, drafts: 0 } });
    assertEqual(quiet.notified, false, '没事就不该发简报');
    assertEqual(quiet.reason, 'nothing-to-tell', '应说明原因');

    const busy = await notifyRun({ counts: { fetched: 5, analyzed: 5, needsReply: 3, drafts: 1 } });
    assertEqual(busy.notified, false, '未开自寄简报时不应发信');
    assertEqual(busy.reason, 'email-off', '应说明是开关没开');
    assertEqual(busy.note.needsReply, 3, '应把计数带出来给页内提示用');

    // 开了自寄简报但发信会失败（测试环境没有可用发件身份）→ 必须吞掉错误，不能影响分析结果
    cfg.notify = { ...cfg.notify, email: true, emailTo: '' };
    const failed = await notifyRun({ counts: { fetched: 1, analyzed: 1, needsReply: 1, drafts: 0 } });
    assertEqual(failed.notified, false, '发信失败时不应报成功');
    assert(failed.error || failed.reason === 'email-failed', `应如实给出失败信息（实际 ${JSON.stringify(failed).slice(0, 120)}）`);
  } finally {
    cfg.notify = { ...(cfg.notify || {}), ...saved };
  }
});

await test('HTTP：定时任务状态与"立即试一次"', async () => {
  const { startServer } = await import('../server/index.js');
  const { server, url } = await startServer({ rootDir: root, port: 0, host: '127.0.0.1' });
  const H = { 'content-type': 'application/json' };
  try {
    const st = await (await fetch(`${url}/api/schedule`, { headers: H })).json();
    assertEqual(st.ok, true, '状态接口应可用');
    assertEqual(st.enabled, false, '默认应关闭（不能偷偷连邮箱花 token）');
    assert(Array.isArray(st.times), '应回传时刻列表');
    assert(st.timeZone, '应回传时区');

    // 开启后保存配置 → 定时器应立即起停（不需要重启）
    const cfgRes = await fetch(`${url}/api/config`, { headers: H });
    const cfg = (await cfgRes.json()).config;
    const put = await fetch(`${url}/api/config`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ ...cfg, schedule: { ...cfg.schedule, enabled: true, times: ['07:15'], days: [1, 2, 3, 4, 5] } }),
    });
    assertEqual(put.status, 200, '保存配置应成功');
    const st2 = await (await fetch(`${url}/api/schedule`, { headers: H })).json();
    assertEqual(st2.enabled, true, '开关应立刻生效');
    assertEqual(st2.ticking, true, '保存后定时器应立即启动（不必重启）');
    assertEqual(st2.times.join(','), '07:15', '时刻应保存下来');

    // 关掉 → 定时器应立刻停
    await fetch(`${url}/api/config`, { method: 'PUT', headers: H, body: JSON.stringify({ ...cfg, schedule: { ...cfg.schedule, enabled: false } }) });
    const st3 = await (await fetch(`${url}/api/schedule`, { headers: H })).json();
    assertEqual(st3.enabled, false, '关闭应立即生效');
    assertEqual(st3.ticking, false, '关闭后定时器应停止');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

await test('定时分析：到点会真的执行；即使失败也要占住这个时刻（不刷屏重试）', async () => {
  const cfg = getConfig();
  const saved = JSON.parse(JSON.stringify(cfg.schedule || {}));
  const { runScheduledScan, shouldRunNow } = await import('../server/schedule.js');
  const { partsInZone } = await import('../server/calendar/time.js');
  const store = await import('../server/store/state.js');
  const tz = cfg.calendar?.timeZone || 'Asia/Shanghai';
  const p = partsInZone(new Date(), tz);
  const nowSlot = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
  try {
    // 把时刻设成"就是现在"，星期设成今天 → 应当真的去跑
    cfg.schedule = { enabled: true, times: [nowSlot], days: [0, 1, 2, 3, 4, 5, 6], windowHours: 24 };
    store.setScheduleState({ lastSlot: null, lastRunAt: null, lastResult: null, lastError: null });

    assertEqual(shouldRunNow({ now: new Date(), schedule: cfg.schedule }).run, true, '前置条件：此刻应判定为"该跑"');

    const out = await runScheduledScan();
    assertEqual(out.skipped, false, '应真的执行而不是跳过');
    const st = store.getState().schedule;
    assert(st.lastSlot, '应记录 lastSlot（幂等键）');
    assert(st.lastRunAt, '应记录执行时间');

    /*
     * 本测试环境的邮箱未配授权码，所以这次分析一定失败——而这正是要验的点：
     * **失败也必须占住这个时刻**，否则"邮箱连不上"会变成每分钟重试一次，
     * 把日志和网络都刷爆。失败原因要如实留下。
     */
    if (out.error) {
      assertIncludes(st.lastError, '授权码', '应如实记录失败原因');
    } else {
      assert(st.lastResult && st.lastResult.analyzed !== null, `成功时应记录结果（实际 ${JSON.stringify(st.lastResult)}）`);
    }

    // 紧接着再跑一次：同一分钟必须被幂等挡住，不管上次成功还是失败
    const again = await runScheduledScan();
    assertEqual(again.skipped, true, '同一分钟不应重复跑（成功或失败都一样）');
    assertEqual(again.reason, 'already-ran', '应说明是被幂等键挡住');
  } finally {
    store.setScheduleState({ lastSlot: null, lastRunAt: null, lastResult: null, lastError: null });
    cfg.schedule = saved;
  }
});

/* ------------------------------------------------------------ 收尾 */

await google.close();
await llm.close();

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
}
console.log(`\n测试数据目录：${tmpDir}`);
process.exit(failures.length ? 1 : 0);
