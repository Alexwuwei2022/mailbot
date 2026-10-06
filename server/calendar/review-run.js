/**
 * 日历回顾分析：把「请分析过去 30 天的日历并给优化建议」变成一份可导出的报告。
 *
 * 流程（与邮件侧的对话式检索同构）：
 *   1. 模型解析意图 → 只得到 `{preset, from, to, focus}`，**不让模型算时间**；
 *   2. 程序按配置时区解析出确定区间，分页取全部日程；
 *   3. 程序本地聚合出统计量（忙碌时长、深度块、晚间/周末会…）；
 *   4. 模型只依据这些统计写叙述，**不许碰原始数据**；
 *   5. 报告 = 叙述 + 统计附录 + 日程清单，落盘成 md（复用简报的下载链路）。
 *
 * 这样做的两个直接好处：成本可控（提示词只有几 KB），以及**结论可复现**——
 * 同一份数据每次算出的"平均每工作日 3.2 场会"是同一个数。
 */

import { getConfig } from '../config/index.js';
import { AppError, log } from '../lib/util.js';
import { LlmClient } from '../llm/client.js';
import * as store from '../store/state.js';
import { CALENDAR_REVIEW_INTENT_SYSTEM, CALENDAR_REVIEW_SYSTEM, buildCalendarReviewPrompt } from './prompts.js';
import { listAllEvents } from './google-api.js';
import { aggregateCalendar, describeExcluded } from './review.js';
import { connectionStatus } from './google-auth.js';
import { nowContext, resolveReviewRange, REVIEW_PRESETS } from './time.js';

/** 模型解析出来的意图做一次"消毒"：只接受白名单内的预设，其余一律回落到默认。 */
function sanitizeIntent(raw, fallbackPreset = 'last-30d') {
  const valid = new Set(REVIEW_PRESETS.map((p) => p.id));
  const preset = valid.has(String(raw?.preset)) ? String(raw.preset) : fallbackPreset;
  const focusList = Array.isArray(raw?.focus) ? raw.focus.map(String) : [];
  const allowedFocus = ['time-allocation', 'meeting-load', 'focus-time', 'conflicts', 'work-life', 'people'];
  const focus = focusList.filter((f) => allowedFocus.includes(f));
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  return {
    preset,
    from: isDate(raw?.from) ? String(raw.from) : null,
    to: isDate(raw?.to) ? String(raw.to) : null,
    focus: focus.length ? focus : ['time-allocation', 'meeting-load', 'focus-time', 'work-life'],
    reason: String(raw?.reason || '').slice(0, 200),
  };
}

