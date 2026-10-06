/**
 * 备份与恢复。
 *
 * ## 为什么需要它
 *
 * 交付给别人之后，最常见的灾难不是 bug，而是**数据没了**：换电脑、重装系统、
 * 误点「重置本地数据」、磁盘坏了。而 `data/` 里是**不可再生**的东西——
 * 几百封邮件的分析结论、草稿、简报、操作台账。
 *
 * ## 两条刻意的设计原则
 *
 * 1. **默认不含密钥**。导出包里默认抹掉邮箱授权码、大模型 API Key、Google 令牌与 `.env`；
 *    需要连密钥一起搬的人才显式打开。凭据散落在压缩包里是最容易出事的一类泄漏。
 * 2. **导入不清空你现在的密钥**。备份若不含密钥，导入时对应字段是空的——
 *    这时**保留当前配置里的值**，而不是用空值覆盖。否则"只想恢复数据"会顺手把
 *    正在用的授权码抹掉，用户只能一脸茫然地去重配。
 *
 * 另外：导入前会自动把当前数据存一份到 `data/backups/`，所以**导入是可后悔的**。
 */

import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME, APP_VERSION, AppError, log } from './util.js';
import { getConfig, getPaths, loadConfig } from '../config/index.js';
import { resetTransportPools } from '../mail/smtp.js';
import { STATE_VERSION } from '../store/state.js';
import { createZip, isSafeEntryName, readZip } from './zip.js';

export const BACKUP_FORMAT = `${APP_NAME}-backup`;
export const BACKUP_VERSION = 1;

/** 需要抹掉的密钥字段（与设置页掩码用的是同一套语义）。 */
const SECRET_FIELDS = ['authPass', 'apiKey', 'authToken', 'clientSecret'];

/** 导入时允许落盘的文件（**白名单**，防止被塞入任意文件）。 */
const RESTORABLE = [
  /^state\.json$/,
  /^config\.json$/,
  /^\.env$/,
  /^google-token\.json$/,
  /^audit\.jsonl$/,
  /^reports\/[\w.\- 一-龥]+\.md$/,
  /^raw\/[\w.\-]+\.eml$/,
];

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 递归抹掉密钥字段，返回新对象（不改原对象）。 */
export function redactSecrets(node) {
  if (Array.isArray(node)) return node.map(redactSecrets);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (SECRET_FIELDS.includes(k)) {
      out[k] = '';
      continue;
    }
    out[k] = redactSecrets(v);
  }
  return out;
}

/** 统计配置里**确实有值**的密钥字段，用于在导入后提示"哪些还得重填"。 */
function missingSecretLabels(config) {
  const labels = [];
  for (const inst of config?.instances || []) {
    if (!inst.imap?.authPass) labels.push(`邮箱授权码（${inst.label || inst.id}）`);
    if (!inst.smtp?.authPass) labels.push(`发信授权码（${inst.label || inst.id}）`);
  }
  if (!config?.llm?.apiKey) labels.push('大模型 API Key');
  if (config?.calendar?.google?.clientSecret === '') labels.push('Google Client Secret');
  return labels;
}

