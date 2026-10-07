/**
 * 端到端冒烟：真实 HTTP 服务 + 模拟邮箱/模型，走完整 Web 使用路径。
 * 与 selftest 互补：这里验证的是「界面会调用的那组 API」。
 *
 *   node test/smoke-e2e.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from './lib/tmp.js';
import { failureText, installFetchDiagnostics } from './lib/http.js';

// 让本套件里每一处 fetch 失败时都带上确切 URL 与完整 cause 链（只加证据，不改判定）
installFetchDiagnostics();

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const tmpDir = makeTempDir('mailbot-smoke-');
process.env.MAILBOT_DATA_DIR = tmpDir;
process.env.MAILBOT_LOG_LEVEL = 'warn';
// 隔离本机 .env：否则真实凭据会覆盖测试配置
process.env.MAILBOT_NO_DOTENV = '1';
delete process.env.DEEPSEEK_API_KEY;

const mocks = await import('./mocks.js');
const { loadConfig, resetConfigCache, getConfig } = await import('../server/config/index.js');
const { startServer } = await import('../server/index.js');

const imap = await mocks.startMockImap({
  messages: [
    {
      uid: 11,
      raw: mocks.makeRawMail({
        subject: '请确认周五的交付计划',
        from: { name: '客户张总', address: 'boss@client.com' },
        body: '麻烦确认周五能否交付，并回复具体时间。',
        messageId: '<smoke-1@client.com>',
        // 真实来信通常本身就在一条会话里，用它验证线程头透传
        inReplyTo: '<smoke-thread@client.com>',
        references: ['<smoke-thread@client.com>'],
      }),
      flags: [],
      internalDate: new Date().toUTCString(),
    },
    {
      uid: 12,
      raw: mocks.makeRawMail({
        subject: '月度账单通知（无需回复）',
        from: { name: '账单系统', address: 'billing@system.com' },
        body: '你的账单已生成，无需回复。',
        messageId: '<smoke-2@system.com>',
      }),
      flags: [],
      internalDate: new Date().toUTCString(),
    },
  ],
});
const smtp = await mocks.startMockSmtp();
const llm = await mocks.startMockLlm({
  handler: (kind, prompt) => {
    if (kind === 'classify') {
      const count = (prompt.match(/^#\d+$/gm) || []).length || 1;
      const subjects = [...prompt.matchAll(/^主题：(.*)$/gm)].map((m) => m[1]);
      return JSON.stringify({
        items: Array.from({ length: count }, (_v, i) => {
          const notice = /账单|通知|无需回复/.test(subjects[i] || '');
          return {
            index: i + 1,
            type: notice ? 'notification' : 'action_required',
            priority: notice ? 'low' : 'urgent',
            needsReply: !notice,
            summary: notice ? '账单系统自动通知。' : '客户要求确认周五交付时间。',
            actions: notice ? [] : ['确认交付时间', '回复客户'],
            language: 'zh',
            reason: notice ? '自动通知，无需回复。' : '对方明确要求回复。',
          };
        }),
      });
    }
    if (kind === 'draft') {
      return JSON.stringify({
        subject: 'Re: 请确认周五的交付计划',
        body: '张总您好，\n\n周五可以交付，我会在周四下班前把最终版本发您确认。\n\n王磊',
        reason: '客户要求确认时间，给出明确承诺。',
        notes: ['请确认周四能否完成内部评审'],
        language: 'zh',
        confidence: 0.8,
      });
    }
    if (kind === 'qa') {
      return JSON.stringify({
        answer: '有 1 封需要你回复：客户张总要求确认周五交付时间。',
        evidence: [{ subject: '请确认周五的交付计划', from: 'boss@client.com', date: new Date().toISOString(), quote: '麻烦确认周五能否交付' }],
        confidence: 0.9,
        insufficient: false,
      });
    }
    return JSON.stringify({ markdown: '## 一句话总结\n客户在等周五交付的确认。' });
  },
});

resetConfigCache();
loadConfig({ rootDir: root, force: true });
const cfg = getConfig();
cfg.instances = [
  {
    id: 'smoke',
    label: '冒烟邮箱',
    imap: { host: '127.0.0.1', port: imap.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    smtp: { host: '127.0.0.1', port: smtp.port, secure: false, authUser: 'bot@example.com', authPass: 'secret' },
    identity: { name: '王磊', email: 'bot@example.com' },
  },
];
cfg.defaultInstanceId = 'smoke';
cfg.llm = { ...cfg.llm, baseUrl: llm.baseUrl, apiKey: 'k', model: 'mock', maxRetries: 1 };
// 配置签名与引文：这两项会改变草稿正文的结构，必须纳入端到端流程一起验证
// （签名首行用「王磊」，正好覆盖「模型末尾只写了姓名 → 升级为完整签名」这条路径）
cfg.draft = {
  ...cfg.draft,
  saveToMailbox: true,
  maxDrafts: 5,
  signature: '王磊 | 客户成功部\n移动电话：13800000000\n安全提示：公司不会通过邮件索要密码',
  quoteOriginal: true,
  quoteStyle: 'zh-client',
  quoteMaxChars: 2000,
};
cfg.web = { ...cfg.web, authToken: 'smoke-token', allowSend: true };

const { server, url } = await startServer({ rootDir: root, port: 0, host: '127.0.0.1' });
const H = { 'x-mailbot-token': 'smoke-token', 'content-type': 'application/json' };
let failures = 0;

const step = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failures += 1;
    // 同样带上 cause 链与确切 URL（诊断层补的 err.diagnostic）；判定没有放宽
    console.log(`  ✗ ${name}\n      ${err?.message || err}${failureText(err)}`);
  }
};
const check = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`\n端到端冒烟（真实 HTTP + 模拟邮箱）\n服务地址：${url}\n`);

await step('静态资源：首页/样式/入口脚本', async () => {
  const html = await fetch(`${url}/`);
  check(html.status === 200, `首页 HTTP ${html.status}`);
  const text = await html.text();
  check(text.includes('邮箱与日历数字人'), '首页缺少标题');
  const css = await fetch(`${url}/styles.css`);
  check(css.status === 200, 'styles.css 不可访问');
  const js = await fetch(`${url}/app.js`);
  check(js.status === 200, 'app.js 不可访问');
  return '3 个资源均 200';
});

await step('GET /api/meta：预设、主题、密钥来源', async () => {
  const meta = await (await fetch(`${url}/api/meta`, { headers: H })).json();
  check(meta.ok, 'meta 未返回 ok');
  check(meta.presets.length >= 6, '服务商预设过少');
  check(meta.topics.length > 0, '缺少主题定义');
  return `${meta.presets.length} 个预设 / ${meta.topics.length} 个主题`;
});

await step('POST /api/runs：分析近 24 小时邮件', async () => {
  const res = await (await fetch(`${url}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ trigger: 'smoke' }) })).json();
  check(res.ok, `运行失败：${res.message}`);
  check(res.result.analyzed === 2, `分析数量应为 2，实际 ${res.result.analyzed}`);
  check(res.result.needsReply === 1, `需回复应为 1，实际 ${res.result.needsReply}`);
  check(res.result.drafts === 1, `草稿应为 1，实际 ${res.result.drafts}`);
  return `${res.result.analyzed} 封 / 需回复 ${res.result.needsReply} / 草稿 ${res.result.drafts}`;
});

await step('GET /api/overview：总览统计与待处理清单', async () => {
  const d = await (await fetch(`${url}/api/overview`, { headers: H })).json();
  check(d.stats.total === 2, 'total 不正确');
  check(d.stats.needsReply === 1, 'needsReply 不正确');
  check(d.stats.drafts.pending === 1, 'pending 草稿不正确');
  check(d.needAction.length === 1, '待处理清单不正确');
  check(d.report?.markdown?.includes('一句话总结'), '未返回简报');
  return `紧急 ${d.stats.urgent} / 待处理 ${d.needAction.length}`;
});

await step('GET /api/knowledge 与 POST /api/knowledge/ask', async () => {
  const kb = await (await fetch(`${url}/api/knowledge`, { headers: H })).json();
  check(kb.entries.length === 2, '知识库条目数不正确');
  check(kb.keyFacts.needsReply === 1, '知识库 needsReply 不正确');
  const ask = await (
    await fetch(`${url}/api/knowledge/ask`, { method: 'POST', headers: H, body: JSON.stringify({ question: '需要我回复什么？' }) })
  ).json();
  check(ask.ok && ask.answer, '问答未返回答案');
  return `条目 ${kb.entries.length} / 答案 ${ask.answer.slice(0, 20)}…`;
});

let draftId = null;
await step('GET /api/drafts 并 PATCH 修改草稿', async () => {
  const list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  check(list.drafts.length === 1, '草稿列表不正确');
  draftId = list.drafts[0].id;
  const patch = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(draftId)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ body: `${list.drafts[0].body}\n（人工补充一句）` }),
    })
  ).json();
  check(patch.ok, '修改失败');
  check(patch.draft.body.includes('人工补充一句'), '正文未更新');
  return draftId;
});

await step('POST /api/drafts/:id/sync：写入邮箱草稿箱', async () => {
  const before = imap.store.appended.length;
  const res = await (await fetch(`${url}/api/drafts/${encodeURIComponent(draftId)}/sync`, { method: 'POST', headers: H, body: '{}' })).json();
  check(res.ok, `同步失败：${res.message}`);
  check(imap.store.appended.length === before + 1, '服务器未收到草稿');
  return `已写入 ${res.mailbox?.folder}`;
});

await step('POST /api/drafts/:id/regenerate：让 AI 重写', async () => {
  const res = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(draftId)}/regenerate`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ instruction: '更简短' }),
    })
  ).json();
  check(res.ok, `重写失败：${res.message}`);
  check(res.draft.body.length > 0, '重写后正文为空');
  return `新正文 ${res.draft.body.length} 字`;
});

await step('POST /api/drafts/:id/send：确认后发送', async () => {
  const noConfirm = await fetch(`${url}/api/drafts/${encodeURIComponent(draftId)}/send`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({}),
  });
  check(noConfirm.status === 428, `未确认时应 428，实际 ${noConfirm.status}`);

  const before = smtp.received.length;
  const res = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(draftId)}/send`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ confirm: true, deleteMailboxDraft: true, appendToSent: true }),
    })
  ).json();
  check(res.ok, `发送失败：${res.message}`);
  check(smtp.received.length === before + 1, 'SMTP 未收到邮件');
  check(res.draft.status === 'sent', '草稿状态未变为 sent');
  const raw = smtp.received[smtp.received.length - 1].raw;
  const draftInfo = await (await fetch(`${url}/api/drafts/${encodeURIComponent(draftId)}`, { headers: H })).json();
  check(
    raw.includes('In-Reply-To: <smoke-thread@client.com>'),
    `发送内容缺少线程头（draft.source.inReplyTo=${JSON.stringify(draftInfo.draft.source?.inReplyTo)}）`,
  );
  check(raw.includes('References: <smoke-thread@client.com> <smoke-1@client.com>'), '发送内容缺少 References 链');

  // 发送时间的时区：Date 头必须带 +0800，否则 Foxmail 等客户端会显示成 UTC 时间
  const dateLine = String(raw).split(/\r?\n/).find((l) => l.startsWith('Date: '));
  check(dateLine, '发送内容缺少 Date 头');
  const tz = getConfig().calendar?.timeZone || 'Asia/Shanghai';
  check(
    dateLine.endsWith('+0800') || (tz !== 'Asia/Shanghai' && /[+-]\d{4}$/.test(dateLine)),
    `Date 头应带数字时区偏移而不是 GMT（实际「${dateLine}」）`,
  );
  check(!dateLine.includes('GMT'), `Date 头不应是 GMT（实际「${dateLine}」）`);
  check(!raw.includes('Date: ') || /\d{2}:\d{2}:\d{2} [+-]\d{4}/.test(dateLine), 'Date 头应含具体时刻与偏移');
  return `已发送至 ${res.draft.to}（Date: ${dateLine.replace('Date: ', '')}）`;
});

await step('GET /api/mails/:folder/:uid：单封邮件详情（不受 24 小时窗口限制）', async () => {
  const detail = await (await fetch(`${url}/api/mails/INBOX/11`, { headers: H })).json();
  check(detail.ok, '详情接口未返回 ok');
  check(detail.found === true, '应找到已分析的邮件');
  check(detail.analyzed === true, '应标记为已分析');
  check(detail.analysis?.summary, '缺少 AI 要点');
  check(detail.mail?.subject === '请确认周五的交付计划', '缺少邮件主题');
  check(detail.draft?.status === 'sent', '应带上已发送的关联草稿');

  const missing = await (await fetch(`${url}/api/mails/INBOX/999999`, { headers: H })).json();
  check(missing.found === false, '不存在的邮件应返回 found:false 而不是报错');
  check(String(missing.note).includes('立即分析这一封'), '应给出可执行的下一步');
  return `已分析详情 + 缺失兜底`;
});

await step('重复分析：已发送的邮件不再生成待审核草稿，总览标为「已发送」', async () => {
  const res = await (await fetch(`${url}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ trigger: 'smoke-again' }) })).json();
  check(res.ok, `再次运行失败：${res.message}`);
  check(res.result.drafts === 0, `已有草稿的邮件不应再起草，实际 ${res.result.drafts}`);
  check(res.result.skippedDrafts === 1, `应报告跳过 1 封，实际 ${res.result.skippedDrafts}`);

  const list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  check(list.drafts.length === 1, `草稿总数不应变化，实际 ${list.drafts.length}`);
  check(list.drafts[0].status === 'sent', '已发送状态不能被降级回待审核');

  const d = await (await fetch(`${url}/api/overview`, { headers: H })).json();
  check(d.stats.drafts.pending === 0, '不应有新的待审核草稿');
  check(d.stats.drafts.sent === 1, '应有 1 封已发送草稿');
  const item = d.needAction[0];
  check(item.draftStatus === 'sent', `总览应给出 draftStatus=sent，实际 ${item.draftStatus}`);
  check(item.draftId === draftId, '总览应带上草稿 id 以便界面直达');
  return `跳过 ${res.result.skippedDrafts} 封 / 待审核 0`;
});

await step('GET /api/reports 与简报详情', async () => {
  const list = await (await fetch(`${url}/api/reports`, { headers: H })).json();
  check(list.reports.length >= 1, '没有简报记录');
  const one = await (await fetch(`${url}/api/reports/${list.reports[0].id}`, { headers: H })).json();
  check(one.markdown.includes('一句话总结'), '简报内容不完整');
  return one.report.file;
});

/* ------------------------------------------------------------------
 * 端到端全流程：窗口一致性 / 预检 / 引文与签名 / 草稿箱替换 / 联动字段
 * 这一段专门覆盖「界面展示必须与所选时间窗口同一口径」这条约束。
 * ------------------------------------------------------------------ */

