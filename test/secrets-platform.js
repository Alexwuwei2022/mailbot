/**
 * 平台密钥保管自检：把「密钥到底存在哪、能不能用」从**读代码推断**变成**真机跑出来的证据**。
 *
 * ## 为什么单独一个套件
 *
 * 前面 5 套测试是**纯离线**的（假后端只做"字符串进、字符串出"），因此它们证明的是
 * "保管逻辑对"，证明不了"这台机器上钥匙串真能用"。而本项目的定位是**交付给别人用**，
 * 所以"在别人机器上密钥存哪、能不能读回来"必须有真机证据。这一套就是干这个的：
 *
 * | 平台 | 本套件做什么 |
 * | --- | --- |
 * | Windows | 真跑 DPAPI（`powershell` + `ProtectedData`）：写入 → 读回 → 校验 → 清除 |
 * | macOS | 真跑钥匙串：`security create-keychain` 建**临时钥匙串**（不碰登录钥匙串），同样整条往返 |
 * | Linux | 先尝试真跑（`dbus-run-session` + `gnome-keyring` + 真 `secret-tool`）；起不来就**显式跳过**并打印原因，改由"命令级"验证兜住 |
 * | 任意 | 后端探测口径、"降级必然可见"的断言（这条三个平台都真跑） |
 *
 * ## 两条不可退让的规矩
 *
 * 1. **跳过必须显式且有原因**：`⊘ 用例名 — 已跳过：<原因>`，末尾还有"跳过明细"。
 *    静默 pass 会把"验证过"变成假象，而那正是本套件要消灭的东西。
 *    ⚠️ 因此"跳过"只允许用在**该能力在该平台确实不存在**的时候；
 *    某个平台本来该有的能力挂了，这里只会**变红**，不会被悄悄跳过。
 * 2. **不留痕迹**：
 *    - macOS 用临时钥匙串，并把它**显式钉给后端**（`__setKeychainPathForTest`），
 *      所以压根不需要改默认钥匙串/搜索列表——用户的登录钥匙串一个字节都不会被碰；
 *      用例结束（含失败）都 `security delete-keychain` + 删目录。
 *    - Linux 的钥匙环数据落在临时目录（`XDG_DATA_HOME`），不写进 runner 的 HOME。
 *    - 假 `secret-tool` 是**测试自己生成的**可执行文件（不是项目依赖），用完即删。
 *
 *   node test/secrets-platform.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from './lib/tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* ------------------------------------------------------------ 干净环境 */

/*
 * 数据目录与"项目根"都指向临时目录：
 *
 * - 数据目录：密钥的落盘全在这里，绝不碰仓库的 data/（那里面有真实凭据）；
 * - 项目根：`MAILBOT_ROOT` 决定 `.env` 从哪儿读。指向临时目录之后，即使哪一步真去清
 *   `.env`，动的也是临时目录里的空文件，而不是仓库根的真实 `.env`。
 */
const tmpDir = makeTempDir('mailbot-secrets-');
const fakeRoot = makeTempDir('mailbot-secrets-root-');
process.env.MAILBOT_DATA_DIR = tmpDir;
process.env.MAILBOT_ROOT = fakeRoot;
process.env.MAILBOT_NO_DOTENV = '1';
process.env.MAILBOT_LOG_LEVEL = process.env.MAILBOT_LOG_LEVEL || 'warn';
process.env.MAILBOT_DEFAULT_INSTANCE = 'test';
// 本机 .env / 真实环境变量里的凭据会污染断言（它们会让某个槽位"由环境变量提供"，
// 于是"磁盘上没有明文"这条断言就会因为跟被测逻辑无关的原因失败），先全摘掉
for (const key of [
  'MAILBOT_IMAP_PASS',
  'MAILBOT_SMTP_PASS',
  'MAILBOT_LLM_API_KEY',
  'MAILBOT_WEB_TOKEN',
  'MAILBOT_GOOGLE_CLIENT_SECRET',
  'DEEPSEEK_API_KEY',
  'GOOGLE_CLIENT_SECRET',
]) {
  delete process.env[key];
}

const {
  listBackends,
  autoDecision,
  resolveMode,
  readVault,
  writeVault,
  clearVault,
  encodeVault,
  decodeVault,
  resetVaultCache,
  __setBackendForTest,
  __setKeychainPathForTest,
  KEYRING_SERVICE,
  DPAPI_FILE,
  FILE_VAULT,
} = await import('../server/lib/secrets.js');
const {
  loadConfig,
  getConfig,
  getPaths,
  resetConfigCache,
  migrateSecrets,
  secretsReport,
} = await import('../server/config/index.js');

/* ------------------------------------------------------------ 断言 */

let passed = 0;
const failures = [];
const skipped = [];

/**
 * 用例返回值约定：
 *   - 字符串          → 作为"这一项具体验了什么"的说明打印；
 *   - `{ skip: 原因 }` → **显式跳过**（原因必打印）；
 *   - 抛错            → 失败。
 */
