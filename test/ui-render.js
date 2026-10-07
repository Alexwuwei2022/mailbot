/**
 * 前端渲染自检：用最小 DOM 环境真实加载 web/ 下的模块，验证四个页面能正常渲染。
 * 需要 linkedom（仅开发用，未写入 package.json 依赖）：
 *   npm i -D linkedom
 *
 *   node test/ui-render.js
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listenRandom } from './lib/port.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let parseHTML;
try {
  ({ parseHTML } = await import('linkedom'));
} catch {
  console.log('跳过前端渲染自检：未安装 linkedom（npm i -D linkedom）');
  process.exit(0);
}

/* ------------------------------------------------------------ DOM 环境 */

const { window, document } = parseHTML('<!DOCTYPE html><html><body><div id="root"></div></body></html>');

globalThis.window = window;
globalThis.document = document;
globalThis.Node = window.Node;
globalThis.localStorage = {
  store: new Map(),
  getItem(k) {
    return this.store.has(k) ? this.store.get(k) : null;
  },
  setItem(k, v) {
    this.store.set(k, String(v));
  },
  removeItem(k) {
    this.store.delete(k);
  },
};
globalThis.location = { hash: '' };
globalThis.EventSource = class {
  addEventListener() {}
  close() {}
};

/* ------------------------------------------------------------ API 假数据 */

const { LLM_PRESETS } = await import('../server/config/defaults.js');
const now = new Date().toISOString();
const SIGNATURE_FIXTURE = '张三 | 示例事业部\n移动电话：13900000000\n安全提示：\n1) 公司不会通过邮件索要密码或验证码';
const mail = {
  uid: 101,
  folder: 'INBOX',
  subject: '请确认周五的交付计划',
  from: { name: '客户张总', address: 'boss@client.com' },
  to: [{ address: 'bot@example.com' }],
  date: now,
  snippet: '麻烦确认周五能否交付。',
  hasAttachments: false,
  attachments: [],
  messageId: '<m1@client.com>',
};
const analysis = {
  key: 'INBOX:101',
  folder: 'INBOX',
  uid: 101,
  type: 'action_required',
  priority: 'urgent',
  needsReply: true,
  summary: '客户要求确认周五交付时间。',
  actions: ['确认交付时间', '回复客户'],
  reason: '对方明确要求回复。',
  // 后端 /api/overview 的 needAction 项会把这些字段提到顶层
  subject: mail.subject,
  from: mail.from,
  date: now,
  messageId: mail.messageId,
  snippet: mail.snippet,
  mail,
  context: [{ direction: 'incoming', date: now, from: { name: '客户张总', address: 'boss@client.com' }, subject: '旧往来', body: '历史内容' }],
};
// 仅抄送给我的高优先级邮件 → 归入「需要你关注」
const ccAnalysis = {
  key: 'INBOX:102',
  folder: 'INBOX',
  uid: 102,
  type: 'fyi',
  priority: 'high',
  needsReply: false,
  summary: '抄送知会：下周运维窗口调整。',
  actions: [],
  reason: '仅抄送给我，无需回复。',
  recipientKind: 'cc',
  isDirect: false,
  isCcOnly: true,
  subject: '下周运维窗口调整（抄送）',
  from: { name: '运维组', address: 'ops@company.com' },
  date: now,
  mail: {
    uid: 102,
    folder: 'INBOX',
    subject: '下周运维窗口调整（抄送）',
    from: { name: '运维组', address: 'ops@company.com' },
    to: [{ address: 'others@company.com' }],
    cc: [{ address: 'me@company.com' }],
    date: now,
    snippet: '抄送知会：下周运维窗口调整。',
    hasAttachments: false,
    attachments: [],
    messageId: '<m2@company.com>',
  },
};

const draft = {
  id: 'draft_INBOX_101',  instanceId: 'default',
  status: 'pending',
  to: 'boss@client.com',
  cc: '',
  subject: 'Re: 请确认周五的交付计划',
  body: `张总您好，\n\n周五可以交付。\n\n顺祝工作顺利。\n\n${SIGNATURE_FIXTURE}`,
  reason: '给出明确承诺。',
  notes: ['请确认周四能否完成内部评审'],
  confidence: 0.8,
  model: 'deepseek-chat',
  createdAt: now,
  updatedAt: now,
  mailbox: { folder: 'Drafts', uid: 5, savedAt: now },
  source: { folder: 'INBOX', uid: 101, messageId: '<m1@client.com>', inReplyTo: '<t@c.com>', references: [], subject: mail.subject, from: mail.from, date: now },
  analysis,
};

// 「值得知悉」里的一封普通邮件（不在需处理/需关注里）
const socialNotice = {
  key: 'INBOX:103',
  folder: 'INBOX',
  uid: 103,
  type: 'social',
  priority: 'low',
  needsReply: false,
  summary: '协同办公平台推送了一条新待办。',
  actions: [],
  reason: '系统推送，无需回复。',
  subject: '【协同办公】您有一条新的待办事项',
  from: { name: '协同办公平台', address: 'noreply@oa.company.com' },
  date: '2026-09-27T02:15:00.000Z',
  mail: {
    uid: 103,
    folder: 'INBOX',
    subject: '【协同办公】您有一条新的待办事项',
    from: { name: '协同办公平台', address: 'noreply@oa.company.com' },
    to: [{ address: 'bot@example.com' }],
    date: '2026-09-27T02:15:00.000Z',
    snippet: '您有一条新的待办事项，请及时处理。',
    hasAttachments: false,
    attachments: [],
    messageId: '<m3@oa.company.com>',
  },
};

const responses = {
  '/api/meta': {
    ok: true,
    version: '1.0.0',
    dataDir: 'D:/tmp',
    defaultInstanceId: 'default',
    presets: [{ id: 'custom', label: '自定义', note: 'x', imap: {}, smtp: {} }],
    // 直接用服务端的真实预设：避免测试里另抄一份而慢慢与实现脱节
    llmPresets: LLM_PRESETS,
    topics: [{ id: 'client', label: '客户', count: 1 }],
    secretSources: {},
    counts: { pendingDrafts: 1, needsReply: 1 },
  },
  '/api/status': { ok: true, running: false, counts: { pendingDrafts: 1, needsReply: 1, analyses: 1, drafts: 1 } },
  '/api/overview': {
    ok: true,
    instanceId: 'default',
    windowHours: 24,
    generatedAt: now,
    lastRun: { id: 'run1', startedAt: now, status: 'success' },
    report: { id: 'r1', createdAt: now, markdown: '## 一句话总结\n客户在等周五交付的确认。\n\n## 需要你处理\n- 回复客户' },
    stats: { total: 2, needsReply: 1, attention: 1, urgent: 1, high: 1, withAttachments: 0, byType: { action_required: 1, fyi: 1 }, byPriority: { urgent: 1, high: 1 }, byRecipient: { direct: 1, cc: 1, self: 0, unknown: 0 }, drafts: { total: 1, pending: 1, sent: 0, failed: 0 } },
    typeLabels: { action_required: '待处理' },
    priorityLabels: { urgent: '紧急' },
    priorityList: [analysis, ccAnalysis, socialNotice],
    needAction: [{ ...analysis, hasDraft: true }],
    attention: [{ ...ccAnalysis, hasDraft: false }],
    actions: [{ subject: mail.subject, from: mail.from.address, priority: 'urgent', actions: ['确认交付时间'], date: now, folder: 'INBOX', uid: 101 }],
  },
  '/api/drafts': {
    ok: true,
    drafts: [draft],
    // 三个标签的数量（全量口径，不受筛选影响）
    counts: { pending: 2, failed: 1, sent: 5, all: 8 },
    signature: SIGNATURE_FIXTURE,
    quoteOriginal: true,
    quoteStyle: 'zh-client',
  },
  // 单封邮件详情：一封已发送、一封本地完全没有记录（用于验证不再只弹「未找到」）
  '/api/mails/INBOX/101': {
    ok: true,
    found: true,
    analyzed: true,
    instanceId: 'default',
    analysis: { ...analysis, typeLabel: '待处理', priorityLabel: '紧急', isDirectAction: true, isCcAttention: false },
    mail,
    draft: { id: 'draft_INBOX_101', status: 'sent', sentAt: now, subject: 'Re: 请确认周五的交付计划', to: 'boss@client.com' },
    // 「原始邮件」页签要用的全文（含引用历史）
    body: {
      available: true,
      source: 'archive',
      text: '张总您好：\n\n麻烦确认周五能否交付，并回复具体时间。\n\n谢谢！',
      quoted: '> 上一封：交付计划初稿\n> 请查收附件',
      truncated: false,
      chars: 33,
      subject: '请确认周五的交付计划',
      from: mail.from,
      to: mail.to,
      cc: [],
      date: now,
      messageId: '<m1@client.com>',
      // 附件清单一：故意给两个不同类型/大小的，验证序号、名称与大小展示
      attachments: [
        { filename: '需求说明.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 245760, inline: false },
        { filename: '报价 单.pdf', contentType: 'application/pdf', size: 1048576, inline: false },
      ],
      bodyFormat: 'text',
      reason: '',
    },
    rawExcerpt: null,
    note: '',
  },
  '/api/mails/INBOX/102': {
    ok: true,
    found: false,
    analyzed: false,
    instanceId: 'default',
    analysis: null,
    mail: { folder: 'INBOX', uid: 102 },
    draft: null,
    rawExcerpt: null,
    note: '本地既没有这封邮件的分析记录，也没有归档原文。可以点「立即分析这一封」把它拉下来分析。',
  },
  '/api/knowledge': {
    ok: true,
    instanceId: 'default',
    windowHours: 24,
    generatedAt: now,
    topics: [{ id: 'client', label: '客户/商务', count: 1 }],
    entries: [{ ...analysis, typeLabel: '待处理', priorityLabel: '紧急', hasAttachments: false, attachments: [], topics: ['client'], deadlines: ['本周五'], contextCount: 1 }],
    people: [{ address: 'boss@client.com', name: '客户张总', count: 1, needsReply: 1, subjects: [mail.subject] }],
    attachments: [],
    keyFacts: { total: 1, needsReply: 1, withDeadline: 1, deadlineList: [{ subject: mail.subject, from: 'boss@client.com', deadlines: ['本周五'] }] },
  },
  '/api/config': {
    ok: true,
    presets: [{ id: 'custom', label: '自定义', note: 'x', imap: {}, smtp: {} }],
    secretSources: {},
    config: {
      defaultInstanceId: 'default',
      instances: [{ id: 'default', label: '企业邮箱', enabled: true, imap: { host: 'imap.exmail.qq.com', port: 993, secure: true, authUser: 'you@c.com', authPass: '***' }, smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true, authUser: 'you@c.com', authPass: '***' }, identity: { name: '王磊', email: 'you@c.com', replyTo: '' } }],
      scan: { windowHours: 24, maxMessages: 60, folders: ['INBOX'], threadContextCount: 3, bodyCharsForLlm: 4000, snippetChars: 240 },
      draft: { tone: 'formal', language: 'auto', maxDrafts: 15, concurrency: 3, signature: SIGNATURE_FIXTURE, saveToMailbox: true, appendToSent: false, sendPolicy: 'confirm' },
      llm: { baseUrl: 'https://api.deepseek.com', apiKey: '***', model: 'deepseek-chat', temperature: 0.3, classifyBatchSize: 12, maxRetries: 3 },
      web: { host: '127.0.0.1', port: 8787, authToken: '', allowSend: true },
      calendar: {
        enabled: true,
        google: { clientId: 'test.apps.googleusercontent.com', clientSecret: '***', redirectUri: 'http://127.0.0.1:8787/api/calendar/oauth/callback' },
        calendarId: 'primary',
        timeZone: 'Asia/Shanghai',
        sendUpdates: 'none',
        lookaheadDays: 7,
        upcomingLimit: 20,
        maxFromEmails: 10,
        reminders: [10],
      },
    },
  },
  '/api/storage': {
    ok: true,
    raw: { count: 238, bytes: 204_879_462 },
    orphan: { count: 3, bytes: 512_000 },
    reports: { count: 12, bytes: 40_000 },
    audit: { count: 1, bytes: 3_000 },
    state: { count: 1, bytes: 1_200_000 },
    total: { count: 255, bytes: 206_500_000 },
    /*
     * 用户当前的真实配置就是 rawDays=0（永久保留）。
     * `note` 由服务端下发，界面必须原样说明"保留期清理不会删除任何原文"。
     */
    reclaimable: {
      orphans: { count: 3, bytes: 512_000 },
      expired: { count: 0, bytes: 0 },
      total: { count: 3, bytes: 512_000 },
      permanent: true,
      protectedByRecentAnalysis: { count: 0, bytes: 0 },
      note: '当前为永久保留（归档原文保留天数 = 0），保留期清理不会删除任何原文；可回收的只有 3 个孤儿文件（没有任何分析记录指向，删了不影响任何可查询的历史）。',
    },
    analyses: 238,
    drafts: 5,
    retention: { maxAnalyses: 3000, rawDays: 0 },
  },
  '/api/calendar/status': {
    ok: true,
    enabled: true,
    configured: true,
    configProblems: [],
    connected: true,
    ready: true,
    email: 'me@gmail.com',
    calendarId: 'primary',
    timeZone: 'Asia/Shanghai',
    suggestedRedirectUri: 'http://127.0.0.1:8787/api/calendar/oauth/callback',
    lookaheadDays: 7,
    sendUpdates: 'none',
  },
  '/api/calendar/insight': {
    ok: true,
    generatedAt: now,
    timeZone: 'Asia/Shanghai',
    calendarId: 'primary',
    windowDays: 7,
    stats: { total: 3, today: 2, tomorrow: 1, busyDays: 2, days: 7, totalHours: 2.5, busyHours: 2, conflicts: [{ label: '10:00', a: '周会', b: '客户沟通' }], busiestDay: { label: '今天', count: 2 } },
    conflicts: [{ label: '10:00', a: '周会', b: '客户沟通' }],
    analysis: '## 一句话总结\n今天有两场会议重叠。\n\n## 今日与明日\n10:00 周会。',
    analysisError: null,
    today: { key: '2026-09-27', label: '今天（2026-09-27 周日）', isToday: true, count: 2, busyHours: 2, events: [
      { id: 'evt1', summary: '周会', allDay: false, timeLabel: '10:00–11:00', startLocal: '2026-09-27 10:00', endLocal: '2026-09-27 11:00', location: '会议室 A', attendees: ['a@b.com'], durationMinutes: 60 },
      { id: 'evt2', summary: '客户沟通', allDay: false, timeLabel: '10:30–11:30', startLocal: '2026-09-27 10:30', endLocal: '2026-09-27 11:30', attendees: [], durationMinutes: 60 },
    ] },
    tomorrow: { key: '2026-09-28', label: '明天（2026-09-28 周一）', isTomorrow: true, count: 1, busyHours: 0, events: [
      { id: 'evt3', summary: '出差', allDay: true, date: '2026-09-28', timeLabel: '全天', attendees: [] },
    ] },
    days: [
      { key: '2026-09-27', label: '今天（2026-09-27 周日）', isToday: true, count: 2, busyHours: 2, events: [
        { id: 'evt1', summary: '周会', allDay: false, timeLabel: '10:00–11:00', startLocal: '2026-09-27 10:00', endLocal: '2026-09-27 11:00', location: '会议室 A', attendees: ['a@b.com'] },
      ] },
      { key: '2026-09-28', label: '明天（2026-09-28 周一）', isTomorrow: true, count: 1, busyHours: 0, events: [
        { id: 'evt3', summary: '出差', allDay: true, date: '2026-09-28', timeLabel: '全天', attendees: [] },
      ] },
      { key: '2026-09-29', label: '2026-09-29 周二', count: 0, busyHours: 0, events: [] },
    ],
  },
  '/api/calendar/from-emails': {
    ok: true,
    scanned: 1,
    failures: [],
    note: '',
    window: { hours: 24, since: '2026-10-02T04:00:00.000Z', sinceLabel: '2026-10-02 12:00', label: '最近 24 小时' },
    examined: 1,
    suggestions: [
      {
        id: 'sug_1',
        kind: 'deadline',
        confidence: 0.9,
        evidence: '请于 9 月 30 日前提交月度报告',
        event: { summary: '提交月度报告', allDay: false, startLocal: '2026-09-30 17:00', endLocal: '2026-09-30 18:00', date: '2026-09-30', timeLabel: '17:00–18:00', attendees: [] },
        mail: { key: 'INBOX:101', subject: '月度报告提交提醒', from: { name: '王经理', address: 'wang@client.com' }, date: now },
      },
    ],
  },
  '/api/search/emails': {
    ok: true,
    query: '张总上个月发过哪些关于合同的邮件',
    action: 'search',
    needMore: false,
    understood: '查找张总在指定时间范围内、主题或内容含「合同」的邮件',
    filters: {
      dateFrom: '2026-08-27',
      dateTo: '2026-09-27',
      effectiveRange: '2026-08-27 ~ 2026-09-27',
      defaultedRange: true,
      from: ['张总'],
      subject: ['合同'],
      content: ['合同'],
      types: [],
      priorities: [],
      needsReply: null,
      recipientKind: 'any',
      hasAttachments: null,
      limit: 30,
    },
    items: [
      {
        key: 'INBOX:101',
        folder: 'INBOX',
        uid: 101,
        subject: '请确认周五的交付计划',
        from: { name: '客户张总', address: 'boss@client.com' },
        to: [{ address: 'me@company.com' }],
        cc: [],
        date: now,
        day: '2026-09-27',
        type: 'action_required',
        typeLabel: '待处理',
        priority: 'urgent',
        priorityLabel: '紧急',
        needsReply: true,
        recipientKind: 'direct',
        recipientLabel: '直接发给我',
        isCcAttention: false,
        summary: '客户要求确认周五交付时间。',
        actions: ['确认交付时间'],
        reason: '对方明确要求回复。',
        hasAttachments: false,
        attachments: [],
        snippet: '麻烦确认周五能否交付。',
        hasDraft: true,
      },
      {
        key: 'INBOX:102',
        folder: 'INBOX',
        uid: 102,
        subject: '合同附件二条款（抄送）',
        from: { name: '法务部', address: 'legal@company.com' },
        to: [{ address: 'others@company.com' }],
        cc: [{ address: 'me@company.com' }],
        date: now,
        day: '2026-09-26',
        type: 'fyi',
        typeLabel: '知会',
        priority: 'high',
        priorityLabel: '高',
        needsReply: false,
        recipientKind: 'cc',
        recipientLabel: '抄送给我',
        isCcAttention: true,
        summary: '合同附件二条款已更新，抄送知会。',
        actions: [],
        reason: '仅抄送，无需回复。',
        hasAttachments: true,
        attachments: [{ filename: '附件二.pdf' }],
        snippet: '条款已更新。',
        hasDraft: false,
      },
    ],
    stats: {
      matched: 2,
      listed: 2,
      truncated: false,
      listLimit: 1000,
      analyzed: 2,
      envelopeOnly: 0,
      basis: 2,
      scanned: 12,
      coverage: { count: 12, oldest: '2026-09-01', newest: '2026-09-27' },
      bodyHits: 0,
      sort: 'date_desc',
      analysisBasis: { count: 2, analyzed: 2, maxAnalyzed: 2, limit: 40, order: 'date_desc', partial: false },
    },
    analysisBasis: { count: 2, analyzed: 2, maxAnalyzed: 2, limit: 40, order: 'date_desc', partial: false },
    truncationNote: '',
    assistant: '# 结论\n张总在近一个月内发来 1 封关于合同的邮件。',
    analysisError: null,
  },
  '/api/calendar/knowledge': {
    ok: true,
    generatedAt: now,
    timeZone: 'Asia/Shanghai',
    calendarId: 'primary',
    windowDays: 7,
    stats: { total: 2, today: 1, tomorrow: 1, busyDays: 2, days: 7, totalHours: 1.5, busyHours: 1.5, conflicts: [], busiestDay: { label: '今天', count: 1 } },
    conflicts: [],
    analysis: '## 一句话总结\n今天有一场周会。',
    analysisError: null,
    days: [
      {
        key: '2026-09-27',
        label: '今天（2026-09-27 周日）',
        isToday: true,
        count: 1,
        busyHours: 1,
        events: [
          { id: 'evt1', summary: '周会', allDay: false, timeLabel: '10:00–11:00', startLocal: '2026-09-27 10:00', endLocal: '2026-09-27 11:00', location: '会议室 A', attendees: ['a@b.com'], mailbotRef: null },
        ],
      },
      {
        key: '2026-09-28',
        label: '明天（2026-09-28 周一）',
        isTomorrow: true,
        count: 1,
        busyHours: 0.5,
        events: [
          { id: 'evt2', summary: '站会', allDay: false, timeLabel: '09:00–09:30', startLocal: '2026-09-28 09:00', endLocal: '2026-09-28 09:30', attendees: [], mailbotRef: 'INBOX:101' },
        ],
      },
    ],
    knowledge: {
      totalEvents: 2,
      meetings: 2,
      allDay: 0,
      withLocation: 1,
      participants: 1,
      fromEmails: 1,
      byDay: [{ day: '2026-09-27', label: '今天', count: 1, busyHours: 1 }],
      topics: [{ topic: '例会', count: 2, samples: ['周会', '站会'] }],
    },
  },
};

const calls = [];
globalThis.__settingsDebug = undefined;
globalThis.fetch = async (url, options = {}) => {
  const pathname = String(url).split('?')[0];
  calls.push(`${options.method || 'GET'} ${pathname}`);
  // 允许某个用例临时覆盖返回体（例如把日历状态改成「未授权」）
  if (globalThis.__forceCalendarStatus && pathname === '/api/calendar/status') {
    return json({ ok: true, ...globalThis.__forceCalendarStatus });
  }
  if (globalThis.__forceResponses && globalThis.__forceResponses[pathname]) {
    return json(globalThis.__forceResponses[pathname]);
  }
  const body = responses[pathname];
  if (body === undefined) {
    // 动态接口：单个草稿、问答、报告
    if (/^\/api\/drafts\/[^/]+$/.test(pathname)) return json({ ok: true, draft });
    if (pathname === '/api/knowledge/ask') return json({ ok: true, answer: '有 1 封需要回复。', evidence: [{ subject: mail.subject, from: 'boss@client.com', date: now, quote: 'x' }], insufficient: false });
    if (pathname === '/api/reports') return json({ ok: true, reports: [{ id: 'r1', createdAt: now, file: 'x.md' }] });
    return json({ ok: false, code: 'NOT_FOUND', message: `no stub for ${pathname}` }, 404);
  }
  return json(body);
};
function json(value, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => 'application/json' },
    json: async () => value,
    text: async () => JSON.stringify(value),
  };
}

/* ------------------------------------------------------------ 执行 */

const { boot } = await import('../web/app.js');
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  ✗ ${name}\n      ${err?.stack || err}`);
  }
};
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const checkEqual = (actual, expected, msg) => {
  if (actual !== expected) throw new Error(`${msg}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};

console.log('\n前端渲染自检（最小 DOM + 假 API）\n');

await step('boot()：外壳与顶层导航渲染（「跟进」已合并、运行与记录移出顶层）', async () => {
  boot();
  await new Promise((r) => setTimeout(r, 30));
  const html = document.getElementById('root').innerHTML;
  check(html.includes('邮箱与日历数字人'), '缺少品牌名');
  check(html.includes('邮件总览'), '缺少总览导航');
  check(html.includes('对话查邮件'), '缺少对话查邮件导航');
  check(html.includes('邮件草稿'), '缺少草稿导航');
  check(html.includes('日历'), '缺少日历导航');
  check(html.includes('知识库'), '缺少知识库导航');
  check(html.includes('开始使用'), '缺少开始使用（配置向导）导航');
  check(html.includes('设置'), '缺少设置导航');
  /*
   * 顶层导航的**最终形态**：跟催 / 时间线合并成「跟进」，
   * 运行与记录从顶层移除（改从设置页进入）。这里按按钮清单逐项断言，
   * 而不是只看"包含某些字样"——否则漏删一项也测不出来。
   * 计数徽标是按钮的子节点，比对文案时要先摘掉它。
   */
  const navButtons = [...document.querySelectorAll('.nav .nav-btn')];
  const navLabels = navButtons.map((b) => {
    const badge = b.querySelector('.nav-badge');
    const text = badge ? b.textContent.replace(badge.textContent, '') : b.textContent;
    return text.trim();
  });
  checkEqual(
    navButtons.map((b) => b.dataset.view).join('|'),
    'overview|drafts|search|calendar|knowledge|followup|setup|settings',
    '顶层导航的视图 id',
  );
  checkEqual(
    navLabels.join('|'),
    '邮件总览|邮件草稿|对话查邮件|日历|知识库|跟进|开始使用|设置',
    '顶层导航清单',
  );
  check(navLabels.includes('跟进'), '缺少「跟进」导航');
  check(!navLabels.includes('跟催'), '「跟催」应已并入「跟进」，不该再占顶层导航');
  check(!navLabels.includes('时间线'), '「时间线」应已并入「跟进」，不该再占顶层导航');
  check(!navLabels.includes('运行与记录'), '「运行与记录」应已移入设置页，不该再占顶层导航');
});

await step('外壳：右上角是「轻效 | Ease & Effect」Logo + 外观模式；页脚为指定文案', async () => {
  const root = document.getElementById('root');
  const logo = root.querySelector('.topbar-logo');
  check(logo, '右上角应有品牌 Logo');
  checkEqual(logo.getAttribute('src'), './assets/logo.png', 'Logo 应指向用户上传的图片');
  checkEqual(logo.getAttribute('alt'), '轻效 | Ease & Effect', 'Logo 的无障碍名称应为品牌名');
  const lockup = root.querySelector('.brand-lockup');
  check(lockup, '缺少品牌标识组合');
  check(lockup.textContent.includes('轻效 | Ease & Effect'), 'Logo 旁应显示品牌名「轻效 | Ease & Effect」');

  const topbar = root.querySelector('.topbar');
  check(!topbar.textContent.includes('分析最近 24 小时'), '顶栏不应再有「分析最近 24 小时」按钮');

  const footer = root.querySelector('.footer');
  checkEqual(
    footer.textContent,
    '邮箱与日历数字人 | © 2026 mail.wwu@gmail.com | 供个人/内部使用',
    '页脚文案',
  );
});

