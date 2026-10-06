/**
 * 测试用的端口工具。
 *
 * ## 为什么需要这个
 *
 * 测试里大量出现这种写法：
 *
 * ```js
 * await new Promise((r) => server.listen(0, '127.0.0.1', r));
 * const url = `http://127.0.0.1:${server.address().port}`;
 * ```
 *
 * 看起来没问题——监听回调已经触发，端口应该就绪了。
 * 但实测（Windows + 频繁起停）**偶发**回调触发时 `address()` 还是 `null` 或 `{ port: 0 }`，
 * 于是拼出 `http://127.0.0.1:0`，下游 `fetch` 只报一句 `fetch failed ← bad port`：
 * 既看不出是哪一步错的，也看不出真正的原因。这个 flake 在本项目里出现过两次，
 * 每次都要重新排查一遍。
 *
 * 服务端的 `startServer` 早就为同一个坑加了「等一下再取一次，取不到就明确报错」，
 * 但测试里的这些本地 mock 服务器没有——所以把那段逻辑抽到这里共用。
 */

/**
 * 监听随机端口（`listen(0)`），并等到端口真的可用再返回。
 *
 * @param {import('node:http').Server} server 已创建、尚未监听的服务器
 * @param {string} [host] 监听地址，默认回环
 * @returns {Promise<number>} 实际端口
 * @throws {Error} 反复取不到端口时明确报错（而不是交出一个 `:0` 的地址）
 */
export async function listenRandom(server, host = '127.0.0.1') {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  return resolvePort(server);
}

/**
 * 读取**已经在监听**的服务器的端口，取不到就重试。
 *
 * 有些 mock 服务器监听的是固定端口（`listen(port, ...)`），不能再用 `listenRandom`
 * 去监听一次（会 ERR_SERVER_ALREADY_LISTEN）——那种情况用这个函数。
 */
export async function resolvePort(server) {
  let addr = server.address();
  for (let i = 0; i < 40 && (!addr || !addr.port); i += 1) {
    await new Promise((r) => setTimeout(r, 10));
    addr = server.address();
  }
  if (!addr || !addr.port) {
    throw new Error(
      '测试服务器已监听但拿不到端口号（Windows 上偶发）：这不是被测代码的问题，重跑即可；' +
        '若持续出现，请改用固定端口排查端口占用。',
    );
  }
  return addr.port;
}

/** 监听随机端口并直接返回可用的回环地址。 */
export async function listenRandomUrl(server, host = '127.0.0.1') {
  const port = await listenRandom(server, host);
  return `http://${host}:${port}`;
}
