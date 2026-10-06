/**
 * 洞察层：把已分析的结果整理成「24 小时总览」与「知识库」，
 * 并支持针对这些邮件提问（只依据邮件内容回答，不臆造）。
 */

import { getConfig, getInstance } from '../config/index.js';
import { hoursAgo, log, truncate } from '../lib/util.js';
import { LlmClient } from '../llm/client.js';
import { INJECTION_GUARD } from '../llm/prompts.js';
import { PRIORITY_LABELS, TYPE_LABELS, sortByPriority } from './analyze.js';
import { isCcAttention, isDirectAction, isWorthNoting } from '../mail/recipient.js';
import * as store from '../store/state.js';

/** 关键词主题分类，便于按主题检索。 */
export const TOPICS = [
  { id: 'project', label: '项目/需求', keywords: ['项目', '需求', '方案', '上线', '迭代', '进度', '里程碑', '排期', 'project', 'requirement'] },
  { id: 'client', label: '客户/商务', keywords: ['客户', '合同', '报价', '商务', '签约', '续约', '回款', '招标', 'client', 'contract', 'quotation'] },
  { id: 'finance', label: '财务/发票', keywords: ['发票', '付款', '报销', '预算', '账单', '结算', 'invoice', 'payment', 'reimburse'] },
  { id: 'hr', label: '人事/考勤', keywords: ['请假', '入职', '离职', '招聘', '考勤', '调休', '绩效', '社保', '公积金', '加班'] },
  { id: 'meeting', label: '会议/日程', keywords: ['会议', '邀请', '日程', '评审', '例会', 'meeting', 'invitation', 'calendar', 'zoom', 'teams'] },
  { id: 'tech', label: '技术/运维', keywords: ['故障', '告警', '部署', '发布', '服务器', '接口', 'bug', 'incident', 'alert', 'deploy'] },
  { id: 'approval', label: '审批/流程', keywords: ['审批', '申请', '工单', '流程', '签字', 'approval', 'request', 'ticket'] },
  { id: 'notice', label: '公告/通知', keywords: ['通知', '公告', '提醒', '变更', '维护', 'notice', 'announcement', 'reminder'] },
];

const DEADLINE_PATTERNS = [
  /(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*日?)/g,
  /(\d{1,2}\s*月\s*\d{1,2}\s*日)/g,
  /((?:本周|这周|下周|本月底|月底|季度末|明天|后天|今天)[一二三四五六日天]?)/g,
  /(\d{1,2}\s*(?:个)?工作日内)/g,
  /(by\s+[A-Z][a-z]{2,8}\.?\s*\d{1,2})/gi,
];

/* ------------------------------------------------------------ 总览 */