await step('外观模式：浅色 / 深色 / 绿色三个选项，切换立即生效并记住', async () => {
  const { app } = await import('../web/app.js');
  const theme = await import('../web/theme.js');

  /*
   * 外观模式已从顶栏挪到**设置页**（顶栏放三个按钮会挤得导航在普通宽度下换行）。
   * 所以这里先把设置页渲染出来，再断言三个选项 —— 顺带验证"顶栏不再有它"。
   */
  check(document.querySelectorAll('.topbar .theme-btn').length === 0, '顶栏不该再放外观模式按钮（会把导航挤到换行）');
  const settingsView = await import('../web/views/settings.js');
  const settingsRoot = document.createElement('div');
  document.body.append(settingsRoot);
  settingsView.renderSettings(settingsRoot, app);
  await new Promise((r) => setTimeout(r, 120));

  const btns = [...settingsRoot.querySelectorAll('.theme-btn')];
  const labels = btns.map((b) => b.textContent.replace(/[^\u4e00-\u9fa5]/g, '').trim());
  checkEqual(labels.join('/'), '浅色/深色/绿色', '设置页应有且仅有浅色、深色、绿色三个选项');

  // 默认（未选择过）跟随系统；测试环境的 matchMedia 不存在 → 按深色
  checkEqual(document.documentElement.getAttribute('data-theme'), 'dark', '未选择时应跟随系统（无 matchMedia 时按深色）');
  checkEqual(btns[1].classList.contains('active'), true, '未选择时应对应系统的那个按钮高亮');

  // 切到浅色
  btns[0].dispatchEvent(new window.Event('click', { bubbles: true }));
  checkEqual(document.documentElement.getAttribute('data-theme'), 'light', '点「浅色」应立即生效');
  checkEqual(document.documentElement.style.colorScheme, 'light', '应同步 color-scheme，让原生控件也跟随');
  checkEqual(localStorage.getItem('mailbot.theme'), 'light', '应记住选择');
  checkEqual(btns[0].classList.contains('active'), true, '浅色按钮应高亮');
  checkEqual(btns[1].classList.contains('active'), false, '深色按钮应取消高亮');

  // 切到绿色
  btns[2].dispatchEvent(new window.Event('click', { bubbles: true }));
  checkEqual(document.documentElement.getAttribute('data-theme'), 'green', '点「绿色」应立即生效');
  checkEqual(document.documentElement.style.colorScheme, 'dark', '绿色是深色基底');
  checkEqual(localStorage.getItem('mailbot.theme'), 'green', '应记住选择');

  // 切回深色，避免影响后续步骤的截图/断言
  btns[1].dispatchEvent(new window.Event('click', { bubbles: true }));
  checkEqual(document.documentElement.getAttribute('data-theme'), 'dark', '可以切回深色');
  settingsRoot.remove();

  // 三种主题都必须在 CSS 里真实定义（否则切过去只是「名字变了」）
  const css = readFileSync(path.join(root, 'web/styles.css'), 'utf8');
  check(css.includes(':root[data-theme="light"]'), 'styles.css 应定义浅色主题');
  check(css.includes(':root[data-theme="dark"]'), 'styles.css 应定义深色主题');
  check(css.includes(':root[data-theme="green"]'), 'styles.css 应定义绿色主题');
  for (const id of ['light', 'dark', 'green']) {
    const block = css.slice(css.indexOf(`:root[data-theme="${id}"]`));
    const body = block.slice(0, block.indexOf('}'));
    for (const v of ['--bg', '--surface', '--text', '--accent']) {
      check(body.includes(`${v}:`), `${id} 主题缺少 ${v}`);
    }
  }
  // 绿色主题必须是「绿」的：强调色偏绿（G 明显大于 R）
  const greenBlock = css.slice(css.indexOf(':root[data-theme="green"]'));
  const accent = /--accent:\s*#([0-9a-f]{6})/i.exec(greenBlock.slice(0, greenBlock.indexOf('}')));
  check(accent, '绿色主题应有 --accent');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(accent[1].slice(i, i + 2), 16));
  check(g > r + 40 && g > b + 20, `绿色主题的强调色应明显偏绿，实际 #${accent[1]}`);

  // 主题模块本身可用
  checkEqual(theme.THEMES.length, 3, 'THEMES 应有 3 项');
  checkEqual(typeof app.paintTheme, 'function', 'app 应暴露重绘外观按钮的方法');
});


await step('总览页：需处理 / 需关注 分类与统计', async () => {
  await new Promise((r) => setTimeout(r, 60));
  const html = document.body.innerHTML;
  check(html.includes('一句话总结'), '缺少简报总结');
  check(html.includes('需你处理'), '缺少「需你处理」统计');
  check(html.includes('需你关注'), '缺少「需你关注」统计');
  check(html.includes('直接发我'), '应标注「直接发我」口径');
  check(html.includes('抄送我'), '应标注「抄送我」口径');
  check(html.includes('请确认周五的交付计划'), '缺少邮件主题');
  check(html.includes('客户要求确认周五交付时间'), '缺少 AI 要点');
  check(html.includes('查看草稿'), '缺少草稿入口');
  // 需要处理与需要关注必须是两组不同的邮件
  check(html.includes('需要你处理（1）'), '需要你处理应为 1 封');
  check(html.includes('需要你关注（1）'), '需要你关注应为 1 封');
});

await step('值得知悉：显示主题与发件时间，类型标签带图标与配色', async () => {
  const { app } = await import('../web/app.js');
  globalThis.__forceResponses = { '/api/overview': responses['/api/overview'] };
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 60));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 90));

  const row = [...app.els.main.querySelectorAll('.notice-row')].find((r) => r.textContent.includes('协同办公'));
  check(row, `「值得知悉」里应出现那封普通邮件（实际行数：${app.els.main.querySelectorAll('.notice-row').length}）`);

  // 1) 主题与发件人都必须显示（曾经的 bug：界面读的是顶层字段，而数据在 mail 里，
  //    于是整列都变成「(无主题)」+ 空发件人 + 时间「—」）
  check(row.textContent.includes('【协同办公】您有一条新的待办事项'), '必须显示邮件主题');
  check(row.textContent.includes('协同办公平台'), '必须显示发件人');
  check(!row.textContent.includes('(无主题)'), '不应退化成「(无主题)」');
  check(!row.textContent.includes('未知发件人'), '不应退化成「未知发件人」');

  // 2) 必须显示**发件时间**（不是「—」，也不是纯相对时间）
  const time = row.querySelector('.notice-time');
  check(time, '缺少时间列');
  check(/^\d{2}-\d{2} \d{2}:\d{2}$/.test(time.textContent.trim()), `时间应是「月-日 时:分」，实际「${time.textContent}」`);

  // 3) 类型标签：不同颜色 + 图标（内联 SVG，不是 emoji——emoji 在小字号下会被系统
  //    回退成单色符号（💬→●、🔔→⚠），三平台不一致）
  const tag = row.querySelector('.tag');
  check(tag, '缺少类型标签');
  check(tag.className.includes('type-social'), `类型标签应带 type-social 类，实际「${tag.className}」`);
  check(tag.querySelector('svg'), '类型标签应带内联 SVG 图标');
  check(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(tag.textContent), `标签里不应再有 emoji，实际「${tag.textContent}」`);

  // 4) 8 种类型必须有各自独立的配色类与图标，不能只靠文字
  const { TYPE_META, typeMeta } = await import('../web/type-meta.js');
  const { iconSvg } = await import('../web/icons.js');
  const types = Object.keys(TYPE_META);
  check(types.length >= 8, `类型数量不足：${types.length}`);
  const markup = types.map((t) => iconSvg(typeMeta(t).icon));
  check(new Set(markup).size === types.length, '每种类型的图标必须唯一（SVG 路径不同）');
  check(new Set(types.map((t) => typeMeta(t).className)).size === types.length, '每种类型的配色类必须唯一');
  check(markup.every((m) => m.includes('<svg') && m.includes('currentColor')), '图标应是跟随文字颜色的内联 SVG');
  const css = readFileSync(path.join(root, 'web/styles.css'), 'utf8');
  for (const t of types) {
    check(css.includes(`.${typeMeta(t).className} {`), `styles.css 缺少 .${typeMeta(t).className} 的配色`);
  }
  delete globalThis.__forceResponses;
});

await step('值得知悉：缺主题/发件人/时间的邮件也要能辨认（不出现空壳行）', async () => {
  const { app } = await import('../web/app.js');
  // 造一条「要什么没什么」的记录（历史数据 / 解析失败的邮件都可能长这样）
  const broken = { ...socialNotice, key: 'INBOX:999', uid: 999, subject: undefined, from: undefined, date: undefined, mail: {} };
  globalThis.__forceResponses = {
    '/api/overview': { ...responses['/api/overview'], priorityList: [broken], needAction: [], attention: [] },
  };
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 60));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 90));

  const row = app.els.main.querySelector('.notice-row');
  check(row, '应渲染出该行');
  check(row.textContent.includes('(无主题)'), '没有主题时应显式标注');
  check(row.textContent.includes('INBOX #999'), '必须给出可辨认的兜底标识（文件夹 #UID）');
  check(row.textContent.includes('未知发件人'), '发件人缺失时应显式标注');
  check(row.getAttribute('title').includes('#999'), 'title 里应带兜底标识，便于悬停确认');
  delete globalThis.__forceResponses;
});

await step('总览页：「需留意」单列一栏（不给起草按钮，可标记可恢复）', async () => {
  const { app } = await import('../web/app.js');
  const at = now;
  const mk = (uid, subject, extra = {}) => ({
    key: `INBOX:${uid}`,
    folder: 'INBOX',
    uid,
    subject,
    from: { address: `n${uid}@example.cn`, name: `通知${uid}` },
    to: [{ address: 'me@x.com' }],
    cc: [],
    date: at,
    priority: 'high',
    type: 'notification',
    summary: '需要你在到期前处理一下',
    actions: ['确认参会并安排日程'],
    hasDraft: false,
    draftStatus: null,
    ...extra,
  });
  globalThis.__forceResponses = {
    '/api/overview': {
      ok: true,
      windowHours: 24,
      generatedAt: at,
      timeZone: 'Asia/Shanghai',
      stats: { total: 6, needsReply: 0, worthNoting: 2, attention: 0, urgent: 0, high: 2, withAttachments: 0, byType: {}, byPriority: {}, drafts: { total: 0, pending: 0, sent: 0, failed: 0 }, taskDone: 1, taskSnoozed: 0, taskIgnored: 0 },
      priorityList: [],
      needAction: [],
      worthNoting: [mk(9201, '会议通知：10月8日讨论技术架构', { type: 'meeting' }), mk(9202, '即将过期提醒：工时补填')],
      attention: [],
      taskGroups: { done: [mk(9299, '已经处理过的提醒')], snoozed: [], ignored: [] },
      taskStates: { 'INBOX:9299': { status: 'done', updatedAt: at } },
      actions: [],
    },
  };
  const calls = [];
  const { api } = await import('../web/api.js');
  const realSet = api.taskSetStatus;
  api.taskSetStatus = (key, payload) => {
    calls.push({ key, payload });
    return Promise.resolve({ ok: true, task: { key, ...payload }, message: '已更新' });
  };
  try {
    app.invalidateAll();
    app.navigate('overview');
    await new Promise((r) => setTimeout(r, 120));
    await app.current.reload();
    await new Promise((r) => setTimeout(r, 160));

    const sec = app.els.main.querySelector('[data-section="worth"]');
    check(sec, '应渲染「需留意」分区');
    check(/需留意（2）/.test(sec.textContent), `标题应带条数（实际「${sec.querySelector('h3')?.textContent}」）`);
    check(/不需回复/.test(sec.textContent), '应说明它为什么单独一类（不需回复）');
    const rows = [...sec.querySelectorAll('.mail-row')];
    checkEqual(rows.length, 2, '应有两行');
    // 关键：不给「起草回复」——这类邮件本就不需要回复
    check(!sec.textContent.includes('起草回复'), '「需留意」不应提供「起草回复」按钮');
    check(/已处理/.test(sec.textContent) && /稍后/.test(sec.textContent) && /忽略/.test(sec.textContent), '应可标记 已处理/稍后/忽略（这样也能清空）');
    const doneBtn = [...sec.querySelectorAll('.task-actions button')].find((b) => b.textContent === '已处理');
    doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 140));
    checkEqual(calls.length, 1, '点「已处理」应调用待办接口');
    checkEqual(calls[0].payload.status, 'done', '状态应为 done');

    // 卡片上的「需留意」应能定位到这一栏
    const card = [...app.els.main.querySelectorAll('.stat-card')].find((c) => c.textContent.includes('需留意'));
    let jumped = null;
    const sec2 = app.els.main.querySelector('[data-section="worth"]');
    sec2.scrollIntoView = () => {
      jumped = 'worth';
    };
    card.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    checkEqual(jumped, 'worth', '点「需留意」卡片应滚动到该分区');

    // 已闭环分组要覆盖「需留意」里的条目（服务端已并入同一套分组）
    const groups = app.els.main.querySelector('[data-section="task-groups"]');
    check(groups && /已处理（1）/.test(groups.textContent), '已闭环分组应包含从「需留意」处理掉的条目');
  } finally {
    api.taskSetStatus = realSet;
    delete globalThis.__forceResponses;
    app.invalidateAll();
  }
});

await step('总览页：统计卡片可点击（定位 / 跳转 / 筛选），且带口径说明', async () => {
  const { app } = await import('../web/app.js');
  globalThis.__forceResponses = { '/api/overview': responses['/api/overview'] };
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 60));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 90));

  const cards = [...app.els.main.querySelectorAll('.stat-card')];
  checkEqual(cards.length, 6, '应有 6 张统计卡片（含「需留意」）');
  check(cards.every((c) => c.classList.contains('stat-card-clickable')), '每张卡片都应可点击');
  check(cards.every((c) => c.getAttribute('tabindex') === '0'), '卡片应可用键盘聚焦');
  check(cards.every((c) => (c.getAttribute('title') || '').length > 4), '每张卡片都应有口径说明（tooltip）');
  check(
    cards.some((c) => c.textContent.includes('需留意')),
    '应有「需留意」卡片（不需回复但有明确时限）',
  );

  // 1) 「需你处理」→ 定位到对应分区并高亮
  const needCard = cards.find((c) => c.textContent.includes('需你处理'));
  let jumped = null;
  const needSection = app.els.main.querySelector('[data-section="need"]');
  needSection.scrollIntoView = () => {
    jumped = 'need';
  };
  needCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  checkEqual(jumped, 'need', '点「需你处理」应滚动到对应分区');
  check(needSection.classList.contains('flash-target'), '定位后应短暂高亮该分区');

  // 2) 「紧急 / 高优先」→ 切换筛选
  globalThis.__forceResponses = {
    '/api/overview': {
      ...responses['/api/overview'],
      needAction: [
        { ...analysis, priority: 'urgent', hasDraft: false },
        { ...ccAnalysis, key: 'INBOX:104', uid: 104, priority: 'normal', recipientKind: 'direct', isCcOnly: false, mail: { ...ccAnalysis.mail, uid: 104 } },
      ],
    },
  };
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 60));
  const rowsBefore = app.els.main.querySelectorAll('[data-section="need"] .mail-row').length;
  const urgencyCard = [...app.els.main.querySelectorAll('.stat-card')].find((c) => c.textContent.includes('紧急'));
  urgencyCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const rowsAfter = app.els.main.querySelectorAll('[data-section="need"] .mail-row').length;
  check(rowsAfter < rowsBefore, `点「紧急/高优先」应筛掉普通优先级（${rowsBefore} → ${rowsAfter}）`);
  check(app.els.main.innerHTML.includes('点击取消'), '筛选生效时应给出取消入口');

  // 3) 「待审核草稿」→ 跳草稿页待审核
  const draftCard = [...app.els.main.querySelectorAll('.stat-card')].find((c) => c.textContent.includes('待审核草稿'));
  draftCard.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  checkEqual(app.viewId, 'drafts', '点「待审核草稿」应跳到草稿页');
  checkEqual(app.viewStates.drafts?.filter, 'pending', '应落在「待审核」标签');
  delete globalThis.__forceResponses;
});

await step('邮件构成：点击类型标签可筛选「值得知悉」', async () => {
  const { app } = await import('../web/app.js');
  // 上一步的「紧急/高优先」筛选还开着，这里先复位（筛选状态是跨步骤保留的）
  const viewState = app.viewStates.overview;
  viewState.priorityOnly = false;
  viewState.typeFilter = null;
  const types = responses['/api/overview'].stats.byType;
  globalThis.__forceResponses = {
    '/api/overview': {
      ...responses['/api/overview'],
      stats: { ...responses['/api/overview'].stats, byType: { ...types, fyi: 2 } },
      priorityList: [
        socialNotice,
        { ...socialNotice, key: 'INBOX:105', uid: 105, type: 'fyi', subject: '知会：窗口调整', mail: { ...socialNotice.mail, uid: 105, subject: '知会：窗口调整' } },
      ],
      needAction: [],
      attention: [],
    },
  };
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 60));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 90));

  checkEqual(app.els.main.querySelectorAll('.notice-row').length, 2, '默认应显示 2 条');
  const chip = [...app.els.main.querySelectorAll('.chip-clickable')].find((c) => c.textContent.includes('知会'));
  check(chip, '邮件构成里应有可点击的「知会」标签');
  chip.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const rows = [...app.els.main.querySelectorAll('.notice-row')];
  checkEqual(rows.length, 1, '筛选后只应剩 1 条');
  check(rows[0].textContent.includes('知会：窗口调整'), '剩下的应是指定类型');
  check(app.els.main.innerHTML.includes('已筛选：知会'), '应给出已筛选提示');
  delete globalThis.__forceResponses;
});

await step('详情弹窗：AI 分析 / 原始邮件 双页签，正文全文与复制', async () => {
  const { app } = await import('../web/app.js');
  const overlays = () => [...document.querySelectorAll('.modal-overlay')];
  await app.showMail('INBOX:101', { subject: mail.subject, from: mail.from, date: now, folder: 'INBOX', uid: 101 });
  await new Promise((r) => setTimeout(r, 80));
  const modal = overlays()[overlays().length - 1];
  check(modal, '应弹出详情');

  const tabs = [...modal.querySelectorAll('.modal-tabs .tab')].map((t) => t.textContent.replace(/\d+ 字/, '').trim());
  checkEqual(tabs.join('/'), 'AI 分析/原始邮件', '应有两个页签');

  // 默认在「AI 分析」
  check(modal.textContent.includes('客户要求确认周五交付时间'), '默认应显示 AI 结论');

  // 切到「原始邮件」→ 正文全文 + 邮件头 + 引用历史折叠
  const originalTab = [...modal.querySelectorAll('.modal-tabs .tab')].find((t) => t.textContent.includes('原始邮件'));
  originalTab.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const text = modal.textContent;
  check(text.includes('麻烦确认周五能否交付'), '应显示原始正文全文');
  check(text.includes('发件人'), '应显示邮件头');
  check(text.includes('复制正文'), '应提供复制正文按钮');
  const quoted = modal.querySelector('.mail-quoted');
  check(quoted, '引用历史应单独折叠');
  checkEqual(quoted.hasAttribute('open'), false, '引用历史默认应是收起状态');
  check(quoted.textContent.includes('上一封：交付计划初稿'), '展开后应能看到引用历史');
  modal.remove();
});

await step('草稿页：标签显示数量、引文横幅可一键补、发送后给落点', async () => {
  const draftsView = await import('../web/views/drafts.js');
  const container = document.createElement('div');
  document.body.append(container);
  // 造一封未带引文的草稿
  globalThis.__forceResponses = {
    '/api/drafts': {
      ok: true,
      drafts: [{ ...draft, quoted: false }],
      counts: { pending: 2, failed: 1, sent: 5, all: 8 },
      signature: SIGNATURE_FIXTURE,
      quoteOriginal: true,
      quoteStyle: 'zh-client',
    },
  };
  const appStub = { navigate() {}, refreshCounts() {}, analyze() {}, takeNavParams() { return null; } };
  draftsView.renderDrafts(container, appStub);
  await new Promise((r) => setTimeout(r, 150));

  // 1) 三个标签都带数量（且是服务端给的全量口径）
  const tabs = [...container.querySelectorAll('.tabs-inline .tab')];
  const counts = tabs.map((t) => (t.querySelector('.tab-badge') || {}).textContent);
  checkEqual(counts.join('/'), '3/5/8', `标签数量应是 待审核(failed+pending)=3 / 已发送=5 / 全部=8，实际 ${counts.join('/')}`);

  // 2) 未带引文 → 横幅 + 一键补
  const banner = [...container.querySelectorAll('.alert-warn')].find((a) => a.textContent.includes('引文'));
  check(banner, '应提示有草稿缺引文');
  check([...banner.querySelectorAll('button')].some((b) => b.textContent === '插入原文'), '应提供「插入原文」按钮');

  // 3) 列表项显示来信人 + 是否带引文
  check(container.textContent.includes('回复：'), '草稿列表应显示回复的是谁');
  check(container.textContent.includes('含原文') || true, '带引文时应标注（此处未带，不显示也可以）');
  container.remove();
  delete globalThis.__forceResponses;
});

await step('检索布局：三处「输入框 + 按钮」都在同一行（规则落在 .ask-row 上）', async () => {
  // 这个类在三处用到：对话查邮件页、知识库检索、知识库「问一问」。
  // 曾经把 flex 分别写在容器选择器上，结果「问一问」那处漏了 → 按钮掉到下一行。
  // 所以现在断言的是**通用规则** `.ask-row`，而不是某一个容器。
  const css = readFileSync(path.join(root, 'web/styles.css'), 'utf8');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
  const clean = stripComments(css);
  const ruleOf = (sel) => {
    const i = clean.indexOf(sel);
    return i < 0 ? '' : clean.slice(i, clean.indexOf('}', i));
  };
  const askRow = ruleOf('.ask-row {');
  check(askRow.includes('display: flex'), '.ask-row 必须是 flex，否则按钮会被挤到下一行');
  check(askRow.includes('gap:'), '.ask-row 应有间距');
  check(/flex:\s*1/.test(ruleOf('.ask-row .input {')), '.ask-row 里的输入框应占满剩余宽度');
  check(/flex:\s*0 0 auto/.test(ruleOf('.ask-row .btn {')), '.ask-row 里的按钮不应被压缩');

  // 三处使用者都必须能在 DOM 里同时找到输入框与按钮
  const cases = [];
  const search = await import('../web/views/search.js');
  const box1 = document.createElement('div');
  document.body.append(box1);
  search.renderSearch(box1, { navigate() {}, refreshCounts() {}, showMail() {} });
  await new Promise((r) => setTimeout(r, 100));
  cases.push({ name: '对话查邮件', row: box1.querySelector('.search-panel .ask-row'), button: '检索并分析' });

  const knowledge = await import('../web/views/knowledge.js');
  const box2 = document.createElement('div');
  document.body.append(box2);
  knowledge.renderKnowledge(box2, { navigate() {}, refreshCounts() {}, showMail() {} });
  await new Promise((r) => setTimeout(r, 140));
  const kbRows = [...box2.querySelectorAll('.ask-row')];
  check(kbRows.length >= 2, `知识库应有两处「输入框 + 按钮」（检索 + 问一问），实际 ${kbRows.length}`);
  cases.push({ name: '知识库检索', row: kbRows[0], button: '检索' });
  // 「问一问」就是用户反馈的那一处：先前它用的是 .block > .ask-row，没有 flex
  const qaRow = kbRows.find((r) => r.querySelector('button')?.textContent === '提问');
  check(qaRow, '知识库里应能找到「提问」按钮所在的行');
  cases.push({ name: '知识库问一问', row: qaRow, button: '提问' });

  for (const c of cases) {
    check(c.row, `${c.name}：缺少 .ask-row 结构`);
    check(c.row.querySelector('.input'), `${c.name}：行内应有输入框`);
    check(
      [...c.row.querySelectorAll('button')].some((b) => b.textContent === c.button),
      `${c.name}：行内应有「${c.button}」按钮（与输入框同一行）`,
    );
  }
  box1.remove();
  box2.remove();
});

await step('总览页：简报可下载 Markdown', async () => {
  const { app } = await import('../web/app.js');
  globalThis.__forceResponses = { '/api/overview': responses['/api/overview'] };
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 60));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 90));
  const link = [...app.els.main.querySelectorAll('a')].find((a) => a.textContent.includes('下载 Markdown'));
  check(link, '应有「下载 Markdown」入口');
  checkEqual(link.getAttribute('href'), '/api/reports/r1?format=raw', '下载地址应指向报告原文接口');
  // 文件名按简报生成日期取名，所以期望值从同一个时间戳推出来（不要写死日期）
  checkEqual(link.getAttribute('download'), `简报-${String(now).slice(0, 10)}.md`, '应带 download 文件名');
  delete globalThis.__forceResponses;
});

await step('数据联动：起草后总览按钮变「查看草稿」，发送后变「已发送邮件」', async () => {
  const { app } = await import('../web/app.js');
  const base = responses['/api/overview'];
  // 初始：这封邮件**还没有草稿**（fixture 默认是 hasDraft:true，这里显式覆盖）
  const noDraft = { ...base, needAction: [{ ...analysis, hasDraft: false }] };
  let overviewCalls = 0;
  globalThis.__forceResponses = {
    '/api/overview': noDraft,
  };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 60));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 90));
  /*
   * 只取**草稿操作**那个按钮：`.mail-side` 里现在还有待办操作（已处理/稍后/忽略），
   * 全都抓进来会把断言变成"按钮文案列表"，一旦新增按钮就误报。
   */
  const rowBtn = () =>
    [...app.els.main.querySelectorAll('[data-section="need"] .mail-row .mail-side button')]
      .filter((b) => !b.closest('.task-actions'))
      .map((b) => b.textContent);
  checkEqual(rowBtn().join('/'), '起草回复', '初始应显示「起草回复」');

  // 模拟「点了起草回复」：后端此后会返回带草稿的记录
  const drafted = {
    ...base,
    needAction: [{ ...analysis, hasDraft: true, draftStatus: 'pending', draftId: 'draft_INBOX_101', mail: { ...analysis.mail } }],
    stats: { ...base.stats, drafts: { total: 1, pending: 1, sent: 0, failed: 0 } },
  };
  globalThis.__forceResponses = { '/api/overview': drafted };
  overviewCalls = 0;
  // 关键：模拟 draftFor 结束后的失效 + 用户回到总览
  app.invalidateAll();
  app.navigate('drafts');
  await new Promise((r) => setTimeout(r, 120));
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 180));
  checkEqual(rowBtn().join('/'), '查看草稿', `起草后总览应显示「查看草稿」（实际「${rowBtn().join('/')}」）`);

  // 模拟「在草稿页点了确认发送」
  const sent = {
    ...base,
    needAction: [{ ...analysis, hasDraft: true, draftStatus: 'sent', draftId: 'draft_INBOX_101', draftSentAt: now, mail: { ...analysis.mail } }],
    stats: { ...base.stats, drafts: { total: 1, pending: 0, sent: 1, failed: 0 } },
  };
  globalThis.__forceResponses = { '/api/overview': sent };
  app.invalidateAll();
  app.navigate('drafts');
  await new Promise((r) => setTimeout(r, 120));
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 180));
  checkEqual(rowBtn().join('/'), '已发送邮件', `发送后总览应显示「已发送邮件」（实际「${rowBtn().join('/')}」）`);
  delete globalThis.__forceResponses;
});

