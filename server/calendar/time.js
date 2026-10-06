/**
 * 时区与日期区间工具。
 *
 * 设计原则：项目里**只以一种时区解释人类时间**（config.calendar.timeZone）。
 * 所有磁盘/网络传输一律用 UTC ISO 字符串，只有在「按天切分」和「展示」时才换算到本地时区，
 * 避免出现「今天的日程被算到昨天」这类跨时区错位。
 */

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** 校验时区名是否被运行时支持。 */
export function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const formatterCache = new Map();

function partsFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

/** 取某个瞬间在指定时区下的日历字段。 */
export function partsInZone(input, timeZone) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error(`无效时间：${input}`);
  const parts = {};
  for (const { type, value } of partsFormatter(timeZone).formatToParts(date)) {
    if (type !== 'literal') parts[type] = value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: parts.weekday,
  };
}

/** 某瞬间在指定时区的 UTC 偏移（分钟，东八区为 +480）。 */
export function offsetMinutes(input, timeZone) {
  const date = input instanceof Date ? input : new Date(input);
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // 抹掉毫秒再比，否则会多出 0-999ms 的误差
  return Math.round((asUtc - (date.getTime() - date.getMilliseconds())) / 60_000);
}

/** 把「某时区的墙上时间」转成真实瞬间。 */
export function zonedTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  // 用猜测值求偏移，再用偏移修正一次（对绝大多数时区一次即收敛；跨 DST 边界再迭代一次）
  let ts = guess;
  for (let i = 0; i < 3; i += 1) {
    const off = offsetMinutes(new Date(ts), timeZone);
    const next = guess - off * 60_000;
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/** 某瞬间在指定时区的当天 00:00（返回真实瞬间）。 */
export function startOfDay(input, timeZone) {
  const p = partsInZone(input, timeZone);
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone);
}

/* ------------------------------------------------------------ 邮件头部日期 */

const RFC_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * 生成 RFC 5322 的 `Date:` 值，**用配置时区的数字偏移**而不是 GMT。
 *
 * 为什么不用 `toUTCString()`：它写出的是 `… GMT`（等价 +0000）。绝对时刻没错，
 * 但 Foxmail 等客户端的「已发送」列表在很多版本里会**按头部原样显示偏移**，
 * 于是中国用户看到的是 UTC 时间（比实际早 8 小时）。
 * 写成 `+0800` 既完全符合 RFC 5322，也让各客户端直接显示成期望的本地时间。
 *
 * @param {Date|string|number} input
 * @param {string} timeZone IANA 时区名
 * @returns {string} 形如 `Wed, 01 Oct 2026 10:44:00 +0800`
 */
