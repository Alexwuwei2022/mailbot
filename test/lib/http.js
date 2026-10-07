/**
 * 测试期的 **fetch 诊断层**（只在测试进程里装，不改生产行为）。
 *
 * ## 它解决什么问题
 *
 * `fetch` 失败时只抛一句 `TypeError: fetch failed`，真正的原因在 `err.cause` 里，
 * 而**失败的是哪个 URL** 根本不在错误对象上（`Object.getOwnPropertyNames(err)` 只有
 * `stack/message/cause`）。于是 CI 上红一次，日志里就只剩一句
 * `网络错误：fetch failed`——既不知道打了哪个地址，也不知道底层是
 * `bad port` / `ECONNREFUSED` / 连接被重置，只能从头猜一遍。
 *
 * 测试里有 180 多处 `fetch(...)`，逐个包一层不现实、也容易漏。所以这里**一次性**把
 * `globalThis.fetch` 包起来：任何一处 fetch 失败，抛出的**同一个错误对象**上都会多出
 *   - `err.diagnostic`：`{ phase, requestUrl, requestMethod, error, errorChain }`
 * 而测试 harness（`test()` 的 catch）本来就会打印 `err.diagnostic`，于是"一处加、处处受益"。
 *
 * ## 纪律
 *
 *   - **原样抛同一个错误对象**：不换类型、不改 `name`/`message`/`code`/`cause`，
 *     所以 `instanceof`、`err.name === 'AbortError'`、`isRetryableNetworkError` 的判定
 *     一个字都没变（也就不会因为诊断层而改变任何用例的通过与否）；
 *   - **不加任何重试**：这只加证据，不掩盖失败；
 *   - 与 `server/lib/http.js` 的 `requestFailureDetail` 共用同一份实现。
 */

import { errorChain, requestFailureDetail } from '../../server/lib/http.js';

const MARK = Symbol.for('mailbot.test.fetchDiagnostics');

/** 把 error 链压成一行文本（`' ← '` 连接），没有 cause 时返回空串。 */
export function causeChainText(err) {
  const chain = errorChain(err);
  if (chain.length < 2) return '';
  return ` ← ${chain
    .slice(1)
    .map((e) => `${e.code || e.name || ''} ${e.message}`.trim())
    .join(' ← ')}`;
}

/** 失败详情的一行化文本，供各套件的 `test()` 打印。 */
export function failureText(err) {
  const diag = err?.diagnostic ? `\n      诊断=${JSON.stringify(err.diagnostic)}` : '';
  const detail = !err?.diagnostic && err?.detail ? `\n      详情=${JSON.stringify(err.detail)}` : '';
  return `${causeChainText(err)}${diag}${detail}`;
}

/**
 * 装上诊断层（幂等：重复调用返回同一个包装函数）。
 *
 * @returns {Function} 包装后的 fetch
 */
export function installFetchDiagnostics() {
  const current = globalThis.fetch;
  if (current && current[MARK]) return current;
  const real = current;
  const wrapped = async function fetchWithDiagnostics(input, init) {
    const target =
      typeof input === 'string' || input instanceof URL ? String(input) : input?.url ? String(input.url) : String(input);
    const method = init?.method || (typeof input === 'object' && input?.method) || 'GET';
    try {
      return await real.call(this, input, init);
    } catch (err) {
      // 只**加**字段，然后抛出同一个对象
      if (err && typeof err === 'object' && !err.diagnostic) {
        try {
          err.diagnostic = requestFailureDetail(err, { url: target, method, phase: '测试期 fetch 失败' });
        } catch {
          /* 诊断本身绝不能把原来的失败盖掉 */
        }
      }
      throw err;
    }
  };
  wrapped[MARK] = true;
  wrapped.__realFetch = real;
  globalThis.fetch = wrapped;
  return wrapped;
}

/** 还原原生 fetch（测试进程结束时用；不还原也不影响结论）。 */
export function uninstallFetchDiagnostics() {
  const current = globalThis.fetch;
  if (current && current[MARK] && current.__realFetch) globalThis.fetch = current.__realFetch;
  return globalThis.fetch;
}