/** 本地兜底摘要：模型挂了也要把数字给用户，只是没有叙述。 */
function localReviewSummary(agg) {
  const t = agg.totals;
  const lines = [];
  lines.push('## 一句话总结');
  lines.push(`${agg.range.label}共占用 ${t.busyHours} 小时，其中工作 ${t.workBusyHours} 小时、生活/个人事务 ${t.lifeHours} 小时。`);
  lines.push('');
  lines.push('## 时间去哪了');
  lines.push(`- **总占用 ${t.busyHours} 小时**（占工作表时段约 ${t.occupancyRatio}%，平均每工作日 ${t.busyHoursPerWorkday} 小时）`);
  lines.push(`- 工作负荷 ${t.workBusyHours} 小时：会议 ${t.meetingHours}、独自工作 ${t.workHours}、专注时间块 ${t.focusHours}`);
  lines.push(
    `- 生活/个人事务 ${t.lifeHours} 小时（${t.lifeEntryCount} 项，占总占用 ${t.lifeShareOfBusy}%）` +
      (t.oooDays ? `，另有休假/外出 ${t.oooDays} 天` : ''),
  );
  if (agg.lifeKinds?.length) lines.push(`- 生活分类：${agg.lifeKinds.slice(0, 4).map((l) => `${l.name} ${l.hours}h`).join('、')}`);
  if (agg.topics.length) lines.push(`- 工作主题：${agg.topics.slice(0, 4).map((x) => `${x.topic} ${x.count} 项`).join('、')}`);
  lines.push('');
  lines.push('## 会议负荷与节奏');
  lines.push(`- 每个工作日平均 ${t.meetingsPerWorkday} 场会、${t.meetingHoursPerWorkday} 小时（占工作表时段 ${t.meetingLoadRatio}%）`);
  if (agg.weekly.length) {
    const first = agg.weekly[0];
    const last = agg.weekly[agg.weekly.length - 1];
    lines.push(`- 首周总占用 ${first.busyHours}h / ${first.meetingCount} 场会 → 末周 ${last.busyHours}h / ${last.meetingCount} 场会`);
  }
  lines.push('');
  lines.push('## 结构性问题');
  const s = agg.structure;
  lines.push(`- 晚间占用 ${s.eveningCount} 条（会议 ${s.eveningMeetings.length} / 独自工作 ${s.eveningWork.length} / 生活 ${s.eveningLife?.length || 0}）`);
  lines.push(`- 周末占用 ${s.weekendCount} 条（会议 ${s.weekendMeetings.length} / 独自工作 ${s.weekendWork.length} / 生活 ${s.weekendLife?.length || 0}）`);
  lines.push(`- 超长会议 ${s.longMeetings.length} 场、连续会议 ${s.backToBack.length} 处、冲突 ${s.conflicts.length} 处`);
  lines.push(`- 无日程占用的整块时间 ${s.deepBlockCount} 段、完全没有会议记录的工作日 ${s.meetingFreeWorkdays} 天`);
  lines.push('');
  lines.push('## 可执行的优化建议');
  lines.push('（本次未能生成 AI 建议，以上为本地统计。可稍后重试。）');
  return lines.join('\n');
}

