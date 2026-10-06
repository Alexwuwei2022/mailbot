/**
 * 本地状态存储（data/state.json）+ 原文归档（data/raw/）+ 报告文件（data/reports/）。
 *
 * 原文归档让「重新起草 / 查看正文」不必反复回连 IMAP；state.json 只存结论与草稿。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getConfig, getPaths } from '../config/index.js';
import { AppError, fnv1a, log, newId, safeJson } from '../lib/util.js';

/**
 * 状态结构版本。
 *
 * v1 → v2：新增 `tasks`（把"需要你处理"变成可闭环的待办）。
 *
 * 有版本号就必须有**迁移函数**，否则升级后老用户的数据要么缺字段、
 * 要么被静默丢掉。`migrateState` 负责把任意历史版本补齐到当前版本。
 */
export const STATE_VERSION = 4;
/** 兼容旧测试里的名字；生产代码请直接用 STATE_VERSION。 */
export const STATE_VERSION_FOR_TEST = STATE_VERSION;
/** 分析记录上限的默认值（实际以 `retention.maxAnalyses` 为准，见 maxAnalysesLimit） */
const MAX_ANALYSES_DEFAULT = 3000;
const MAX_DRAFTS = 1000;
const MAX_RUNS = 100;

let state = null;
let statePath = null;

function emptyState() {
  return {
    version: STATE_VERSION,
    updatedAt: new Date().toISOString(),
    runs: [],
    analyses: {},
    drafts: [],
    reports: [],
    /** 日历数字人的对话会话 */
    calendar: { sessions: [] },
    /** 待办闭环：`folder:uid` → { status, snoozeUntil, note, updatedAt } */
    tasks: {},
    /**
     * 跟催：id → { kind: 'mine'|'waiting', title, dueAt, counterparty, status, ... }
     * 由扫描产生（逻辑见 server/followup.js），状态语义与 tasks 一致。
     */
    followUps: {},
    /** 项目登记表：key → { key, name, aliases[], createdAt }（合并后旧名进 aliases） */
    projects: {},
  };
}

/**
 * 把读进来的状态补齐到当前版本（幂等，可反复调用）。
 *
 * 原则：**只补不改**。老数据里的字段一个都不动，缺什么补什么；
 * 认不出的版本号也照常补字段（宁可多补，也不要因为版本号对不上就让用户打不开）。
 */
export function migrateState(s) {
  const from = Number(s.version) || 1;
  const notes = [];

  if (from < 2) {
    if (!s.tasks || typeof s.tasks !== 'object' || Array.isArray(s.tasks)) s.tasks = {};
    notes.push('v1→v2：新增 tasks（待办状态）');
  }

  if (from < 4) {
    /*
     * v3→v4：新增 projects（项目登记表，用于时间线的重命名/合并）。
     * 只补空表，不预填任何内容——项目清单是从分析记录里的 project 标签推导出来的。
     */
    if (!s.projects || typeof s.projects !== 'object' || Array.isArray(s.projects)) s.projects = {};
    notes.push('v3→v4：新增 projects（项目登记表）');
  }

  if (from < 3) {
    /*
     * v2→v3：新增 followUps（跟催：我承诺了什么 / 等谁回复）。
     * 只补空表，不预填任何内容——第一次扫描才会产生记录。
     */
    if (!s.followUps || typeof s.followUps !== 'object' || Array.isArray(s.followUps)) s.followUps = {};
  if (!s.projects || typeof s.projects !== 'object' || Array.isArray(s.projects)) s.projects = {};
    notes.push('v2→v3：新增 followUps（跟催跟踪）');
  }

  // 结构兜底（与版本无关，防止手改/崩溃后的畸形数据把界面弄崩）
  if (!Array.isArray(s.drafts)) s.drafts = [];
  if (!Array.isArray(s.runs)) s.runs = [];
  if (!Array.isArray(s.reports)) s.reports = [];
  if (!s.analyses || typeof s.analyses !== 'object') s.analyses = {};
  if (!s.calendar || typeof s.calendar !== 'object') s.calendar = { sessions: [] };
  if (!Array.isArray(s.calendar.sessions)) s.calendar.sessions = [];
  if (!s.tasks || typeof s.tasks !== 'object' || Array.isArray(s.tasks)) s.tasks = {};
  if (!s.schedule || typeof s.schedule !== 'object' || Array.isArray(s.schedule)) s.schedule = {};
  if (!s.followUps || typeof s.followUps !== 'object' || Array.isArray(s.followUps)) s.followUps = {};
  if (!s.projects || typeof s.projects !== 'object' || Array.isArray(s.projects)) s.projects = {};
  // 会话可能因崩溃残留 pending 字段，统一兜底
  for (const session of s.calendar.sessions) {
    if (!Array.isArray(session.messages)) session.messages = [];
  }

  s.version = STATE_VERSION;
  return { from, to: STATE_VERSION, notes };
}

