/**
 * 密钥保管：把授权码 / API Key / 令牌从配置文件里挪到**操作系统提供的保管处**。
 *
 * ## 威胁模型（先说清边界，不夸大）
 *
 * ✅ 能防：`config.json` / `.env` 被拷走、被网盘同步、进了备份包、被人翻到——
 *    因为文件里不再有密钥，密文只有**同一台机器的同一个用户**才解得开。
 * ❌ 不能防：以你的身份运行的恶意程序、你离开时没锁屏的电脑、你自己点开的钓鱼页面。
 *    任何"用你的身份就能调用的东西"都挡不住这类攻击，钥匙串也不例外。
 *
 * ## 为什么是这些后端（零依赖约束）
 *
 * 项目只有 3 个运行时依赖，不可能为加密引入原生模块，所以一律走**系统自带**的能力：
 *
 * | 平台 | 后端 | 说明 |
 * | --- | --- | --- |
 * | Windows | `dpapi` | 系统数据保护 API（`CurrentUser` 作用域），密文存 `data/secrets.dpapi` |
 * | macOS | `keychain` | 系统钥匙串（`security` 命令） |
 * | Linux | `libsecret` | Secret Service（`secret-tool`，GNOME Keyring / KWallet 都提供） |
 * | 任意 | `file` | 降级：`data/secrets.json`（**未加密**，仅权限 600）。界面上会如实标注"未加密" |
 * | 任意 | `config` | 维持原样：密钥明文写在 `config.json` / `.env`（默认值，保持向后兼容） |
 *
 * ## 两个实现上的关键决定
 *
 * 1. **同步**：`loadConfig()` 是同步的且被到处调用，所以这里用 `spawnSync`。
 *    读一次约 300ms（Windows 启一个 PowerShell），因此**读结果在进程内缓存**。
 * 2. **密钥只走 stdin，绝不进命令行参数**：argv 对其他进程可见（`ps` / 任务管理器都能看），
 *    把密钥放进去等于白加密。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
// 只借一个文件名常量：google-token.js 只依赖 lib/util.js，不反向依赖本模块，不构成环
import { TOKEN_FILE_NAME } from '../calendar/google-token.js';

/** 钥匙串里的服务名（macOS/Linux 用它定位条目） */
export const KEYRING_SERVICE = 'mailbot-secrets';
/** Windows DPAPI 密文文件名 */
export const DPAPI_FILE = 'secrets.dpapi';
/** 降级文件后端文件名 */
export const FILE_VAULT = 'secrets.json';
/** 保管内容的版本号，将来改结构时据此迁移 */
export const VAULT_VERSION = 1;

/**
 * 密钥在配置里的位置 ↔ 保管库里的键名。
 *
 * 这是**唯一一份**口径，`config/index.js` 从这里导入，避免两处各写一套字段名。
 *
 * `set` 一律写成"先补父对象再赋值"的防御式：这些函数会被用在**磁盘上读出来的配置**
 * （可能是老的、缺字段的、甚至手工编辑过的）上，不能假设 `llm` / `imap` 一定存在。
 */