await step('GET /api/runs/preview：只读预检，不调用模型且不写数据', async () => {
  const llmBefore = llm.calls.length;
  const p = await (await fetch(`${url}/api/runs/preview?windowHours=168`, { headers: H })).json();
  check(p.ok, `预检失败：${p.message}`);
  check(p.windowHours === 168, `窗口应为 168，实际 ${p.windowHours}`);
  check(p.windowLabel === '最近 7 天', `窗口描述应为「最近 7 天」，实际「${p.windowLabel}」`);
  check(p.limit === 420, `7 天的取信上限应为 420，实际 ${p.limit}`);
  check(Array.isArray(p.folders) && p.folders.length > 0, '应按文件夹给出命中数');
  check(typeof p.matched === 'number' && p.matched >= 2, `应统计出邮件数，实际 ${p.matched}`);
  check(p.taken <= p.limit, '取数不应超过上限');
  check(llm.calls.length === llmBefore, '预检绝不能调用模型（否则失去"零成本预览"的意义）');

  // 非法窗口要被限幅，而不是把奇怪的值传给 IMAP
  const huge = await (await fetch(`${url}/api/runs/preview?windowHours=99999`, { headers: H })).json();
  check(huge.windowHours === 720, `超过 30 天应限幅到 720，实际 ${huge.windowHours}`);
  return `7 天命中 ${p.matched} 封 / 上限 ${p.limit}`;
});