export function loadState({ force = false } = {}) {
  const p = getPaths();
  if (state && statePath === p.stateFile && !force) return state;
  fs.mkdirSync(p.dataDir, { recursive: true });
  if (fs.existsSync(p.stateFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p.stateFile, 'utf8'));
      state = { ...emptyState(), ...parsed };
      const mig = migrateState(state);
      if (mig.from !== mig.to) log.info(`状态结构已从 v${mig.from} 迁移到 v${mig.to}：${mig.notes.join('；')}`);
    } catch (err) {
      log.warn(`state.json 解析失败，已备份并重建：${err.message}`);
      try {
        fs.renameSync(p.stateFile, `${p.stateFile}.broken-${Date.now()}`);
      } catch {
        /* ignore */
      }
      state = emptyState();
    }
  } else {
    state = emptyState();
  }
  statePath = p.stateFile;
  return state;
}

export function getState() {
  return state || loadState();
}

/** 原子写盘并做容量收敛。 */
export function persistState({ prune = true } = {}) {
  const p = getPaths();
  const s = getState();
  s.updatedAt = new Date().toISOString();
  if (prune) {
    const entries = Object.entries(s.analyses);
    /*
     * 上限**可配置**（`retention.maxAnalyses`，默认 3000）。
     * 旧版本写死 3000：用户既不知道会发生这件事，也没法调。
     */
    const maxAnalyses = maxAnalysesLimit();
    if (entries.length > maxAnalyses) {
      entries
        .sort((a, b) => new Date(a[1]?.analyzedAt || 0) - new Date(b[1]?.analyzedAt || 0))
        .slice(0, entries.length - maxAnalyses)
        .forEach(([key]) => delete s.analyses[key]);
    }
    if (s.drafts.length > MAX_DRAFTS) {
      const keep = [...s.drafts]
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .slice(0, MAX_DRAFTS);
      const keepIds = new Set(keep.map((d) => d.id));
      s.drafts = s.drafts.filter((d) => keepIds.has(d.id));
    }
    if (s.runs.length > MAX_RUNS) s.runs = s.runs.slice(-MAX_RUNS);
    /*
     * 待办状态跟着分析记录走：分析记录被收敛掉之后，它对一条已经不存在的邮件
     * 的"已处理/已忽略"标记就没有意义了，留着只会让 state.json 无限增长。
     */
    for (const key of Object.keys(s.tasks || {})) {
      if (!s.analyses[key]) delete s.tasks[key];
    }
  }
  fs.mkdirSync(path.dirname(p.stateFile), { recursive: true });
  const tmp = `${p.stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, p.stateFile);
  return s;
}

export function resetStateCache() {
  state = null;
  statePath = null;
}

/* ------------------------------------------------------------ 定时任务状态 */

/**
 * 定时分析的运行状态。
 *
 * `lastSlot`（形如 `2026-10-04 08:30`）是**幂等键**：进程重启、tick 抖动、
 * 手动改系统时间，都不会让同一时刻跑两次分析。
 */
export function setScheduleState(patch = {}) {
  const s = getState();
  s.schedule = { ...(s.schedule || {}), ...patch };
  persistState();
  return s.schedule;
}

/* ------------------------------------------------------------ 待办状态 */

/**
 * 待办状态（"需要你处理"的闭环）。
 *
 * 键与 `analysisKey` 一致（`folder:uid`），所以不需要在任务里再存一份邮件信息，
 * 也永远不会和邮件"对不上号"。
 *
 * 状态语义：
 *   - `open`（默认，没有记录就是 open）：还在列表里等你处理；
 *   - `done`：已处理 → 移出列表，可在"已处理"里翻回去恢复；
 *   - `snoozed`：稍后提醒 → 到 `snoozeUntil` 之前隐藏，**到期自动回到列表**；
 *   - `ignored`：忽略 → 永久移出列表（可在"已忽略"里恢复）。
 */
export const TASK_STATUSES = ['open', 'done', 'snoozed', 'ignored'];

export function getTask(key) {
  const t = getState().tasks?.[key];
  return t || { key, status: 'open', snoozeUntil: null, note: null, updatedAt: null };
}

export function listTasks() {
  return Object.entries(getState().tasks || {}).map(([key, t]) => ({ key, ...t }));
}

/**
 * 设置一条待办的状态。
 * @param {string} key `folder:uid`
 * @param {object} patch { status, snoozeUntil, note }
 */
export function setTask(key, patch = {}) {
  const s = getState();
  if (!s.tasks) s.tasks = {};
  const status = TASK_STATUSES.includes(patch.status) ? patch.status : 'open';
  const prev = s.tasks[key] || {};
  const next = {
    ...prev,
    key,
    status,
    updatedAt: new Date().toISOString(),
    doneAt: status === 'done' ? new Date().toISOString() : null,
    // 只有"稍后提醒"才需要时间；其他状态一律清掉，避免留下过期的旧时间
    snoozeUntil: status === 'snoozed' ? patch.snoozeUntil || prev.snoozeUntil || null : null,
    note: patch.note !== undefined ? String(patch.note || '').slice(0, 500) : prev.note || null,
  };
  /*
   * 回到 open 就等于"没做任何标记"：删掉记录比留一条 open 更干净，
   * 也让 state.json 不会为"点了一下又撤销"而增长。
   */
  if (status === 'open') {
    delete s.tasks[key];
    persistState();
    return getTask(key);
  }
  s.tasks[key] = next;
  persistState();
  return next;
}

/* ------------------------------------------------------------ 跟催（follow-up） */

/**
 * 跟催项使用的状态集合**与待办完全一致**（open/done/snoozed/ignored）。
 *
 * 刻意不另造一套：用户已经在「需要你处理」里学过这四个状态的含义，
 * 再发明一套"已跟催/已催办"只会让人困惑；界面上也能复用同一批按钮与样式。
 */
export const FOLLOWUP_STATUSES = TASK_STATUSES;

export function listFollowUps({ kind, status } = {}) {
  const all = Object.values(getState().followUps || {});
  return all
    .filter((f) => (kind ? f.kind === kind : true))
    .filter((f) => (status ? f.status === status : true))
    .sort((a, b) => {
      // 有截止时间的排前面（最紧急）；其余按"发生时间"倒序
      const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
      const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
      if (ad !== bd) return ad - bd;
      return new Date(b.since || b.createdAt || 0) - new Date(a.since || a.createdAt || 0);
    });
}

export function getProjectRegistry() {
  return getState().projects || {};
}

/** 整体替换项目登记表（合并后写回）。 */
export function replaceProjects(registry) {
  const s = getState();
  s.projects = registry && typeof registry === 'object' ? registry : {};
  persistState();
  return Object.keys(s.projects).length;
}

/** 批量改写标签（合并项目时用）：返回改了多少条。 */
export function rewriteProjectTags({ from, to }) {
  const s = getState();
  const key = (v) =>
    String(v || '')
      .trim()
      .toLowerCase()
      .replace(/[\s·・,，.。:：;；\-—_/\\|()（）[\]【】]+/g, '');
  const want = key(from);
  const target = String(to || '').trim();
  if (!want || !target) return 0;
  let moved = 0;
  for (const a of Object.values(s.analyses || {})) {
    if (key(a?.project) === want) {
      a.project = target;
      moved += 1;
    }
  }
  for (const d of s.drafts || []) {
    if (key(d?.project) === want) d.project = target;
  }
  for (const f of Object.values(s.followUps || {})) {
    if (key(f?.project) === want) f.project = target;
  }
  persistState();
  return moved;
}

export function getFollowUpMap() {
  return getState().followUps || {};
}

/**
 * 整体替换跟催表（扫描后写回）。
 *
 * 用"整体替换"而不是逐条 upsert：扫描本身已经做了合并（保留用户状态、幂等键），
 * 逐条写反而容易在中途留下半个状态。
 */
export function replaceFollowUps(map) {
  const s = getState();
  s.followUps = map && typeof map === 'object' ? map : {};
  persistState();
  return Object.keys(s.followUps).length;
}

/** 设置一条跟催的状态（与 setTask 同样的语义）。 */
export function setFollowUp(id, patch = {}) {
  const s = getState();
  if (!s.followUps) s.followUps = {};
  const prev = s.followUps[id];
  if (!prev) return null;
  const status = FOLLOWUP_STATUSES.includes(patch.status) ? patch.status : 'open';
  const next = {
    ...prev,
    status,
    updatedAt: new Date().toISOString(),
    doneAt: status === 'done' ? new Date().toISOString() : null,
    snoozeUntil: status === 'snoozed' ? patch.snoozeUntil || prev.snoozeUntil || null : null,
    closeReason: status === 'done' ? String(patch.closeReason || prev.closeReason || '手动标记完成').slice(0, 200) : null,
  };
  // 与待办不同：跟催记录是扫描出来的事实，撤销标记只回到 open，不能把记录本身删掉
  s.followUps[id] = status === 'open' ? { ...next, doneAt: null, closeReason: null } : next;
  persistState();
  return s.followUps[id];
}

export function summarizeFollowUps(now = Date.now()) {
  const all = Object.values(getState().followUps || {});
  const open = all.filter((f) => f.status === 'open');
  return {
    total: all.length,
    open: open.length,
    mine: open.filter((f) => f.kind === 'mine').length,
    waiting: open.filter((f) => f.kind === 'waiting').length,
    overdue: open.filter((f) => f.dueAt && new Date(f.dueAt).getTime() < now).length,
  };
}

/* ------------------------------------------------------------ 分析记录 */

export function analysisKey(folder, uid) {
  return `${folder}:${uid}`;
}

export function upsertAnalyses(records) {
  const s = getState();
  for (const rec of records) {
    if (!rec?.uid) continue;
    const key = analysisKey(rec.folder || 'INBOX', rec.uid);
    s.analyses[key] = { ...(s.analyses[key] || {}), ...rec, key };
  }
  return records.length;
}

export function listAnalyses({ instanceId, since, limit = 500 } = {}) {
  const s = getState();
  return Object.values(s.analyses)
    .filter((a) => (instanceId ? a.instanceId === instanceId : true))
    .filter((a) => (since ? new Date(a.mail?.date || a.analyzedAt) >= new Date(since) : true))
    .sort((a, b) => new Date(b.mail?.date || 0) - new Date(a.mail?.date || 0))
    .slice(0, limit);
}

export function getAnalysis(folder, uid) {
  return getState().analyses[analysisKey(folder, uid)] || null;
}

/* ------------------------------------------------------------ 草稿 */

export function listDrafts({ instanceId, status, since } = {}) {
  return getState()
    .drafts.filter((d) => (instanceId ? d.instanceId === instanceId : true))
    .filter((d) => (status ? d.status === status : true))
    .filter((d) => (since ? new Date(d.createdAt) >= new Date(since) : true))
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

export function getDraft(id) {
  return getState().drafts.find((d) => d.id === id) || null;
}

/**
 * 写入草稿。草稿 id 由「文件夹 + UID」推导，重新分析同一封邮件会得到相同 id，
 * 因此这里按 id 覆盖而不是追加——否则会留下两条同 id、状态互相矛盾的记录。
 *
 * 安全阀：**已发送的草稿绝不允许被「降级」回待审核**。
 * 否则重新分析一次，用户会看到一封已经发出去的邮件又变成「待审核、待发送」，
 * 既会诱导重复发送，也会抹掉发送时间与结果这些审计信息。
 */
export function addDraft(draft) {
  const s = getState();
  /*
   * 草稿必须有主键：没有 id 的记录无法被更新、发送或删除，
   * 却会出现在计数里（曾经真的出现过"草稿数 +1 但界面上找不到"）。
   * 调用方忘了给 id 时这里补一个，而不是静默推入一条无法管理的记录。
   */
  const withId = draft.id ? draft : { ...draft, id: newId('draft') };
  const idx = s.drafts.findIndex((d) => d.id === withId.id);
  if (idx < 0) {
    s.drafts.push(withId);
    return withId;
  }
  const previous = s.drafts[idx];
  const keepSent = previous.status === 'sent' && withId.status !== 'sent';
  const merged = {
    ...previous,
    ...withId,
    ...(keepSent
      ? {
          status: 'sent',
          sentAt: previous.sentAt,
          sendResult: previous.sendResult,
          // 保留「实际发出去的那一份」正文，方便回溯
          to: previous.to,
          cc: previous.cc,
          subject: previous.subject,
          body: previous.body,
        }
      : {}),
    createdAt: previous.createdAt || withId.createdAt,
    // 正文已重新生成，旧的草稿箱副本作废（需重新同步）；已发送的保留其发送后状态
    mailbox: keepSent ? previous.mailbox : null,
    updatedAt: new Date().toISOString(),
  };
  s.drafts[idx] = merged;
  return merged;
}

export function updateDraft(id, patch) {
  const s = getState();
  const idx = s.drafts.findIndex((d) => d.id === id);
  if (idx < 0) return null;
  s.drafts[idx] = { ...s.drafts[idx], ...patch, updatedAt: new Date().toISOString() };
  return s.drafts[idx];
}

export function removeDraft(id) {
  const s = getState();
  const before = s.drafts.length;
  s.drafts = s.drafts.filter((d) => d.id !== id);
  return s.drafts.length !== before;
}

/* ------------------------------------------------------------ 日历会话 */

const MAX_CALENDAR_SESSIONS = 30;
const MAX_SESSION_MESSAGES = 60;

export function listCalendarSessions() {
  return getState().calendar?.sessions || [];
}

export function getCalendarSession(id) {
  return listCalendarSessions().find((s) => s.id === id) || null;
}

export function startCalendarSession({ id }) {
  const s = getState();
  if (!s.calendar) s.calendar = { sessions: [] };
  const session = {
    id: id || `cal_${Date.now().toString(36)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    messages: [],
    pending: null,
  };
  s.calendar.sessions.push(session);
  // 只保留最近若干会话，避免无限增长
  if (s.calendar.sessions.length > MAX_CALENDAR_SESSIONS) {
    s.calendar.sessions = s.calendar.sessions.slice(-MAX_CALENDAR_SESSIONS);
  }
  return session;
}

