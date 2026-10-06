/**
 * 操作审计：把"改了外部系统"的动作**追加**到 `data/audit.jsonl`。
 *
 * 为什么需要它：控制台日志关窗即失，而"创建了哪些日程、发了哪些邮件、删了什么"
 * 是改了 Google 日历 / 邮箱的写操作。出问题（重复日程、误发、误删）时，
 * 必须能回查"什么时候、对什么、做了什么、结果如何"。
 *
 * ## 为什么用追加式 JSONL 而不是塞进 state.json
 *
 *   - `state.json` 每次变更都要**整体重写并解析**，审计记录是只增不改的台账，
 *     放进去会让每次写状态都变慢；
 *   - JSONL 一行一条，可以直接 grep / 用 Excel 打开 / 追加不会破坏已有内容；
 *   - 用户选择"永久保留"，因此不做轮转——但也不该拖累主状态文件。
 *
 * 隐私：按用户要求**记录具体标题与主题**（可查性优先）。这些是明文存在本地文件里的，
 * 运行与配置文档里已就此写明。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config/index.js';
import { log } from '../lib/util.js';

/** 动作清单（写操作）。新增动作时在这里登记，界面按它分组展示。 */
export const AUDIT_ACTIONS = {
  'draft.send': { label: '发送回复邮件', group: '邮件' },
  'draft.sync': { label: '同步草稿到邮箱', group: '邮件' },
  'draft.delete': { label: '删除草稿', group: '邮件' },
  'draft.retract': { label: '撤回服务器草稿副本', group: '邮件' },
  'calendar.event.create': { label: '创建日程', group: '日历' },
  'calendar.event.update': { label: '修改日程', group: '日历' },
  'calendar.event.delete': { label: '删除日程', group: '日历' },
  'calendar.draft.cleanup': { label: '清理已发送草稿的附件', group: '邮件' },
  /** 删除原文归档是不可逆的数据损失，值得留痕："我的原文是什么时候没的" */
  'storage.cleanup': { label: '清理归档原文', group: '数据' },
  /** 导出/导入备份：前者涉及"数据（可能含密钥）被搬走"，后者会覆盖数据 */
  'backup.export': { label: '导出备份', group: '数据' },
  'backup.import': { label: '导入备份', group: '数据' },
  /** 密钥搬家：把明文搬进系统保管库、或搬回明文 */
  'secrets.migrate': { label: '密钥迁入保管库', group: '数据' },
  'secrets.revert': { label: '密钥迁回明文', group: '数据' },
  /**
   * 认证相关。
   *
   * 失败登录也要记：它既是排查"我为什么进不去"的依据，
   * 也是"有人在试我的令牌"的唯一线索。
   */
  'auth.login': { label: '登录成功', group: '安全' },
  'auth.logout': { label: '登出', group: '安全' },
  'auth.fail': { label: '登录失败', group: '安全' },
  'security.token': { label: '修改访问令牌', group: '安全' },
  /** 跟催：扫描与状态变更 */
  'followup.scan': { label: '扫描跟催', group: '跟催' },
  'followup.status': { label: '跟催状态变更', group: '跟催' },
  /** 项目重命名/合并：会改写历史记录的标签 */
  'project.rename': { label: '项目重命名或合并', group: '跟催' },
};

function auditPath() {
  return path.join(getPaths().dataDir, 'audit.jsonl');
}

/** 界面与导出用：审计文件的位置（供用户自己去打开/备份）。 */
export function auditFile() {
  return auditPath();
}

/**
 * 追加一条审计记录。
 *
 * **绝不抛错**：审计失败不能影响主流程（发邮件、写日程都已完成，
 * 不能因为记不上台账就让用户看到失败）。失败时只打一条 warn。
 *
 * @param {string} action AUDIT_ACTIONS 里的键
 * @param {object} detail { target, result, source, ok, error, extra }
 * @returns {object|null} 写入的记录
 */
