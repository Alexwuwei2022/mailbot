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
 * 于是拼出 `http://127.0.0.1:0`。这个 flake 在本项目里出现过两次，每次都要重新排查一遍。
 *
 * ## 还有第二个、更隐蔽的坑（2026-10 实测确认）：fetch 的「禁用端口」
 *
 * 上面那条只解释了 `:0`。真正把测试打红的是**另一件事**：
 *
 *   fetch 规范要求浏览器与 undici 在**建立连接之前**就拒绝一批端口（"bad port"），
 *   而 `listen(0)` 的端口是操作系统从**动态端口范围**里分配的。两者一旦相交，
 *   落到那个端口上的服务就**永远无法被 `fetch` 访问**——表现为偶发的一句
 *   `TypeError: fetch failed`（`cause: Error: bad port`），用例名每次都不一样。
 *
 * 本机实测（Windows，`netsh int ipv4 show dynamicport tcp` = start 1024 / 13977 个，
 * 即 **1025–15000**）与禁用名单有 **19 个交集**：1719/1720/1723/2049/3659/4045/4190/
 * 5060/5061/6000/6566/6665-6669/6679/6697/10080（**逐个端口与 undici 核对过**，
 * 初版照记忆写时漏了 6679）。裸 `listen(0)` 连抽 2 万次命中 20 次（≈1/1000；
 * 另一轮 6000 次命中 10 次 ≈ 1/600）；一套日历自检要起 23 个临时端口，
 * 于是约 **1/30~1/40 每套**——与实测的 3/60 同一数量级。
 * （默认动态范围 49152–65535 的机器上永远碰不到，这也是它看起来"只是偶发"的原因。）
 *
 * 所以这里不只"等一下再读一次端口"，还要求**端口本身能被 fetch 用**：
 * 抽到禁用端口就关掉重抽。这不是重试掩盖问题——重抽后若还有其他问题，用例会立刻红。
 */

import { FORBIDDEN_FETCH_PORTS, isForbiddenFetchPort } from '../../server/lib/http.js';

// 名单与判定只有一份实现（在 server/lib/http.js，生产代码里也要用），这里只做转发，
// 免得测试和生产各维护一份、慢慢漂移。
export { FORBIDDEN_FETCH_PORTS, isForbiddenFetchPort };

/** 监听一次；失败（EADDRINUSE 等）直接抛。 */
async function listenOnce(server, port, host) {
  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/**
 * 读取**已经在监听**的服务器的端口，取不到就重试。
 *
 * 有些 mock 服务器监听的是调用方指定的固定端口，不能再 `listen(0)` 去监听一次
 * （会 ERR_SERVER_ALREADY_LISTEN）——那种情况用这个函数。
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

/**
 * 在**指定端口**上监听并返回实际端口（调用方给了固定端口时用它）。
 *
 * 注意：这里**不会**检查"是否 fetch 禁用端口"——调用方既然指定了端口，
 * 就得自己负责（例如 mock IMAP/SMTP 走的是裸 socket，不受 fetch 限制）。
 */
export async function listenOn(server, port, host = '127.0.0.1') {
  await listenOnce(server, port, host);
  return resolvePort(server);
}

/**
 * 监听随机端口（`listen(0)`），并等到**端口真的可用、且 fetch 能用**再返回。
 *
 * @param {import('node:http').Server} server 已创建、尚未监听的服务器
 * @param {string} [host] 监听地址，默认回环
 * @returns {Promise<number>} 实际端口（保证不在 fetch/浏览器的禁用端口名单里）
 * @throws {Error} 反复取不到端口、或反复抽到禁用端口时明确报错（而不是交出一个坏地址）
 */
export async function listenRandom(server, host = '127.0.0.1', { attempts = 8 } = {}) {
  const drawn = [];
  for (let i = 0; i < attempts; i += 1) {
    const port = await listenOn(server, 0, host);
    if (!isForbiddenFetchPort(port)) return port;
    drawn.push(port);
    // 关掉重抽：这个端口 fetch 规范禁止使用，交出去只会得到一句 "bad port"
    await new Promise((resolve) => server.close(() => resolve()));
  }
  throw new Error(
    `连续 ${attempts} 次抽到 fetch/浏览器禁用端口（${drawn.join('、')}）：` +
      '这是本机动态端口范围与 fetch 禁用名单大面积重叠导致的，不是被测代码的问题。' +
      '可临时用 netsh 调整动态端口范围，或给这些服务器改用固定端口。',
  );
}

/** 监听随机端口并直接返回可用的回环地址。 */
export async function listenRandomUrl(server, host = '127.0.0.1') {
  const port = await listenRandom(server, host);
  return `http://${host}:${port}`;
}