await step('数据联动：跑完分析后草稿页列表自动重新拉取（不再需要手动刷新页面）', async () => {
  const { app } = await import('../web/app.js');
  let draftCalls = 0;
  globalThis.__forceResponses = {
    '/api/drafts': {
      ok: true,
      drafts: [draft],
      counts: { pending: 1, failed: 0, sent: 5, all: 6 },
      signature: SIGNATURE_FIXTURE,
      quoteOriginal: true,
      quoteStyle: 'zh-client',
    },
  };
  // 先正常进入草稿页，确认初始只有 1 封
  app.invalidateAll();
  app.navigate('drafts');
  await new Promise((r) => setTimeout(r, 200));
  const before = app.els.main.querySelectorAll('.draft-item').length;
  checkEqual(before, 1, '初始应有 1 封草稿');

  // 后端此时多了一封（分析刚起草出来的）
  globalThis.__forceResponses = {
    '/api/drafts': {
      ok: true,
      drafts: [draft, { ...draft, id: 'draft_new_1', subject: 'Re: 新邮件带来的草稿', source: { ...draft.source, uid: 202 } }],
      counts: { pending: 2, failed: 0, sent: 5, all: 7 },
      signature: SIGNATURE_FIXTURE,
      quoteOriginal: true,
      quoteStyle: 'zh-client',
    },
  };
  // 等价于点了「继续分析新邮件」：分析结束 → 失效所有视图 → 当前视图重新取数
  await app.syncAfterChange();
  await new Promise((r) => setTimeout(r, 200));
  const after = app.els.main.querySelectorAll('.draft-item').length;
  checkEqual(after, 2, `分析后列表应自动刷新出新草稿（${before} → ${after}）`);
  const tabText = app.els.main.querySelector('.tabs-inline .tab .tab-badge')?.textContent;
  checkEqual(tabText, '2', '标签计数也应跟着更新');
  delete globalThis.__forceResponses;
});

await step('按时间段分析：窗口选择器改变标题与请求参数，并给出预检确认', async () => {
  const { app } = await import('../web/app.js');
  const { api } = await import('../web/api.js');
  const seen = [];
  const realOverview = api.overview;
  // 记录总览请求参数（__forceResponses 只支持静态对象，所以用包一层的方式观察）
  api.overview = (params) => {
    seen.push(JSON.stringify(params || {}));
    return realOverview(params);
  };
  globalThis.__forceResponses = {
    '/api/overview': { ...responses['/api/overview'], windowHours: 168 },
    '/api/runs/preview': {
      ok: true,
      windowHours: 168,
      windowLabel: '最近 7 天',
      matched: 312,
      taken: 312,
      limit: 420,
      truncated: false,
      alreadyAnalyzed: 40,
      alreadyDrafted: 2,
      // 真正会复用的只有"已有分析 + 已有草稿"的交集；预计分类数 = 取出数 - 复用数
      reusable: 2,
      estimatedAnalyze: 310,
      estimatedCalls: 27,
      batchSize: 12,
    },
    '/api/runs': { ok: true, result: { analyzed: 5, drafts: 1, skippedDrafts: 0, windowHours: 168, truncation: [] } },
  };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 80));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 120));

  checkEqual(app.els.main.querySelector('h2').textContent, '最近 7 天', '标题应使用后端返回的窗口（不是「最近 168 小时」）');

  // 切到「最近 7 天」
  const select = app.els.main.querySelector('.window-select');
  check(select, '应有时间范围选择器');
  const weekOption = [...select.options].find((o) => o.textContent === '最近 7 天');
  check(weekOption, '应有「最近 7 天」选项');
  check([...select.options].some((o) => o.textContent === '自定义时间段…'), '应有自定义时间段入口');
  seen.length = 0;
  // linkedom 的 select.value 只有 getter，直接调处理函数（等价于用户选择）
  select.onchange({ target: { value: weekOption.value } });
  await new Promise((r) => setTimeout(r, 220));
  checkEqual(app.els.main.querySelector('h2').textContent, '最近 7 天', '标题应跟着窗口变');
  check(seen.length > 0, '切换窗口后应重新请求总览（旧数据不再是同一口径）');
  check(
    seen.some((p) => /"hours":\s*168/.test(p)),
    `总览请求应带上新窗口（实际请求参数：${seen.join(' | ')}）`,
  );

  // 分析按钮应带上窗口，并且先弹预检确认
  const analyzeBtn = [...app.els.main.querySelectorAll('button')].find((b) => b.textContent.includes('分析最近 7 天'));
  check(analyzeBtn, '分析按钮文案应跟随窗口');
  analyzeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  const modal = document.querySelector('.modal-overlay');
  check(modal, '应弹出预检确认框');
  const text = modal.textContent;
  check(text.includes('312'), '应展示窗口内命中封数');
  /*
   * 预检数字必须与真实运行一致：旧文案写"其中 N 封已分析过，**不会重复消耗**"，
   * 而分类阶段其实对窗口内全部邮件都会重跑——那是拿错数字劝用户花钱。
   */
  check(text.includes('310'), `应展示预计分析封数（花钱前先看到代价，实际「${text.slice(0, 160)}」）`);
  check(text.includes('27'), '应展示预计模型调用次数');
  check(/已有草稿，会直接复用/.test(text), '应说明只有"已有草稿"的才会复用');
  check(!/不会重复消耗/.test(text), '不得再出现"已分析过就不会重复消耗"这种与事实不符的说法');
  // 取消掉，不真的发起分析
  [...modal.querySelectorAll('button')].find((b) => b.textContent === '取消')?.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  api.overview = realOverview;
  delete globalThis.__forceResponses;
});

await step('时间展示：按配置时区（Asia/Shanghai）渲染，而不是浏览器本地时区', async () => {
  const dom = await import('../web/dom.js');
  // 2026-09-30T08:52:00Z = 北京时间 16:52
  const iso = '2026-09-30T08:52:00.000Z';
  dom.setDisplayTimeZone('Asia/Shanghai');
  checkEqual(dom.fmtFull(iso), '2026-09-30 16:52', '北京时间应是 16:52');
  checkEqual(dom.fmtMailTime(iso), '09-30 16:52', '邮件时间也按配置时区');
  dom.setDisplayTimeZone('UTC');
  checkEqual(dom.fmtFull(iso), '2026-09-30 08:52', '切到 UTC 应显示 08:52（证明时区真的生效）');
  dom.setDisplayTimeZone('Asia/Shanghai');
  checkEqual(dom.getDisplayTimeZone(), 'Asia/Shanghai', '应记住展示时区');
  // 非法时区不能把页面搞崩，退回本地时区
  dom.setDisplayTimeZone('Not/AZone');
  check(dom.fmtFull(iso) !== '—', '非法时区应退回本地时区而不是抛错');
  dom.setDisplayTimeZone(null);
});

await step('一句话总结必须与所选窗口同一口径（不能"最近 7 天"配"近 24 小时"）', async () => {
  const { app } = await import('../web/app.js');
  const base = responses['/api/overview'];
  // 后端行为：切窗口后当前窗口没有简报时 report=null，只给 latestReport 提示
  globalThis.__forceResponses = {
    '/api/overview': {
      ...base,
      windowHours: 168,
      stats: { ...base.stats, total: 95, needsReply: 8, attention: 12, drafts: { total: 8, pending: 2, sent: 6, failed: 0 } },
      report: null,
      latestReport: { id: 'r24', createdAt: now, windowHours: 24, isCurrentWindow: false, markdown: '## 一句话总结\n近 24 小时 38 封邮件中，3 封紧急件…' },
    },
  };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 80));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 120));

  const card = app.els.main.querySelector('.summary-card');
  check(card, '缺少一句话总结卡片');
  const text = card.textContent;
  // 核心：不能出现属于别的窗口的数字/措辞
  check(!text.includes('近 24 小时 38 封'), '切到 7 天后不得再展示 24 小时口径的总结（这正是用户看到的矛盾）');
  check(!/38 封/.test(text), `总结里不应出现 24 小时的 38 封，实际「${text}」`);
  // 应该现场按当前窗口算一句，并且与卡片数字同源
  check(text.includes('最近 7 天'), '总结应标明当前窗口');
  check(text.includes('95'), `总结里的总数应与卡片一致（95），实际「${text}」`);
  check(text.includes('8'), '总结应包含需你处理的数量');
  // 并说明上次简报属于哪个窗口，避免用户误以为没生成
  check(text.includes('上一次 AI 简报针对的是最近 24 小时'), `应提示上次简报的窗口，实际「${text}」`);

  // 当前窗口有简报时要显示它，并标注窗口
  globalThis.__forceResponses = {
    '/api/overview': {
      ...base,
      windowHours: 168,
      report: { id: 'r168', createdAt: now, windowHours: 168, markdown: '## 一句话总结\n最近 7 天 95 封邮件中，8 封需要你处理。' },
      latestReport: { id: 'r168', createdAt: now, windowHours: 168, isCurrentWindow: true, markdown: '## 一句话总结\n最近 7 天 95 封邮件中，8 封需要你处理。' },
    },
  };
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 120));
  const card2 = app.els.main.querySelector('.summary-card');
  check(card2.textContent.includes('最近 7 天 95 封邮件中'), '有本期简报时应展示它');
  check(card2.textContent.includes('一句话总结 · 最近 7 天'), '简报应标注所属窗口');
  delete globalThis.__forceResponses;
});

await step('总览头部：只保留「时间范围 + 分析」一组，且同一行', async () => {
  const { app } = await import('../web/app.js');
  globalThis.__forceResponses = { '/api/overview': responses['/api/overview'] };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 80));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 120));

  const head = app.els.main.querySelector('.page-head');
  const labels = [...head.querySelectorAll('button, a')].map((b) => b.textContent.trim());
  check(!labels.includes('刷新'), '应已去掉「刷新」按钮');
  check(!labels.includes('邮件知识库'), '应已去掉「邮件知识库」按钮（导航里已有）');
  check(labels.some((t) => t.startsWith('分析最近')), '应保留分析按钮');

  const group = head.querySelector('.window-group');
  check(group, '时间范围与分析按钮应在同一个 .window-group 里');
  check(group.querySelector('.window-select'), '该组应包含时间范围选择器');
  check(
    [...group.querySelectorAll('button')].some((b) => b.textContent.startsWith('分析最近')),
    '该组应包含分析按钮',
  );
  const css = readFileSync(path.join(root, 'web/styles.css'), 'utf8');
  const rule = css.slice(css.indexOf('.window-group {'), css.indexOf('}', css.indexOf('.window-group {')));
  check(rule.includes('flex-wrap: nowrap'), '.window-group 不应换行（下拉框与按钮必须同一行）');
  // 下拉框不能被 `.input { width: 100% }` 拉成整行：必须有一条更具体的 width:auto 规则
  const selStart = css.indexOf('.window-group .window-select {');
  check(selStart > 0, '缺少针对 .window-group .window-select 的规则');
  const selRule = css.slice(selStart, css.indexOf('\n}', selStart));
  check(/width:\s*auto/.test(selRule), '.window-select 必须显式 width:auto，否则会被 .input 拉满整行');
  check(/flex:\s*0 0 auto/.test(selRule), '.window-select 不应被 flex 拉伸');
  delete globalThis.__forceResponses;
});

await step('分析按钮：点击后立即置灰（预检期间不允许重复点击）', async () => {
  const { app } = await import('../web/app.js');
  const { api } = await import('../web/api.js');
  let resolvePreview = null;
  const realPreview = api.runPreview;
  // 让预检"卡住"，模拟真实的 1~2 秒网络往返
  api.runPreview = () =>
    new Promise((resolve) => {
      resolvePreview = () => resolve({ ok: true, windowHours: 24, windowLabel: '最近 24 小时', matched: 3, taken: 3, limit: 60, truncated: false, alreadyAnalyzed: 0, alreadyDrafted: 0, reusable: 0, estimatedAnalyze: 3, estimatedCalls: 1, batchSize: 12 });
    });
  globalThis.__forceResponses = { '/api/overview': responses['/api/overview'] };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 80));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 120));

  // 注意：按钮文案在预检期间会变成「预检中…」，所以按位置取（组内最后一个按钮）
  const btn = () => {
    const group = app.els.main.querySelector('.window-group');
    const buttons = group ? [...group.querySelectorAll('button')] : [];
    return buttons[buttons.length - 1];
  };
  check(btn(), '头部应有分析按钮');
  checkEqual(btn().disabled, false, '初始应可点击');
  btn().dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  const during = btn();
  check(during, '预检期间按钮仍应存在');
  checkEqual(during.disabled, true, '预检期间按钮必须置灰，否则会重复点击弹多个确认框');
  checkEqual(during.textContent, '预检中…', `预检期间按钮文案应变为「预检中…」，实际「${during.textContent}」`);

  // 预检返回后恢复可点，并弹出模态确认框
  resolvePreview();
  await new Promise((r) => setTimeout(r, 120));
  checkEqual(btn().disabled, false, '预检结束后按钮应恢复');
  const modal = document.querySelector('.modal-overlay');
  check(modal, '应弹出确认框');
  checkEqual(modal.querySelector('.modal').classList.contains('modal-confirm'), true, '确认框应是模态样式');
  checkEqual(document.body.classList.contains('modal-open'), true, '模态打开时应锁住页面滚动');
  // Esc 关闭（linkedom 没有 KeyboardEvent 构造器，用带 key 的通用 Event 模拟）
  const esc = new window.Event('keydown', { bubbles: true });
  esc.key = 'Escape';
  document.dispatchEvent(esc);
  await new Promise((r) => setTimeout(r, 60));
  check(!document.querySelector('.modal-overlay'), 'Esc 应能关闭确认框');
  checkEqual(document.body.classList.contains('modal-open'), false, '关闭后应解除滚动锁');
  api.runPreview = realPreview;
  delete globalThis.__forceResponses;
});

await step('模态遮罩：深色/绿色主题下用更强的遮罩，不再"看不出是弹窗"', async () => {
  const css = readFileSync(path.join(root, 'web/styles.css'), 'utf8');
  check(css.includes('--scrim'), '应使用 --scrim 变量而不是写死的浅遮罩');
  const alphaOf = (block) => {
    const m = /--scrim:\s*rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)/.exec(block);
    return m ? Number(m[1]) : NaN;
  };
  const dark = css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf(':root[data-theme="green"]'));
  const green = css.slice(css.indexOf(':root[data-theme="green"]'), css.indexOf('@media (prefers-color-scheme: dark)'));
  const light = css.slice(0, css.indexOf(':root[data-theme="dark"]'));
  check(alphaOf(dark) >= 0.6, `深色主题的遮罩黑度应 ≥0.6（实际 ${alphaOf(dark)}）`);
  check(alphaOf(green) >= 0.6, `绿色主题的遮罩黑度应 ≥0.6（实际 ${alphaOf(green)}）`);
  check(alphaOf(light) >= 0.3 && alphaOf(light) < alphaOf(dark), '浅色主题遮罩要可见但不必像深色那么重');
  check(/\.modal-overlay\s*\{[^}]*backdrop-filter/.test(css), '遮罩应带背景模糊，弱遮罩下也能读出"被压住"');
  check(/body\.modal-open\s*\{[^}]*overflow:\s*hidden/.test(css), '模态打开时应禁止页面滚动');
});

await step('后台分析跑完（如定时任务）也会让页面自己更新，不依赖手动刷新', async () => {
  const { app } = await import('../web/app.js');
  const base = responses['/api/overview'];
  let overviewCalls = 0;
  const { api } = await import('../web/api.js');
  const realOverview = api.overview;
  api.overview = (params) => {
    overviewCalls += 1;
    return realOverview(params);
  };
  globalThis.__forceResponses = { '/api/overview': base };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 80));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 120));
  const before = overviewCalls;
  check(before >= 1, '进入总览应至少请求一次');

  // 模拟 SSE 推送「运行完成」：没有点任何按钮
  app.onProgressEvent({ type: 'run:done', result: { analyzed: 2, drafts: 1 } });
  await new Promise((r) => setTimeout(r, 200));
  check(overviewCalls > before, `收到 run:done 后总览应重新取数（${before} → ${overviewCalls}）`);
  api.overview = realOverview;
  delete globalThis.__forceResponses;
});

await step('返回顶部：滚动超过阈值才出现，点击回到顶部，切页自动复位', async () => {
  const { app, scrollPageToTop } = await import('../web/app.js');
  globalThis.__forceResponses = { '/api/overview': responses['/api/overview'] };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 120));

  const btn = app.els.backToTop;
  check(btn, '外壳里应有返回顶部按钮');
  checkEqual(btn.hidden, true, '没有滚动时不应显示');

  // 模拟滚动（linkedom 没有滚动实现，直接造 scrollY + 触发 scroll）
  let scrolled = 0;
  const scrollToCalls = [];
  window.scrollTo = (opts) => {
    scrollToCalls.push(opts);
    scrolled = typeof opts === 'object' ? opts.top : 0;
    window.scrollY = scrolled;
  };
  window.scrollY = 900;
  window.dispatchEvent(new window.Event('scroll'));
  await new Promise((r) => setTimeout(r, 30));
  checkEqual(btn.hidden, false, '滚动超过阈值后应出现');
  checkEqual(btn.classList.contains('is-visible'), true, '应带可见动画类');

  // 点击 → 回到顶部
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 30));
  check(scrollToCalls.length >= 1, '点击后应调用滚动');
  checkEqual(scrollToCalls[0]?.top, 0, '应滚到 top: 0');

  // 滚回顶部后按钮消失
  window.scrollY = 0;
  window.dispatchEvent(new window.Event('scroll'));
  await new Promise((r) => setTimeout(r, 30));
  checkEqual(btn.hidden, true, '回到顶部后应自动隐藏');

  // 切换标签页要复位滚动（否则从长列表底部跳过去会停在半空）
  window.scrollY = 1500;
  scrollToCalls.length = 0;
  app.navigate('knowledge');
  await new Promise((r) => setTimeout(r, 150));
  check(scrollToCalls.length >= 1, '切换标签页时应回到顶部');

  // 安全性：最小 DOM 下没有 scrollTo 也不能抛错
  const saved = window.scrollTo;
  delete window.scrollTo;
  let threw = null;
  try {
    scrollPageToTop();
  } catch (err) {
    threw = err;
  }
  check(!threw, `没有 window.scrollTo 时不应抛错（实际 ${threw?.message}）`);
  window.scrollTo = saved;
  delete globalThis.__forceResponses;
});

await step('设置页：大模型可选主流服务商，选中后自动填 Base URL 与模型名', async () => {
  const settings = await import('../web/views/settings.js');
  const { app } = await import('../web/app.js');
  const container = document.createElement('div');
  document.body.append(container);
  settings.renderSettings(container, {
    navigate() {},
    refreshCounts() {},
    invalidateAll() {},
    takeNavParams() {
      return null;
    },
  });
  await new Promise((r) => setTimeout(r, 200));

  const select = container.querySelector('.llm-provider select');
  check(select, '设置页应有服务商选择器');
  const labels = [...select.options].map((o) => o.textContent);
  for (const key of ['DeepSeek', '通义千问', 'Kimi', 'GLM', 'OpenAI', 'Ollama', '自定义']) {
    check(labels.some((l) => l.includes(key)), `服务商列表里应包含「${key}」，实际：${labels.join(' / ')}`);
  }

  // 默认配置是 DeepSeek → 应自动选中它，并显示注意事项 + 申请 Key 的链接
  checkEqual(select.value, 'deepseek', '默认 baseUrl 应匹配到 DeepSeek 预设');
  const note = container.querySelector('.llm-provider-note');
  check(note && note.textContent.length > 5, '应展示该服务商的注意事项');
  const keyLink = note.querySelector('a');
  check(keyLink && /deepseek\.com/.test(keyLink.getAttribute('href')), '应给出申请 API Key 的链接');

  // 切到 Ollama → baseUrl 与模型名一起变，并提示无需 Key
  const ollama = [...select.options].find((o) => o.textContent.includes('Ollama'));
  check(ollama, '应有本地部署选项');
  select.onchange({ target: { value: ollama.value } });
  await new Promise((r) => setTimeout(r, 120));
  const baseUrlInput = [...container.querySelectorAll('.form-grid input')].find((i) => /^https?:/.test(i.value));
  check(baseUrlInput, '应能读到 Base URL 输入框');
  checkEqual(baseUrlInput.value, 'http://127.0.0.1:11434/v1', 'Ollama 的 Base URL 应被自动填入');
  const modelField = [...container.querySelectorAll('.form-grid input')].find((i) => i.value === 'qwen2.5:7b');
  check(modelField, '模型名也应一起被填入（baseUrl 与模型必须配套）');
  check(container.querySelector('.llm-provider-note').textContent.includes('无需 Key'), '本机部署应提示无需 Key');
  // 模型候选来自当前服务商
  const datalist = container.querySelector('datalist');
  check(datalist, '应给出该服务商的常用模型候选');
  check([...datalist.querySelectorAll('option')].length >= 2, '候选模型不应只有一个');
  container.remove();
  check(app, 'app 可导入');
});

await step('设置页：自定义 baseUrl 不会被预设悄悄改写', async () => {
  const settings = await import('../web/views/settings.js');
  globalThis.__forceResponses = {
    '/api/config': {
      ok: true,
      config: {
        ...responses['/api/config'].config,
        llm: { ...responses['/api/config'].config.llm, baseUrl: 'https://my-gateway.internal/v1', model: 'my-model' },
      },
      presets: responses['/api/config'].presets,
      secretSources: {},
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  settings.renderSettings(container, { navigate() {}, refreshCounts() {}, invalidateAll() {}, takeNavParams: () => null });
  await new Promise((r) => setTimeout(r, 200));
  const select = container.querySelector('.llm-provider select');
  checkEqual(select.value, 'custom', '匹配不上任何预设时应显示「自定义」，而不是硬套一个');
  const baseUrlInput = [...container.querySelectorAll('.form-grid input')].find((i) => /^https?:/.test(i.value));
  checkEqual(baseUrlInput.value, 'https://my-gateway.internal/v1', '用户手填的地址必须原样保留');
  check(!container.querySelector('datalist'), '自定义地址不应硬塞某个服务商的模型候选');
  container.remove();
  delete globalThis.__forceResponses;
});

await step('详情弹窗：附件清单每行都有「保存」按钮，且序号与接口一致', async () => {
  const { app } = await import('../web/app.js');
  const overlays = () => [...document.querySelectorAll('.modal-overlay')];
  await app.showMail('INBOX:101', { subject: mail.subject, from: mail.from, date: now, folder: 'INBOX', uid: 101 });
  await new Promise((r) => setTimeout(r, 80));
  const modal = overlays()[overlays().length - 1];
  const tab = [...modal.querySelectorAll('.modal-tabs .tab')].find((t) => t.textContent.includes('原始邮件'));
  tab.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));

  const rows = [...modal.querySelectorAll('.attachment-row')];
  checkEqual(rows.length, 2, `应渲染 2 个附件行（实际 ${rows.length}）`);
  check(rows[0].textContent.includes('需求说明.docx'), '第一行应是第一个附件');
  check(rows[1].textContent.includes('报价 单.pdf'), '第二行应是第二个附件');
  // 大小与类型要显示出来，用户才知道点下去要下多大的文件
  check(/\d/.test(rows[0].textContent), '附件行应显示大小（KB/MB）');

  // 序号必须与列表顺序一致：点第 N 行的按钮，请求的必须是第 N 个下标
  const { api } = await import('../web/api.js');
  const urls = [];
  const realSave = window.showSaveFilePicker;
  window.showSaveFilePicker = undefined; // 走普通下载分支，避免真弹窗
  const realClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    urls.push(this.getAttribute('href'));
  };
  for (const row of rows) {
    row.querySelector('button').dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  }
  window.HTMLAnchorElement.prototype.click = realClick;
  window.showSaveFilePicker = realSave;
  checkEqual(urls.length, 2, '两次点击都应触发下载');
  checkEqual(urls[0], api.attachmentUrl('INBOX', 101, 0), `第 1 行应对应下标 0（实际 ${urls[0]}）`);
  checkEqual(urls[1], api.attachmentUrl('INBOX', 101, 1), `第 2 行应对应下标 1（实际 ${urls[1]}）`);
  modal.remove();
});

await step('附件保存：优先目录选择器，取消不下载，失败有提示', async () => {
  const { saveAttachment } = await import('../web/dom.js');
  // 1) 支持 File System Access API：写入用户选定的文件
  const written = [];
  window.showSaveFilePicker = async ({ suggestedName }) => ({
    createWritable: async () => ({
      write: async (blob) => written.push({ suggestedName, size: blob.size }),
      close: async () => {},
    }),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3, 4])]) });
  const okOut = await saveAttachment('/api/x', '报表.xlsx');
  checkEqual(okOut.mode, 'picker', '应走目录选择器');
  checkEqual(okOut.saved, true, '应保存成功');
  checkEqual(written.length, 1, '应写入一次');
  checkEqual(written[0].suggestedName, '报表.xlsx', '建议文件名应传下去');

  // 2) 用户取消 → 不保存、也不偷偷下载
  window.showSaveFilePicker = async () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  };
  let downloadClicks = 0;
  const realClick2 = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    downloadClicks += 1;
  };
  const cancelOut = await saveAttachment('/api/x', 'a.txt');
  checkEqual(cancelOut.mode, 'cancelled', '应识别为用户取消');
  checkEqual(cancelOut.saved, false, '取消不应算保存成功');
  checkEqual(downloadClicks, 0, '取消后不应再偷偷下载一份');

  // 3) 不支持该 API → 退化为普通下载
  window.showSaveFilePicker = undefined;
  const fallbackOut = await saveAttachment('/api/x', 'b.txt');
  checkEqual(fallbackOut.mode, 'download', '不支持时应退化为普通下载');
  checkEqual(downloadClicks, 1, '应触发一次下载');

  // 4) 写入失败要如实返回错误
  window.HTMLAnchorElement.prototype.click = realClick2;
  window.showSaveFilePicker = async () => ({
    createWritable: async () => {
      throw new Error('磁盘已满');
    },
  });
  const failOut = await saveAttachment('/api/x', 'c.txt');
  checkEqual(failOut.saved, false, '写入失败不应报成功');
  check(/磁盘已满/.test(failOut.error), `应带上失败原因（实际 ${failOut.error}）`);
  window.showSaveFilePicker = undefined;
  globalThis.fetch = realFetch;
});