/** 备份里内嵌的说明文件：用户双击打开压缩包时先看到它。 */
function readmeText({ includeSecrets, includeRaw, manifest }) {
  return [
    `${APP_NAME} 备份包`,
    '',
    `生成时间：${manifest.createdAt}`,
    `程序版本：${manifest.appVersion}`,
    `数据目录：${manifest.dataDir}`,
    '',
    '【里面有什么】',
    '- manifest.json   本次备份的清单与统计（程序导入时会校验它）',
    '- state.json      分析与草稿、待办状态、简报索引（**最重要**）',
    '- config.json     你的配置',
    '- audit.jsonl     操作台账',
    '- reports/        历次简报原文',
    includeRaw ? '- raw/            邮件原文归档（含附件）' : '- （未包含邮件原文；如需一并备份，导出时勾选"包含邮件原文"）',
    includeSecrets ? '- .env / google-token.json  凭据与令牌（**含密钥，请妥善保管**）' : '- （未包含任何密钥：' + missingSecretLabels(manifest.__plainConfig || {}).slice(0, 3).join('、') + '）',
    '',
    '【怎么恢复】',
    '在程序的「设置 → 备份与恢复」里选择这个文件导入即可；导入前程序会自动把当前数据再备份一份。',
    '',
    includeSecrets ? '⚠️ 本包含有密钥，请勿通过聊天工具/邮件发送给任何人。' : '✅ 本包不含密钥（授权码、API Key、Google 令牌），可以安全地放到网盘。',
    includeRaw ? '⚠️ 本包含有邮件原文（可能含个人隐私），请自行决定存放位置。' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * 生成备份包。
 *
 * @param {object} options { includeSecrets, includeRaw, now }
 * @returns {{ buffer: Buffer, manifest: object, filename: string }}
 */
export function buildBackup({ includeSecrets = false, includeRaw = false, now = new Date() } = {}) {
  const p = getPaths();
  const config = getConfig();
  const entries = [];
  const counts = { reports: 0, raw: 0 };
  const warnings = [];

  // 1) 状态文件（最重要，缺了就直接报错，不能给一个"看起来成功"的空备份）
  if (!fs.existsSync(p.stateFile)) {
    throw new AppError('还没有可备份的数据（state.json 不存在）。先跑一次分析再备份。', {
      code: 'BACKUP_NO_DATA',
      status: 400,
    });
  }
  const stateBuf = fs.readFileSync(p.stateFile);
  entries.push({ name: 'state.json', data: stateBuf });

  // 2) 配置（按开关决定是否抹掉密钥）
  if (fs.existsSync(p.configFile)) {
    const raw = fs.readFileSync(p.configFile, 'utf8');
    let out = raw;
    if (!includeSecrets) {
      try {
        out = `${JSON.stringify(redactSecrets(JSON.parse(raw)), null, 2)}\n`;
      } catch (err) {
        warnings.push(`config.json 解析失败，已按原文备份（含密钥）：${err.message}`);
        out = raw;
      }
    }
    entries.push({ name: 'config.json', data: out });
  }

  // 3) 台账
  const auditFile = path.join(p.dataDir, 'audit.jsonl');
  if (fs.existsSync(auditFile)) entries.push({ name: 'audit.jsonl', data: fs.readFileSync(auditFile) });

  // 4) 简报
  try {
    for (const name of fs.readdirSync(p.reportsDir)) {
      if (!name.endsWith('.md')) continue;
      entries.push({ name: `reports/${name}`, data: fs.readFileSync(path.join(p.reportsDir, name)) });
      counts.reports += 1;
    }
  } catch {
    /* 没有简报目录是正常的 */
  }

  // 5) 邮件原文（体积大，默认不含）
  if (includeRaw) {
    try {
      for (const name of fs.readdirSync(p.rawDir)) {
        if (!name.endsWith('.eml')) continue;
        entries.push({ name: `raw/${name}`, data: fs.readFileSync(path.join(p.rawDir, name)) });
        counts.raw += 1;
      }
    } catch {
      /* 忽略 */
    }
  }

  // 6) 凭据（只在显式要求时）
  if (includeSecrets) {
    const envFile = path.join(p.rootDir, '.env');
    if (fs.existsSync(envFile)) entries.push({ name: '.env', data: fs.readFileSync(envFile) });
    const tokenFile = path.join(p.dataDir, 'google-token.json');
    if (fs.existsSync(tokenFile)) entries.push({ name: 'google-token.json', data: fs.readFileSync(tokenFile) });
  }

  let schemaVersion = null;
  try {
    schemaVersion = JSON.parse(stateBuf.toString('utf8')).version ?? null;
  } catch {
    warnings.push('state.json 解析失败（已按原文备份）');
  }

  const manifest = {
    format: BACKUP_FORMAT,
    backupVersion: BACKUP_VERSION,
    appVersion: APP_VERSION,
    createdAt: now.toISOString(),
    dataDir: p.dataDir,
    /** 数据结构的版本（导入时用于提示"会自动迁移"） */
    schemaVersion,
    includeSecrets: !!includeSecrets,
    includeRaw: !!includeRaw,
    counts: {
      reports: counts.reports,
      raw: counts.raw,
      analyses: (() => {
        try {
          return Object.keys(JSON.parse(stateBuf.toString('utf8')).analyses || {}).length;
        } catch {
          return null;
        }
      })(),
      drafts: (() => {
        try {
          return (JSON.parse(stateBuf.toString('utf8')).drafts || []).length;
        } catch {
          return null;
        }
      })(),
    },
    /** 备份里**没有**的东西：让用户一眼看到代价 */
    excluded: [
      ...(includeSecrets ? [] : ['密钥（邮箱授权码 / 大模型 API Key / Google 令牌 / .env）']),
      ...(includeRaw ? [] : ['邮件原文归档（data/raw）']),
      '草稿附件文件（data/attachments，发送成功后本来就会被清理）',
    ],
    warnings,
  };

  // README 写在 manifest 之前，用户解压后先看到它
  const manifestForReadme = { ...manifest, __plainConfig: config };
  entries.unshift({ name: 'README.txt', data: readmeText({ includeSecrets, includeRaw, manifest: manifestForReadme }) });
  entries.splice(1, 0, { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` });

  const stamp = manifest.createdAt.replace(/[:.]/g, '-').slice(0, 19);
  return {
    buffer: createZip(entries, { compress: true }),
    manifest,
    filename: `${APP_NAME}-backup-${stamp}.zip`,
    entries: entries.map((e) => ({ name: e.name, size: Buffer.byteLength(e.data) })),
  };
}

/** 读取备份包并校验（不落盘）。 */
export function inspectBackup(buffer) {
  const files = readZip(buffer);
  const manifestEntry = files.find((f) => f.name === 'manifest.json');
  if (!manifestEntry) {
    throw new AppError('这不像是本程序导出的备份包（缺少 manifest.json）', {
      code: 'BACKUP_BAD_FORMAT',
      status: 400,
    });
  }
  let manifest = null;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (err) {
    throw new AppError(`备份包的 manifest.json 解析失败：${err.message}`, { code: 'BACKUP_BAD_MANIFEST', status: 400 });
  }
  if (manifest.format !== BACKUP_FORMAT) {
    throw new AppError(`备份包格式不认识（${manifest.format || '未知'}），本程序期望 ${BACKUP_FORMAT}`, {
      code: 'BACKUP_BAD_FORMAT',
      status: 400,
    });
  }
  const restorable = files.filter((f) => RESTORABLE.some((re) => re.test(f.name)));
  const skipped = files
    .filter((f) => !RESTORABLE.some((re) => re.test(f.name)) && f.name !== 'manifest.json' && f.name !== 'README.txt')
    .map((f) => f.name);
  /*
   * 「导入后还需要你补填的密钥」= 备份里没有 **且** 当前这台机器也没有的项。
   *
   * 只算"备份里没有"是错的：导入时会**保留当前配置里已有的密钥**（见 mergeSecrets），
   * 所以本机已经填好的授权码并不会因为导入了"不含密钥的备份"而失效。
   */
  let needsSecrets = [];
  if (!manifest.includeSecrets) {
    try {
      const cfgEntry = files.find((f) => f.name === 'config.json');
      const inBackup = cfgEntry ? missingSecretLabels(JSON.parse(cfgEntry.data.toString('utf8'))) : [];
      const inCurrent = new Set(missingSecretLabels(getConfig()));
      needsSecrets = inBackup.filter((label) => inCurrent.has(label));
    } catch {
      needsSecrets = [];
    }
  }
  return {
    manifest,
    files: files.map((f) => ({ name: f.name, size: f.size })),
    restorable: restorable.map((f) => f.name),
    skipped,
    totals: { entries: files.length, bytes: buffer.length },
    needsSecrets,
    /** 数据结构版本比当前低时会自动迁移 */
    willMigrate: typeof manifest.schemaVersion === 'number' && manifest.schemaVersion < STATE_VERSION,
  };
}

/**
 * 导入备份。
 *
 * 顺序刻意如此：**先给当前数据留一份退路**，再动任何文件。
 *
 * @param {Buffer} buffer
 * @param {object} options { confirm, now }
 */
export function importBackup(buffer, { confirm = false, now = new Date() } = {}) {
  if (!confirm) {
    throw new AppError('导入会覆盖当前数据：请传入 confirm=true。', { code: 'CONFIRM_REQUIRED', status: 428 });
  }
  const p = getPaths();
  const info = inspectBackup(buffer);
  const files = readZip(buffer);

  // 1) 退路：把**当前**数据完整备份一份（含密钥，因为它只留在本机）
  let safety = null;
  try {
    const current = buildBackup({ includeSecrets: true, includeRaw: false, now });
    const dir = path.join(p.dataDir, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `pre-import-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`);
    fs.writeFileSync(file, current.buffer);
    safety = file;
    log.info(`导入前已自动备份当前数据：${file}`);
  } catch (err) {
    // 没有可备份的数据（例如全新安装）不算错误；但如果是因为写不进去，要说清楚
    log.warn(`导入前的自动备份未完成（继续导入）：${err?.message || err}`);
  }

  // 2) 落盘（白名单 + 安全名 + 保留现有密钥）
  const restored = [];
  const skipped = [...info.skipped];
  /*
   * 合并密钥的来源必须是**磁盘上的 config.json**，不能是 `getConfig()`。
   *
   * 因为 `getConfig()` 已被 `.env` 覆盖——用它合并会把 `.env` 里的授权码 / API Key
   * **抄进 config.json**，正好和文档里"密钥只放 .env，别写进 config.json"的建议相反：
   * 一次导入就把密钥复制成了两份，而且其中一份从此跟着备份/同步到处跑。
   * 磁盘上没有的就留空：`.env` 里的值在运行时仍然生效，什么都不会丢。
   */
  const currentOnDisk = readConfigOnDisk();
  for (const f of files) {
    if (!RESTORABLE.some((re) => re.test(f.name))) continue;
    if (!isSafeEntryName(f.name)) {
      skipped.push(f.name);
      continue;
    }
    let data = f.data;
    if (f.name === 'config.json') {
      try {
        const incoming = JSON.parse(data.toString('utf8'));
        const merged = mergeSecrets(incoming, currentOnDisk);
        data = Buffer.from(`${JSON.stringify(merged, null, 2)}\n`, 'utf8');
      } catch (err) {
        log.warn(`导入的 config.json 无法解析，将按原文写入：${err.message}`);
      }
    }
    const target = path.join(p.dataDir, f.name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    restored.push(f.name);
  }

  // 3) 让内存里的缓存失效（否则界面上还是旧数据）
  loadConfig({ force: true });
  // 凭据可能变了，连接池必须丢弃（否则还在用旧授权码）
  resetTransportPools();

  return { ok: true, restored, skipped, safetyBackup: safety, manifest: info.manifest };
}

/** 读取**磁盘上**的 config.json（不含 .env 覆盖），用于导入时的密钥合并。 */
function readConfigOnDisk() {
  try {
    const file = getPaths().configFile;
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    log.warn(`读取磁盘配置失败（导入时将无法保留原有密钥）：${err?.message || err}`);
    return {};
  }
}

/** 用当前配置补齐备份里为空的密钥字段。 */
export function mergeSecrets(incoming, current) {
  const out = { ...incoming };
  // 顶层与实例内的密钥
  out.llm = { ...(incoming.llm || {}) };
  if (!out.llm.apiKey) out.llm.apiKey = current?.llm?.apiKey || '';
  out.web = { ...(incoming.web || {}) };
  if (!out.web.authToken) out.web.authToken = current?.web?.authToken || '';
  out.calendar = { ...(incoming.calendar || {}) };
  out.calendar.google = { ...(incoming.calendar.google || {}) };
  if (!out.calendar.google.clientSecret) out.calendar.google.clientSecret = current?.calendar?.google?.clientSecret || '';

  const curInstances = new Map((current?.instances || []).map((i) => [i.id, i]));
  out.instances = (incoming.instances || []).map((inst) => {
    const cur = curInstances.get(inst.id) || {};
    return {
      ...inst,
      imap: { ...(inst.imap || {}), authPass: inst.imap?.authPass || cur.imap?.authPass || '' },
      smtp: { ...(inst.smtp || {}), authPass: inst.smtp?.authPass || cur.smtp?.authPass || '' },
    };
  });
  return out;
}

/** 已生成过的备份包列表（导入前的自动备份，供用户回滚）。 */
export function listSafetyBackups() {
  const p = getPaths();
  const dir = path.join(p.dataDir, 'backups');
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.zip'))
      .map((n) => {
        const st = fs.statSync(path.join(dir, n));
        return { name: n, size: st.size, at: st.mtime.toISOString() };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch {
    return [];
  }
}