await step('总览简报与窗口一致：切窗口不会串味（这次修的核心问题）', async () => {
  // 先用默认 24 小时跑一次，生成 24 小时口径的简报
  const run24 = await (await fetch(`${url}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ trigger: 'smoke-24h', windowHours: 24 }) })).json();
  check(run24.ok, `24 小时分析失败：${run24.message}`);
  check(run24.result.windowHours === 24, '应记录 24 小时窗口');
  check(run24.result.windowLabel === '最近 24 小时', `窗口描述不对：${run24.result.windowLabel}`);

  const d24 = await (await fetch(`${url}/api/overview?hours=24`, { headers: H })).json();
  check(d24.windowHours === 24, '总览应回显窗口 24');
  check(d24.report?.windowHours === 24, `24 小时窗口应返回 24 小时的简报，实际 ${d24.report?.windowHours}`);
  check(d24.report?.markdown?.includes('最近 24 小时'), '简报正文里的统计窗口应是「最近 24 小时」');
  check(d24.latestReport?.isCurrentWindow === true, '应标记为当前窗口的简报');

  // 切到 7 天：**不能**再把 24 小时的简报当成 7 天的展示（用户截图里的矛盾）
  const d7 = await (await fetch(`${url}/api/overview?hours=168`, { headers: H })).json();
  check(d7.windowHours === 168, '总览应回显窗口 168');
  check(d7.report === null, '7 天窗口还没有简报时 report 必须为 null（否则会出现"最近 7 天"配"近 24 小时"的矛盾）');
  check(d7.latestReport?.windowHours === 24, '应带上"最近一次简报针对 24 小时"的提示信息');
  check(d7.latestReport?.isCurrentWindow === false, '不应标记为当前窗口');
  return `24h 简报匹配正确；切到 7 天时 report=null 且提示指向 24h`;
});

await step('按窗口分析 7 天：生成 7 天简报后，24 小时与 7 天各自独立', async () => {
  const run7 = await (await fetch(`${url}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ trigger: 'smoke-7d', windowHours: 168 }) })).json();
  check(run7.ok, `7 天分析失败：${run7.message}`);
  check(run7.result.windowHours === 168, '应记录 168 小时窗口');

  const d7 = await (await fetch(`${url}/api/overview?hours=168`, { headers: H })).json();
  check(d7.report?.windowHours === 168, '现在应有 7 天的简报');
  check(d7.report?.markdown?.includes('最近 7 天'), '7 天简报正文的统计窗口应是「最近 7 天」');

  const d24 = await (await fetch(`${url}/api/overview?hours=24`, { headers: H })).json();
  check(d24.report?.windowHours === 24, '24 小时窗口仍应取到自己的简报，而不是被 7 天的覆盖');
  check(d24.report?.markdown?.includes('最近 24 小时'), '24 小时简报内容不能被换掉');
  return `两个窗口各有独立简报（24h / 7d 互不覆盖）`;
});