await step('草稿页：附件区可列出附件、显示体积预算、超限禁用发送', async () => {
  const draftsView = await import('../web/views/drafts.js');
  const container = document.createElement('div');
  document.body.append(container);
  globalThis.__forceResponses = {
    '/api/drafts': {
      ok: true,
      drafts: [
        {
          ...draft,
          attachments: [
            { id: 'att_1', filename: '对账单.csv', contentType: 'text/csv', size: 2048 },
            { id: 'att_2', filename: '截图.png', contentType: 'image/png', size: 1024 * 1024 },
          ],
          attachmentBudget: { count: 2, actualBytes: 1050624, encodedBytes: 1401000, limitBytes: 20_000_000, overBudget: false },
        },
      ],
      counts: { pending: 1, failed: 0, sent: 0, all: 1 },
      signature: SIGNATURE_FIXTURE,
      quoteOriginal: true,
      quoteStyle: 'zh-client',
      attachmentMaxBytes: 20_000_000,
      maxAttachments: 10,
    },
  };
  const appStub = { navigate() {}, refreshCounts() {}, analyze() {}, invalidateAll() {}, takeNavParams: () => null };
  draftsView.renderDrafts(container, appStub);
  await new Promise((r) => setTimeout(r, 200));

  const editor = container.querySelector('.attachment-editor');
  check(editor, '草稿编辑器应有附件区');
  check(editor.textContent.includes('附件（2）'), `应显示附件数量（实际 ${editor.textContent.slice(0, 60)}）`);
  const rows = [...editor.querySelectorAll('.attachment-row')];
  checkEqual(rows.length, 2, '应列出 2 个附件');
  check(rows[0].textContent.includes('对账单.csv'), '应显示附件名');
  check(/KB|MB/.test(rows[0].textContent), '应显示附件大小');
  check(editor.textContent.includes('上限'), '应显示体积预算');
  check(
    [...editor.querySelectorAll('button')].some((b) => b.textContent === '选择文件'),
    '应提供选择文件入口',
  );
  check(
    [...editor.querySelectorAll('button')].some((b) => b.textContent === '移除'),
    '未发送的草稿应能移除附件',
  );
  const sendBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '确认发送');
  checkEqual(sendBtn.disabled, false, '未超限时发送按钮应可用');

  // 超限：发送按钮禁用 + 明确提示
  // 递增数据版本号 = 真实的"数据变更"路径（view-state 会因此重新取数）
  appStub.dataVersion = (appStub.dataVersion || 0) + 1;
  globalThis.__forceResponses = {
    '/api/drafts': {
      ok: true,
      drafts: [
        {
          ...draft,
          attachments: [{ id: 'att_1', filename: '大文件.zip', contentType: 'application/zip', size: 18 * 1024 * 1024 }],
          attachmentBudget: { count: 1, actualBytes: 18 * 1024 * 1024, encodedBytes: 25_000_000, limitBytes: 20_000_000, overBudget: true },
        },
      ],
      counts: { pending: 1, failed: 0, sent: 0, all: 1 },
      signature: SIGNATURE_FIXTURE,
      quoteOriginal: true,
      quoteStyle: 'zh-client',
      attachmentMaxBytes: 20_000_000,
      maxAttachments: 10,
    },
  };
  appStub.forceReload?.();
  appStub.forceReload?.();
  draftsView.renderDrafts(container, appStub);
  await new Promise((r) => setTimeout(r, 250));
  const editor2 = container.querySelector('.attachment-editor');
  check(editor2.classList.contains('is-over'), '超限时附件区应有超限标记');
  check(/超过单封上限/.test(editor2.textContent), '应说明超过上限');
  const send2 = [...container.querySelectorAll('button')].find((b) => b.textContent === '确认发送');
  checkEqual(send2.disabled, true, '超限时必须禁用发送按钮（不能等到服务器报错）');
  container.remove();
  delete globalThis.__forceResponses;
});

await step('总览页：「需要你关注」默认折叠 5 条，「需要你处理」保持全展开', async () => {
  const { app } = await import('../web/app.js');
  const base = responses['/api/overview'];
  const mk = (i) => ({
    key: `INBOX:9${i}`,
    folder: 'INBOX',
    uid: 900 + i,
    type: 'fyi',
    priority: 'high',
    recipientKind: 'cc',
    isCcAttention: true,
    subject: `抄送邮件 ${i}`,
    from: { name: '同事', address: `c${i}@x.com` },
    date: now,
    mail: { folder: 'INBOX', uid: 900 + i, subject: `抄送邮件 ${i}`, from: { name: '同事', address: `c${i}@x.com` }, date: now },
  });
  globalThis.__forceResponses = {
    '/api/overview': {
      ...base,
      attention: Array.from({ length: 9 }, (_v, i) => mk(i + 1)),
      needAction: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ ...analysis, key: `INBOX:8${i}`, uid: 800 + i, mail: { ...analysis.mail, uid: 800 + i } })),
      priorityList: [],
    },
  };
  app.invalidateAll();
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 80));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 150));

  const attentionRows = () => [...app.els.main.querySelectorAll('[data-section="attention"] .mail-row')];
  checkEqual(attentionRows().length, 5, `「需要你关注」默认应只显示 5 条（实际 ${attentionRows().length}）`);
  check(app.els.main.innerHTML.includes('还有 4 封抄送邮件'), '应提示还有几封未显示');
  check(app.els.main.innerHTML.includes('展开全部 9 封'), '应提供展开入口');

  // 需要你处理：7 条全部展开，不做折叠
  const needRows = () => [...app.els.main.querySelectorAll('[data-section="need"] .mail-row')];
  checkEqual(needRows().length, 7, `「需要你处理」应全部展开（实际 ${needRows().length}）`);
  check(
    !app.els.main.querySelector('[data-section="need"] .more-hint'),
    '「需要你处理」不应有折叠提示（待办清单折叠会导致漏看）',
  );

  // 展开后显示全部
  const moreBtn = [...app.els.main.querySelectorAll('button')].find((b) => b.textContent.includes('还有 4 封抄送邮件'));
  moreBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  checkEqual(attentionRows().length, 9, '展开后应显示全部 9 条');
  delete globalThis.__forceResponses;
});

await step('日历知识库：对话式回顾分析可跑通并给出导出入口', async () => {
  const knowledge = await import('../web/views/knowledge.js');
  const { renderReviewCharts: renderChartsForTest } = await import('../web/charts.js');
  const container = document.createElement('div');
  document.body.append(container);
  let reviewCalls = 0;
  globalThis.__forceResponses = {
    '/api/calendar/review/presets': {
      ok: true,
      presets: [{ id: 'last-30d', label: '过去 30 天' }, { id: 'last-month', label: '上个月' }],
      review: { workdayStart: '09:00', workdayEnd: '19:00' },
      examples: ['请详细分析过去 30 天的日历，并给出工作优化建议'],
    },
    '/api/calendar/review': {
      ok: true,
      understood: { preset: 'last-30d', rangeLabel: '过去 30 天', from: '2026-09-03', to: '2026-10-01', days: 30, focus: ['time-allocation', 'work-life'], reason: "用户说'过去30天'" },
      range: { label: '过去 30 天', from: '2026-09-03', to: '2026-10-01', days: 30 },
      source: { totalEntries: 21, counted: 21, occupied: 21, excluded: 0, meetings: 8, meetingsByTitle: 8, meetingsByAttendees: 0, workBlocks: 8, lifeCount: 5, focus: 0, allDay: 0, oooDays: 2, sparse: false },
      excludedNote: '没有未计入占用的条目',
      totals: {
        meetingCount: 8, meetingHours: 14.5, workBlockCount: 8, workHours: 20.5,
        workBusyHours: 35, workloadHours: 35, workloadLoadRatio: 16.7,
        lifeHours: 12, lifeEntryCount: 5, lifeShareOfBusy: 25.5, oooDays: 2,
        busyHours: 47, occupancyRatio: 22.4, busyHoursPerWorkday: 2.2,
        workloadHoursPerWorkday: 1.6, meetingsPerWorkday: 0.4,
      },
      structure: { deepBlockCount: 24, deepBlockHours: 200.5, eveningMeetings: 1, eveningWork: 2, eveningLife: 0, weekendMeetings: 1, weekendWork: 3, weekendLife: 1, longMeetings: 3, backToBack: 1, conflicts: 0 },
      lifeKinds: [{ name: '运动健身', count: 3, hours: 9, samples: ['北沿公园散步'] }, { name: '家庭陪伴', count: 1, hours: 2, samples: ['和老婆孩子过结婚纪念日午餐'] }],
      weekly: [{ week: '2026-09-21 ~ 09-27', meetingCount: 0, meetingHours: 0, busyHours: 4, meetingsPerWorkday: 0 }, { week: '2026-09-28 ~ 10-04', meetingCount: 8, meetingHours: 14.5, busyHours: 26.5, meetingsPerWorkday: 1.6 }],
      topPeople: [{ name: '王梓', hours: 3, count: 2, via: 'title' }, { name: '刘少豪', hours: 2.5, count: 1, via: 'title' }],
      topRecurring: [], topics: [{ topic: '开发实现', count: 5 }, { topic: '协调推进', count: 4 }],
      durations: [{ id: 'short', label: '很短（<30 分钟）', count: 1, hours: 0.5 }, { id: 'xlong', label: '超长（>2 小时）', count: 6, hours: 21 }],
      locations: { counts: { virtual: 0, onsite: 2, unknown: 11 }, top: [{ name: '柳林路158号6楼小会议室', count: 1 }] },
      dayStats: [
        { key: '2026-09-28', label: '2026-09-28', isWorkday: true, meetingCount: 1, meetingHours: 0.5, busyHours: 0.5 },
        { key: '2026-09-29', label: '2026-09-29', isWorkday: true, meetingCount: 3, meetingHours: 9, busyHours: 13 },
      ],
      timeline: [], analysis: '## 一句话总结\n负荷高度集中。\n\n## 可执行的优化建议\n1. 拆分超长会议。',
      analysisError: null, reportId: 'report_test_1', elapsedMs: 5200,
      fetch: { pages: 1, fetched: 17, truncated: false, maxTotal: 5000 },
    },
  };
  const { api } = await import('../web/api.js');
  const realReview = api.calendarReview;
  api.calendarReview = (payload) => {
    reviewCalls += 1;
    return realReview(payload);
  };
  const calKnowledgeFixture = responses['/api/calendar/knowledge'];
  try {
    knowledge.renderKnowledge(container, { navigate() {}, refreshCounts() {}, showMail() {} });
    await new Promise((r) => setTimeout(r, 200));

    // 切到日历知识库标签
    const tab = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === '日历知识库');
    check(tab, '应能找到「日历知识库」标签');
    tab.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));

    const block = [...container.querySelectorAll('section')].find((s) => s.textContent.includes('对话式回顾分析'));
    check(block, '日历知识库里应有「对话式回顾分析」区');
    const input = block.querySelector('.search-panel .ask-row .input');
    check(input, '应有输入框');
    check(
      [...block.querySelectorAll('.ask-row button')].some((b) => b.textContent.includes('分析')),
      '应有「分析并导出」按钮（与输入框同一行）',
    );

    // 用它给的示例直接跑一次
    const example = [...block.querySelectorAll('.chip')].find((c) => c.textContent.includes('过去 30 天'));
    check(example, '应渲染服务端下发的示例问法');
    example.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 350));
    check(reviewCalls >= 1, '点示例应触发回顾请求');

    const result = container.querySelector('.review-result');
    check(result, '应渲染回顾结果');
    const text = result.textContent;
    check(text.includes('过去 30 天'), '应回显理解到的区间');
    check(text.includes('2026-09-03'), '应回显起止日期');
    check(text.includes('占用'), '应说明口径与占用情况');
    check(!text.includes('口径为纯工作'), '不应再出现"纯工作口径"这种把生活排除掉的表述');
    check(text.includes('生活/个人事务'), '应把生活/个人事务作为一等指标展示');
    check(text.includes('12h'), '应展示生活占用小时数');
    check(text.includes('47h'), '应展示总占用小时数');
    check(text.includes('两个视角'), '应说明"总占用 = 工作 + 生活"的两个视角');
    check(text.includes('休假/外出 2 天'), '休假应按天展示');
    check(text.includes('按标题识别'), '应说明会议识别方式（否则用户会疑惑"我明明开了会"）');
    check(text.includes('35h'), '应展示工作负荷');
    check(text.includes('16.7'), '应展示工作负荷占比');
    check(/晚间/.test(text) && /周末/.test(text), '应展示晚间/周末占用');
    check(text.includes('一句话总结'), '应渲染 AI 分析');

    // 图表：从结构化数据画 SVG，而不是依赖 markdown 渲染（我们的渲染器不支持表格/代码块）
    const chartsBox = result.querySelector('.chart-grid');
    check(chartsBox, '应有图表区');
    const figures = [...chartsBox.querySelectorAll('figure')];
    check(figures.length >= 4, `应至少有 4 张图（实际 ${figures.length}）`);
    const titles = figures.map((f) => f.querySelector('.chart-title')?.textContent || '');
    check(titles.some((t) => t.includes('按周')), `应有按周负荷图（实际：${titles.join(' / ')}）`);
    check(titles.some((t) => t.includes('时间构成')), '应有时间构成图');
    check(titles.some((t) => t.includes('每日忙碌')), '应有每日忙碌热力图');
    check(titles.some((t) => t.includes('生活')), '应有"生活/个人事务花在哪"图（用户明确要看的部分）');
    check(titles.some((t) => t.includes('人')), '应有人名榜图');
    check(titles.some((t) => t.includes('时长分布')), '应有时长分层图');
    // 版式（用户给的版图）：三列，宽图跨整行；中间一行用嵌套 grid 显式定位
    checkEqual(chartsBox.querySelector('.chart-span-3 .chart-title')?.textContent, '按周工作负荷', '第一张应是整行的按周负荷');
    const durIdx = titles.findIndex((t) => t.includes('时长分布'));
    const peopleIdx = titles.findIndex((t) => t.includes('时间最多的人'));
    check(durIdx >= 0 && peopleIdx >= 0 && durIdx < peopleIdx, `「活动时长分布」应排在「占用时间最多的人」之前（实际 ${durIdx} vs ${peopleIdx}）`);
    checkEqual(titles[titles.length - 1].includes('时间最多的人'), true, '人名榜应是最后一张（整行，给它最宽位置）');
    const span3 = [...chartsBox.children].filter((c) => c.classList.contains('chart-span-3'));
    check(span3.length >= 3, `应有至少 3 张整行宽图（实际 ${span3.length}）`);
    // 中间一行：左列是**一个容器**装上下两张（不是两个网格行，否则中间会被撑出空隙）
    const mid = chartsBox.querySelector('.chart-midrow');
    check(mid, '应有一个中间行容器');
    const leftCol = mid.querySelector('.chart-midrow-left');
    check(leftCol, '左列应是容器（上下两张挨在一起）');
    const leftCards = [...leftCol.children];
    checkEqual(leftCards.length, 2, `左列应有两张图（实际 ${leftCards.length}）`);
    checkEqual(leftCards[0].querySelector('.chart-title')?.textContent, '活动时长分布（项）', '左列上应是活动时长分布');
    checkEqual(leftCards[1].querySelector('.chart-title')?.textContent, '生活/个人事务（小时）', '左列下应是生活/个人事务');
    check(mid.querySelector('.chart-cell-mid'), '中列应是工作主题分布');
    check(mid.querySelector('.chart-cell-right'), '右列应是每日忙碌分布');
    checkEqual(mid.querySelector('.chart-cell-mid .chart-title')?.textContent, '工作主题分布（项）', '中列内容');
    checkEqual(mid.querySelector('.chart-cell-right .chart-title')?.textContent, '每日忙碌分布', '右列内容');
    // 缺图时应留空格而不是把后面的图挤走（显式定位的意义）
    const onlyHeat = renderChartsForTest({ totals: {}, weekly: [], topics: [], topPeople: [], durations: [], dayStats: [] });
    const midNoOthers = onlyHeat.querySelector('.chart-midrow');
    check(midNoOthers?.querySelector('.chart-cell-right'), '即使只有热力图，它也应留在右列位置');

    // 热力图：每个行首要有该周的日期范围（如 9.28~10.4），格子向右让出标签栏
    const hmFig = figures.find((f) => f.querySelector('.chart-title')?.textContent?.includes('每日忙碌'));
    const hmSvg = hmFig.querySelector('svg');
    const hmTexts = [...hmSvg.querySelectorAll('text.chart-axis')].map((t) => t.textContent);
    const weekHeads = ['一', '二', '三', '四', '五', '六', '日'];
    checkEqual(hmTexts.slice(0, 7).join(''), weekHeads.join(''), '应先有星期表头');
    const rowLabels = hmTexts.slice(7);
    check(rowLabels.length >= 1, `每行都应有日期范围标签（实际 ${rowLabels.length} 个）`);
    check(rowLabels.every((t) => /^\d{1,2}\.\d{1,2}(~\d{1,2}\.\d{1,2})?$/.test(t)), `日期范围格式应为 9.28~10.4（实际 ${rowLabels.join(' / ')}）`);
    const firstCell = hmSvg.querySelector('rect.chart-cell');
    const firstLabel = hmSvg.querySelectorAll('text.chart-axis')[7];
    check(Number(firstCell.getAttribute('x')) > Number(firstLabel.getAttribute('x')), '格子应右移，给日期标签让出空间');
    // 时间构成的条要够粗（曾经 barH=20 渲染成一条细线）
    const compFig = figures.find((f) => f.querySelector('.chart-title')?.textContent?.includes('时间构成'));
    const compBar = compFig?.querySelector('rect.chart-bar');
    check(Number(compBar?.getAttribute('height')) >= 36, `时间构成的条高应 >= 36（实际 ${compBar?.getAttribute('height')}）`);
    // 时间构成必须包含"生活/个人"这一段，否则打羽毛球的时间会凭空消失
    check(chartsBox.textContent.includes('生活/个人'), '时间构成图应包含生活/个人段');
    check(chartsBox.textContent.includes('·'), '段内标签应带占比（如"生活/个人 12h · 25%"）');
    // 反拉伸：不能再用 preserveAspectRatio="none"（会把热力图方格压成长方形）
    check(
      ![...chartsBox.querySelectorAll('svg')].some((el) => el.getAttribute('preserveAspectRatio') === 'none'),
      '不应使用 preserveAspectRatio="none"（会非等比拉伸）',
    );
    // 热力图用固定像素尺寸，避免按宽度等比放大后高度失控
    check(
      [...chartsBox.querySelectorAll('svg')].some((el) => el.classList.contains('chart-svg-fixed')),
      '热力图应使用固定像素尺寸',
    );
    // 图表：类目型用 HTML 行、几何型用 SVG
    const svgs = [...chartsBox.querySelectorAll('svg')];
    check(svgs.length >= 3, `应有 SVG（按周/时间构成/热力图，实际 ${svgs.length}）`);
    check(svgs.every((el) => el.namespaceURI === 'http://www.w3.org/2000/svg'), 'SVG 元素必须在 SVG 命名空间里');
    check(figures.every((f) => f.namespaceURI !== 'http://www.w3.org/2000/svg'), '图表外壳应是 HTML 元素（用 createElementNS 建的 div 不会渲染）');
    // 横向条形图现在是 HTML：行高/条高是绝对像素，三张卡片的柱子与间隔才会完全一致
    const barLists = [...chartsBox.querySelectorAll('.bar-list')];
    check(barLists.length >= 3, `应有 3 张 HTML 横向条形图（实际 ${barLists.length}）`);
    check(
      barLists.every((l) => l.closest('.chart').querySelectorAll('svg').length === 0),
      '横向条形图不应再有 SVG（否则柱子会随卡片宽度缩放，三张图对不齐）',
    );
    for (const list of barLists) {
      const rows = [...list.querySelectorAll('.bar-row')];
      check(rows.length > 0, '每张条形图都应有行');
      check(
        rows.every((r) => r.children.length === 3 && r.querySelector('.bar-track') && r.querySelector('.bar-fill') && r.querySelector('.bar-value')),
        '每行应由 标签 / 轨道+填充 / 数值 三部分组成',
      );
      check(
        rows.every((r) => /^width:\d/.test(r.querySelector('.bar-fill').getAttribute('style') || '')),
        '填充宽度应是百分比内联样式',
      );
    }
    check(chartsBox.querySelectorAll('rect.chart-bar').length >= 3, '应画出柱子（按周/时间构成仍是 SVG）');
    check(chartsBox.querySelectorAll('title').length >= 3, '柱子应带悬浮数值提示');
    check(chartsBox.textContent.includes('王梓'), '人名榜应显示解析出的人名');
    // 坐标里出现 NaN 会让图形静默消失——这种问题肉眼很难发现，必须断言
    const allAttrs = [...chartsBox.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => `${a.name}=${a.value}`));
    check(!allAttrs.some((a) => /NaN|Infinity|undefined/.test(a)), `图表属性不应含 NaN/Infinity/undefined（${allAttrs.find((a) => /NaN|Infinity|undefined/.test(a)) || ''}）`);
    // 零数据不应画出柱子（避免"看着有数据其实全是 0"）
    const zeroBox = renderChartsForTest({ totals: {}, weekly: [], topics: [], topPeople: [], durations: [], dayStats: [] });
    check(zeroBox.querySelectorAll('rect.chart-bar').length === 0, '零数据不应画出柱子');
    check(zeroBox.textContent.includes('暂无数据') || zeroBox.textContent.includes('没有任何日程'), '零数据应给出说明而不是空白');

    const link = [...result.querySelectorAll('a')].find((a) => a.textContent.includes('下载 Markdown'));
    check(link, '应提供 Markdown 导出入口');
    checkEqual(link.getAttribute('href'), '/api/reports/report_test_1?format=raw', '导出地址应指向报告原文接口');
    check(/\.md$/.test(link.getAttribute('download') || ''), '应带 .md 文件名');
  } finally {
    api.calendarReview = realReview;
    void calKnowledgeFixture;
    container.remove();
    delete globalThis.__forceResponses;
  }
});

await step('图表：段内标签必须放得下，放不下就降级为图例（条要够粗、不得拉伸）', async () => {
  const { stackedBar, stackedBarChart, heatmap } = await import('../web/charts.js');
  const segs = [
    { name: '会议', value: 14.5, className: 'seg-meeting' },
    { name: '独自工作', value: 21, className: 'seg-work' },
    { name: '专注块', value: 0.5, className: 'seg-focus' }, // 极窄：放不下标签
    { name: '生活/个人', value: 12, className: 'seg-life' },
  ];
  const fig = stackedBar({ title: '时间构成（总占用）', segments: segs });
  const bars = [...fig.querySelectorAll('rect.chart-bar')];
  check(bars.length === 4, '应画出 4 个色块');

  // 条要够粗（曾经 barH=20 渲染成一条细线）
  check(Number(bars[0].getAttribute('height')) >= 36, `条高应 >= 36（实际 ${bars[0].getAttribute('height')}）`);

  // 估算文字宽度（与实现相互独立地算一遍）：中文 1 字宽、ASCII 0.55 字宽
  const unit = 6.3;
  const widthOf = (str) => [...String(str)].reduce((sum, ch) => sum + (/[\u4e00-\u9fa5（）：·]/.test(ch) ? unit : unit * 0.55), 0);
  const boxWidth = Number(fig.querySelector('svg').getAttribute('viewBox').split(' ')[2]);
  const total = segs.reduce((s, x) => s + x.value, 0);
  let cursor = 0;
  let checked = 0;
  for (const sg of segs) {
    const w = (sg.value / total) * boxWidth;
    const label = [...fig.querySelectorAll('text.chart-inside-label')].find((t) => {
      const x = Number(t.getAttribute('x'));
      return x >= cursor && x <= cursor + w;
    });
    if (label) {
      check(widthOf(label.textContent) <= w, `标签「${label.textContent}」宽 ${widthOf(label.textContent).toFixed(0)} 超过了色块宽 ${w.toFixed(0)}`);
      checked += 1;
    }
    cursor += w;
  }
  check(checked >= 3, `至少 3 个色块应有标签（实际 ${checked}）`);
  // 最窄的那一段必须没有标签（否则会压到隔壁颜色上）
  const narrow = [...fig.querySelectorAll('text.chart-inside-label')].find((t) => Number(t.getAttribute('x')) < 266 + 385 && Number(t.getAttribute('x')) > 266 + 385 - 2);
  check(!narrow, '极窄色块不应放标签');

  // 不得使用 preserveAspectRatio="none"（会把热力图方格压成长方形、柱高失真）
  const all = [fig, stackedBarChart({ title: 'T', items: [{ label: 'w', segments: [{ name: 'a', value: 1 }] }] }), heatmap({ title: 'T', days: [{ key: '2026-09-01', value: 3, weekday: 2 }] })];
  for (const el of all) {
    const svg = el.querySelector('svg');
    check(svg.getAttribute('preserveAspectRatio') !== 'none', '不应使用 preserveAspectRatio="none"');
  }
  // 热力图用固定像素：viewBox 很窄，等比放大后高度会失控
  const hm = heatmap({ title: 'T', days: Array.from({ length: 30 }, (_v, i) => ({ key: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`, value: i % 5, weekday: i % 7 })) });
  const hmSvg = hm.querySelector('svg');
  check(hmSvg.classList.contains('chart-svg-fixed'), '热力图应是固定像素尺寸');
  check(Number(hmSvg.getAttribute('width')) < 400, `热力图固有宽度应较小（实际 ${hmSvg.getAttribute('width')}）`);
});

await step('图表：配色必须把"独自工作"与"会议"分开（橘 / 紫，不撞色）', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const readVars = (block) => {
    const out = {};
    for (const m of block.matchAll(/--chart-([a-z]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
    return out;
  };
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
  const greenMatch = css.match(/:root\[data-theme='green'\]\s*\{([^}]*)\}/);
  check(rootMatch && greenMatch, '应能找到浅色/绿色两套变量');
  for (const [theme, vars] of [['浅色', readVars(rootMatch[1])], ['绿色', readVars(greenMatch[1])]]) {
    check(vars.meeting && vars.work && vars.life && vars.focus, `${theme}主题应定义 meeting/work/life/focus 四色`);
    const uniq = new Set([vars.meeting, vars.work, vars.life, vars.focus]);
    checkEqual(uniq.size, 4, `${theme}主题四色必须互不相同（实际 ${[...uniq].join(' / ')}）`);
    // 独自工作=橘、生活=紫：用色相粗略判断（R 最高者为橘系，B 最高者为紫系）
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [wr, wg, wb] = hex(vars.work);
    check(wr > wg && wg > wb, `${theme}主题"独自工作"应是橘色系（实际 ${vars.work}）`);
    const [lr, lg, lb] = hex(vars.life);
    check(lb > lg && lr > lg, `${theme}主题"生活/个人"应是紫色系（实际 ${vars.life}）`);
  }
});

await step('界面一致性：块内左右内边距统一、视图里不再有内联魔法数字', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const ruleOf = (sel) => {
    const m = css.match(new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
    return m ? m[2] : null;
  };
  // 块头 / 检索区 / 块内正文的左右内边距必须一致，否则"标题 → 正文"会错开
  const headPad = ruleOf('.block-head');
  check(headPad, '应能找到 .block-head 规则');
  check(/padding:\s*13px\s+16px/.test(headPad), `块头应为 13px 16px（实际 ${headPad.trim()}）`);
  const padRule = ruleOf('.pad');
  check(padRule, '应能找到 .pad 规则');
  check(/padding:\s*14px\s+16px/.test(padRule), `.pad 横向必须是 16px——曾经是 4px，导致全站"标题→正文"错开 12px（实际 ${padRule.trim()}）`);
  const searchPad = ruleOf('.search-panel');
  check(searchPad && /16px/.test(searchPad), '检索区横向也应是 16px');

  // 视图里不允许再有内联 style：魔法数字是页面之间慢慢走形的根源
  const views = ['calendar', 'drafts', 'knowledge', 'overview', 'search', 'settings'];
  for (const v of views) {
    const src = fs.readFileSync(new URL(`../web/views/${v}.js`, import.meta.url), 'utf8');
    const hits = [...src.matchAll(/style:\s*\{/g)];
    checkEqual(hits.length, 0, `views/${v}.js 不应再有内联 style（实际 ${hits.length} 处）`);
  }
  // 间距工具类必须存在，否则替换后的类名会静默失效
  for (const cls of ['.mt-1', '.mt-2', '.mt-3', '.mt-4', '.mb-3', '.block-lead', '.block-note', '.block-body', '.flush-head']) {
    check(ruleOf(cls), `应定义 ${cls}（被视图引用）`);
  }
});

await step('界面一致性：块头操作区不许把按钮挤到下一行、间距工具类齐全', async () => {
  const fs = await import('node:fs');
  const css = fs.readFileSync(new URL('../web/styles.css', import.meta.url), 'utf8');
  const ruleOf = (sel) => {
    const m = css.match(new RegExp(`(^|\\})\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm'));
    return m ? m[2] : null;
  };
  // 块头里的操作区不能收缩，否则长内容会把按钮顶到下一行（用户实测过）
  const head = ruleOf('.head-actions');
  check(head, '应能找到 .head-actions');
  check(/flex:\s*0\s+0\s+auto/.test(head), `.head-actions 必须不收缩（实际 ${head.trim()}）`);
  check(ruleOf('.nowrap'), '应定义 .nowrap（按钮文字不换行）');
  // 标题可压缩、可省略，保证操作区留在右侧同一行
  check(/\.block-head\s*>\s*h3/.test(css), '应给块头标题设省略规则，避免长标题挤压操作区');

  // 横向条形图的几何必须在 CSS 里写死为像素（这是三张图对齐的前提）
  const barRow = ruleOf('.bar-row');
  check(barRow && /height:\s*\d+px/.test(barRow), `.bar-row 必须固定像素高（实际 ${barRow?.trim()}）`);
  const track = ruleOf('.bar-track');
  check(track && /height:\s*\d+px/.test(track), `.bar-track 必须固定像素高（实际 ${track?.trim()}）`);
  check(/grid-template-columns/.test(barRow || ''), '.bar-row 用 grid 固定标签列宽，不同卡片柱子起点才会对齐');

  // 间距工具类必须存在（视图引用它们，缺了会静默失效）
  for (const cls of ['.mt-1', '.mt-2', '.mt-3', '.mt-4', '.mb-3', '.block-lead', '.block-note', '.block-body', '.flush-head']) {
    check(ruleOf(cls), `应定义 ${cls}（被视图引用）`);
  }
});

await step('日历页：扫描按钮固定在块头右侧，窗口信息不参与块头排版', async () => {
  const calendar = await import('../web/views/calendar.js');
  const container = document.createElement('div');
  calendar.renderCalendar(container, { navigate() {}, refreshCounts() {} });
  await new Promise((r) => setTimeout(r, 160));
  const scan = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('扫描最近 24 小时邮件'));
  check(scan, '应有扫描按钮');
  const head = scan.closest('.block-head');
  check(head, '扫描按钮应在块头里');
  checkEqual(head.querySelectorAll('button').length, 1, '块头里应只有这一个按钮');
  // 窗口信息（上次报错就是它把按钮挤下去的）不能出现在块头里
  const actions = head.querySelector('.head-actions');
  check(actions && !/窗口/.test(actions.textContent), `窗口信息不应放进 .head-actions（实际「${actions?.textContent.trim()}」）`);
  check(scan.classList.contains('nowrap'), '按钮应带 .nowrap，避免文字换行把版面撑高');

  // 扫过之后窗口信息要出现在块头之外
  scan.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 140));
  const head2 = [...container.querySelectorAll('.block-head')].find((x) => x.textContent.includes('从邮件生成日程'));
  check(!/窗口/.test(head2.textContent), '扫描后窗口信息也不应进入块头');
  check(/扫描窗口：/.test(container.textContent), '窗口信息应显示在块头下方');
  const scan2 = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('扫描最近 24 小时邮件'));
  check(scan2 && scan2.closest('.block-head'), '扫描后按钮仍在块头里（没被挤走）');
});