export function buildOverview({ instanceId, windowHours = 24 } = {}) {
  const config = getConfig();
  const id = instanceId || config.defaultInstanceId;
  const since = hoursAgo(windowHours);
  const all = store.listAnalyses({ instanceId: id, since, limit: 1000 });
  const prioritized = sortByPriority(all).map((a) => ({ ...a, mail: a.mail || {} }));
  // 「需要你处理」：直接发给我 + 高优先级 + 需回复
  const needsReplyRaw = prioritized.filter((a) => isDirectAction(a) && a.type !== 'spam');
  /*
   * 待办闭环：把「需要你处理」按待办状态拆开。
   *
   * 没有这一步，每次分析都会把已经处理过的邮件**再列一遍**——列表永远清不空，
   * 也就谈不上"闭环"。规则：
   *   - `open`（含没标记过的）：留在列表里；
   *   - `snoozed` 且**已到时间**：自动回到列表（"稍后提醒"到点就该出现）；
   *   - `done` / `ignored` / 未到时间的 `snoozed`：移出列表，但要能在对应分组里翻回去。
   */
  const nowMs = Date.now();
  const tasks = store.getState().tasks || {};
  const statusOf = (a) => {
    const t = tasks[a.key];
    if (!t || !t.status || t.status === 'open') return 'open';
    if (t.status === 'snoozed') {
      const due = t.snoozeUntil ? new Date(t.snoozeUntil).getTime() : 0;
      // 时间非法或已到期都当作"回到列表"，否则会永远躺在稍后里出不来
      return !due || due <= nowMs ? 'open' : 'snoozed';
    }
    return t.status;
  };
  const needsReply = needsReplyRaw.filter((a) => statusOf(a) === 'open');
  /*
   * 「需留意」：不需要回复，但有明确时限 / 需要亲自去办（到期提醒、待确认的会议…）。
   *
   * 为什么单列一类：塞进「需要你处理」会把那份"要你回信"的清单灌满，用户就再也不看了；
   * 塞进「值得知悉」又会被"看看就好"的内容淹掉——而那正是"别错过"的东西。
   */
  const worthNotingRaw = prioritized.filter((a) => isWorthNoting(a));
  const worthNoting = worthNotingRaw.filter((a) => statusOf(a) === 'open');
  const taskGroups = { done: [], snoozed: [], ignored: [] };
  // 已闭环分组要覆盖**两类**清单，否则从「需留意」里标记掉的条目就找不回来了
  for (const a of [...needsReplyRaw, ...worthNotingRaw]) {
    const st = statusOf(a);
    if (st !== 'open' && taskGroups[st]) taskGroups[st].push(a);
  }
  // 「需要你关注」：仅抄送我 + 高优先级（通常不该由我回复，但要看）
  const attention = prioritized.filter((a) => isCcAttention(a) && a.type !== 'spam');
  /*
   * 草稿统计**不受回看窗口限制**。
   *
   * 草稿是"待办"：一封昨天起草、还没发的邮件，不该因为它的来信时间掉出 24 小时窗口
   * 就从卡片上消失（曾经出现过卡片显示「待审核 0」而草稿页显示「待审核 1」的矛盾）。
   * 只有「值得知悉 / 需要你处理」这类**按邮件时间**的清单才应该跟着窗口走。
   */
  const drafts = store.listDrafts({ instanceId: id });

  const byType = {};
  const byPriority = {};
  for (const a of prioritized) {
    byType[a.type] = (byType[a.type] || 0) + 1;
    byPriority[a.priority] = (byPriority[a.priority] || 0) + 1;
  }

  const allActions = prioritized
    .filter((a) => a.actions?.length)
    .map((a) => ({
      subject: a.mail.subject,
      from: a.mail.from?.address || '',
      priority: a.priority,
      actions: a.actions,
      date: a.mail.date,
      folder: a.folder,
      uid: a.uid,
    }));

  const lastRun = store.lastRun({ instanceId: id });

  /*
   * 简报必须与请求的窗口**对应**，否则界面会出现自相矛盾的展示：
   * 标题写着「最近 7 天 / 95 封」，下面的「一句话总结」却是「近 24 小时 38 封邮件中…」
   * （因为那是上一次针对 24 小时跑出来的简报）。用户在切换窗口但还没点分析时就会看到这种矛盾。
   *
   * 所以：只把**窗口匹配**的最新简报作为 `report` 返回；
   * 另用 `latestReport` 带上"最近一次简报是针对哪个窗口的"，让界面能给出准确提示。
   */
  const reports = store.listReports(30).filter((r) => r.instanceId === id);
  const matching = reports.find((r) => Number(r.windowHours) === Number(windowHours)) || null;
  const latest = reports[0] || null;
  const readMarkdown = (rec) => {
    if (!rec) return null;
    try {
      return store.readReportFile(rec.file);
    } catch {
      return null;
    }
  };
  const reportMarkdown = readMarkdown(matching);

  return {
    instanceId: id,
    windowHours,
    generatedAt: new Date().toISOString(),
    lastRun,
    report: matching
      ? {
          id: matching.id,
          createdAt: matching.createdAt,
          windowHours: matching.windowHours ?? null,
          markdown: reportMarkdown,
          /*
           * 快照口径：简报是**那次分析时**写下的，而卡片/清单是**打开页面时**实时算的。
           * 两个数字会随着时间滑动而不一致（实测：简报写"共 11 封"，卡片显示 5 封）。
           * 所以把"当时窗口内多少封"一并带上，界面就能把这件事讲清楚，
           * 而不是让用户以为哪个数字算错了。
           */
          snapshot: {
            total: matching.total ?? matching.stats?.total ?? null,
            needsReply: matching.needsReply ?? matching.stats?.needsReply ?? null,
            analyzed: matching.analyzed ?? null,
          },
          /** 打开页面这一刻，同一个窗口里实际有多少封 */
          live: { total: prioritized.length, needsReply: needsReply.length },
        }
      : null,
    /** 最近一次简报（可能属于另一个窗口），供界面提示「上次简报针对最近 X」 */
    latestReport: latest
      ? {
          id: latest.id,
          createdAt: latest.createdAt,
          windowHours: latest.windowHours ?? null,
          isCurrentWindow: latest.id === matching?.id,
          total: latest.total ?? null,
          markdown: latest.id === matching?.id ? reportMarkdown : readMarkdown(latest),
        }
      : null,
    stats: {
      total: prioritized.length,
      /** 只数**尚未处理**的：徽标和"需要你处理"卡片都该是可清零的 */
      needsReply: needsReply.length,
      /** 已处理 / 稍后提醒 / 已忽略（不在上面那个数字里） */
      taskDone: taskGroups.done.length,
      taskSnoozed: taskGroups.snoozed.length,
      taskIgnored: taskGroups.ignored.length,
      /** 不需回复但有明确时限（单列，不混进 needsReply） */
      worthNoting: worthNoting.length,
      /** 仅抄送我且高优先级的邮件数 */
      attention: attention.length,
      urgent: prioritized.filter((a) => a.priority === 'urgent').length,
      high: prioritized.filter((a) => a.priority === 'high').length,
      withAttachments: prioritized.filter((a) => a.mail.hasAttachments).length,
      byType,
      byPriority,
      byRecipient: {
        direct: prioritized.filter((a) => a.recipientKind === 'direct').length,
        cc: prioritized.filter((a) => a.recipientKind === 'cc').length,
        self: prioritized.filter((a) => a.recipientKind === 'self').length,
        unknown: prioritized.filter((a) => a.recipientKind === undefined || a.recipientKind === 'unknown').length,
      },
      drafts: {
        total: drafts.length,
        pending: drafts.filter((d) => d.status === 'pending').length,
        sent: drafts.filter((d) => d.status === 'sent').length,
        failed: drafts.filter((d) => d.status === 'failed').length,
      },
    },
    typeLabels: TYPE_LABELS,
    priorityLabels: PRIORITY_LABELS,
    /**
     * 完整优先级清单。**必须和 needAction / attention 用同一种结构**：
     * 原始分析记录把主题/发件人/时间放在 `mail` 里，而列表项把它们提到顶层。
     * 早期这里直接返回原始记录，界面按顶层字段读，于是「值得知悉」整列都是
     * 「(无主题) + 时间 —」——数据其实一直都在，只是读错了层级。
     */
    priorityList: prioritized.map((a) => toListItem(a, drafts)),
    needAction: needsReply.map((a) => toListItem(a, drafts)),
    /** 不需回复但有明确时限：单独一栏，带同样的待办操作 */
    worthNoting: worthNoting.map((a) => toListItem(a, drafts)),
    attention: attention.map((a) => toListItem(a, drafts)),
    /**
     * 已闭环/已推迟/已忽略的「需要你处理」。
     *
     * 单独给出而不是丢掉：用户点错、或者"其实还没处理完"，都得能翻回去恢复。
     */
    taskGroups: {
      done: taskGroups.done.map((a) => toListItem(a, drafts)),
      snoozed: taskGroups.snoozed.map((a) => toListItem(a, drafts)),
      ignored: taskGroups.ignored.map((a) => toListItem(a, drafts)),
    },
    /** 每条待办的原始状态，便于界面显示"3 天前标记为已处理"这类信息 */
    taskStates: Object.fromEntries(
      Object.entries(tasks).map(([key, t]) => [key, { status: t.status, snoozeUntil: t.snoozeUntil || null, note: t.note || null, updatedAt: t.updatedAt || null }]),
    ),
    actions: allActions,
  };
}

