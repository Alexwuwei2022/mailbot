/**
 * 定时自动分析（主动性）。
 *
 * ## 为什么需要它
 *
 * 在此之前，程序**只有你点它才动**：不打开页面，它什么都不知道。
 * 而"提效"的核心不是"能分析"，是"**不用你惦记**"——早上自动跑一次，
 * 有事才提醒你。
 *
 * ## 设计要点
 *
 *   - **默认关闭**：会在你不知情时连邮箱、花 token、把正文送模型，必须明确开启；
 *   - **到点才跑**：每分钟对一次表，命中 `schedule.times` 且当天允许才跑；
 *   - **同一时刻只跑一次**：用 `lastSlot`（`YYYY-MM-DD HH:MM`）记录，
 *     进程重启、tick 抖动、手动改系统时间都不会重复触发；
 *   - **不抢正在跑的任务**：已有分析在跑就跳过本次（宁可漏一次，也不要并发两遍 I/O）；
 *   - **失败不影响下一次**：记录失败原因，下一个时刻照常尝试。
 */

import { getConfig, getInstance } from './config/index.js';
import { formatInZone, partsInZone } from './calendar/time.js';
import { log } from './lib/util.js';
import * as store from './store/state.js';
import { isRunning, runScan } from './ai/engine.js';

const TICK_MS = 60_000;

let timer = null;
let running = false;
/** 最近一次 tick 的结果，供设置页显示"定时器活着吗" */
let lastTickAt = null;

/** 当前时刻在配置时区里的 `YYYY-MM-DD HH:MM`。 */
function slotKey(now) {
  const { calendar } = getConfig();
  const tz = calendar?.timeZone || 'Asia/Shanghai';
  const p = partsInZone(now, tz);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    day: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
    time: `${pad(p.hour)}:${pad(p.minute)}`,
    weekday: p.weekday,
    label: `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`,
    tz,
  };
}

/** 星期几（0=周日）。`partsInZone` 给的是英文缩写。 */
const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * 判断此刻是否该跑。
 *
 * 抽成纯函数是为了能直接测"到点/没到点/星期不对/已经跑过"四种情况，
 * 不必等真实的分钟边界。
 *
 * @param {object} o { now, schedule, lastSlot, busy }
 */
export function shouldRunNow({ now = new Date(), schedule, lastSlot = null, busy = false } = {}) {
  if (!schedule?.enabled) return { run: false, reason: 'disabled' };
  if (busy) return { run: false, reason: 'busy' };
  const times = Array.isArray(schedule.times) ? schedule.times.filter((t) => /^\d{2}:\d{2}$/.test(String(t))) : [];
  if (!times.length) return { run: false, reason: 'no-times' };

  const s = slotKey(now);
  const wd = WEEKDAY_INDEX[s.weekday];
  const days = Array.isArray(schedule.days) && schedule.days.length ? schedule.days.map(Number) : [0, 1, 2, 3, 4, 5, 6];
  if (!days.includes(wd)) return { run: false, reason: 'weekday', slot: s };

  if (!times.includes(s.time)) return { run: false, reason: 'not-now', slot: s };
  // 同一分钟只跑一次：重启/抖动/改系统时间都不会重复
  const key = `${s.day} ${s.time}`;
  if (lastSlot === key) return { run: false, reason: 'already-ran', slot: s, key };
  return { run: true, slot: s, key };
}

/**
 * 跑一次定时分析，并按需通知。
 * 供定时器调用，也可手动触发（测试/设置页"立即试一次"）。
 */
export async function runScheduledScan({ now = new Date(), trigger = 'schedule', force = false } = {}) {
  const config = getConfig();
  const instanceId = config.defaultInstanceId;
  /*
   * 除了"定时器自己在跑"，还要看**引擎里有没有任务在跑**：
   * 手动点了一次分析还没结束时，定时器不该去撞它（引擎会抛 RUN_IN_PROGRESS），
   * 更不该把那句报错写进 lastError、白白占掉这个时刻。
   */
  const decision = shouldRunNow({
    now,
    schedule: config.schedule,
    lastSlot: store.getState().schedule?.lastSlot || null,
    busy: running || isRunning(instanceId),
  });
  if (!force && !decision.run) return { skipped: true, reason: decision.reason };

  running = true;
  const key = decision.key || `${slotKey(now).day} ${slotKey(now).time}`;
  try {
    const result = await runScan({
      instanceId,
      windowHours: Number(config.schedule?.windowHours) || 24,
      trigger,
    });
    store.setScheduleState({
      lastSlot: key,
      lastRunAt: new Date().toISOString(),
      lastResult: {
        ok: true,
        fetched: result?.counts?.fetched ?? result?.fetched ?? null,
        analyzed: result?.counts?.analyzed ?? result?.analyzed ?? null,
        needsReply: result?.counts?.needsReply ?? null,
        drafts: result?.counts?.drafts ?? null,
      },
      lastError: null,
    });
    log.info(`定时分析完成：${JSON.stringify(store.getState().schedule?.lastResult || {})}`);
    return { skipped: false, result, key };
  } catch (err) {
    /*
     * 失败**不占用 lastSlot**吗？——占用。
     *
     * 否则"邮箱连不上"会导致每分钟重试一次，把日志和网络都刷爆。
     * 下一个时刻点自然会再试一次。
     */
    store.setScheduleState({
      lastSlot: key,
      lastRunAt: new Date().toISOString(),
      lastError: err?.message || String(err),
    });
    log.warn(`定时分析失败（下一个时刻会再试）：${err?.message || err}`);
    return { skipped: false, error: err?.message || String(err), key };
  } finally {
    running = false;
  }
}