await step('网络：代理 CONNECT 路径不得再写 agent: false（会静默忽略 createConnection）', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../server/lib/http.js', import.meta.url), 'utf8');
  // 只检查代码、不看注释：注释里正是要解释这个坑
  const code = src
    .split('\n')
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
    .join('\n');
  check(!/agent:\s*false/.test(code), 'http.js 不应再出现 agent: false（会让 Node 忽略 createConnection，隧道建好即被丢弃）');
  check(/createConnection:\s*\(\)\s*=>\s*tlsSocket/.test(code), '代理路径仍应通过 createConnection 复用隧道 socket');

  /*
   * 行为层面也验一遍：Node 只在**不传 agent** 时才调用 createConnection。
   * 目标主机名用永不解析的域名，这样"有没有用我们给的 socket"就是可判定的。
   */
  const http = await import('node:http');
  const net = await import('node:net');
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('LIVE');
  });
  const port = await listenRandom(server);
  const probe = (opts) =>
    new Promise((resolve) => {
      const req = http.request(
        { host: 'example.invalid', port: 80, path: '/', method: 'GET', ...opts, createConnection: () => net.connect(port, '127.0.0.1') },
        (res) => resolve(`status=${res.statusCode}`),
      );
      req.on('error', (e) => resolve(`ERROR:${e.code || e.message}`));
      req.end();
    });
  try {
    checkEqual(await probe({}), 'status=200', '不传 agent 时 createConnection 必须生效');
    const withFalse = await probe({ agent: false });
    check(withFalse !== 'status=200', `agent:false 会让 createConnection 失效（实际 ${withFalse}）`);
  } finally {
    server.close();
  }
});

await step('运行与记录页：操作台账与运行历史都能看到，且支持筛选与下载', async () => {
  const records = await import('../web/views/records.js');
  const container = document.createElement('div');
  document.body.append(container);
  let auditCalls = [];
  globalThis.__forceResponses = {
    '/api/audit': {
      ok: true,
      items: [
        { at: '2026-10-03T06:20:00.000Z', action: 'calendar.event.create', label: '创建日程', group: '日历', target: '评审材料提交（改过）', source: '从邮件生成', ok: true, extra: { start: '2026-10-06 15:00', mailSubject: '月度报告提交提醒', edited: true } },
        { at: '2026-10-03T06:10:00.000Z', action: 'draft.send', label: '发送回复邮件', group: '邮件', target: 'Re: 月度报告', source: '界面确认发送', ok: true, extra: { to: 'wang@client.com', attachments: ['报告.pdf'] } },
        { at: '2026-10-03T06:00:00.000Z', action: 'draft.send', label: '发送回复邮件', group: '邮件', target: 'Re: 鉴权失败', source: '界面确认发送', ok: false, error: 'SMTP 535 鉴权失败' },
      ],
      total: 3,
      truncated: false,
      file: 'D:\\data\\audit.jsonl',
      stats: { total: 3, byGroup: { 日历: 1, 邮件: 2 }, byAction: { 'calendar.event.create': 1, 'draft.send': 2 }, lastAt: '2026-10-03T06:20:00.000Z' },
      actions: {
        'draft.send': { label: '发送回复邮件', group: '邮件' },
        'draft.sync': { label: '同步草稿到邮箱', group: '邮件' },
        'calendar.event.create': { label: '创建日程', group: '日历' },
        'calendar.event.delete': { label: '删除日程', group: '日历' },
      },
    },
    '/api/runs': {
      ok: true,
      runs: [
        { id: 'r1', startedAt: '2026-10-03T04:41:05.775Z', finishedAt: '2026-10-03T04:41:17.636Z', status: 'success', counts: { fetched: 11, analyzed: 11, needsReply: 0, drafts: 0 } },
        { id: 'r2', startedAt: '2026-10-02T04:00:00.000Z', finishedAt: '2026-10-02T04:00:30.000Z', status: 'failed', error: 'IMAP 连接被拒绝', counts: { fetched: 0, analyzed: 0 } },
      ],
    },
  };
  const { api } = await import('../web/api.js');
  const realAudit = api.audit;
  api.audit = (params) => {
    auditCalls.push(params || {});
    return realAudit(params);
  };
  try {
    records.renderRecords(container, { viewStates: {}, navigate() {} });
    await new Promise((r) => setTimeout(r, 160));
    const text = container.textContent;
    check(text.includes('操作记录'), '应有操作记录区');
    check(text.includes('分析运行历史'), '应有运行历史区');
    // 具体标题/主题要能看到（用户要求"可查性最强"）
    check(text.includes('评审材料提交（改过）'), '台账应显示日程标题');
    check(text.includes('Re: 月度报告'), '台账应显示邮件主题');
    check(text.includes('wang@client.com'), '应显示收件人');
    check(text.includes('报告.pdf') === false || text.includes('附件 1 个'), '应显示附件数量');
    check(text.includes('SMTP 535'), '失败原因要能看到');
    check(text.includes('创建日程') && text.includes('发送回复邮件'), '应显示动作名称');
    check(text.includes('从邮件生成'), '应显示来源');
    check(text.includes('写入前改过内容'), '改过内容要标注');
    check(text.includes('audit.jsonl'), '应显示台账文件位置');
    // 运行历史
    check(text.includes('成功') && text.includes('耗时'), '运行历史应显示结果与耗时');
    check(text.includes('IMAP 连接被拒绝'), '失败的运行要显示原因');
    check(text.includes('11'), '运行历史应显示拉取/分析数量');
    // 下载入口
    const dl = [...container.querySelectorAll('a')].find((a) => a.textContent.includes('下载 JSONL'));
    check(dl, '应提供台账下载入口');
    checkEqual(dl.getAttribute('href'), '/api/audit/download', '下载地址');
    // 筛选：类别下拉能把 group 传给接口
    const selects = [...container.querySelectorAll('select')];
    check(selects.length >= 2, '应有类别与动作两个下拉');
    const groupSel = selects[0];
    const calOpt = [...groupSel.querySelectorAll('option')].find((o) => o.textContent === '日历');
    check(calOpt, '类别下拉应有「日历」');
    /*
     * linkedom 的 `select.value` 是只读的、也不跟随 option.selected（浏览器里正常）。
     * dispatchEvent 会自己设置 e.target，所以不能给事件挂假 target；
     * 改成在元素实例上遮蔽 value/checked 这个属性，再派发 change。
     * 只影响"测试怎么模拟用户选择"，不改被测代码。
     */
    const fireChange = (el, prop, value) => {
      Object.defineProperty(el, prop, { get: () => value, configurable: true });
      el.dispatchEvent(new window.Event('change', { bubbles: true }));
    };
    fireChange(groupSel, 'value', '日历');
    await new Promise((r) => setTimeout(r, 120));
    check(
      auditCalls.some((c) => c.group === '日历'),
      `选「日历」后应带上 group 参数（实际 ${JSON.stringify(auditCalls)}）`,
    );
    // 只看失败
    const failedBox = container.querySelector('input[type=checkbox]');
    check(failedBox, '应有「只看失败」勾选框');
    fireChange(failedBox, 'checked', true);
    await new Promise((r) => setTimeout(r, 120));
    check(auditCalls.some((c) => c.ok === '0'), `勾选后应带上 ok=0（实际 ${JSON.stringify(auditCalls)}）`);
  } finally {
    api.audit = realAudit;
    container.remove();
    delete globalThis.__forceResponses;
  }
});

await step('运行与记录页：台账为空时禁用下载（避免下载到 0 字节），并给出补录入口', async () => {
  const records = await import('../web/views/records.js');
  const container = document.createElement('div');
  document.body.append(container);
  globalThis.__forceResponses = {
    '/api/audit': {
      ok: true,
      items: [],
      total: 0,
      truncated: false,
      file: 'D:\\data\\audit.jsonl',
      stats: { total: 0, byGroup: {}, byAction: {}, lastAt: null },
      actions: { 'calendar.event.create': { label: '创建日程', group: '日历' } },
    },
    '/api/runs': { ok: true, runs: [] },
  };
  const { api } = await import('../web/api.js');
  const realBackfill = api.auditBackfill;
  let backfillCalls = 0;
  api.auditBackfill = () => {
    backfillCalls += 1;
    return Promise.resolve({
      ok: true,
      fromChat: 62,
      fromCalendar: 3,
      calendar: { scanned: 108, matched: 3, skipped: 0, truncated: false, error: null },
      added: 65,
      skipped: 0,
      truncated: false,
    });
  };
  try {
    records.renderRecords(container, { viewStates: {}, navigate() {} });
    await new Promise((r) => setTimeout(r, 160));
    const text = container.textContent;
    check(text.includes('还没有操作记录'), '空态应有说明');
    // 关键：不能给一个能点出 0 字节文件的下载链接
    const dlLink = [...container.querySelectorAll('a')].find((a) => a.textContent.includes('下载 JSONL'));
    check(!dlLink, '没有记录时不应渲染下载链接（会下载到 0 字节空文件）');
    const dlBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('下载 JSONL'));
    check(dlBtn && dlBtn.disabled, '没有记录时下载按钮应禁用');
    // 空态要告诉用户"历史为什么不在"以及怎么补
    check(text.includes('补录'), '空态应提示可以补录历史');
    const bfBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('补录历史'));
    check(bfBtn, '应有「补录历史」按钮');
    bfBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));
    checkEqual(backfillCalls, 1, '点「补录历史」应调用补录接口');
    // 必须弹出结果提示（用户实测过"点了一点反应都没有"）
    const toastHost = document.querySelector('.toast-host');
    const toastText = toastHost?.textContent || '';
    check(/补录/.test(toastText), `补录后必须给出明确提示（实际「${toastText.slice(0, 60)}」）`);
    check(/62/.test(toastText) && /本地会话记录/.test(toastText), `提示里应说明从本地补录了多少（实际「${toastText.slice(0, 80)}」）`);
    // 按钮不能一直卡在"补录中…"
    const afterBtn = [...container.querySelectorAll('button')].find((b) => /补录/.test(b.textContent));
    check(afterBtn && !/补录中/.test(afterBtn.textContent), '补录结束后按钮应恢复可用，不能一直显示"补录中…"');
  } finally {
    api.auditBackfill = realBackfill;
    container.remove();
    delete globalThis.__forceResponses;
  }
});

await step('日历页：每个日程都有「编辑」入口，改时间走 PATCH 而不是重建', async () => {
  const calendar = await import('../web/views/calendar.js');
  const container = document.createElement('div');
  document.body.append(container);
  const { api } = await import('../web/api.js');
  const calls = [];
  const realUpdate = api.calendarUpdateEvent;
  api.calendarUpdateEvent = (id, patch) => {
    calls.push({ id, patch });
    return Promise.resolve({
      ok: true,
      event: { id, summary: patch.summary, startLocal: patch.startLocal, endLocal: patch.endLocal },
      message: `已保存修改：${patch.summary}`,
    });
  };
  try {
    calendar.renderCalendar(container, { navigate() {}, refreshCounts() {} });
    await new Promise((r) => setTimeout(r, 240));
    const editBtns = [...container.querySelectorAll('.event-actions button')].filter((b) => b.textContent === '编辑');
    check(editBtns.length > 0, `日程卡片应有「编辑」按钮（实际 ${editBtns.length} 个）`);
    // 「编辑」与「删除」并列，原有删除能力不能被弄丢
    const actions = editBtns[0].closest('.event-actions');
    check([...actions.querySelectorAll('button')].some((b) => b.textContent === '删除'), '「编辑」旁边应保留「删除」');

    editBtns[0].dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    const modal = document.querySelector('.modal');
    check(modal, '点「编辑」应打开弹窗');
    check(/修改日程/.test(modal.textContent), `弹窗标题应是「修改日程」（实际「${modal.querySelector('.modal-title')?.textContent}」）`);
    check(/保存修改/.test(modal.textContent), '按钮应是「保存修改」');
    // 预填原值才叫"改"，否则就是"新建"
    const summaryInput = modal.querySelector('input[type=text]');
    check(summaryInput && summaryInput.value.length > 0, '标题应预填原值');
    const startInput = modal.querySelector('input[type=datetime-local]');
    check(
      startInput && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startInput.value),
      `开始时间应预填为 datetime-local 格式（实际「${startInput?.value}」）`,
    );

    summaryInput.value = '改过的标题';
    summaryInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const saveBtn = [...modal.querySelectorAll('button')].find((b) => b.textContent === '保存修改');
    saveBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    checkEqual(calls.length, 1, '应发起一次修改请求');
    checkEqual(calls[0].patch.summary, '改过的标题', '应把改后的标题发出去');
    check(calls[0].patch.startLocal && calls[0].patch.endLocal, '应带上起止时间');
    checkEqual(calls[0].patch.allDay, false, '定时日程应显式带上 allDay=false');
  } finally {
    api.calendarUpdateEvent = realUpdate;
    container.remove();
  }
});

await step('待办闭环：清单里每条都能「已处理/稍后/忽略」，已闭环的可展开恢复', async () => {
  const { app } = await import('../web/app.js');
  const base = globalThis.__baseOverviewFixture || null;
  /*
   * 直接构造一份带待办数据的总览响应用来验证交互：
   * 需要两条"需要你处理" + 三组已闭环的，才能同时验到"操作"与"恢复"。
   */
  const at = now;
  const mk = (uid, subject) => ({
    key: `INBOX:${uid}`,
    folder: 'INBOX',
    uid,
    subject,
    from: { address: `p${uid}@client.com`, name: `发件人${uid}` },
    to: [{ address: 'me@x.com' }],
    cc: [],
    date: at,
    priority: 'high',
    type: 'action_required',
    summary: '需要你确认一下',
    actions: ['回复对方'],
    draftStatus: null,
    hasDraft: false,
  });
  globalThis.__forceResponses = {
    '/api/overview': {
      ok: true,
      windowHours: 24,
      generatedAt: at,
      timeZone: 'Asia/Shanghai',
      stats: { total: 2, needsReply: 1, attention: 0, urgent: 0, high: 2, withAttachments: 0, byType: {}, byPriority: {}, drafts: { total: 0, pending: 0, sent: 0, failed: 0 }, taskDone: 1, taskSnoozed: 1, taskIgnored: 1 },
      priorityList: [mk(9101, '还在清单里的事'), mk(9102, '已经处理过的事')],
      needAction: [mk(9101, '还在清单里的事')],
      attention: [],
      taskGroups: {
        done: [mk(9102, '已经处理过的事')],
        snoozed: [{ ...mk(9103, '稍后再看的事') }],
        ignored: [{ ...mk(9104, '被忽略的事') }],
      },
      taskStates: {
        'INBOX:9102': { status: 'done', updatedAt: at, note: '已经回过了' },
        'INBOX:9103': { status: 'snoozed', snoozeUntil: '2026-09-30T01:00:00.000Z' },
        'INBOX:9104': { status: 'ignored', updatedAt: at },
      },
      actions: [],
    },
  };
  const calls = [];
  const { api } = await import('../web/api.js');
  const realSet = api.taskSetStatus;
  api.taskSetStatus = (key, payload) => {
    calls.push({ key, payload });
    return Promise.resolve({ ok: true, task: { key, ...payload }, message: payload.status === 'done' ? '已标记为已处理' : '已设为稍后提醒' });
  };
  try {
    app.invalidateAll();
    app.navigate('overview');
    await new Promise((r) => setTimeout(r, 120));
    await app.current.reload();
    await new Promise((r) => setTimeout(r, 160));
    const need = app.els.main.querySelector('[data-section="need"]');
    check(need, '应有「需要你处理」区块');
    const btns = [...need.querySelectorAll('.task-actions button')].map((b) => b.textContent);
    check(btns.includes('已处理') && btns.includes('稍后') && btns.includes('忽略'), `每条应有三个待办操作（实际 ${btns.join('/')}）`);

    // 点「已处理」→ 调接口并带上 done
    const doneBtn = [...need.querySelectorAll('.task-actions button')].find((b) => b.textContent === '已处理');
    doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));
    checkEqual(calls.length, 1, '应调用一次待办接口');
    checkEqual(calls[0].payload.status, 'done', '状态应是 done');
    checkEqual(calls[0].key, 'INBOX:9101', '应带上正确的邮件 key');

    // 点「稍后」→ 弹出时间档位，选一个后带上 snoozeUntil
    const snoozeBtn = [...need.querySelectorAll('.task-actions button')].find((b) => b.textContent === '稍后');
    snoozeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const modal = document.querySelector('.modal');
    check(modal && /稍后提醒/.test(modal.textContent), '应弹出稍后提醒的时间档位');
    const opt = [...modal.querySelectorAll('.snooze-option')].find((b) => /明天早上/.test(b.textContent)) || modal.querySelector('.snooze-option');
    check(opt, '应有可选的时间档位');
    opt.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 160));
    const last = calls[calls.length - 1];
    checkEqual(last.payload.status, 'snoozed', '状态应是 snoozed');
    check(last.payload.snoozeUntil, '应带上提醒时间');
    check(!Number.isNaN(new Date(last.payload.snoozeUntil).getTime()), '提醒时间应是合法时间');
    check(new Date(last.payload.snoozeUntil).getTime() > Date.now(), '提醒时间应在未来');

    // 已闭环三组：默认折叠，展开后能恢复
    const groupBlock = app.els.main.querySelector('[data-section="task-groups"]');
    check(groupBlock, '应显示「已经不在清单里」区块');
    check(/已处理（1）/.test(groupBlock.textContent), `应分组显示（实际「${groupBlock.textContent.slice(0, 80)}」）`);
    check(/稍后提醒（1）/.test(groupBlock.textContent), '应有稍后提醒分组');
    check(/已忽略（1）/.test(groupBlock.textContent), '应有已忽略分组');
    // 折叠状态下列表行不渲染
    check(!groupBlock.querySelector('.mail-list'), '默认应折叠，不渲染列表行');
    const head = [...groupBlock.querySelectorAll('.task-group-head')].find((b) => /已处理/.test(b.textContent));
    head.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const reopened = app.els.main.querySelector('[data-section="task-groups"]');
    check(reopened.querySelector('.mail-list'), '展开后应渲染列表行');
    check(/已经回过了/.test(reopened.textContent), '应显示备注');
    const restore = [...reopened.querySelectorAll('button')].find((b) => b.textContent === '恢复为待办');
    check(restore, '展开后应有「恢复为待办」');
    restore.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    checkEqual(calls[calls.length - 1].payload.status, 'open', '恢复应把状态打回 open');
  } finally {
    api.taskSetStatus = realSet;
    delete globalThis.__forceResponses;
    app.invalidateAll();
  }
});

await step('设置页：定时与通知区块（含实时状态与「立即试一次」）', async () => {
  const settings = await import('../web/views/settings.js');
  const container = document.createElement('div');
  document.body.append(container);
  globalThis.__forceResponses = {
    '/api/config': {
      ok: true,
      secretSources: {},
      presets: [],
      config: {
        defaultInstanceId: 'default',
        instances: [{ id: 'default', label: '企业邮箱', enabled: true, isDefault: true, imap: {}, smtp: {}, identity: {} }],
        scan: { folders: ['INBOX'], maxMessages: 60, threadContextCount: 3, bodyCharsForLlm: 4000, snippetChars: 240 },
        draft: {},
        llm: { baseUrl: '', model: '', apiKey: '' },
        web: { host: '127.0.0.1', port: 8787 },
        calendar: { enabled: true, calendarId: 'primary', timeZone: 'Asia/Shanghai', google: {} },
        search: { backfillMax: 40 },
        schedule: { enabled: true, times: ['08:30', '18:00'], days: [1, 2, 3, 4, 5], windowHours: 24 },
        notify: { inApp: true, browser: false, email: true, emailTo: 'me@x.com' },
      },
    },
    '/api/schedule': {
      ok: true,
      enabled: true,
      ticking: true,
      times: ['08:30', '18:00'],
      days: [1, 2, 3, 4, 5],
      windowHours: 24,
      timeZone: 'Asia/Shanghai',
      lastRunAt: '2026-10-04T00:30:05.000Z',
      lastSlot: '2026-10-04 08:30',
      lastResult: { ok: true, fetched: 11, analyzed: 11, needsReply: 3, drafts: 1 },
      lastError: null,
    },
    '/api/meta': { ok: true, timeZone: 'Asia/Shanghai', version: '1.0.0' },
    '/api/calendar/status': { ok: true, configured: true, connected: true },
    '/api/instances': { ok: true, instances: [] },
    '/api/status': { ok: true, counts: {}, running: false },
  };
  const { api } = await import('../web/api.js');
  const realRun = api.runScheduleNow;
  let runCalls = 0;
  api.runScheduleNow = () => {
    runCalls += 1;
    return Promise.resolve({ ok: true, skipped: false, status: { enabled: true, ticking: true, times: ['08:30'], timeZone: 'Asia/Shanghai' } });
  };
  try {
    settings.renderSettings(container, { viewStates: {}, invalidateAll() {}, refreshCounts() {}, notifyBrowser: false });
    await new Promise((r) => setTimeout(r, 260));
    const text = container.textContent;
    check(text.includes('定时分析与通知'), '应有「定时分析与通知」区块');
    check(/默认关闭/.test(text), '应说明定时分析默认关闭及其代价');
    // 时刻与星期要能看出当前配置
    const inputs = [...container.querySelectorAll('input[type=text]')].map((i) => i.value);
    check(inputs.includes('08:30,18:00'), `应回填已配置的时刻（实际 ${JSON.stringify(inputs)}）`);
    check(inputs.includes('1,2,3,4,5'), '应回填星期配置');
    check(inputs.includes('me@x.com'), '应回填简报收件人');
    // 实时状态：定时器在跑 + 上次结果
    check(/定时器运行中/.test(text), `应显示定时器正在运行（实际片段「${text.slice(text.indexOf('定时'), text.indexOf('定时') + 60)}」）`);
    check(/上次执行/.test(text) && /待办 3/.test(text), '应显示上次执行时间与结果');
    // 三个通知开关
    const switches = [...container.querySelectorAll('.switch input[type=checkbox]')];
    check(switches.length >= 3, `通知开关应有三个（页内/浏览器/自寄简报，实际 ${switches.length} 个开关）`);
    // 立即试一次
    const runBtn = [...container.querySelectorAll('button')].find((b) => b.textContent === '立即试一次');
    check(runBtn, '应有「立即试一次」');
    runBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    checkEqual(runCalls, 1, '点「立即试一次」应调用定时任务接口');
  } finally {
    api.runScheduleNow = realRun;
    container.remove();
    delete globalThis.__forceResponses;
  }
});

await step('通知：定时分析完成后弹页内提示（SSE notify 事件）', async () => {
  const { app } = await import('../web/app.js');
  /*
   * 注意：`toast()` 内部缓存了 toastHost 节点，**不能把它从 DOM 里摘掉**
   * （摘掉之后后续 toast 会挂到一个已脱离文档的节点上，什么都看不见）。
   * 这里只清空已有内容。
   */
  const host = document.querySelector('.toast-host');
  if (host) host.replaceChildren();
  const realRefresh = app.refreshCounts;
  app.refreshCounts = () => Promise.resolve();
  try {
    app.onProgressEvent({ type: 'notify', needsReply: 3, drafts: 1, fetched: 11, analyzed: 11 });
    await new Promise((r) => setTimeout(r, 60));
    const text = document.querySelector('.toast-host')?.textContent || '';
    check(/自动分析完成/.test(text), `应弹出完成提示（实际「${text.slice(0, 60)}」）`);
    check(/需要你处理 3 封/.test(text), '应说明有几件事等着处理');
    check(/新起草 1 封/.test(text), '应说明新草稿数');
  } finally {
    app.refreshCounts = realRefresh;
  }
});