export function appendCalendarMessage(id, message) {
  const session = getCalendarSession(id);
  if (!session) return null;
  session.messages.push(message);
  if (session.messages.length > MAX_SESSION_MESSAGES) session.messages = session.messages.slice(-MAX_SESSION_MESSAGES);
  session.updatedAt = new Date().toISOString();
  return session;
}

export function setCalendarPending(id, pending) {
  const session = getCalendarSession(id);
  if (!session) return null;
  session.pending = pending;
  session.updatedAt = new Date().toISOString();
  return session;
}

export function clearCalendarPending(id) {
  const session = getCalendarSession(id);
  if (!session) return null;
  session.pending = null;
  session.updatedAt = new Date().toISOString();
  return session;
}

/* ------------------------------------------------------------ 运行记录 */

export function startRun(record) {
  const s = getState();
  const run = {
    id: newId('run'),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    phase: 'starting',
    counts: { fetched: 0, analyzed: 0, needsReply: 0, drafts: 0, errors: 0 },
    error: null,
    ...record,
  };
  s.runs.push(run);
  return run;
}

export function updateRun(id, patch) {
  const s = getState();
  const idx = s.runs.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  const current = s.runs[idx];
  s.runs[idx] = {
    ...current,
    ...patch,
    counts: { ...current.counts, ...(patch.counts || {}) },
  };
  return s.runs[idx];
}

