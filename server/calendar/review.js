/**
 * 日程回顾聚合：把一段时间的日程算成一组**可核对**的统计量。
 *
 * 设计原则（与邮件分析一致）：
 *   **程序负责算数与筛选，模型只负责解读与写建议。**
 * 让模型直接读一年原始日程有三个问题：token 成本不可控、模型数数不准、
 * 结论无法复现（同一份数据每次问可能给出不同的"平均每周 3 个会"）。
 *
 * 所有时间计算都按配置时区、并按"左闭右开 [start, end)"裁剪到区间内：
 * 一条跨月的日程只计入区间内的那部分，否则"上个月"的统计会被相邻月份污染。
 */

import { getConfig } from '../config/index.js';
import { classifyEvents, DURATION_BUCKETS, durationBucket, extractPeopleFromTitle, locationKind, otherAttendees } from './classify.js';
import { addDays, buildPastWindows, partsInZone, zonedTimeToUtc } from './time.js';
import { groupEventTopics } from './topics.js';

/* ------------------------------------------------------------ 基础工具 */

function minutesBetween(a, b) {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 60_000));
}

/** 把一天内的区间求并集（重叠只算一次），返回总分钟数与合并后的区间。 */
function unionMinutes(intervals) {
  const list = intervals.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  let total = 0;
  const merged = [];
  for (const iv of list) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  for (const iv of merged) total += minutesBetween(iv.start, iv.end);
  return { minutes: total, merged };
}

/** 解析 "09:00" 为当天的本地时刻。 */
function timeOfDay(dayStart, hhmm, timeZone) {
  const [h, m] = String(hhmm || '09:00').split(':').map(Number);
  const p = partsInZone(dayStart, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day, hour: h || 0, minute: m || 0 }, timeZone);
}

