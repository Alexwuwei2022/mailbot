/**
 * 日历数字人核心逻辑：
 *   1) 对话建日程（自然语言 → 结构化 → 冲突检查 → 待确认 → 写入）
 *   2) 邮件转日程（从已分析邮件里提取时间信息 → 待确认 → 写入）
 *   3) 今日 / 明日 / 最近 N 天的日程获取与程序化统计 + 模型分析
 *
 * 所有写操作都先产出「待确认草稿」，由用户在界面上确认后才真正调用 Google Calendar，
 * 与邮件发送的「人工确认」策略保持一致。
 */

import { getConfig } from '../config/index.js';
import { runScan } from '../ai/engine.js';
import { AppError, clampNumber, log, truncate } from '../lib/util.js';
import { LlmClient } from '../llm/client.js';
import * as store from '../store/state.js';
import * as gcal from './google-api.js';
import { appendAudit, listAudit } from '../store/audit.js';
import {
  CALENDAR_ANALYSIS_SYSTEM,
  EMAIL_TO_EVENT_SYSTEM,
  EXTRACT_SYSTEM,
  buildCalendarAnalysisPrompt,
  buildEmailEventPrompt,
  buildExtractPrompt,
} from './prompts.js';
import {
  addDays,
  buildWindows,
  dayKey,
  formatInZone,
  nowContext,
  parseCalendarTime,
  startOfDay,
  toRfc3339,
  zhWeekday,
  partsInZone,
} from './time.js';

const SESSION_TTL_MS = 2 * 60 * 60_000;
const DEFAULT_DURATION_MIN = 60;

/* ================================================================ 时间解析 */

function pad(n) {
  return String(n).padStart(2, '0');
}