export function getRun(id) {
  return getState().runs.find((r) => r.id === id) || null;
}

export function listRuns(limit = 20) {
  return [...getState().runs].sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)).slice(0, limit);
}

export function lastRun({ instanceId, ok = true } = {}) {
  return (
    [...getState().runs]
      .filter((r) => (instanceId ? r.instanceId === instanceId : true))
      .filter((r) => (ok ? r.status === 'success' : true))
      .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))[0] || null
  );
}

/* ------------------------------------------------------------ 原文归档 */

export function rawFileName(folder, uid, messageId) {
  const safeFolder = String(folder || 'INBOX').replace(/[^\w.-]+/g, '_');
  return `${safeFolder}__${uid}__${fnv1a(messageId || String(uid))}.eml`;
}

export function saveRaw(folder, uid, messageId, buffer) {
  const p = getPaths();
  fs.mkdirSync(p.rawDir, { recursive: true });
  const file = path.join(p.rawDir, rawFileName(folder, uid, messageId));
  try {
    fs.writeFileSync(file, buffer);
    return file;
  } catch (err) {
    log.warn(`归档邮件原文失败：${err.message}`);
    return null;
  }
}

export function readRaw(folder, uid, messageId) {
  const p = getPaths();
  const file = path.join(p.rawDir, rawFileName(folder, uid, messageId));
  if (!fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 存储占用与清理 */

/** 归档文件名的「文件夹 + UID」前缀（清理时按它判断某文件是否还有主）。 */
function rawPrefix(folder, uid) {
  return `${String(folder || 'INBOX').replace(/[^\w.-]+/g, '_')}__${uid}__`;
}

function dirSize(dir, filter = () => true) {
  let bytes = 0;
  let count = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { bytes, count, names: [] };
  }
  for (const name of names) {
    if (!filter(name)) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      if (!st.isFile()) continue;
      bytes += st.size;
      count += 1;
    } catch {
      /* 文件刚好被删掉，忽略 */
    }
  }
  return { bytes, count, names };
}