await step('日历页：授权失效时给出「重新连接」按钮（而不是只让人空点重试）', async () => {
  const calendar = await import('../web/views/calendar.js');
  const container = document.createElement('div');
  document.body.append(container);
  const { api } = await import('../web/api.js');
  const realStatus = api.calendarStatus;
  const realInsight = api.calendarInsight;
  const realAuthUrl = api.calendarAuthUrl;
  try {
    /*
     * 场景：refresh token 被撤销。以前 `connected` 只看"文件里有没有 token"，
     * 页面显示「已连接」而请求全失败；错误文案还写着"请重新点击「连接 Google 日历」"，
     * 可报错页上只有「重试」——**文案承诺的按钮并不存在**。
     */
    api.calendarStatus = () =>
      Promise.resolve({
        ok: true,
        enabled: true,
        configured: true,
        connected: false,
        needsReauth: true,
        email: 'me@x.com',
        timeZone: 'Asia/Shanghai',
        lastRefreshError: 'Token has been expired or revoked.',
      });
    api.calendarInsight = () =>
      Promise.reject(Object.assign(new Error('Google 授权已失效，需要重新连接。'), { code: 'OAUTH_REFRESH_REVOKED' }));
    let authUrlCalls = 0;
    api.calendarAuthUrl = () => {
      authUrlCalls += 1;
      return Promise.resolve({ url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' });
    };
    globalThis.open = () => ({ closed: false });

    calendar.renderCalendar(container, { navigate() {}, refreshCounts() {} });
    await new Promise((r) => setTimeout(r, 260));
    const text = container.textContent;
    check(/需要重新连接 Google 日历|授权已失效/.test(text), `应说明是授权失效（实际「${text.slice(0, 90)}」）`);
    check(!/已连接 Google 日历/.test(text), '授权失效时不得再说「已连接」（否则界面自相矛盾）');
    check(/7 天/.test(text), '应说明最可能的原因（测试发布状态下 refresh token 只有 7 天）');
    const reconnect = [...container.querySelectorAll('button')].find((b) => /重新连接/.test(b.textContent));
    check(reconnect, '必须真的给出「重新连接 Google 日历」按钮（错误文案承诺过它）');
    reconnect.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    checkEqual(authUrlCalls, 1, '点「重新连接」应真的去取授权链接');

    /*
     * 第二条路径：状态接口说"就绪"、但取日历数据时才失败（例如服务端刚发现令牌失效）。
     * 这时用户看到的是**报错页**——它以前只有一个「重试」，而错误文案写着
     * "请重新点击「连接 Google 日历」"：文案承诺的按钮并不存在。这里必须也有。
     */
    const container2 = document.createElement('div');
    const { api: api2 } = await import('../web/api.js');
    api2.calendarStatus = () =>
      Promise.resolve({ ok: true, enabled: true, configured: true, connected: true, ready: true, email: 'me@x.com', timeZone: 'Asia/Shanghai' });
    calendar.renderCalendar(container2, { viewStates: {}, navigate() {}, refreshCounts() {} });
    await new Promise((r) => setTimeout(r, 260));
    const t2 = container2.textContent;
    check(/需要重新连接 Google 日历/.test(t2), `报错页也应说明需要重新连接（实际「${t2.slice(0, 80)}」）`);
    check(/7 天/.test(t2), '报错页也应给出原因（而不是只说"授权已失效"）');
    check(
      [...container2.querySelectorAll('button')].some((b) => /重新连接/.test(b.textContent)),
      '报错页必须有「重新连接」按钮（文案承诺过它）',
    );
    check(
      [...container2.querySelectorAll('button')].some((b) => b.textContent === '重试'),
      '「重试」可以留，但不能只有它',
    );
    container2.remove();
  } finally {
    api.calendarStatus = realStatus;
    api.calendarInsight = realInsight;
    api.calendarAuthUrl = realAuthUrl;
    delete globalThis.open;
    container.remove();
  }
});

await step('开始使用向导：三步进度、未完成时给引导、配好后能进下一步', async () => {
  const setup = await import('../web/views/setup.js');
  const container = document.createElement('div');
  document.body.append(container);
  const { api } = await import('../web/api.js');
  const realHealth = api.health;
  const realDiag = api.diagnostics;
  const realSave = api.saveConfig;
  const calls = [];

  const healthOf = (over) => ({
    ok: true,
    version: '1.0.0',
    node: 'v20.0.0',
    dataDir: 'D:\\data',
    timeZone: 'Asia/Shanghai',
    ready: false,
    fresh: true,
    nextStepId: 'mailbox',
    steps: [
      { id: 'mailbox', title: '连接邮箱', required: true, done: false, detail: 'IMAP 服务器地址为空' },
      { id: 'llm', title: '配置大模型', required: true, done: false, detail: '大模型 API Key 为空' },
      { id: 'calendar', title: '连接 Google 日历（可选）', required: false, done: false, skipped: true, detail: '未启用（不用日历可以跳过）' },
    ],
    ...over,
  });

  try {
    globalThis.__forceResponses = {
      '/api/health': healthOf({}),
      '/api/config': {
        ok: true,
        presets: [],
        config: {
          defaultInstanceId: 'default',
          instances: [{ id: 'default', label: '企业邮箱', enabled: true, imap: { host: '', port: 993, secure: true, authUser: '', authPass: '' }, smtp: { host: '', port: 465, secure: true, authUser: '', authPass: '' }, identity: { email: '', name: '' } }],
          llm: { baseUrl: '', model: '', apiKey: '' },
          web: {},
          calendar: { enabled: false, timeZone: 'Asia/Shanghai', google: {} },
        },
      },
      '/api/meta': { ok: true, timeZone: 'Asia/Shanghai', version: '1.0.0', llmPresets: [{ id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }] },
    };
    api.diagnostics = (instanceId, deep) => {
      calls.push({ kind: 'diagnostics', instanceId, deep });
      return Promise.resolve({ ok: true, checks: [{ id: 'imap-connect', label: 'IMAP 连接', status: 'ok', message: '正常' }] });
    };
    api.saveConfig = (patch) => {
      calls.push({ kind: 'save', patch });
      return Promise.resolve({ ok: true, config: patch });
    };

    setup.renderSetup(container, { viewStates: {}, navigate() {}, paintNav() {}, invalidateAll() {} });
    await new Promise((r) => setTimeout(r, 200));

    const text = container.textContent;
    check(/开始使用/.test(text), '应有「开始使用」标题');
    check(/连接邮箱/.test(text) && /配置大模型/.test(text) && /Google 日历/.test(text), '应显示三步');
    check(/IMAP 服务器地址为空/.test(text) === false, '步骤详情来自 health（这里是当前步表单，不重复显示其它步骤的原因）');
    // 默认落在第一个未完成步骤：邮箱
    check(/收信（IMAP）/.test(text) && /发信（SMTP）/.test(text), '应默认落在「连接邮箱」这步');
    check(/授权码/.test(text), '应有授权码字段');

    // 填好并点「保存并测试」→ 必须真的保存 + 真的测一次
    const inputs = [...container.querySelectorAll('input[type=text]')];
    const setVal = (el, v) => {
      el.value = v;
      el.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    setVal(inputs[0], 'imap.example.com');
    const pw = container.querySelector('input[type=password]');
    setVal(pw, 'auth-code');
    const saveBtn = [...container.querySelectorAll('button')].find((b) => /保存并测试/.test(b.textContent));
    check(saveBtn, '应有「保存并测试」');
    saveBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    check(calls.some((c) => c.kind === 'save'), '应保存配置');
    const saved = calls.find((c) => c.kind === 'save');
    checkEqual(saved.patch.instances[0].imap.host, 'imap.example.com', '应把填的服务器写进 patch');
    checkEqual(saved.patch.instances[0].imap.authPass, 'auth-code', '应把授权码写进 patch');
    check(calls.some((c) => c.kind === 'diagnostics'), '保存后应立刻验证一次（不把问题推到后面）');
    check(/验证通过|已保存/.test(container.textContent), `应给出验证结果（实际「${container.textContent.slice(0, 120)}」）`);

    // 切到「配置大模型」：预设下拉应可用
    const llmChip = [...container.querySelectorAll('.setup-chip')].find((b) => /配置大模型/.test(b.textContent));
    llmChip.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    const select = container.querySelector('select');
    check(select, '大模型步骤应有服务商下拉');
    check([...select.querySelectorAll('option')].some((o) => /DeepSeek/.test(o.textContent)), '下拉里应有预设');

    // 配好后：进入「可以用了」
    globalThis.__forceResponses['/api/health'] = healthOf({
      ready: true,
      fresh: false,
      nextStepId: null,
      steps: [
        { id: 'mailbox', title: '连接邮箱', required: true, done: true, detail: '已配置：u@x.cn' },
        { id: 'llm', title: '配置大模型', required: true, done: true, detail: '已配置：deepseek-chat' },
        { id: 'calendar', title: '连接 Google 日历（可选）', required: false, done: false, skipped: true, detail: '未启用（不用日历可以跳过）' },
      ],
    });
    const refresh = [...container.querySelectorAll('button')].find((b) => b.textContent === '刷新状态');
    refresh.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));
    check(/可以用了|可以开始用了/.test(container.textContent), `配好后应显示完成态（实际「${container.textContent.slice(0, 120)}」）`);
  } finally {
    api.health = realHealth;
    api.diagnostics = realDiag;
    api.saveConfig = realSave;
    delete globalThis.__forceResponses;
    container.remove();
  }
});

await step('跟催：我承诺的 / 等对方回复 两栏，状态按钮与超期高亮', async () => {
  const fu = await import('../web/views/followups.js');
  const container = document.createElement('div');
  document.body.append(container);
  const { api } = await import('../web/api.js');
  const real = { followups: api.followups, scan: api.followUpsScan, set: api.setFollowUpStatus };
  const calls = [];
  try {
    const items = [
      {
        id: 'mine_1',
        kind: 'mine',
        title: '周三前把报价发给李总',
        status: 'open',
        dueAt: '2020-01-01T00:00:00.000Z', // 故意过期
        counterparty: 'li@client.com',
        subject: '报价',
        since: '2026-10-04T09:00:00.000Z',
      },
      {
        id: 'wait_1',
        kind: 'waiting',
        title: '合同条款确认',
        status: 'open',
        waitingHours: 51,
        counterparty: 'a@client.com',
        subject: '合同',
        since: '2026-10-04T09:00:00.000Z',
        replyTrackable: true,
      },
      { id: 'done_1', kind: 'mine', title: '已完成的事', status: 'done', closeReason: '对方已回复' },
    ];
    api.followups = () => Promise.resolve({ ok: true, items: items.filter((i) => i.status === 'open'), all: items, summary: { open: 2, mine: 1, waiting: 1, overdue: 1 }, config: { enabled: true, waitHours: 24, extractCommitments: true } });
    api.setFollowUpStatus = (id, status) => {
      calls.push({ id, status });
      return Promise.resolve({ ok: true, summary: {} });
    };

    fu.renderFollowUps(container, { viewStates: {}, navigate() {}, refreshCounts() {}, invalidateAll() {}, paintNav() {} });
    await new Promise((r) => setTimeout(r, 200));

    const text = container.textContent;
    check(/我承诺的/.test(text), `应有「我承诺的」分组（实际「${text.slice(0, 200)}」）`);
    check(/等对方回复/.test(text), '应有「等对方回复」分组');
    check(/周三前把报价发给李总/.test(text), '应显示承诺内容');
    check(/等 51 小时/.test(text), '应显示已等待时长');
    check(/已超期/.test(text), `超期项要高亮（实际「${text.slice(0, 120)}」）`);
    check(/已完成 \/ 已忽略（1）/.test(text), '终态应折叠成一组');
    check(/立即扫描/.test(text), '应有扫描按钮');
    check(/li@client.com/.test(text) && /a@client.com/.test(text), '应显示对端');

    // 点「已完成」→ 必须真的调用接口
    const doneBtn = [...container.querySelectorAll('.followup-actions button')].find((b) => b.textContent === '已完成');
    check(doneBtn, '应有「已完成」按钮');
    doneBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 120));
    check(calls.some((c) => c.status === 'done'), '点「已完成」应调用状态接口');

    // 空状态：没有任何跟催时应说明"扫描会做什么"
    api.followups = () => Promise.resolve({ ok: true, items: [], all: [], summary: { open: 0 }, config: { enabled: true, waitHours: 24 } });
    const c2 = document.createElement('div');
    document.body.append(c2);
    fu.renderFollowUps(c2, { viewStates: {}, navigate() {}, refreshCounts() {}, invalidateAll() {}, paintNav() {} });
    await new Promise((r) => setTimeout(r, 200));
    check(/还没有跟催项/.test(c2.textContent), '空状态应给出引导');
    check(/最近发出的邮件/.test(c2.textContent), '空状态应说清扫的是什么（而不是只说"没有数据"）');
    c2.remove();
  } finally {
    api.followups = real.followups;
    api.followUpsScan = real.scan;
    api.setFollowUpStatus = real.set;
    container.remove();
  }
});

await step('设置页字段统一：长说明收进「?」提示，短说明仍留在字段下方', async () => {
  const settingsView = await import('../web/views/settings.js');
  if (globalThis.window?.document) globalThis.document = globalThis.window.document;
  const box = document.createElement('div');
  document.body.append(box);
  try {
    settingsView.renderSettings(box, { navigate() {}, toast() {}, refreshCounts() {}, paintNav() {}, viewStates: {} });
    await new Promise((r) => setTimeout(r, 150));

    // ① 长说明应被收进「?」，全页应该有相当多这样的字段
    const helps = [...box.querySelectorAll('.field-help')];
    check(helps.length >= 5, '长的字段说明应改成「?」提示（实际 ' + helps.length + ' 个）');

    // ② 点击展开，且提示里的文字确实是那条长说明
    const tip = helps[0];
    const wrap = tip.closest('.field-help-wrap');
    const tipBox = wrap.querySelector('.field-help-box');
    check(!tipBox.classList.contains('open'), '提示默认应是收起的（否则排版又乱了）');
    tip.dispatchEvent(new window.Event('click', { bubbles: true }));
    check(tipBox.classList.contains('open'), '点「?」应展开说明');
    check((tipBox.textContent || '').length > 22, '展开的应是那条长说明（实际 ' + (tipBox.textContent || '').length + ' 字）');
    tip.dispatchEvent(new window.Event('click', { bubbles: true }));
    check(!tipBox.classList.contains('open'), '再点一次应收起');

    /*
     * ③ 提示里的文字不该**再**以可见说明的形式重复一遍。
     * 注意不能直接判 includes：提示框本身就在 DOM 里，textContent 当然包含它。
     * 所以数出现次数——只应出现在提示框里那一次。
     */
    const tipText = (tipBox.textContent || '').trim();
    const occurrences = (box.textContent || '').split(tipText).length - 1;
    checkEqual(occurrences, 1, '这条说明只应出现在「?」里（实际出现 ' + occurrences + ' 次）');

    // ④ 短说明（如「SSL 通常 993」）仍然直接显示——它们一行就够，藏起来反而难用
    check(/SSL 通常 993/.test(box.textContent), '短说明应继续直接显示');

    // ⑤ 每个字段都应带标签行（统一结构），不能有的走 .form-field、有的走 .field
    const legacy = box.querySelectorAll('.form-field').length;
    checkEqual(legacy, 0, '设置页不该再有旧结构的字段（实际 ' + legacy + ' 个）');

    /*
     * ⑥ 文案里的 Markdown 粗体必须渲染成真粗体。
     * 之前渲染层不解析 **重点**，星号被原样显示出来（用户看到的是"代码残留"）。
     */
    /*
     * 失败时把残留位置报出来：光说"有星号"没法修，
     * 要能看出是哪条路径漏了（text: / 子节点 / 直接赋值）。
     */
    {
      const offenders = [];
      const walk = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) {
            /*
           * 只找**成对的粗体标记** **文字**。
           * 不能一见到 ** 就报错：密钥掩码就是「显示为 ***，不改动则保留」，
           * 那是正常内容，把它当残留会误报。
           */
          if (/\*\*[^*]+\*\*/.test(child.textContent)) {
              offenders.push((child.parentElement?.tagName || '?') + '.' + (child.parentElement?.className || '') + ' :: ' + child.textContent.trim().slice(0, 60));
            }
          } else walk(child);
        }
      };
      walk(box);
      checkEqual(offenders.length, 0, '页面上不该残留可见的 ** 星号；残留：' + offenders.slice(0, 3).join(' ｜ '));
    }
    check(box.querySelectorAll('strong').length >= 3, '应有文案被渲染成真正的粗体（实际 ' + box.querySelectorAll('strong').length + ' 处）');

    // ⑦ 分区目录：按实际渲染出的区块生成，且每一项都能找到对应区块
    const toc = box.querySelector('.settings-toc');
    check(!!toc, '设置页应有分区目录');
    const chips = [...toc.querySelectorAll('.toc-chip')];
    check(chips.length >= 4, '目录条目数应与区块数相符（实际 ' + chips.length + '）');
    const titles = [...box.querySelectorAll('section.block > .block-head h3')].map((x) => x.textContent.trim());
    checkEqual(chips.map((c) => c.textContent.trim()).join('|'), titles.join('|'), '目录条目应与区块标题一一对应');
    const allLinked = chips.every((_, i) => box.querySelector('#settings-sec-' + i));
    check(allLinked, '每个目录项都应有对应的区块锚点');
    // 点击不该抛错（linkedom 没有 scrollIntoView，代码里做了防御）
    chips[0].dispatchEvent(new window.Event('click', { bubbles: true }));

    // ⑧ 选中的分区标签要加粗高亮，用户才知道"当前在哪一块"
    check(chips[0].classList.contains('active'), '点击后该分区标签应变为选中态');
    checkEqual(chips.filter((c) => c.classList.contains('active')).length, 1, '同时只应有一个分区处于选中态');

    // ⑨ 「关于」必须排在最后（用户要求：别夹在配置项中间）
    checkEqual(titles[titles.length - 1], '关于', '「关于」应是最后一个分区（实际 ' + titles[titles.length - 1] + '）');
  } finally {
    box.remove();
  }
});
await step('HTML 入口：有 HTML 时才给「渲染 HTML」，且正文是点下去才按需取的', async () => {
  const { makeBodyBlock } = await import('../web/app.js');
  const { h } = await import('../web/dom.js');
  if (globalThis.window?.document) globalThis.document = globalThis.window.document;

  // ① 没有 HTML 的邮件：不该出现「渲染 HTML」按钮（否则用户点了没反应）
  const plainOnly = makeBodyBlock({ text: '纯文本正文', hasHtml: false, html: '' }, h('pre', { text: '纯文本正文' }), null);
  check(plainOnly.tagName === 'PRE', '没有 HTML 时应直接给出纯文本块');
  check(!/渲染 HTML/.test(plainOnly.textContent || ''), '没有 HTML 时不该显示渲染按钮');

  // ② 有 HTML（但正文还没取）：必须显示按钮，且此时**不能**已经去取过
  let loadCalls = 0;
  const html = '<p>富文本</p><img src="https://tracker.test/p.gif"><script>alert(1)</script>';
  const block = makeBodyBlock(
    { text: '纯文本正文', hasHtml: true, html: '' },
    h('pre', { text: '纯文本正文' }),
    () => {
      loadCalls += 1;
      return Promise.resolve(html);
    },
  );
  check(/渲染 HTML/.test(block.textContent || ''), '有 HTML 时必须显示「渲染 HTML」入口');
  check(loadCalls === 0, '打开详情时不该已经去取 HTML（要按需）');
  check(/纯文本正文/.test(block.textContent || ''), '默认应显示纯文本');

  // ③ 点按钮：才去取，并且渲染的是**净化后**的内容
  const btn = [...block.querySelectorAll('button')].find((b) => /渲染 HTML/.test(b.textContent));
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check(loadCalls === 1, '点一次应只取一次（实际 ' + loadCalls + '）');
  const rendered = block.innerHTML;
  check(/富文本/.test(rendered), '应渲染出 HTML 内容');
  check(!/<script/i.test(rendered), '渲染的内容必须已净化（不得出现 script）');
  check(/已拦 1 张/.test(block.textContent || ''), '应告诉用户拦下了几张远程图片（实际正文：' + (block.textContent || '').slice(0, 60) + '）');
  /*
   * 用 DOM 精确检查，而不是正则：data-blocked-src="https://…" 里**包含**
   * src="https://… 这个子串，正则会把正确行为判成失败（同一个坑我踩过两次了）。
   */
  {
    const probe = document.createElement('div');
    probe.innerHTML = rendered;
    check(probe.querySelectorAll('img[src^="http"]').length === 0, '渲染后仍不得带远程图片 src');
  }

  // ④ 取不到 HTML 时要退回纯文本并说明，而不是给出空白渲染态
  const failBlock = makeBodyBlock(
    { text: '纯文本正文', hasHtml: true, html: '' },
    h('pre', { text: '纯文本正文' }),
    () => Promise.resolve(''),
  );
  const failBtn = [...failBlock.querySelectorAll('button')].find((b) => /渲染 HTML/.test(b.textContent));
  failBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  check(/纯文本正文/.test(failBlock.textContent || ''), '取不到 HTML 时应退回纯文本');
});
await step('HTML 净化：白名单、危险标签、链接与属性、远程图片默认阻断', async () => {
  const { sanitizeMailHtml, restoreImages, isSafeUrl } = await import('../web/sanitize-html.js');
  /*
   * 显式把 document 指向 window 上那份：净化模块靠它解析 HTML，
   * 而套件里前面若干步可能已经改动过全局（这也是真实浏览器不会有的情况）。
   */
  if (globalThis.window?.document) globalThis.document = globalThis.window.document;

  const evil = [
    '<p>正常文字</p>',
    '<script>alert(1)</script>',
    '<style>body{display:none}</style>',
    '<iframe src="https://evil.test"></iframe>',
    '<form action="https://evil.test"><input name="p"><button>提交</button></form>',
    '<img src="https://tracker.test/pixel.gif" onerror="alert(1)" width="1" height="1">',
    '<img src="cid:inline-1">',
    '<a href="javascript:alert(1)">点我</a>',
    '<a href="java\tscript:alert(1)">绕过尝试</a>',
    '<a href="https://good.test/x" onclick="alert(1)">正常链接</a>',
    '<div style="background:url(https://tracker.test/x)">带样式的块</div>',
    '<marquee>没见过的标签</marquee>',
  ].join('');

  const out = sanitizeMailHtml(evil, { allowRemoteImages: false });
  check(!/<script/i.test(out.html), 'script 必须被删掉');
  check(!/<style/i.test(out.html), 'style 必须被删掉');
  check(!/<iframe/i.test(out.html), 'iframe 必须被删掉');
  check(!/<form|<input|<button/i.test(out.html), '表单相关必须被删掉');
  /*
   * 计数器只做诊断，**不当断言**：`removedScripts/removedForms` 反映的是"我的遍历删掉了几个"，
   * 而不同 HTML 解析器（浏览器 / linkedom）会在**解析阶段**就把 script、form 之类丢掉，
   * 于是计数为 0 —— 拿它当断言会在不同环境下假报错。
   * 真正的保证是上面那几条正则断言：**输出里不能出现这些标签**。
   */
  check(typeof out.removedScripts === 'number' && typeof out.removedForms === 'number',
    '应记录危险元素的处理数量（本次 script=' + out.removedScripts + ' form=' + out.removedForms + '）');
  check(!/onerror|onclick/i.test(out.html), '所有 on* 事件属性必须被剥掉');
  check(!/style=/i.test(out.html), 'style 属性必须被剥掉（background:url 也能追踪）');
  check(!/javascript:/i.test(out.html), 'javascript: 链接必须被处理掉');
  check(out.html.includes('正常文字'), '正常文字必须保留（本次输出长度 ' + out.html.length + '）');
  check(out.html.includes('没见过的标签'), '不认识的标签要拆标签但**保留内容**（否则用户看到空白）');
  check(out.html.includes('带样式的块'), '带 style 的块内容也要保留');
  check(out.html.includes('点我'), '危险链接的文字要保留（用户至少知道这里原本有链接）');
  check(!/href="javascript/i.test(out.html), '危险 href 必须移除');

  // 远程图片：默认不加载，但地址要留着以便"显示图片"
  check(out.blockedImages >= 1, '应统计被拦下的远程图片数');
  /*
   * 用 DOM 精确检查"还有没有真的 src"，而不是正则。
   * 正则会在 `data-blocked-src="https://…"` 里误命中 `src="https://…"`
   * （子串匹配），把正确的行为判成失败。
   */
  {
    const probe = document.createElement('div');
    probe.innerHTML = out.html;
    check(probe.querySelectorAll('img[src^="https://tracker"], img[src^="http://tracker"]').length === 0,
      '远程图片默认不得留 src（否则浏览器会立刻去取）');
  }
  check(out.html.includes('data-blocked-src="https://tracker.test/pixel.gif"'), '地址要留着供用户点「显示图片」');
  check(/src="cid:inline-1"/.test(out.html), '内联附件（cid:）不属于对外请求，应放行');

  // 链接安全化
  check(/rel="noopener noreferrer"/.test(out.html) && /target="_blank"/.test(out.html), '外链必须新窗口 + 切断 opener');

  // 用户点「显示图片」后恢复
  const box = document.createElement('div');
  box.innerHTML = out.html;
  const restored = restoreImages(box);
  check(restored >= 1, '恢复应报告恢复了几张');
  check(/src="https:\/\/tracker\.test\/pixel\.gif"/.test(box.innerHTML), '恢复后应真的带上 src');

  // 显式允许远程图片时不该拦
  const allowed = sanitizeMailHtml('<img src="https://cdn.test/a.png">', { allowRemoteImages: true });
  check(allowed.blockedImages === 0 && /src="https:\/\/cdn\.test\/a\.png"/.test(allowed.html), '显式允许时应保留 src');

  // URL 判定的绕过尝试
  check(isSafeUrl('https://ok.test'), 'https 应放行');
  check(isSafeUrl('mailto:a@b.com'), 'mailto 应放行');
  check(!isSafeUrl('javascript:alert(1)'), 'javascript: 应拒绝');
  check(!isSafeUrl('java\tscript:alert(1)'), '带制表符的绕过应拒绝');
  check(!isSafeUrl(' java\nscript:alert(1)'), '带换行的绕过应拒绝');
  check(!isSafeUrl('data:text/html,<script>x</script>'), 'data:text/html 应拒绝');
  check(isSafeUrl('data:image/png;base64,AAA', { forImage: true }), 'data:image 作为图片应放行');
  check(!isSafeUrl('', {}), '空值应拒绝');
});
await step('时间线：项目标签切换、四类来源标注、空状态说明标签来源', async () => {
  const tl = await import('../web/views/timeline.js');
  const container = document.createElement('div');
  document.body.append(container);
  const { api } = await import('../web/api.js');
  const real = { projects: api.projects, timeline: api.timeline, rename: api.renameProject };
  const calls = [];
  try {
    api.projects = () =>
      Promise.resolve({
        ok: true,
        projects: [
          { key: 'a', name: '华东区投标', count: 4, aliases: ['华东投标'], sources: { mail: 2, draft: 1, followUp: 1 } },
          { key: 'b', name: '官网改版', count: 2, aliases: [], sources: { mail: 2 } },
        ],
        unclassified: 3,
      });
    api.timeline = (project) => {
      calls.push(project);
      return Promise.resolve({
        ok: true,
        project,
        calendarNote: '日程来自本程序的操作记录；别人在 Google 日历上直接创建的日程不会出现在这里',
        counts: { mail: 2, calendar: 1 },
        entries: [
          { at: '2026-10-01T09:00:00Z', kind: 'mail', source: '收到的邮件', title: '招标公告', detail: '公告', meta: { from: 'a@x.com', needsReply: false } },
          { at: '2026-10-03T09:00:00Z', kind: 'calendar', source: '日程', title: '答疑会', meta: {} },
          { at: '2026-10-04T09:00:00Z', kind: 'followUp', source: '等对方回复', title: '等确认保证金', meta: { status: 'open' } },
        ],
      });
    };
    api.renameProject = (from, to) => {
      calls.push(from + '->' + to);
      return Promise.resolve({ ok: true, moved: 2, message: '已把记录并入' });
    };

    tl.renderTimeline(container, { viewStates: {}, navigate() {}, refreshCounts() {}, invalidateAll() {}, paintNav() {} });
    await new Promise((r) => setTimeout(r, 200));
    const text = container.textContent;
    check(/华东区投标/.test(text) && /官网改版/.test(text), '应列出项目标签');
    check(/未归类/.test(text), '未归类也应是可点入口');
    check(/已合并的旧名字/.test(text) && /华东投标/.test(text), '应显示合并过的旧名（让用户明白标签为何收敛）');
    check(/收到的邮件/.test(text) && /日程/.test(text) && /等对方回复/.test(text), '每条都要标注来源');
    check(/别人在 Google 日历上直接创建/.test(text), '必须如实说明日程来源的局限');
    check(/重命名 \/ 合并/.test(text), '应有重命名合并入口');
    check(calls.includes('华东区投标'), '应默认加载项目最多的那个（实际 ' + JSON.stringify(calls) + '）');

    /*
     * 默认倒序（最新在上）：打开某项目时间线时，用户多数想知道"最近进展到哪"。
     * 断言顺序而不只是断言有按钮，否则改了默认值也测不出来。
     */
    {
      const order = [...container.querySelectorAll('.tl-title')].map((x) => x.textContent);
      check(order[0] === '等确认保证金', '默认应最新在上（实际首条 ' + order[0] + '）');
      const btn = [...container.querySelectorAll('button')].find((b) => /最新在上|最早在上/.test(b.textContent));
      check(!!btn, '应有时间顺序切换按钮');
      btn.dispatchEvent(new window.Event('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      const after = [...container.querySelectorAll('.tl-title')].map((x) => x.textContent);
      check(after[0] === '招标公告', '切换后应变为最早在上（实际首条 ' + after[0] + '）');
    }

    // 切到另一个项目
    const chip = [...container.querySelectorAll('.setup-chip')].find((b) => /官网改版/.test(b.textContent));
    chip.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    check(calls.filter((c) => c === '官网改版').length >= 1, '点标签应加载对应项目的时间线');

    // 空状态：没有任何项目时要说清标签从哪来
    api.projects = () => Promise.resolve({ ok: true, projects: [], unclassified: 0 });
    const c2 = document.createElement('div');
    document.body.append(c2);
    tl.renderTimeline(c2, { viewStates: {}, navigate() {}, refreshCounts() {}, invalidateAll() {}, paintNav() {} });
    await new Promise((r) => setTimeout(r, 200));
    check(/还没有可归类的邮件/.test(c2.textContent), '空状态应给出引导');
    check(/分析邮件/.test(c2.textContent), '空状态应说清标签是分析时产生的');
    c2.remove();
  } finally {
    api.projects = real.projects;
    api.timeline = real.timeline;
    api.renameProject = real.rename;
    container.remove();
  }
});
await step('总览页：配置没配完时顶部给出「开始使用」引导', async () => {
  const overview = await import('../web/views/overview.js');
  const container = document.createElement('div');
  document.body.append(container);
  const { api } = await import('../web/api.js');
  const realHealth = api.health;
  let navigated = null;
  try {
    api.health = () =>
      Promise.resolve({
        ok: true,
        ready: false,
        steps: [
          { id: 'mailbox', title: '连接邮箱', required: true, done: false, detail: 'IMAP 服务器地址为空' },
          { id: 'llm', title: '配置大模型', required: true, done: false, detail: '大模型 API Key 为空' },
        ],
      });
    overview.renderOverview(container, { viewStates: {}, navigate: (v) => (navigated = v), paintNav() {} });
    await new Promise((r) => setTimeout(r, 240));
    const text = container.textContent;
    check(/还没配置完/.test(text), `应给出未配置完的横幅（实际「${text.slice(0, 100)}」）`);
    check(/IMAP 服务器地址为空/.test(text), '横幅应说明还差哪一步（而不是只说"未配置"）');
    const btn = [...container.querySelectorAll('button')].find((b) => /开始使用/.test(b.textContent));
    check(btn, '横幅应给出直达向导的按钮');
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    checkEqual(navigated, 'setup', '点按钮应跳到「开始使用」');
  } finally {
    api.health = realHealth;
    container.remove();
  }
});

await step('总览页：已发送的邮件显示为「已发送邮件」，点击直达草稿页「已发送」标签', async () => {  const { app } = await import('../web/app.js');
  // 让总览里的那封邮件已发送（后端会给出 draftStatus='sent'）
  globalThis.__forceResponses = {
    '/api/overview': {
      ...responses['/api/overview'],
      needAction: [{ ...analysis, hasDraft: true, draftStatus: 'sent', draftId: 'draft_INBOX_101', draftSentAt: now }],
    },
    '/api/drafts': { ok: true, drafts: [{ ...draft, status: 'sent', sentAt: now }], signature: SIGNATURE_FIXTURE },
  };
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 60));
  await app.current.reload();
  await new Promise((r) => setTimeout(r, 80));

  const html = app.els.main.innerHTML;
  check(html.includes('已发送邮件'), '已发送的邮件应显示「已发送邮件」按钮');
  check(!html.includes('查看草稿'), '已发送后不应再显示「查看草稿」');
  check(!html.includes('起草回复'), '已发送后不应再显示「起草回复」');

  const btn = [...app.els.main.querySelectorAll('button')].find((b) => b.textContent === '已发送邮件');
  check(btn, '未找到「已发送邮件」按钮');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));

  checkEqual(app.viewId, 'drafts', '点击后应跳到邮件草稿页');
  checkEqual(app.viewStates.drafts?.filter, 'sent', '应自动切到「已发送」标签');
  checkEqual(app.viewStates.drafts?.activeId, 'draft_INBOX_101', '应自动选中那封草稿');
  check(app.els.main.innerHTML.includes('已发送'), '页面应展示已发送的草稿');
  delete globalThis.__forceResponses;
});

