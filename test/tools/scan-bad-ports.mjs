/**
 * 手动工具（**不在 `npm test` 里**）：把「fetch 禁用端口名单」跟 undici 的真实行为对一遍。
 *
 * 为什么需要它：名单是 fetch 规范里的一串硬编码端口，Node 升级后可能变。名单不全 =
 * 抽到那个端口的本地服务仍然会被 `fetch` 判为 `bad port`（偶发红），名单多了 = 白白
 * 少掉一个可用端口。这个脚本把端口逐个发给 undici，只认 `cause: bad port` 这一种失败，
 * 于是"缺哪个/多哪个"一眼可见——`6679` 就是这么发现的（初版照记忆写的名单里没有它）。
 *
 *   node test/tools/scan-bad-ports.mjs            # 全量 1–65535，约 30 秒
 *   node test/tools/scan-bad-ports.mjs 1025 15000 # 只扫本机动态端口范围（更快）
 *
 * 动态端口范围怎么查：
 *   Windows  netsh int ipv4 show dynamicport tcp
 *   Linux    sysctl net.ipv4.ip_local_port_range
 *   macOS    sysctl net.inet.ip.portrange.first net.inet.ip.portrange.last
 */

import { FORBIDDEN_FETCH_PORTS, isForbiddenFetchPort } from '../../server/lib/http.js';

const from = Number(process.argv[2] || 1);
const to = Number(process.argv[3] || 65535);
const CONCURRENCY = 64;

if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 65535 || from > to) {
  console.error('用法：node test/tools/scan-bad-ports.mjs [起始端口] [结束端口]（1–65535）');
  process.exit(2);
}

/** undici 会不会以 `bad port` 拒绝这个端口。 */
async function undiciRejects(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    return false; // 本机真有服务在监听（名单里的端口不可能走到这里）
  } catch (err) {
    return /bad port/i.test(String(err?.cause?.message || ''));
  }
}

const missing = []; // undici 拒绝、名单里却没有 → 还会偶发红
const extra = []; // 名单里有、undici 却不拒绝 → 白少一个端口
let cursor = from;
let done = 0;
const started = Date.now();

await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const port = cursor;
      cursor += 1;
      if (port > to) return;
      const rejected = await undiciRejects(port);
      const listed = isForbiddenFetchPort(port);
      if (rejected && !listed) missing.push(port);
      if (!rejected && listed) extra.push(port);
      done += 1;
      if (done % 5000 === 0) process.stdout.write(`  …${done}/${to - from + 1}\n`);
    }
  }),
);

console.log(`\n扫描 ${from}-${to}（${to - from + 1} 个端口，${((Date.now() - started) / 1000).toFixed(1)}s）`);
console.log(`名单条目总数：${FORBIDDEN_FETCH_PORTS.size}`);
console.log(`undici 拒绝但名单缺失：${missing.length} ${JSON.stringify(missing)}`);
console.log(`名单有但 undici 不拒绝：${extra.length} ${JSON.stringify(extra)}`);
process.exitCode = missing.length ? 1 : 0;