/** 统计附录（Markdown 表格），导出的 md 里附在叙述之后。 */
export function buildReviewAppendix(agg) {
  const lines = [];
  lines.push('## 附录 A：统计明细');
  lines.push('');
  lines.push('### 口径');
  lines.push('');
  lines.push(`- 区间：${agg.range.from} ~ ${agg.range.to}（${agg.range.days} 天，工作日 ${agg.totals.workdays} 天）`);
  lines.push(`- 时区：${agg.timeZone}`);
  lines.push(`- 日历条目 ${agg.source.totalEntries} 条 → **占用时间 ${agg.source.occupied} 条**，未计入占用 ${agg.source.excluded} 条`);
  lines.push(`- 未计入占用的明细：${describeExcluded(agg.source)}`);
  lines.push(
    `- 占用构成：会议 ${agg.source.meetings}、独自工作 ${agg.source.workBlocks}、` +
      `**生活/个人事务 ${agg.source.lifeCount}**、专注 ${agg.source.focus}、全天事项 ${agg.source.allDay}` +
      (agg.source.oooDays ? `；另有休假/外出 ${agg.source.oooDays} 天（按天计）` : ''),
  );
  if (agg.source.meetingsByTitle) {
    lines.push(`- 会议识别：有参会人的 ${agg.source.meetingsByAttendees} 场、按标题识别的 ${agg.source.meetingsByTitle} 场（该日历用标题记录与会对象）`);
  }
  if (agg.source.sparse) {
    lines.push(
      `- ⚠️ 记录偏稀疏：总占用只占工作表时段的 ${agg.totals.occupancyRatio}%，` +
        `说明只有一部分事写进了日历。「无日程占用的整块时间」应理解为"未记录的时间"，不等于真实空闲。`,
    );
  }
  lines.push('- **两个视角**：总占用 = 工作 + 生活；工作负荷 = 会议 + 独自工作 + 专注时间（不含生活）');
  lines.push('- 占用时长按区间并集计算（重叠不重复累加）；全天事项只计条数、不计小时');
  lines.push('');
  lines.push('### 总览');
  lines.push('');
  lines.push('| 指标 | 数值 |');
  lines.push('| --- | --- |');
  lines.push(`| **总占用** | **${agg.totals.busyHours} 小时**（占工作表时段 ${agg.totals.occupancyRatio}%） |`);
  lines.push(`| 　工作负荷 | ${agg.totals.workBusyHours} 小时（占工作表时段 ${agg.totals.workloadLoadRatio}%） |`);
  lines.push(`| 　生活/个人事务 | ${agg.totals.lifeHours} 小时（${agg.totals.lifeEntryCount} 项，占总占用 ${agg.totals.lifeShareOfBusy}%） |`);
  if (agg.totals.oooDays) lines.push(`| 　休假/外出 | ${agg.totals.oooDays} 天 |`);
  lines.push(`| 会议场次 | ${agg.totals.meetingCount} |`);
  lines.push(`| 会议时长 | ${agg.totals.meetingHours} 小时 |`);
  lines.push(`| 独自工作 | ${agg.totals.workBlockCount} 段 / ${agg.totals.workHours} 小时 |`);
  lines.push(`| 专注时间块 | ${agg.totals.focusHours} 小时 |`);
  lines.push(`| 每工作日平均会议 | ${agg.totals.meetingsPerWorkday} 场 |`);
  lines.push(`| 每工作日平均总占用 | ${agg.totals.busyHoursPerWorkday} 小时 |`);
  lines.push(`| 会议占工作时段 | ${agg.totals.meetingLoadRatio}% |`);
  lines.push('');
  if (agg.lifeKinds?.length) {
    lines.push('### 生活/个人事务分类');
    lines.push('');
    lines.push('| 类别 | 项数 | 小时 | 例子 |');
    lines.push('| --- | --- | --- | --- |');
    for (const l of agg.lifeKinds) lines.push(`| ${l.name} | ${l.count} | ${l.hours} | ${(l.samples || []).join('、')} |`);
    lines.push('');
  }
  lines.push('### 按周');
  lines.push('');
  lines.push('| 周 | 会议场次 | 总占用小时 | 每工作日会议 |');
  lines.push('| --- | --- | --- | --- |');
  for (const w of agg.weekly) lines.push(`| ${w.week} | ${w.meetingCount} | ${w.busyHours} | ${w.meetingsPerWorkday} |`);
  lines.push('');
  if (agg.topRecurring.length) {
    lines.push('### 占用最多的重复日程');
    lines.push('');
    lines.push('| 日程 | 次数 | 合计小时 |');
    lines.push('| --- | --- | --- |');
    for (const r of agg.topRecurring) lines.push(`| ${r.summary} | ${r.count} | ${r.hours} |`);
    lines.push('');
  }
  if (agg.topPeople.length) {
    lines.push('### 与我开会最多的人');
    lines.push('');
    lines.push('| 人 | 次数 | 合计小时 |');
    lines.push('| --- | --- | --- |');
    for (const p of agg.topPeople) lines.push(`| ${p.name} | ${p.count} | ${p.hours} |`);
    lines.push('');
  }
  const s = agg.structure;
  lines.push('### 结构性问题');
  lines.push('');
  for (const [label, list, fmt] of [
    ['晚间会议', s.eveningMeetings, (x) => `${x.at} ${x.summary}`],
    ['周末会议', s.weekendMeetings, (x) => `${x.at} ${x.summary}`],
    ['超长会议', s.longMeetings, (x) => `${x.at} ${x.summary}（${x.minutes} 分钟）`],
    ['连续会议', s.backToBack, (x) => `${x.day} 间隔 ${x.gap} 分钟：${x.from} → ${x.to}`],
    ['时间冲突', s.conflicts, (x) => `${x.day} 重叠 ${x.overlapMin} 分钟：${x.a} × ${x.b}`],
  ]) {
    lines.push(`- **${label}**：${list.length} 处`);
    for (const item of list.slice(0, 20)) lines.push(`  - ${fmt(item)}`);
    if (list.length > 20) lines.push(`  - …另有 ${list.length - 20} 处`);
  }
  if (s.deepBlocks.length) {
    const total = Math.round((s.deepBlocks.reduce((sum, b) => sum + b.minutes, 0) / 60) * 10) / 10;
    lines.push(`- **整块深度工作时间**：${s.deepBlocks.length} 段，合计约 ${total} 小时`);
    for (const b of s.deepBlocks.slice(0, 15)) lines.push(`  - ${b.day} ${b.start}-${b.end}（${b.minutes} 分钟）`);
    if (s.deepBlocks.length > 15) lines.push(`  - …另有 ${s.deepBlocks.length - 15} 段`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Unicode 条形图。
 *
 * 为什么用字符画而不是真图：导出的是一份**独立 .md 文件**，可能在记事本、邮件正文、
 * 钉钉、GitHub、Obsidian 任何地方打开。字符条在哪里都能看、可直接复制，文件也保持自包含。
 *
 * 两个刻意的取舍：
 *   - **数字放在最前面**：万一查看器用等宽以外字体（条会错位），数字仍然读得出来；
 *   - **不用代码围栏**：不依赖渲染器支持 fenced code，避免在纯文本环境里看到一堆反引号。
 */
function bar(value, max, { width = 24, unit = 'h', digits = 1 } = {}) {
  const v = Number(value) || 0;
  const n = max > 0 ? Math.round((v / max) * width) : 0;
  const filled = v > 0 ? Math.max(1, n) : 0; // 有值至少给一格，避免"有数据却看不见"
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
}

function padLabel(text, len) {
  const s = String(text ?? '');
  // 中文按两格宽算，这样纯文本里各列能对齐
  const width = [...s].reduce((sum, ch) => sum + (/[\u4e00-\u9fa5（）【】]/.test(ch) ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, len - width));
}

/** 生成"图表"附录：按周负荷、时间构成、主题、人名、时长分布。 */
export function buildReviewCharts(agg) {
  const lines = [];
  lines.push('## 附录 C：图表（字符条）');
  lines.push('');

  const weekly = (agg.weekly || []).filter((w) => w.meetingCount || w.busyHours);
  if (weekly.length) {
    const max = Math.max(...weekly.map((w) => w.busyHours || 0), 0);
    lines.push(`**按周工作负荷**（█ 每格约 ${max > 0 ? Math.round((max / 24) * 10) / 10 : 0}h，最长为 ${max}h）`);
    lines.push('');
    for (const w of weekly) {
      const meeting = w.meetingHours || 0;
      const work = Math.max(0, Math.round(((w.busyHours || 0) - meeting) * 10) / 10);
      lines.push(`${padLabel(`${w.busyHours}h`, 7)}${bar(w.busyHours, max)}  ${padLabel(w.week, 20)}会议 ${meeting}h / 独自 ${work}h`);
    }
    lines.push('');
  }

  const t = agg.totals || {};
  /*
   * 时间构成要**同时包含生活**：用户记日历就是为了标记"这段时间我占用了"，
   * 只画工作部分会让"打羽毛球 9 小时"凭空消失。
   */
  const parts = [
    { name: '会议', value: t.meetingHours || 0 },
    { name: '独自工作', value: t.workHours || 0 },
    { name: '专注块', value: t.focusHours || 0 },
    { name: '生活/个人', value: t.lifeHours || 0 },
  ].filter((x) => x.value > 0);
  const total = parts.reduce((s, x) => s + x.value, 0);
  if (total > 0) {
    lines.push('**时间构成（总占用）**');
    lines.push('');
    for (const p of parts) {
      lines.push(`${padLabel(`${p.value}h`, 7)}${bar(p.value, total)}  ${padLabel(p.name, 12)}${Math.round((p.value / total) * 100)}%`);
    }
    lines.push('');
  }

  const lifeKinds = agg.lifeKinds || [];
  if (lifeKinds.length) {
    const max = Math.max(...lifeKinds.map((l) => l.hours || 0), 0);
    lines.push('**生活/个人事务花在哪**（小时）');
    lines.push('');
    for (const l of lifeKinds) {
      lines.push(`${padLabel(`${l.hours}h`, 7)}${bar(l.hours, max)}  ${padLabel(l.name, 14)}${l.count} 项`);
    }
    lines.push('');
  }

  const topics = agg.topics || [];
  if (topics.length) {
    const max = Math.max(...topics.map((x) => x.count || 0), 0);
    lines.push('**主题分布**（项）');
    lines.push('');
    for (const x of topics.slice(0, 10)) lines.push(`${padLabel(String(x.count), 4)}${bar(x.count, max, { unit: '' })}  ${x.topic}`);
    lines.push('');
  }

  const people = agg.topPeople || [];
  if (people.length) {
    const max = Math.max(...people.map((p) => p.hours || 0), 0);
    lines.push('**占用时间最多的人**（小时；来源为活动标题解析或参与人）');
    lines.push('');
    for (const p of people.slice(0, 10)) {
      lines.push(`${padLabel(`${p.hours}h`, 7)}${bar(p.hours, max)}  ${padLabel(p.name, 14)}${p.count} 次${p.via === 'title' ? '（标题）' : ''}`);
    }
    lines.push('');
  }

  const durations = agg.durations || [];
  if (durations.length) {
    const max = Math.max(...durations.map((d) => d.count || 0), 0);
    lines.push('**活动时长分布**（项）');
    lines.push('');
    for (const d of durations) lines.push(`${padLabel(String(d.count), 4)}${bar(d.count, max, { unit: '' })}  ${padLabel(d.label, 22)}${d.hours}h`);
    lines.push('');
  }

  const loc = agg.locations?.counts;
  if (loc) {
    const kn = { virtual: '线上', onsite: '线下（有地点）', unknown: '未填地点' };
    lines.push(`**地点**：${Object.entries(loc).map(([k, v]) => `${kn[k] || k} ${v}`).join('、')}`);
    if (agg.locations.top?.length) lines.push(`**最常去的地点**：${agg.locations.top.map((x) => `${x.name}（${x.count}）`).join('、')}`);
    lines.push('');
  }

  const sparse = agg.source?.sparse;
  if (sparse) {
    lines.push(`> 注：这段时间总占用只占工作表时段的 ${t.occupancyRatio ?? 0}%，说明只有一部分事情写进了日历；`);
    lines.push('> 因此"未记录的时间"不等于真实空闲，图表反映的是**日历记录**而非全部时间分布。');
    lines.push('');
  }

  return lines.join('\n');
}

/** 日程清单附录。 */
export function buildReviewTimeline(agg) {
  const lines = [];
  lines.push('## 附录 B：日程清单');
  lines.push('');
  if (!agg.timeline.length) {
    lines.push('_这段时间没有任何日程记录。_');
    return lines.join('\n');
  }
  const kindLabel = { meeting: '会议', personal: '个人', focus: '专注', allDay: '全天', work: '独自工作', life: '生活', ooo: '休假/外出' };
  for (const d of agg.timeline) {
    lines.push(`### ${d.label}${d.isWorkday ? '' : '（非工作日）'}`);
    lines.push('');
    if (!d.items.length) {
      lines.push('- 无安排');
      lines.push('');
      continue;
    }
    for (const it of d.items) {
      const time = it.start === '全天' ? '全天' : `${it.start}-${it.end}`;
      const meta = [kindLabel[it.kind] || it.kind, it.minutes ? `${it.minutes} 分钟` : null, it.people ? `${it.people} 人` : null]
        .filter(Boolean)
        .join('，');
      lines.push(`- ${time} ${it.summary}（${meta}）`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * 执行一次回顾分析。
 *
 * @param {object} input { query, now, preset, from, to }
 * @returns {Promise<object>}
 */
export async function runCalendarReview({ query = '', now = new Date(), preset, from, to } = {}) {
  const config = getConfig();
  if (!config.calendar.enabled) {
    throw new AppError('日历功能未启用。请到「设置 → 日历」开启后再试。', { code: 'CALENDAR_DISABLED', status: 400 });
  }
  const status = connectionStatus();
  if (!status.connected) {
    throw new AppError('Google 日历尚未授权。请到「日历」页点「连接 Google 日历」完成授权后再试。', {
      code: 'CALENDAR_NOT_CONNECTED',
      status: 400,
    });
  }

  const text = String(query || '').trim();
  const timeZone = config.calendar.timeZone;
  const client = new LlmClient(config.llm);
  const started = Date.now();

  /* ---- 1. 意图：能直接给参数就跳过模型；否则让模型解析 ---- */
  let intent;
  if (preset) {
    intent = sanitizeIntent({ preset, from, to }, preset);
  } else if (!text) {
    throw new AppError('请输入要回顾的内容，例如「请详细分析过去 30 天的日历并给出工作优化建议」', {
      code: 'EMPTY_QUERY',
      status: 400,
    });
  } else if (!client.ready) {
    // 模型不可用时不再报错：用默认区间给出**本地统计**，比什么都不给有用
    log.warn('大模型未就绪，日历回顾将只返回本地统计');
    intent = sanitizeIntent({ preset: 'last-30d', reason: '模型未就绪，使用默认区间' });
  } else {
    const { text: raw } = await client.complete({
      system: CALENDAR_REVIEW_INTENT_SYSTEM,
      user: `## 当前时间\n${nowContext(now, timeZone).local}（${nowContext(now, timeZone).weekday}）\n时区：${timeZone}\n\n## 用户的话\n${text}`,
      temperature: 0,
      maxTokens: 400,
      jsonMode: true,
      label: '日历回顾意图',
    });
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.warn(`日历回顾意图解析失败，回落到默认区间：${String(raw).slice(0, 120)}`);
    }
    intent = sanitizeIntent(parsed || { preset: 'last-30d' });
  }

  /* ---- 2. 区间（程序解析，模型只给 id） ---- */
  let range = resolveReviewRange({ preset: intent.preset, from: intent.from, to: intent.to, now, timeZone });
  const maxDays = config.calendar.review.maxRangeDays;
  let clamped = false;
  if (range.days > maxDays) {
    // 超长区间收敛到上限，并如实告知
    range = resolveReviewRange({ preset: 'last-30d', now, timeZone });
    range = { ...range, label: `${range.label}（请求区间过长，已收敛到 ${maxDays} 天内）` };
    clamped = true;
  }

  /* ---- 3. 取数（分页）+ 聚合 ---- */
  const fetched = await listAllEvents({
    timeMin: range.start,
    timeMax: range.end,
    maxTotal: config.calendar.review.maxEvents,
  });
  const aggregate = aggregateCalendar({ events: fetched.items, range, timeZone });
  aggregate.workdayStart = config.calendar.review.workdayStart;
  aggregate.workdayEnd = config.calendar.review.workdayEnd;
  aggregate.eveningAfterHour = config.calendar.review.eveningAfterHour;

  /* ---- 4. 叙述 ---- */
  let analysis = null;
  let analysisError = null;
  if (client.ready) {
    try {
      const { text: out } = await client.complete({
        system: CALENDAR_REVIEW_SYSTEM,
        user: buildCalendarReviewPrompt({ range, aggregate, focus: intent.focus }),
        temperature: 0.35,
        maxTokens: 2000,
        jsonMode: false,
        label: '日历回顾分析',
      });
      analysis = String(out || '').trim() || null;
    } catch (err) {
      analysisError = err?.message || String(err);
      log.warn(`日历回顾分析生成失败：${analysisError}`);
    }
  }
  if (!analysis) analysis = localReviewSummary(aggregate);

  /* ---- 5. 落盘成可导出的 md ---- */
  const header = [
    `# 日程回顾分析 · ${range.label}`,
    '',
    `> 区间：${range.from} ~ ${range.to}（${range.days} 天） ｜ 时区：${timeZone} ｜ 生成：${new Date().toISOString()}`,
    `> 数据：日历条目 ${aggregate.source.totalEntries} 条 → 计入 ${aggregate.source.counted} 条，排除 ${aggregate.source.excluded} 条（${describeExcluded(aggregate.source)}）`,
    fetched.truncated ? `> ⚠️ 日程数超过单次上限 ${fetched.maxTotal} 条，本次只分析了前 ${fetched.fetched} 条` : null,
    clamped ? `> ⚠️ 请求的区间过长，已收敛到 ${maxDays} 天内` : null,
    analysisError ? `> ⚠️ AI 叙述生成失败（${analysisError}），以下为本地统计` : null,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  // 顺序：叙述（结论）→ 图表（直觉）→ 统计明细（核对）→ 日程清单（原始记录）
  const markdown = [
    header,
    analysis,
    '',
    '---',
    '',
    buildReviewCharts(aggregate),
    '',
    '---',
    '',
    buildReviewAppendix(aggregate),
    '',
    '---',
    '',
    buildReviewTimeline(aggregate),
  ].join('\n');

  const report = store.saveReport({
    instanceId: config.defaultInstanceId,
    runId: null,
    markdown,
    meta: {
      kind: 'calendar-review',
      windowHours: range.days * 24,
      range: { from: range.from, to: range.to, days: range.days, preset: intent.preset },
      total: aggregate.source.totalEntries,
      meetings: aggregate.totals.meetingCount,
    },
  });
  store.persistState();

  return {
    query: text,
    understood: {
      preset: intent.preset,
      rangeLabel: range.label,
      from: range.from,
      to: range.to,
      days: range.days,
      focus: intent.focus,
      reason: intent.reason,
    },
    range: aggregate.range,
    source: aggregate.source,
    excludedNote: describeExcluded(aggregate.source),
    totals: aggregate.totals,
    structure: {
      deepBlockCount: aggregate.structure.deepBlockCount,
      deepBlockHours: Math.round((aggregate.structure.deepBlocks.reduce((s, b) => s + b.minutes, 0) / 60) * 10) / 10,
      meetingFreeWorkdays: aggregate.structure.meetingFreeWorkdays,
      eveningMeetings: aggregate.structure.eveningMeetings.length,
      weekendMeetings: aggregate.structure.weekendMeetings.length,
      longMeetings: aggregate.structure.longMeetings.length,
      backToBack: aggregate.structure.backToBack.length,
      conflicts: aggregate.structure.conflicts.length,
      details: aggregate.structure,
    },
    weekly: aggregate.weekly,
    topPeople: aggregate.topPeople,
    topRecurring: aggregate.topRecurring,
    topics: aggregate.topics,
    /** 时长分层（界面图表与导出都会用） */
    durations: aggregate.durations,
    /** 生活事务分类（运动健身/家庭陪伴/个人事务…） */
    lifeKinds: aggregate.lifeKinds,
    /** 地点：线上/线下/未填 + Top 地点 */
    locations: aggregate.locations,
    /** 逐日统计（热力图用） */
    dayStats: aggregate.dayStats,
    timeline: aggregate.timeline,
    analysis,
    analysisError,
    reportId: report.id,
    reportFile: report.file,
    fetch: { pages: fetched.pages, fetched: fetched.fetched, truncated: fetched.truncated, maxTotal: fetched.maxTotal },
    elapsedMs: Date.now() - started,
  };
}