export const SECRET_SLOTS = [
  {
    key: 'imap',
    label: '邮箱授权码（收信）',
    /** 实例级：每个邮箱实例各有一份 */
    scope: 'instance',
    get: (c, i) => i.imap?.authPass,
    set: (i, v) => {
      i.imap = i.imap || {};
      i.imap.authPass = v;
    },
  },
  {
    key: 'smtp',
    label: '邮箱授权码（发信）',
    scope: 'instance',
    get: (c, i) => i.smtp?.authPass,
    set: (i, v) => {
      i.smtp = i.smtp || {};
      i.smtp.authPass = v;
    },
  },
  {
    key: 'llm',
    label: '大模型 API Key',
    scope: 'config',
    get: (c) => c.llm?.apiKey,
    set: (c, v) => {
      c.llm = c.llm || {};
      c.llm.apiKey = v;
    },
  },
  {
    key: 'web',
    label: '界面访问令牌',
    scope: 'config',
    get: (c) => c.web?.authToken,
    set: (c, v) => {
      c.web = c.web || {};
      c.web.authToken = v;
    },
  },
  {
    key: 'google',
    label: 'Google Client Secret',
    scope: 'config',
    get: (c) => c.calendar?.google?.clientSecret,
    set: (c, v) => {
      c.calendar = c.calendar || {};
      c.calendar.google = c.calendar.google || {};
      c.calendar.google.clientSecret = v;
    },
  },
  /*
   * Google 刷新令牌（`data/google-token.json`）不在配置里，但它同样是"别人拿到就能读你日历"
   * 的凭据，因此**同样纳入保管**。
   *
   * `external` 表示"不落在这个配置对象上，而是另一个文件"，因此它不参与
   * `collectFromConfig` / `applyToConfig` / `stripFromConfig` 的配置路径：
   * 那三个函数只管配置；外部文件由 `collectExternalSecrets` / `applyExternalSecrets`
   * 通过下面注入的 `read` / `write` / `clear` 处理（见 `server/calendar/google-token.js`）。
   * 保管库里的键名仍是 `googleToken`，值是**令牌文件对象的 JSON 文本**。
   */
  {
    key: 'googleToken',
    label: 'Google 刷新令牌',
    scope: 'config',
    external: TOKEN_FILE_NAME,
    read: () => externalTokenIO()?.read() ?? null,
    write: (value) => externalTokenIO()?.write(value) ?? { ok: false, error: '令牌存储未初始化' },
    clear: () => externalTokenIO()?.clear() ?? { ok: false, error: '令牌存储未初始化' },
    verify: () => externalTokenIO()?.verify() ?? { ok: false, error: '令牌存储未初始化' },
    managed: () => externalTokenIO()?.managed() ?? false,
  },
];

/* ------------------------------------------------------------ 外部密钥（不在配置里的文件） */

/**
 * 外部密钥槽位的读写实现（如 `data/google-token.json`）。
 *
 * 为什么用注入而不是 import：`server/calendar/google-token.js` 需要 `config/index.js`
 * 里的 `getPaths` / `readVault` 等，反过来 `config/index.js` 又要在这里搬动它——
 * 静态互相 import 会形成模块环。注入把这条边断成"运行时依赖"。
 */
let externalIO = {};
export function setExternalSecretIO(io) {
  externalIO = io || {};
}

function externalTokenIO() {
  return externalIO.googleToken || null;
}

function externalSlots() {
  return SECRET_SLOTS.filter((s) => s.external);
}

/** 收集外部密钥：返回 `{ [key]: string }`（值是**要写进保管库的字符串**）。 */
export function collectExternalSecrets({ exclude = new Set() } = {}) {
  const secrets = {};
  const problems = [];
  for (const slot of externalSlots()) {
    if (exclude.has(slot.key)) continue;
    let value = null;
    try {
      value = slot.read ? slot.read() : null;
    } catch (err) {
      problems.push({ key: slot.key, message: err?.message || String(err), code: err?.code || null });
      continue;
    }
    if (value) secrets[slot.key] = value;
  }
  return { secrets, problems };
}

/**
 * 把外部密钥写回它原来的地方（「保存配置」的搬运路径用）。
 *
 * **只搬运"保管库已经说了算"的项**（`slot.managed()`）。原因很简单：外部密钥没有
 * "配不配置"这个中间态，一旦写回就必须能把原处的明文清掉。若保管库还不掌握它
 * （比如用户只是迁移过授权码、之后才连的 Google），把它写进去再清掉明文，就等于
 * 用过期的副本替换仍然有效的令牌——**宁可不搬**。
 * 真正"第一次纳入保管库"由 `migrateSecrets` 负责（它有读回比对那一整套）。
 */
export function applyExternalSecrets(secrets) {
  let applied = 0;
  const problems = [];
  for (const slot of externalSlots()) {
    const value = secrets?.[slot.key];
    if (!value) continue;
    if (slot.managed && !slot.managed()) {
      problems.push({ key: slot.key, message: '保管库尚未掌握该项，本次未搬运（明文保持原样）' });
      continue;
    }
    try {
      const res = slot.write ? slot.write(value) : { ok: false, error: '该密钥槽位不支持写回' };
      if (res?.ok === false) problems.push({ key: slot.key, message: res.error || '写入失败' });
      else applied += 1;
    } catch (err) {
      problems.push({ key: slot.key, message: err?.message || String(err), code: err?.code || null });
    }
  }
  return { applied, problems };
}

