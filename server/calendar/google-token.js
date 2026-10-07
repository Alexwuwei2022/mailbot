/**
 * Google 令牌的**存放**：系统保管库（钥匙串/DPAPI）/ 明文文件 / 保管库不可用时的如实报错。
 *
 * ## 为什么单独一个模块
 *
 * 令牌原先只躺在 `data/google-token.json`（0600）里。它和邮箱授权码、API Key 一样是
 * "别人拿到就能读你日历"的凭据，所以现在纳入保管库（`secrets.js` 的 `googleToken` 槽位）。
 *
 * 抽成独立模块是为了**避开模块循环**：`config/index.js` 需要在 `migrateSecrets` /
 * `revertSecrets` / `secretsReport` 里搬动这个令牌，如果它去静态 import `google-auth.js`
 * （里面一堆网络与 OAuth 逻辑），就会形成 config ↔ calendar 的环。
 * 这里只要求**注入两个依赖**（`configure`），自己不去 import 业务模块。
 *
 * ## 三条铁律
 *
 * 1. **令牌值绝不进日志、也绝不进错误信息**。所有出错路径只写"哪一步失败了"，
 *    不写令牌内容（连前缀都不写）。日志里只有账号邮箱、后端名、错误码。
 * 2. **先落袋（写进保管库并读回比对），再清明文**。比对不通过就不动明文文件——
 *    弄丢 refresh token 等于要用户重新授权一次，宁可留着明文也不能丢。
 * 3. **读不出来不许静默**。以前 parse 失败/没有文件都返回 `null`，上层就当成"没连接"，
 *    界面显示"未连接"而用户以为自己连过——这种静默掉线是最难查的一类问题。
 *    现在读取失败抛 `GOOGLE_TOKEN_*` 错误，界面据此显示"需要重新授权"而不是"未连接"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { AppError, log } from '../lib/util.js';

/** 明文令牌文件名（在 dataDir 下）。迁移后它会被删掉，但**旧数据必须仍能被读**。 */
export const TOKEN_FILE_NAME = 'google-token.json';

/** 注入依赖（由 config/index.js 在模块初始化时调用；测试里也可替换）。 */
let deps = null;

export function configure(next) {
  deps = next;
}

/** 测试用：把依赖还原成"config/index.js 默认注入的那一份"。 */
let defaultDeps = null;
export function __setDefaultDeps() {
  deps = defaultDeps;
}
/** 测试用：直接替换依赖。 */
export function __setDepsForTest(next) {
  deps = next;
  if (!defaultDeps) defaultDeps = next;
}

/**
 * 依赖里允许出现一点竞态（模块循环带来的 `undefined`）：
 * 只要某一刻拿不到，就"像保管库不可用那样"如实报错，而不是当成"没有令牌"。
 */
function d() {
  return deps || null;
}

function ctx() {
  const deps = d();
  if (!deps) {
    return { ok: false, error: 'Google 令牌存储未初始化（程序内部错误）', code: 'GOOGLE_TOKEN_STORE_UNAVAILABLE' };
  }
  const config = deps.getConfig();
  const root = deps.getRoot();
  const vcfg = config.vault || {};
  const mode = vcfg.mode || 'config';
  return {
    ok: true,
    deps,
    config,
    mode,
    resolved: deps.resolveMode(mode),
    dataDir: deps.dataDirOf(config, root),
    // 用**磁盘上**的 vault 配置判断"托管是否正在进行"，避免内存与磁盘短暂不一致时误删明文
    diskVault: deps.readDiskVault(),
  };
}

/** 明文令牌文件路径（导出便于测试与文档定位）。 */
export function tokenFilePath() {
  const c = ctx();
  if (!c.ok) return null;
  return path.join(c.dataDir, TOKEN_FILE_NAME);
}

/* ------------------------------------------------------------------ 明文文件 */

