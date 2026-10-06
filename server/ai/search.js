/**
 * 对话式邮件检索。
 *
 * 流程：自然语言 → 模型解析成结构化筛选条件 → 程序在本地已分析邮件上过滤 →
 * （正文检索才回落到 IMAP）→ 模型基于命中结果写分析。
 *
 * 关键原则：**筛选由程序做，模型只做理解与总结**。
 * 这样结果可复核、可复现，也不会出现模型编造不存在邮件的情况。
 */

import { getConfig, getInstance } from '../config/index.js';
import { AppError, clampNumber, log, truncate } from '../lib/util.js';
import { LlmClient } from '../llm/client.js';
import { PRIORITY_LABELS, TYPE_LABELS } from './analyze.js';
import * as store from '../store/state.js';
import { SEARCH_ANSWER_SYSTEM, SEARCH_INTENT_SYSTEM, buildSearchAnswerPrompt, buildSearchIntentPrompt } from './search-prompts.js';
import { ensureCoverage } from './backfill.js';
import { addDays, dayKey, nowContext, zonedTimeToUtc } from '../calendar/time.js';

/** 检索默认回看天数（无时间条件时）。 */
const DEFAULT_WINDOW_DAYS = 30;
/** 允许检索的最长范围。 */
const MAX_WINDOW_DAYS = 366;

/**
 * 把时刻换算成配置时区下的日期键（YYYY-MM-DD）。
 *
 * 一律按配置时区判断日期边界：邮件时间戳是 UTC，而用户是按本地时区看日期的。
 * 若按 UTC 取前 10 位，08-31 17:51 UTC 会被算成 8 月，而用户看到的是 9 月 1 日。
 */
function localDay(value, timeZone) {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return dayKey(d, timeZone);
}

/** 把「本地日期」换算成该时区当天 00:00 的真实瞬间（用于 IMAP SINCE 下界）。 */
function localDayStart(day, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!m) return new Date(0);
  return zonedTimeToUtc({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, timeZone);
}

/* ================================================================ 筛选条件 */

/** 把模型输出归一化成可安全使用的筛选条件。 */
export function normalizeFilters(raw, { now, timeZone }) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const toList = (v) =>
    (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v])
      .map((s) => String(s).trim())
      .filter(Boolean)
      .slice(0, 12);

  const today = dayKey(now, timeZone);
  const parseDay = (value) => {
    if (!value) return null;
    const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? m[0] : null;
  };

  let dateFrom = parseDay(input.dateFrom);
  let dateTo = parseDay(input.dateTo);
  const explicitRange = !!(dateFrom || dateTo);
  if (!dateFrom && !dateTo) {
    // 没给时间条件时用默认回看窗口
    dateFrom = dayKey(addDays(now, -DEFAULT_WINDOW_DAYS, timeZone), timeZone);
    dateTo = today;
  } else {
    if (!dateFrom) dateFrom = dayKey(addDays(now, -MAX_WINDOW_DAYS, timeZone), timeZone);
    if (!dateTo) dateTo = today;
  }
  // 限制最长范围，避免模型给出「过去十年」这种无意义查询
  const minFrom = dayKey(addDays(now, -MAX_WINDOW_DAYS, timeZone), timeZone);
  if (dateFrom < minFrom) dateFrom = minFrom;
  if (dateTo < dateFrom) dateTo = dateFrom;

  const types = toList(input.types).map((t) => t.toLowerCase());
  const priorities = toList(input.priorities).map((p) => p.toLowerCase());

  let recipientKind = String(input.recipientKind || 'any').toLowerCase();
  if (!['direct', 'cc', 'any'].includes(recipientKind)) recipientKind = 'any';

  return {
    dateFrom,
    dateTo,
    /** 解释日期边界所用的时区（日期比较必须同一把尺子） */
    timeZone,
    /** 是否由模型显式给出时间范围（用于提示里区分「默认 30 天」） */
    explicitRange,
    from: toList(input.from).map((s) => s.toLowerCase()),
    to: toList(input.to).map((s) => s.toLowerCase()),
    subject: toList(input.subject).map((s) => s.toLowerCase()),
    content: toList(input.content).map((s) => s.toLowerCase()),
    excludeContent: toList(input.excludeContent).map((s) => s.toLowerCase()),
    types: types.filter((t) => Object.keys(TYPE_LABELS).includes(t)),
    priorities: priorities.filter((p) => Object.keys(PRIORITY_LABELS).includes(p)),
    needsReply: input.needsReply === true ? true : null,
    recipientKind,
    hasAttachments: input.hasAttachments === true ? true : null,
    limit: clampNumber(input.limit, 1, 200, 30),
  };
}