/** 把分析记录转成界面列表项；区分「需要处理」与「需要关注」两类。 */
function toListItem(a, drafts) {
  const draft = drafts.find((d) => d.source?.uid === a.uid && d.source?.folder === a.folder) || null;
  return {
    key: a.key,
    folder: a.folder,
    uid: a.uid,
    subject: a.mail?.subject,
    from: a.mail?.from,
    to: a.mail?.to || [],
    cc: a.mail?.cc || [],
    date: a.mail?.date,
    priority: a.priority,
    type: a.type,
    summary: a.summary,
    actions: a.actions,
    reason: a.reason,
    recipientKind: a.recipientKind ?? 'unknown',
    isDirect: a.isDirect ?? a.recipientKind === undefined,
    isCcOnly: a.isCcOnly ?? a.recipientKind === 'cc',
    hasDraft: !!draft,
    /** 关联草稿的状态：pending / sending / sent / failed；没有草稿时为 null */
    draftStatus: draft?.status || null,
    draftId: draft?.id || null,
    /** 已发送时给出时间，界面据此显示「已发送邮件」而不是「查看草稿」 */
    draftSentAt: draft?.sentAt || null,
    messageId: a.mail?.messageId,
    snippet: a.mail?.snippet,
    hasAttachments: !!a.mail?.hasAttachments,
    attachments: a.mail?.attachments || [],
    /** 分析时间：邮件时间缺失时用它兜底显示，保证列表里不会出现「时间 —」 */
    analyzedAt: a.analyzedAt || null,
    /** 原始分析记录（详情弹窗兜底用） */
    mail: a.mail || {},
  };
}

