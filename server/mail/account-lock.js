/**
 * 同账号 IMAP 串行化（按「邮箱账号」排队，而不是按实例 id）。
 *
 * ## 为什么需要它
 *
 * 这个程序里有**多个入口会各自连同一个邮箱账号的 IMAP**：整轮分析、分析预检、
 * 检索的按需回补、检索的正文回退、邮件正文回源、同步草稿到草稿箱、发送后的收尾、
 * 邮箱连通性诊断。它们互相不认识，谁都能在别人还开着连接时再开一条。
 *
 * 实测（`test/selftest.js` 的「同账号 IMAP 串行化」一组用例，mock 服务器侧统计
 * 「同时活跃连接数」）：一次分析进行中再去取一封邮件的正文/做一次预检/跑一次诊断/
 * 做一次按需回补，峰值都是 **2** 条连接打到同一个账号。企业邮箱普遍限制同账号并发连接数，
 * 撞上会表现为连接被拒或账号被锁（`imapflow` 只会给一句认证/连接失败，很难看出是并发导致的）。
 *
 * ## 语义
 *
 *   - **按账号**排队：键是 `imap.host:port:authUser`。同一个账号的 IMAP 操作串行执行；
 *     不同账号（多实例）各有各的队列，**互不阻塞**——多账号必须仍然能并发。
 *   - **有界**：等待有上限 `waitMs`，队列有长度上限 `maxQueue`。超时或队列满都抛
 *     `ACCOUNT_BUSY`（409），带 `detail`（当前占用者、已等待毫秒、队列深度），
 *     不做无限等待，也不静默丢弃。
 *   - **等待可见**：开始排队时打日志，并通过 `onWait` 回调把「谁在占用、前面还有几个」
 *     交给调用方（引擎会把它变成进度事件与运行相位，检索会变成 SSE 进度）。
 *   - **可取消**：传 `signal`（引擎的 abort 对象）后，排队期间被取消会立刻抛出，
 *     不会让人等满整个超时。
 *
 * ## 死锁（重要）
 *
 * 本模块**不是可重入锁**。规则：**持有许可期间不得再调用任何会连 IMAP 的入口**
 * （也就是本文件的所有调用点）。当前代码里不存在这种嵌套——
 *   - 引擎在持锁期间只用**同一条**已建立连接的 client（`fetchRawSourceWithin` /
 *     `appendToMailbox` 等），不会再 connect；它调用的 `runFollowUpScan` 只读本地 state，不连邮箱；
 *   - 一次检索里的「按需回补」与「正文回退」是**先后**两次 acquire，不是嵌套；
 *   - 日历「从邮件生成日程」是调用引擎本身，不是引擎再调它。
 * 万一将来有人写出嵌套调用，它**不会永久挂死**：自己会等到 `waitMs` 超时，
 * 然后抛 `ACCOUNT_BUSY`（有明确错误码与日志）。`test/selftest.js` 的「排队有界」用例
 * 把这条行为固定住了（用例本身也带超时保护，不会因为潜在死锁把整套测试挂死）。
 *
 * 依赖：只用 Node 内置能力，不新增运行时依赖。
 */

import { AppError, log } from '../lib/util.js';

/** 普通入口（预检 / 回补 / 正文回源 / 草稿同步 / 诊断）最长排队等待。 */
export const DEFAULT_WAIT_MS = 30_000;
/** 整轮分析最长排队等待：「等一次分析/一次回补跑完」比「等一次预检」合理得多。 */
export const RUN_WAIT_MS = 120_000;
/** 同一账号最多允许多少个操作同时在排队（超过就直接拒绝，而不是让队列无限长）。 */
export const DEFAULT_MAX_QUEUE = 8;

/** 队列状态：账号键 → { busy, holder, since, waiting: [] } */
const gates = new Map();

/** 测试用：把等待上限临时改小，好在毫秒级验证「超时会给明确错误」。 */
let limitsOverride = null;

/**
 * 账号键：**同一个邮箱账号**才排队，而不是同一个实例。
 *
 * 用 host:port:authUser 而不是 instance.id，是因为两个实例完全可以指向同一个邮箱
 * （配置里复制一份改了 id 的情形），那时它们打在服务商眼里是同一个账号、共用同一个并发额度。
 * 配置不完整（拿不到 host/user）时退回实例 id：至少同实例内不会重叠。
 */
export function accountKeyOf(instance) {
  const imap = instance?.imap || {};
  const host = String(imap.host || '').trim().toLowerCase();
  const user = String(imap.authUser || imap.user || '').trim().toLowerCase();
  if (!host || !user) return `instance:${instance?.id || 'unknown'}`;
  return `${host}:${Number(imap.port) || 0}:${user}`;
}

function limitsOf() {
  return limitsOverride || { waitMs: DEFAULT_WAIT_MS, maxQueue: DEFAULT_MAX_QUEUE };
}

function gateOf(key) {
  let gate = gates.get(key);
  if (!gate) {
    gate = { key, busy: false, holder: null, since: null, waiting: [] };
    gates.set(key, gate);
  }
  return gate;
}

/**
 * 当前排队情况（供接口/日志展示「正在排队」用）。
 *
 * 刻意**不含账号键**（那是 `主机:端口:账号`）：接口只需要说清"谁占着、还要等多久"，
 * 不必把邮箱地址与服务器地址再复制一份到响应里。
 */