function readFileToken() {
  const c = ctx();
  if (!c.ok) return { ok: false, error: c.error, code: c.code };
  const file = path.join(c.dataDir, TOKEN_FILE_NAME);
  if (!fs.existsSync(file)) return { ok: true, token: null, exists: false };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, token: parsed && typeof parsed === 'object' ? parsed : null, exists: true };
  } catch (err) {
    /*
     * **不要输出 err.message 之外的内容**；message 里只有 JSON 解析位置，不含令牌。
     * 被截断/写坏的令牌文件是真实会发生的（磁盘满、断电），必须报出来而不是当成"没有"。
     */
    return {
      ok: false,
      exists: true,
      code: 'GOOGLE_TOKEN_FILE_CORRUPT',
      error: `令牌文件无法解析（${path.join(c.dataDir, TOKEN_FILE_NAME)}）：${err.message}。` +
        '这通常是写入过程中断电/磁盘满造成的；请重新连接 Google 日历（或先把它删掉再连接）。',
    };
  }
}

/** 只用于"明文文件必须仍可被读取/使用"的兼容路径与测试。 */
export function readTokenFile() {
  return readFileToken();
}

/**
 * 把一段 JSON 文本写进明文令牌文件（0600）。
 * 只由「保存配置的搬运」与「迁回明文」使用；迁移前的读写一律走 `readToken()` / `writeToken()`。
 */
export function writeTokenFile(jsonText) {
  const parsed = safeParse(jsonText);
  if (!parsed) return { ok: false, error: '要写入的令牌内容不是合法 JSON（已放弃写入，原文件未改动）' };
  return writeFileToken(parsed);
}

/** 删掉明文令牌文件（迁回/迁移流程显式调用）。 */
export function removeTokenFile() {
  return removeFileToken();
}