await step('回复正文：引文与签名顺序正确，且位置错乱可一键自愈', async () => {
  // 前一封已发送。按「删除草稿后重新分析会重新起草」的既有行为，
  // 删掉它再单独分析 UID 11，就能拿到一封**带引文 + 签名**的待审核草稿。
  const list0 = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  const sent = list0.drafts.find((x) => x.status === 'sent');
  check(sent, '前置条件：应有已发送草稿');
  check(sent.quoted === true, '已发送的草稿也应报告 quoted=true');
  const del = await (await fetch(`${url}/api/drafts/${encodeURIComponent(sent.id)}`, { method: 'DELETE', headers: H })).json();
  check(del.ok, `删除草稿失败：${del.message}`);

  const run = await (
    await fetch(`${url}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ trigger: 'smoke-quote', scope: { folder: 'INBOX', uid: 11 } }) })
  ).json();
  check(run.ok, `单封分析失败：${run.message}`);
  check(run.result.drafts === 1, `应重新起草 1 封，实际 ${run.result.drafts}`);

  let list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  let target = list.drafts.find((x) => x.status === 'pending');
  check(target, '应有待审核草稿');
  const signature = String(list.signature || '').trim().split('\n')[0];
  check(signature, '前置条件：应配置了签名（取首行用于定位）');

  // 1) 新起草的草稿：顺序必须是「新正文 → 签名 → 引文」
  check(target.hasSignature === true, '带签名的草稿必须报告 hasSignature=true（否则界面横幅会误报）');
  check(target.signatureMisplaced === false, '位置正确时不应报告 misplaced');
  check(target.quoted === true, '应报告已带引文');
  const body = String(target.body || '');
  const iSign = body.indexOf(signature);
  const iQuote = body.indexOf('------------------ 原始邮件');
  check(iSign >= 0, '正文里应有签名');
  check(iQuote >= 0, '正文里应有引文分隔线');
  check(iSign < iQuote, `签名必须在引文之前（签名 ${iSign} / 引文 ${iQuote}）`);

  // 2) 已合规时重复操作应被跳过，而不是插第二份
  const q1 = await (await fetch(`${url}/api/drafts/apply-quote`, { method: 'POST', headers: H, body: JSON.stringify({ ids: [target.id] }) })).json();
  check(q1.ok, 'apply-quote 失败');
  check(q1.applied.length === 0, `已带引文时不应重复插入，实际 applied=${q1.applied.length}`);
  check(q1.skipped.some((s) => s.reason === '已包含引文'), '应说明跳过原因');
  const s1 = await (await fetch(`${url}/api/drafts/apply-signature`, { method: 'POST', headers: H, body: JSON.stringify({ ids: [target.id] }) })).json();
  check(s1.ok, 'apply-signature 失败');
  check(s1.applied.length === 0, '签名已合规时不应改动正文');
  check(s1.skipped.some((s) => s.reason === '已包含当前签名'), '应说明跳过原因');

  // 3) 制造「签名被引文挤到下面」的坏状态（老草稿/手工编辑都可能长这样）
  const signBlock = String(list.signature).replace(/\r\n/g, '\n').trimEnd();
  const withoutSign = body.replace(signBlock, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  const patch = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(target.id)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ body: `${withoutSign}\n\n${signBlock}` }),
    })
  ).json();
  check(patch.ok, '构造坏顺序失败');

  let after = (await (await fetch(`${url}/api/drafts/${encodeURIComponent(target.id)}`, { headers: H })).json()).draft;
  check(after.hasSignature === false, '签名在引文之下时不应算「已带签名」（这正是横幅永远消不掉的原因）');
  check(after.signatureMisplaced === true, '应标记为签名位置不对');

  // 4) 一键补签名：必须真的把签名搬回引文之前，而不只是"报告已处理"
  const fix = await (await fetch(`${url}/api/drafts/apply-signature`, { method: 'POST', headers: H, body: JSON.stringify({ ids: [target.id] }) })).json();
  check(fix.ok, 'apply-signature 失败');
  check(fix.applied.length === 1, `应处理这封草稿，实际 ${JSON.stringify(fix)}`);
  check(fix.applied[0].mode === 'reordered', `应识别为「仅调整位置」，实际 ${fix.applied[0].mode}`);
  after = (await (await fetch(`${url}/api/drafts/${encodeURIComponent(target.id)}`, { headers: H })).json()).draft;
  check(after.hasSignature === true, '修复后必须报告 hasSignature=true（横幅才会消失）');
  check(after.signatureMisplaced === false, '修复后不应再报告位置问题');
  check(after.body.split(signBlock).length - 1 === 1, '修复后签名只应出现一次');
  check(after.body.indexOf(signBlock) < after.body.indexOf('------------------ 原始邮件'), '修复后签名应在引文之前');

  // 5) 完全没有签名时（例如换了签名配置），插入后仍必须在引文之前
  const stripped = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(target.id)}`, {
      method: 'PATCH',
      headers: H,
      body: JSON.stringify({ body: String(after.body).replace(signBlock, '').replace(/\n{3,}/g, '\n\n').trimEnd() }),
    })
  ).json();
  check(stripped.ok, '移除签名失败');
  const insert = await (await fetch(`${url}/api/drafts/apply-signature`, { method: 'POST', headers: H, body: JSON.stringify({ ids: [target.id] }) })).json();
  check(insert.applied.length === 1, '缺签名时应插入');
  check(insert.applied[0].mode !== 'reordered', '这种情况应是新增签名而不是搬位置');
  after = (await (await fetch(`${url}/api/drafts/${encodeURIComponent(target.id)}`, { headers: H })).json()).draft;
  check(after.hasSignature === true, '插入后应报告 hasSignature=true');
  check(after.body.indexOf(signBlock) < after.body.indexOf('------------------ 原始邮件'), '插入的签名也必须在引文之前');
  check(after.body.split(signBlock).length - 1 === 1, '签名仍只应出现一次');
  return `顺序正确；坏顺序自愈（reordered）；缺签名插入后仍在引文之前`;
});