/* ------------------------------------------------------------ 单封详情 */

/**
 * 取一封邮件的原文 Buffer：本地归档优先，缺失时**只读回源**一次并顺手归档。
 *
 * 抽成独立函数是因为「查看正文」与「下载附件」都要它——
 * 否则两处各写一份归档/回源逻辑，迟早出现"正文能看、附件下不了"这类不一致。
 *
 * @returns {Promise<{raw: Buffer|null, source: 'archive'|'imap'|'none', reason: string}>}
 */
export async function loadRawFor({ folder, uid, instanceId } = {}) {
  const numUid = Number(uid);
  if (!folder || !Number.isFinite(numUid)) return { raw: null, source: 'none', reason: '邮件标识不完整' };

  const archived = store.findRaw(folder, numUid);
  if (archived) return { raw: archived, source: 'archive', reason: '' };

  try {
    const instance = getInstance(instanceId);
    if (!instance?.imap?.host || !instance?.imap?.authUser || !instance?.imap?.authPass) {
      return { raw: null, source: 'none', reason: '本地没有归档原文，且邮箱配置不完整，无法回源获取' };
    }
    const { connect, fetchRawSourceWithin, safeLogout } = await import('../mail/imap.js');
    const client = await connect(instance);
    let raw = null;
    try {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        raw = await fetchRawSourceWithin(client, numUid);
      } finally {
        lock.release();
      }
    } finally {
      await safeLogout(client);
    }
    if (!raw) return { raw: null, source: 'none', reason: '服务器上没有找到这封邮件（可能已被移动或删除）' };
    store.saveRaw(folder, numUid, null, raw);
    return { raw, source: 'imap', reason: '' };
  } catch (err) {
    log.debug(`回源取原文失败（${folder}:${numUid}）：${err?.message || err}`);
    return { raw: null, source: 'none', reason: `本地没有归档原文，回源获取失败：${err?.message || err}` };
  }
}

/**
 * 取一封邮件的**原文全文**（供「原始邮件」页签）。
 *
 * 来源优先级：
 *   1. 本地归档 `data/raw/*.eml`（分析过的邮件都会归档，命中率最高、也最快）；
 *   2. 归档缺失时**只读回源**拉一次 IMAP 并顺手归档（注意：只读打开信箱，不改任何标记）；
 *   3. 都拿不到 → 返回 available:false，由界面说明原因。
 *
 * 正文拆成「新内容」与「引用历史」两段：前者直接展示，后者单独折叠，
 * 否则一封来回十次的邮件会把阅读区撑成几千行。
 *
 * @returns {Promise<{available: boolean, source: string, text: string, quoted: string, truncated: boolean, chars: number, reason: string}>}
 */
