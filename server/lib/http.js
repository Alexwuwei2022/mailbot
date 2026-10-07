/**
 * 极简 HTTP(S) 客户端 + **代理支持**（零依赖）。
 *
 * 为什么不直接用全局 `fetch`：
 *   1. Node 的 `fetch`（undici）**不读** `HTTP_PROXY` / `HTTPS_PROXY`，也不看 Windows/macOS 的
 *      系统代理设置。于是会出现「浏览器能打开 Google，本程序却报 fetch failed」这种看起来矛盾的现象。
 *   2. `fetch` 失败时只抛一句 `TypeError: fetch failed`，把真正的底层原因
 *      （`ENOTFOUND` / `ETIMEDOUT` / `ECONNRESET` / 证书错误）藏在 `err.cause` 里，
 *      使用者完全无法据此排查。
 *
 * 所以这里直接用 `node:https` / `node:http`，并支持通过 HTTP 代理的 `CONNECT` 隧道访问 HTTPS 目标，
 * 同时把底层错误码原样保留下来（`describeNetworkError` 会把它翻译成中文可执行提示）。
 *
 * 代理地址的来源（按优先级）：
 *   1. 显式传入的 `proxy`（来自配置 `calendar.proxy`）
 *   2. 环境变量 `MAILBOT_GOOGLE_PROXY`
 *   3. 环境变量 `HTTPS_PROXY` / `https_proxy` / `HTTP_PROXY` / `http_proxy` / `ALL_PROXY` / `all_proxy`
 * 回环地址（127.0.0.1 / localhost / ::1）与命中 `NO_PROXY` 的主机永远直连。
 */

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

export const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * `fetch` / 浏览器规范**禁止连接**的端口（"bad port" 名单）。
 *
 * 为什么要有这份名单：fetch 标准（URL 的 "bad port" 定义）要求浏览器与 undici 在
 * **建立连接之前**就拒绝这些端口，于是任何指向这类端口的 URL 都只会得到一句
 * `TypeError: fetch failed`（`cause: Error: bad port`）——既不连、也不解释。
 *
 * 这不是理论问题：本机实测（Windows，`netsh int ipv4 show dynamicport tcp` =
 * start 1024 / 13977 个）系统临时端口范围 **1025–15000** 与这份名单有 **19 个交集**
 * （1719/1720/1723/2049/3659/4045/4190/5060/5061/6000/6566/6665-6669/6679/6697/10080；
 * 裸 `listen(0)` 抽 2 万次命中 20 次 ≈ 1/1000；另一轮 6000 次命中 10 次 ≈ 1/600）。
 * 测试里每次 `listen(0)` 落到这些端口上，指向它的 `fetch` 就必然失败——
 * 表现为"偶发"的 `网络错误：fetch failed` / `bad port`，每次红的用例还不一样。
 *
 * 注意：这份名单是**逐个端口与 undici 实测核对**过的（不是照抄文档）。把 1025–15000
 * 全扫一遍、逐个发请求并只认 `cause: bad port` 这一种失败，结果正好是"漏了 6679、
 * 其余全对"——初版名单是照记忆写的，没有它。扫描工具：`test/tools/scan-bad-ports.mjs`。
 *
 * 所以：**系统分配的临时端口必须先过这一关**（见 `isForbiddenFetchPort`）。
 * 名单取自 fetch 标准 + 实测校正；`test/selftest.js` 里有一条用例逐个端口验证 undici
 * 的真实行为，一旦 Node 侧名单变化，那条用例会立刻红。
 */
export const FORBIDDEN_FETCH_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/**
 * 这个端口能不能被 `fetch` / 浏览器访问。
 *
 * 端口 0 也算"不能用"：它表示"由系统分配"，不是一个可连接的端口
 * （实测 `fetch('http://127.0.0.1:0/')` 得到 `EADDRNOTAVAIL`，而不是 `bad port`——
 * 两种错法都不该被当成一个可用的地址交出去）。
 */
