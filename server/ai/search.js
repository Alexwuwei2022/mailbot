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
import { backfillNeeded, ensureCoverage } from './backfill.js';
import { addDays, dayKey, nowContext, zonedTimeToUtc } from '../calendar/time.js';

/** 检索默认回看天数（无时间条件时）。 */
const DEFAULT_WINDOW_DAYS = 30;
/** 允许检索的最长范围（1 年）。超出时收敛并把原因写进 filters.rangeNote，界面如实展示。 */
const MAX_WINDOW_DAYS = 366;
/**
 * 命中列表默认最多返回多少条 / 硬上限。
 *
 * 列表该列多少是**使用者的关切**，不是模型该随手决定的事：之前把模型解析出的
 * `limit`（默认 30）直接当成列表上限，于是「查某发件人 7 月以来的邮件」这类
 * 命中 34 封的查询被静默截到最新 30 封，最早那封（7-02）凭空消失。
 *
 * 默认直接顶到硬上限：本地应用里 1000 条纯 JSON（约 1 MB）没有问题，
 * 界面另有 200 条一批的渲染上限（「显示更多」），所以这里优先保证**列表不缺**。
 * 模型给的 limit 只能在这个上限内收窄，永远不会低于默认值。
 */
const LIST_DEFAULT = 1000;
const MAX_LIST_LIMIT = 1000;
/**
 * 结论（模型分析）最多依据多少封邮件。
 *
 * 与列表上限解耦：列表可以很长，但送进模型的必须是有界的（额度与上下文长度）。
 * 40 的理由：约等于一次检索结论能覆盖的合理阅读量，token 可控（每封只带摘要与 300 字摘录）。
 */
const ANALYSIS_BASIS_LIMIT = 40;
/** 结论依据的 40 封之外，还额外列出多少封的「标题+时间」给它做主题参考（不带摘录）。 */
const ANALYSIS_HEADLINE_LIMIT = 40;

/* ================================================================ 结论范围策略 */

/**
 * 「结论范围」：决定把命中里的**哪** ANALYSIS_BASIS_LIMIT 封交进模型写结论。
 *
 * 为什么需要这个开关：上限本身必须钉死（额度闸门，绝不放大），但「取哪 40 封」直接决定
 * 结论能看到什么。原先是硬编码「按时间倒序取前 40 封」，于是「7 月份以来某人发来的邮件」
 * 这类跨 3 个月的查询里，第 41 封（实测 07-16）之后的邮件完全没有摘录进入结论——
 * 结论表面上在回答「7 月以来」，实际只看了最近一个月，而界面上看不出来。
 *
 * 所以把选择权交给用户，并且**在界面上写清每种策略的代价**：
 *   - recent ：看得最细（连续的最新一批），但范围较宽时早期邮件进不了结论；
 *   - monthly：覆盖整段时间（每个自然月都有代表），但每个月的细节看得少；
 *   - even   ：比按月更均匀（含最早与最新各一封），但会跳过中间月份的大部分邮件。
 *
 * 三种策略的带摘录总数恒为 `min(ANALYSIS_BASIS_LIMIT, 命中数)`——策略只决定「哪 40 封」，
 * 不决定「多少封」。所有选择都是**本地确定性算法**（无随机数、无模型参与），
 * 同一输入跑两次结果完全一致，可测试也可解释。
 */
const BASIS_MONTHLY_PER_MONTH = 8;

export const BASIS_STRATEGIES = {
  recent: {
    id: 'recent',
    /** 策略名（界面下拉、提示词里都用它） */
    name: '最近 N 封',
    /** 口径前缀：「最近 40 封」 */
    scope: '最近',
    detail: '看得最细（连续的最新一批，每封都有摘录），但范围较宽时早期邮件进不了结论。',
  },
  monthly: {
    id: 'monthly',
    name: '按月节选',
    scope: '按月节选',
    detail: `覆盖整段时间：每个自然月都有代表（每月最多 ${BASIS_MONTHLY_PER_MONTH} 封），但每个月的细节看得少。`,
  },
  even: {
    id: 'even',
    name: '均衡采样',
    scope: '均衡采样',
    detail: '在全范围内等间隔取样（含最早与最新各一封），比按月更均匀，但会跳过中间月份的大部分邮件。',
  },
};
export const BASIS_STRATEGY_IDS = Object.keys(BASIS_STRATEGIES);
export const DEFAULT_BASIS_STRATEGY = 'recent';