function localString(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`;
}

function localDateString(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * 把模型输出的「本地墙上时间」草稿解析成可写入日历的事件。
 * 不接受模型给出的时区换算结果，一律按配置时区解释本地时间。
 *
 * @returns {{ok: boolean, problems: string[], event?: object}}
 */
export function resolveEventDraft(raw, { timeZone, defaults = {} } = {}) {
  const problems = [];
  const input = raw && typeof raw === 'object' ? raw : {};
  const summary = String(input.summary || '').trim();
  if (!summary) problems.push('缺少日程标题');

  const allDay = input.allDay === true || (!input.startLocal && !!input.allDayStart);
  const duration = clampNumber(input.durationMinutes, 5, 24 * 60, defaults.durationMinutes || DEFAULT_DURATION_MIN);

  let start = null;
  let end = null;
  let allDayStart = null;
  let allDayEnd = null;

  if (allDay) {
    const startStr = input.allDayStart || (input.startLocal ? String(input.startLocal).slice(0, 10) : null);
    if (!startStr) problems.push('缺少日期');
    else {
      const parsed = parseCalendarTime(startStr, timeZone);
      if (!parsed) problems.push(`无法识别的日期：${startStr}`);
      else {
        allDayStart = localDateString(parsed.date, timeZone);
        // 全天事件的结束日期是「次日」（日历排他语义）
        const endParsed = input.allDayEnd ? parseCalendarTime(input.allDayEnd, timeZone) : null;
        allDayEnd = endParsed ? localDateString(endParsed.date, timeZone) : localDateString(addDays(parsed.date, 1, timeZone));
        if (allDayEnd <= allDayStart) allDayEnd = localDateString(addDays(parsed.date, 1, timeZone));
      }
    }
  } else {
    const parsedStart = input.startLocal ? parseCalendarTime(input.startLocal, timeZone) : null;
    if (!parsedStart) problems.push(input.startLocal ? `无法识别的开始时间：${input.startLocal}` : '缺少开始时间');
    else {
      start = parsedStart.date;
      const parsedEnd = input.endLocal ? parseCalendarTime(input.endLocal, timeZone) : null;
      if (parsedEnd) {
        end = parsedEnd.date;
        if (end.getTime() <= start.getTime()) {
          // 模型把结束时间算错时，容忍并改为按默认时长（而不是直接失败）
          end = new Date(start.getTime() + duration * 60_000);
          problems.push('结束时间早于开始时间，已按默认时长调整');
        }
      } else {
        end = new Date(start.getTime() + duration * 60_000);
      }
    }
  }

  const attendees = Array.isArray(input.attendees)
    ? input.attendees
        .map((a) => (typeof a === 'string' ? { email: a } : { email: String(a?.email || '').trim(), displayName: a?.displayName || '' }))
        .filter((a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a.email))
    : [];

  const event = {
    summary,
    allDay,
    allDayStart,
    allDayEnd,
    start,
    end,
    durationMinutes: allDay ? null : Math.round((end && start ? end - start : duration * 60_000) / 60_000),
    location: String(input.location || '').trim(),
    description: String(input.description || '').trim(),
    attendees,
    reminders: Array.isArray(input.reminders) ? input.reminders.map(Number).filter((n) => Number.isFinite(n)) : undefined,
    timeZone,
    confidence: typeof input.confidence === 'number' ? Math.max(0, Math.min(1, input.confidence)) : null,
    assumptions: Array.isArray(input.assumptions) ? input.assumptions.map(String).slice(0, 5) : [],
    reason: typeof input.reason === 'string' ? input.reason.trim() : '',
  };

  const hard = problems.filter((p) => !p.includes('已按默认时长调整'));
  return { ok: hard.length === 0, problems, hardProblems: hard, event: hard.length === 0 ? event : undefined };
}

/** 把事件转成界面/模型都好用的展示形态（本地时间字符串）。 */
export function presentEvent(event, timeZone) {
  const tz = timeZone || event.timeZone;
  if (event.allDay) {
    return {
      id: event.id || null,
      summary: event.summary,
      allDay: true,
      date: event.allDayStart || (event.start ? localDateString(new Date(event.start), tz) : null),
      dateEnd: event.allDayEnd || null,
      timeLabel: '全天',
      startLocal: null,
      endLocal: null,
      location: event.location || '',
      description: event.description || '',
      attendees: (event.attendees || []).map((a) => a.email || a),
      htmlLink: event.htmlLink || null,
    };
  }
  const start = event.start instanceof Date ? event.start : new Date(event.start);
  const end = event.end instanceof Date ? event.end : new Date(event.end);
  return {
    id: event.id || null,
    summary: event.summary,
    allDay: false,
    date: localDateString(start, tz),
    dateEnd: localDateString(end, tz),
    startLocal: localString(start, tz),
    endLocal: localString(end, tz),
    timeLabel: `${localString(start, tz).slice(11)}–${localString(end, tz).slice(11)}`,
    durationMinutes: Math.round((end - start) / 60_000),
    location: event.location || '',
    description: event.description || '',
    attendees: (event.attendees || []).map((a) => a.email || a),
    htmlLink: event.htmlLink || null,
    mailbotRef: event.mailbotRef || null,
  };
}

/* ================================================================ 统计 */

/**
 * 检测时间重叠。忽略全天事件（全天事件与具体时段不构成冲突）。
 */
export function detectConflicts(events) {
  const timed = events
    .filter((e) => !e.allDay && e.start && e.end)
    .map((e) => ({ ...e, s: new Date(e.start).getTime(), t: new Date(e.end).getTime() }))
    .sort((a, b) => a.s - b.s);
  const conflicts = [];
  for (let i = 0; i < timed.length; i += 1) {
    for (let j = i + 1; j < timed.length; j += 1) {
      if (timed[j].s >= timed[i].t) break; // 已排序，后面不会再重叠
      conflicts.push({
        a: timed[i].summary,
        b: timed[j].summary,
        startA: timed[i].s,
        startB: timed[j].s,
        overlapMinutes: Math.round((Math.min(timed[i].t, timed[j].t) - Math.max(timed[i].s, timed[j].s)) / 60_000),
      });
    }
  }
  return conflicts;
}

/**
 * 按天分组 + 程序化统计（模型只负责写分析文字，数字由这里算，避免编造）。
 */
export function groupEventsByDay(events, { now, timeZone, lookaheadDays = 7 }) {
  const windows = buildWindows(now, timeZone, lookaheadDays);
  const days = windows.days.map((day, index) => {
    const label =
      index === 0 ? `今天（${day.key} ${zhWeekday(partsInZone(day.start, timeZone).weekday)}）`
        : index === 1 ? `明天（${day.key} ${zhWeekday(partsInZone(day.start, timeZone).weekday)}）`
          : `${day.key} ${zhWeekday(partsInZone(day.start, timeZone).weekday)}`;
    const dayEvents = events
      .filter((e) => dayKey(new Date(e.start), timeZone) === day.key)
      .map((e) => presentEvent(e, timeZone))
      .sort((a, b) => {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return String(a.startLocal).localeCompare(String(b.startLocal));
      });
    const busyMinutes = dayEvents.filter((e) => !e.allDay).reduce((sum, e) => sum + (e.durationMinutes || 0), 0);
    return {
      key: day.key,
      index,
      label,
      isToday: index === 0,
      isTomorrow: index === 1,
      events: dayEvents,
      count: dayEvents.length,
      busyHours: Math.round((busyMinutes / 60) * 10) / 10,
    };
  });

  const conflicts = detectConflicts(events).map((c) => ({
    ...c,
    label: `${formatInZone(new Date(c.startA), timeZone, { withDate: false })}`,
    a: c.a,
    b: c.b,
  }));

  const timed = events.filter((e) => !e.allDay && e.start && e.end);
  const totalMinutes = timed.reduce((sum, e) => sum + (new Date(e.end) - new Date(e.start)) / 60_000, 0);
  // 「忙碌时长」按区间并集算：连续/重叠的会议不应被重复累加，这才是排期真正占用的时间
  const busyMinutes = (() => {
    const spans = timed
      .map((e) => [new Date(e.start).getTime(), new Date(e.end).getTime()])
      .sort((a, b) => a[0] - b[0]);
    let total = 0;
    let curStart = null;
    let curEnd = null;
    for (const [s, t] of spans) {
      if (curStart === null) {
        curStart = s;
        curEnd = t;
        continue;
      }
      if (s <= curEnd) curEnd = Math.max(curEnd, t);
      else {
        total += curEnd - curStart;
        curStart = s;
        curEnd = t;
      }
    }
    if (curStart !== null) total += curEnd - curStart;
    return total / 60_000; // 转成分钟
  })();
  const busiest = [...days].sort((a, b) => b.count - a.count)[0];

  return {
    timeZone,
    windowDays: lookaheadDays,
    days,
    conflicts,
    stats: {
      total: events.length,
      today: days[0]?.count || 0,
      tomorrow: days[1]?.count || 0,
      busyDays: days.filter((d) => d.count > 0).length,
      days: days.length,
      totalHours: Math.round((totalMinutes / 60) * 10) / 10,
      busyHours: Math.round((busyMinutes / 60) * 10) / 10,
      conflicts: conflicts.map((c) => ({ label: c.label, a: c.a, b: c.b })),
      busiestDay: busiest && busiest.count > 0 ? { label: busiest.label, count: busiest.count } : null,
    },
  };
}

/* ================================================================ 1. 对话建日程 */

function sessionOf(state, sessionId) {
  const sessions = state.calendar?.sessions || [];
  return sessions.find((s) => s.id === sessionId) || null;
}

/**
 * 处理一轮日历对话。
 * @returns {Promise<object>} 响应体（含 assistant 文本、待确认动作、事件草稿）
 */
export async function chatWithCalendar({ sessionId, message, now = new Date() } = {}) {
  const config = getConfig();
  if (!config.calendar.enabled) {
    throw new AppError('日历功能未启用。请到「设置 → 日历」开启后再试。', { code: 'CALENDAR_DISABLED', status: 400 });
  }
  const timeZone = config.calendar.timeZone;
  const text = String(message || '').trim();
  if (!text) throw new AppError('请输入内容', { code: 'EMPTY_MESSAGE', status: 400 });

  const state = store.getState();
  const session = sessionOf(state, sessionId) || store.startCalendarSession({ id: sessionId });
  const pending = session.pending || null;
  const history = (session.messages || []).slice(-8);

  const client = new LlmClient(config.llm);
  const { data } = await client.completeJson({
    system: EXTRACT_SYSTEM,
    user: buildExtractPrompt({
      message: text,
      now: nowContext(now, timeZone),
      timeZone,
      pending: pending?.event ? pending.event : null,
      history,
    }),
    temperature: 0.2,
    label: '日历对话解析',
  });

  store.appendCalendarMessage(session.id, { role: 'user', content: text, at: new Date().toISOString() });

  const action = ['create', 'update', 'delete', 'list', 'none'].includes(data.action) ? data.action : 'create';

  /* 信息不足 → 追问 */
  if (data.needMore === true || action === 'none') {
    const question = String(data.question || data.reason || '能再具体一点吗？比如时间、时长或参与人？').trim();
    store.appendCalendarMessage(session.id, { role: 'assistant', content: question, at: new Date().toISOString() });
    store.persistState();
    return {
      sessionId: session.id,
      assistant: question,
      kind: 'question',
      needMore: true,
      action,
      event: null,
      pending: null,
    };
  }

  /* 只要查看 → 直接返回日程概览 */
  if (action === 'list') {
    const answer = await buildListReply({ now, timeZone, question: text, config, client });
    store.appendCalendarMessage(session.id, { role: 'assistant', content: answer.assistant, at: new Date().toISOString() });
    store.persistState();
    return { sessionId: session.id, kind: 'list', action, ...answer, pending: null };
  }

  /* 创建/更新 → 解析成事件草稿并做冲突检查 */
  const resolved = resolveEventDraft(
    { ...data.event, durationMinutes: data.event?.durationMinutes },
    { timeZone, defaults: { durationMinutes: DEFAULT_DURATION_MIN } },
  );
  if (!resolved.ok) {
    const question = `还缺一点信息：${resolved.hardProblems.join('；')}。能补充一下吗？`;
    store.appendCalendarMessage(session.id, { role: 'assistant', content: question, at: new Date().toISOString() });
    store.persistState();
    return {
      sessionId: session.id,
      assistant: question,
      kind: 'question',
      needMore: true,
      action,
      problems: resolved.hardProblems,
      event: null,
      pending: null,
    };
  }

  const event = resolved.event;
  const presented = presentEvent(event, timeZone);
  const conflicts = await findConflictsFor(event, { timeZone, config });

  const assistant = buildConfirmText({ action, presented, conflicts, assumptions: event.assumptions, reason: event.reason });

  /* delete：需要用户指定删哪一个，这里只给候选 */
  if (action === 'delete') {
    const candidates = await searchEvents({ query: event.summary, now, timeZone, config });
    store.appendCalendarMessage(session.id, { role: 'assistant', content: assistant, at: new Date().toISOString() });
    store.persistState();
    return {
      sessionId: session.id,
      assistant,
      kind: 'delete-candidates',
      action,
      candidates,
      event: presented,
      pending: null,
    };
  }

  const pendingAction = {
    type: action === 'update' ? 'update' : 'create',
    event,
    presented,
    conflicts,
    createdAt: new Date().toISOString(),
  };
  store.setCalendarPending(session.id, pendingAction);
  store.appendCalendarMessage(session.id, { role: 'assistant', content: assistant, at: new Date().toISOString() });
  store.persistState();

  return {
    sessionId: session.id,
    assistant,
    kind: 'confirm',
    action,
    event: presented,
    conflicts,
    assumptions: event.assumptions,
    pending: { type: pendingAction.type, event: presented },
  };
}

function buildConfirmText({ action, presented, conflicts, assumptions, reason }) {
  const lines = [];
  if (action === 'update') lines.push('已准备更新这个日程，请确认：');
  else lines.push('已整理好日程，请确认后写入日历：');
  lines.push('');
  lines.push(`· 标题：${presented.summary}`);
  lines.push(`· 时间：${presented.allDay ? `${presented.date}（全天）` : `${presented.startLocal} → ${presented.endLocal}（${presented.durationMinutes} 分钟）`}`);
  if (presented.location) lines.push(`· 地点：${presented.location}`);
  if (presented.attendees?.length) lines.push(`· 参与人：${presented.attendees.join('、')}`);
  if (presented.description) lines.push(`· 备注：${truncate(presented.description.replace(/\n/g, ' '), 80)}`);
  if (reason) lines.push(`· 理解：${reason}`);
  if (assumptions?.length) {
    lines.push('');
    lines.push(`假设：${assumptions.join('；')}`);
  }
  if (conflicts?.length) {
    lines.push('');
    lines.push(`⚠️ 与已有日程冲突：${conflicts.map((c) => `「${c.summary}」${c.timeLabel}`).join('、')}`);
  }
  return lines.join('\n');
}

/** 查这个时间段是否与已有日程冲突。 */
async function findConflictsFor(event, { timeZone, config }) {
  if (event.allDay) return [];
  try {
    const start = new Date(event.start);
    const end = new Date(event.end);
    // 前后各放宽一天，覆盖跨天日程
    const list = await gcal.listEvents({
      calendarId: config.calendar.calendarId,
      timeMin: addDays(start, -1, timeZone),
      timeMax: addDays(end, 1, timeZone),
      maxResults: 100,
      timeZone,
    });
    return list.items
      .filter((e) => !e.allDay && e.start && e.end)
      .map((e) => ({
        summary: e.summary,
        start: e.start,
        end: e.end,
        timeLabel: `${formatInZone(new Date(e.start), timeZone, { withDate: false })}–${formatInZone(new Date(e.end), timeZone, { withDate: false })}`,
      }))
      .filter((e) => new Date(e.start) < end && new Date(e.end) > start);
  } catch (err) {
    log.warn(`冲突检查失败（不影响创建）：${err?.message || err}`);
    return [];
  }
}

async function searchEvents({ query, now, timeZone, config, days = 30 }) {
  try {
    const list = await gcal.listEvents({
      calendarId: config.calendar.calendarId,
      timeMin: now,
      timeMax: addDays(now, days, timeZone),
      maxResults: 100,
      q: query || undefined,
      timeZone,
    });
    return list.items.map((e) => presentEvent(e, timeZone));
  } catch (err) {
    log.warn(`搜索日程失败：${err?.message || err}`);
    return [];
  }
}

async function buildListReply({ now, timeZone, question, config, client }) {
  const lookaheadDays = config.calendar.lookaheadDays;
  const windows = buildWindows(now, timeZone, lookaheadDays);
  const list = await gcal.listEvents({
    calendarId: config.calendar.calendarId,
    timeMin: windows.range.start,
    timeMax: windows.range.end,
    maxResults: 250,
    timeZone,
  });
  const grouped = groupEventsByDay(list.items, { now, timeZone, lookaheadDays });
  let assistant;
  try {
    const { text } = await client.complete({
      system: CALENDAR_ANALYSIS_SYSTEM.replace('{{days}}', String(lookaheadDays)),
      user: buildCalendarAnalysisPrompt({
        windowLabel: `今天 / 明天 / 最近 ${lookaheadDays} 天`,
        days: grouped.days,
        events: list.items,
        now: nowContext(now, timeZone),
        timeZone,
        stats: grouped.stats,
      }),
      temperature: 0.3,
      maxTokens: 1200,
      jsonMode: false,
      label: '日历问答',
    });
    assistant = String(text || '').trim();
  } catch (err) {
    log.warn(`日程分析生成失败，使用本地摘要：${err?.message || err}`);
    assistant = localSummary(grouped);
  }
  void question;
  return { assistant, analysis: grouped, grouped };
}

function localSummary(grouped) {
  const lines = [`最近 ${grouped.windowDays} 天共 ${grouped.stats.total} 条日程：今日 ${grouped.stats.today} 条，明日 ${grouped.stats.tomorrow} 条。`];
  for (const day of grouped.days) {
    if (!day.count) continue;
    lines.push('');
    lines.push(`${day.label}：`);
    for (const e of day.events) lines.push(`  ${e.timeLabel}　${e.summary}`);
  }
  if (!grouped.stats.total) lines.push('这段时间没有安排。');
  return lines.join('\n');
}

/* ================================================================ 2. 待确认动作落地 */

/** 确认并写入日历。 */
export async function commitPending({ sessionId, override } = {}) {
  const config = getConfig();
  const timeZone = config.calendar.timeZone;
  const state = store.getState();
  const session = sessionOf(state, sessionId);
  if (!session?.pending) {
    throw new AppError('没有待确认的日程。请先在对话里描述日程，或从邮件生成。', {
      code: 'NO_PENDING_ACTION',
      status: 404,
    });
  }
  const pending = session.pending;
  // 允许用户在确认前微调字段
  const merged = override ? resolveEventDraft({ ...toRawDraft(pending.event), ...override }, { timeZone }) : { ok: true, event: pending.event };
  if (!merged.ok) {
    throw new AppError(`调整后的内容不完整：${merged.hardProblems.join('；')}`, { code: 'INVALID_EVENT', status: 400 });
  }

  /*
   * 打上来源标记。
   *
   * 原来只有「从邮件生成」那条路径会设置 `source`，**对话建日程这条从来不设**——
   * 结果是：①「由本程序创建」的日程在 Google 上没有标记，事后无法区分；
   * ② 操作台账补录时认不出它们（实测 107 条日程里只有 3 条带标记）。
   */
  if (!merged.event.source) merged.event.source = 'chat';

  const created = await gcal.createEvent(merged.event, {
    calendarId: config.calendar.calendarId,
    sendUpdates: config.calendar.sendUpdates,
    timeZone,
  });
  // 写操作留台账：日志关窗即失，日程却是建在 Google 上的
  appendAudit('calendar.event.create', {
    target: merged.event.summary,
    source: '对话建日程',
    extra: {
      start: formatInZone(new Date(created.start), timeZone),
      end: created.end ? formatInZone(new Date(created.end), timeZone) : null,
      eventId: created.id || null,
      location: merged.event.location || null,
    },
  });

  store.clearCalendarPending(session.id);
  store.appendCalendarMessage(session.id, {
    role: 'assistant',
    content: `已写入日历：${created.summary}　${created.allDay ? created.start : `${formatInZone(new Date(created.start), timeZone)}`}`,
    at: new Date().toISOString(),
  });
  store.persistState();

  return { ok: true, event: presentEvent(created, timeZone), calendarId: config.calendar.calendarId };
}

/** 把展示形态还原成模型输出的原始形态（用于用户微调后重新解析）。 */
function toRawDraft(presented) {
  return {
    summary: presented.summary,
    allDay: presented.allDay,
    allDayStart: presented.date,
    allDayEnd: presented.dateEnd,
    startLocal: presented.startLocal,
    endLocal: presented.endLocal,
    durationMinutes: presented.durationMinutes,
    location: presented.location,
    description: presented.description,
    attendees: (presented.attendees || []).map((e) => ({ email: e })),
  };
}

export function cancelPending({ sessionId } = {}) {
  const state = store.getState();
  const session = sessionOf(state, sessionId);
  if (!session) return { ok: true, cleared: false };
  store.clearCalendarPending(session.id);
  store.persistState();
  return { ok: true, cleared: true };
}

/* ================================================================ 3. 邮件转日程 */

/**
 * 从分析结果里挑出可能含时间信息的邮件，逐封提取日程建议（不写日历，等确认）。
 */
/**
 * 「从邮件生成日程」默认只扫描最近 24 小时的邮件。
 *
 * 这个默认值必须存在：按钮写的是「扫描最近 24 小时邮件」，
 * 而之前只有在调用方**显式传** windowHours 时才过滤——界面从来不传，
 * 于是实际扫的是"分析库里最新的若干封"，把几周前的邮件也列了出来（用户实测发现）。
 * 标签承诺什么，就得真做什么。
 */
export const EMAIL_EVENT_WINDOW_HOURS = 24;

export async function suggestEventsFromEmails({ instanceId, ids, windowHours, now: nowInput } = {}) {
  const config = getConfig();
  if (!config.calendar.enabled) {
    throw new AppError('日历功能未启用。请到「设置 → 日历」开启后再试。', { code: 'CALENDAR_DISABLED', status: 400 });
  }
  const timeZone = config.calendar.timeZone;
  const now = nowInput instanceof Date ? nowInput : new Date();

  const hours = Number(windowHours) > 0 ? Number(windowHours) : EMAIL_EVENT_WINDOW_HOURS;
  const since = new Date(now.getTime() - hours * 3600_000);
  const windowInfo = {
    hours,
    since: since.toISOString(),
    sinceLabel: formatInZone(since, timeZone),
    label: hours === 24 ? '最近 24 小时' : `最近 ${hours} 小时`,
  };

  /**
   * 取窗口内的候选邮件。
   * 抽成函数是因为"自动补一次分析"之后要重新取一遍。
   */
  const collect = () => {
    const inWindow = store
      .listAnalyses({ instanceId, since, limit: 200 })
      .filter((a) => (ids?.length ? ids.includes(`${a.folder}:${a.uid}`) : true))
      // 只挑有实质内容的：需回复 / 会议 / 待处理，排除通知与营销
      .filter((a) => !['spam', 'newsletter', 'social'].includes(a.type));
    return { inWindow, records: inWindow.slice(0, config.calendar.maxFromEmails) };
  };

  let { inWindow, records } = collect();

  /*
   * 窗口内没有可用邮件时**自动先补一次分析**再提取。
   *
   * 理由：「扫描最近 24 小时邮件」这个名字的意思是"把最近的邮件变成日程"，
   * 而只分析过一次旧邮件的人点下去会得到空列表——那不是他要的结果，是流程缺了一步。
   * 所以这里替他跑一次 `runScan`（它本身会跳过已分析的邮件，不会重复花钱），再重新取。
   *
   * 注意：显式指定 `ids` 时**不**自动分析——那是调用方点名要哪几封，不该擅自扩大范围。
   */
  let autoAnalyzed = null;
  if (!records.length && !ids?.length) {
    try {
      const run = await runScan({ instanceId, windowHours: hours, trigger: 'calendar-scan' });
      autoAnalyzed = {
        ok: true,
        fetched: run?.fetched ?? 0,
        analyzed: run?.analyzed ?? 0,
        message: run?.message || '',
      };
      ({ inWindow, records } = collect());
    } catch (err) {
      // 邮件分析失败不该让"从邮件生成日程"整个不可用：如实说明原因，让用户手动去分析
      autoAnalyzed = { ok: false, error: err?.message || String(err) };
      log.warn(`日历扫描时自动补分析失败：${autoAnalyzed.error}`);
    }
  }

  if (!records.length) {
    /*
     * 三种"没有"必须分开说，否则用户会以为邮件里真的没有时间信息：
     *   ① 窗口内压根没有已分析的邮件（先去分析新邮件）
     *   ② 有邮件，但都被类型过滤掉了
     *   ③ 刚自动分析过，确实没有新内容
     * 顺便告诉他在窗口外还有多少条，避免"数据不见了"的错觉。
     */
    const olderWithCandidates = store
      .listAnalyses({ instanceId, limit: 200 })
      .filter((a) => new Date(a.mail?.date || a.analyzedAt) < since)
      .filter((a) => !['spam', 'newsletter', 'social'].includes(a.type)).length;

    const autoNote = autoAnalyzed
      ? autoAnalyzed.ok
        ? `已自动分析${windowInfo.label}的邮件（拉取 ${autoAnalyzed.fetched} 封、新分析 ${autoAnalyzed.analyzed} 封）${autoAnalyzed.message ? `：${autoAnalyzed.message}` : '。'}`
        : `自动分析未能完成（${autoAnalyzed.error}），请到总览页手动运行「分析最近 24 小时邮件」。`
      : '';

    const base = inWindow.length
      ? `${windowInfo.label}内的邮件都不是会议/待处理类，没有可提取的时间信息。`
      : `${windowInfo.label}（${windowInfo.sinceLabel} 起）没有已分析的邮件。` +
        (olderWithCandidates
          ? `更早有 ${olderWithCandidates} 封可提取的邮件，但不在本次窗口内。`
          : '');
    return { suggestions: [], note: `${autoNote}${autoNote ? ' ' : ''}${base}`, window: windowInfo, examined: inWindow.length, autoAnalyzed };
  }

  const client = new LlmClient(config.llm);
  const suggestions = [];
  const failures = [];

  for (const record of records) {
    const mail = record.mail || {};
    let body = '';
    try {
      const raw = store.readRaw(record.folder, record.uid, mail.messageId);
      if (raw) {
        const { parseMessage, stripQuoted, clipForLlm } = await import('../mail/parse.js');
        const parsed = await parseMessage(raw);
        body = clipForLlm(stripQuoted(parsed.body), Math.min(4000, config.scan.bodyCharsForLlm));
      }
    } catch (err) {
      log.debug(`读取邮件原文失败 UID=${record.uid}：${err?.message || err}`);
    }

    try {
      const { data } = await client.completeJson({
        system: EMAIL_TO_EVENT_SYSTEM,
        user: buildEmailEventPrompt({
          mail: {
            subject: mail.subject,
            from: mail.from,
            date: mail.date,
            attendees: [...(mail.to || []).map((t) => t.address), ...(mail.cc || []).map((c) => c.address)].filter(Boolean),
            body: body || mail.snippet || '',
          },
          now: nowContext(now, timeZone),
          timeZone,
        }),
        temperature: 0.1,
        label: `邮件转日程：${truncate(mail.subject || '', 30)}`,
      });

      for (const item of Array.isArray(data.events) ? data.events : []) {
        const normalized = normalizeMailEventTimes(item, { timeZone });
        const resolved = resolveEventDraft(normalized, { timeZone });
        if (!resolved.ok) continue;
        const presented = presentEvent(resolved.event, timeZone);
        suggestions.push({
          id: `sug_${record.folder}_${record.uid}_${suggestions.length}`,
          mail: {
            key: `${record.folder}:${record.uid}`,
            folder: record.folder,
            uid: record.uid,
            subject: mail.subject,
            from: mail.from,
            date: mail.date,
            messageId: mail.messageId || null,
          },
          event: presented,
          kind: item.kind || 'meeting',
          // 时间被规整过就说清楚，避免用户以为模型识别的就是整点
          timeAdjusted: normalized.__adjusted === true,
          evidence: String(item.evidence || '').slice(0, 200),
          confidence: typeof item.confidence === 'number' ? Math.max(0, Math.min(1, item.confidence)) : null,
        });
      }
    } catch (err) {
      failures.push({ uid: record.uid, subject: mail.subject, message: err?.message || String(err) });
      log.warn(`邮件转日程失败 UID=${record.uid}：${err?.message || err}`);
    }
  }

  suggestions.sort((a, b) => String(a.event.date || '').localeCompare(String(b.event.date || '')));
  return {
    suggestions,
    scanned: records.length,
    /** 本次真正扫描的窗口（界面会显示，方便核对"是不是只有 24 小时"） */
    window: windowInfo,
    /** 窗口内没有可用邮件时自动补跑的分析（界面会说明，避免"怎么突然等这么久"） */
    autoAnalyzed,
    /** 窗口内的候选邮件数（未截断前） */
    examined: inWindow.length,
    failures,
    note: suggestions.length ? '' : `${windowInfo.label}内的 ${records.length} 封邮件里没有找到明确的日期时间。`,
  };
}

/**
 * 把邮件里抽出来的时间规整成"日历上可用的时间块"。
 *
 * 邮件里的时间往往是**时间点**而不是日程：实测模型会给出
 * `17:00 → 17:05`、`10:52:12 → 10:52:17` 这种 5 分钟的事件，
 * 还有一个"截止"被建成 5 分钟会议——这种条目在日历上毫无意义。
 *
 * 规整规则：
 *   1. **开始时间对齐到整点或半点**。截止类（deadline）**向下取整**：
 *      "10:52 之后无法登录" → 10:30 开始，提醒不晚于邮件里说的时间；
 *      其余（会议等）**就近取整**，14:20 → 14:30。
 *   2. **时长不足 30 分钟的一律给 30 分钟**。模型已经识别出更长的时长
 *      （例如"14:00-16:00 的评审会"）就保留，不要把它压成半小时。
 *
 * @param {object} item 模型输出的日程草稿
 * @param {object} opts { timeZone }
 */
export function normalizeMailEventTimes(item, { timeZone } = {}) {
  const draft = { ...(item || {}) };
  // 全天事项没有"几点"的问题，原样返回
  if (draft.allDay === true || (!draft.startLocal && draft.allDayStart)) return draft;

  const parsedStart = draft.startLocal ? parseCalendarTime(draft.startLocal, timeZone) : null;
  if (!parsedStart) return draft;

  const isDeadline = String(draft.kind || '').toLowerCase() === 'deadline';
  const original = parsedStart.date;
  const stepMs = 30 * 60_000;
  const rounded = new Date(
    (isDeadline ? Math.floor(original.getTime() / stepMs) : Math.round(original.getTime() / stepMs)) * stepMs,
  );

  const parsedEnd = draft.endLocal ? parseCalendarTime(draft.endLocal, timeZone) : null;
  const givenMinutes = parsedEnd ? Math.round((parsedEnd.date.getTime() - original.getTime()) / 60_000) : null;
  const durationMinutes = Math.max(30, Number.isFinite(givenMinutes) && givenMinutes > 0 ? givenMinutes : 0);

  const adjusted = rounded.getTime() !== original.getTime() || durationMinutes !== givenMinutes;

  // formatInZone 已经给出 "YYYY-MM-DD HH:MM"（本地墙钟时间），正好是 resolveEventDraft 认的格式
  draft.startLocal = formatInZone(rounded, timeZone);
  draft.endLocal = formatInZone(new Date(rounded.getTime() + durationMinutes * 60_000), timeZone);
  // 时长以 durationMinutes 为准（resolveEventDraft 在缺 endLocal 时会用它兜底）
  draft.durationMinutes = durationMinutes;
  Object.defineProperty(draft, '__adjusted', { value: adjusted, enumerable: false });
  return draft;
}

/** 把一条邮件日程建议写入日历（用户逐条确认）。 */
export async function acceptEmailSuggestion({ instanceId, suggestion, override } = {}) {
  const config = getConfig();
  const timeZone = config.calendar.timeZone;
  if (!suggestion?.event) throw new AppError('缺少日程内容', { code: 'INVALID_EVENT', status: 400 });

  const raw = { ...toRawDraft(suggestion.event), ...(override || {}) };
  const resolved = resolveEventDraft(raw, { timeZone });
  if (!resolved.ok) throw new AppError(`日程内容不完整：${resolved.hardProblems.join('；')}`, { code: 'INVALID_EVENT', status: 400 });

  const event = resolved.event;
  if (suggestion.mail) {
    event.source = 'email';
    event.ref = `${suggestion.mail.folder}:${suggestion.mail.uid}`;
    if (!event.description) {
      event.description = `来自邮件：${suggestion.mail.from?.address || ''}　${suggestion.mail.subject || ''}`;
    }
  } else {
    event.source = 'manual';
  }

  const created = await gcal.createEvent(event, {
    calendarId: config.calendar.calendarId,
    sendUpdates: config.calendar.sendUpdates,
    timeZone,
  });
  /*
   * 「从邮件生成日程」是可以一键批量写入的，本地原先**完全没留下"建了哪条"的记录**
   * （只有 state 落盘一次）。这里补上审计，批量操作才追得回来。
   */
  appendAudit('calendar.event.create', {
    target: event.summary,
    source: suggestion?.mail ? '从邮件生成' : '直接写入',
    extra: {
      start: formatInZone(new Date(created.start), timeZone),
      end: created.end ? formatInZone(new Date(created.end), timeZone) : null,
      eventId: created.id || null,
      location: event.location || null,
      mailSubject: suggestion?.mail?.subject || null,
      mailFrom: suggestion?.mail?.from?.address || null,
      edited: !!(override && Object.keys(override).length),
    },
  });
  store.persistState();
  return { ok: true, event: presentEvent(created, timeZone), instanceId };
}

/**
 * 从 Google 日历**补录**历史操作台账。
 *
 * 为什么需要：审计是后来才加的，之前通过界面批量创建（或由邮件生成）的日程
 * 在本地没有任何痕迹。但那些事件在 Google 上带着 `mailbotSource` / `mailbotRef`
 * 扩展属性——凡是由本程序创建的都带，因此可以据此回填，让台账不至于从"功能上线那天"才开始。
 *
 * 安全性：只 **读** Google（`listAllEvents`），只 **追加**本地台账文件；
 * 不新建、不修改、不删除任何日程。已存在的记录按 `eventId` 去重，可重复执行。
 *
 * @param {object} options { now, monthsBack, monthsAhead }
 */
/**
 * 给一个 Promise 加超时。超时后**放弃等待**（底层请求会自行结束并被忽略），
 * 让调用方能立刻给用户一个明确结果，而不是无限转圈。
 */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const err = new Error(message || `操作超时（>${Math.round(ms / 1000)}s）`);
        err.code = 'TIMEOUT';
        reject(err);
      }, ms);
    }),
  ]);
}

export async function backfillCalendarAudit({ now = new Date(), monthsBack = 18, monthsAhead = 24, googleTimeoutMs = 20_000 } = {}) {
  const config = getConfig();
  if (!config.calendar.enabled) {
    throw new AppError('日历功能未启用。请到「设置 → 日历」开启后再试。', { code: 'CALENDAR_DISABLED', status: 400 });
  }
  const timeZone = config.calendar.timeZone;

  /*
   * 顺序很关键：**先做不依赖网络的本地补录，再做 Google**。
   *
   * 之前是先查 Google 再补会话记录，于是"访问 Google 卡住"会把整件事拖死——
   * 而会话记录那部分（实测能补 62 条）明明纯本地、一瞬间就能完成。
   * 现在 Google 只是"尽力而为"的第二个来源：失败/超时都会保留已补录的本地结果，
   * 并把原因如实带回去，而不是让用户对着"补录中…"干等。
   */
  const chat = backfillChatAudit(timeZone);

  const from = new Date(now.getTime() - monthsBack * 30 * 86_400_000);
  const to = new Date(now.getTime() + monthsAhead * 30 * 86_400_000);
  const calendar = { scanned: 0, matched: 0, added: 0, skipped: 0, truncated: false, error: null };
  try {
    const listed = await withTimeout(
      gcal.listAllEvents({ timeMin: from, timeMax: to, maxTotal: 3000 }),
      googleTimeoutMs,
      `查询 Google 日历超时（>${Math.round(googleTimeoutMs / 1000)}s）。可能是本机到 Google 的网络不通。`,
    );
    calendar.scanned = listed.items.length;
    calendar.truncated = !!listed.truncated;
    const mine = listed.items.filter((e) => e.mailbotSource);
    calendar.matched = mine.length;

    const known = existingAuditEventIds();
    for (const e of mine) {
      if (e.id && known.has(e.id)) {
        calendar.skipped += 1;
        continue;
      }
      appendAudit('calendar.event.create', {
        target: e.summary,
        source: e.mailbotSource === 'email' ? '由 Google 日历补录（来自邮件）' : '由 Google 日历补录',
        // 用事件自带的 created 做时间参考：这是"当时创建"的真实时刻
        at: e.created || e.updated || now.toISOString(),
        extra: {
          start: e.start ? formatInZone(new Date(e.start), timeZone) : null,
          end: e.end ? formatInZone(new Date(e.end), timeZone) : null,
          eventId: e.id || null,
          location: e.location || null,
          mailRef: e.mailbotRef || null,
          backfilled: true,
        },
      });
      if (e.id) known.add(e.id);
      calendar.added += 1;
    }
  } catch (err) {
    calendar.error = err?.message || String(err);
    log.warn(`补录历史：Google 日历这一路没成功（本地记录已补录）：${calendar.error}`);
  }

  return {
    /** 本地会话记录这一路的结果 */
    fromChat: chat.added,
    chatSkipped: chat.skipped,
    sessions: chat.sessions,
    /** Google 这一路的结果（含失败原因） */
    fromCalendar: calendar.added,
    calendar: { scanned: calendar.scanned, matched: calendar.matched, skipped: calendar.skipped, truncated: calendar.truncated, error: calendar.error },
    added: chat.added + calendar.added,
    skipped: chat.skipped + calendar.skipped,
    truncated: calendar.truncated,
    range: { from: from.toISOString(), to: to.toISOString() },
  };
}

/**
 * 从本地日历会话记录补录"对话建日程"的台账。
 *
 * 为什么需要第二个来源：**对话建日程这条路径在本次修复前不给事件打来源标记**，
 * 所以那些日程在 Google 上认不出来（实测 107 条里只有 3 条带标记，而会话里有 61 条
 * "已写入日历"的消息）。但会话消息本身记下了**标题与时间**，可以据此补录。
 *
 * 去重键：`target + 开始时间`（会话消息里没有 Google 事件 id）。
 */
function backfillChatAudit(timeZone) {
  const sessions = store.getState()?.calendar?.sessions || [];
  const known = new Set();
  for (const rec of listAudit({ limit: 2000 }).items) {
    if (rec.extra?.fromChat) known.add(`${rec.target}|${rec.extra.start || ''}`);
  }

  let added = 0;
  let skipped = 0;
  for (const session of sessions) {
    for (const m of session.messages || []) {
      const content = String(m?.content || '');
      if (!content.startsWith('已写入日历：')) continue;
      const rest = content.slice('已写入日历：'.length);
      /*
       * 消息格式是 `已写入日历：<标题>　<时间>`（中间是全角空格）。
       * 标题本身可能含全角空格，所以取**最后**一个全角空格作为分隔，
       * 且只有它看起来像时间/日期时才这么切。
       */
      const idx = rest.lastIndexOf('　');
      let title = rest;
      let start = '';
      if (idx > 0) {
        const tail = rest.slice(idx + 1).trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(tail) || /^\d{4}-\d{2}-\d{2}T/.test(tail)) {
          title = rest.slice(0, idx);
          start = tail;
        }
      }
      title = title.trim();
      if (!title) continue;
      const key = `${title}|${start}`;
      if (known.has(key)) {
        skipped += 1;
        continue;
      }
      known.add(key);
      appendAudit('calendar.event.create', {
        target: title,
        source: '由会话记录补录',
        // 用消息时间作为"当时"的时间，时间线才正确
        at: m.at || m.createdAt || undefined,
        extra: { start: start || null, fromChat: true, sessionId: session.id || null, backfilled: true },
      });
      added += 1;
    }
  }
  return { added, skipped, sessions: sessions.length };
}

/** 台账里已记录过的日程 id（补录去重用）。 */
function existingAuditEventIds() {
  const ids = new Set();
  for (const rec of listAudit({ limit: 2000 }).items) {
    if (rec.extra?.eventId) ids.add(rec.extra.eventId);
  }
  return ids;
}

/**
 * 修改一条**已有**日程（标题 / 时间 / 地点 / 说明）。
 *
 * 之前只有"写入前编辑"（改的是还没写进日历的草稿）和"删除"——想改会议时间只能删了重建。
 * `google-api.js` 里的 `updateEvent` 早就写好了却**从未被调用**，这里把它接通。
 *
 * 与"邮件抽时间"的区别：**不套用整点/半点规整**。规整是为了把邮件里的"时间点"
 * 修成可用的时间块；而这里是你亲手填的时间，必须原样执行。
 *
 * @param {object} options { eventId, patch, instanceId }
 */
export async function updateCalendarEvent({ eventId, patch = {}, instanceId } = {}) {
  const config = getConfig();
  if (!config.calendar.enabled) {
    throw new AppError('日历功能未启用。请到「设置 → 日历」开启后再试。', { code: 'CALENDAR_DISABLED', status: 400 });
  }
  const id = String(eventId || '').trim();
  if (!id) throw new AppError('缺少日程 id', { code: 'INVALID_EVENT', status: 400 });
  const timeZone = config.calendar.timeZone;

  /*
   * 手动改时间时，"结束早于开始"必须**明确报错**。
   *
   * `resolveEventDraft` 遇到这种情况只会软性提示并**按默认时长兜底**——那是给
   * "邮件里没写清楚"用的；你亲手填的两个时间被悄悄改成 1 小时只会莫名其妙。
   */
  if (patch.allDay !== true && patch.startLocal && patch.endLocal) {
    const startAt = parseCalendarTime(patch.startLocal, timeZone);
    const endAt = parseCalendarTime(patch.endLocal, timeZone);
    if (startAt && endAt && endAt.date.getTime() <= startAt.date.getTime()) {
      throw new AppError('结束时间必须晚于开始时间', { code: 'INVALID_EVENT', status: 400 });
    }
  }

  const resolved = resolveEventDraft(patch, { timeZone });
  if (!resolved.ok) {
    throw new AppError(`修改后的内容不完整：${resolved.hardProblems.join('；')}`, { code: 'INVALID_EVENT', status: 400 });
  }
  const event = resolved.event;

  const updated = await gcal.updateEvent(
    id,
    {
      summary: event.summary,
      description: event.description,
      location: event.location,
      allDay: !!event.allDay,
      allDayStart: event.allDayStart,
      allDayEnd: event.allDayEnd,
      start: event.start,
      end: event.end,
      timeZone,
    },
    { calendarId: config.calendar.calendarId, sendUpdates: config.calendar.sendUpdates },
  );

  appendAudit('calendar.event.update', {
    target: updated.summary,
    source: '界面修改日程',
    extra: {
      eventId: id,
      start: updated.allDay
        ? updated.allDayStart || updated.start
        : updated.start
          ? formatInZone(new Date(updated.start), timeZone)
          : null,
      end: updated.allDay ? updated.allDayEnd || null : updated.end ? formatInZone(new Date(updated.end), timeZone) : null,
      location: updated.location || null,
      /** 改了哪些字段（便于事后核对"我只改了时间"） */
      fields: Object.keys(patch).filter((k) => k !== 'allDay'),
    },
  });

  return { ok: true, event: presentEvent(updated, timeZone), instanceId };
}

/* ================================================================ 4. 今日/明日/近 N 天分析 */

/**
 * 拉取日程并生成分析。
 * @param {object} options { now, lookaheadDays, withAnalysis }
 */
export async function getCalendarInsight({ now = new Date(), lookaheadDays, withAnalysis = true } = {}) {
  const config = getConfig();
  if (!config.calendar.enabled) {
    throw new AppError('日历功能未启用。请到「设置 → 日历」开启后再试。', { code: 'CALENDAR_DISABLED', status: 400 });
  }
  const timeZone = config.calendar.timeZone;
  const days = clampNumber(lookaheadDays, 1, 60, config.calendar.lookaheadDays);
  const windows = buildWindows(now, timeZone, days);

  const list = await gcal.listEvents({
    calendarId: config.calendar.calendarId,
    timeMin: windows.range.start,
    timeMax: windows.range.end,
    maxResults: 500,
    timeZone,
  });

  const grouped = groupEventsByDay(list.items, { now, timeZone, lookaheadDays: days });
  const result = {
    generatedAt: new Date().toISOString(),
    timeZone,
    calendarId: list.calendarId,
    windowDays: days,
    today: grouped.days[0],
    tomorrow: grouped.days[1],
    days: grouped.days,
    stats: grouped.stats,
    conflicts: grouped.conflicts,
    analysis: null,
    analysisError: null,
  };

  if (withAnalysis) {
    const client = new LlmClient(config.llm);
    try {
      const { text } = await client.complete({
        system: CALENDAR_ANALYSIS_SYSTEM.replace('{{days}}', String(days)),
        user: buildCalendarAnalysisPrompt({
          windowLabel: `最近 ${days} 天（含今天与明天）`,
          days: grouped.days,
          events: list.items,
          now: nowContext(now, timeZone),
          timeZone,
          stats: grouped.stats,
        }),
        temperature: 0.35,
        maxTokens: 1500,
        jsonMode: false,
        label: '日程分析',
      });
      result.analysis = String(text || '').trim() || localSummary(grouped);
    } catch (err) {
      log.warn(`日程分析生成失败：${err?.message || err}`);
      result.analysisError = err?.message || String(err);
      result.analysis = localSummary(grouped);
    }
  }

  return result;
}

/** 即将到来的日程（首页用）。 */
export async function getUpcoming({ now = new Date(), limit } = {}) {
  const config = getConfig();
  const timeZone = config.calendar.timeZone;
  const list = await gcal.listEvents({
    calendarId: config.calendar.calendarId,
    timeMin: now,
    timeMax: addDays(now, config.calendar.lookaheadDays, timeZone),
    maxResults: limit || config.calendar.upcomingLimit,
    timeZone,
  });
  return { items: list.items.map((e) => presentEvent(e, timeZone)), timeZone };
}

/* ================================================================ 会话 */

export function newSessionId() {
  return `cal_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function getSession(sessionId) {
  const state = store.getState();
  const session = sessionOf(state, sessionId);
  if (!session) return null;
  return {
    id: session.id,
    createdAt: session.createdAt,
    messages: session.messages || [],
    pending: session.pending
      ? { type: session.pending.type, event: session.pending.presented, conflicts: session.pending.conflicts }
      : null,
  };
}

export function listSessions() {
  const state = store.getState();
  return (state.calendar?.sessions || [])
    .filter((s) => Date.now() - new Date(s.updatedAt || s.createdAt).getTime() < SESSION_TTL_MS)
    .map((s) => ({ id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, messageCount: (s.messages || []).length, hasPending: !!s.pending }));
}

/** 供自检/调试：把当前时间上下文暴露出来。 */
export function describeNow(now = new Date()) {
  const config = getConfig();
  return nowContext(now, config.calendar.timeZone);
}

export { startOfDay, toRfc3339 };