/** 该日本地星期（0=周日）。 */
function weekdayOf(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

function hours(minutes) {
  return Math.round((minutes / 60) * 10) / 10;
}

/* ------------------------------------------------------------ 主聚合 */

/**
 * @param {object} input
 * @param {Array} input.events 原始日程（已 normalizeEvent）
 * @param {object} input.range resolveReviewRange 的结果
 * @param {string} input.timeZone
 * @param {object} [input.options] { workHours, workdays, eveningAfter, longMeetingMin, backToBackGapMin, deepBlockMin, topN }
 */
export function aggregateCalendar({ events = [], range, timeZone, options = {} } = {}) {
  const config = getConfig();
  const review = { ...(config.calendar?.review || {}), ...options };
  const workStart = review.workdayStart || '09:00';
  const workEnd = review.workdayEnd || '19:00';
  const workdays = Array.isArray(review.workdays) && review.workdays.length ? review.workdays : [1, 2, 3, 4, 5];
  const eveningAfter = Number(review.eveningAfterHour ?? 19);
  const longMeetingMin = Number(review.longMeetingMin ?? 120);
  const backToBackGapMin = Number(review.backToBackGapMin ?? 10);
  const deepBlockMin = Number(review.deepBlockMin ?? 90);
  const topN = Number(review.topN ?? 8);

  const days = buildPastWindows(range, timeZone);
  const { kept, excluded, excludedReasons, meetingsByTitle, meetingsByAttendees, occupied, lifeCount, workCount } = classifyEvents(events);

  // 按天裁剪：跨天/跨区间的事件只计入落在区间内的部分
  const byDay = new Map(days.map((d) => [d.key, { day: d, meetings: [], busy: [], workBusy: [], focus: [], allDay: [], work: [], life: [] }]));
  const clipped = [];

  for (const e of kept) {
    const start = e.start ? new Date(e.start) : null;
    const rawEnd = e.end ? new Date(e.end) : null;
    if (!start || !rawEnd || Number.isNaN(start.getTime())) continue;

    if (e.allDay) {
      // 全天事项：计入"有安排的日子"，但不计入忙碌小时（否则一天能被算成 8 小时）
      const key = dayKeyOf(start, timeZone);
      const bucket = byDay.get(key);
      if (bucket) bucket.allDay.push(e);
      clipped.push({ ...e, clippedStart: start, clippedEnd: rawEnd });
      continue;
    }

    for (const d of days) {
      const s = start > d.start ? start : d.start;
      const en = rawEnd < d.end ? rawEnd : d.end;
      if (en <= s) continue;
      const bucket = byDay.get(d.key);
      const entry = { ...e, clippedStart: s, clippedEnd: en };
      /*
       * 三条流水线：
       *   - `busy`：**总占用小时**（工作 + 生活），回答"我的时间被占了多少"
       *   - `workBusy`：**工作占用小时**，回答"工作负荷有多重"
       *   - `life`：生活/休假条目，用于分类与列清单
       *
       * 生活事务只进 busy，不进 workBusy——否则"打羽毛球 2 小时"会被算进工作负荷。
       *
       * 例外：**休假/外出不进小时口径**。一条「年假 9/5 00:00 → 9/7 00:00」按小时算就是 48 小时，
       * 足以把整份报告的数字压平（其他事都变成了零头）。休假的正确单位是"天"，
       * 所以它只进 life（用于列清单与天数统计），不进 busy，另行按天汇报。
       */
      if (e.kind !== 'ooo') bucket.busy.push({ start: s, end: en });
      if (e.isWork) bucket.workBusy.push({ start: s, end: en });
      if (e.kind === 'meeting') bucket.meetings.push(entry);
      else if (e.kind === 'focus') bucket.focus.push(entry);
      else if (e.kind === 'life' || e.kind === 'ooo') bucket.life.push(entry);
      else bucket.work.push(entry);
      clipped.push(entry);
    }
  }

  /* ---- 逐日 ---- */
  const dayStats = days.map((d) => {
    const b = byDay.get(d.key);
    const busy = unionMinutes(b.busy);
    const workBusy = unionMinutes(b.workBusy);
    const meetingUnion = unionMinutes(b.meetings.map((m) => ({ start: m.clippedStart, end: m.clippedEnd })));
    const workUnion = unionMinutes(b.work.map((m) => ({ start: m.clippedStart, end: m.clippedEnd })));
    const lifeUnion = unionMinutes(b.life.filter((m) => m.kind === 'life').map((m) => ({ start: m.clippedStart, end: m.clippedEnd })));
    const focusUnion = unionMinutes(b.focus.map((m) => ({ start: m.clippedStart, end: m.clippedEnd })));
    const isWorkday = workdays.includes(weekdayOf(d.start, timeZone));
    const first = b.meetings.length ? b.meetings.reduce((min, m) => (m.clippedStart < min ? m.clippedStart : min), b.meetings[0].clippedStart) : null;
    const last = b.meetings.length ? b.meetings.reduce((max, m) => (m.clippedEnd > max ? m.clippedEnd : max), b.meetings[0].clippedEnd) : null;
    return {
      key: d.key,
      label: d.label,
      // 保留原始窗口信息：深度工作块需要按"这一天的工作时段"来算
      day: d,
      weekday: weekdayOf(d.start, timeZone),
      isWorkday,
      meetingCount: b.meetings.length,
      meetingHours: hours(meetingUnion.minutes),
      workCount: b.work.length,
      workHours: hours(workUnion.minutes),
      lifeCount: b.life.length,
      lifeHours: hours(lifeUnion.minutes),
      /** 总占用：工作 + 生活 */
      busyHours: hours(busy.minutes),
      /** 工作占用（不含生活） */
      workBusyHours: hours(workBusy.minutes),
      focusHours: hours(focusUnion.minutes),
      allDayCount: b.allDay.length,
      firstMeetingAt: first ? hhmmOf(first, timeZone) : null,
      lastMeetingEndAt: last ? hhmmOf(last, timeZone) : null,
      meetings: b.meetings,
      work: b.work,
      life: b.life,
      merged: busy.merged,
      workMerged: workBusy.merged,
    };
  });

  /* ---- 总览 ---- */
  const workdayStats = dayStats.filter((d) => d.isWorkday);
  const meetingCount = clipped.filter((e) => e.kind === 'meeting').length;
  const workBlockCount = clipped.filter((e) => e.kind === 'work').length;
  const lifeEntryCount = clipped.filter((e) => e.kind === 'life').length;
  const totalBusyMin = dayStats.reduce((s, d) => s + Math.round(d.busyHours * 60), 0);
  const totalMeetingMin = dayStats.reduce((s, d) => s + Math.round(d.meetingHours * 60), 0);
  const totalWorkMin = dayStats.reduce((s, d) => s + Math.round(d.workHours * 60), 0);
  const totalLifeMin = dayStats.reduce((s, d) => s + Math.round(d.lifeHours * 60), 0);
  const totalFocusMin = dayStats.reduce((s, d) => s + Math.round(d.focusHours * 60), 0);
  // 工作占用（会议+独自+专注）按并集算，避免重叠重复累加
  const totalWorkBusyMin = dayStats.reduce((s, d) => s + Math.round(d.workBusyHours * 60), 0);

  /* ---- 休假：按天计，不按小时 ----
   * 一条「年假 9/10 00:00 → 9/12 00:00」按小时算就是 48 小时，会把所有数字压平。
   * 休假更适合按"天数"表达，所以单独统计天数、不进小时口径。
   */
  const oooEntries = clipped.filter((e) => e.kind === 'ooo');
  const oooDays = new Set();
  for (const e of oooEntries) {
    const start = new Date(e.start);
    const end = new Date(e.end);
    for (const d of days) {
      if (end > d.start && start < d.end) oooDays.add(d.key);
    }
  }

  /* ---- 结构性指标 ---- */
  /*
   * 晚间/周末占用要涵盖**会议、独自工作，以及生活事务**。
   * 只统计"晚间会议"会漏掉"晚上写代码"；只统计工作又会漏掉
   * "周末带家人出去"——而这两种都是用户想看到的占用。
   * 所以这里一并统计，并带上 kind 以便分别叙述。
   */
  const eveningMeetings = [];
  const eveningWork = [];
  const eveningLife = [];
  const weekendMeetings = [];
  const weekendWork = [];
  const weekendLife = [];
  const longMeetings = [];
  const seenMeetingIds = new Set();
  for (const d of dayStats) {
    const all = [
      ...d.meetings.map((x) => ({ ...x, kind: 'meeting' })),
      ...d.work.map((x) => ({ ...x, kind: 'work' })),
      ...d.life.map((x) => ({ ...x, kind: x.kind === 'ooo' ? 'ooo' : 'life' })),
    ];
    for (const m of all) {
      /*
       * 去重键用**原始开始时间**而不是当天裁剪后的时间。
       * 跨天事件会被拆进多天的 bucket（这是对的，便于按天展示），
       * 但如果用裁剪后的时间当键，一条「3 天出差」就会被算成 3 条晚间/周末占用。
       */
      const uid = `${m.id || m.summary}|${new Date(m.start).toISOString()}`;
      if (seenMeetingIds.has(uid)) continue;
      seenMeetingIds.add(uid);
      const p = partsInZone(m.clippedStart, timeZone);
      const isWeekend = !workdays.includes(weekdayOf(m.clippedStart, timeZone));
      const at = `${d.label} ${hhmmOf(m.clippedStart, timeZone)}`;
      if (p.hour >= eveningAfter) {
        if (m.kind === 'meeting') eveningMeetings.push({ summary: m.summary, at, hour: p.hour, kind: m.kind });
        else if (m.kind === 'work') eveningWork.push({ summary: m.summary, at, hour: p.hour, kind: m.kind });
        else eveningLife.push({ summary: m.summary, at, hour: p.hour, kind: m.kind });
      }
      if (isWeekend) {
        if (m.kind === 'meeting') weekendMeetings.push({ summary: m.summary, at, kind: m.kind });
        else if (m.kind === 'work') weekendWork.push({ summary: m.summary, at, kind: m.kind });
        else weekendLife.push({ summary: m.summary, at, kind: m.kind });
      }
      if (m.kind === 'meeting') {
        const dur = minutesBetween(new Date(m.start), new Date(m.end));
        if (dur > longMeetingMin) longMeetings.push({ summary: m.summary, at: d.label, minutes: dur });
      }
    }
  }

  // 连续会议（两场之间几乎没有喘息）
  const backToBack = [];
  const conflicts = [];
  for (const d of dayStats) {
    const sorted = [...d.meetings].sort((a, b) => a.clippedStart - b.clippedStart);
    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const gap = Math.round((cur.clippedStart - prev.clippedEnd) / 60_000);
      if (gap >= 0 && gap < backToBackGapMin) {
        backToBack.push({ day: d.label, gap, from: prev.summary, to: cur.summary });
      } else if (gap < 0) {
        conflicts.push({ day: d.label, a: prev.summary, b: cur.summary, overlapMin: -gap });
      }
    }
  }

  /*
   * 无日程占用的整块时间：工作日上班时段内 ≥ deepBlockMin 的空档。
   *
   * 用**总占用**（d.merged，含生活事务）来挖空档，而不是只看工作——
   * 因为这段时间同样"不能用来干活"：写着"陪家人"的两小时并不空闲。
   */
  const deepBlocks = [];
  for (const d of dayStats) {
    if (!d.isWorkday) continue;
    const wStart = timeOfDay(d.day.start, workStart, timeZone);
    const wEnd = timeOfDay(d.day.start, workEnd, timeZone);
    let cursor = wStart;
    for (const iv of d.merged) {
      if (iv.start > cursor) {
        const mins = Math.round((iv.start - cursor) / 60_000);
        if (mins >= deepBlockMin) deepBlocks.push({ day: d.label, start: hhmmOf(cursor, timeZone), end: hhmmOf(iv.start, timeZone), minutes: mins });
      }
      if (iv.end > cursor) cursor = iv.end;
    }
    if (wEnd > cursor) {
      const mins = Math.round((wEnd - cursor) / 60_000);
      if (mins >= deepBlockMin) deepBlocks.push({ day: d.label, start: hhmmOf(cursor, timeZone), end: hhmmOf(wEnd, timeZone), minutes: mins });
    }
  }

  // 无会日：工作日里一场会都没有
  const meetingFreeWorkdays = workdayStats.filter((d) => d.meetingCount === 0).length;

  /* ---- 按周趋势 ---- */
  const weeks = new Map();
  for (const d of dayStats) {
    const key = weekKeyOf(d.day.start, timeZone);
    const w = weeks.get(key) || { key, meetingCount: 0, busyMinutes: 0, meetingMinutes: 0, workdays: 0 };
    w.meetingCount += d.meetingCount;
    w.busyMinutes += Math.round(d.busyHours * 60);
    w.meetingMinutes += Math.round(d.meetingHours * 60);
    if (d.isWorkday) w.workdays += 1;
    weeks.set(key, w);
  }
  const weekly = [...weeks.values()].map((w) => ({
    week: w.key,
    meetingCount: w.meetingCount,
    busyHours: hours(w.busyMinutes),
    meetingHours: hours(w.meetingMinutes),
    /** 每个工作日平均几场会 */
    meetingsPerWorkday: w.workdays ? Math.round((w.meetingCount / w.workdays) * 10) / 10 : 0,
  }));

  /* ---- 参与人与重复日程 ---- */
  /*
   * 人名有两个来源，必须合并：
   *   1. 活动的 attendees（标准做法）；
   *   2. **从标题里解析**（「与家诚、柳鑫讨论…」）——实测这个用户从不填参会者，
   *      名字全在标题里，所以只统计 attendees 会得出"没和任何人开会"的荒谬结论。
   * 每条都标注来源，界面上能看出这个数字是怎么来的。
   */
  const people = new Map();
  const addPerson = (key, name, minutes) => {
    const rec = people.get(key) || { name, email: '', count: 0, minutes: 0, via: 'title' };
    rec.count += 1;
    rec.minutes += minutes;
    if (name && (!rec.name || rec.name === rec.email)) rec.name = name;
    people.set(key, rec);
  };
  const seenForPeople = new Set();
  for (const e of clipped) {
    if (e.kind !== 'meeting') continue;
    // 键用原始开始时间：跨天事件在 clipped 里会出现多次，用裁剪时间当键会重复计数
    const uid = `${e.id || e.summary}|${new Date(e.start).toISOString()}`;
    if (seenForPeople.has(uid)) continue;
    seenForPeople.add(uid);
    const minutes = minutesBetween(new Date(e.start), new Date(e.end));
    const attendees = otherAttendees(e);
    if (attendees.length) {
      for (const a of attendees) {
        const key = a.email.toLowerCase();
        addPerson(key, a.name, minutes);
        people.get(key).email = a.email;
        people.get(key).via = 'attendee';
      }
    } else {
      for (const name of extractPeopleFromTitle(e.summary)) {
        addPerson(`title:${name}`, name, minutes);
      }
    }
  }
  const topPeople = [...people.values()]
    .sort((a, b) => b.minutes - a.minutes || b.count - a.count)
    .slice(0, topN)
    .map((p) => ({ name: p.name, email: p.email, count: p.count, hours: hours(p.minutes), via: p.via }));

  /* ---- 生活事务分类（用户明确要看"生活占了多少时间、花在哪类"） ---- */
  const lifeMap = new Map();
  const seenForLife = new Set();
  for (const e of clipped) {
    if (e.kind !== 'life') continue;
    // 同上：跨天的生活安排（如连续几天休假）不能被按天重复归类
    const uid = `${e.id || e.summary}|${new Date(e.start).toISOString()}`;
    if (seenForLife.has(uid)) continue;
    seenForLife.add(uid);
    const key = e.lifeKind || '其他生活事务';
    const rec = lifeMap.get(key) || { name: key, count: 0, minutes: 0, samples: [] };
    rec.count += 1;
    rec.minutes += minutesBetween(new Date(e.start), new Date(e.end));
    if (rec.samples.length < 3 && e.summary) rec.samples.push(e.summary);
    lifeMap.set(key, rec);
  }
  const lifeKinds = [...lifeMap.values()]
    .sort((a, b) => b.minutes - a.minutes)
    .map((x) => ({ name: x.name, count: x.count, hours: hours(x.minutes), samples: x.samples }));

  /* ---- 时长分层（比"会议数量"更能说明问题） ---- */
  const durationStats = new Map(DURATION_BUCKETS.map((b) => [b.id, { id: b.id, label: b.label, count: 0, minutes: 0, meetings: 0 }]));
  const seenForDuration = new Set();
  for (const e of clipped) {
    if (e.allDay) continue;
    // 同上：时长分层也要按"条"算，跨天事件不能按天重复计入
    const uid = `${e.id || e.summary}|${new Date(e.start).toISOString()}`;
    if (seenForDuration.has(uid)) continue;
    seenForDuration.add(uid);
    const minutes = minutesBetween(new Date(e.start), new Date(e.end));
    const bucket = durationStats.get(durationBucket(minutes).id);
    bucket.count += 1;
    bucket.minutes += minutes;
    if (e.kind === 'meeting') bucket.meetings += 1;
  }
  const durations = [...durationStats.values()].map((b) => ({ ...b, hours: hours(b.minutes) }));

  /* ---- 地点：线上 / 线下 / 未填 ---- */
  const locationCounts = { virtual: 0, onsite: 0, unknown: 0 };
  const placeMap = new Map();
  for (const e of clipped) {
    if (e.allDay) continue;
    const kind = locationKind(e);
    locationCounts[kind] += 1;
    if (kind === 'onsite') {
      const key = String(e.location).trim();
      placeMap.set(key, (placeMap.get(key) || 0) + 1);
    }
  }
  const locations = {
    counts: locationCounts,
    top: [...placeMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([name, count]) => ({ name, count })),
  };

  const series = new Map();
  for (const e of clipped) {
    if (!e.recurringEventId) continue;
    const rec = series.get(e.recurringEventId) || { summary: e.summary, count: 0, minutes: 0 };
    rec.count += 1;
    rec.minutes += minutesBetween(new Date(e.start), new Date(e.end));
    series.set(e.recurringEventId, rec);
  }
  const topRecurring = [...series.values()]
    .filter((s) => s.count > 1)
    .sort((a, b) => b.minutes - a.minutes)
    .slice(0, topN)
    .map((s) => ({ summary: s.summary, count: s.count, hours: hours(s.minutes) }));

  const topics = groupEventTopics(clipped.filter((e) => e.kind === 'meeting' || e.kind === 'work'));

  /* ---- 工作表时段容量与占比（提前算，供 totals 与"稀疏"判定共用） ---- */
  const firstDayStart = dayStats[0]?.day.start || range.start;
  const workCapacityMin = minutesBetween(timeOfDay(firstDayStart, workStart, timeZone), timeOfDay(firstDayStart, workEnd, timeZone)) * workdayStats.length;
  // 工作负荷比例用**工作占用的并集**做分子，避免"会议×独自工作"重叠时高估
  const workloadMinutes = totalWorkBusyMin;
  const workloadLoadRatio = workCapacityMin ? Math.round((workloadMinutes / workCapacityMin) * 1000) / 10 : 0;
  const meetingLoadRatio = workCapacityMin ? Math.round((totalMeetingMin / workCapacityMin) * 1000) / 10 : 0;
  /**
   * 记录是否稀疏。
   *
   * 判据用**总占用**（含生活事务）而不是单纯工作负荷：
   * 有人把日历当纯工作时间日志，也有人把生活安排也记进来。
   * 用总占用判断"日历是否反映了他的真实时间分布"更准确。
   *
   * 为什么需要这个标记：「无日程占用的整块时间」在稀疏记录下会算出几百小时——
   * 那其实是"**没写进日历**的时间"，不是"真的空闲"。
   * 带出这个标记，叙述才会留有余地，而不是建议他"好好利用 200 小时空闲"。
   */
  const occupancyRatio = workCapacityMin ? Math.round((totalBusyMin / workCapacityMin) * 1000) / 10 : 0;
  const sparse = occupancyRatio < 20;

  /*
   * 时间线：按天列出全部**占用时间**的条目（含生活事务）。
   * 它有两个用途：导出报告的「日程清单附录」，以及界面上可核对。
   * 刻意**不进提示词**——一年上千条会把 token 撑爆，模型也不需要逐条看。
   */
  const timeline = dayStats
    .filter((d) => d.meetings.length || d.work.length || d.life.length || byDay.get(d.key)?.allDay.length || byDay.get(d.key)?.focus.length)
    .map((d) => {
      const b = byDay.get(d.key);
      const items = [
        ...b.allDay.map((e) => ({ kind: 'allDay', start: '全天', end: '', summary: e.summary, minutes: 0, people: 0 })),
        ...[...b.meetings, ...b.work, ...b.focus, ...b.life]
          .sort((a, c) => a.clippedStart - c.clippedStart)
          .map((e) => ({
            kind: e.kind,
            start: hhmmOf(e.clippedStart, timeZone),
            end: hhmmOf(e.clippedEnd, timeZone),
            summary: e.summary,
            minutes: minutesBetween(e.clippedStart, e.clippedEnd),
            people: otherAttendees(e).length,
            byTitle: !!e.meetingByTitle,
            lifeKind: e.lifeKind || null,
          })),
      ];
      return { day: d.key, label: d.label, weekday: d.weekday, isWorkday: d.isWorkday, items };
    });

  /* ---- 汇总输出（体积要可控：这些数字会被塞进提示词） ---- */
  return {
    range: { id: range.id, label: range.label, from: range.from, to: range.to, days: range.days },
    timeZone,
    /** 一段时间里"到底有多少条日程" —— 含被排除的，方便用户核对 */
    source: {
      totalEntries: events.length,
      counted: clipped.length,
      excluded,
      excludedReasons,
      meetings: meetingCount,
      /** 其中有多少是靠标题识别出来的（日历里没有邀请参与人） */
      meetingsByTitle,
      meetingsByAttendees,
      workBlocks: workBlockCount,
      /** 占用时间的条目总数（含生活事务） */
      occupied,
      lifeCount,
      workCount,
      allDay: clipped.filter((e) => e.allDay).length,
      focus: clipped.filter((e) => e.kind === 'focus').length,
      /** 休假天数（按天计，不按小时） */
      oooDays: oooDays.size,
      sparse,
      /** 总占用占工作表时段的比例（判断记录是否稀疏用的就是这个） */
      occupancyRatio,
    },
    totals: {
      days: dayStats.length,
      workdays: workdayStats.length,
      meetingCount,
      meetingHours: hours(totalMeetingMin),
      workBlockCount,
      workHours: hours(totalWorkMin),
      /** 工作相关占用 = 会议 + 独自工作 + 专注时间（这才是"工作负荷"） */
      workloadHours: hours(totalWorkMin + totalMeetingMin + totalFocusMin),
      /** 工作占用按并集算（重叠不重复） */
      workBusyHours: hours(totalWorkBusyMin),
      /**
       * 生活/个人事务占用。
       * 用户记录日历的目的就是"把这段时间标记为忙碌"，所以生活事务同样是分析对象：
       * 它计入**总占用**，但不计入工作负荷。
       */
      lifeEntryCount,
      lifeHours: hours(totalLifeMin),
      /** 休假天数（不进小时口径，避免"年假 48 小时"把数字压平） */
      oooDays: oooDays.size,
      /** 总占用 = 工作 + 生活（按并集，重叠不重复） */
      busyHours: hours(totalBusyMin),
      focusHours: hours(totalFocusMin),
      /** 生活占总占用的比例 */
      lifeShareOfBusy: totalBusyMin ? Math.round((totalLifeMin / totalBusyMin) * 1000) / 10 : 0,
      /** 每个工作日平均几场会 */
      meetingsPerWorkday: workdayStats.length ? Math.round((meetingCount / workdayStats.length) * 10) / 10 : 0,
      /** 工作日平均每天被会议占掉几小时 */
      meetingHoursPerWorkday: workdayStats.length ? Math.round((hours(totalMeetingMin) / workdayStats.length) * 10) / 10 : 0,
      /** 工作日平均每天的工作相关占用小时 */
      workloadHoursPerWorkday: workdayStats.length
        ? Math.round((hours(totalWorkBusyMin) / workdayStats.length) * 10) / 10
        : 0,
      /** 工作日平均每天的总占用小时（工作 + 生活） */
      busyHoursPerWorkday: workdayStats.length ? Math.round((hours(totalBusyMin) / workdayStats.length) * 10) / 10 : 0,
      /** 会议占工作时段的比例 */
      meetingLoadRatio,
      /** 工作相关占用占工作表时段的比例 */
      workloadLoadRatio,
      /** 总占用占工作表时段的比例 */
      occupancyRatio,
    },
    structure: {
      deepBlocks,
      deepBlockCount: deepBlocks.length,
      meetingFreeWorkdays,
      eveningMeetings,
      eveningWork,
      /** 晚间生活安排（如晚饭后的运动、家庭时间） */
      eveningLife,
      /** 晚间占用合计（会议 + 独自工作 + 生活） */
      eveningCount: eveningMeetings.length + eveningWork.length + eveningLife.length,
      weekendMeetings,
      weekendWork,
      weekendLife,
      /** 周末占用合计（会议 + 独自工作 + 生活） */
      weekendCount: weekendMeetings.length + weekendWork.length + weekendLife.length,
      longMeetings,
      backToBack,
      conflicts,
    },
    weekly,
    topPeople,
    topRecurring,
    topics,
    /** 生活事务分类（运动健身/家庭陪伴/个人事务…） */
    lifeKinds,
    /** 时长分层（很短/常规/较长/超长） */
    durations,
    /** 地点：线上/线下/未填 计数 + Top 地点 */
    locations,
    timeline,
    dayStats: dayStats.map((d) => ({
      key: d.key,
      label: d.label,
      isWorkday: d.isWorkday,
      meetingCount: d.meetingCount,
      meetingHours: d.meetingHours,
      workCount: d.workCount,
      workHours: d.workHours,
      busyHours: d.busyHours,
      firstMeetingAt: d.firstMeetingAt,
      lastMeetingEndAt: d.lastMeetingEndAt,
      allDayCount: d.allDayCount,
    })),
  };
}

/* ------------------------------------------------------------ 小工具 */

function dayKeyOf(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function hhmmOf(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** 周一为一周的开始（国内习惯）。 */
function weekKeyOf(date, timeZone) {
  const p = partsInZone(date, timeZone);
  const utc = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dow = (utc.getUTCDay() + 6) % 7; // 0=周一
  const monday = new Date(utc.getTime() - dow * 86_400_000);
  const mp = { year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate() };
  const sunday = addDays(zonedTimeToUtc(mp, timeZone), 6, timeZone);
  const sp = partsInZone(sunday, timeZone);
  return `${mp.year}-${String(mp.month).padStart(2, '0')}-${String(mp.day).padStart(2, '0')} ~ ${String(sp.month).padStart(2, '0')}-${String(sp.day).padStart(2, '0')}`;
}

/** 供界面/报告复用的"排除说明"文案。 */
export function describeExcluded(source) {
  const reasons = Object.entries(source?.excludedReasons || {});
  if (!reasons.length) return '没有需要排除的条目';
  return reasons.map(([reason, count]) => `${reason} ${count} 条`).join('、');
}