/**
 * 归一化请求里的策略值。
 *
 * 非法值**回落到默认并说明**（而不是静默当成默认）：与全项目「绝不静默少给/静默改口径」
 * 的原则一致——界面会把这句说明显示出来，调用方也能从 `fellBack` 判断出发生了回落。
 */
export function normalizeBasis(raw) {
  const requested = raw === undefined || raw === null ? '' : String(raw).trim();
  const id = requested.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(BASIS_STRATEGIES, id)) {
    return { strategy: id, requested: id, fellBack: false, note: '' };
  }
  if (!requested) return { strategy: DEFAULT_BASIS_STRATEGY, requested: '', fellBack: false, note: '' };
  return {
    strategy: DEFAULT_BASIS_STRATEGY,
    requested,
    fellBack: true,
    note: `结论范围「${requested}」不是有效选项，已按「${BASIS_STRATEGIES[DEFAULT_BASIS_STRATEGY].name}」处理。可选：${BASIS_STRATEGY_IDS.join(' / ')}。`,
  };
}

/** 条目所属的自然月（按配置时区折算，与列表展示的日期同一把尺子）。 */
function basisMonthKey(item, timeZone) {
  const day = item?.day || localDay(item?.date, timeZone);
  return day ? day.slice(0, 7) : '';
}

/** 条目的展示日（YYYY-MM-DD）。 */
function basisDay(item, timeZone) {
  return item?.day || localDay(item?.date, timeZone) || '';
}

/**
 * 时间倒序（同一时刻按 key 兜底）。
 *
 * 兜底比较是**确定性**的关键：同一时刻的邮件若靠 `Array.prototype.sort` 的稳定性决定顺序，
 * 一旦上游顺序变化（例如换排序、多线程补数据）结果就会变，测试也就无法解释。
 */
function timeDesc(a, b) {
  const da = new Date(a?.date || 0).getTime();
  const db = new Date(b?.date || 0).getTime();
  if (db !== da) return db - da;
  return String(a?.key ?? a?.uid ?? '').localeCompare(String(b?.key ?? b?.uid ?? ''));
}

/**
 * 均衡采样：在长度为 m 的序列里等间隔取 n 个**下标**（含首尾），无随机数。
 *
 * `idx_i = round(i * (m-1) / (n-1))`：步长 ≥ 1，因此相邻下标必然不同（重复下标另有兜底去重）。
 * n 小于 m 时首下标恒为 0、末下标恒为 (m-1)——即**范围内最新与最早各取一封**，
 * 这正是「均衡采样」要保证的：视野拉到整段时间，而不是只看最近一批。
 * n=1 时给最新的那封（与「最近」策略的首条一致，避免出现「唯一一个名额给了中间某封」这种怪事）。
 */
function evenSample(sorted, n) {
  const m = sorted.length;
  if (n <= 0 || m === 0) return [];
  if (n >= m) return [...sorted];
  if (n === 1) return [sorted[0]];
  const out = [];
  const seen = new Set();
  for (let i = 0; i < n; i += 1) {
    const idx = Math.round((i * (m - 1)) / (n - 1));
    if (seen.has(idx)) continue;
    seen.add(idx);
    out.push(sorted[idx]);
  }
  return out;
}

/** 一组条目的时间跨度与覆盖的自然月数。 */
function spanOf(items, timeZone) {
  const days = items.map((it) => basisDay(it, timeZone)).filter(Boolean).sort();
  const months = new Set(items.map((it) => basisMonthKey(it, timeZone)).filter(Boolean));
  return {
    coveredFrom: days[0] || '',
    coveredTo: days[days.length - 1] || '',
    months: months.size,
  };
}

/**
 * 按策略挑出结论依据的邮件（本地确定性）。
 *
 * 边界口径（三种策略一致）：
 *   - 命中不足上限时有多少给多少（cap = min(limit, 命中数)），不会凑数、不会重复；
 *   - 某个月没有邮件就不参与按月节选（不会凭空造出代表），`months` 只数真的有邮件的月份；
 *   - 没有日期的条目归不进任何自然月（monthly 里被跳过），recent/even 不受影响。
 *
 * @returns {{strategy: string, items: Array, months: number, rangeMonths: number,
 *            monthCounts: Array|null, coveredFrom: string, coveredTo: string}}
 */