async function test(name, fn) {
  try {
    const detail = await fn();
    if (detail && typeof detail === 'object' && detail.skip) {
      skipped.push({ name, reason: detail.skip });
      console.log(`  ⊘ ${name} — 已跳过：${detail.skip}`);
      return;
    }
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    const cause = err?.cause ? ` ← ${err.cause.code || err.cause.name || ''} ${err.cause.message || err.cause}` : '';
    failures.push({ name, message: (err?.stack || String(err)) + cause });
    console.log(`  ✗ ${name}\n      ${err?.message || err}${cause}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function assertIncludes(hay, needle, msg) {
  if (!String(hay).includes(needle)) {
    throw new Error(`${msg || '未包含'}：期望包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(String(hay).slice(0, 300))}`);
  }
}

/** 被测值：三个平台共用的"金丝雀"，绝不能出现在任何明文文件里 */
const CANARY_IMAP = 'MAILBOT-CANARY-IMAP-7f3a91';
const CANARY_LLM = 'MAILBOT-CANARY-LLM-52c4e8';
const CANARY_WEB = 'MAILBOT-CANARY-WEB-3b6d20';
const CANARY_GSEC = 'MAILBOT-CANARY-GSEC-9a10ff';

/**
 * 本进程能不能**起子进程并拿到它的输出**？
 *
 * 三个系统后端全靠这个能力（DPAPI 走 powershell、钥匙串走 security、libsecret 走 secret-tool），
 * 而某些受限运行环境（例如带沙箱的 agent 会话）会把"管道子进程"整个禁掉，报 `EPERM`。
 * 那种环境里"真机往返"物理上不可能发生，所以这里先探一次，然后：
 *   - 能起：按平台预期与真实往返来断言（CI / 普通终端就是这条路）；
 *   - 不能起：**如实**断言"三个系统后端都报不可用 + 降级可见 + 拒绝把密钥搬进用不了的后端"，
 *     并在说明里写明"真跑交给 CI"，绝不假装验证过。
 */
function probePipedSubprocess() {
  const res = spawnSync(process.execPath, ['-e', 'process.stdout.write("ok")'], { encoding: 'utf8', timeout: 20000 });
  return { ok: !res.error && (res.stdout || '').trim() === 'ok', error: res.error ? res.error.code || res.error.message : null };
}
const SPAWN_PROBE = probePipedSubprocess();
const CAN_SPAWN = SPAWN_PROBE.ok;

/* ------------------------------------------------------------ 小工具 */

/** 递归找"某个明文值出现在哪些文件里"（② 的判据：必须是空数组）。 */
function findPlaintext(dir, needle) {
  const hits = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else {
        let text = '';
        try {
          text = fs.readFileSync(full, 'utf8');
        } catch {
          /* 二进制读不出来就算了：金丝雀是 ASCII，真泄漏了必然以文本可读 */
        }
        if (text.includes(needle)) hits.push(full);
      }
    }
  };
  walk(dir);
  return hits;
}

/**
 * 写一份带明文的配置并加载（模拟"用户刚填完授权码、还没迁入保管库"）。
 *
 * 每次都先清掉上一个用例留下的保管库残留：这套件里每个用例都要**自己从干净状态出发**，
 * 否则"读回一致"可能是在读上一个用例的残留，断言会变成假证据。
 */
function seedConfig({ mode, withSecrets = true }) {
  for (const file of [DPAPI_FILE, FILE_VAULT, 'google-token.json']) {
    fs.rmSync(path.join(tmpDir, file), { force: true });
  }
  const config = {
    dataDir: tmpDir,
    defaultInstanceId: 'test',
    instances: [
      {
        id: 'test',
        label: '测试实例',
        imap: { host: 'imap.example.com', port: 993, secure: true, authUser: 'tester@example.com', authPass: withSecrets ? CANARY_IMAP : '' },
        smtp: { host: 'smtp.example.com', port: 465, secure: true, authUser: 'tester@example.com', authPass: withSecrets ? CANARY_IMAP : '' },
        identity: { email: 'tester@example.com', name: '测试' },
      },
    ],
    llm: { apiKey: withSecrets ? CANARY_LLM : '', baseUrl: 'https://example.invalid/v1', model: 'test-model' },
    web: { authToken: withSecrets ? CANARY_WEB : '' },
    calendar: { google: { clientSecret: withSecrets ? CANARY_GSEC : '' } },
    vault: { mode },
  };
  fs.writeFileSync(getPaths().configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  resetVaultCache();
  resetConfigCache();
  loadConfig({ rootDir: root, force: true });
  return config;
}

/** 读磁盘上的 config.json（**磁盘事实**，不是内存里的注入结果）。 */
function diskConfig() {
  return JSON.parse(fs.readFileSync(getPaths().configFile, 'utf8'));
}

/* -------------------------------------------------- A. 跨平台通用：探测与降级可见 */

console.log(`\n平台密钥保管自检（platform=${process.platform}）`);
console.log(
  CAN_SPAWN
    ? '子进程能力：可用（真机往返会真跑）'
    : `子进程能力：**不可用**（${SPAWN_PROBE.error || '未知'}）——受限运行环境，系统后端的真机往返在本进程里无法进行，只能靠 CI`,
);
console.log('');

await test('后端探测：清单口径稳定，且平台预期与实测一致（可用性是实测，不是猜）', async () => {
  const list = listBackends();
  assertEqual(
    list.map((b) => b.id).join(','),
    'dpapi,keychain,libsecret,file',
    '后端清单（含顺序）应稳定，界面与报告都按它展示',
  );
  const of = (id) => list.find((b) => b.id === id);
  assertEqual(of('file').encrypted, false, 'file 后端必须如实标为**未加密**');
  for (const id of ['dpapi', 'keychain', 'libsecret']) {
    assertEqual(of(id).encrypted, true, `${id} 是加密后端，应标为已加密`);
  }
  assert(/未加密/.test(`${of('file').label}${of('file').detail}`), 'file 后端的文案里必须出现"未加密"（不粉饰）');
  assertEqual(of('file').available, true, 'file 是最后的退路，任何平台都必须可用');

  /*
   * 起不了子进程的受限环境：三个系统后端**必须**如实报不可用。
   * 这一条本身就是要紧的断言——"加密后端用不了却说可用"会直接导致密钥被搬进一个读不出来的地方。
   */
  if (!CAN_SPAWN) {
    for (const id of ['dpapi', 'keychain', 'libsecret']) {
      assertEqual(of(id).available, false, `本进程起不了子进程时，${id} 必须如实报不可用（不能假装可用）`);
    }
    return `受限环境（${SPAWN_PROBE.error}）：三个系统后端都如实报不可用；平台预期与真机往返交给 CI`;
  }

  const probeTool = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).status === 0;
  let detail = '';
  if (process.platform === 'win32') {
    assertEqual(of('dpapi').available, true, 'Windows 上 DPAPI 应可用（powershell 必在）');
    assertEqual(of('keychain').available, false, 'Windows 上不该报 macOS 钥匙串可用');
    assertEqual(of('libsecret').available, false, 'Windows 上不该报 secret-tool 可用');
    detail = 'Windows → dpapi 可用，keychain/libsecret 不可用';
  } else if (process.platform === 'darwin') {
    assertEqual(of('keychain').available, true, 'macOS 上 /usr/bin/security 必在，钥匙串后端应可用');
    assertEqual(of('dpapi').available, false, 'macOS 上不该报 DPAPI 可用');
    assertEqual(of('libsecret').available, false, 'macOS 上不该报 secret-tool 可用（libsecret 后端的 available() 只在 Linux 为真）');
    detail = 'macOS → keychain 可用，dpapi/libsecret 不可用';
  } else {
    // Linux：取决于本机是否装了 secret-tool —— 用独立探测**对账**，而不是假设
    const hasTool = probeTool('secret-tool');
    assertEqual(of('libsecret').available, hasTool, `libsecret 的可用性必须与本机是否真有 secret-tool 一致（实测：${hasTool ? '有' : '没有'}）`);
    assertEqual(of('dpapi').available, false, 'Linux 上不该报 DPAPI 可用');
    assertEqual(of('keychain').available, false, 'Linux 上不该报 macOS 钥匙串可用');
    detail = `Linux → libsecret ${hasTool ? '可用（装了 secret-tool）' : '不可用（没装 secret-tool）'}`;
  }
  return detail;
});

await test('auto 选择：首选加密后端可用就用它；一个都没有才落到 file（且必须标记降级）', async () => {
  const list = listBackends();
  const preferred = process.platform === 'win32' ? 'dpapi' : process.platform === 'darwin' ? 'keychain' : 'libsecret';
  const preferredAvailable = list.find((b) => b.id === preferred).available;
  const decision = autoDecision();

  if (preferredAvailable) {
    assertEqual(decision.id, preferred, '首选加密后端可用时，auto 必须选它');
    assertEqual(decision.degraded, false, '有加密后端可用时不算降级');
    assertEqual(decision.encrypted, true, '加密后端必须如实标为已加密');
    assertEqual(decision.reason, null, '没降级就不该有降级原因');
    assertEqual(resolveMode('auto'), preferred, 'resolveMode 与 autoDecision 必须一致');
    return `auto → ${preferred}（未降级）`;
  }

  const anyEncrypted = list.find((b) => b.encrypted && b.available);
  if (anyEncrypted) {
    assertEqual(decision.degraded, false, '还有别的加密后端可用时，不算降级');
    assertEqual(decision.id, anyEncrypted.id, `应退到可用的加密后端 ${anyEncrypted.id}`);
    return `auto → ${decision.id}（未降级）`;
  }

  assertEqual(decision.id, 'file', '没有任何加密后端时只能落到 file');
  assertEqual(decision.degraded, true, '落到**未加密**的 file 必须标记 degraded（静默降级是这里最不能接受的事）');
  assertEqual(decision.encrypted, false, 'file 未加密，不能标成已加密');
  assert(/未加密/.test(decision.reason || ''), `降级原因必须明说"未加密"（实际：${decision.reason}）`);
  assertEqual(resolveMode('auto'), 'file', 'resolveMode 也必须落到 file');
  return 'auto → file（已降级，原因可见）';
});

await test('降级可见（跨平台）：把系统后端全藏起来后，报告必须标注"未加密 + degraded + 原因"', async () => {
  /*
   * 怎么"藏起来"：把 PATH 指向一个空目录。
   *
   * 后端可用性是 `which` 实测出来的，所以这一下三个平台的后端都会报不可用
   * （POSIX 上连 `which` 自己都找不到；Windows 上 `where` 由系统目录兜住，但它照样
   * 查不到 PATH 里的 powershell.exe）。于是我们能在**任何**平台上稳定地走到降级分支——
   * 而不是"碰巧本机没有 secret-tool 才顺带测到"。
   */
  const oldPath = process.env.PATH;
  const oldPs = process.env.MAILBOT_POWERSHELL;
  const emptyBin = path.join(tmpDir, 'empty-bin');
  fs.mkdirSync(emptyBin, { recursive: true });
  try {
    process.env.PATH = emptyBin;
    delete process.env.MAILBOT_POWERSHELL;

    const list = listBackends();
    for (const id of ['dpapi', 'keychain', 'libsecret']) {
      assertEqual(list.find((b) => b.id === id).available, false, `${id} 在"系统工具不可见"的环境里必须如实报不可用（不能假装可用）`);
    }
    assertEqual(list.find((b) => b.id === 'file').available, true, 'file 后端不依赖任何外部工具，仍应可用');

    const decision = autoDecision();
    assertEqual(decision.id, 'file', '没有加密后端时 auto 应落到 file');
    assertEqual(decision.degraded, true, '必须标记为降级');
    assertEqual(decision.encrypted, false, '必须如实标为未加密');
    assert(/未加密/.test(decision.reason || ''), `降级原因必须明说"未加密"（实际：${decision.reason}）`);

    // 切到 auto 之后，报告层必须把降级照出来（设置页就是照着这份数据提示用户的）
    seedConfig({ mode: 'auto' });
    const report = secretsReport();
    assertEqual(report.mode, 'auto', '前置条件：当前是 auto 模式');
    assertEqual(report.resolved, 'file', '报告应说明实际用的是 file');
    assertEqual(report.degraded, true, '报告必须带 degraded 标记（界面据此显式提示，不许静默）');
    assert(/未加密/.test(report.degradeReason || ''), `报告的降级原因必须明说"未加密"（实际：${report.degradeReason}）`);
    assertEqual(report.currentBackend.id, 'file', '报告里的当前后端应是 file');
    assertEqual(report.currentBackend.encrypted, false, '当前后端必须如实标为未加密');
    assert(/未加密/.test(`${report.currentBackend.label}${report.currentBackend.detail}`), '当前后端文案里必须出现"未加密"');
    const fileRow = report.backends.find((b) => b.id === 'file');
    assertEqual(fileRow.encrypted, false, '后端清单里 file 也应标为未加密');

    // 迁移这条路同样不能含糊：落盘的 mode 是"实际用的后端"，结果文案也要说未加密
    const out = migrateSecrets({ mode: 'auto' });
    assertEqual(out.backend, 'file', '迁移结果应说明用的是 file');
    assertEqual(out.token.encrypted, false, '迁移结果必须如实说"没加密"');
    assert(/未加密/.test(out.message), `迁移结果文案必须出现"未加密"（实际：${out.message}）`);
    assertEqual(diskConfig().vault.mode, 'file', '落盘的是实际后端（不是"auto"这种看着加密、其实没有的假象）');
    return '三个平台都在"没有系统后端"的环境里验证过：降级必然可见';
  } finally {
    process.env.PATH = oldPath;
    if (oldPs === undefined) delete process.env.MAILBOT_POWERSHELL;
    else process.env.MAILBOT_POWERSHELL = oldPs;
    clearVault('file', { dataDir: tmpDir });
    resetVaultCache();
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
  }
});

/* -------------------------------------------------- 真机往返的公共骨架 */

/**
 * 在**真实系统后端**上走一遍用户实际会走的路：
 *   ① 写进系统保管 → 从系统保管原样读回；
 *   ② 迁进保管库之后，磁盘上（配置/任何文件）不得再有明文；
 *   ③ 清除之后读不到，系统保管里也确实没有了。
 *
 * `hooks.inStore()` / `hooks.notInStore()` 由各平台提供，用来**绕过我们自己的代码**直接问
 * 系统保管（双证据：不是"我们的代码说读回来了"，而是"系统里确实有"）。
 */
async function realBackendRoundtrip({ mode, label, hooks = {} }) {
  const dataDir = tmpDir;
  const p = getPaths();
  try {
    // 幂等清场：万一上次跑崩留下了残留
    clearVault(mode, { dataDir });
    resetVaultCache();

    // ①-a 不经配置文件，直接验证后端本身（写入 → 读回 → 逐项比对）
    const payload = { 'imap:test': CANARY_IMAP, llm: CANARY_LLM };
    const written = writeVault(mode, { dataDir }, encodeVault(payload));
    assert(written.ok, `写入「${label}」失败：${written.error || ''}`);
    const readBack = readVault(mode, { dataDir, force: true });
    assert(readBack.ok, `从「${label}」读回失败：${readBack.error || ''}`);
    const decoded = decodeVault(readBack.data);
    assert(decoded.ok, '保管内容应能解析');
    assertEqual(decoded.secrets['imap:test'], CANARY_IMAP, `① 写进「${label}」的值必须能原样读回`);
    assertEqual(decoded.secrets.llm, CANARY_LLM, '① 第二项也必须一致（不是只搬了第一项）');
    if (hooks.inStore) assert(hooks.inStore(), `① 系统保管里应当真的有这个值（${label}）`);

    // ①-b 端到端：走用户真正点的那条路（迁移）
    seedConfig({ mode: 'config' });
    assert(fs.existsSync(p.configFile), `前置条件：配置文件应当存在（${p.configFile}）`);
    const rawConfig = fs.readFileSync(p.configFile, 'utf8');
    assertIncludes(rawConfig, CANARY_IMAP, '前置条件：迁移前明文确实在 config.json 里（否则后面的断言等于没测）');

    const out = migrateSecrets({ mode });
    assertEqual(out.backend, mode, `迁移应报告后端为 ${mode}`);
    assert(out.migrated >= 4, `应迁移多项（实际 ${out.migrated}）`);

    // ① 值仍然可用：从系统保管注入回内存
    const live = getConfig();
    assertEqual(live.instances[0].imap.authPass, CANARY_IMAP, '① 迁移后程序仍能拿到授权码（说明是从系统保管读回来的）');
    assertEqual(live.llm.apiKey, CANARY_LLM, '① 大模型 API Key 也应读回来');
    assertEqual(live.web.authToken, CANARY_WEB, '① 界面访问令牌也应读回来');
    assertEqual(live.calendar.google.clientSecret, CANARY_GSEC, '① Google Client Secret 也应读回来');
    if (hooks.inStore) assert(hooks.inStore(), `① 系统保管里应当真的有这个值（${label}）`);

    // ② 磁盘上不许再有明文
    const onDisk = diskConfig();
    assertEqual(onDisk.instances[0].imap.authPass, '', '② config.json 里不应再有明文授权码');
    assertEqual(onDisk.instances[0].smtp.authPass, '', '② config.json 里不应再有明文发信授权码');
    assertEqual(onDisk.llm.apiKey, '', '② config.json 里不应再有明文 API Key');
    assertEqual(onDisk.web.authToken, '', '② config.json 里不应再有明文访问令牌');
    assertEqual(onDisk.calendar.google.clientSecret, '', '② config.json 里不应再有明文 Client Secret');
    for (const needle of [CANARY_IMAP, CANARY_LLM, CANARY_WEB, CANARY_GSEC]) {
      const hits = findPlaintext(dataDir, needle);
      assertEqual(hits.length, 0, `② 数据目录里不应有任何明文文件含这个值（命中：${hits.join('、')}）`);
    }
    assertEqual(secretsReport().plaintextCount, 0, '② 报告也不该说还有明文密钥');

    // ③ 清除之后读不到，系统保管里也确实没有
    const cleared = clearVault(mode, { dataDir });
    assert(cleared.ok, `清除「${label}」失败：${cleared.error || ''}`);
    resetVaultCache();
    const after = readVault(mode, { dataDir, force: true });
    assert(after.ok, '清除后读取不应报错');
    const afterDecoded = after.data ? decodeVault(after.data) : { ok: true, secrets: {} };
    assertEqual(afterDecoded.secrets['imap:test'] || null, null, `③ 清除后「${label}」里不应还能读到值`);
    if (hooks.notInStore) assert(hooks.notInStore(), `③ 清除后系统保管里也应该没有（${label}）`);

    return label;
  } finally {
    // 无论成功失败都清干净：不留条目、不留临时钥匙串
    try {
      clearVault(mode, { dataDir });
    } catch {
      /* 尽力而为 */
    }
    resetVaultCache();
    if (hooks.cleanup) {
      try {
        hooks.cleanup();
      } catch {
        /* 尽力而为 */
      }
    }
    // 收尾把配置恢复成"没有保管库"的干净样子，免得影响后面的用例
    seedConfig({ mode: 'config', withSecrets: false });
  }
}

/* -------------------------------------------------- B0. 骨架自检（跨平台，不需任何系统能力） */

await test('真机用例骨架自检：用内存假后端走一遍"迁移 → 读回 → 明文检查 → 清除"整条断言链', async () => {
  /*
   * 这一条不是"再测一遍假后端"，而是**给真机用例做垫脚石**：
   *
   * 真机往返（DPAPI / 钥匙串 / libsecret）只能在各自平台、且能起子进程的环境里跑。
   * 万一那条链子里有 bug（顺序错了、扫明文扫到自己写的文件、hooks 没接上），
   * CI 上会红成一片，而红的原因却是"测试骨架坏了"——排查成本极高。
   * 所以先用一个纯内存后端把**同一套断言链**跑通：骨架不过，就不必上真机。
   */
  const store = { text: null };
  __setBackendForTest('osskeleton', {
    id: 'osskeleton',
    label: '骨架自检用内存后端',
    encrypted: true,
    detail: '仅测试用（不是真实系统保管）',
    available: () => true,
    read: () => ({ ok: true, value: store.text }),
    write: (_dataDir, text) => {
      store.text = text;
      return { ok: true };
    },
    clear: () => {
      store.text = null;
      return { ok: true };
    },
  });
  resetVaultCache();
  try {
    return await realBackendRoundtrip({
      mode: 'osskeleton',
      label: '骨架自检用内存后端',
      hooks: {
        inStore() {
          assert(!!store.text, '① 内存后端里应当确实有内容');
          return true;
        },
        notInStore() {
          assertEqual(store.text, null, '③ 清除后内存后端里应当没有内容');
          return true;
        },
      },
    });
  } finally {
    __setBackendForTest(null);
    resetVaultCache();
    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
  }
});

/* -------------------------------------------------- B1. Windows：DPAPI 真跑 */

await test('Windows DPAPI：真跑往返（密文落盘、明文不落盘、清除后读不到）', async () => {
  if (process.platform !== 'win32') {
    return { skip: `DPAPI 是 Windows 专有 API（本机是 ${process.platform}，该能力在本平台确实不存在）` };
  }
  const dpapiFile = path.join(tmpDir, DPAPI_FILE);
  /*
   * 受限环境（起不了子进程）：DPAPI 真跑在物理上做不到。这里不假装验证过，而是断言那条底线——
   * "用不了的后端必须如实报不可用，且**拒绝**迁移、一个字节明文都不许动"。
   * 真机往返由 Windows CI 完成（那边子进程可用）。
   */
  if (!CAN_SPAWN) {
    seedConfig({ mode: 'config' });
    let code = null;
    let message = '';
    try {
      migrateSecrets({ mode: 'dpapi' });
    } catch (err) {
      code = err.code;
      message = err.message;
    }
    assertEqual(code, 'SECRETS_BACKEND_UNAVAILABLE', `起不了子进程时 DPAPI 必须如实报不可用并拒绝迁移（实际：${code} / ${message}）`);
    assertIncludes(fs.readFileSync(getPaths().configFile, 'utf8'), CANARY_IMAP, '拒绝迁移时明文必须原样还在（绝不弄丢）');
    assertEqual(fs.existsSync(dpapiFile), false, '被拒绝的迁移不该留下半个密文文件');
    assertEqual(diskConfig().vault?.mode || 'config', 'config', '被拒绝时不该改 vault.mode');
    resetVaultCache();
    return `受限环境（${SPAWN_PROBE.error}）：DPAPI 如实报不可用 + 拒绝迁移 + 明文未动；真机往返交给 Windows CI`;
  }
  return realBackendRoundtrip({
    mode: 'dpapi',
    label: 'Windows DPAPI',
    hooks: {
      inStore() {
        assert(fs.existsSync(dpapiFile), `DPAPI 密文文件应落盘：${dpapiFile}`);
        const raw = fs.readFileSync(dpapiFile, 'utf8');
        assert(raw.trim().length > 0, 'DPAPI 密文不应为空');
        assert(!raw.includes(CANARY_IMAP), '② 密文里不得出现明文（它是加密后 Base64，不是"换个后缀的明文"）');
        assert(!raw.includes(CANARY_LLM), '② 密文里不得出现第二个明文值');
        assert(/^[A-Za-z0-9+/=]+$/.test(raw.trim()), 'DPAPI 密文应是 Base64（不是随手写了个 JSON）');
        return true;
      },
      notInStore() {
        assertEqual(fs.existsSync(dpapiFile), false, '③ 清除后密文文件应被删掉');
        return true;
      },
    },
  });
});

/* -------------------------------------------------- B2. macOS：钥匙串真跑（临时钥匙串） */

function security(args, { timeout = 20000 } = {}) {
  const res = spawnSync('security', args, { encoding: 'utf8', timeout, windowsHide: true });
  return {
    status: res.status,
    stdout: (res.stdout || '').trim(),
    stderr: (res.stderr || '').trim(),
    error: res.error ? res.error.code || res.error.message : null,
  };
}

/** 默认（登录）钥匙串路径；拿不到就返回 null（那就不做"没被碰过"的附加断言） */
function defaultKeychainPath() {
  const res = security(['default-keychain', '-d', 'user']);
  if (res.status !== 0) return null;
  const m = res.stdout.match(/"([^"]+)"/);
  return m ? m[1] : null;
}

/** 某个钥匙串里有没有 mailbot 的条目（只读属性，**不加 -w**，避免任何取密码的弹窗） */
function keychainHasItem(keychainPath) {
  if (!keychainPath) return 'unknown';
  const res = security(['find-generic-password', '-s', KEYRING_SERVICE, '-a', 'mailbot', keychainPath]);
  if (res.status === 0) return true;
  if (res.status === 44 || /could not be found/i.test(res.stderr)) return false;
  return `unknown(${res.status}${res.error ? `/${res.error}` : ''})`;
}

await test('macOS 钥匙串：临时钥匙串里的真跑往返（登录钥匙串一个字节都不碰）', async () => {
  if (process.platform !== 'darwin') {
    return { skip: `macOS 钥匙串只在 darwin 上存在（本机是 ${process.platform}，该能力在本平台确实不存在）` };
  }
  if (!CAN_SPAWN) {
    // 受限环境：`security` 起不来，整条往返无法进行（能力在本进程里确实不存在）
    return { skip: `本进程起不了子进程（${SPAWN_PROBE.error}），security 命令无法执行，真机往返交给 macOS CI` };
  }
  const kcDir = makeTempDir('mailbot-keychain-');
  const kcName = path.join(kcDir, 'mailbot-test.keychain');
  const pw = `mailbot-test-${process.pid}`;
  let created = false;
  let cleanedUp = false;
  let detail = '';
  const loginBefore = keychainHasItem(defaultKeychainPath());
  try {
    const made = security(['create-keychain', '-p', pw, kcName]);
    assertEqual(made.status, 0, `security create-keychain 失败：${made.stderr || made.error || made.status}`);
    created = true;

    /*
     * 新版 macOS 落盘是 `<名字>-db`，所以这里以**目录里实际出现的文件**为准，
     * 而不是猜后缀——后面所有 `security` 调用都用这个真实路径。
     */
    const files = fs.readdirSync(kcDir).filter((f) => f.startsWith('mailbot-test.keychain'));
    assertEqual(files.length, 1, `应正好建出一个临时钥匙串文件（实际：${files.join('、') || '无'}）`);
    const kc = path.join(kcDir, files[0]);

    const unlocked = security(['unlock-keychain', '-p', pw, kc]);
    assertEqual(unlocked.status, 0, `临时钥匙串应能解锁：${unlocked.stderr || unlocked.error || unlocked.status}`);

    /*
     * 关键一步：把钥匙串后端**钉到临时钥匙串**上。
     *
     * 于是我们既不需要 `security default-keychain` 也不需要改搜索列表——
     * 那两样都是**全局机器状态**，改了万一进程被杀就会留下痕迹（用户的钥匙串默认值被换掉）。
     * 钉住之后，后端拼出的每条命令都显式带这个钥匙串参数，用户登录钥匙串压根不在搜索范围内。
     */
    __setKeychainPathForTest(kc);
    assertEqual(
      security(['find-generic-password', '-s', KEYRING_SERVICE, '-a', 'mailbot', '-w', kc]).status === 0,
      false,
      '前置条件：临时钥匙串建出来时是空的',
    );

    detail = await realBackendRoundtrip({
      mode: 'keychain',
      label: 'macOS 钥匙串',
      hooks: {
        inStore() {
          const got = security(['find-generic-password', '-s', KEYRING_SERVICE, '-a', 'mailbot', '-w', kc]);
          assertEqual(got.status, 0, `① 直接用 security 查临时钥匙串应当查得到：${got.stderr || got.error || got.status}`);
          assert(got.stdout.includes(CANARY_IMAP), `① 钥匙串里存的应当就是那份保管内容（含金丝雀），实际：${got.stdout.slice(0, 120)}`);
          return true;
        },
        notInStore() {
          const got = security(['find-generic-password', '-s', KEYRING_SERVICE, '-a', 'mailbot', '-w', kc]);
          assert(got.status !== 0, '③ 清除后直接用 security 也应查不到（退出码不为 0）');
          return true;
        },
      },
    });

    // 附加证据：用户登录钥匙串的状态前后完全一致（我们只动了临时钥匙串）
    const loginAfter = keychainHasItem(defaultKeychainPath());
    if (loginBefore !== 'unknown' && loginAfter !== 'unknown') {
      assertEqual(loginAfter, loginBefore, '登录钥匙串里 mailbot 条目的存在性不得被本次测试改变');
    }
    detail = `${detail}（临时钥匙串 ${path.basename(kc)}，登录钥匙串未触碰）`;
  } finally {
    /*
     * 无论成功失败：解除钉住 → 删掉临时钥匙串 → 删目录。
     *
     * 清理里**刻意不做断言**：否则清理失败会把"真正的失败原因"顶掉，
     * 排查的人只会看到一个莫名其妙的清理错误。清理结论放到 finally 之后单独断言。
     */
    __setKeychainPathForTest(null);
    if (created) {
      const del = security(['delete-keychain', kcName]);
      if (del.status !== 0) console.log(`      （注意：security delete-keychain 退出码 ${del.status}：${del.stderr || del.error || ''}）`);
    }
    try {
      for (const f of fs.readdirSync(kcDir)) fs.rmSync(path.join(kcDir, f), { force: true });
      fs.rmSync(kcDir, { recursive: true, force: true });
    } catch {
      /* 目录已登记在 tmp.js，进程退出时还会再删一次 */
    }
    cleanedUp = !fs.existsSync(kcDir);
    if (!cleanedUp) console.log(`      （注意：临时钥匙串目录还在 ${kcDir}，tmp.js 会在进程退出时再删一次）`);
  }
  // 主流程没抛错时才走到这里：此时"4 清理彻底"才是一条有效的结论
  assertEqual(cleanedUp, true, '④ 临时钥匙串（含目录）必须被删掉，不留痕迹');
  return detail;
});

/* -------------------------------------------------- B3. Linux：libsecret */

/**
 * 在真实 D-Bus 会话里跑一遍 libsecret 往返（子进程方式）。
 *
 * 为什么要起子进程：`secret-tool` 要通过会话总线找到 Secret Service，
 * 而 `dbus-run-session` + `gnome-keyring-daemon` 必须在**同一个会话**里起。
 * 本测试自己搭这个会话（钥匙环数据落在临时目录），不依赖 CI 的 shell 已经配好。
 *
 * 返回值：{ kind: 'real', facts } | { kind: 'skip', reason }
 */
function runLibsecretReal() {
  const child = path.join(here, 'lib', 'libsecret-roundtrip.mjs');
  const rundir = path.join(tmpDir, 'dbus-session');
  fs.mkdirSync(path.join(rundir, 'xdg'), { recursive: true });
  fs.mkdirSync(path.join(rundir, 'runtime'), { recursive: true, mode: 0o700 });

  const script = [
    'set -u',
    'echo WRAPPER:start',
    'export XDG_DATA_HOME="$KC_RUNDIR/xdg"',      // 钥匙环数据落在临时目录，不写 runner 的 HOME
    'export XDG_RUNTIME_DIR="$KC_RUNDIR/runtime"',
    'if command -v gnome-keyring-daemon >/dev/null 2>&1; then',
    '  printf %s "$KC_PASS" | gnome-keyring-daemon --unlock --components=secrets >"$KC_RUNDIR/keyring.out" 2>"$KC_RUNDIR/keyring.err" &',
    'fi',
    'i=0',
    'ok=0',
    'while [ "$i" -lt 20 ]; do',
    '  probe="probe-$i"',
    '  if printf %s "$probe" | secret-tool store --label=mailbot-probe probe probe >/dev/null 2>&1; then',
    '    got=$(secret-tool lookup probe probe 2>/dev/null || true)',
    '    if [ "$got" = "$probe" ]; then ok=1; secret-tool clear probe probe >/dev/null 2>&1 || true; break; fi',
    '  fi',
    '  i=$((i+1)); sleep 0.5',
    'done',
    'if [ "$ok" != "1" ]; then',
    '  echo "INFRA:secret-service-unusable"',
    '  echo "--- gnome-keyring stderr ---"; tail -n 5 "$KC_RUNDIR/keyring.err" 2>/dev/null || true',
    '  exit 3',
    'fi',
    'echo WRAPPER:node-start',
    'exec "$KC_NODE" "$KC_CHILD" "$KC_CANARY" "$KC_DATADIR" "$KC_ROOT"',
  ].join('\n');

  const res = spawnSync('dbus-run-session', ['--', 'bash', '-c', script], {
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      KC_RUNDIR: rundir,
      KC_PASS: `mailbot-test-${process.pid}`,
      KC_NODE: process.execPath,
      KC_CHILD: child,
      KC_CANARY: CANARY_IMAP,
      KC_DATADIR: tmpDir,
      KC_ROOT: root,
    },
  });
  const stdout = res.stdout || '';
  const stderr = res.stderr || '';
  const tail = (text, n = 6) => text.trim().split('\n').slice(-n).join('\n');

  if (res.error && res.error.code === 'ENOENT') {
    return { kind: 'skip', reason: '本机没有 dbus-run-session（缺 dbus 工具），无法造出 Secret Service 会话' };
  }
  if (res.error && res.error.code === 'EPERM') {
    return { kind: 'skip', reason: '本进程起不了子进程（EPERM，受限环境），无法造出 Secret Service 会话' };
  }
  if (stdout.includes('INFRA:')) {
    const why = (stdout.split('\n').find((l) => l.startsWith('INFRA:')) || '').trim();
    console.log(`      真跑不可用的原始输出：\n${tail(stdout, 12)}`);
    return { kind: 'skip', reason: `${why.replace('INFRA:', '')}（D-Bus/钥匙环在本环境里起不来，详见上方原始输出）` };
  }
  if (!stdout.includes('WRAPPER:start')) {
    console.log(`      真跑不可用的原始输出（退出码 ${res.status}，error=${res.error?.code || '无'}）：\n${tail(stdout || stderr, 12)}`);
    return { kind: 'skip', reason: `dbus-run-session 没能起来（退出码 ${res.status}）` };
  }
  /*
   * 走到这里说明**会话真的起来了**（wrapper 打出了标记）。
   * 那么再往下就不允许"跳过"了：子进程没跑完 = 真问题，必须红。
   */
  assert(stdout.includes('WRAPPER:node-start'), `会话起来了但子进程没被启动（输出：${tail(stdout, 12)}）`);
  const doneLine = stdout.split('\n').reverse().find((l) => l.includes('"stage":"done"'));
  assert(doneLine, `子进程没有打出结论（说明它中途崩了），stderr：\n${tail(stderr, 12)}`);
  return { kind: 'real', facts: JSON.parse(doneLine) };
}

await test('Linux libsecret：真实 Secret Service 往返（D-Bus/钥匙环起不来时显式跳过）', async () => {
  if (process.platform !== 'linux') {
    return { skip: `libsecret 后端只在 Linux 上可用（本机是 ${process.platform}，该能力在本平台确实不存在）` };
  }
  const probe = spawnSync('sh', ['-c', 'command -v secret-tool'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    return { skip: '本机没有 secret-tool（未安装 libsecret-tools），改由下面的"命令级"用例覆盖读写路径' };
  }
  // 子进程要跑"迁移"，所以先给它备好一份带明文的配置（它自己起会话、自己跑完整个往返）
  seedConfig({ mode: 'config' });
  const res = runLibsecretReal();
  if (res.kind === 'skip') return { skip: res.reason };

  const f = res.facts;
  try {
    assertEqual(f.stage, 'done', '子进程应给出结论');
    assert(f.ok, `真实 libsecret 往返失败：${f.error || '未知原因'}`);
    assertEqual(f.write?.ok, true, '写入真实 Secret Service 应成功');
    assertEqual(f.readValue, CANARY_IMAP, '① 写进 Secret Service 的值必须能原样读回');
    assertEqual(f.directAfterWrite?.stdout?.includes(CANARY_IMAP), true, '① 直接用 secret-tool lookup 也应能查到（双证据）');
    assertEqual(f.migrate?.backend, 'libsecret', '迁移应报告后端为 libsecret');
    assertEqual(f.inMemoryValue, CANARY_IMAP, '① 迁移后程序仍能拿到授权码');
    assertEqual(f.configDiskHasPlaintext, false, '② config.json 里不应再有明文');
    assertEqual(f.plaintextHits.length, 0, `② 数据目录里不应有明文文件含该值（命中：${f.plaintextHits.join('、')}）`);
    assertEqual(f.reportPlaintextCount, 0, '② 报告也不该说还有明文密钥');
    assertEqual(f.clear?.ok, true, '清除应成功');
    assertEqual(f.afterClearValue, null, '③ 清除后读不到');
    assertEqual(f.directAfterClear?.status !== 0, true, '③ 清除后直接用 secret-tool 也查不到');
  } finally {
    clearVault('libsecret', { dataDir: tmpDir });
    resetVaultCache();
    seedConfig({ mode: 'config', withSecrets: false });
  }
  return '真跑通过：真 D-Bus 会话 + 真 gnome-keyring + 真 secret-tool';
});

await test('libsecret 命令级验证：假 secret-tool 记录真实调用（store 走 stdin、lookup、clear）', async () => {
  /*
   * 这条用例在**任何 POSIX** 上都跑（不依赖 D-Bus）：它验证的不是"钥匙环能用"，
   * 而是"我们拼出去的命令与读写路径对不对"——尤其是**密钥只走 stdin、绝不进 argv**
   * 这条硬规矩（argv 对同机其他进程可见，把密钥放进去等于白加密）。
   *
   * 假 secret-tool 由测试自己生成，不属于项目依赖，用完即删。
   */
  if (process.platform === 'win32') {
    return { skip: 'Windows 上 libsecret 后端按设计不可用（available() 只在 Linux 为真），且 .cmd 无法被直接 spawn' };
  }
  if (!CAN_SPAWN) {
    return { skip: `本进程起不了子进程（${SPAWN_PROBE.error}），没法调用假 secret-tool，命令级验证交给 CI` };
  }
  const dir = makeTempDir('mailbot-fake-secret-tool-');
  const bin = path.join(dir, 'secret-tool');
  const logFile = path.join(dir, 'calls.log');
  const valueFile = path.join(dir, 'value');
  const script = `#!/bin/sh
# 测试生成的假 secret-tool（只在本次用例的 PATH 里出现）
DIR='${dir}'
{ echo CALL; for a in "$@"; do echo "ARG:$a"; done; } >> "$DIR/calls.log"
cmd="\${1:-}"
if [ $# -gt 0 ]; then shift; fi
case "$cmd" in
  store) cat > "$DIR/value"; exit 0 ;;
  lookup) if [ -f "$DIR/value" ]; then cat "$DIR/value"; exit 0; else exit 1; fi ;;
  clear) rm -f "$DIR/value"; exit 0 ;;
  *) echo "fake secret-tool: 不认识的子命令 $cmd" >&2; exit 2 ;;