export async function loadMailBody({ folder, uid, instanceId, maxChars = 40_000 } = {}) {
  const empty = { available: false, source: 'none', text: '', quoted: '', truncated: false, chars: 0, reason: '' };
  const numUid = Number(uid);
  if (!folder || !Number.isFinite(numUid)) return { ...empty, reason: '邮件标识不完整' };

  const { parseMessage, splitQuoted, visibleAttachments } = await import('../mail/parse.js');
  const loaded = await loadRawFor({ folder, uid: numUid, instanceId });
  const raw = loaded.raw;
  const source = loaded.source;
  if (!raw) return { ...empty, reason: loaded.reason };

  if (!raw) return { ...empty, reason: '服务器上没有找到这封邮件（可能已被移动或删除）' };

  try {
    const parsed = await parseMessage(raw);
    const { fresh, quoted } = splitQuoted(parsed.body);
    const limit = Number(maxChars) > 0 ? Number(maxChars) : 40_000;
    const truncated = fresh.length > limit;
    return {
      available: true,
      source,
      text: truncated ? `${fresh.slice(0, limit)}\n…（正文较长，已截断显示）` : fresh,
      quoted,
      truncated,
      chars: fresh.length,
      // 邮件头一并带出：界面在「原始邮件」页签里要显示发件人/收件人/时间
      subject: parsed.subject || '',
      from: parsed.from || null,
      to: parsed.to || [],
      cc: parsed.cc || [],
      date: parsed.date || null,
      messageId: parsed.messageId || null,
      inReplyTo: parsed.inReplyTo || null,
      references: parsed.references || [],
      // 与下载接口共用 visibleAttachments：保证列表顺序与下载序号一一对应
      attachments: visibleAttachments(parsed.attachments),
      bodyFormat: parsed.bodyFormat,
      reason: '',
    };
  } catch (err) {
    return { ...empty, reason: `原文解析失败：${err?.message || err}` };
  }
}

/**
 * 取一封邮件的详情（总览之外的入口，例如「对话查邮件」里的完整详情）。
 *
 * 与总览不同，这里**不受 24 小时窗口限制**：检索到的邮件可能是上个月回补进来的。
 * 三种情况都要给出可解释的结果，而不是笼统地报「未找到」：
 *   1. 有分析记录 → 返回完整分析；
 *   2. 没有分析记录但本地存有原文 → 解析出主题/发件人/正文摘录，标记 analyzed:false；
 *   3. 两者都没有 → 返回 found:false，由界面提示「先分析这一封」。
 *
 * 无论哪种情况都附带**原文全文**（`body`），供「原始邮件」页签阅读。
 *
 * @param {object} options { folder, uid, instanceId, withBody }
 */
export async function buildMailDetail({ folder, uid, instanceId, withBody = true } = {}) {
  const config = getConfig();
  const id = instanceId || config.defaultInstanceId;
  const entry = store.getAnalysis(folder, uid);
  const found = store.listDrafts({ instanceId: id }).find((d) => d.source?.folder === folder && d.source?.uid === Number(uid)) || null;
  const draft = found
    ? {
        id: found.id,
        status: found.status,
        sentAt: found.sentAt,
        subject: found.subject,
        to: found.to,
        quoted: found.quoted === true,
        mailbox: found.mailbox || null,
      }
    : null;
  const body = withBody ? await loadMailBody({ folder, uid, instanceId: id }) : null;

  if (entry) {
    return {
      found: true,
      analyzed: true,
      instanceId: id,
      analysis: {
        ...entry,
        typeLabel: TYPE_LABELS[entry.type] || entry.type,
        priorityLabel: PRIORITY_LABELS[entry.priority] || entry.priority,
        isDirectAction: isDirectAction(entry),
        isCcAttention: isCcAttention(entry),
      },
      mail: entry.mail || { folder, uid: Number(uid) },
      draft,
      body,
      rawExcerpt: null,
      note: '',
    };
  }

  // 没有分析记录：尽量把本地归档的原文解析出来，让「完整详情」不至于一无所获
  if (!body?.available) {
    return {
      found: false,
      analyzed: false,
      instanceId: id,
      analysis: null,
      mail: { folder, uid: Number(uid) },
      draft,
      body,
      rawExcerpt: null,
      note: body?.reason
        ? `${body.reason}。可以点「立即分析这一封」把它拉下来分析。`
        : '本地既没有这封邮件的分析记录，也没有归档原文。可以点「立即分析这一封」把它拉下来分析。',
    };
  }

  return {
    found: true,
    analyzed: false,
    instanceId: id,
    analysis: null,
    mail: {
      folder,
      uid: Number(uid),
      subject: body.subject || undefined,
      from: body.from || undefined,
      to: body.to || [],
      cc: body.cc || [],
      date: body.date || undefined,
      messageId: body.messageId || null,
      attachments: body.attachments || [],
      hasAttachments: !!(body.attachments || []).length,
      snippet: truncate(body.text, config.scan.snippetChars),
    },
    draft,
    body,
    rawExcerpt: truncate(body.text, 1200),
    note: '这封邮件还没有做过 AI 分析（可能是通过正文检索补充进来的）。可以点「立即分析这一封」。',
  };
}