export function selectBasisItems(items, { strategy = DEFAULT_BASIS_STRATEGY, limit = ANALYSIS_BASIS_LIMIT, maxPerMonth = BASIS_MONTHLY_PER_MONTH, timeZone } = {}) {
  const list = Array.isArray(items) ? items : [];
  const cap = Math.max(0, Math.min(limit, list.length));
  // 选中结果一律**按列表原顺序**返回：提示词与界面看到的顺序始终与命中列表一致
  const order = new Map(list.map((it, i) => [it, i]));
  const byListOrder = (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0);
  const allMonths = new Set(list.map((it) => basisMonthKey(it, timeZone)).filter(Boolean));
  const rangeMonths = allMonths.size;

  let picked = [];
  let monthCounts = null;

  if (cap > 0 && strategy === 'monthly') {
    const groups = new Map();
    for (const it of list) {
      const key = basisMonthKey(it, timeZone);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(it);
    }
    // 月份倒序：同一批里取数顺序固定，与上游排序无关
    const months = [...groups.keys()].sort().reverse();
    for (const key of months) groups.get(key).sort(timeDesc);
    /*
     * 轮转取（先每月第 1 新，再每月第 2 新……）而不是「整体按时间取前 40」：
     * 后者在月份多、每月邮件多时会又一次把早期月份整段挤掉，等于换个方式重演原缺陷。
     * 轮转保证：只要总量没被 cap 卡死，每个月都有代表；被卡死时也是**从最老的月份开始少给**，
     * 而不是从最老的月份开始全丢。
     */
    for (let depth = 0; depth < maxPerMonth && picked.length < cap; depth += 1) {
      for (const key of months) {
        if (picked.length >= cap) break;
        const group = groups.get(key);
        if (depth < group.length) picked.push(group[depth]);
      }
    }
    monthCounts = months
      .map((key) => ({ month: key, selected: picked.filter((it) => basisMonthKey(it, timeZone) === key).length, total: groups.get(key).length }))
      .sort((a, b) => b.month.localeCompare(a.month));
    picked.sort(byListOrder);
  } else if (cap > 0 && strategy === 'even') {
    picked = evenSample([...list].sort(timeDesc), cap).sort(byListOrder);
  } else if (cap > 0) {
    // recent：与旧行为逐条一致——就是当前列表顺序的前 cap 条（默认按时间倒序，即最新的一批）
    picked = list.slice(0, cap);
  }

  const span = spanOf(picked, timeZone);
  return {
    strategy: BASIS_STRATEGIES[strategy] ? strategy : DEFAULT_BASIS_STRATEGY,
    items: picked,
    months: span.months,
    rangeMonths,
    monthCounts,
    coveredFrom: span.coveredFrom,
    coveredTo: span.coveredTo,
  };
}

/**
 * 把策略与选择结果拼成**唯一一处**的口径文案（界面、提示词、本地降级摘要共用），
 * 避免三处各写一套、数字与说法对不上。
 */