export function accountQueueState(instance) {
  const key = typeof instance === 'string' ? instance : accountKeyOf(instance);
  const gate = gates.get(key);
  if (!gate) return { busy: false, holder: null, waitedMs: 0, queued: 0, waiting: [] };
  return {
    busy: gate.busy,
    holder: gate.holder,
    waitedMs: gate.since ? Date.now() - gate.since : 0,
    queued: gate.waiting.length,
    /** 排队中每个操作的标签与已等待毫秒 */
    waiting: gate.waiting.map((w) => ({ label: w.label, waitedMs: Date.now() - w.at })),
  };
}

/** 把等待时长写成人话（毫秒级也要如实，不能四舍五入成「0 秒」）。 */
function humanMs(ms) {
  return ms >= 1000 ? `${Math.round(ms / 1000)} 秒` : `${Math.max(1, Math.round(ms))} 毫秒`;
}

function busyError(key, label, waitedMs, waiting) {
  const holder = gates.get(key)?.holder || '另一个邮箱操作';
  return new AppError(
    `邮箱正忙：${holder} 还没结束（已等待 ${humanMs(waitedMs)}），暂时无法开始「${label}」。请稍后重试。`,
    {
      code: 'ACCOUNT_BUSY',
      status: 409,
      detail: {
        holder,
        label,
        waitedMs,
        queued: waiting,
        /** 建议客户端等这么久再试（界面上可以直接显示） */
        retryAfterMs: 5000,
      },
    },
  );
}

function cancelledError(label, code) {
  return new AppError(`「${label}」在等待邮箱空闲时被取消。`, {
    code,
    status: 499,
    detail: { label },
  });
}

/**
 * 取一个账号许可。返回值是一个 **release 函数**（必须调用，建议放在 finally 里）。
 *
 * @param {object} instance 实例配置（至少要能算出账号键）
 * @param {object} [options]
 * @param {string} [options.label] 人类可读的操作名（日志与错误信息里用）
 * @param {number} [options.waitMs] 本次最长排队等待毫秒
 * @param {number} [options.maxQueue] 本次允许的最大排队长度
 * @param {object} [options.signal] `{ cancelled: boolean }`（引擎的 abort 对象），排队期间轮询它
 * @param {string} [options.cancelCode] 取消时的错误码（引擎用 RUN_CANCELLED）
 * @param {Function} [options.onWait] 开始排队时回调一次：({ label, holder, queued, waitedMs, waitMs })
 */
export async function acquireAccount(instance, options = {}) {
  const {
    label = '邮箱操作',
    waitMs = limitsOf().waitMs,
    maxQueue = limitsOf().maxQueue,
    signal = null,
    cancelCode = 'ACCOUNT_WAIT_CANCELLED',
    onWait = null,
  } = options;

  const key = accountKeyOf(instance);
  const gate = gateOf(key);

  if (!gate.busy) {
    gate.busy = true;
    gate.holder = label;
    gate.since = Date.now();
    return makeRelease(gate);
  }

  if (gate.waiting.length >= maxQueue) {
    log.warn(`邮箱排队已满（${key}）：拒绝「${label}」，当前占用者 ${gate.holder}，已排队 ${gate.waiting.length} 个`);
    throw busyError(key, label, 0, gate.waiting.length);
  }

  const waiter = { label, at: Date.now() };
  const queued = gate.waiting.length + 1;
  log.info(`邮箱正忙：${gate.holder} 进行中，「${label}」开始排队（前面还有 ${queued - 1} 个，最多等 ${Math.round(waitMs / 1000)} 秒）`);
  try {
    onWait?.({ label, holder: gate.holder, queued, waitedMs: 0, waitMs });
  } catch (err) {
    log.debug(`onWait 回调异常（忽略）：${err?.message || err}`);
  }

  await new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, arg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (cancelPoll) clearInterval(cancelPoll);
      fn(arg);
    };
    waiter.resolve = () => finish(resolve);
    waiter.reject = (err) => finish(reject, err);

    const timer = setTimeout(() => {
      const i = gate.waiting.indexOf(waiter);
      if (i >= 0) gate.waiting.splice(i, 1);
      log.warn(`邮箱排队超时（${key}）：「${label}」等了 ${Math.round(waitMs / 1000)} 秒仍未轮到，占用者是 ${gate.holder}`);
      waiter.reject(busyError(key, label, Date.now() - waiter.at, gate.waiting.length));
    }, waitMs);
    timer.unref?.();

    // 排队期间被取消（例如用户点了「取消」）：不必等满超时
    const cancelPoll = signal
      ? setInterval(() => {
          if (signal.cancelled) {
            const i = gate.waiting.indexOf(waiter);
            if (i >= 0) gate.waiting.splice(i, 1);
            waiter.reject(cancelledError(label, cancelCode));
          }
        }, 100)
      : null;
    cancelPoll?.unref?.();

    gate.waiting.push(waiter);
  });

  // 所有权由上一个持有者在 release 时直接交接过来（busy 一直是 true）
  const waitedMs = Date.now() - waiter.at;
  log.info(`邮箱排到队了：「${label}」等待 ${waitedMs}ms 后开始（占用者变更为 ${label}）`);
  gate.holder = label;
  gate.since = Date.now();
  return makeRelease(gate);
}

function makeRelease(gate) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const next = gate.waiting.shift();
    if (next) {
      // 直接把所有权交给队首：busy 保持 true，中间不会有人插队
      gate.holder = next.label;
      gate.since = Date.now();
      next.resolve();
      return;
    }
    gate.busy = false;
    gate.holder = null;
    gate.since = null;
  };
}

/** 测试钩子：临时收紧/放宽等待上限与队列长度；传 null 恢复默认。 */
export function __setAccountLimitsForTest(limits) {
  limitsOverride = limits ? { ...limits } : null;
}
