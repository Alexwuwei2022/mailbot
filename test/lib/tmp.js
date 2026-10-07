/**
 * 测试用的临时目录助手。
 *
 * ## 为什么需要这个
 *
 * 4 个测试脚本里散着 11 处 `fs.mkdtempSync(path.join(os.tmpdir(), 'mailbot-xxx-'))`，
 * 它们各自建目录、基本没人删：实测用户机器的 `%TEMP%` 里攒了 137 个 `mailbot-*` 目录
 * （约 4.1 MB），而且**只增不减**——每跑一次 `npm test` 就多一批。名字有
 * `mailbot-cal-` / `mailbot-selftest-` / `mailbot-smoke-` / `mailbot-fresh-` /
 * `mailbot-root-`，以及用例内部的 `mailbot-cap-` / `mailbot-budget-` /
 * `mailbot-cache-` / `mailbot-backfill-` / `mailbot-tz-`。
 *
 * 修复前实测：跑一次 `npm test` 净增 3 个主数据目录（`mailbot-cal-` / `mailbot-selftest-` /
 * `mailbot-smoke-` 各一个）；用例内部那 6 个 scratch 目录只靠 `calendar-selftest.js` 里的
 * 一份本地删除函数兜着，一旦用例中途崩掉或进程被中断就同样留下（用户机器上的
 * `mailbot-cap-` / `mailbot-budget-` 就是这么来的）。所以这里把这件事抽成统一的一份：
 * **谁建的目录谁登记，进程退出时统一删**。
 *
 * ## 两个刻意的设计
 *
 * 1. **清理必须容忍失败**：Windows 上刚写过的文件偶尔还被句柄占着（EPERM/EBUSY），
 *    删除失败本身与被测逻辑无关，绝不能因此把测试搞红。所以删除失败只重试、不抛错，
 *    实在删不掉就留给系统临时目录清理，测试结论不受影响。
 * 2. **清理必须是同步的**：`process.on('exit')` 里只有同步代码会被执行——事件循环已经停了，
 *    `fs.promises.*` / `await` 排进去的任务永远不会跑。所以这里从头到尾用 `fs.rmSync`。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 已登记、等待进程退出时清理的临时目录 */
const registered = new Set();

/** 退出钩子只装一次（重复 `process.on` 会让同一个目录被删多次） */
let hookInstalled = false;

/**
 * 删除一个目录，失败就等一小会儿再试。
 *
 * 同步睡眠用 `Atomics.wait`（不占 CPU，也不依赖 `await`，可在 `exit` 钩子里用）。
 * 全部重试都失败也**不抛错**：清理失败不是被测逻辑的错。
 */
function rmTolerant(dir) {
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch {
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120);
      } catch {
        /* ignore */
      }
    }
  }
  return false;
}

/** 装一次进程退出清理：正常结束（含 `process.exit`）走 `exit`，Ctrl+C 走 `SIGINT`。 */
function installExitHook() {
  if (hookInstalled) return;
  hookInstalled = true;

  // `exit`：同步钩子，正常结束和显式 process.exit() 都会走到这里
  process.on('exit', () => {
    cleanupTempDirs();
  });

  /*
   * 信号：一旦注册了监听器，Node 默认的「收到就退出」就不再生效，
   * 因此这里清理完要自己退出（退出码沿用 shell 惯例：130 = SIGINT，143 = SIGTERM）。
   */
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ]) {
    process.on(signal, () => {
      cleanupTempDirs();
      process.exit(code);
    });
  }
}

/**
 * 在系统临时目录下建一个目录，并登记到退出清理清单。
 *
 * @param {string} prefix 目录名前缀（保留调用方的套件/用例名，例如 `'mailbot-cal-'`）
 * @returns {string} 新建目录的绝对路径
 */
export function makeTempDir(prefix) {
  installExitHook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  registered.add(dir);
  return dir;
}

/**
 * 清理全部已登记的临时目录。
 *
 * - 幂等：可重复调用，第二次是空操作；
 * - 不抛错：单个目录删不掉（句柄未释放）只重试并放弃，不影响测试结论；
 * - 无论成功与否都从清单移除，避免清单反复变长。
 */
export function cleanupTempDirs() {
  for (const dir of [...registered]) {
    registered.delete(dir);
    rmTolerant(dir);
  }
}