function withinRange(record, filters) {
  const date = record.mail?.date || record.analyzedAt;
  if (!date) return false;
  const key = localDay(date, filters.timeZone || 'Asia/Shanghai');
  if (!key) return false;
  return key >= filters.dateFrom && key <= filters.dateTo;
}

function textOf(record) {
  return [
    record.mail?.subject,
    record.mail?.snippet,
    record.summary,
    ...(record.actions || []),
    record.reason,
    record.mail?.from?.name,
    record.mail?.from?.address,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function fromText(record) {
  return [record.mail?.from?.name, record.mail?.from?.address].filter(Boolean).join(' ').toLowerCase();
}

function subjectText(record) {
  return String(record.mail?.subject || '').toLowerCase();
}

function recipientsText(record) {
  return [...(record.mail?.to || []), ...(record.mail?.cc || [])]
    .map((a) => `${a.name || ''} ${a.address || ''}`)
    .join(' ')
    .toLowerCase();
}

function bodyText(record) {
  // 正文摘录 + 命中关键词需要时读原文
  return String(record.mail?.snippet || '').toLowerCase();
}

/**
 * 在本地已分析邮件上应用筛选条件。
 * @returns {Array} 命中的分析记录
 */
export function applyFilters(records, filters) {
  return records.filter((record) => {
    if (!withinRange(record, filters)) return false;

    if (filters.from.length && !filters.from.some((kw) => fromText(record).includes(kw))) return false;
    if (filters.to.length && !filters.to.some((kw) => recipientsText(record).includes(kw))) return false;
    if (filters.subject.length && !filters.subject.some((kw) => subjectText(record).includes(kw))) return false;
    if (filters.content.length) {
      const hay = `${textOf(record)} ${bodyText(record)}`;
      if (!filters.content.some((kw) => hay.includes(kw))) return false;
    }
    if (filters.excludeContent.length) {
      const hay = `${textOf(record)} ${bodyText(record)}`;
      if (filters.excludeContent.some((kw) => hay.includes(kw))) return false;
    }
    if (filters.types.length && !filters.types.includes(record.type)) return false;
    if (filters.priorities.length && !filters.priorities.includes(record.priority)) return false;
    if (filters.needsReply === true && !record.needsReply) return false;
    if (filters.hasAttachments === true && !record.mail?.hasAttachments) return false;

    if (filters.recipientKind === 'direct' && record.recipientKind !== 'direct') return false;
    if (filters.recipientKind === 'cc' && record.recipientKind !== 'cc') return false;

    return true;
  });
}

/* ================================================================ 正文检索 */

/**
 * 正文检索：本地分析只存了摘要，正文关键词可能落在摘要之外，
 * 因此当条件里含 content 且本地命中偏少时，回落到 IMAP 正文检索。
 *
 * 只做一次有上限的补充，且失败不影响主流程。
 */
async function searchImapBodies({ instanceId, filters, need }) {
  if (!need || !filters.content.length) return [];
  const timeZone = filters.timeZone || getConfig().calendar.timeZone;
  let instance;
  try {
    instance = getInstance(instanceId);
  } catch {
    return [];
  }
  const { connect, fetchSince, safeLogout } = await import('../mail/imap.js');
  const { parseMessage, stripQuoted } = await import('../mail/parse.js');
  const config = getConfig();

  // 配置不完整时不必尝试连接：否则日志里会出现与检索无关的认证失败
  if (!instance?.imap?.host || !instance?.imap?.authUser || !instance?.imap?.authPass) {
    log.debug('正文检索已跳过：邮箱配置不完整');
    return [];
  }

  let client;
  const hits = [];
  try {
    client = await connect(instance);
    for (const folder of config.scan.folders) {
      if (hits.length >= need) break;
      let list = [];
      try {
        list = await fetchSince(instance, {
          folder,
          since: localDayStart(filters.dateFrom, timeZone),
          maxMessages: Math.min(300, config.scan.maxMessages * 5),
          client,
        });
      } catch (err) {
        log.debug(`正文检索拉取失败（${folder}）：${err?.message || err}`);
        continue;
      }
      for (const summary of list) {
        if (hits.length >= need) break;
        const key = localDay(summary.date, timeZone);
        if (key && (key < filters.dateFrom || key > filters.dateTo)) continue;
        try {
          const raw = await (await import('../mail/imap.js')).fetchRawSourceWithin(client, summary.uid);
          if (!raw) continue;
          const parsed = await parseMessage(raw);
          const body = stripQuoted(parsed.body).toLowerCase();
          if (!filters.content.some((kw) => body.includes(kw))) continue;
          hits.push({
            folder,
            uid: summary.uid,
            subject: summary.subject,
            date: summary.date,
            from: summary.from,
            to: summary.to,
            cc: summary.cc,
            snippet: truncate(body, 240),
            source: 'imap-body',
          });
        } catch (err) {
          log.debug(`正文检索解析失败 UID=${summary.uid}：${err?.message || err}`);
        }
      }
    }
  } catch (err) {
    log.warn(`正文检索失败（不影响已分析结果）：${err?.message || err}`);
  } finally {
    if (client) await safeLogout(client);
  }
  return hits;
}

/* ================================================================ 主流程 */

function coverageOf(records, timeZone) {
  if (!records.length) return null;
  const dates = records
    .map((r) => localDay(r.mail?.date || r.analyzedAt, timeZone))
    .filter(Boolean)
    .sort();
  if (!dates.length) return null;
  return {
    count: records.length,
    oldest: dates[0],
    newest: dates[dates.length - 1],
  };
}

function recipientLabel(record) {
  switch (record.recipientKind) {
    case 'direct':
      return '直接发给我';
    case 'cc':
      return '抄送给我';
    case 'self':
      return '我自己发出';
    case 'unknown':
      return '收件人不明';
    default:
      // 历史数据没有该字段
      return '（旧记录，未判定）';
  }
}

function toResultItem(record, timeZone) {
  const draft =
    store.listDrafts({ instanceId: record.instanceId }).find((d) => d.source?.uid === record.uid && d.source?.folder === record.folder) ||
    null;
  return {
    key: record.key,
    folder: record.folder,
    uid: record.uid,
    subject: record.mail?.subject || '(无主题)',
    from: record.mail?.from || null,
    to: record.mail?.to || [],
    cc: record.mail?.cc || [],
    date: record.mail?.date || record.analyzedAt,
    day: localDay(record.mail?.date || record.analyzedAt, timeZone),
    type: record.type,
    typeLabel: TYPE_LABELS[record.type] || record.type,
    priority: record.priority,
    priorityLabel: PRIORITY_LABELS[record.priority] || record.priority,
    needsReply: !!record.needsReply,
    recipientKind: record.recipientKind ?? 'unknown',
    recipientLabel: recipientLabel(record),
    isCcAttention: record.recipientKind === 'cc' && ['urgent', 'high'].includes(record.priority),
    summary: record.summary || '',
    actions: record.actions || [],
    reason: record.reason || '',
    hasAttachments: !!record.mail?.hasAttachments,
    attachments: record.mail?.attachments || [],
    snippet: record.mail?.snippet || '',
    hasDraft: !!draft,
    /** 关联草稿的状态（pending / sent / failed），没有草稿时为 null */
    draftStatus: draft?.status || null,
    draftId: draft?.id || null,
  };
}

/**
 * 对话式检索入口。
 *
 * @param {object} options { query, instanceId, now, limit, onProgress }
 * @returns {Promise<object>} 意图、命中邮件、分析文本
 */
export async function searchEmails({ query, instanceId, now = new Date(), limit, onProgress } = {}) {
  const config = getConfig();
  const timeZone = config.calendar.timeZone;
  const text = String(query || '').trim();
  if (!text) throw new AppError('请输入要检索的内容', { code: 'EMPTY_QUERY', status: 400 });

  const instance = getInstance(instanceId);
  let all = store.listAnalyses({ instanceId: instance.id, limit: 5000 });
  const coverage = coverageOf(all, timeZone);

  const client = new LlmClient(config.llm);
  const { data: intent, usage } = await client.completeJson({
    system: SEARCH_INTENT_SYSTEM,
    user: buildSearchIntentPrompt({ query: text, now: nowContext(now, timeZone), timeZone, coverage }),
    temperature: 0.1,
    label: '检索意图解析',
  });

  const action = ['search', 'list', 'ask'].includes(intent.action) ? intent.action : 'search';
  const understood = String(intent.understood || '').trim();

  if (intent.needMore === true) {
    return {
      query: text,
      action,
      needMore: true,
      assistant: String(intent.question || '能再具体说明一下你想找哪些邮件吗？').trim(),
      understood,
      filters: null,
      items: [],
      stats: { matched: 0, scanned: all.length, coverage },
      note: '',
    };
  }

  const filters = normalizeFilters(intent.filters, { now, timeZone });
  if (limit) filters.limit = clampNumber(limit, 1, 200, filters.limit);

  /*
   * 按需回补：常规分析只覆盖最近 24 小时，若检索范围更早，本地候选集里根本没有这些邮件。
   * 这里先去 IMAP 拉取该范围（用发件人做服务端过滤）并分析，再重新检索。
   */
  let backfill = null;
  if (config.search.backfillMax > 0) {
    try {
      backfill = await ensureCoverage({ instanceId: instance.id, filters, onProgress });
      if (backfill?.attempted) all = store.listAnalyses({ instanceId: instance.id, limit: 5000 });
    } catch (err) {
      log.warn(`按需回补失败（不影响已分析范围内的检索）：${err?.message || err}`);
      backfill = { attempted: true, failed: true, note: `按需回补失败：${err?.message || err}`, errors: [] };
    }
  }

  let matched = applyFilters(all, filters);

  // 正文关键词在摘要里没命中时，回落到 IMAP 正文检索
  let bodyHits = [];
  if (filters.content.length && matched.length < 5) {
    bodyHits = await searchImapBodies({ instanceId: instance.id, filters, need: filters.limit });
  }

  // 排序
  const sortKey = ['date_desc', 'date_asc', 'priority'].includes(intent.sort) ? intent.sort : 'date_desc';
  const order = { urgent: 0, high: 1, normal: 2, low: 3 };
  matched = [...matched].sort((a, b) => {
    if (sortKey === 'priority') {
      const p = (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
      if (p !== 0) return p;
    }
    const da = new Date(a.mail?.date || 0).getTime();
    const db = new Date(b.mail?.date || 0).getTime();
    return sortKey === 'date_asc' ? da - db : db - da;
  });

  const totalMatched = matched.length + bodyHits.length;
  const items = matched.slice(0, filters.limit).map((r) => toResultItem(r, timeZone));

  // 正文命中里补充「尚未分析」的邮件（可选展示）
  const analysedKeys = new Set(all.map((r) => `${r.folder}:${r.uid}`));
  const extraItems = bodyHits
    .filter((h) => !analysedKeys.has(`${h.folder}:${h.uid}`))
    .slice(0, Math.max(0, filters.limit - items.length))
    .map((h) => ({
      key: `${h.folder}:${h.uid}`,
      folder: h.folder,
      uid: h.uid,
      subject: h.subject,
      from: h.from,
      to: h.to || [],
      cc: h.cc || [],
      date: h.date,
      day: localDay(h.date, timeZone),
      type: 'unknown',
      typeLabel: '未分析',
      priority: 'normal',
      priorityLabel: '未分析',
      needsReply: false,
      recipientKind: 'unknown',
      recipientLabel: '收件人不明',
      isCcAttention: false,
      summary: '',
      actions: [],
      reason: '',
      hasAttachments: false,
      attachments: [],
      snippet: h.snippet,
      hasDraft: false,
      notAnalyzed: true,
    }));

  const finalItems = [...items, ...extraItems];

  // 结果分析
  const answerMails = finalItems.slice(0, 12).map((it) => ({
    subject: it.subject,
    date: it.day,
    from: it.from?.name ? `${it.from.name} <${it.from.address}>` : it.from?.address || '未知',
    recipientLabel: it.recipientLabel,
    typeLabel: it.typeLabel,
    priorityLabel: it.priorityLabel,
    needsReply: it.needsReply,
    summary: it.summary,
    actions: it.actions,
    body: truncate(String(it.snippet || ''), 300),
  }));

  let assistant = '';
  let analysisError = null;
  const totals = coverageOf(store.listAnalyses({ instanceId: instance.id, limit: 5000 }), timeZone);
  if (finalItems.length === 0) {
    assistant = buildEmptyReply({ filters, understood, coverage: totals, action, backfill });
  } else {
    try {
      const { text: out } = await client.complete({
        system: SEARCH_ANSWER_SYSTEM,
        user: buildSearchAnswerPrompt({
          query: text,
          understood,
          mails: answerMails,
          now: nowContext(now, timeZone),
          timeZone,
          stats: { matched: totalMatched },
        }),
        temperature: 0.3,
        maxTokens: 1400,
        jsonMode: false,
        label: '检索结果分析',
      });
      assistant = String(out || '').trim();
    } catch (err) {
      log.warn(`检索结果分析失败，使用本地摘要：${err?.message || err}`);
      analysisError = err?.message || String(err);
      assistant = localSummary(finalItems, understood);
    }
  }

  return {
    query: text,
    action,
    needMore: false,
    understood,
    filters: {
      ...filters,
      effectiveRange: `${filters.dateFrom} ~ ${filters.dateTo}`,
      defaultedRange: !filters.explicitRange,
    },
    items: finalItems,
    stats: {
      matched: totalMatched,
      scanned: all.length,
      coverage: totals,
      bodyHits: bodyHits.length,
      sort: sortKey,
      backfill: backfill
        ? {
            attempted: !!backfill.attempted,
            rangeExpanded: !!backfill.attempted && !backfill.failed,
            fetched: backfill.fetched || 0,
            analyzed: backfill.analyzed || 0,
            truncated: !!backfill.truncated,
            failed: !!backfill.failed,
            errors: backfill.errors || [],
          }
        : null,
    },
    backfillNote: backfill?.note || '',
    assistant,
    analysisError,
    usage,
  };
}

function buildEmptyReply({ filters, understood, coverage, action, backfill }) {
  const lines = [`没有找到符合条件的邮件。`];
  if (understood) lines.push('', `检索条件：${understood}`);
  lines.push('', `时间范围：${filters.dateFrom} ~ ${filters.dateTo}`);
  const cond = [];
  if (filters.from.length) cond.push(`发件人含「${filters.from.join('、')}」`);
  if (filters.subject.length) cond.push(`主题含「${filters.subject.join('、')}」`);
  if (filters.content.length) cond.push(`内容含「${filters.content.join('、')}」`);
  if (filters.priorities.length) cond.push(`优先级为 ${filters.priorities.join('/')}`);
  if (filters.types.length) cond.push(`类型为 ${filters.types.join('/')}`);
  if (cond.length) lines.push(`筛选条件：${cond.join('；')}`);

  if (coverage) {
    lines.push('', `本地已分析的邮件覆盖 ${coverage.oldest} ~ ${coverage.newest}（共 ${coverage.count} 封）。`);
  } else {
    lines.push('', '本地还没有已分析的邮件。');
  }

  // 已尝试按需回补：如实说明这一步做了什么，避免让用户以为是「检索坏了」
  if (backfill?.attempted) {
    if (backfill.failed) {
      lines.push('', `已尝试按需拉取该范围的邮件但失败：${backfill.note || '未知错误'}`);
    } else if (backfill.fetched > 0) {
      lines.push('', `已按需拉取并分析 ${backfill.analyzed ?? 0} 封（候选 ${backfill.fetched} 封），但其中仍没有符合上述条件的邮件。`);
    } else {
      lines.push('', '已按需到邮箱里查过这个范围，没有符合时间与发件人条件的邮件。');
    }
    if (backfill.truncated && backfill.note) lines.push(`注意：${backfill.note}`);
    if (backfill.errors?.length) {
      lines.push(`部分文件夹拉取失败：${backfill.errors.map((e) => `${e.folder}（${e.message}）`).join('；')}`);
    }
  } else if (coverage && filters.dateFrom < coverage.oldest) {
    lines.push('', '注意：你要查的时间段早于本地已分析范围，而按需回补当前是关闭的。');
    const limit = getConfig().search?.backfillMax ?? 0;
    lines.push(
      limit > 0
        ? '按需回补已开启但没有生效，可稍后重试或缩小时间范围。'
        : '可以在「设置 → 分析与起草策略」把「检索按需回补上限」调到 40 左右后重试。',
    );
  } else if (!coverage) {
    // 本地为空：可能是从没分析过，也可能是回补被关掉了——两种都要说清
    const limit = getConfig().search?.backfillMax ?? 0;
    lines.push('', limit > 0 ? '本地还没有已分析的邮件。请先运行一次「分析最近 24 小时」。' : '本地还没有已分析的邮件，而按需回补当前是关闭的（检索按需回补上限 = 0）。');
    if (limit <= 0) lines.push('可以在「设置 → 分析与起草策略」把「检索按需回补上限」调到 40 左右后重试。');
  } else {
    lines.push('', '可以放宽时间范围，或换用更短的关键词（例如只填人名或邮箱前缀）。');
  }
  void action;
  return lines.join('\n');
}

function localSummary(items, understood) {
  const lines = [understood ? `检索条件：${understood}` : '', `共找到 ${items.length} 封邮件：`, ''];
  for (const it of items.slice(0, 15)) {
    lines.push(`- [${it.day}] ${it.from?.name || it.from?.address || '未知'}：${it.subject}`);
    if (it.summary) lines.push(`  ${it.summary}`);
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * 最近 N 天每天有多少封邮件（按收件方式分），用于日历知识库与检索页的「近一个月」视图。
 */
export function emailActivity({ instanceId, days = 30, now = new Date() } = {}) {
  const config = getConfig();
  const timeZone = config.calendar.timeZone;
  const id = instanceId || config.defaultInstanceId;
  const from = dayKey(addDays(now, -(days - 1), timeZone), timeZone);
  const to = dayKey(now, timeZone);
  const records = store.listAnalyses({ instanceId: id, limit: 3000 }).filter((r) => {
    const key = localDay(r.mail?.date || r.analyzedAt, timeZone);
    return key >= from && key <= to;
  });

  const buckets = new Map();
  for (const r of records) {
    const key = localDay(r.mail?.date || r.analyzedAt, timeZone);
    const bucket = buckets.get(key) || { day: key, total: 0, direct: 0, cc: 0, urgent: 0, needsReply: 0, subjects: [] };
    bucket.total += 1;
    if (r.recipientKind === 'direct') bucket.direct += 1;
    if (r.recipientKind === 'cc') bucket.cc += 1;
    if (r.priority === 'urgent') bucket.urgent += 1;
    if (r.needsReply) bucket.needsReply += 1;
    if (bucket.subjects.length < 5) bucket.subjects.push(r.mail?.subject || '');
    buckets.set(key, bucket);
  }

  const list = [...buckets.values()].sort((a, b) => b.day.localeCompare(a.day));
  return {
    instanceId: id,
    days,
    range: { from, to },
    total: records.length,
    activeDays: list.length,
    days: list,
  };
}