export function describeBasis({
  strategy,
  count,
  limit = ANALYSIS_BASIS_LIMIT,
  months = 0,
  maxPerMonth = BASIS_MONTHLY_PER_MONTH,
  coveredFrom = '',
  coveredTo = '',
  matched = 0,
  headlines = 0,
  order = 'date_desc',
}) {
  const meta = BASIS_STRATEGIES[strategy] || BASIS_STRATEGIES[DEFAULT_BASIS_STRATEGY];
  /*
   * `recent` 取的是「当前列表顺序的前 N 封」（这正是它向后兼容的旧语义）。默认排序是时间倒序，
   * 于是它就是「最新的一批」；但模型也可以选 `priority` / `date_asc` 排序，那时前 40 封并不是最新的，
   * 口径必须如实改写——否则界面写着「最近 40 封」、实际给的却是另一批，又回到了这次要修的毛病。
   */
  const scope = strategy === 'recent' && order !== 'date_desc' ? '列表前' : meta.scope;
  const label = `${scope} ${count} 封`;
  const extra = strategy === 'monthly' ? `，每月最多 ${maxPerMonth} 封` : '';
  const span = coveredFrom && coveredTo ? `覆盖 ${coveredFrom} ~ ${coveredTo}` : '覆盖范围未知';
  /** 送给模型的这批是按什么顺序列的（界面与提示词共用，别再各写一套三元表达式） */
  const orderLabel = order === 'date_asc' ? '时间正序' : order === 'priority' ? '按优先级' : '时间倒序';
  return {
    strategy: meta.id,
    strategyName: meta.name,
    label,
    /** 一句话口径：界面与提示词都用它（两边口径天然一致） */
    line: `结论基于${label}（${span}${extra}）`,
    count,
    limit,
    months,
    maxPerMonth: strategy === 'monthly' ? maxPerMonth : null,
    coveredFrom,
    coveredTo,
    matched,
    headlines,
    order,
    orderLabel,
    detail: meta.detail,
  };
}

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
  // 限制最长范围，避免模型给出「过去十年」这种无意义查询。
  // 只收敛不报错，但必须标记出来——静默改小范围同样是「少给」的一种。
  const minFrom = dayKey(addDays(now, -MAX_WINDOW_DAYS, timeZone), timeZone);
  const requestedFrom = dateFrom;
  let rangeClamped = false;
  if (dateFrom < minFrom) {
    dateFrom = minFrom;
    rangeClamped = true;
  }
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
    /** 允许的最长范围（天）：超出就被收敛到这里 */
    maxWindowDays: MAX_WINDOW_DAYS,
    /** 是否因超出 1 年上限而被收敛（界面必须如实说明） */
    rangeClamped,
    /** 收敛前模型要求的起点（用于提示「你要的是 X，实际按 Y 检索」） */
    requestedFrom: rangeClamped ? requestedFrom : null,
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
    /**
     * 列表展示上限。
     *
     * 模型只在**明确要得更多**时才能抬高它，且绝不会低于 LIST_DEFAULT——
     * 模型随手给的 30 不再有机会把命中列表截短（这正是本次 bug 的成因）。
     */
    limit: input.limit === undefined || input.limit === null || input.limit === ''
      ? LIST_DEFAULT
      : Math.max(LIST_DEFAULT, clampNumber(input.limit, 1, MAX_LIST_LIMIT, LIST_DEFAULT)),
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

/* ================================================================ 列表与排序 */

/**
 * 命中记录的排序。列表与「结论依据」用同一份顺序，界面文案才能对得上。
 */
export function sortAnalyses(records, sortKey) {
  const order = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...records].sort((a, b) => {
    if (sortKey === 'priority') {
      const p = (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
      if (p !== 0) return p;
    }
    const da = new Date(a.mail?.date || 0).getTime();
    const db = new Date(b.mail?.date || 0).getTime();
    return sortKey === 'date_asc' ? da - db : db - da;
  });
}

/** 把检索结果条目换算成「列表所需的展示日」。 */
function withDisplayDay(it, timeZone) {
  return { ...it, day: it.day || localDay(it.date, timeZone) };
}

/** 信封级命中 → 列表条目（只有时间/发件人/主题，没有摘要，标记为未分析）。 */
function envelopeItem(candidate, timeZone) {
  return withDisplayDay(
    {
      key: `${candidate.folder}:${candidate.uid}`,
      folder: candidate.folder,
      uid: candidate.uid,
      subject: candidate.subject || '(无主题)',
      from: candidate.from || null,
      to: candidate.to || [],
      cc: candidate.cc || [],
      date: candidate.date,
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
      snippet: '',
      hasDraft: false,
      /** 明确标记：条目只来自信封，没有模型摘要 */
      notAnalyzed: true,
      analyzed: false,
      source: 'envelope',
    },
    timeZone,
  );
}

/** IMAP 正文检索命中 → 列表条目（正文里读到的，但同样没有模型摘要）。 */
function imapHitItem(hit, timeZone, snippet) {
  return withDisplayDay(
    {
      key: `${hit.folder}:${hit.uid}`,
      folder: hit.folder,
      uid: hit.uid,
      subject: hit.subject || '(无主题)',
      from: hit.from || null,
      to: hit.to || [],
      cc: hit.cc || [],
      date: hit.date,
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
      snippet: snippet || '',
      hasDraft: false,
      notAnalyzed: true,
      analyzed: false,
      source: 'imap-body',
    },
    timeZone,
  );
}