/**
 * 存储占用体检。
 *
 * `orphan*` 是重点：**没有任何分析记录指向的归档原文**。
 * 它们已经没有任何入口能访问（列表里找不到记录就点不进去），却一直占着磁盘——
 * 因为 `persistState` 的容量收敛只删 `state.json` 里的条目，**从不动原文文件**。
 */
export function storageStats() {
  const p = getPaths();
  const s = getState();
  const prefixes = new Set(Object.values(s.analyses || {}).map((a) => rawPrefix(a.folder, a.uid)));
  const raw = dirSize(p.rawDir, (n) => n.endsWith('.eml'));
  let orphanBytes = 0;
  let orphanCount = 0;
  for (const name of raw.names) {
    if (!name.endsWith('.eml')) continue;
    const owned = [...prefixes].some((pre) => name.startsWith(pre));
    if (owned) continue;
    try {
      orphanBytes += fs.statSync(path.join(p.rawDir, name)).size;
      orphanCount += 1;
    } catch {
      /* ignore */
    }
  }
  const reports = dirSize(p.reportsDir, (n) => n.endsWith('.md'));
  const audit = dirSize(p.dataDir, (n) => n === 'audit.jsonl');
  const stateFile = dirSize(p.dataDir, (n) => n.startsWith('state.json'));
  return {
    raw: { count: raw.count, bytes: raw.bytes },
    orphan: { count: orphanCount, bytes: orphanBytes },
    reports: { count: reports.count, bytes: reports.bytes },
    audit: { count: audit.count, bytes: audit.bytes },
    state: { count: stateFile.count, bytes: stateFile.bytes },
    analyses: Object.keys(s.analyses || {}).length,
    drafts: (s.drafts || []).length,
    retention: { maxAnalyses: maxAnalysesLimit(), rawDays: rawRetentionDays() },
  };
}