await step('草稿箱同步：重复同步会替换旧副本，不留孤儿', async () => {
  const list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  const pending = list.drafts.find((x) => x.status === 'pending');
  check(pending, '前置条件：应有待审核草稿');
  const before = imap.store.appended.length;
  const first = await (await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}/sync`, { method: 'POST', headers: H, body: '{}' })).json();
  check(first.ok, `首次同步失败：${first.message}`);
  const firstUid = first.mailbox?.uid;
  check(firstUid, '应返回草稿箱 UID');

  const second = await (await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}/sync`, { method: 'POST', headers: H, body: '{}' })).json();
  check(second.ok, `二次同步失败：${second.message}`);
  check(second.mailbox?.uid !== firstUid, '应写入新的一份（IMAP 不能原地替换）');
  check(second.replaced?.uid === firstUid, `应报告替换掉了哪一份（实际 ${JSON.stringify(second.replaced)}）`);
  check(imap.store.appended.length === before + 2, '应恰好新增两封');
  check(
    imap.store.deleted.some((d) => Number(d.uid) === Number(firstUid)),
    `应删除旧副本 UID=${firstUid}（实际删除：${JSON.stringify(imap.store.deleted)}）`,
  );
  return `替换旧副本 UID ${firstUid} → ${second.mailbox.uid}`;
});