export function appendAudit(action, detail = {}) {
  /*
   * 允许调用方指定 `at`：补录历史台账时要用**事件当时的创建时间**，
   * 而不是"补录这一刻"，否则台账里的时间线是错的。
   * 非法时间就退回当前时间，绝不因此写坏记录。
   */
  const atInput = detail.at ? new Date(detail.at) : null;
  const at = atInput && !Number.isNaN(atInput.getTime()) ? atInput.toISOString() : new Date().toISOString();
  const record = {
    at,
    action,
    label: AUDIT_ACTIONS[action]?.label || action,
    group: AUDIT_ACTIONS[action]?.group || '其他',
    /** 目标：日程标题 / 邮件主题 / 收件人 等（用户要求记具体内容） */
    target: detail.target ? String(detail.target).slice(0, 300) : '',
    /** 来源：对话建日程 / 从邮件生成 / 界面操作 / 接口 */
    source: detail.source || '',
    ok: detail.ok !== false,
    error: detail.error ? String(detail.error).slice(0, 500) : '',
    extra: detail.extra && typeof detail.extra === 'object' ? detail.extra : undefined,
  };
  try {
    const file = auditPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return record;
  } catch (err) {
    log.warn(`写入操作审计失败（不影响本次操作）：${err?.message || err}`);
    return null;
  }
}

/**
 * 读取审计记录（新的在前）。
 *
 * 永久保留意味着文件可能很大，所以这里**从文件尾部往前读**，
 * 读够 limit 条就停，而不是把整个文件读进内存再截断。
 *
 * @param {object} options { limit, action, group, q, since, ok }
 */
export function listAudit({ limit = 200, action, group, q, since, ok } = {}) {
  const file = auditPath();
  if (!fs.existsSync(file)) return { items: [], total: 0, file, truncated: false };

  const max = Math.max(1, Math.min(2000, Number(limit) || 200));
  const keyword = String(q || '').trim().toLowerCase();
  const sinceMs = since ? new Date(since).getTime() : null;
  const wantOk = typeof ok === 'boolean' ? ok : null;

  const match = (r) => {
    if (action && r.action !== action) return false;
    if (group && r.group !== group) return false;
    if (wantOk !== null && !!r.ok !== wantOk) return false;
    if (sinceMs && new Date(r.at).getTime() < sinceMs) return false;
    if (keyword) {
      /*
       * 关键词要能搜到**收件人、附件名、来源邮件主题**这些 extra 里的字段——
       * "这封信发给谁了""这个附件发出去没有"是最常见的追问。
       */
      const hay = `${r.target || ''} ${r.label || ''} ${r.source || ''} ${r.error || ''} ${
        r.extra ? JSON.stringify(r.extra) : ''
      }`.toLowerCase();
      if (!hay.includes(keyword)) return false;
    }
    return true;
  };

  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    log.warn(`读取操作审计失败：${err?.message || err}`);
    return { items: [], total: 0, file, truncated: false };
  }

  const lines = raw.split('\n').filter((l) => l.trim());
  const items = [];
  let matchedTotal = 0;
  // 从尾部往前扫：只看够 max 条匹配就停，避免大文件全量解析
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let rec = null;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      continue; // 跳过写坏的行，不让一行毁掉整个列表
    }
    if (!match(rec)) continue;
    matchedTotal += 1;
    if (items.length < max) items.push(rec);
  }
  return {
    items,
    /** 命中的总条数（可能大于返回条数） */
    total: matchedTotal,
    file,
    /** 是否因为 limit 截断（界面据此提示"只显示最近 N 条"） */
    truncated: matchedTotal > items.length,
  };
}

/** 统计各动作的条数（界面上做概览用）。 */
export function auditStats() {
  const file = auditPath();
  if (!fs.existsSync(file)) return { total: 0, byGroup: {}, byAction: {}, lastAt: null };
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { total: 0, byGroup: {}, byAction: {}, lastAt: null };
  }
  const byGroup = {};
  const byAction = {};
  let total = 0;
  let lastAt = null;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    total += 1;
    const g = rec.group || '其他';
    byGroup[g] = (byGroup[g] || 0) + 1;
    byAction[rec.action] = (byAction[rec.action] || 0) + 1;
    if (rec.at && (!lastAt || rec.at > lastAt)) lastAt = rec.at;
  }
  return { total, byGroup, byAction, lastAt };
}