/** 启动分钟级 tick。重复调用安全（先停再启）。 */
export function startScheduler() {
  stopScheduler();
  lastTickAt = new Date().toISOString();
  timer = setInterval(async () => {
    lastTickAt = new Date().toISOString();
    try {
      const out = await runScheduledScan();
      if (!out.skipped && !out.error) {
        // 只有真的跑出结果才通知；skip 与失败都不打扰用户
        await notifyRun(out.result);
      }
    } catch (err) {
      log.warn(`定时器 tick 出错：${err?.message || err}`);
    }
  }, TICK_MS);
  // 定时器不应阻止进程退出
  timer.unref?.();
  return timer;
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 设置页用它显示"定时器是否在跑、下次大概什么时候"。 */
export function schedulerStatus() {
  const config = getConfig();
  const s = store.getState().schedule || {};
  return {
    enabled: !!config.schedule?.enabled,
    ticking: !!timer,
    tickMs: TICK_MS,
    lastTickAt,
    times: config.schedule?.times || [],
    days: config.schedule?.days || [],
    windowHours: config.schedule?.windowHours || 24,
    timeZone: config.calendar?.timeZone || 'Asia/Shanghai',
    lastSlot: s.lastSlot || null,
    lastRunAt: s.lastRunAt || null,
    lastResult: s.lastResult || null,
    lastError: s.lastError || null,
  };
}

/**
 * 分析完成后的通知。
 *
 * 只在"确实有事"时提醒：有待回复或新草稿才打扰你。
 * 三种渠道各自独立、互不影响：
 *   1. 页内（SSE `notify` 事件 → 弹条 + 徽标）；
 *   2. 浏览器桌面通知（页面开着时由前端弹）；
 *   3. 自寄简报（**唯一在你什么都没打开时也能收到**的渠道）。
 */
export async function notifyRun(result) {
  const config = getConfig();
  const counts = result?.counts || result?.result?.counts || {};
  const needsReply = Number(counts.needsReply || 0);
  const drafts = Number(counts.drafts || 0);
  const fetched = Number(counts.fetched || 0);
  const analyzed = Number(counts.analyzed || 0);
  const note = { needsReply, drafts, fetched, analyzed, at: new Date().toISOString() };

  // 引擎已经在跑的时候会推 SSE；这里补一条"定时任务完成"的语义事件
  emitNotify({ ...note, kind: 'schedule' });

  const worthTelling = needsReply > 0 || drafts > 0;
  if (!worthTelling) {
    log.info(`定时分析：本次没有需要你处理的邮件（拉取 ${fetched}、分析 ${analyzed}），不打扰`);
    return { notified: false, reason: 'nothing-to-tell', note };
  }

  if (!config.notify?.email) return { notified: false, reason: 'email-off', note };
  try {
    const out = await sendDigestEmail(note);
    return { notified: true, email: out, note };
  } catch (err) {
    log.warn(`自寄简报失败（不影响分析结果）：${err?.message || err}`);
    return { notified: false, reason: 'email-failed', error: err?.message || String(err), note };
  }
}

/** 让 index.js 把自己的 SSE 广播函数注入进来，避免循环依赖。 */
let emitNotify = () => {};
export function setNotifyEmitter(fn) {
  emitNotify = typeof fn === 'function' ? fn : () => {};
}

/**
 * 自寄简报：把"有几件事等着你"寄到你自己的邮箱。
 *
 * 为什么值得做：页内提示和浏览器通知都要求**页面开着**；
 * 只有邮件能在你合上电脑、关掉窗口之后仍然找到你。
 */
export async function sendDigestEmail(note) {
  const config = getConfig();
  const instance = getInstance(config.defaultInstanceId);
  const to = String(config.notify?.emailTo || '').trim() || instance.identity?.address || instance.user;
  if (!to) throw new Error('没有可用的收件地址：请填写「通知 → 收件人」或配置发件身份');

  const lines = [
    `自动分析已完成（${formatInZone(new Date(note.at), config.calendar?.timeZone || 'Asia/Shanghai')}）。`,
    '',
    `拉取邮件：${note.fetched} 封`,
    `新分析：${note.analyzed} 封`,
    `需要你处理：${note.needsReply} 封`,
    `新起草：${note.drafts} 封`,
    '',
    '打开界面查看详情与原文。',
  ];
  const { sendMessage } = await import('./mail/smtp.js');
  return sendMessage(
    instance,
    {
      to,
      subject: `【轻效】需要你处理 ${note.needsReply} 封${note.drafts ? `，新草稿 ${note.drafts} 封` : ''}`,
      text: lines.join('\n'),
    },
    { pool: false },
  );
}