export function isForbiddenFetchPort(port) {
  const n = Number(port);
  return !Number.isInteger(n) || n <= 0 || n > 65535 || FORBIDDEN_FETCH_PORTS.has(n);
}

/** 回环地址：本机模拟服务器、本地代理自身的探测等一律直连。 */
function isLoopback(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost') || /^127\./.test(h);
}

/** 解析代理地址字符串，支持 `http://user:pass@host:port` 或裸 `host:port`。 */
export function parseProxy(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    const err = new Error(`代理地址无法解析：${raw}。正确写法如 http://127.0.0.1:7890`);
    err.code = 'PROXY_INVALID';
    throw err;
  }
  const protocol = url.protocol.replace(':', '').toLowerCase();
  if (protocol === 'socks' || protocol === 'socks5' || protocol === 'socks4' || protocol === 'socks5h') {
    const err = new Error(
      `暂不支持 SOCKS 代理（${raw}）。请在代理软件里开启「HTTP 代理」端口（如 127.0.0.1:7890）并填那一个。`,
    );
    err.code = 'PROXY_SOCKS_UNSUPPORTED';
    throw err;
  }
  if (protocol !== 'http' && protocol !== 'https') {
    const err = new Error(`不支持的代理协议「${protocol}」，只支持 http://（绝大多数代理软件提供的都是 HTTP 端口）`);
    err.code = 'PROXY_INVALID';
    throw err;
  }
  if (!url.hostname) {
    const err = new Error(`代理地址缺少主机名：${raw}`);
    err.code = 'PROXY_INVALID';
    throw err;
  }
  return {
    protocol,
    host: url.hostname,
    port: Number(url.port || (protocol === 'https' ? 443 : 80)),
    auth: url.username ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password || '')}` : '',
    raw,
  };
}

/** NO_PROXY：逗号分隔的主机后缀列表，`*` 表示全部直连。 */
function matchesNoProxy(hostname, noProxy) {
  const list = String(noProxy || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  const h = String(hostname || '').toLowerCase();
  return list.some((entry) => entry === '*' || h === entry || h.endsWith(`.${entry}`) || h.endsWith(entry));
}

/**
 * 决定某个目标是否走代理。
 *
 * 规则（顺序很重要）：
 *   1. 命中 NO_PROXY → 直连；
 *   2. **显式配置的代理**（界面里填的 `calendar.proxy`）一律生效，回环地址也不例外——
 *      否则「填了代理却不生效」会变成新的困惑源；
 *   3. 回环地址（127.0.0.1 / localhost / ::1）直连：本机模拟服务、本地探测不该被代理劫持；
 *   4. 其余情况看环境变量。
 *
 * @returns {object|null} 代理配置；null 表示直连
 */
export function resolveProxyFor(target, { proxy, noProxy, env = process.env } = {}) {
  const hostname = typeof target === 'string' ? new URL(target).hostname : target.hostname;
  if (matchesNoProxy(hostname, noProxy ?? env.NO_PROXY ?? env.no_proxy)) return null;
  const explicit = String(proxy || '').trim();
  if (explicit) return parseProxy(explicit);
  if (isLoopback(hostname)) return null;
  const raw =
    env.MAILBOT_GOOGLE_PROXY ||
    env.HTTPS_PROXY ||
    env.https_proxy ||
    env.HTTP_PROXY ||
    env.http_proxy ||
    env.ALL_PROXY ||
    env.all_proxy ||
    '';
  return parseProxy(raw);
}

/** 当前生效的代理（不针对具体目标，仅用于界面/自检展示）。 */
export function activeProxy(proxy) {
  try {
    return resolveProxyFor('https://www.googleapis.com', { proxy });
  } catch (err) {
    return { error: err.message, code: err.code || 'PROXY_INVALID', raw: String(proxy || '') };
  }
}

/* ------------------------------------------------------------ 请求 */

function proxyAuthHeader(proxy) {
  return proxy.auth ? { 'proxy-authorization': `Basic ${Buffer.from(proxy.auth).toString('base64')}` } : {};
}

/**
 * 发起一次 HTTP(S) 请求。
 *
 * @param {string|URL} url
 * @param {object} options
 * @param {string} [options.method]
 * @param {object} [options.headers]
 * @param {string|Buffer} [options.body]
 * @param {number} [options.timeoutMs]
 * @param {string} [options.proxy] 显式代理地址（覆盖环境变量）
 * @param {string} [options.noProxy]
 * @returns {Promise<{ok:boolean,status:number,statusText:string,headers:object,text:string,viaProxy:object|null,elapsedMs:number}>}
 */
export async function httpRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    proxy,
    noProxy,
    env = process.env,
  } = options;

  let target;
  try {
    target = url instanceof URL ? url : new URL(String(url));
  } catch (err) {
    // 连 URL 都拼不出来时同样要留下"确切的目标串"——否则只剩一句 Invalid URL
    throw decorateRequestFailure(err, { url: String(url), method, phase: '目标地址无法解析' });
  }
  const isHttps = target.protocol === 'https:';
  if (!isHttps && target.protocol !== 'http:') {
    const err = new Error(`不支持的协议：${target.protocol}`);
    err.code = 'UNSUPPORTED_PROTOCOL';
    throw decorateRequestFailure(err, { url: target.href, method });
  }

  const proxyCfg = resolveProxyFor(target, { proxy, noProxy, env });
  const started = Date.now();
  const requestOptions = {
    method,
    headers: { ...headers },
    timeout: timeoutMs,
  };
  if (body !== undefined && body !== null) {
    requestOptions.headers['content-length'] = Buffer.byteLength(body);
  }

  /*
   * 失败时**在原错误对象上**补齐证据，然后原样抛出（见下面的 `.catch`）：
   * 不换错误类型、不改 message、不加重试。
   */
  const res = await new Promise((resolve, reject) => {
    const fail = (err) => reject(err);

    const onResponse = (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve({
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          headers: response.headers || {},
          buffer,
          text: buffer.toString('utf8'),
        });
      });
      response.on('error', (err) => fail(err));
    };

    const attachTimeout = (req) => {
      req.setTimeout(timeoutMs, () => {
        const err = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
        err.code = 'ETIMEDOUT';
        req.destroy(err);
      });
      req.on('error', (err) => fail(err));
      return req;
    };

    /* ---------- 直连 ---------- */
    if (!proxyCfg) {
      const mod = isHttps ? https : http;
      const req = attachTimeout(
        mod.request(
          {
            ...requestOptions,
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port || (isHttps ? 443 : 80),
            path: `${target.pathname}${target.search}`,
            headers: { ...requestOptions.headers, host: target.host },
          },
          onResponse,
        ),
      );
      if (body !== undefined && body !== null) req.write(body);
      req.end();
      return;
    }

    /* ---------- 经代理：HTTPS 走 CONNECT 隧道 ---------- */
    if (isHttps) {
      const connectMod = proxyCfg.protocol === 'https' ? https : http;
      const targetPort = target.port || 443;
      const connectReq = attachTimeout(
        connectMod.request({
          host: proxyCfg.host,
          port: proxyCfg.port,
          method: 'CONNECT',
          path: `${target.hostname}:${targetPort}`,
          headers: { host: `${target.hostname}:${targetPort}`, ...proxyAuthHeader(proxyCfg) },
          timeout: timeoutMs,
        }),
      );
      connectReq.on('connect', (response, socket) => {
        if (response.statusCode !== 200) {
          socket.destroy();
          const err = new Error(`代理拒绝建立隧道（HTTP ${response.statusCode}）`);
          err.code = response.statusCode === 407 ? 'PROXY_AUTH_REQUIRED' : 'PROXY_CONNECT_FAILED';
          fail(err);
          return;
        }
        const tlsSocket = tls.connect({ socket, servername: target.hostname }, () => {
          const req = https.request(
            {
              ...requestOptions,
              hostname: target.hostname,
              port: targetPort,
              path: `${target.pathname}${target.search}`,
              headers: { ...requestOptions.headers, host: target.host },
              /*
               * 这里**不能写 `agent: false`**（曾经有，是个隐蔽的真 bug）。
               *
               * Node 的 ClientRequest 构造函数里：
               *   agent === false  →  agent = new Agent()   （一个一次性 Agent）
               *   agent == null    →  只有在 `createConnection` 不是函数时才用全局 Agent
               * 而 `createConnection` 只在**没有 agent** 时才会被调用（见 _http_client.js：
               * `if (this.agent) this.agent.addRequest(...) else { ...options.createConnection(...) }`）。
               *
               * 所以 `agent: false` 会让 Node 建一个一次性 Agent、**直接忽略我们的 createConnection**，
               * 于是刚建好的 CONNECT 隧道 socket 被丢掉，它自己去直连 Google ——
               * 在国内的表现就是 ECONNRESET 或 30 秒超时，而日志看起来"代理已连上"。
               *
               * 本机实测（Node v24.14.1，纯回环，目标用永不解析的域名以区分两种行为）：
               *   agent:false + createConnection → ERROR: ECONNRESET   （createConnection 被忽略）
               *   不传 agent   + createConnection → RESPONSE: LIVE      （生效）
               *   agent:null   + createConnection → RESPONSE: LIVE      （生效）
               */
              createConnection: () => tlsSocket,
            },
            onResponse,
          );
          req.setTimeout(timeoutMs, () => {
            const err = new Error(`请求超时（>${Math.round(timeoutMs / 1000)}s）`);
            err.code = 'ETIMEDOUT';
            req.destroy(err);
          });
          req.on('error', (err) => fail(err));
          if (body !== undefined && body !== null) req.write(body);
          req.end();
        });
        tlsSocket.on('error', (err) => fail(err));
      });
      connectReq.end();
      return;
    }

    /* ---------- 经代理：HTTP 用绝对 URI 直接请求代理 ---------- */
    const req = attachTimeout(
      http.request(
        {
          ...requestOptions,
          host: proxyCfg.host,
          port: proxyCfg.port,
          path: target.href,
          headers: { ...requestOptions.headers, host: target.host, ...proxyAuthHeader(proxyCfg) },
        },
        onResponse,
      ),
    );
    if (body !== undefined && body !== null) req.write(body);
    req.end();
  }).catch((err) => {
    /*
     * 失败时**在原错误对象上**补齐证据（确切 URL、方法、完整 cause 链、是否走代理、超时设置），
     * 然后原样抛出：不换错误类型、不改 message、不加重试。原因是 `fetch`/`net` 的报错
     * 常常只剩一句 "socket hang up" 或 "请求超时"，没有 URL 就无从判断是哪一步，
     * 也不知道是不是撞上了 `fetch` 的禁用端口。（`describeNetworkError` 仍照旧读 err.code。）
     */
    throw decorateRequestFailure(err, {
      url: target.href,
      method,
      phase: proxyCfg ? '经代理的请求失败' : '直连请求失败',
      extra: { viaProxy: proxyCfg?.raw || null, timeoutMs, hostname: target.hostname, port: target.port || null },
    });
  });

  // 407 只会来自代理：必须当成「代理问题」抛出，否则会被上层误判成「Google 拒绝了请求」。
  if (res.status === 407 || res.headers['proxy-authenticate']) {
    const err = new Error('代理要求身份验证（HTTP 407）');
    err.code = 'PROXY_AUTH_REQUIRED';
    err.proxy = proxyCfg?.raw || null;
    throw decorateRequestFailure(err, { url: target.href, method, phase: '代理要求身份验证' });
  }

  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    buffer: res.buffer,
    text: res.text,
    viaProxy: proxyCfg,
    elapsedMs: Date.now() - started,
  };
}

/** 便捷方法：发 JSON（或表单）并解析 JSON 响应。 */
export async function httpJson(url, { body, json, form, headers, ...rest } = {}) {
  const finalHeaders = { accept: 'application/json', ...(headers || {}) };
  let payload = body;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    finalHeaders['content-type'] = 'application/json';
  } else if (form !== undefined) {
    payload = form instanceof URLSearchParams ? form.toString() : new URLSearchParams(form).toString();
    finalHeaders['content-type'] = 'application/x-www-form-urlencoded';
  }
  const res = await httpRequest(url, { ...rest, headers: finalHeaders, body: payload });
  let data = null;
  try {
    data = res.text ? JSON.parse(res.text) : null;
  } catch {
    /* 非 JSON */
  }
  return { ...res, data };
}

/* ------------------------------------------------------------ 失败现场 */

/**
 * 展开 error 链，返回**可 JSON 序列化**的数组（第一项是最外层错误）。
 *
 * `fetch` 只说一句 `TypeError: fetch failed`，真正的原因（`bad port` / `ECONNREFUSED` /
 * 证书错误）在 `cause` 里；再往里还有 `cause.cause`。只打印一层等于没打印——
 * 本项目此前的失败日志就只剩 `网络错误：fetch failed`，排查要从"是不是端口"重新猜一遍。
 */
export function errorChain(err, maxDepth = 6) {
  const out = [];
  let cur = err;
  for (let depth = 0; cur && depth <= maxDepth; depth += 1) {
    out.push({
      name: cur.name || null,
      code: cur.code || null,
      message: String(cur.message ?? cur),
      ...(cur.errno !== undefined ? { errno: cur.errno } : {}),
      ...(cur.syscall ? { syscall: cur.syscall } : {}),
      ...(cur.address ? { address: cur.address } : {}),
      ...(cur.port !== undefined ? { port: cur.port } : {}),
    });
    cur = cur.cause;
  }
  return out;
}

/**
 * 一次 HTTP 调用的失败现场：**确切的 URL 与 method** + 完整错误链 + 额外上下文。
 *
 * 这是"让所有 HTTP 调用在失败时都带上 URL 与 cause"的唯一实现处：
 * `httpRequest`（Google / OAuth / 代理）与 `LlmClient`（大模型，走全局 fetch）都调它。
 */
export function requestFailureDetail(err, { url, method = 'GET', phase = '请求失败', extra = {} } = {}) {
  return {
    phase,
    requestUrl: url ? String(url) : null,
    requestMethod: method,
    error: err ? String(err.message || err) : '(无 error 对象)',
    errorChain: errorChain(err),
    ...extra,
  };
}

/**
 * 在**原错误对象上**补证据后原样返回。
 *
 * 刻意不替换错误、不改 `message`、不改 `code`：上层（`describeNetworkError`、
 * `wrapGoogleError`、`isRetryableNetworkError`）都按 `err.code` / `err.cause` 判定，
 * 换一个错误对象就等于悄悄改变了重试与归类行为。这里只**加**字段：
 *   - `err.diagnostic`：失败现场（测试harness 会原样打印）；
 *   - `err.detail`：可直接进 API 响应 `detail` 的精简版；
 *   - `err.requestUrl` / `err.requestMethod`：给需要拼提示的调用方用。
 */
export function decorateRequestFailure(err, options = {}) {
  if (!err || typeof err !== 'object') return err;
  const detail = requestFailureDetail(err, options);
  if (!err.diagnostic) err.diagnostic = detail;
  if (!err.requestUrl) err.requestUrl = detail.requestUrl;
  if (!err.requestMethod) err.requestMethod = detail.requestMethod;
  /*
   * `errorChain` 也要**单独挂一份**：上层（`google-api.js` 的 catch）会重新包一个 Error，
   * 它只会搬运 `requestUrl` / `requestMethod` / `errorChain` 这几个字段——
   * 只把链塞在 `diagnostic` 里，搬过去就是 `null`（本文件的第一版就是这么漏的）。
   * 注意 `node:http` 的错误（ECONNREFUSED 等）**没有** `.cause`，链只有一项；
   * 那也是有用的一项（含错误码与地址），所以这里不做"长度 > 1"的过滤。
   */
  if (!err.errorChain) err.errorChain = detail.errorChain;
  if (!err.detail) {
    err.detail = {
      requestUrl: detail.requestUrl,
      requestMethod: detail.requestMethod,
      errorChain: detail.errorChain,
    };
  }
  return err;
}

/* ------------------------------------------------------------ 错误翻译 */

const NETWORK_HINTS = {
  ENOTFOUND: 'DNS 解析失败——本机找不到这个域名。可能是没有外网 DNS 出口，或域名被污染。',
  EAI_AGAIN: 'DNS 解析暂时失败（EAI_AGAIN）。请检查本机 DNS / 网络是否稳定。',
  ECONNREFUSED: '连接被拒绝——目标端口或代理端口没有服务在监听。若填了代理，请确认代理软件正在运行且端口正确。',
  ETIMEDOUT: '连接超时——本机到这个地址的网络出口不通。国内网络访问 Google 必须走代理。',
  ECONNRESET: '连接被重置——常见于网络中间设备阻断了该连接。',
  EPIPE: '连接被对端提前关闭。',
  EHOSTUNREACH: '主机不可达。',
  ENETUNREACH: '网络不可达。',
  CERT_HAS_EXPIRED: '证书已过期。',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务器证书——如果代理在做 TLS 中间人，请改用 HTTP 代理的 CONNECT 模式或把代理根证书加入系统信任。',
  DEPTH_ZERO_SELF_SIGNED_CERT: '服务器证书是自签名的，无法验证。',
  ERR_TLS_CERT_ALTNAME_INVALID: '证书域名不匹配——通常是代理在中间替换了证书。',
  PROXY_AUTH_REQUIRED: '代理要求身份验证（407）。请在代理地址里写成 http://用户名:密码@主机:端口。',
  PROXY_CONNECT_FAILED: '代理拒绝为这个地址建立隧道。请确认代理允许访问该域名。',
  PROXY_INVALID: '代理地址格式不对，正确写法如 http://127.0.0.1:7890。',
  PROXY_SOCKS_UNSUPPORTED: '不支持 SOCKS 代理，请填代理软件的 HTTP 端口。',
};

/**
 * 把底层网络错误翻译成「原因 + 下一步怎么做」。
 * @param {Error} err
 * @param {object} options { target, proxyUsed }
 */
export function describeNetworkError(err, { target = 'Google', proxyUsed = null } = {}) {
  const code = err?.code || err?.cause?.code || '';
  const rawMessage = err?.message || String(err);
  /*
   * `bad port` 这条原因**连错误码都没有**（`cause` 是个光秃秃的 Error），
   * 所以只能按消息识别。它是 fetch/浏览器规范在**建立连接之前**就拒掉的端口，
   * 和网络出口没有任何关系——不单独说清楚，用户只会看到一句莫名其妙的 "bad port"。
   *
   * 只在**真的**是 bad port 时才这么说：不能拿"端口号在名单里"去推断，
   * 因为本服务发 Google 请求走的是 `node:http`（不受该名单限制），
   * 那种情况下真正的原因可能是 ECONNREFUSED——用名单去覆盖它就成了误报。
   */
  const badPort = /bad port/i.test(String(err?.cause?.message || ''));
  const hint = badPort
    ? '目标地址用的端口被 fetch/浏览器规范列为禁用端口（"bad port"），连接根本不会被发起。' +
      '请把服务换到其它端口（本机模型如 Ollama 换个端口即可）。'
    : NETWORK_HINTS[code] || '';
  const proxyNote = proxyUsed
    ? `当前已配置代理 ${proxyUsed.raw}，请确认代理软件正在运行、且允许访问 ${target}。`
    : `当前**没有**配置代理。如果这台机器需要借助代理/VPN 才能访问 ${target}，` +
      '请到「设置 → 日历数字人 → 网络代理」填写代理软件提供的 HTTP 端口（如 http://127.0.0.1:7890）。';
  return {
    code: code || 'NETWORK_ERROR',
    message: `${rawMessage}${hint ? `（${hint}）` : ''}`,
    hint,
    proxyUsed: proxyUsed?.raw || null,
    advice: proxyNote,
  };
}