/**
 * 该查询的附加条件是否**全部**能用信封字段（发件人/收件人/时间/主题）判定。
 *
 * 信封里没有正文，也没有模型判定出来的类型/优先级/收件人身份，因此含这些条件时
 * 信封层面无法证实某封邮件是否命中。这种情况下宁可不并入信封命中（列表会因此变短），
 * 也不列出不符合条件的邮件——少列可以用「已分析范围」解释，列错就是实打实的错。
 */
function allFiltersDecidableFromEnvelope(filters) {
  return (
    !filters.content.length &&
    !filters.excludeContent.length &&
    !filters.types.length &&
    !filters.priorities.length &&
    filters.needsReply !== true &&
    filters.hasAttachments !== true &&
    filters.recipientKind === 'any'
  );
}

/** 信封是否命中该查询（时间 + 发件人 + 收件人 + 主题）。 */
function matchesEnvelope(candidate, filters, timeZone) {
  const key = localDay(candidate.date, timeZone || 'Asia/Shanghai');
  if (key && (key < filters.dateFrom || key > filters.dateTo)) return false;
  if (filters.from.length) {
    const hay = `${candidate.from?.name || ''} ${candidate.from?.address || ''}`.toLowerCase();
    if (!filters.from.some((kw) => hay.includes(kw))) return false;
  }
  if (filters.to.length) {
    const hay = [...(candidate.to || []), ...(candidate.cc || [])]
      .map((a) => `${a.name || ''} ${a.address || ''}`)
      .join(' ')
      .toLowerCase();
    if (!filters.to.some((kw) => hay.includes(kw))) return false;
  }
  if (filters.subject.length) {
    const subject = String(candidate.subject || '').toLowerCase();
    if (!filters.subject.some((kw) => subject.includes(kw))) return false;
  }
  return true;
}

/**
 * 列表截断说明（界面直接展示，绝不静默截断）。
 * 覆盖两种不同的「少给」：命中数超过可展示上限、信封扫描达到上限。
 */
function buildTruncationNote({ stats, backfill }) {
  const lines = [];
  if (stats.matched > stats.listed) {
    lines.push(
      `命中 ${stats.matched} 封，已列出前 ${stats.listed} 封（单次展示上限）。` +
        '请缩小时间范围或加上发件人/主题条件后分次查询，以免漏看较早的邮件。',
    );
  }
  if (backfill?.scanTruncated) {
    /*
     * 这里必须把**两批邮件**分开说，否则会自相矛盾（用户实测指出过）：
     *   - 上方列表来自**本地已分析**记录，那批命中是完整的；
     *   - 未检查的是"信封扫描没扫到的那部分"，它们只可能**另外**带来命中，
     *     不代表已列的少了。
     * 原措辞「上方列表可能不全」把后者说成了前者，用户看到"63 封都列出来了"
     * 却被告知列表可能不全，只会怀疑数据。
     *
     * 数字口径：上限（scanLimit）/ 已扫描（scanned）/ 未检查（unscanned）/ 从 IMAP 取到（scanTotal）。
     * 截断时恒有 `scanned + unscanned === scanTotal`——四个数在文案里一起给出，用户能直接对账
     * （曾经的缺陷就是只写「已扫描约 250 封」，与预算 800 对不上却看不出问题在哪）。
     */
    const scanned = backfill.scanned ?? 0;
    const unscanned = backfill.unscanned ?? 0;
    const limit = backfill.scanLimit ? `上限 ${backfill.scanLimit} 封，` : '';
    const total = backfill.scanTotal ? `从 IMAP 取到 ${backfill.scanTotal} 封 UID，` : '';
    lines.push(
      `本次信封扫描达到上限（${limit}${total}已扫描约 ${scanned} 封，另有约 ${unscanned} 封未检查）。` +
        `**上方列表是完整的**（来自本地已分析记录）；未检查的那部分只可能带来**额外的**命中，` +
        `不影响已列出的结果。如需确认，请缩小时间范围（例如按月分次查询）后重试。`,
    );
  }
  return lines.join('\n');
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
    /** 该条目有模型摘要（已分析）；false 的只有信封信息 */
    analyzed: true,
    source: 'analysis',
    notAnalyzed: false,
  };
}