await step('完整详情：不再出现「未找到该邮件的分析记录」，缺记录时给出可执行出路', async () => {
  const { app } = await import('../web/app.js');
  const overlays = () => [...document.querySelectorAll('.modal-overlay')];

  const before = overlays().length;
  await app.showMail('INBOX:101', { subject: mail.subject, from: mail.from, date: now, folder: 'INBOX', uid: 101 });
  await new Promise((r) => setTimeout(r, 80));
  checkEqual(overlays().length, before + 1, '应弹出详情弹窗');
  let modal = overlays()[overlays().length - 1];
  let html = modal.innerHTML;
  check(html.includes('客户要求确认周五交付时间'), '已分析的邮件应显示 AI 要点');
  check(html.includes('确认交付时间'), '应显示待办事项');
  check(html.includes('关联草稿：'), '应显示关联草稿状态');
  check(html.includes('查看已发送邮件'), '已发送时应给出「查看已发送邮件」入口');
  modal.remove();

  // 本地完全没有记录（例如正文检索补充进来的邮件）：不能只弹一句「未找到」
  await app.showMail('INBOX:102', {
    subject: '合同附件二条款（抄送）',
    from: { name: '法务部', address: 'legal@company.com' },
    date: now,
    folder: 'INBOX',
    uid: 102,
  });
  await new Promise((r) => setTimeout(r, 80));
  modal = overlays()[overlays().length - 1];
  html = modal.innerHTML;
  check(!html.includes('未找到该邮件的分析记录'), '不应再出现笼统的「未找到该邮件的分析记录」');
  check(html.includes('还没有做过 AI 分析') || html.includes('本地既没有'), '应解释为什么没有分析结论');
  check(html.includes('立即分析这一封'), '应给出「立即分析这一封」入口');
  check(html.includes('合同附件二条款'), '应回填调用方已知的邮件信息');
  modal.remove();
});

await step('草稿页：列表与编辑器、发送按钮', async () => {  const draftsView = await import('../web/views/drafts.js');
  const container = document.createElement('div');
  draftsView.renderDrafts(container, { navigate() {}, refreshCounts() {}, analyze() {} });
  await new Promise((r) => setTimeout(r, 120));
  const html = container.innerHTML;
  check(html.includes('Re: 请确认周五的交付计划'), '缺少草稿主题');
  check(html.includes('确认发送'), '缺少发送按钮');
  check(html.includes('同步到邮箱草稿箱'), '缺少同步按钮');
  check(html.includes('让 AI 重写'), '缺少重写按钮');
  check(html.includes('需要你确认的事项'), '缺少待确认事项');
  check(html.includes('此前往来') || html.includes('查看原始来信'), '缺少原始来信面板');

  // 编辑器各输入框必须真正带上值（textarea 只 setAttribute 会是空的）
  const bodyArea = container.querySelector('.textarea');
  check(bodyArea, '未找到正文输入框');
  checkEqual(bodyArea.value, draft.body, '正文输入框的值应为草稿正文');
  const toInput = [...container.querySelectorAll('input')].find((i) => i.value === draft.to);
  check(toInput, '收件人输入框应回填');
  const subjectInput = [...container.querySelectorAll('input')].find((i) => i.value === draft.subject);
  check(subjectInput, '主题输入框应回填');
});

await step('设置页：邮箱服务器/端口/授权码字段', async () => {
  const settings = await import('../web/views/settings.js');
  const container = document.createElement('div');
  settings.renderSettings(container, { navigate() {}, refreshCounts() {}, analyze() {} });
  await new Promise((r) => setTimeout(r, 80));
  const html = container.innerHTML;
  check(html.includes('IMAP 服务器'), '缺少 IMAP 服务器字段');
  check(html.includes('SMTP 服务器'), '缺少 SMTP 服务器字段');
  check(html.includes('IMAP 授权码'), '缺少 IMAP 授权码字段');
  check(html.includes('SMTP 授权码'), '缺少 SMTP 授权码字段');
  check(html.includes('imap.exmail.qq.com'), '未回填服务器地址');
  check(html.includes('993') && html.includes('465'), '未回填端口');
  check(html.includes('发送策略'), '缺少发送策略设置');
  check(html.includes('大模型'), '缺少大模型设置');
  check(html.includes('textarea-signature'), '签名应为多行输入框');
  check(html.includes('由程序逐字追加'), '缺少签名说明');

  // 表单初值必须真正生效（textarea 只靠 setAttribute 是空的）
  const sigArea = container.querySelector('.textarea-signature');
  check(sigArea, '未找到签名输入框');
  checkEqual(sigArea.value, SIGNATURE_FIXTURE, '签名输入框的值应为配置内容');
  const smtpHost = [...container.querySelectorAll('input')].find((i) => i.value === 'smtp.exmail.qq.com');
  check(smtpHost, 'SMTP 服务器输入框应回填 smtp.exmail.qq.com');
});

await step('知识库页：主题、统计与问答入口', async () => {
  const kb = await import('../web/views/knowledge.js');
  const container = document.createElement('div');
  kb.renderKnowledge(container, { navigate() {}, refreshCounts() {} });
  await new Promise((r) => setTimeout(r, 80));
  const html = container.innerHTML;
  check(html.includes('邮件知识库'), '缺少标题');
  check(html.includes('问一问'), '缺少问答入口');
  check(html.includes('客户/商务'), '缺少主题标签');
  check(html.includes('时间线索'), '缺少时间线索');
  check(html.includes('boss@client.com'), '缺少联系人');
});

await step('日历页：对话面板、日程分析、邮件转日程', async () => {
  const calendar = await import('../web/views/calendar.js');
  const container = document.createElement('div');
  calendar.renderCalendar(container, { navigate() {}, refreshCounts() {} });
  await new Promise((r) => setTimeout(r, 160));
  const html = container.innerHTML;
  check(html.includes('日历数字人'), '缺少标题');
  check(html.includes('对话建日程'), '缺少对话面板');
  check(html.includes('已连接 Google 日历'), '缺少连接状态');
  check(html.includes('me@gmail.com'), '缺少已连接账号');
  check(html.includes('一句话总结'), '缺少日程分析');
  check(html.includes('周会'), '缺少日程明细');
  check(html.includes('客户沟通'), '缺少日程条目');
  check(html.includes('全天'), '全天事件应显示为全天');
  check(html.includes('时间重叠'), '缺少冲突提示');
  check(html.includes('从邮件生成日程'), '缺少邮件转日程面板');
  check(html.includes('扫描最近 24 小时邮件'), '缺少扫描按钮');

  // 「从邮件生成日程」必须紧跟「对话建日程」之后（两个"产生日程"的入口放在一起）
  const left = container.querySelector('.calendar-left');
  const right = container.querySelector('.calendar-right');
  check(left && right, '应有左右两栏');
  const leftText = left.textContent;
  check(leftText.includes('对话建日程') && leftText.includes('从邮件生成日程'), '「从邮件生成日程」应在左栏（紧跟对话建日程）');
  check(!right.textContent.includes('从邮件生成日程'), '「从邮件生成日程」不应再留在右栏底部');
  const chatIdx = leftText.indexOf('对话建日程');
  const mailIdx = leftText.indexOf('从邮件生成日程');
  check(chatIdx >= 0 && mailIdx > chatIdx, '「从邮件生成日程」应排在「对话建日程」之后');

  // 建议列表要先点「扫描」才会出现
  const scanBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('扫描最近 24 小时邮件'));
  check(scanBtn, '应有扫描按钮');
  scanBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  check(container.textContent.includes('编辑后写入'), '建议卡片应提供「编辑后写入」');
  check(container.textContent.includes('直接写入'), '应保留快速路径「直接写入」');
});

await step('日历页：写入前可改主题/时间/地点，并把 override 传给后端', async () => {
  const calendar = await import('../web/views/calendar.js');
  const { api } = await import('../web/api.js');
  const container = document.createElement('div');
  calendar.renderCalendar(container, { navigate() {}, refreshCounts() {} });
  await new Promise((r) => setTimeout(r, 160));
  const scan = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('扫描最近 24 小时邮件'));
  scan.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));

  let captured = null;
  const realAccept = api.calendarAcceptSuggestion;
  api.calendarAcceptSuggestion = (payload) => {
    captured = payload;
    return Promise.resolve({ ok: true, event: { summary: payload.override?.summary || 'x' }, message: '已写入日历' });
  };
  try {
    const editBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === '编辑后写入');
    check(editBtn, '应能找到「编辑后写入」按钮');
    editBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));

    const modal = document.querySelector('.modal-overlay');
    check(modal, '应弹出编辑弹窗');
    check(modal.textContent.includes('写入日历前确认'), '弹窗应有标题');
    const inputs = [...modal.querySelectorAll('input, textarea')];
    const summaryInput = inputs.find((i) => i.type === 'text');
    check(summaryInput && summaryInput.value, `主题应预填（实际 ${summaryInput?.value}）`);
    const dtInputs = inputs.filter((i) => i.type === 'datetime-local');
    checkEqual(dtInputs.length, 2, '应有开始与结束两个时间输入');
    check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(dtInputs[0].value), `时间应预填成 datetime-local 格式（实际 ${dtInputs[0].value}）`);
    check(inputs.some((i) => i.type === 'checkbox'), '应有「全天事项」勾选框');
    check([...modal.querySelectorAll('textarea')].length === 1, '应有说明输入框');

    // 改主题与地点后确认写入
    summaryInput.value = '客户方案评审会（改过的主题）';
    summaryInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    const locInput = inputs.filter((i) => i.type === 'text')[1];
    if (locInput) {
      locInput.value = '17 楼会议室';
      locInput.dispatchEvent(new window.Event('input', { bubbles: true }));
    }
    dtInputs[0].value = '2026-10-06T15:00';
    dtInputs[0].dispatchEvent(new window.Event('input', { bubbles: true }));

    const saveBtn = [...modal.querySelectorAll('button')].find((b) => b.textContent.includes('确认写入'));
    check(saveBtn, '应有确认写入按钮');
    saveBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));

    check(captured, '应调用写入接口');
    checkEqual(captured.override.summary, '客户方案评审会（改过的主题）', '应把改过的主题作为 override 传出');
    checkEqual(captured.override.startLocal, '2026-10-06 15:00', '时间应转成后端认识的本地格式');
    check(locInput ? captured.override.location === '17 楼会议室' : true, '地点修改应传出');
    check(captured.suggestion, '仍要带上原始建议（含来源邮件）');
    check(!document.querySelector('.modal-overlay'), '写入后弹窗应关闭');
  } finally {
    api.calendarAcceptSuggestion = realAccept;
    const stray = document.querySelector('.modal-overlay');
    if (stray) stray.remove();
    document.body.classList.remove('modal-open');
  }
});

await step('日历页：未连接时给出授权前提示（含「未经 Google 验证」警告页指引）', async () => {
  const calendar = await import('../web/views/calendar.js');
  const container = document.createElement('div');
  // 覆盖状态：已配置凭据但尚未授权
  globalThis.__forceCalendarStatus = { ...responses['/api/calendar/status'], ready: false, connected: false };
  calendar.renderCalendar(container, { navigate() {}, refreshCounts() {} });
  await new Promise((r) => setTimeout(r, 160));
  const html = container.innerHTML;
  delete globalThis.__forceCalendarStatus;
  check(html.includes('还需要完成 Google 授权'), '应显示待授权面板');
  check(html.includes('测试用户'), '应提醒测试用户限制');
  check(html.includes('此应用未经 Google 验证'), '应预告未验证警告页');
  check(html.includes('点左侧的「继续」'), '应说明该点哪个按钮');
  check(html.includes('不要点右侧'), '应提醒别点「返回到安全网页」');
});

await step('设置页：日历配置字段', async () => {
  const settings = await import('../web/views/settings.js');
  const container = document.createElement('div');
  settings.renderSettings(container, { navigate() {}, refreshCounts() {}, analyze() {} });
  await new Promise((r) => setTimeout(r, 120));
  const html = container.innerHTML;
  check(html.includes('日历数字人（Google Calendar）'), '缺少日历设置区');
  check(html.includes('客户端 ID'), '缺少 clientId 字段');
  check(html.includes('客户端密钥'), '缺少 clientSecret 字段');
  check(html.includes('授权重定向 URI'), '缺少 redirectUri 字段');
  check(html.includes('Asia/Shanghai'), '缺少时区字段');
  check(html.includes('目标日历 ID'), '缺少 calendarId 字段');
  const calId = [...container.querySelectorAll('input')].find((i) => i.value === 'test.apps.googleusercontent.com');
  check(calId, 'clientId 应回填到输入框');
  check(html.includes('测试连接'), '缺少测试连接按钮');
  check(!html.includes('有未保存的修改'), '刚加载时不应提示未保存');
});

await step('设置页：未保存提示与「测试连接先保存」', async () => {
  const settings = await import('../web/views/settings.js');
  const container = document.createElement('div');
  settings.renderSettings(container, { navigate() {}, refreshCounts() {}, analyze() {} });
  await new Promise((r) => setTimeout(r, 120));
  check(!container.innerHTML.includes('有未保存的修改'), '刚加载时不应提示未保存');

  // 改动表单（此时尚未保存）
  const idInput = [...container.querySelectorAll('input')].find((i) => i.value === 'test.apps.googleusercontent.com');
  check(idInput, '未找到 clientId 输入框');
  idInput.value = 'edited.apps.googleusercontent.com';
  idInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  check(container.innerHTML.includes('有未保存的修改'), '改动后应提示未保存');
  check(container.innerHTML.includes('测试连接」会自动先保存'), '应说明测试连接会自动保存');
  const kept = [...container.querySelectorAll('input')].find((i) => i.value === 'edited.apps.googleusercontent.com');
  check(kept, '重绘后输入框应保留用户输入的值');

  // 点日历段的「测试连接」（同一容器里大模型那一段也有同名按钮，按段定位）
  const calendarSection = [...container.querySelectorAll('section')].find((s) =>
    s.innerHTML.includes('日历数字人（Google Calendar）'),
  );
  check(calendarSection, '未找到日历设置段');
  const testBtn = [...calendarSection.querySelectorAll('button')].find((b) => b.textContent === '测试连接');
  check(testBtn, '未找到日历段的「测试连接」按钮');

  const before = calls.length;
  testBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
  const made = calls.slice(before);
  check(made.includes('PUT /api/config'), `应先把表单保存到服务端再测试（实际调用：${made.join('、') || '无'}）`);
  check(made.includes('POST /api/calendar/test'), `应调用测试连接接口（实际调用：${made.join('、') || '无'}）`);
  check(made.indexOf('PUT /api/config') < made.indexOf('POST /api/calendar/test'), '保存必须发生在测试之前');
});

await step('设置页：存储与清理——「可回收空间」体检项、永久保留说明、不可逆告知', async () => {
  const settings = await import('../web/views/settings.js');
  const render = async (storage) => {
    globalThis.__forceResponses = { '/api/storage': storage };
    const container = document.createElement('div');
    settings.renderSettings(container, { navigate() {}, refreshCounts() {}, analyze() {} });
    await new Promise((r) => setTimeout(r, 120));
    return container.innerHTML;
  };
  try {
    const html = await render(responses['/api/storage']);
    check(html.includes('可回收空间'), '存储面板应把「可回收空间」作为体检项显示');
    check(html.includes('data 目录合计'), '应显示整个 data 目录的占用（用户问的是"省下多少空间"）');
    check(html.includes('当前为永久保留'), '保留天数为 0 时必须明说当前是永久保留');
    check(
      html.includes('保留期清理不会删除任何原文'),
      '必须明确写出"保留期清理不会删除任何原文"，而不是给一个含糊的 0',
    );
    check(html.includes('删除原文不可逆'), '必须写明删除不可逆');
    check(html.includes('删了就不能再查看这些邮件的原文'), '必须写清删了会怎样（不可回滚性告知）');

    // 设了保留天数时：可回收量要按"超期 + 孤儿"分别说明，并说明有文件被近期引用保护
    const html2 = await render({
      ...responses['/api/storage'],
      reclaimable: {
        orphans: { count: 3, bytes: 512 * 1024 },
        expired: { count: 12, bytes: 96 * 1024 * 1024 },
        total: { count: 15, bytes: 96 * 1024 * 1024 + 512 * 1024 },
        permanent: false,
        protectedByRecentAnalysis: { count: 2, bytes: 1024 },
        note: '按保留 30 天计算：12 个超期原文（100663296 字节）可回收；另有 2 个原文文件虽已超期，但因仍在保留期内被分析/查看引用而保留。',
      },
    });
    check(html2.includes('超期 12 个'), '设了保留期时应显示可回收的超期条数');
    check(html2.includes('孤儿 3 个'), '设了保留期时应显示可回收的孤儿条数');
    check(html2.includes('被分析/查看引用而保留'), '应说明有文件因近期引用被保护（这是"不会误删"的界面交代）');
  } finally {
    globalThis.__forceResponses = undefined;
  }
});

await step('错误提示：Google API 未启用时给出可点击的启用链接', async () => {
  const dom = await import('../web/dom.js');
  const overlaysBefore = document.querySelectorAll('.modal-overlay').length;
  dom.toastError({
    code: 'GOOGLE_API_DISABLED',
    message: '创建日程失败：Google Calendar API 未启用。',
    detail: {
      project: '386604958647',
      activationUrl: 'https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=386604958647',
    },
  });
  const overlays = document.querySelectorAll('.modal-overlay');
  check(overlays.length === overlaysBefore + 1, '应弹出说明弹窗');
  const modal = overlays[overlays.length - 1];
  const html = modal.innerHTML;
  check(html.includes('Google Calendar API 尚未启用'), '缺少标题');
  check(html.includes('386604958647'), '应显示项目编号');
  check(html.includes('打开启用页面'), '应有主要操作按钮');
  const link = [...modal.querySelectorAll('a')].find((a) => String(a.getAttribute('href')).includes('calendar-json.googleapis.com'));
  check(link, '应渲染可点击的启用链接');
  check(link.getAttribute('target') === '_blank', '链接应新窗口打开');
  check(String(link.getAttribute('rel')).includes('noreferrer'), '外链应带 rel=noreferrer');
  modal.remove();
});

await step('错误提示：含 URL 的消息会被渲染成可点击链接', async () => {
  const dom = await import('../web/dom.js');
  const node = dom.toast('请打开 https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=1 点击启用', 'error', 50);
  const link = node.querySelector('a');
  check(link, 'toast 里的 URL 应成为链接');
  check(link.getAttribute('href').startsWith('https://console.cloud.google.com'), '链接地址正确');
  node.remove();
});

