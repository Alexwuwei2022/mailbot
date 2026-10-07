/**
 * 在**真实 D-Bus 会话 + gnome-keyring** 里跑一遍 libsecret 后端的往返。
 *
 * 为什么是子进程：`secret-tool` 必须通过**会话总线**找到 Secret Service，
 * 而 `dbus-run-session` + `gnome-keyring-daemon` 只能在同一个会话里起。
 * 由 `test/secrets-platform.js` 负责搭这个会话（钥匙环数据落在临时目录），本文件只负责跑与汇报。
 *
 * ## 这里只汇报事实，不做断言
 *
 * 断言留在父进程（`test/secrets-platform.js`），好处是：CI 日志里能看到**同一个用例名下的
 * 完整断言链**，而不是"子进程说它自己过了"。所以这里把每一步的结果如实打成一行 JSON。
 *
 * 用法（父进程负责传参）：
 *   node test/lib/libsecret-roundtrip.mjs <金丝雀值> <数据目录> <项目根>
 *
 * ⚠️ 前置条件：父进程已经往 `<数据目录>/config.json` 里写好了一份**带明文金丝雀**的配置，
 *    本文件负责走"迁移 → 校验 → 清除"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  writeVault,
  readVault,
  clearVault,
  encodeVault,
  decodeVault,
  resetVaultCache,
} from '../../server/lib/secrets.js';

const [canary, dataDir, rootDir] = process.argv.slice(2);
const configFile = path.join(dataDir, 'config.json');
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

// 第一行必须是"我还活着"：父进程靠它区分"子进程中途崩了"（真问题，要红）
// 与"会话压根没起来"（环境能力缺失，显式跳过）。
out({ stage: 'child-start', pid: process.pid, platform: process.platform });

/** 直接问 secret-tool（**绕过我们自己的代码**，作为"值真的在钥匙环里"的独立证据） */
function directLookup() {
  const res = spawnSync('secret-tool', ['lookup', 'service', 'mailbot'], { encoding: 'utf8', timeout: 20000 });
  return { status: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

/** 递归找明文金丝雀（与父进程同一判据：② 明文不许落盘） */
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

const facts = { ok: false };

try {
  // 幂等清场（万一上一轮留下了条目）
  facts.clearBefore = clearVault('libsecret', { dataDir });
  resetVaultCache();

  // ①-a 不经配置文件，直接验证后端本身
  const payload = { 'imap:test': canary, llm: `${canary}-LLM` };
  facts.write = writeVault('libsecret', { dataDir }, encodeVault(payload));
  const readBack = readVault('libsecret', { dataDir, force: true });
  facts.readOk = readBack.ok;
  facts.readError = readBack.error || null;
  facts.readValue = readBack.ok ? decodeVault(readBack.data).secrets['imap:test'] : null;
  facts.directAfterWrite = directLookup();

  // ①-b 端到端：走用户实际点的那条路（迁移）
  const { loadConfig, getConfig, resetConfigCache, migrateSecrets, secretsReport } = await import('../../server/config/index.js');
  resetConfigCache();
  loadConfig({ rootDir, force: true });
  facts.configDiskHasPlaintextBefore = fs.readFileSync(configFile, 'utf8').includes(canary);
  facts.migrate = migrateSecrets({ mode: 'libsecret' });
  facts.inMemoryValue = getConfig().instances[0].imap.authPass;
  facts.configDiskHasPlaintext = fs.readFileSync(configFile, 'utf8').includes(canary);
  facts.plaintextHits = findPlaintext(dataDir, canary);
  facts.reportPlaintextCount = secretsReport().plaintextCount;

  // ③ 清除后读不到
  facts.clear = clearVault('libsecret', { dataDir });
  resetVaultCache();
  const after = readVault('libsecret', { dataDir, force: true });
  facts.afterClearOk = after.ok;
  facts.afterClearValue = after.ok && after.data ? decodeVault(after.data).secrets['imap:test'] ?? null : null;
  facts.directAfterClear = directLookup();

  facts.ok = true;
} catch (err) {
  facts.ok = false;
  facts.error = `${err?.code ? `${err.code}: ` : ''}${err?.message || String(err)}`;
} finally {
  // 无论成败都清掉钥匙环里的条目：不留痕迹
  try {
    clearVault('libsecret', { dataDir });
  } catch {
    /* 尽力而为 */
  }
}

out({ stage: 'done', ...facts });