export function formatRfc5322Date(input, timeZone = 'Asia/Shanghai') {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error(`无效时间：${input}`);
  const p = partsInZone(date, timeZone);
  const off = offsetMinutes(date, timeZone);
  const sign = off < 0 ? '-' : '+';
  const abs = Math.abs(off);
  const pad = (n) => String(n).padStart(2, '0');
  const weekday = RFC_WEEKDAYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return (
    `${weekday}, ${pad(p.day)} ${months[p.month - 1]} ${p.year} ` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/** 在时区日历上加减天数，并**保持原有的墙上时刻**（跨 DST 也不会漂移）。 */
export function addDays(input, days, timeZone) {
  const p = partsInZone(input, timeZone);
  // 用 UTC 做纯日期加减，再按原墙钟时分秒还原，避免 DST 造成 23/25 小时问题
  const shifted = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return zonedTimeToUtc(
    {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
      hour: p.hour,
      minute: p.minute,
      second: p.second,
    },
    timeZone,
  );
}

export function addMinutes(input, minutes) {
  const date = input instanceof Date ? input : new Date(input);
  return new Date(date.getTime() + minutes * 60_000);
}

export function addHours(input, hours) {
  return addMinutes(input, hours * 60);
}

/** 规范化成 RFC3339（Google Calendar 要求）。 */
export function toRfc3339(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) throw new Error(`无效时间：${input}`);
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** 人类可读的本地时间，如 2026-09-27 14:30（周日）。 */
export function formatInZone(input, timeZone, { withWeekday = false, withDate = true } = {}) {
  const p = partsInZone(input, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  const datePart = withDate ? `${p.year}-${pad(p.month)}-${pad(p.day)} ` : '';
  const weekday = withWeekday ? `（${zhWeekday(p.weekday)}）` : '';
  return `${datePart}${pad(p.hour)}:${pad(p.minute)}${weekday}`;
}

export function zhWeekday(shortName) {
  const idx = WEEKDAY_EN.indexOf(shortName);
  return idx >= 0 ? WEEKDAY_ZH[idx] : shortName;
}

/** 当天的键（本地时区的 YYYY-MM-DD），用于按天分组。 */
export function dayKey(input, timeZone) {
  const p = partsInZone(input, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * 生成「今天 / 明天 / 未来 N 天」的区间。
 * @returns {{timeZone: string, today: object, tomorrow: object, days: Array, range: object}}
 */
export function buildWindows(now, timeZone, lookaheadDays = 7) {
  const todayStart = startOfDay(now, timeZone);
  const tomorrowStart = addDays(todayStart, 1, timeZone);
  const dayAfterStart = addDays(todayStart, 2, timeZone);
  const rangeEnd = addDays(todayStart, lookaheadDays, timeZone);
  return {
    timeZone,
    today: { start: todayStart, end: tomorrowStart },
    tomorrow: { start: tomorrowStart, end: dayAfterStart },
    range: { start: todayStart, end: rangeEnd },
    days: Array.from({ length: lookaheadDays }, (_v, i) => {
      const start = addDays(todayStart, i, timeZone);
      return { index: i, start, end: addDays(todayStart, i + 1, timeZone), key: dayKey(start, timeZone) };
    }),
  };
}

/** 供提示词使用的「现在」上下文。 */
export function nowContext(now, timeZone) {
  const p = partsInZone(now, timeZone);
  const weekday = zhWeekday(p.weekday);
  const pad = (n) => String(n).padStart(2, '0');
  const dayOf = (offset) => {
    const d = addDays(startOfDay(now, timeZone), offset, timeZone);
    const dp = partsInZone(d, timeZone);
    return `${dp.year}-${pad(dp.month)}-${pad(dp.day)}`;
  };
  return {
    iso: toRfc3339(now),
    local: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`,
    date: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    weekday,
    todayDate: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    tomorrowDate: dayOf(1),
    dayAfterDate: dayOf(2),
    timeZone,
    offsetMinutes: offsetMinutes(now, timeZone),
  };
}

/**
 * 解析模型给出的时间。
 * 支持：RFC3339（带或不带偏移）、"YYYY-MM-DD HH:mm"、"YYYY-MM-DDTHH:mm"、"YYYY-MM-DD"。
 * 不带偏移的时间一律按配置时区解释——这正是模型输出的常见形态，必须正确处理，
 * 否则会把「明天 15:00」当成 UTC 而整体偏移 8 小时。
 *
 * @returns {{date: Date, hadOffset: boolean, allDay: boolean}|null}
 */
export function parseCalendarTime(value, timeZone) {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return { date: value, hadOffset: false, allDay: false };

  const raw = String(value).trim();
  // 1) 带显式偏移或 Z：交给 Date 解析
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return null;
    return { date, hadOffset: true, allDay: false };
  }
  // 2) 纯日期 → 当天 00:00（全天）
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number);
    return { date: zonedTimeToUtc({ year: y, month: m, day: d }, timeZone), hadOffset: false, allDay: true };
  }
  // 3) 不带偏移的日期时间
  const local = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (local) {
    const [, y, m, d, hh, mm, ss] = local;
    return {
      date: zonedTimeToUtc(
        { year: Number(y), month: Number(m), day: Number(d), hour: Number(hh), minute: Number(mm), second: Number(ss || 0) },
        timeZone,
      ),
      hadOffset: false,
      allDay: false,
    };
  }
  // 4) 兜底：交给 Date（例如 "2026/09/27 15:00"）
  const fallback = new Date(raw);
  if (Number.isNaN(fallback.getTime())) return null;
  return { date: fallback, hadOffset: false, allDay: false };
}

/** 判断两个瞬间是否同一本地日。 */
export function isSameDay(a, b, timeZone) {
  return dayKey(a, timeZone) === dayKey(b, timeZone);
}

/* ------------------------------------------------------------ 回顾窗口 */

/** 支持的回顾区间预设（顺序即界面展示顺序）。 */
export const REVIEW_PRESETS = [
  { id: 'last-7d', label: '过去 7 天', days: 7 },
  { id: 'last-30d', label: '过去 30 天', days: 30 },
  { id: 'last-month', label: '上个月' },
  { id: 'last-quarter', label: '上季度' },
  { id: 'last-year', label: '过去一年', days: 365 },
  { id: 'custom', label: '自定义区间' },
];

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dayLabelInZone(date, timeZone) {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/**
 * 把「上个月 / 上季度 / 过去一年 / 自定义」解析成确定的起止时刻。
 *
 * 关键约束：**必须按配置时区确定性解析**。
 * 「上个月」指上一个**自然月**（9/1 00:00 ~ 10/1 00:00），不是"往前 30 天"——
 * 否则同一句话在不同日子给出不同区间，报告也就无法复现。
 *
 * 区间语义统一为**左闭右开** [start, end)：
 * 这样"上个月"不会把本月 1 号 0 点的事件算进来。
 *
 * @param {object} input { preset, from, to, now, timeZone }
 * @returns {{id, label, from, to, start: Date, end: Date, days: number}}
 */
export function resolveReviewRange({ preset = 'last-30d', from, to, now = new Date(), timeZone = 'Asia/Shanghai' } = {}) {
  const p = partsInZone(now, timeZone);
  const todayStart = startOfDay(now, timeZone);

  const build = (id, label, start, end) => ({
    id,
    label,
    from: dayLabelInZone(start, timeZone),
    // 结束日按"含当天"展示，但内部用右开区间
    to: dayLabelInZone(new Date(end.getTime() - 1), timeZone),
    start,
    end,
    days: Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000)),
  });

  if (preset === 'custom') {
    const s = parseCalendarTime(String(from || ''), timeZone)?.date || null;
    // 结束日按"含当天"处理：加一天构成右开区间
    const e0 = parseCalendarTime(String(to || ''), timeZone)?.date || null;
    if (!s || !e0) return build('last-30d', '过去 30 天', addDays(todayStart, -29, timeZone), addDays(todayStart, 1, timeZone));
    const e = addDays(startOfDay(e0, timeZone), 1, timeZone);
    const start = startOfDay(s, timeZone);
    if (e <= start) return build('custom', `${dayLabelInZone(start, timeZone)} ~ ${dayLabelInZone(start, timeZone)}`, start, addDays(start, 1, timeZone));
    return build('custom', `${dayLabelInZone(start, timeZone)} ~ ${dayLabelInZone(new Date(e.getTime() - 1), timeZone)}`, start, e);
  }

  if (preset === 'last-month') {
    // 上一个自然月
    const start = zonedTimeToUtc({ year: p.month === 1 ? p.year - 1 : p.year, month: p.month === 1 ? 12 : p.month - 1, day: 1 }, timeZone);
    const end = zonedTimeToUtc({ year: p.year, month: p.month, day: 1 }, timeZone);
    return build('last-month', `${dayLabelInZone(start, timeZone).slice(0, 7)}（上个月）`, start, end);
  }

  if (preset === 'last-quarter') {
    // 上一个自然季度
    const q = Math.floor((p.month - 1) / 3); // 本季度序号 0..3
    let qy = p.year;
    let qq = q - 1;
    if (qq < 0) {
      qq = 3;
      qy -= 1;
    }
    const start = zonedTimeToUtc({ year: qy, month: qq * 3 + 1, day: 1 }, timeZone);
    const end = zonedTimeToUtc({ year: qy, month: qq * 3 + 4 > 12 ? 1 : qq * 3 + 4, day: 1 }, timeZone);
    const realEnd = qq * 3 + 4 > 12 ? zonedTimeToUtc({ year: qy + 1, month: 1, day: 1 }, timeZone) : end;
    return build('last-quarter', `${qy} Q${qq + 1}（上季度）`, start, realEnd);
  }

  if (preset === 'last-year') {
    // 滚动 12 个月：从今天往前 365 天到明天 0 点（含今天）
    const start = addDays(todayStart, -364, timeZone);
    const end = addDays(todayStart, 1, timeZone);
    return build('last-year', `过去一年（${dayLabelInZone(start, timeZone)} 起）`, start, end);
  }

  const days = REVIEW_PRESETS.find((x) => x.id === preset)?.days || 30;
  const start = addDays(todayStart, -(days - 1), timeZone);
  const end = addDays(todayStart, 1, timeZone);
  return build(preset, `过去 ${days} 天`, start, end);
}

/**
 * 把回顾区间切成"天"，供按天/按周聚合使用（左闭右开）。
 * 与 `buildWindows`（向前看）区分开，避免两处语义混用。
 */
export function buildPastWindows(range, timeZone) {
  const days = [];
  let cursor = startOfDay(range.start, timeZone);
  let guard = 0;
  while (cursor < range.end && guard < 400) {
    const next = addDays(cursor, 1, timeZone);
    days.push({ start: cursor, end: next, key: dayKey(cursor, timeZone), label: dayLabelInZone(cursor, timeZone) });
    cursor = next;
    guard += 1;
  }
  return days;
}

export { WEEKDAY_ZH };