/** 迁移成功后清掉外部明文（**只在保管库读回比对通过之后调用**）。 */
export function clearExternalSecrets(secrets) {
  const cleared = [];
  const problems = [];
  for (const slot of externalSlots()) {
    if (!secrets?.[slot.key]) continue;
    try {
      const res = slot.clear ? slot.clear() : { ok: true };
      if (res?.ok === false) problems.push({ key: slot.key, message: res.error || '清理失败' });
      else cleared.push(slot.key);
    } catch (err) {
      problems.push({ key: slot.key, message: err?.message || String(err), code: err?.code || null });
    }
  }
  return { cleared, problems };
}

/** 外部密钥的现状（给上报用；实现失败时返回 null，由上报层如实说明）。 */
export function externalSecretStatus() {
  const out = {};
  for (const slot of externalSlots()) {
    try {
      out[slot.key] = slot.verify ? slot.verify() : null;
    } catch (err) {
      out[slot.key] = { error: err?.message || String(err), errorCode: err?.code || null };
    }
  }
  return out;
}

/** 需要保管的配置键（用于判断"某个字段算不算密钥"） */
export const SECRET_KEYS = new Set(SECRET_SLOTS.map((s) => s.key));

/* ------------------------------------------------------------------ 执行工具 */

function run(cmd, args, { input, timeout = 20000 } = {}) {
  const res = spawnSync(cmd, args, {
    input: input === undefined ? undefined : String(input),
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (res.error) return { ok: false, code: res.error.code || 'SPAWN_FAILED', message: res.error.message, stdout: '', status: null };
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  return { ok: res.status === 0, status: res.status, stdout, stderr, message: stderr || stdout };
}

function which(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = run(probe, [cmd]);
  return res.ok && !!res.stdout;
}

/* ------------------------------------------------------------------ 后端：Windows DPAPI */

const PS_PROTECT = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$plain = [Console]::In.ReadToEnd()
$enc = [System.Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($plain), $null, 'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($enc))`;

const PS_UNPROTECT = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$b64 = [Console]::In.ReadToEnd()
$enc = [Convert]::FromBase64String($b64)
$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, 'CurrentUser')
[Console]::Out.Write([Text.Encoding]::UTF8.GetString($dec))`;

function powershellExe() {
  if (process.env.MAILBOT_POWERSHELL) return process.env.MAILBOT_POWERSHELL;
  // 优先用 Windows PowerShell（一定在），没有才退回 pwsh
  for (const exe of ['powershell.exe', 'pwsh.exe', 'pwsh']) {
    if (which(exe)) return exe;
  }
  return 'powershell.exe';
}

const dpapiBackend = {
  id: 'dpapi',
  label: 'Windows 凭据保护（DPAPI）',
  encrypted: true,
  detail: '密文只有本机当前用户能解开；换了电脑或换了 Windows 账户都读不出来',
  available: () => process.platform === 'win32' && which(powershellExe()),
  file: (dataDir) => path.join(dataDir, DPAPI_FILE),
  read(dataDir) {
    const file = this.file(dataDir);
    if (!fs.existsSync(file)) return { ok: true, value: null };
    const b64 = fs.readFileSync(file, 'utf8').trim();
    if (!b64) return { ok: true, value: null };
    const res = run(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', PS_UNPROTECT], { input: b64 });
    if (!res.ok) {
      return {
        ok: false,
        code: 'DPAPI_DECRYPT_FAILED',
        message: `无法解开密钥文件（可能换了 Windows 账户或换了机器）：${res.message.split('\n')[0]}`,
      };
    }
    return { ok: true, value: res.stdout };
  },
  write(dataDir, plaintext) {
    const res = run(powershellExe(), ['-NoProfile', '-NonInteractive', '-Command', PS_PROTECT], { input: plaintext });
    if (!res.ok || !res.stdout) {
      return { ok: false, code: 'DPAPI_ENCRYPT_FAILED', message: `加密失败：${res.message || '无输出'}` };
    }
    const file = this.file(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, res.stdout, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  },
  clear(dataDir) {
    const file = this.file(dataDir);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ 后端：macOS 钥匙串 */

const keychainBackend = {
  id: 'keychain',
  label: 'macOS 钥匙串',
  encrypted: true,
  detail: '由系统钥匙串保管；换机器需要重新填授权码',
  available: () => process.platform === 'darwin' && which('security'),
  read() {
    const res = run('security', ['find-generic-password', '-s', KEYRING_SERVICE, '-a', 'mailbot', '-w']);
    // 44 = errSecItemNotFound：没存过，不算错误
    if (!res.ok && (res.status === 44 || /could not be found/i.test(res.message))) return { ok: true, value: null };
    if (!res.ok) return { ok: false, code: 'KEYCHAIN_READ_FAILED', message: res.message };
    return { ok: true, value: res.stdout };
  },
  write(dataDir, plaintext) {
    /*
     * `security` 只支持把密码作为参数传入，没有 stdin 形式。
     * 也就是说写入的一瞬间它在本机进程参数里可见——本机单用户场景可接受，
     * 但这点在文档里如实写明，不假装没有。
     */
    const res = run('security', ['add-generic-password', '-U', '-s', KEYRING_SERVICE, '-a', 'mailbot', '-w', plaintext]);
    if (!res.ok) return { ok: false, code: 'KEYCHAIN_WRITE_FAILED', message: res.message };
    return { ok: true };
  },
  clear() {
    const res = run('security', ['delete-generic-password', '-s', KEYRING_SERVICE, '-a', 'mailbot']);
    if (!res.ok && !/could not be found/i.test(res.message)) {
      return { ok: false, code: 'KEYCHAIN_CLEAR_FAILED', message: res.message };
    }
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ 后端：Linux libsecret */

const libsecretBackend = {
  id: 'libsecret',
  label: 'Linux Secret Service（GNOME Keyring / KWallet）',
  encrypted: true,
  detail: '由桌面钥匙串保管；无桌面环境的服务器上通常不可用',
  available: () => process.platform === 'linux' && which('secret-tool'),
  read() {
    const res = run('secret-tool', ['lookup', 'service', 'mailbot']);
    if (!res.ok) {
      // secret-tool 查不到时退出码为 1 且无输出，不算错误
      if (!res.stdout) return { ok: true, value: null };
      return { ok: false, code: 'LIBSECRET_READ_FAILED', message: res.message };
    }
    return { ok: true, value: res.stdout || null };
  },
  write(dataDir, plaintext) {
    // secret-tool store 从 stdin 读密钥（密码提示走 stdin），不经命令行 ✓
    const res = run('secret-tool', ['store', '--label=mailbot 密钥保管', 'service', 'mailbot'], { input: plaintext });
    if (!res.ok) return { ok: false, code: 'LIBSECRET_WRITE_FAILED', message: res.message };
    return { ok: true };
  },
  clear() {
    const res = run('secret-tool', ['clear', 'service', 'mailbot']);
    if (!res.ok && res.status !== 1) return { ok: false, code: 'LIBSECRET_CLEAR_FAILED', message: res.message };
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ 后端：文件降级 */

const fileBackend = {
  id: 'file',
  label: '本地文件（未加密）',
  encrypted: false,
  detail: '所有平台都能用，但**没有加密**：只是把密钥从 config.json 挪到单独一个 600 权限的文件里',
  available: () => true,
  file: (dataDir) => path.join(dataDir, FILE_VAULT),
  read(dataDir) {
    const file = this.file(dataDir);
    if (!fs.existsSync(file)) return { ok: true, value: null };
    try {
      return { ok: true, value: fs.readFileSync(file, 'utf8') };
    } catch (err) {
      return { ok: false, code: 'FILE_READ_FAILED', message: err.message };
    }
  },
  write(dataDir, plaintext) {
    const file = this.file(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, plaintext, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  },
  clear(dataDir) {
    const file = this.file(dataDir);
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
    return { ok: true };
  },
};

/* ------------------------------------------------------------------ 后端注册与探测 */

const BACKENDS = [dpapiBackend, keychainBackend, libsecretBackend, fileBackend];

/** 供测试注入（离线跑，不碰真实钥匙串） */
let injected = null;
export function __setBackendForTest(name, impl) {
  injected = name ? { name, impl } : null;
}
function allBackends() {
  return injected ? [...BACKENDS, { ...injected.impl, id: injected.name }] : BACKENDS;
}

/**
 * 列出所有后端及其可用性。
 *
 * 每次都实测一次（`which` 很快），因为"装了没有"会随环境变化，
 * 而这个结果要直接展示给用户，不能凭猜。
 */
export function listBackends({ probe = true } = {}) {
  return allBackends().map((b) => {
    let available = true;
    let error = null;
    if (probe && typeof b.available === 'function') {
      try {
        available = !!b.available();
      } catch (err) {
        available = false;
        error = err.message;
      }
    }
    return {
      id: b.id,
      label: b.label,
      encrypted: b.encrypted !== false,
      detail: b.detail,
      available,
      error,
    };
  });
}

/** `auto` 模式下挑一个：优先真正加密的系统后端，最后才落到文件。 */
export function pickAutoBackend() {
  return autoDecision().id;
}

/**
 * `auto` 的选择过程与**是否降级**。
 *
 * 单独返回降级信息是刻意的：从"加密保管"悄悄退化成"未加密的本地文件"，
 * 用户会以为密钥是加密的——这类静默降级比功能缺失更糟。界面据此显式提示。
 */
export function autoDecision() {
  const list = listBackends();
  const preferred = process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'libsecret';
  const hit = list.find((b) => b.id === preferred && b.available);
  if (hit) return { id: hit.id, encrypted: hit.encrypted !== false, degraded: false, reason: null };
  const anyEncrypted = list.find((b) => b.encrypted && b.available);
  if (anyEncrypted) return { id: anyEncrypted.id, encrypted: true, degraded: false, reason: null };
  const preferredBackend = list.find((b) => b.id === preferred);
  return {
    id: 'file',
    encrypted: false,
    degraded: true,
    reason: preferredBackend
      ? `${preferredBackend.label} 在本机不可用${preferredBackend.error ? `（${preferredBackend.error}）` : ''}，只能退到未加密的本地文件`
      : '本机没有可用的系统密钥保管后端',
  };
}

export function getBackend(id) {
  return allBackends().find((b) => b.id === id) || null;
}

/** 把 mode 解析成具体后端 id；`config` 表示"不保管"（明文留在配置文件里）。 */
export function resolveMode(mode = 'config') {
  if (mode === 'config') return 'config';
  if (mode === 'auto') return autoDecision().id;
  return mode;
}

/* ------------------------------------------------------------------ 读写（带缓存） */

/** mode → { value|error }，避免每次 loadConfig 都启一个 PowerShell */
const cache = new Map();

export function resetVaultCache() {
  cache.clear();
}

/**
 * 读取保管库内容（JSON 字符串）。
 *
 * **读取失败绝不抛异常**：调用方在加载配置的路径上，那里崩了整个程序都起不来。
 * 失败时返回 `{ ok: false, error }`，由调用方决定怎么提示——
 * 关键是**不能假装成功**（那会让用户以为密钥没配，然后去重新填一遍）。
 */
export function readVault(mode, { dataDir, force = false } = {}) {
  const backendId = resolveMode(mode);
  if (backendId === 'config') return { ok: true, backend: 'config', data: null };
  const backend = getBackend(backendId);
  if (!backend) return { ok: false, backend: backendId, error: `未知的密钥保管后端：${backendId}` };
  if (!force && cache.has(backendId)) return cache.get(backendId);

  const res = backend.read(dataDir);
  const out = res.ok
    ? { ok: true, backend: backendId, data: res.value || null }
    : { ok: false, backend: backendId, error: res.message, code: res.code };
  cache.set(backendId, out);
  return out;
}

/**
 * 写入保管库。
 *
 * 与读取相反，这里**必须**让失败可被感知：调用方要靠它决定
 * "能不能把配置文件里的明文抹掉"。写失败却抹掉明文 = 直接把用户的密钥弄丢。
 */
export function writeVault(mode, { dataDir }, data) {
  const backendId = resolveMode(mode);
  if (backendId === 'config') return { ok: true, backend: 'config' };
  const backend = getBackend(backendId);
  if (!backend) return { ok: false, backend: backendId, error: `未知的密钥保管后端：${backendId}` };
  const res = backend.write(dataDir, data);
  cache.delete(backendId);
  return res.ok ? { ok: true, backend: backendId } : { ok: false, backend: backendId, error: res.message, code: res.code };
}

export function clearVault(mode, { dataDir }) {
  const backendId = resolveMode(mode);
  if (backendId === 'config') return { ok: true, backend: 'config' };
  const backend = getBackend(backendId);
  if (!backend) return { ok: false, backend: backendId, error: `未知的密钥保管后端：${backendId}` };
  const res = backend.clear(dataDir);
  cache.delete(backendId);
  return res.ok ? { ok: true, backend: backendId } : { ok: false, backend: backendId, error: res.message, code: res.code };
}

/* ------------------------------------------------------------------ 打包 / 解包 */

/**
 * 把配置里的密钥收集成保管库内容（只会包含有值的项）。
 *
 * 实例级（imap/smtp）与配置级（llm/web/google）**分开处理**：早先版本让同一个循环
 * 处理两者，结果配置级的密钥被按"每个实例一份"重复收集，还会往实例对象上写
 * `instance.llm` 这种脏字段（迁移时少报多存、校验对不上）。
 */
export function collectFromConfig(config, { exclude = new Set() } = {}) {
  const secrets = {};
  const instances = Array.isArray(config?.instances) ? config.instances : [];
  for (const inst of instances) {
    for (const slot of SECRET_SLOTS) {
      if (slot.external || slot.scope !== 'instance' || exclude.has(slot.key)) continue;
      const value = slot.get(config, inst);
      if (value) secrets[`${slot.key}:${inst.id || 'default'}`] = value;
    }
  }
  for (const slot of SECRET_SLOTS) {
    if (slot.external || slot.scope !== 'config' || exclude.has(slot.key)) continue;
    const value = slot.get(config);
    if (value) secrets[slot.key] = value;
  }
  return secrets;
}

/** 把保管库内容注入配置（**只填空的**，不覆盖已有非空值——比如 .env 里显式设的）。 */
export function applyToConfig(config, secrets) {
  if (!secrets) return { applied: 0 };
  let applied = 0;
  const instances = Array.isArray(config?.instances) ? config.instances : [];
  for (const inst of instances) {
    for (const slot of SECRET_SLOTS) {
      if (slot.external || slot.scope !== 'instance') continue;
      const value = secrets[`${slot.key}:${inst.id || 'default'}`];
      if (value && !slot.get(config, inst)) {
        slot.set(inst, value);
        applied += 1;
      }
    }
  }
  for (const slot of SECRET_SLOTS) {
    if (slot.external || slot.scope !== 'config') continue;
    const value = secrets[slot.key];
    if (value && !slot.get(config)) {
      slot.set(config, value);
      applied += 1;
    }
  }
  return { applied };
}

/** 把配置里的密钥清空（用于写入保管库之后再落盘）。 */
export function stripFromConfig(config) {
  const instances = Array.isArray(config?.instances) ? config.instances : [];
  for (const inst of instances) {
    for (const slot of SECRET_SLOTS) {
      if (slot.external || slot.scope !== 'instance') continue;
      slot.set(inst, '');
    }
  }
  for (const slot of SECRET_SLOTS) {
    if (slot.external || slot.scope !== 'config') continue;
    slot.set(config, '');
  }
  return config;
}

/** 保管库内容 ↔ JSON 文本（带版本号，便于将来迁移结构）。 */
export function encodeVault(secrets, now = new Date()) {
  return JSON.stringify({ version: VAULT_VERSION, updatedAt: now.toISOString(), secrets }, null, 2);
}

export function decodeVault(text) {
  if (!text) return { ok: true, secrets: {} };
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: '保管内容不是对象' };
    if (parsed.version && parsed.version > VAULT_VERSION) {
      return { ok: false, error: `保管内容版本（${parsed.version}）比本程序支持的（${VAULT_VERSION}）新，请升级程序` };
    }
    return { ok: true, secrets: parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {} };
  } catch (err) {
    return { ok: false, error: `保管内容解析失败：${err.message}` };
  }
}