await step('草稿计数：切换筛选不改变计数（避免"待审核"看起来丢了）', async () => {
  const all = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  const sent = await (await fetch(`${url}/api/drafts?status=sent`, { headers: H })).json();
  check(all.counts && sent.counts, '两个请求都应返回 counts');
  check(all.counts.all === sent.counts.all, `筛选后的 counts 应保持全量口径（${all.counts.all} vs ${sent.counts.all}）`);
  check(all.counts.sent === sent.drafts.length, 'counts.sent 应等于已发送列表长度');
  check(all.counts.pending + all.counts.failed + all.counts.sent === all.counts.all, '三类之和应等于总数');
  check(sent.drafts.every((d) => d.status === 'sent'), '已发送筛选应只返回已发送');
  return `全部 ${all.counts.all} / 待审核 ${all.counts.pending} / 已发送 ${all.counts.sent}`;
});

await step('总览与草稿页口径一致：草稿计数不受回看窗口限制', async () => {
  // 把窗口缩到 1 小时：来信都在这之前，草稿计数仍必须与草稿页一致
  const d = await (await fetch(`${url}/api/overview?hours=1`, { headers: H })).json();
  const list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  check(d.stats.drafts.total === list.counts.all, `草稿总数应一致（总览 ${d.stats.drafts.total} vs 草稿页 ${list.counts.all}）`);
  check(d.stats.drafts.pending === list.counts.pending, '待审核数应一致');
  check(d.stats.drafts.sent === list.counts.sent, '已发送数应一致');
  check(d.stats.total <= 2, `1 小时窗口内的邮件应很少，实际 ${d.stats.total}`);
  return `窗口 1 小时：邮件 ${d.stats.total} 封，但草稿仍显示 ${d.stats.drafts.total} 封`;
});