/**
 * 对话式检索入口。
 *
 * @param {object} options { query, instanceId, now, limit, basis, onProgress }
 *   `basis` 是「结论范围」策略：'recent'（默认）| 'monthly' | 'even'，非法值回落到 recent 并说明。
 * @returns {Promise<object>} 意图、命中邮件、分析文本、结论范围口径（basis/analysisBasis）
 */
export async function searchEmails({ query, instanceId, now = new Date(), limit, basis: basisStrategy, onProgress } = {}) {
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
  // 显式传入的 limit 只用于**主动收窄**（例如调用方想只要前几条），
  // 并且同样受硬上限约束：不能因为调用方给了个大数就让响应无限膨胀。
  if (limit) filters.limit = Math.min(MAX_LIST_LIMIT, Math.max(1, clampNumber(limit, 1, MAX_LIST_LIMIT, filters.limit)));

  /*
   * 按需回补 + 信封级匹配：
   *   1. 常规分析只覆盖最近 24 小时，范围更早时本地候选集里根本没有这些邮件 → 去 IMAP 拉该范围并分析（有额度上限）；
   *   2. 回补过程中扫过的**信封**（时间/发件人/主题）会一并带回，让没有花额度分析的那部分邮件
   *      也能出现在命中列表里（标记为「未分析」）——列表完整性不靠放大模型调用量来换。
   * 本地分析已覆盖该范围时跳过重扫：已有覆盖说明这些邮件早就分析过，列表本来就是全的，
   * 再扫一遍同一个范围只会白等一次 IMAP 往返。范围出现新的更早边界时，backfillNeeded 会要求重扫。
   */
  let backfill = null;
  if (config.search.backfillMax > 0) {
    try {
      const skipScan = !backfillNeeded(all, filters, timeZone).needed;
      backfill = await ensureCoverage({ instanceId: instance.id, filters, onProgress, skipScan });
      if (backfill?.attempted) all = store.listAnalyses({ instanceId: instance.id, limit: 5000 });
    } catch (err) {
      log.warn(`按需回补失败（不影响已分析范围内的检索）：${err?.message || err}`);
      backfill = { attempted: true, failed: true, note: `按需回补失败：${err?.message || err}`, errors: [] };
    }
  }

  let matched = applyFilters(all, filters);

  // 正文关键词在摘要里没命中时，回落到 IMAP 正文检索。
  // 注意这里的 need 用列表硬上限，不再跟模型的展示上限走（不再是 30 这种小数字）。
  let bodyHits = [];
  if (filters.content.length && matched.length < 5) {
    bodyHits = await searchImapBodies({ instanceId: instance.id, filters, need: MAX_LIST_LIMIT });
  }

  // 排序
  const sortKey = ['date_desc', 'date_asc', 'priority'].includes(intent.sort) ? intent.sort : 'date_desc';
  matched = sortAnalyses(matched, sortKey);

  /*
   * 信封级命中：本次回补已经扫过该范围的信封，这些「对得上时间/发件人/主题、
   * 但没有被分析（例如超出回补分析额度）」的邮件同样属于命中。
   * 它们**不读正文、不花模型额度**，因此可以全部列进列表——这正是「列表不能缺」的要求。
   * 只有在该查询的所有附加条件都能用信封字段判定时才并入，避免把无法证实的邮件列出来。
   */
  const envelopeOk = allFiltersDecidableFromEnvelope(filters);
  const analysedKeys = new Set(all.map((r) => `${r.folder}:${r.uid}`));
  const envelopeItems = envelopeOk
    ? (backfill?.candidates || [])
        .filter((c) => matchesEnvelope(c, filters, timeZone))
        .filter((c) => !analysedKeys.has(`${c.folder}:${c.uid}`))
        .map((c) => envelopeItem(c, timeZone))
    : [];
  // 去重（同一封可能因多次回补/多文件夹重复出现）
  const envelopeOnly = [];
  const seenEnvelope = new Set();
  for (const it of envelopeItems) {
    if (seenEnvelope.has(it.key)) continue;
    seenEnvelope.add(it.key);
    envelopeOnly.push(it);
  }

  // 正文命中里补充「尚未分析」的邮件（可选展示）
  const bodyOnly = bodyHits
    .filter((h) => !analysedKeys.has(`${h.folder}:${h.uid}`))
    .map((h) => imapHitItem(h, timeZone, h.snippet));
  const seenBody = new Set();
  const bodyExtra = [];
  for (const it of bodyOnly) {
    if (seenBody.has(it.key)) continue;
    seenBody.add(it.key);
    bodyExtra.push(it);
  }

  // 列表 = 已分析的命中 + 仅信封命中 + 正文命中（未分析），全部保留后再按上限截断
  const allItems = [...matched.map((r) => toResultItem(r, timeZone)), ...envelopeOnly, ...bodyExtra];
  const totalMatched = allItems.length;
  const finalItems = allItems.slice(0, filters.limit);
  /** 命中数超过可展示上限 → 必须如实标注，绝不静默少给 */
  const listTruncated = totalMatched > finalItems.length;

  /*
   * 结果分析：只把有界的子集交给模型，并如实告知「结论基于哪些邮件、覆盖到哪」。
   *
   * 视野分两层，额度闸门只有第一层：
   *   ① 带摘录：最多 ANALYSIS_BASIS_LIMIT（40）封——「结论范围」策略决定取**哪** 40 封；
   *   ② 只给标题与时间：再最多 ANALYSIS_HEADLINE_LIMIT（40）封，仅供判断话题分布。
   * 策略永远不改变 ① 的条数，只改变它覆盖的时间段——所以换策略不会放大模型额度。
   */
  const basisChoice = normalizeBasis(basisStrategy);
  const basisSelect = selectBasisItems(finalItems, {
    strategy: basisChoice.strategy,
    limit: ANALYSIS_BASIS_LIMIT,
    maxPerMonth: BASIS_MONTHLY_PER_MONTH,
    timeZone,
  });
  const answerItems = basisSelect.items;
  const answerSet = new Set(answerItems);
  const headlineItems = finalItems.filter((it) => !answerSet.has(it)).slice(0, ANALYSIS_HEADLINE_LIMIT);
  const analyzedCount = finalItems.filter((it) => it.analyzed).length;
  const analysisBasis = {
    ...describeBasis({
      strategy: basisSelect.strategy,
      count: answerItems.length,
      limit: ANALYSIS_BASIS_LIMIT,
      months: basisSelect.months,
      maxPerMonth: BASIS_MONTHLY_PER_MONTH,
      coveredFrom: basisSelect.coveredFrom,
      coveredTo: basisSelect.coveredTo,
      matched: finalItems.length,
      headlines: headlineItems.length,
      /* 列表顺序如实带出去：priority / date_asc 时 `recent` 的「最近」说法要被改写成「列表前」 */
      order: sortKey === 'date_asc' ? 'date_asc' : sortKey === 'priority' ? 'priority' : 'date_desc',
    }),
    /** 带摘录的这批里有几封有模型摘要（其余只有信封信息） */
    analyzed: answerItems.filter((it) => it.analyzed).length,
    /** 命中里共有多少个自然月（用于核对「按月节选」是否真的每月都有代表） */
    rangeMonths: basisSelect.rangeMonths,
    /** 每个自然月实际选中的封数（仅 monthly 有值） */
    monthCounts: basisSelect.monthCounts,
    /** 有没有命中没拿到摘录（即结论视野小于命中范围）——界面必须说清 */
    excerptPartial: answerItems.length < finalItems.length,
    /** 连「标题+时间」都没装下的命中（模型完全没看到） */
    partial: answerItems.length + headlineItems.length < finalItems.length,
    /** 带摘录子集的硬上限（额度与上下文长度控制） */
    maxAnalyzed: Math.min(ANALYSIS_BASIS_LIMIT, finalItems.length),
    /** 请求里的策略值不合法时回落并说明（绝不静默改口径） */
    requested: basisChoice.requested,
    fellBack: basisChoice.fellBack,
    note: basisChoice.note,
  };
  const answerMails = answerItems.map((it) => ({
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
  const headlineMails = headlineItems.map((it) => ({
    subject: it.subject,
    date: it.day,
    from: it.from?.name ? `${it.from.name} <${it.from.address}>` : it.from?.address || '未知',
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
          headlines: headlineMails,
          now: nowContext(now, timeZone),
          timeZone,
          stats: {
            matched: totalMatched,
            basis: analysisBasis.count,
            analyzed: analysisBasis.analyzed,
            hasUnanalyzed: analysisBasis.count > analysisBasis.analyzed,
            partial: analysisBasis.partial,
            analysisOrder: analysisBasis.order,
            /** 结论范围口径（策略名 + 覆盖区间），提示词与界面用同一份文案 */
            scope: analysisBasis,
          },
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
      assistant = localSummary(finalItems, understood, analysisBasis);
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
      /** 超出 1 年上限被收敛时给出可直接展示的说明 */
      rangeNote: filters.rangeClamped
        ? `你要的起始日期 ${filters.requestedFrom} 超出了最长 ${MAX_WINDOW_DAYS} 天（约 1 年）的范围，已按 ${filters.dateFrom} 起检索；更早的邮件请缩短问题里的时间跨度后分次查询。`
        : '',
    },
    items: finalItems,
    stats: {
      matched: totalMatched,
      /** 本次实际列出的条数；小于 matched 时 truncated 为 true */
      listed: finalItems.length,
      truncated: listTruncated,
      /** 列表展示上限（来自请求，默认给足） */
      listLimit: filters.limit,
      /** 命中里带模型摘要（已分析）的封数 */
      analyzed: analyzedCount,
      /** 命中里只有信封（未分析、无摘要）的封数 */
      envelopeOnly: finalItems.filter((it) => it.source === 'envelope').length,
      /** 结论依据的封数（带摘录的有界子集） */
      basis: analysisBasis.count,
      scanned: all.length,
      coverage: totals,
      bodyHits: bodyHits.length,
      sort: sortKey,
      analysisBasis,
      backfill: backfill
        ? {
            attempted: !!backfill.attempted,
            rangeExpanded: !!backfill.attempted && !backfill.failed,
            fetched: backfill.fetched || 0,
            analyzed: backfill.analyzed || 0,
            /** 命中数超过回补分析额度 → 只有部分邮件有摘要（列表仍然完整） */
            truncated: !!backfill.truncated,
            /** 信封扫描本身达到上限 → 范围内还有邮件没被扫到，列表可能不全 */
            scanTruncated: !!backfill.scanTruncated,
            /** 本次是否复用了上一次信封扫描的结果（本地已覆盖该范围时不再重扫邮箱） */
            envelopeReused: !!backfill.envelopeReused,
            scanned: backfill.scanned || 0,
            unscanned: backfill.unscanned || 0,
            /** 本次从 IMAP 取到的 UID 总数；截断时 scanned + unscanned === scanTotal */
            scanTotal: backfill.scanTotal || 0,
            scanLimit: backfill.scanLimit || 0,
            failed: !!backfill.failed,
            errors: backfill.errors || [],
          }
        : null,
    },
    /**
     * 结论依据的有界性与列表截断说明，界面直接展示。
     * `basis` 与 `analysisBasis` 是同一份口径（`basis` 为规范名，`analysisBasis` 保留向后兼容）。
     */
    analysisBasis,
    basis: analysisBasis,
    truncationNote: buildTruncationNote({
      stats: {
        matched: totalMatched,
        listed: finalItems.length,
        envelopeOnly: finalItems.filter((it) => it.source === 'envelope').length,
      },
      backfill,
    }),
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

function localSummary(items, understood, basis) {
  const lines = [understood ? `检索条件：${understood}` : '', `共找到 ${items.length} 封邮件：`, ''];
  for (const it of items.slice(0, 15)) {
    lines.push(`- [${it.day}] ${it.from?.name || it.from?.address || '未知'}：${it.subject}`);
    if (it.summary) lines.push(`  ${it.summary}`);
    else lines.push('  （仅信封命中，无摘要）');
  }
  if (items.length > 15) lines.push(`（列表已截断显示前 15 条，共 ${items.length} 条）`);
  // 口径用与提示词/界面同一份文案（scope.line），降级摘要也不能换一种说法
  if (basis?.line) lines.push('', `${basis.line}；命中共 ${basis.matched ?? items.length} 封。`);
  else if (basis) lines.push('', `以上依据列表前 ${basis.count} 封（${basis.orderLabel ? `按${basis.orderLabel}` : `按时间${basis.order === 'date_asc' ? '正序' : '倒序'}`}）。`);
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