/** 本地的小工具：解析失败返回 null（不抛）。 */
function safeParse(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeFileToken(token) {
  const c = ctx();
  if (!c.ok) return { ok: false, error: c.error, code: c.code };
  const file = path.join(c.dataDir, TOKEN_FILE_NAME);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    // 0600：降级到未加密文件时，权限是唯一的保护
    fs.writeFileSync(tmp, `${JSON.stringify(token, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      code: err.code || 'GOOGLE_TOKEN_FILE_WRITE_FAILED',
      error: `写入令牌文件失败（${file}）：${err.message}`,
    };
  }
}

/** 删掉明文文件（**只在保管库已确认可用之后**调用）。 */
function removeFileToken() {
  const c = ctx();
  if (!c.ok) return { ok: false, error: c.error, code: c.code };
  const file = path.join(c.dataDir, TOKEN_FILE_NAME);
  try {
    fs.rmSync(file, { force: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: err.code || 'GOOGLE_TOKEN_FILE_REMOVE_FAILED', error: `删除明文令牌文件失败（${file}）：${err.message}` };
  }
}

/* ------------------------------------------------------------------ 保管库 */

/** 从保管库取刷新令牌（值、错误、是否存在三种信息都要）。 */
function readVaultToken() {
  const c = ctx();
  if (!c.ok) return { mode: 'config', available: false, error: c.error, code: c.code };
  const mode = c.mode;
  if (mode === 'config' || !c.diskVault.configured) {
    return { mode, available: false, error: null, code: null };
  }
  const res = c.deps.readVault(mode, { dataDir: c.dataDir });
  if (!res.ok) {
    return {
      mode,
      backend: res.backend || c.resolved,
      available: true,
      error: res.error,
      code: res.code || 'GOOGLE_TOKEN_VAULT_READ_FAILED',
    };
  }
  const decoded = c.deps.decodeVault(res.data);
  if (!decoded.ok) {
    return { mode, backend: res.backend, available: true, error: decoded.error, code: 'GOOGLE_TOKEN_VAULT_DECODE_FAILED' };
  }
  return {
    mode,
    backend: res.backend,
    available: true,
    token: decoded.secrets?.googleToken || null,
    error: null,
    code: null,
  };
}

/** 写入保管库并**逐项读回比对**；比对不通过就当作写失败（上层因此绝不删明文）。 */
function writeVaultToken(refreshToken) {
  const c = ctx();
  if (!c.ok) return { ok: false, error: c.error, code: c.code };
  const { deps, mode, resolved, dataDir } = c;

  // 合并写入：保管库里还有邮箱授权码等其它密钥，绝不能整体覆盖
  const current = deps.readVault(mode, { dataDir });
  if (!current.ok) {
    return { ok: false, code: current.code || 'GOOGLE_TOKEN_VAULT_READ_FAILED', error: `读取保管库失败：${current.error}` };
  }
  const decoded = deps.decodeVault(current.data);
  if (!decoded.ok) return { ok: false, code: 'GOOGLE_TOKEN_VAULT_DECODE_FAILED', error: decoded.error };
  const secrets = { ...decoded.secrets, googleToken: refreshToken };

  const res = deps.writeVault(resolved, { dataDir }, deps.encodeVault(secrets));
  if (!res.ok) return { ok: false, code: res.code || 'GOOGLE_TOKEN_VAULT_WRITE_FAILED', error: res.error };

  // 读回比对：不比对就等于没验证，"搬过去打不开"是这里最糟的结果
  deps.resetVaultCache();
  const back = deps.readVault(resolved, { dataDir, force: true });
  if (!back.ok) return { ok: false, code: back.code || 'GOOGLE_TOKEN_VAULT_VERIFY_FAILED', error: back.error };
  const again = deps.decodeVault(back.data);
  if (!again.ok || again.secrets?.googleToken !== refreshToken) {
    return {
      ok: false,
      code: 'GOOGLE_TOKEN_VAULT_VERIFY_FAILED',
      error: `保管库读回内容与写入不一致（${again.ok ? 'googleToken' : again.error}）`,
    };
  }
  return { ok: true };
}

/**
 * 保管库是否"说了算"。
 *
 * 只有**迁移真的把令牌搬进保管库**（保管库里有值、且与磁盘明文一致，或磁盘明文已被清掉）
 * 才成立。仅仅是 `vault.mode != 'config'`（用户迁移了授权码，之后才连的 Google）
 * 不算——那种情况下明文文件才是权威，绝不能删。
 */
function vaultAuthoritative() {
  const vault = readVaultToken();
  const file = readFileToken();
  /*
   * 这里必须分清"保管库压根没启用"与"保管库出错了"：
   *   - 没启用 / 还没托管（`error === null`）→ 明文文件才是权威，正常返回，不算错误；
   *   - 真的读失败（`error` 有值）→ 上层必须看见（有明文还能用，但要留下警告）。
   * 曾经把两者合在一起判断，结果"没启用保管库"被当成"保管库读失败"报错——
   * 那会让所有没迁移过的用户一打开日历就看到一句吓人的错误。
   */
  if (vault.error) return { ok: false, vault, file, reason: 'vault-error' };
  if (!vault.available) return { ok: false, vault, file, reason: 'vault-disabled' };
  if (!vault.token) return { ok: false, vault, file, reason: 'empty' };
  if (!file.exists) return { ok: true, vault, file, reason: 'file-gone' };
  // 明文还有：只有"两边一致"才认为迁移已完成但文件没删干净；不一致就是没迁过（明文权威）
  if (file.ok && file.token) {
    const same = JSON.stringify(file.token) === JSON.stringify(tokenFromVault(vault.token));
    return { ok: same, vault, file, reason: same ? 'file-equal' : 'file-differs' };
  }
  return { ok: false, vault, file, reason: 'file-unusable' };
}

/** 保管库里存的是"令牌文件对象的 JSON 文本"；坏数据要能被识别而不是抛异常。 */
function tokenFromVault(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 保管库是否已经掌握这个令牌（= 迁移真的搬过它、且内容对得上）。
 * 「保存配置」与「迁移」都靠它决定"能不能动原处的明文"。
 */
export function tokenManagedByVault() {
  try {
    return vaultAuthoritative().ok;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ 对外接口 */

/**
 * 读取令牌。
 *
 * @returns {object|null} 令牌对象；"确实没有"返回 `null`
 * @throws {AppError} 保管库读失败 / 令牌文件损坏 —— 这两种都必须让调用方看见，
 *   否则界面会把"读不出来"说成"未连接"，用户只会以为自己掉线了。
 */
export function readToken() {
  const c = ctx();
  if (!c.ok) {
    throw new AppError(`无法读取 Google 令牌：${c.error}`, { code: c.code || 'GOOGLE_TOKEN_STORE_UNAVAILABLE', status: 500 });
  }
  const who = vaultAuthoritative();

  if (who.reason === 'vault-error') {
    /*
     * 明文还在 → 还能用，但**必须留下可见警告**：这正是"保管库静默失效"的现场。
     * 明文不在 → 直接抛，让界面说"需要重新授权（保管库读不出来）"，而不是"未连接"。
     */
    if (who.file.exists && who.file.ok) {
      log.warn(
        `Google 令牌保管库读取失败，本次退回 data/${TOKEN_FILE_NAME} 的明文令牌：${who.vault.error}。` +
          '（令牌没有丢；修好保管库前它仍是明文存放）',
      );
      return who.file.token;
    }
    throw new AppError(
      `Google 令牌读不出来：密钥保管库「${who.vault.backend || c.resolved}」读取失败（${who.vault.error}）。` +
        '日历暂时不可用；请到「设置 → 密钥存储」检查保管库，或重新连接 Google 日历。',
      { code: 'GOOGLE_TOKEN_VAULT_ERROR', status: 503, detail: { backend: who.vault.backend || c.resolved, vaultError: who.vault.error } },
    );
  }

  if (who.reason === 'file-unusable') {
    // 已经在用保管库、明文文件却坏了：不影响使用（保管库说了算），但要如实说一声
    if (who.ok) {
      log.warn(`明文令牌文件已损坏，当前使用保管库里的令牌：${who.file.error}`);
      return tokenFromVault(who.vault.token);
    }
    throw new AppError(`Google 令牌读不出来：${who.file.error}`, { code: who.file.code || 'GOOGLE_TOKEN_FILE_CORRUPT', status: 500 });
  }

  if (who.ok) {
    const token = tokenFromVault(who.vault.token);
    if (!token) {
      throw new AppError('Google 令牌读不出来：保管库里的令牌内容无法解析（需要重新连接 Google 日历）。', {
        code: 'GOOGLE_TOKEN_VAULT_DECODE_FAILED',
        status: 500,
      });
    }
    return token;
  }
  if (!who.file.ok) {
    throw new AppError(`Google 令牌读不出来：${who.file.error}`, { code: who.file.code || 'GOOGLE_TOKEN_FILE_CORRUPT', status: 500 });
  }
  return who.file.token;
}

/** 不抛异常的读法（给"状态展示"用；失败时给出可识别的错误码与原因）。 */
export function tryReadToken() {
  try {
    return { ok: true, token: readToken(), error: null, code: null };
  } catch (err) {
    return { ok: false, token: null, error: err?.message || String(err), code: err?.code || 'GOOGLE_TOKEN_READ_FAILED' };
  }
}

/**
 * 写入令牌（**先落袋再清明文**）。
 *
 * 授权码换来的新令牌（含 refresh_token）在三种情形下写入：
 *   ① 保管库里有值（已托管）→ 只写保管库并读回比对，顺手清掉残留的明文文件；
 *   ② 还没托管，但明文文件已存在 → 覆盖明文（本来就明文放着，不算新增泄漏）；
 *   ③ 还没托管，也没有明文（**全新授权**）→ 保管库可用就只进保管库，
 *      否则明文落盘（此时没有别的地方可放；这是"未纳入保管库"的既有行为）。
 *
 * 写失败时：**明文还在就照旧写明文**（绝不因为保管库坏了就让人连不上）；
 * **明文不在**（已托管、密文又写不进去）才抛错——因为那一刻没有第二个地方能放令牌了。
 */
export function writeToken(token) {
  if (!token || typeof token !== 'object') {
    throw new AppError('写入 Google 令牌的参数无效', { code: 'GOOGLE_TOKEN_INVALID', status: 500 });
  }
  const c = ctx();
  if (!c.ok) {
    throw new AppError(`无法写入 Google 令牌：${c.error}`, { code: c.code || 'GOOGLE_TOKEN_STORE_UNAVAILABLE', status: 500 });
  }
  const who = vaultAuthoritative();
  const payload = JSON.stringify(token);
  const current = readFileToken();
  const vaultUsable = c.mode !== 'config' && c.diskVault.configured;

  if (who.ok || vaultUsable) {
    const res = writeVaultToken(payload);
    if (res.ok) {
      // 已托管：明文留着是纯多余的暴露面（放在配置里跑保管库是同一条口径）
      if (who.file.exists) {
        const removed = removeFileToken();
        if (!removed.ok) {
          log.warn(`令牌已进保管库，但明文文件没能删除（${removed.error}）——请手动检查 data/${TOKEN_FILE_NAME}`);
        }
      }
      return token;
    }
    log.warn(`Google 令牌写不进保管库：${res.error}`);
    // 已经托管时没有退路：明文已清，再"静默失败"就等于丢令牌，只能如实报错
    if (who.ok) {
      throw new AppError(
        `Google 令牌无法保存：密钥保管库写入失败（${res.error}）。` +
          '刷新令牌可能仍然有效，请先修好保管库（「设置 → 密钥存储」）再重试；' +
          '实在不行就在那里点「迁回明文」后重新连接一次 Google 日历。',
        { code: 'GOOGLE_TOKEN_VAULT_WRITE_FAILED', status: 500, detail: { vaultError: res.error } },
      );
    }
  }

  const written = writeFileToken(token);
  if (!written.ok) throw new AppError(`Google 令牌无法保存：${written.error}`, { code: written.code, status: 500 });
  log.warn(
    `Google 令牌暂存在未加密的 data/${TOKEN_FILE_NAME}（保管库未启用或写入失败）。` +
      '到「设置 → 密钥存储」点「迁入」可以把令牌搬进系统保管库。',
  );
  return token;
}

/** 清空令牌（撤销授权后）：**先清保管库、成功再删明文**，避免保管库留着还能用的令牌。 */
export function clearToken() {
  const c = ctx();
  if (!c.ok) {
    log.warn(`清空 Google 令牌时无法确定保管库状态：${c.error}`);
    return { ok: false, error: c.error };
  }
  if (c.mode !== 'config' && c.diskVault.configured) {
    const current = c.deps.readVault(c.mode, { dataDir: c.dataDir });
    if (!current.ok) {
      log.warn(`清空 Google 令牌失败：保管库读不出来（${current.error}）；明文文件保持原样，请手动检查`);
      return { ok: false, error: current.error };
    }
    const decoded = c.deps.decodeVault(current.data);
    if (!decoded.ok) {
      log.warn(`清空 Google 令牌失败：保管库内容无法解析（${decoded.error}）；明文文件保持原样`);
      return { ok: false, error: decoded.error };
    }
    if (decoded.secrets?.googleToken) {
      const secrets = { ...decoded.secrets };
      delete secrets.googleToken;
      const written = c.deps.writeVault(c.resolved, { dataDir: c.dataDir }, c.deps.encodeVault(secrets));
      if (!written.ok) {
        log.warn(`清空 Google 令牌失败：保管库写入失败（${written.error}）；明文文件保持原样，请手动检查`);
        return { ok: false, error: written.error };
      }
      c.deps.resetVaultCache();
    }
  }
  const removed = removeFileToken();
  if (!removed.ok) {
    log.warn(`删除明文令牌文件失败：${removed.error}`);
    return { ok: false, error: removed.error };
  }
  return { ok: true };
}

/**
 * 令牌存放现状（给「设置 → 密钥存储」与诊断用）。
 *
 * 这个函数存在的意义就是"别让用户猜"：令牌在不在、在明文还是在保管库、加密没有、
 * 需不需要重新授权，必须能一句话回答。**不抛异常**（展示路径不该因为状态读取失败而崩）。
 */
export function tokenStatus() {
  const out = {
    file: TOKEN_FILE_NAME,
    /**
     * 令牌现在**放在哪**：'vault'（托管，含"托管了但读不出来"）/ 'file'（明文文件）/
     * 'none'（还没有令牌）/ 'unknown'（连存放位置都判断不了）。
     * 注意它是"存放口径"，不是"可用口径"——能不能用看 `error`。
     */
    location: null,
    set: false,
    encrypted: false,
    backend: null,
    /** 明文文件是否还在（迁移成功后应为 false） */
    plaintextFile: false,
    error: null,
    errorCode: null,
    /** 无法读取 → 只能重新授权，界面据此提示（而不是谎称"未连接"） */
    requiresReauth: false,
    email: null,
    savedAt: null,
    revokedAt: null,
  };
  const c = ctx();
  if (!c.ok) {
    out.location = 'unknown';
    out.error = c.error;
    out.errorCode = c.code || 'GOOGLE_TOKEN_STORE_UNAVAILABLE';
    out.requiresReauth = true;
    return out;
  }
  const fileExists = fs.existsSync(path.join(c.dataDir, TOKEN_FILE_NAME));
  out.plaintextFile = fileExists;
  /** 保管库是否**配了**（不是"能不能读通"）：配了就说明令牌按约定托管在它那里 */
  const vaultConfigured = c.mode !== 'config' && c.diskVault.configured;

  const read = tryReadToken();
  if (read.ok && read.token) {
    const who = vaultAuthoritative();
    out.location = who.ok ? 'vault' : 'file';
    out.set = true;
    const backendList = c.deps.listBackends();
    const backend = backendList.find((b) => b.id === c.resolved) || null;
    out.backend = who.ok ? who.vault.backend || c.resolved : c.resolved;
    out.encrypted = who.ok ? !!backend?.encrypted : false;
    out.email = read.token.email || null;
    out.savedAt = read.token.savedAt || null;
    out.revokedAt = read.token.revokedAt || null;
    // 按约定托管在保管库、却退回明文在读：这是"托管没生效"的现场，必须说明白
    if (!who.ok && vaultConfigured && who.reason === 'empty') {
      out.note = '保管库里还没有这个令牌（它现在是明文存放）；在「密钥存储」点「迁入」即可搬进去';
    }
    if (!who.ok && vaultConfigured && who.reason === 'vault-error' && fileExists) {
      out.note = `保管库读不出来，本次退回 data/${TOKEN_FILE_NAME} 的明文令牌（令牌没有丢，但它现在是明文存放）`;
    }
    // 读得出来、但"文件坏了 + 没托管"的组合上面已经覆盖；这里只需保证文件损坏也不会误报
    return out;
  }

  out.error = read.error;
  out.errorCode = read.code;
  if (vaultConfigured && !fileExists) {
    /*
     * 保管库配了、明文文件又不在 → 令牌**按约定在保管库里**，只是这次读不出来。
     * 位置必须如实报 'vault'（而不是含糊成"未设置"），同时 `requiresReauth` 为真，
     * 界面据此显示"需要重新授权/修保管库"，而不是"从未连接"。
     */
    out.location = 'vault';
    out.requiresReauth = true;
    out.errorCode = read.code || 'GOOGLE_TOKEN_READ_FAILED';
    out.backend = c.resolved;
    out.encrypted = false;
  } else if (fileExists) {
    out.location = 'file';
    out.requiresReauth = true;
    out.errorCode = read.code || 'GOOGLE_TOKEN_READ_FAILED';
    out.error = read.error || `令牌存在但读不出来（data/${TOKEN_FILE_NAME}）`;
  } else {
    out.location = 'none';
  }
  return out;
}