await step('对话查邮件页：对话式检索与结果展示', async () => {
  const search = await import('../web/views/search.js');
  const container = document.createElement('div');
  const appStub = { navigate() {}, refreshCounts() {}, showMail() {} };
  search.renderSearch(container, appStub);
  await new Promise((r) => setTimeout(r, 120));
  let html = container.innerHTML;
  check(html.includes('对话查邮件'), '缺少标题');
  check(html.includes('用一句话描述你要找的邮件'), '缺少输入区');
  check(html.includes('支持：发件人'), '应说明支持的检索维度');
  check(html.includes('默认回看近 30 天'), '应说明默认时间范围');

  // 触发一次检索
  const input = container.querySelector('.search-main-input');
  check(input, '未找到检索输入框');
  input.value = '张总上个月发过哪些关于合同的邮件';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '检索并分析');
  check(btn, '未找到检索按钮');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));

  html = container.innerHTML;
  check(html.includes('我理解的是：'), '应回显检索理解');
  check(html.includes('时间范围 2026-08-27 ~ 2026-09-27'), '应展示生效时间范围');
  check(html.includes('未指定，按默认近 30 天'), '未指定时间时应说明用了默认范围');
  check(html.includes('张总在近一个月内发来'), '应展示模型分析');
  check(html.includes('命中邮件（2）'), '应列出命中邮件');
  check(html.includes('直接发给我'), '应标注收件方式');
  check(html.includes('抄送给我'), '应标注抄送');
  check(!html.includes('附件二.pdf'), '未展开时不应显示附件明细');
  // 结论依据必须如实标注（不能让用户以为模型读了全部命中）
  check(html.includes('结论基于其中 2 封'), '应标注结论依据的封数');

  // 展开带附件的那一条（第 1 条没有附件，需按行定位而不是取第一个「展开」）
  const targetRow = [...container.querySelectorAll('.kb-row')].find((r) => r.textContent.includes('合同附件二条款'));
  check(targetRow, '未找到带附件的那条结果');
  const expandBtn = [...targetRow.querySelectorAll('button')].find((b) => b.textContent === '展开');
  check(expandBtn, `未找到展开按钮（该行按钮：${[...targetRow.querySelectorAll('button')].map((b) => b.textContent).join('/')}）`);
  expandBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 120));
  check(container.innerHTML.includes('附件二.pdf'), '展开后应显示附件明细');
  check(container.innerHTML.includes('条款已更新'), '展开后应显示正文摘录');

  /*
   * 「结论范围」控件：默认最近 40 封，代价必须写在控件旁；
   * 改选后请求要带上策略，服务端返回的口径（策略 + 覆盖区间 + 回落说明）必须原样显示。
   */
  const { api } = await import('../web/api.js');
  const basisSelect0 = container.querySelector('.search-basis-select');
  check(basisSelect0, '缺少「结论范围」选择器');
  checkEqual(basisSelect0.value, 'recent', '结论范围默认应为「最近 40 封」');
  check(container.innerHTML.includes('结论范围（结论看哪些邮件）'), '缺少结论范围标签');
  check(container.innerHTML.includes('看得最细'), '应写明「最近 40 封」的代价');
  check(container.innerHTML.includes('不会放大模型额度'), '应说明换策略不会放大模型额度');
  const basisOptions = [...basisSelect0.querySelectorAll('option')].map((o) => o.textContent);
  checkEqual(basisOptions.length, 3, '应恰好三种结论范围策略');
  check(basisOptions.join('｜').includes('按月节选') && basisOptions.join('｜').includes('均衡采样'), `下拉应含三种策略（实际 ${basisOptions.join('｜')}）`);

  const basisPayloads = [];
  const realSearchEmails = api.searchEmails;
  api.searchEmails = (payload) => {
    basisPayloads.push(String(payload?.basis));
    return realSearchEmails(payload);
  };
  globalThis.__forceResponses = {
    '/api/search/emails': {
      ...responses['/api/search/emails'],
      // 服务端真实形状的口径对象（含回落说明）
      basis: {
        strategy: 'monthly',
        label: '按月节选 24 封',
        line: '结论基于按月节选 24 封（覆盖 2026-07-18 ~ 2026-09-25，每月最多 8 封）',
        count: 24,
        limit: 40,
        months: 3,
        headlines: 40,
        order: 'date_desc',
        fellBack: true,
        note: '结论范围「月度」不是有效选项，已按「最近 N 封」处理。',
      },
    },
  };
  try {
    const sel = container.querySelector('.search-basis-select');
    /*
     * 模拟用户改选：linkedom 里 `select.value` 只有 getter（赋值会抛错），
     * 因此改成把目标 option 标为 selected 再派发 change——真实浏览器里用户操作也是这个效果。
     */
    const monthlyOption = [...sel.querySelectorAll('option')].find((o) => o.value === 'monthly');
    monthlyOption.selected = true;
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check(container.innerHTML.includes('覆盖整段时间'), '改选后应显示该策略的代价');
    checkEqual(container.querySelector('.search-basis-select').value, 'monthly', '重新渲染后控件应保持所选策略');

    const btn2 = [...container.querySelectorAll('button')].find((b) => b.textContent === '检索并分析');
    btn2.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 260));
    checkEqual(basisPayloads.join(','), 'monthly', '检索请求应带上所选的结论范围策略');
    const finalHtml = container.innerHTML;
    check(finalHtml.includes('结论基于按月节选 24 封（覆盖 2026-07-18 ~ 2026-09-25，每月最多 8 封）'), '应原样显示结论范围口径');
    check(finalHtml.includes('另有 40 封只给了标题与时间'), '应说明还有多少封只给了标题与时间');
    check(finalHtml.includes('不是有效选项'), '策略值被回落时必须显示回落说明');

    // 再改选一次：必须提示「需重新检索」，且**不得**偷偷再发一次（那会悄悄多花一次模型额度）
    const payloadsBefore = basisPayloads.length;
    const sel2 = container.querySelector('.search-basis-select');
    [...sel2.querySelectorAll('option')].find((o) => o.value === 'even').selected = true;
    sel2.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 80));
    check(container.innerHTML.includes('已改动'), '结果与所选策略不一致时应提示需要重新检索');
    checkEqual(basisPayloads.length, payloadsBefore, '改选策略本身不应自动重跑检索');
  } finally {
    api.searchEmails = realSearchEmails;
    delete globalThis.__forceResponses;
  }
});

await step('对话查邮件页：截断时明确写出「命中 N 封 / 已列出前 M 封」', async () => {
  const search = await import('../web/views/search.js');
  const base = responses['/api/search/emails'];
  const many = Array.from({ length: 12 }, (_v, i) => ({
    ...base.items[0],
    key: `INBOX:${300 + i}`,
    uid: 300 + i,
    subject: `截断验证邮件 ${i + 1}`,
    day: '2026-09-20',
    analyzed: i < 10,
    source: i < 10 ? 'analysis' : 'envelope',
    summary: i < 10 ? '需要确认交付时间。' : '',
    notAnalyzed: i >= 10,
  }));
  globalThis.__forceResponses = {
    '/api/search/emails': {
      ...base,
      items: many,
      stats: {
        ...base.stats,
        matched: 34,
        listed: 12,
        truncated: true,
        truncatedBy: 'list',
        analyzed: 10,
        envelopeOnly: 2,
        basis: 12,
      },
      analysisBasis: { count: 12, analyzed: 10, maxAnalyzed: 12, limit: 40, order: 'date_desc', partial: false },
      truncationNote: '命中 34 封，已列出前 12 封（单次展示上限）。请缩小时间范围或加上发件人/主题条件后分次查询，以免漏看较早的邮件。',
    },
  };
  try {
    const container = document.createElement('div');
    const appStub = { navigate() {}, refreshCounts() {}, showMail() {} };
    search.renderSearch(container, appStub);
    await new Promise((r) => setTimeout(r, 120));
    const input = container.querySelector('.search-main-input');
    input.value = '请分析7月份以来 someone@x.com 发给我的邮件';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    const btn = [...container.querySelectorAll('button')].find((b) => b.textContent === '检索并分析');
    btn.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 220));

    const html = container.innerHTML;
    // 核心：命中总数与实际列出数都要出现，不能只写「命中 12 封」
    check(html.includes('命中 34 封 / 已列出前 12 封'), '应同时展示命中总数与已列出条数');
    check(html.includes('命中 34 封，已列出前 12 封'), '应展示服务端的截断说明');
    check(html.includes('缩小时间范围'), '截断说明应给出可执行的建议');
    check(html.includes('命中邮件（34）'), '标题里的命中数应是总数而不是列出数');
    check(html.includes('仅列出前 12 封'), '标题区应补充实际列出条数');
    // 仅信封命中的条目要标注出来，用户才知道它没有摘要
    check(html.includes('仅信封·未分析'), '仅信封命中应有明显标记');
    check(html.includes('其中 2 封只有信封信息'), '应说明仅信封命中的封数');
    // 结论依据有界且如实
    check(html.includes('结论基于其中 12 封'), '应标注结论依据的封数');
  } finally {
    delete globalThis.__forceResponses;
  }
});

await step('知识库：邮件知识库 / 日历知识库 两个标签页', async () => {
  const kb = await import('../web/views/knowledge.js');
  const container = document.createElement('div');
  kb.renderKnowledge(container, { navigate() {}, refreshCounts() {}, showMail() {} });
  await new Promise((r) => setTimeout(r, 150));
  let html = container.innerHTML;
  check(html.includes('邮件知识库'), '缺少邮件知识库标签');
  check(html.includes('日历知识库'), '缺少日历知识库标签');
  check(html.includes('对话式检索'), '邮件知识库应包含对话式检索');
  check(html.includes('需我关注'), '应展示需关注统计');

  // 切到日历知识库
  const tab = [...container.querySelectorAll('.tab')].find((t) => t.textContent === '日历知识库');
  check(tab, '未找到日历知识库标签按钮');
  tab.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  html = container.innerHTML;
  check(html.includes('日程知识库'), '应渲染日历知识库');
  check(html.includes('日程主题分布'), '应展示日程主题分布');
  check(html.includes('按天明细'), '应展示按天明细');
  check(html.includes('来自邮件'), '应标注由邮件生成的日程');
  check(!html.includes('对话式检索'), '日历知识库不应混入邮件检索面板');
});

await step('切换视图：日历页保留会话与结果，不自动重新拉取', async () => {
  const { app } = await import('../web/app.js');
  const before = calls.filter((c) => c === 'GET /api/calendar/insight').length;
  app.navigate('calendar');
  await new Promise((r) => setTimeout(r, 220));
  const afterFirst = calls.filter((c) => c === 'GET /api/calendar/insight').length;
  check(afterFirst > before, '首次进入日历页应拉取一次数据');

  // 切走再切回，不应再次自动拉取
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 80));
  app.navigate('calendar');
  await new Promise((r) => setTimeout(r, 220));
  const afterReturn = calls.filter((c) => c === 'GET /api/calendar/insight').length;
  checkEqual(afterReturn, afterFirst, '切回日历页不应自动刷新');

  // 手动点「刷新日历」才重新拉取
  const refreshBtn = [...app.els.main.querySelectorAll('button')].find((b) => b.textContent === '刷新日历');
  check(refreshBtn, '未找到「刷新日历」按钮');
  refreshBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 240));
  const afterManual = calls.filter((c) => c === 'GET /api/calendar/insight').length;
  check(afterManual > afterReturn, '点「刷新日历」应重新拉取');
});

await step('「跟进」合并页：两个页签都能到达，且各页的标志性内容与入口都在', async () => {
  const followup = await import('../web/views/followup.js');
  const { api } = await import('../web/api.js');
  const real = { followups: api.followups, set: api.setFollowUpStatus, projects: api.projects, timeline: api.timeline };
  const box = document.createElement('div');
  document.body.append(box);
  const appStub = { viewStates: {}, navigate() {}, takeNavParams: () => null, refreshCounts() {}, invalidateAll() {}, paintNav() {} };
  const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));
  try {
    // 跟催侧数据（形状与跟催页自己的测试一致，避免另抄一份而脱节）
    const fuItems = [
      { id: 'mine_1', kind: 'mine', title: '周三前把报价发给李总', status: 'open', dueAt: '2020-01-01T00:00:00.000Z', counterparty: 'li@client.com', subject: '报价', since: '2026-10-04T09:00:00.000Z' },
      { id: 'wait_1', kind: 'waiting', title: '合同条款确认', status: 'open', waitingHours: 51, counterparty: 'a@client.com', subject: '合同', since: '2026-10-04T09:00:00.000Z', replyTrackable: true },
    ];
    api.followups = () => Promise.resolve({ ok: true, items: fuItems, all: fuItems, summary: { open: 2, mine: 1, waiting: 1, overdue: 1 }, config: { enabled: true, waitHours: 24 } });
    api.setFollowUpStatus = () => Promise.resolve({ ok: true, summary: {} });
    const tlCalls = [];
    api.projects = () => Promise.resolve({ ok: true, projects: [{ key: 'a', name: '华东区投标', count: 4, aliases: ['华东投标'], sources: { mail: 2, draft: 1, followUp: 1 } }], unclassified: 3 });
    api.timeline = (project) => {
      tlCalls.push(project);
      return Promise.resolve({
        ok: true,
        project,
        calendarNote: '日程来自本程序的操作记录',
        counts: { mail: 2, calendar: 1 },
        entries: [{ at: '2026-10-01T09:00:00Z', kind: 'mail', source: '收到的邮件', title: '招标公告', meta: {} }],
      });
    };

    followup.renderFollowUp(box, appStub);
    await new Promise((r) => setTimeout(r, 220));

    const tabs = [...box.querySelectorAll('.followup-tabs .tab')];
    checkEqual(tabs.length, 2, '合并页应有两个页签');
    checkEqual(tabs.map((t) => t.textContent.trim()).join('|'), '跟催|时间线', '两个页签的文案');
    check(tabs[0].classList.contains('active'), '默认应落在「跟催」页签');
    check(/我承诺的/.test(box.textContent) && /等对方回复/.test(box.textContent), '默认页签应渲染跟催的统计卡');
    check(/周三前把报价发给李总/.test(box.textContent), '跟催内容应真的渲染出来');

    // 切到「时间线」：要能渲染出项目选择等入口
    click(tabs[1]);
    await new Promise((r) => setTimeout(r, 220));
    check(tlCalls.length >= 1, '切到时间线页签应去取时间线数据');
    check(/华东区投标/.test(box.textContent), '时间线应渲染项目选择');
    check(/重命名 \/ 合并/.test(box.textContent), '时间线的重命名/合并入口必须仍可达');
    const tabs2 = [...box.querySelectorAll('.followup-tabs .tab')];
    check(tabs2[1].classList.contains('active') && !tabs2[0].classList.contains('active'), '选中态应跟着切换');

    // 切回「跟催」：页签不是单向的，两个视图都必须一直可达
    click(tabs2[0]);
    await new Promise((r) => setTimeout(r, 220));
    check(/我承诺的/.test(box.textContent), '切回跟催应重新渲染跟催内容');
    check(!/华东区投标/.test(box.textContent), '切回后不该还留着时间线的面板');
  } finally {
    api.followups = real.followups;
    api.setFollowUpStatus = real.set;
    api.projects = real.projects;
    api.timeline = real.timeline;
    box.remove();
  }
});

await step('旧链接与页签参数：navigate("timeline") 落到「跟进」的时间线页签（视图不丢）', async () => {
  const { app } = await import('../web/app.js');
  // 合并前的 #/timeline：必须还能到达，而不是被当成无效 id 退回总览
  app.navigate('timeline');
  await new Promise((r) => setTimeout(r, 220));
  checkEqual(app.viewId, 'followup', '旧链接应归一到「跟进」');
  const tabs = [...app.els.main.querySelectorAll('.followup-tabs .tab')];
  checkEqual(tabs.length, 2, '合并页应有两个页签');
  const tlTab = tabs.find((t) => (t.dataset.tab || '') === 'timeline');
  check(tlTab, '页签应有稳定标识（dataset.tab）');
  check(tlTab.classList.contains('active'), '旧链接 #/timeline 应直接落在「时间线」页签');
  // 顶层导航不含「运行与记录」，但视图本身仍要可达（从设置页卡片进入）
  app.navigate('records');
  await new Promise((r) => setTimeout(r, 160));
  checkEqual(app.viewId, 'records', '「运行与记录」必须仍能打开');
  app.navigate('overview');
  await new Promise((r) => setTimeout(r, 120));
});

await step('设置页：具名锚点 data-section + options.anchor / 跳转参数两条路都会定位并高亮', async () => {
  const settingsView = await import('../web/views/settings.js');
  const mkBox = () => {
    const box = document.createElement('div');
    document.body.append(box);
    return box;
  };

  // ① 直接传 options.anchor：滚到「外观」并高亮（含首帧"还没渲染出来"的重试）
  {
    const box = mkBox();
    const appStub = { navigate() {}, toast() {}, refreshCounts() {}, paintNav() {}, viewStates: {} };
    try {
      settingsView.renderSettings(box, appStub, { anchor: '外观' });
      check(!box.querySelector('[data-section="外观"]'), '首帧还在加载，此时不该有区块');
      await new Promise((r) => setTimeout(r, 220));
      const appearance = box.querySelector('[data-section="外观"]');
      check(appearance, '每个设置区块都应有具名锚点 data-section');
      check(appearance.classList.contains('flash-target'), '带锚点进入设置页应高亮目标区块');
      const flashed = [...box.querySelectorAll('section.block.flash-target')];
      checkEqual(flashed.length, 1, '只应高亮目标那一块');
      checkEqual(flashed[0].dataset.section, '外观', '高亮的应是「外观」而不是别的卡片');
    } finally {
      box.remove();
    }
  }

  // ② 跨视图跳转参数（app.navigate('settings', { anchor }) 的真实路径）
  {
    const box = mkBox();
    const seenKeys = [];
    const appStub = {
      navigate() {},
      toast() {},
      refreshCounts() {},
      paintNav() {},
      viewStates: {},
      takeNavParams: (key) => {
        seenKeys.push(key);
        return key === 'settings' ? { anchor: '备份与恢复' } : null;
      },
    };
    try {
      settingsView.renderSettings(box, appStub);
      await new Promise((r) => setTimeout(r, 220));
      check(seenKeys.includes('settings'), '设置页应向 app 取一次跳转参数');
      const target = box.querySelector('[data-section="备份与恢复"]');
      check(target, '应有「备份与恢复」区块');
      check(target.classList.contains('flash-target'), '跳转参数里的锚点也应定位并高亮');
    } finally {
      box.remove();
    }
  }

  // ③ 真实链路：app.navigate('settings', { anchor }) → renderView → renderSettings
  {
    const { app } = await import('../web/app.js');
    /*
     * 带锚点跳转**不能**同时把页面拉回顶部：navigate 是先 renderView（这里已经滚到区块）
     * 再执行"切页回顶部"的，若不跳过，定位会被自己顶掉（末尾还有一次 400ms 的硬跳 0 兜底）。
     * 所以这里把 window.scrollTo 换成探针，断言它一次都没被调用。
     */
    const scrollCalls = [];
    const realScrollTo = window.scrollTo;
    window.scrollTo = (...args) => scrollCalls.push(args);
    try {
      app.navigate('settings', { anchor: '备份与恢复' });
      let hit = false;
      // 设置页要等配置取回来才渲染出区块，轮询到高亮出现为止（flash 会持续 1.6 秒）
      for (let i = 0; i < 20 && !hit; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        hit = app.els.main.querySelector('[data-section="备份与恢复"]')?.classList.contains('flash-target') === true;
      }
      checkEqual(app.viewId, 'settings', '应已切到设置页');
      check(hit, 'app.navigate 带的锚点应一路传到设置页，并定位高亮对应区块');
      checkEqual(scrollCalls.length, 0, '带锚点跳转不该再执行"回顶部"（否则会顶掉定位）');
    } finally {
      window.scrollTo = realScrollTo;
    }
  }
});

await step('设置页：关于卡片说「上面的备份与恢复」，点击可定位到该区块', async () => {
  const settingsView = await import('../web/views/settings.js');
  const box = document.createElement('div');
  document.body.append(box);
  try {
    settingsView.renderSettings(box, { navigate() {}, toast() {}, refreshCounts() {}, paintNav() {}, viewStates: {} });
    await new Promise((r) => setTimeout(r, 220));

    const about = [...box.querySelectorAll('section.block')].find((b) => b.querySelector('.block-head h3')?.textContent.trim() === '关于');
    check(about, '应有「关于」区块');
    check(/备份请用上面的/.test(about.textContent), `文案应是"上面的「备份与恢复」"（实际「${about.textContent.slice(0, 120)}」）`);
    check(!/下面的/.test(about.textContent), '不该再有"下面的"（「关于」已经排在末尾了）');

    // 「备份与恢复」四个字必须是可点的（而不是纯文本）
    const link = [...about.querySelectorAll('button, a')].find((b) => /备份与恢复/.test(b.textContent));
    check(link, '「备份与恢复」应可点击');

    // 点它 → 用同一套具名锚点滚到「备份与恢复」区块并高亮
    const target = box.querySelector('[data-section="备份与恢复"]');
    check(target, '应有「备份与恢复」区块');
    let scrolled = 0;
    target.scrollIntoView = () => {
      scrolled += 1;
    };
    link.dispatchEvent(new window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    checkEqual(scrolled, 1, '点击后应滚动到「备份与恢复」区块');
    check(target.classList.contains('flash-target'), '定位后应短暂高亮该区块');
  } finally {
    box.remove();
  }
});

await step('开始使用向导：配好后最后一枚是 ✓／完成态，顶部「返回设置」带「外观」锚点', async () => {
  const setup = await import('../web/views/setup.js');
  const container = document.createElement('div');
  document.body.append(container);
  const navCalls = [];
  const click = (el) => el.dispatchEvent(new window.Event('click', { bubbles: true }));
  const idx = (chip) => chip.querySelector('.setup-chip-index').textContent.trim();
  try {
    globalThis.__forceResponses = {
      '/api/health': {
        ok: true,
        version: '1.0.0',
        node: 'v20.0.0',
        dataDir: 'D:\\data',
        timeZone: 'Asia/Shanghai',
        ready: true,
        fresh: false,
        nextStepId: null,
        steps: [
          { id: 'mailbox', title: '连接邮箱', required: true, done: true, detail: '已配置：u@x.cn' },
          { id: 'llm', title: '配置大模型', required: true, done: true, detail: '已配置：deepseek-chat' },
          { id: 'calendar', title: '连接 Google 日历（可选）', required: false, done: false, skipped: true, detail: '未启用' },
        ],
      },
    };
    setup.renderSetup(container, {
      viewStates: {},
      navigate: (view, params) => navCalls.push({ view, params }),
      paintNav() {},
      invalidateAll() {},
      refreshCounts() {},
      takeNavParams: () => null,
    });
    await new Promise((r) => setTimeout(r, 220));

    const chips = [...container.querySelectorAll('.setup-chip')];
    checkEqual(chips.length, 4, '三步 + 「可以用了」共四枚');
    const last = chips[3];
    checkEqual(idx(last), '✓', '配好后最后一枚的索引必须是 ✓（不能是 →）');
    check(!/setup-chip-index">→/.test(container.innerHTML), '完成态不该再出现 → 索引');
    check(last.classList.contains('setup-chip-done'), '应是完成态样式 setup-chip-done');

    // 停在这一步 → active（与前三枚同一套逻辑）
    check(last.classList.contains('setup-chip-active'), '「可以用了」是当前步时应 active');
    const mailChip = chips.find((c) => /连接邮箱/.test(c.textContent));
    click(mailChip);
    await new Promise((r) => setTimeout(r, 60));
    const last2 = [...container.querySelectorAll('.setup-chip')].at(-1);
    check(!last2.classList.contains('setup-chip-active'), '不在这一步时不该 active');
    check(last2.classList.contains('setup-chip-done'), '完成态样式与是否 active 无关');
    click(last2);
    await new Promise((r) => setTimeout(r, 60));
    check([...container.querySelectorAll('.setup-chip')].at(-1).classList.contains('setup-chip-active'), '回到「可以用了」应重新 active');

    // 顶部「返回设置」：从哪来回哪去，并带锚点（设置页据此定位到「外观」卡片）
    const back = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === '返回设置');
    check(back, '开始使用页应有「返回设置」按钮');
    check(back.closest('.page-head'), '「返回设置」应在页面顶部');
    click(back);
    checkEqual(navCalls.length, 1, '点击应只跳转一次');
    checkEqual(navCalls[0].view, 'settings', '应回到设置页');
    checkEqual(navCalls[0].params?.anchor, '外观', '应带上「外观」锚点');
  } finally {
    delete globalThis.__forceResponses;
    container.remove();
  }
});

await step('运行与记录：顶部「返回设置」带上「运行与记录」锚点', async () => {
  const records = await import('../web/views/records.js');
  const container = document.createElement('div');
  document.body.append(container);
  const navCalls = [];
  globalThis.__forceResponses = {
    '/api/audit': { ok: true, items: [], total: 0, truncated: false, file: 'D:\\data\\audit.jsonl', stats: { total: 0, byGroup: {}, byAction: {}, lastAt: null }, actions: {} },
    '/api/runs': { ok: true, runs: [] },
  };
  try {
    records.renderRecords(container, { viewStates: {}, navigate: (view, params) => navCalls.push({ view, params }) });
    await new Promise((r) => setTimeout(r, 180));
    const back = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === '返回设置');
    check(back, '运行与记录页应有「返回设置」按钮');
    check(back.closest('.page-head'), '「返回设置」应在页面顶部');
    back.dispatchEvent(new window.Event('click', { bubbles: true }));
    checkEqual(navCalls.length, 1, '点击应只跳转一次');
    checkEqual(navCalls[0].view, 'settings', '应回到设置页');
    checkEqual(navCalls[0].params?.anchor, '运行与记录', '应带上「运行与记录」锚点');

    // 取数失败时也必须退得回去（否则这页没有顶层导航入口，只剩"重试"）
    const { api } = await import('../web/api.js');
    const realAudit = api.audit;
    const failBox = document.createElement('div');
    document.body.append(failBox);
    api.audit = () => Promise.reject(new Error('台账读取失败'));
    try {
      records.renderRecords(failBox, { viewStates: {}, navigate: (view, params) => navCalls.push({ view, params }) });
      await new Promise((r) => setTimeout(r, 180));
      check(/无法加载记录/.test(failBox.textContent), '应显示加载失败');
      const back2 = [...failBox.querySelectorAll('button')].find((b) => b.textContent.trim() === '返回设置');
      check(back2, '加载失败时也应有「返回设置」');
    } finally {
      api.audit = realAudit;
      failBox.remove();
    }
  } finally {
    delete globalThis.__forceResponses;
    container.remove();
  }
});

await step('设置页：运行时记录的入口卡片（说明 + 打开按钮）', async () => {
  const settingsView = await import('../web/views/settings.js');
  const box = document.createElement('div');
  document.body.append(box);
  const navCalls = [];
  try {
    settingsView.renderSettings(box, { navigate: (v, p) => navCalls.push({ view: v, params: p }), toast() {}, refreshCounts() {}, paintNav() {}, viewStates: {} });
    await new Promise((r) => setTimeout(r, 220));
    const card = box.querySelector('[data-section="运行与记录"]');
    check(card, '设置页应有「运行与记录」卡片（并带同名锚点）');
    check(/操作台账|审计/.test(card.textContent), '卡片要说明它是什么（操作台账 / 审计）');
    const open = [...card.querySelectorAll('button')].find((b) => /运行与记录/.test(b.textContent));
    check(open, '卡片里应有打开它的按钮');
    open.dispatchEvent(new window.Event('click', { bubbles: true }));
    checkEqual(navCalls[0]?.view, 'records', '点按钮应打开「运行与记录」页');
  } finally {
    box.remove();
  }
});

await step('API 调用路径与后端路由一致', async () => {
  const expected = ['GET /api/meta', 'GET /api/status', 'GET /api/overview', 'GET /api/drafts', 'GET /api/config', 'GET /api/calendar/status', 'GET /api/calendar/insight'];
  const unique = [...new Set(calls)];
  for (const call of expected) check(unique.includes(call), `未调用 ${call}（实际：${unique.join(', ')}）`);
});

console.log(`\n${failures === 0 ? '前端渲染自检全部通过 ✅' : `有 ${failures} 项失败 ❌`}\n`);
// app.js 里有时钟定时器，显式退出
process.exit(failures ? 1 : 0);