/* ------------------------------------------------------------ 知识库 */

function matchTopics(record) {
  const haystack = [
    record.mail?.subject,
    record.summary,
    ...(record.actions || []),
    record.mail?.snippet,
    record.mail?.from?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return TOPICS.filter((t) => t.keywords.some((k) => haystack.includes(k.toLowerCase()))).map((t) => t.id);
}

function extractDeadlines(text) {
  const found = new Set();
  const src = String(text || '');
  for (const re of DEADLINE_PATTERNS) {
    for (const m of src.matchAll(re)) {
      const v = (m[1] || m[0]).trim();
      if (v) found.add(v);
    }
  }
  return [...found].slice(0, 3);
}

export function buildKnowledge({ instanceId, windowHours = 24, topic } = {}) {
  const config = getConfig();
  const id = instanceId || config.defaultInstanceId;
  const since = hoursAgo(windowHours);
  const records = store.listAnalyses({ instanceId: id, since, limit: 1000 });

  const entries = sortByPriority(records).map((a) => ({
    key: a.key,
    folder: a.folder,
    uid: a.uid,
    date: a.mail?.date || a.analyzedAt,
    subject: a.mail?.subject || '(无主题)',
    from: a.mail?.from || null,
    to: (a.mail?.to || []).map((t) => t.address),
    type: a.type,
    typeLabel: TYPE_LABELS[a.type] || a.type,
    priority: a.priority,
    priorityLabel: PRIORITY_LABELS[a.priority] || a.priority,
    needsReply: !!a.needsReply,
    recipientKind: a.recipientKind ?? 'unknown',
    /** 抄送 + 高优先级 → 需关注 */
    isCcAttention: isCcAttention(a),
    /** 直接发我 + 高优先级 + 需回复 → 需处理 */
    isDirectAction: isDirectAction(a),
    summary: a.summary || '',
    actions: a.actions || [],
    reason: a.reason || '',
    hasAttachments: !!a.mail?.hasAttachments,
    attachments: a.mail?.attachments || [],
    snippet: a.mail?.snippet || '',
    topics: matchTopics(a),
    deadlines: extractDeadlines(`${a.mail?.subject || ''} ${a.summary || ''} ${(a.actions || []).join(' ')}`),
    messageId: a.mail?.messageId || null,
    contextCount: (a.context || []).length,
  }));

  const topicBuckets = TOPICS.map((t) => ({
    id: t.id,
    label: t.label,
    count: entries.filter((e) => e.topics.includes(t.id)).length,
    entries: entries.filter((e) => e.topics.includes(t.id)).slice(0, 50),
  })).filter((t) => t.count > 0);

  const people = new Map();
  for (const e of entries) {
    const addr = e.from?.address;
    if (!addr) continue;
    const cur = people.get(addr) || { address: addr, name: e.from?.name || '', count: 0, needsReply: 0, subjects: [] };
    cur.count += 1;
    if (e.needsReply) cur.needsReply += 1;
    cur.subjects.push(e.subject);
    people.set(addr, cur);
  }

  const attachments = entries.filter((e) => e.hasAttachments).map((e) => ({
    subject: e.subject,
    from: e.from,
    date: e.date,
    files: e.attachments.map((f) => ({ filename: f.filename, contentType: f.contentType, size: f.size })),
  }));

  const filtered = topic ? entries.filter((e) => e.topics.includes(topic)) : entries;

  return {
    instanceId: id,
    windowHours,
    generatedAt: new Date().toISOString(),
    topics: topicBuckets.map(({ id: tid, label, count }) => ({ id: tid, label, count })),
    entries: filtered,
    people: [...people.values()].sort((a, b) => b.count - a.count).slice(0, 50),
    attachments,
    keyFacts: {
      total: entries.length,
      /** 直接发我 + 高优先级 + 需回复 */
      needsReply: entries.filter((e) => e.isDirectAction).length,
      /** 抄送我 + 高优先级 */
      attention: entries.filter((e) => e.isCcAttention).length,
      withDeadline: entries.filter((e) => e.deadlines.length).length,
      deadlineList: entries
        .filter((e) => e.deadlines.length)
        .map((e) => ({ subject: e.subject, from: e.from?.address || '', deadlines: e.deadlines })),
    },
  };
}

/* ------------------------------------------------------------ 问答 */

const QA_SYSTEM = `你是企业邮件知识库助手。用户会就最近一段时间收到的邮件提问，你要只依据提供的邮件资料回答。

规则：
- 只使用资料中出现的邮件；资料中没有的信息，明确回答「邮件里没有相关信息」，不要猜测、不要使用你的常识补充。
- 回答用简体中文，先给结论，再列依据（发件人 + 主题 + 时间）。
- 涉及金额、日期、人名、承诺时，必须与资料完全一致。
- 最多引用 5 封邮件，用「- 」开头的列表。
- 若问题与邮件无关，直接说明这属于邮件之外的范畴。

${INJECTION_GUARD}

只输出 JSON，不要 Markdown 围栏：
{
  "answer": "结论文本（可含换行）",
  "evidence": [
    { "subject": "...", "from": "...", "date": "...", "quote": "要点摘录" }
  ],
  "confidence": 0.0,
  "insufficient": false
}`;

export async function answerQuestion({ instanceId, question, topic, windowHours } = {}) {
  const config = getConfig();
  const id = instanceId || config.defaultInstanceId;
  const knowledge = buildKnowledge({ instanceId: id, windowHours: windowHours || config.scan.windowHours, topic });
  const instance = getInstance(id);

  const entries = knowledge.entries;
  if (entries.length === 0) {
    return {
      answer: `最近 ${knowledge.windowHours} 小时内没有可用于回答的邮件。请先运行一次「分析最近 24 小时邮件」。`,
      evidence: [],
      confidence: 1,
      insufficient: true,
      knowledgeStats: knowledge.keyFacts,
    };
  }

  const material = entries
    .map((e, i) =>
      [
        `【邮件 ${i + 1}】`,
        `主题：${e.subject}`,
        `发件人：${e.from?.name ? `${e.from.name} <${e.from.address}>` : e.from?.address || '未知'}`,
        `时间：${e.date || '未知'}`,
        `类型/优先级：${e.typeLabel}/${e.priorityLabel}${e.needsReply ? '（需回复）' : ''}`,
        `要点：${e.summary || '（无）'}`,
        e.actions.length ? `待办：${e.actions.join('；')}` : null,
        e.deadlines.length ? `时间线索：${e.deadlines.join('、')}` : null,
        e.snippet ? `正文摘录：${truncate(e.snippet, 300)}` : null,
        e.attachments.length ? `附件：${e.attachments.map((f) => f.filename || f.contentType).join('、')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n\n');

  const user = [
    `邮箱：${instance.identity.email}`,
    `资料范围：最近 ${knowledge.windowHours} 小时，共 ${entries.length} 封邮件`,
    topic ? `限定主题：${topic}` : null,
    '',
    '## 邮件资料',
    material,
    '',
    '## 用户问题',
    question,
    '',
    '请输出 JSON。',
  ]
    .filter(Boolean)
    .join('\n');

  const client = new LlmClient(config.llm);
  const { data, usage, model } = await client.completeJson({
    system: QA_SYSTEM,
    user,
    temperature: 0.2,
    label: '知识库问答',
  });

  return {
    question,
    answer: typeof data.answer === 'string' ? data.answer : '',
    evidence: Array.isArray(data.evidence) ? data.evidence.slice(0, 6) : [],
    confidence: typeof data.confidence === 'number' ? data.confidence : null,
    insufficient: !!data.insufficient,
    knowledgeStats: knowledge.keyFacts,
    model,
    usage,
  };
}