esac
`;
  fs.writeFileSync(bin, script, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  const oldPath = process.env.PATH;
  try {
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    resetVaultCache();

    const lib = listBackends().find((b) => b.id === 'libsecret');
    assertEqual(lib.available, process.platform === 'linux', 'Linux 上找到了 secret-tool 就应报可用；其它 POSIX 平台这个后端按设计不可用');

    const payload = { 'imap:test': CANARY_IMAP };
    const written = writeVault('libsecret', { dataDir: tmpDir }, encodeVault(payload));
    assert(written.ok, `写入应走假 secret-tool 并成功：${written.error || ''}`);
    const readBack = readVault('libsecret', { dataDir: tmpDir, force: true });
    assert(readBack.ok, `读回应成功：${readBack.error || ''}`);
    assertEqual(decodeVault(readBack.data).secrets['imap:test'], CANARY_IMAP, '读回的值应与写入一致');

    const cleared = clearVault('libsecret', { dataDir: tmpDir });
    assert(cleared.ok, `清除应成功：${cleared.error || ''}`);
    const after = readVault('libsecret', { dataDir: tmpDir, force: true });
    assert(after.ok, '清除后读取不应报错');
    assert(
      !after.data || !decodeVault(after.data).secrets['imap:test'],
      '清除后应读不到（真 secret-tool 查不到时是"退出码 1 + 空输出"，这不算错误）',
    );

    const calls = fs.readFileSync(logFile, 'utf8');
    assertIncludes(calls, 'ARG:store', '应调用 store');
    assertIncludes(calls, 'ARG:--label=mailbot 密钥保管', 'store 应带 --label（界面上要能认出这是谁存的）');
    assertIncludes(calls, 'ARG:lookup', '应调用 lookup');
    assertIncludes(calls, 'ARG:clear', '应调用 clear');
    for (const attr of ['service', 'mailbot']) {
      assertIncludes(calls, `ARG:${attr}`, `lookup/clear/store 都应按 "${attr}" 属性定位同一条目`);
    }

    // 硬规矩：密钥只走 stdin
    const argLines = calls.split('\n').filter((l) => l.startsWith('ARG:'));
    assert(argLines.length > 0, '假工具应当真的被调用过（否则上面的断言全是空转）');
    const leaked = argLines.filter((l) => l.includes(CANARY_IMAP));
    assertEqual(leaked.length, 0, `密钥绝不能出现在命令行参数里（argv 对同机其他进程可见）：${leaked.join(' | ')}`);

    assertEqual(fs.existsSync(valueFile), false, '清除之后假工具里的值文件也应没了（清理彻底）');
    const callCount = calls.split('\n').filter((l) => l.trim() === 'CALL').length;
    return `命令级验证通过：假 secret-tool 被调用 ${callCount} 次（store/lookup/clear 各就各位），明文未进 argv`;
  } finally {
    process.env.PATH = oldPath;
    resetVaultCache();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('Linux：secret-tool 存在与否都如实反映（没有时必须显式降级到未加密 file）', async () => {
  if (process.platform !== 'linux') {
    return { skip: `这是 Linux 专属口径（本机是 ${process.platform}）；其它平台由前面的跨平台降级用例覆盖` };
  }
  const hasTool = spawnSync('sh', ['-c', 'command -v secret-tool'], { encoding: 'utf8' }).status === 0;
  const lib = listBackends().find((b) => b.id === 'libsecret');
  assertEqual(lib.available, hasTool, 'libsecret 的可用性必须与本机是否真有 secret-tool 一致');
  assertEqual(lib.encrypted, true, 'libsecret 是加密后端');

  const decision = autoDecision();
  if (hasTool) {
    assertEqual(decision.id, 'libsecret', 'secret-tool 在时 auto 应选 libsecret');
    assertEqual(decision.degraded, false, '有加密后端可用时不该报降级');
    return '本机装了 secret-tool：auto → libsecret（未降级）';
  }

  assertEqual(decision.id, 'file', 'secret-tool 不在时 auto 只能落到 file');
  assertEqual(decision.degraded, true, '必须标记降级（不能悄悄把密钥写进未加密文件）');
  assertEqual(decision.encrypted, false, '必须如实标为未加密');
  assert(/未加密/.test(decision.reason || ''), `降级原因必须明说"未加密"（实际：${decision.reason}）`);

  seedConfig({ mode: 'auto' });
  try {
    const report = secretsReport();
    assertEqual(report.degraded, true, '报告必须带 degraded 标记');
    assert(/未加密/.test(report.degradeReason || ''), '报告的降级原因必须明说"未加密"');
    assertEqual(report.currentBackend.id, 'file', '当前后端应是 file');
    assertEqual(report.currentBackend.encrypted, false, '当前后端必须如实标为未加密');
  } finally {
    clearVault('file', { dataDir: tmpDir });
    resetVaultCache();
  }
  return '本机没有 secret-tool：auto → file（降级在报告里可见）';
});

/* ------------------------------------------------------------ 收尾 */

seedConfig({ mode: 'config', withSecrets: false });

console.log(`\n通过 ${passed} 项，跳过 ${skipped.length} 项，失败 ${failures.length} 项。`);
if (skipped.length) {
  console.log('\n跳过明细（原因必须打印出来：静默 pass 会让"验证过"变成假象）：');
  for (const s of skipped) console.log(`  ⊘ ${s.name}\n      原因：${s.reason}`);
}
if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
}
console.log(`\n测试数据目录：${tmpDir}（已登记，进程退出时自动清理）`);

process.exitCode = failures.length ? 1 : 0;