await step('草稿附件：上传（原始字节）→ 下载核对 → 发送带 multipart/mixed → 越权被拒', async () => {
  const list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  check(list.attachmentMaxBytes > 0, '草稿接口应下发附件上限');
  check(list.maxAttachments >= 1, '草稿接口应下发附件数量上限');
  const pending = list.drafts.find((x) => x.status === 'pending');
  check(pending, '前置条件：应有待审核草稿');

  // 1) 上传：请求体就是文件原始字节，文件名走查询参数
  const csv = Buffer.from('姓名,金额\n张三,100\n', 'utf8');
  const up1 = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}/attachments?filename=${encodeURIComponent('对账单 2026-09.csv')}`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'text/csv' },
      body: csv,
    })
  ).json();
  check(up1.ok, `上传失败：${up1.message}`);
  check(up1.attachment?.id, '应返回附件 id');
  check(up1.attachment.size === csv.length, `记录的字节数应一致（${up1.attachment.size} vs ${csv.length}）`);
  check(up1.draft.attachments.length === 1, '草稿应带上 1 个附件');
  check(up1.budget && up1.budget.overBudget === false, '应返回体积预算且未超限');

  const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
  const up2 = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}/attachments?filename=${encodeURIComponent('../../恶意.png')}`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'image/png' },
      body: bin,
    })
  ).json();
  check(up2.ok, `第二个附件上传失败：${up2.message}`);
  check(up2.attachment.filename === '恶意.png', `文件名应去掉路径成分（实际 ${up2.attachment.filename}）`);

  // 2) 下载核对：字节必须完全一致
  const dl = await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}/attachments/${encodeURIComponent(up1.attachment.id)}`, { headers: H });
  check(dl.status === 200, `下载附件应 200，实际 ${dl.status}`);
  const got = Buffer.from(await dl.arrayBuffer());
  check(Buffer.compare(got, csv) === 0, '下载回来的字节必须与上传完全一致');
  check(String(dl.headers.get('content-disposition')).includes("filename*=UTF-8''"), '下载头应带 RFC 5987 编码名');

  // 3) 发送：报文必须是 multipart/mixed，收件侧能解析出正文与两个附件
  const before = smtp.received.length;
  const sent = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}/send`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ confirm: true, deleteMailboxDraft: true, appendToSent: false }),
    })
  ).json();
  check(sent.ok, `发送失败：${sent.message}`);
  check(smtp.received.length === before + 1, 'SMTP 应收到邮件');
  const raw = smtp.received[smtp.received.length - 1].raw;
  check(raw.includes('multipart/mixed'), '带附件的邮件应使用 multipart/mixed');
  const { parseMessage } = await import('../server/mail/parse.js');
  const parsed = await parseMessage(Buffer.from(raw, 'utf8'));
  check(parsed.attachments.length === 2, `收件侧应解析出 2 个附件（实际 ${parsed.attachments.length}）`);
  check(parsed.body.length > 0, '正文不能因为 MIME 层级变深而丢失');

  // 4) 发送成功后本地附件内容被清理，但元数据保留
  const after = await (await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}`, { headers: H })).json();
  check(after.draft.attachments.length === 2, '附件元数据应保留，便于回看发了什么');
  check(after.draft.attachmentsCleanedAt, '应记录附件清理时间');
  const gone = await fetch(`${url}/api/drafts/${encodeURIComponent(pending.id)}/attachments/${encodeURIComponent(up1.attachment.id)}`, { headers: H });
  check(gone.status === 410 || gone.status === 404, `清理后下载应 404/410，实际 ${gone.status}`);
  return `上传 2 个（含中文名与路径名）→ 下载一致 → multipart/mixed 发送 → 本地副本已清理`;
});

await step('草稿附件：已发送的草稿不能再改附件', async () => {
  const list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  const sentDraft = list.drafts.find((x) => x.status === 'sent');
  check(sentDraft, '前置条件：应有已发送草稿');
  const res = await fetch(`${url}/api/drafts/${encodeURIComponent(sentDraft.id)}/attachments?filename=x.txt`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'text/plain' },
    body: Buffer.from('x'),
  });
  check(res.status === 409, `已发送的草稿加附件应 409，实际 ${res.status}`);
  const body = await res.json();
  check(body.code === 'DRAFT_ALREADY_SENT', `错误码应是 DRAFT_ALREADY_SENT，实际 ${body.code}`);
  return '已发送草稿拒绝改附件（409）';
});

await step('附件体积：超过单封上限的文件上传被拒（413），且不留残留', async () => {
  const list = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  // 上一批已把 UID 11 的草稿发出去了；引擎不会为一封"已有草稿"的邮件再起草，
  // 所以先按既有行为删掉它，再单独分析一次拿到待审核草稿。
  for (const d of list.drafts) {
    if (d.status !== 'pending') await fetch(`${url}/api/drafts/${encodeURIComponent(d.id)}`, { method: 'DELETE', headers: H });
  }
  const run = await (
    await fetch(`${url}/api/runs`, { method: 'POST', headers: H, body: JSON.stringify({ trigger: 'smoke-att', scope: { folder: 'INBOX', uid: 11 } }) })
  ).json();
  check(run.ok, `重新起草失败：${run.message}`);
  check(run.result.drafts === 1, `应重新起草 1 封，实际 ${run.result.drafts}`);
  const drafts2 = await (await fetch(`${url}/api/drafts`, { headers: H })).json();
  const fresh = drafts2.drafts.find((x) => x.status === 'pending');
  check(fresh, '应有新的待审核草稿');

  // 构造一个超过上限的文件（上限来自服务端配置）
  const tooBig = Buffer.alloc(Math.min(list.attachmentMaxBytes + 1024, 25 * 1024 * 1024), 0x41);
  const res = await fetch(`${url}/api/drafts/${encodeURIComponent(fresh.id)}/attachments?filename=huge.bin`, {
    method: 'POST',
    headers: { ...H, 'content-type': 'application/octet-stream' },
    body: tooBig,
  });
  check(res.status === 413, `超过上限应 413，实际 ${res.status}`);
  const body = await res.json();
  check(
    ['ATTACHMENT_TOO_LARGE', 'BODY_TOO_LARGE'].includes(body.code),
    `错误码应是体积相关，实际 ${body.code}`,
  );
  // 被拒绝后草稿不应留下半个附件
  const after = await (await fetch(`${url}/api/drafts/${encodeURIComponent(fresh.id)}`, { headers: H })).json();
  check((after.draft.attachments || []).length === 0, '被拒绝的附件不应留下记录');

  // 正常大小的附件仍然可以上传（证明拒绝的是体积，不是功能坏了）
  const okUp = await (
    await fetch(`${url}/api/drafts/${encodeURIComponent(fresh.id)}/attachments?filename=小文件.txt`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'text/plain' },
      body: Buffer.from('小文件内容'),
    })
  ).json();
  check(okUp.ok && okUp.draft.attachments.length === 1, '正常大小的附件应能上传');

  // 收拾干净：删掉这封测试草稿（同时会清理它的附件文件）
  const del = await (await fetch(`${url}/api/drafts/${encodeURIComponent(fresh.id)}`, { method: 'DELETE', headers: H })).json();
  check(del.ok, '删除测试草稿失败');
  check(del.freedAttachments === 1, `删除草稿应同时清理附件文件（实际 ${del.freedAttachments}）`);
  return `上限 ${(list.attachmentMaxBytes / 1048576).toFixed(0)} MB：超限被拒且不留残留，正常附件仍可上传，删草稿会清理文件`;
});

await step('POST /api/diagnostics：对模拟服务自检', async () => {
  const res = await (await fetch(`${url}/api/diagnostics`, { method: 'POST', headers: H, body: JSON.stringify({ instanceId: 'smoke', deep: true }) })).json();
  const errors = res.result.checks.filter((c) => c.status === 'error');
  check(errors.length === 0, `自检失败项：${errors.map((e) => e.label).join(',')}`);
  return `${res.result.checks.length} 项检查通过`;
});

await step('PUT /api/config：保存配置且密钥不泄露', async () => {
  const current = await (await fetch(`${url}/api/config`, { headers: H })).json();
  check(current.config.instances[0].imap.authPass === '***', '接口未脱敏');
  current.config.scan.windowHours = 48;
  const saved = await (await fetch(`${url}/api/config`, { method: 'PUT', headers: H, body: JSON.stringify(current.config) })).json();
  check(saved.ok, '保存失败');
  check(saved.config.scan.windowHours === 48, '窗口未生效');
  check(saved.config.instances[0].imap.authPass === '***', '保存后密钥泄露');
  const raw = fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8');
  check(raw.includes('secret'), '磁盘上应保留真实授权码');
  check(!raw.includes('***'), '磁盘上不应出现掩码值');
  return '窗口 48h 已保存，密钥未泄露';
});

await step('鉴权：无令牌被拒绝，SSE 通道可建立', async () => {
  const unauth = await fetch(`${url}/api/overview`);
  check(unauth.status === 401, `无令牌应 401，实际 ${unauth.status}`);
  const controller = new AbortController();
  const sse = await fetch(`${url}/api/events?token=smoke-token`, { signal: controller.signal });
  check(sse.status === 200, 'SSE 未建立');
  const reader = sse.body.getReader();
  const { value } = await reader.read();
  check(Buffer.from(value).toString('utf8').includes('retry:'), 'SSE 首包异常');
  controller.abort();
  return '401 正常 / SSE 正常';
});

await new Promise((r) => server.close(r));
await imap.close();
await smtp.close();
await llm.close();

console.log(`\n${failures === 0 ? '端到端冒烟全部通过 ✅' : `有 ${failures} 项失败 ❌`}\n`);
process.exitCode = failures ? 1 : 0;