/** 原文保留天数（0 = 永久保留）。 */
export function rawRetentionDays() {
  const v = Number(getConfig()?.retention?.rawDays);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** 分析记录上限（可配置；旧版本是写死的 3000）。 */
export function maxAnalysesLimit() {
  const v = Number(getConfig()?.retention?.maxAnalyses);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : MAX_ANALYSES_DEFAULT;
}

/**
 * 清理归档原文。
 *
 * 两件事，风险完全不同：
 *   1. **孤儿清理**（`includeOrphans`，默认开）：删掉没有任何分析记录指向的 .eml。
 *      这些文件**已经没有任何界面入口**能访问，删了不损失任何可查询的历史 —— 零风险。
 *   2. **按保留期清理**（`retentionDays > 0` 时）：连"有主"的原文也一起删旧的。
 *      ⚠️ 这会牺牲「查看原文全文 / 下载附件 / 重新起草」的离线可用性：
 *      邮件还在服务器上时程序会**回连邮箱重新拉**（`loadRawFor` 有兜底），
 *      但邮件已被删除或超出服务器保留期时，就**彻底查不到了**。
 *
 * 只动 `data/raw/*.eml`，绝不碰 `state.json`/`reports`/`audit.jsonl`——那三样才是"历史记录"本身。
 */
export function cleanupRawArchives({ includeOrphans = true, retentionDays = 0, now = Date.now() } = {}) {
  const p = getPaths();
  const s = getState();
  const keep = new Set(Object.values(s.analyses || {}).map((a) => rawPrefix(a.folder, a.uid)));
  const cutoff = retentionDays > 0 ? now - retentionDays * 86_400_000 : null;
  const raw = dirSize(p.rawDir, (n) => n.endsWith('.eml'));
  const removed = { orphans: 0, expired: 0, bytes: 0, kept: 0, failed: 0 };
  for (const name of raw.names) {
    if (!name.endsWith('.eml')) continue;
    const full = path.join(p.rawDir, name);
    const owned = [...keep].some((pre) => name.startsWith(pre));
    let st = null;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    const isOrphan = !owned;
    const isExpired = cutoff !== null && st.mtimeMs < cutoff;
    if ((includeOrphans && isOrphan) || (cutoff !== null && isExpired && owned)) {
      try {
        fs.unlinkSync(full);
        if (isOrphan) removed.orphans += 1;
        else removed.expired += 1;
        removed.bytes += st.size;
      } catch (err) {
        removed.failed += 1;
        log.warn(`删除归档原文失败（${name}）：${err?.message || err}`);
      }
    } else {
      removed.kept += 1;
    }
  }
  return removed;
}

/**
 * 只按「文件夹 + UID」找归档原文。
 *
 * 归档文件名里带 Message-ID 的哈希，调用方不一定知道它（未分析的邮件就没有分析记录可查），
 * 因此这里按前缀扫描目录。原文目录很小，代价可忽略。
 */
export function findRaw(folder, uid) {
  const p = getPaths();
  const safeFolder = String(folder || 'INBOX').replace(/[^\w.-]+/g, '_');
  const prefix = `${safeFolder}__${uid}__`;
  let names = [];
  try {
    names = fs.readdirSync(p.rawDir);
  } catch {
    return null;
  }
  const hit = names.find((n) => n.startsWith(prefix) && n.endsWith('.eml'));
  if (!hit) return null;
  try {
    return fs.readFileSync(path.join(p.rawDir, hit));
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 报告 */

export function saveReport({ instanceId, runId, markdown, meta = {} }) {
  const p = getPaths();
  fs.mkdirSync(p.reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const id = newId('report');
  /*
   * 文件名必须**唯一**，不能只用秒级时间戳：
   * 连续两次分析（例如先跑 24 小时、紧接着跑自定义 7 天）可能落在同一秒，
   * 那样第二份简报会把第一份**覆盖掉**，导致两个窗口的简报内容串味
   * （表现为：7 天的窗口里读到 24 小时的简报）。
   * 带上记录 id 就绝不会撞名。
   */
  const unique = String(id).replace(/[^\w-]/g, '').slice(-8);
  const file = path.join(p.reportsDir, `digest-${stamp}-${unique}.md`);
  const header = [
    `<!-- mailbot report`,
    `instance: ${instanceId}`,
    `run: ${runId || ''}`,
    `generated: ${new Date().toISOString()}`,
    `-->`,
    '',
  ].join('\n');
  fs.writeFileSync(file, `${header}${markdown}\n`, 'utf8');

  const s = getState();
  const record = { id, file, instanceId, runId: runId || null, createdAt: new Date().toISOString(), ...meta };
  s.reports.push(record);
  if (s.reports.length > 200) s.reports = s.reports.slice(-200);
  return record;
}

export function listReports(limit = 30) {
  return [...getState().reports].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, limit);
}

export function getReport(id) {
  return getState().reports.find((r) => r.id === id) || null;
}

export function readReportFile(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new AppError(`读取报告失败：${err.message}`, { code: 'REPORT_READ_FAILED', status: 500 });
  }
}

/* ------------------------------------------------------------ 清理 */

/** 清理超过 days 天的原文归档。 */
export function pruneRawFiles(days = 14) {
  const p = getPaths();
  if (!fs.existsSync(p.rawDir)) return 0;
  const cutoff = Date.now() - days * 86_400_000;
  let removed = 0;
  for (const name of fs.readdirSync(p.rawDir)) {
    const file = path.join(p.rawDir, name);
    try {
      if (fs.statSync(file).mtimeMs < cutoff) {
        fs.unlinkSync(file);
        removed += 1;
      }
    } catch {
      /* ignore */
    }
  }
  if (removed) log.info(`清理了 ${removed} 个过期邮件归档`);
  return removed;
}

export function stateSummary() {
  const s = getState();
  return {
    analyses: Object.keys(s.analyses).length,
    drafts: s.drafts.length,
    runs: s.runs.length,
    reports: s.reports.length,
    updatedAt: s.updatedAt,
    state: safeJson(s.runs.slice(-1)[0] || null) === 'null' ? null : s.runs.slice(-1)[0],
  };
}
