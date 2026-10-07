/**
 * 运行引擎：拉取近 N 小时邮件 → 分类 → 起草回复 → 存草稿 → 生成简报。
 *
 * 设计要点：
 *  - 一次运行只开一条 IMAP 连接，全程串行，避免服务器并发连接数限制。
 *  - 扫描阶段不修改邮箱；唯一的写操作是「把草稿追加进草稿箱」。
 *  - 同一实例同时只允许一个运行（互斥锁）。
 *  - 进度通过 EventEmitter 广播，HTTP 层转成 SSE。
 */

import { EventEmitter } from 'node:events';
import { getConfig, getInstance, getPaths, validateInstance } from '../config/index.js';
import { AppError, hoursAgo, log, mapLimit, truncate } from '../lib/util.js';
import { LlmClient } from '../llm/client.js';
import { runFollowUpScan } from '../followup.js';

/**
 * 当前已有的项目标签（喂给分类提示词，让模型尽量**复用**而不是每次换个说法）。
 *
 * 取不到就返回空数组：分类本身不该因为"读不到已有标签"而失败。
 */
async function knownProjectLabels() {
  try {
    const [{ listProjects }, store] = await Promise.all([import('../timeline.js'), import('../store/state.js')]);
    return listProjects({
      analyses: store.listAnalyses({ limit: 5000 }),
      drafts: store.listDrafts({}),
      followUps: store.getFollowUpMap(),
      registry: store.getProjectRegistry(),
    })
      .map((p) => p.name)
      .slice(0, 40);
  } catch {
    return [];
  }
}
import { REPORT_SYSTEM, buildReportPrompt } from '../llm/prompts.js';
import { classifyMails, draftReply, sortByPriority, PRIORITY_LABELS, TYPE_LABELS } from '../ai/analyze.js';
import {
  appendToMailbox,
  connect,
  fetchRawSourceWithin,
  fetchSince,
  findDraftsMailbox,
  findThreadContext,
  listMailboxes,
  safeLogout,
  searchUids,
} from '../mail/imap.js';
import { buildMime, ensureReplyPrefix, identitySender, makeMessageId } from '../mail/compose.js';
import { acquireAccount, RUN_WAIT_MS } from '../mail/account-lock.js';
import { clipForLlm, makeSnippet, parseMessage, stripQuoted } from '../mail/parse.js';
import { classifyRecipient, isCcAttention, isDirectAction, isWorthNoting } from '../mail/recipient.js';
import * as store from '../store/state.js';

export const progressBus = new EventEmitter();
progressBus.setMaxListeners(50);

const activeRuns = new Map();

/** 回看窗口的允许范围：1 小时 ~ 30 天。 */
export const MIN_WINDOW_HOURS = 1;
export const MAX_WINDOW_HOURS = 24 * 30;

/** 把窗口小时数限幅到合法区间（界面可以传自定义天数，但后端必须自己把关）。 */
export function clampWindowHours(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, Math.round(n)));
}

/**
 * 按窗口推算单次取信上限。
 *
 * 以「24 小时 = 配置值（默认 60）」为基准线性放大：3 天 → 180，7 天 → 420，30 天 → 1800，
 * 但硬顶 2000 封（一次分析再多就得考虑分批与成本了）。
 */
export function maxMessagesFor(hours, base = 60) {
  const days = Math.max(1, Math.ceil(clampWindowHours(hours) / 24));
  return Math.min(2000, Math.max(Number(base) || 60, days * (Number(base) || 60)));
}

/** 人类可读的窗口描述（标题与简报共用，避免出现「最近 168 小时」）。 */
export function describeWindow(hours) {
  const h = clampWindowHours(hours);
  // 24 小时保持「最近 24 小时」的说法：这是大家习惯的叫法，也是既有文案
  if (h <= 24) return `最近 ${h} 小时`;
  const days = Math.round(h / 24);
  return h % 24 === 0 ? `最近 ${days} 天` : `最近 ${h} 小时`;
}

/** 草稿里保留的来信正文快照上限（够生成引文即可，不必存整封） */
const ORIGINAL_BODY_SNAPSHOT_CHARS = 8000;

/**
 * 分析前的**只读预检**：连一次邮箱，数一数这个窗口里到底有多少封邮件。
 *
 * 为什么需要它：把窗口从 24 小时放宽到 7 天/30 天时，代价会成倍增长
 * （一封邮件一次分类调用）。用户需要**在花钱之前**看到「将分析约 N 封」，
 * 而不是点下去才发现要跑半小时。这里只读列表、不取正文、不调用模型，因此零 token 成本。
 *
 * @returns {Promise<object>} { windowHours, windowLabel, folders, matched, matchedTotal, taken, limit, truncated, existingDrafts, willDraft, estimatedCalls, backfillCandidates }
 */
export async function previewScan({ instanceId, windowHours } = {}) {
  const config = getConfig();
  const instance = getInstance(instanceId);
  const problems = validateInstance(instance);
  if (problems.length) {
    throw new AppError(`邮箱配置不完整：${problems.join('；')}`, {
      code: 'INSTANCE_INVALID',
      status: 400,
      detail: { problems },
    });
  }

  const hours = clampWindowHours(windowHours || config.scan.windowHours);
  const since = hoursAgo(hours);
  const limit = maxMessagesFor(hours, config.scan.maxMessages);

  let imap;
  let releaseAccount = null;
  const folders = [];
  let matchedTotal = 0;
  try {
    // 预检也要连邮箱，同样得跟别的入口排队：否则「点一下预检」就可能在一次分析旁边多开一条连接
    releaseAccount = await acquireAccount(instance, {
      label: `分析预检（${instance.label}）`,
      onWait: ({ holder, queued, waitMs }) =>
        log.info(`分析预检在等邮箱空闲（当前占用：${holder}，前面 ${queued - 1} 个，最多等 ${Math.round(waitMs / 1000)} 秒）`),
    });
    imap = await connect(instance);
    const mailboxes = await listMailboxes(imap);
    for (const folder of config.scan.folders) {
      if (!mailboxes.some((m) => m.path === folder)) {
        folders.push({ folder, exists: false, matched: 0, taken: 0 });
        continue;
      }
      // 只要 UID 列表，不取头部正文
      const found = await searchUids(instance, { folder, since, client: imap });
      const uids = Array.isArray(found) ? found : found?.uids || [];
      const remaining = Math.max(0, limit - Math.min(matchedTotal, limit));
      const taken = Math.min(uids.length, remaining);
      matchedTotal += uids.length;
      folders.push({ folder, exists: true, matched: uids.length, taken });
    }
  } finally {
    if (imap) await safeLogout(imap);
    releaseAccount?.();
  }

  const taken = folders.reduce((sum, f) => sum + f.taken, 0);
  const analyzed = store.listAnalyses({ instanceId: instance.id, since, limit: 5000 });
  const analyzedKeys = new Set(analyzed.map((a) => a.key));
  const drafts = store.listDrafts({ instanceId: instance.id });
  const draftKeys = new Set(drafts.map((d) => `${d.source?.folder}:${d.source?.uid}`));
  /*
   * 预检数字必须与**实际运行**一致，否则用户会照着错数字决定要不要花钱。
   *
   * 旧实现按"已分析比例"估算复用率，于是写着"其中 5 封已分析过，**不会重复消耗**"，
   * 而实际每轮都会把窗口内**全部**邮件重新分类（实测连续 6 次都是 拉取 11 → 分析 11）。
   *
   * 真实规则（见分类阶段）：只有**已有分析记录 + 已有草稿**的邮件才会复用。
   * 所以这里精确算出这个交集，而不是拍一个比例。
   */
  const reusable = [...draftKeys].filter((k) => analyzedKeys.has(k)).length;
  const estimatedAnalyze = Math.max(0, taken - reusable);
  const batchSize = Math.max(1, Number(config.llm.batchSize) || 12);

  return {
    instanceId: instance.id,
    instanceLabel: instance.label,
    windowHours: hours,
    windowLabel: describeWindow(hours),
    folders,
    /** 窗口内命中的邮件总数（不限截断上限） */
    matched: matchedTotal,
    /** 本次实际会取的封数（受上限约束） */
    taken,
    limit,
    truncated: matchedTotal > taken,
    /** 窗口内已有分析记录的封数（**注意：不代表不会重新分析**） */
    alreadyAnalyzed: analyzed.length,
    alreadyDrafted: draftKeys.size,
    /** 真正会复用的封数：已有分析 **且** 已有草稿（这封已经处置过） */
    reusable,
    /** 预计要送给模型分类的封数（与运行时的真实行为一致） */
    estimatedAnalyze,
    /** 预计模型调用次数（分类批次数 + 1 次生成简报） */
    estimatedCalls: Math.ceil(estimatedAnalyze / batchSize) + 1,
    batchSize,
  };
}

export function isRunning(instanceId) {
  return activeRuns.has(instanceId);
}

export function currentRun(instanceId) {
  return activeRuns.get(instanceId) || null;
}

function emit(runId, event) {
  progressBus.emit('event', { runId, at: new Date().toISOString(), ...event });
}

/**
 * 把已有分析记录转回「分类结果」的形状，用于复用（不再调用模型）。
 *
 * 只取分类产出的字段，**不带 mail/recipient** —— 那些由本次运行重新计算，
 * 因为收件人身份会随实例配置变化，而邮件元数据以本轮拉到的为准。
 */
function reuseClassification(stored) {
  return {
    type: stored.type,
    priority: stored.priority,
    needsReply: stored.needsReply === true,
    worthNoting: stored.worthNoting === true,
    summary: stored.summary || '',
    actions: Array.isArray(stored.actions) ? stored.actions : [],
    language: stored.language ?? null,
    reason: stored.reason || '',
    model: stored.model || null,
    analyzedAt: stored.analyzedAt || new Date().toISOString(),
    /** 标记复用来源，便于界面/自检区分"这次没花钱" */
    reused: true,
  };
}

/* ================================================================ 主流程 */

/**
 * 按**精确**窗口过滤邮件。
 *
 * 存在的理由：IMAP 的 `SEARCH SINCE <日期>` 只精确到「天」（协议如此），所以"最近 24 小时"
 * 实际会把当天更早的邮件也带回来。真实案例：一次"最近 24 小时"拉回 11 封，其中 6 封
 * 距当时 24–43 小时——于是简报写"共 11 封"、页面卡片写 5 封，**同一页两个数字互相矛盾**。
 *
 * 时间解析不出来的邮件一律**保留**：宁可多分析一封，也不要因为日期意外就丢掉邮件。
 *
 * @param {Array<{date?: string}>} mails
 * @param {number} sinceMs 窗口起点（毫秒）
 */
export function filterByExactWindow(mails, sinceMs) {
  if (!Number.isFinite(sinceMs)) return { kept: mails, dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const m of mails) {
    const t = new Date(m?.date).getTime();
    if (Number.isNaN(t) || t >= sinceMs) kept.push(m);
    else dropped += 1;
  }
  return { kept, dropped };
}

/**
 * @param {object} options
 * @param {string} [options.instanceId]
 * @param {number} [options.windowHours]
 * @param {boolean} [options.force] 忽略「距离上次运行不足 N 分钟」的提示
 * @param {{folder:string, uid:number}} [options.scope] 只处理指定的一封邮件
 * @returns {Promise<object>} 运行结果摘要
 */
export async function runScan({ instanceId, windowHours, force = false, trigger = 'manual', scope = null } = {}) {
  const config = getConfig();
  const instance = getInstance(instanceId);

  const problems = validateInstance(instance);
  if (problems.length) {
    throw new AppError(`邮箱配置不完整：${problems.join('；')}`, {
      code: 'INSTANCE_INVALID',
      status: 400,
      detail: { problems },
    });
  }
  if (isRunning(instance.id)) {
    throw new AppError('该邮箱已有一次分析正在进行，请等待完成。', { code: 'RUN_IN_PROGRESS', status: 409 });
  }

  const llmConfig = { ...config.llm, model: config.llm.model };
  const client = new LlmClient(llmConfig);
  if (!client.ready) {
    throw new AppError('大模型未配置完成（缺少 API Key），无法分析邮件。', {
      code: 'LLM_NOT_CONFIGURED',
      status: 400,
    });
  }

  const hours = clampWindowHours(windowHours || config.scan.windowHours);
  const since = hoursAgo(hours);
  // 放宽窗口时必须同步放宽「单次取信上限」，否则 7 天窗口只会取到最新 60 封、
  // 其余静默丢弃——用户看到"分析完成"却漏了邮件，比报错更难发现。
  const maxMessages = maxMessagesFor(hours, config.scan.maxMessages);
  const run = store.startRun({
    instanceId: instance.id,
    instanceLabel: instance.label,
    windowHours: hours,
    trigger,
    scope: scope ? { folder: scope.folder, uid: scope.uid } : null,
  });
  const abort = { cancelled: false };
  activeRuns.set(instance.id, { runId: run.id, abort });
  store.persistState();

  emit(run.id, { type: 'run:start', run: { id: run.id, instanceId: instance.id, windowHours: hours } });

  const phase = (name, extra = {}) => {
    store.updateRun(run.id, { phase: name });
    emit(run.id, { type: 'phase', phase: name, ...extra });
  };
  const bump = (counts) => {
    const updated = store.updateRun(run.id, { counts });
    emit(run.id, { type: 'counts', counts: updated.counts });
  };

  let imap;
  let releaseAccount = null;
  const errors = [];
  try {
    /* ---------------------------------------------------------- 1. 连接 */
    /*
     * 同账号串行化：整个运行周期只允许这个账号上有一条 IMAP 连接。
     *
     * 这里复用**已有的**「同一实例同时只允许一个运行」语义（上面的 isRunning → RUN_IN_PROGRESS），
     * 不另造第二套：isRunning 负责「再点一次分析」立刻被拒，
     * acquireAccount 负责「别的入口（预检/检索回补/正文回源/草稿同步/诊断）正开着连接」时排队。
     * 两个都必须有：前者是快速失败，后者才是真正防并发连接。
     */
    releaseAccount = await acquireAccount(instance, {
      label: `分析（${instance.label}）`,
      waitMs: RUN_WAIT_MS,
      // 排队期间用户点「取消」要能立刻停，而不是干等满两分钟
      signal: abort,
      cancelCode: 'RUN_CANCELLED',
      onWait: ({ holder, queued, waitMs }) => {
        // 相位写成 queued：运行列表与顶部进度条都能显示「在排队」，不会让人以为卡死
        phase('queued', {
          message: `邮箱正忙（${holder}），已排队等待，最多 ${Math.round(waitMs / 1000)} 秒`,
        });
        emit(run.id, {
          type: 'account:queued',
          holder,
          queued: queued - 1,
          waitMs,
          message: `另一个邮箱操作正在进行：${holder}`,
        });
      },
    });
    phase('connecting', { message: `连接 ${instance.imap.host}:${instance.imap.port}` });
    imap = await connect(instance);
    const mailboxes = await listMailboxes(imap);
    const draftsBox = await findDraftsMailbox(imap, config.draft.draftsMailbox);
    log.info(`已连接 ${instance.label}；文件夹 ${mailboxes.length} 个；草稿箱：${draftsBox || '未找到'}`);
    emit(run.id, {
      type: 'connected',
      mailboxes: mailboxes.map((m) => ({ path: m.path, name: m.name, specialUse: m.specialUse })),
      draftsMailbox: draftsBox,
    });

    /* ---------------------------------------------------------- 2. 拉取 */
    phase('fetching', { message: scope ? '读取指定邮件' : `拉取${describeWindow(hours)}的邮件` });
    // let：下面要按**精确**窗口再滤一道（IMAP SINCE 只精确到天）
    let collected = [];
    const truncation = [];
    for (const folder of config.scan.folders) {
      if (abort.cancelled) throw new AppError('运行已取消', { code: 'RUN_CANCELLED', status: 499 });
      if (!mailboxes.some((m) => m.path === folder)) {
        errors.push({ stage: 'fetch', folder, message: `文件夹不存在：${folder}` });
        log.warn(`跳过不存在的文件夹：${folder}`);
        continue;
      }
      if (scope && folder !== scope.folder) continue;
      const list = await fetchSince(instance, {
        folder,
        since: scope ? hoursAgo(24 * 365) : since,
        maxMessages: scope ? 500 : maxMessages,
        client: imap,
        uids: scope ? [scope.uid] : undefined,
        onProgress: ({ done, total }) => emit(run.id, { type: 'fetch:progress', folder, done, total }),
      });
      const meta = list.meta || {};
      if (meta.truncated) {
        truncation.push({ folder, matched: meta.matched ?? null, taken: list.length, limit: scope ? 500 : maxMessages });
      }
      emit(run.id, { type: 'fetch:done', folder, ...meta });
      collected.push(...list);
    }

    /*
     * 按**精确**窗口再过滤一道。
     *
     * IMAP 的 `SEARCH SINCE <日期>` 只精确到「天」（协议如此），所以"最近 24 小时"
     * 实际会把当天更早的邮件也带回来。真实案例：一次"最近 24 小时"拉回 11 封，
     * 其中 6 封距当时 24–43 小时——于是简报写"共 11 封"、页面卡片写 5 封，
     * **同一页上两个数字互相矛盾**（用户实测）。
     *
     * 这里用邮件的真实时间再滤一次，让"拉取数 = 窗口内数 = 卡片数"。
     * 两种情况下**不过滤**：
     *   - `scope`：用户点名重析某一封（可能很旧），不能用窗口把它挡住；
     *   - 有时间缺失的邮件：宁可多留一封，也不要因为解析不出时间就把信丢掉。
     */
    if (!scope) {
      const { kept, dropped } = filterByExactWindow(collected, new Date(since).getTime());
      if (dropped > 0) {
        log.info(`按精确 ${hours} 小时窗口过滤掉 ${dropped} 封（IMAP SINCE 只精确到天，会多带当天的邮件）`);
        emit(run.id, { type: 'fetch:filtered', dropped, windowHours: hours });
      }
      collected = kept;
    }

    bump({ fetched: collected.length });
    log.info(`共取得 ${collected.length} 封邮件（${describeWindow(hours)}）`);
    if (truncation.length) {
      // 如实告知被截断，而不是让用户以为"都分析过了"
      const detail = truncation.map((t) => `${t.folder} 命中 ${t.matched ?? '?'} 封、只取了最新 ${t.taken} 封`).join('；');
      log.warn(`取信达到上限被截断：${detail}`);
      emit(run.id, { type: 'fetch:truncated', detail, truncation });
    }

    if (collected.length === 0) {
      const empty = {
        runId: run.id,
        instanceId: instance.id,
        windowHours: hours,
        fetched: 0,
        analyzed: 0,
        needsReply: 0,
        drafts: 0,
        skippedDrafts: 0,
        message: `最近 ${hours} 小时内没有新邮件。`,
      };
      store.updateRun(run.id, { status: 'success', phase: 'done', finishedAt: new Date().toISOString() });
      store.persistState();
      emit(run.id, { type: 'run:done', result: empty });
      return empty;
    }

    /* ------------------------------------------------ 3. 取正文并归档 */
    phase('reading', { message: '读取邮件正文' });
    const mails = [];
    let readIndex = 0;
    for (const summary of collected) {
      if (abort.cancelled) throw new AppError('运行已取消', { code: 'RUN_CANCELLED', status: 499 });
      readIndex += 1;
      try {
        const raw = await fetchRawSourceWithin(imap, summary.uid);
        if (!raw) throw new Error('服务器未返回邮件原文');
        const parsed = await parseMessage(raw);
        store.saveRaw(summary.folder, summary.uid, summary.messageId, raw);
        const body = stripQuoted(parsed.body);
        mails.push({
          ...summary,
          subject: parsed.subject || summary.subject,
          inReplyTo: parsed.inReplyTo || summary.inReplyTo,
          references: parsed.references || [],
          attachments: parsed.attachments?.length ? parsed.attachments : summary.attachments,
          bodyFull: body,
          bodySnippet: makeSnippet(body, config.scan.snippetChars),
        });
      } catch (err) {
        errors.push({ stage: 'read', uid: summary.uid, subject: summary.subject, message: err?.message || String(err) });
        log.warn(`读取邮件失败 UID=${summary.uid}：${err?.message || err}`);
        mails.push({ ...summary, bodyFull: '', bodySnippet: '(正文读取失败)' });
      }
      emit(run.id, { type: 'read:progress', done: readIndex, total: collected.length });
    }

    /* ------------------------------------------------ 4. 会话上下文 */
    phase('threads', { message: '整理会话上下文' });
    const contextByKey = new Map();
    if (config.scan.threadContextCount > 0) {
      for (const mail of mails) {
        if (abort.cancelled) throw new AppError('运行已取消', { code: 'RUN_CANCELLED', status: 499 });
        try {
          const lock = await imap.getMailboxLock(mail.folder, { readOnly: true });
          let ctxSummaries = [];
          try {
            ctxSummaries = await findThreadContext(imap, mail, config.scan.threadContextCount);
          } finally {
            lock.release();
          }
          if (!ctxSummaries.length) continue;
          const records = [];
          for (const ctx of ctxSummaries) {
            const raw = store.readRaw(ctx.folder, ctx.uid, ctx.messageId) || (await fetchRawSourceWithin(imap, ctx.uid));
            if (!raw) continue;
            const parsed = await parseMessage(raw);
            records.push({
              uid: ctx.uid,
              folder: ctx.folder,
              messageId: parsed.messageId || ctx.messageId,
              subject: parsed.subject || ctx.subject,
              date: parsed.date || ctx.date,
              from: parsed.from || ctx.from,
              direction: isOutgoing(instance, parsed.from || ctx.from) ? 'outgoing' : 'incoming',
              body: clipForLlm(stripQuoted(parsed.body), Math.min(1200, config.scan.bodyCharsForLlm / 2)),
            });
          }
          contextByKey.set(store.analysisKey(mail.folder, mail.uid), records);
        } catch (err) {
          log.debug(`整理会话失败 UID=${mail.uid}：${err?.message || err}`);
        }
      }
    }

    /* ------------------------------------------------ 5. 分类 */
    const forLlm = mails.map((m) => ({
      ...m,
      body: clipForLlm(m.bodyFull || m.bodySnippet, config.scan.bodyCharsForLlm),
    }));
    /*
     * ------------------------------------------------ 5. 分类
     *
     * **复用规则（省钱）**：一封邮件如果**已经有分析记录、又有草稿**，说明它已经处置过了，
     * 再花钱重新分类不会带来任何新信息 → 直接复用已有结论。
     *
     * 为什么只对"有草稿"的复用，而不是对所有已分析过的复用：
     * 分类提示词会随版本演进（例如新增了 worthNoting 字段），全量复用会让老邮件永远拿不到新字段。
     * 而"已有草稿"的邮件已经处置完毕，不需要新字段。用户删掉草稿后下一轮就会重新分类，自愈。
     */
    const draftKeySet = new Set(
      store.listDrafts({ instanceId: instance.id }).map((d) => `${d.source?.folder}:${d.source?.uid}`),
    );
    const classifications = new Array(mails.length);
    const pending = [];
    let reusedCount = 0;
    for (let i = 0; i < mails.length; i += 1) {
      const key = store.analysisKey(mails[i].folder, mails[i].uid);
      const stored = draftKeySet.has(key) ? store.getAnalysis(mails[i].folder, mails[i].uid) : null;
      if (stored && stored.type) {
        /*
         * **必须带上本轮的 folder/uid/messageId**。
         *
         * 漏了它们会造成两个很隐蔽的后果（我第一版就踩了）：
         *   1. 下游 `upsertAnalyses` 见 `rec.uid` 为空会**直接跳过**，
         *      于是复用的邮件从清单/统计里静默消失；
         *   2. 起草去重按 `${folder}:${uid}` 匹配，键变成 `undefined:undefined`，
         *      于是**已经发过的邮件又被起草一遍**（诱导重复发送）。
         */
        classifications[i] = {
          ...reuseClassification(stored),
          folder: mails[i].folder,
          uid: mails[i].uid,
          messageId: mails[i].messageId || null,
        };
        reusedCount += 1;
      } else {
        pending.push({ mail: forLlm[i], index: i });
      }
    }
    if (reusedCount) {
      log.info(`复用已有分析 ${reusedCount} 封（已有草稿，不再重复消耗）`);
      emit(run.id, { type: 'analyze:reuse', reused: reusedCount, toClassify: pending.length });
    }
    phase('analyzing', {
      message: pending.length ? `大模型分析 ${pending.length} 封邮件` : '全部可复用，无需调用模型',
      total: pending.length,
    });
    const fresh = pending.length
      ? await classifyMails({
          mails: pending.map((p) => p.mail),
          client,
          config,
          /* 已有项目标签：不给列表的话，"照抄已知标签"这条要求根本无从执行 */
          knownProjects: await knownProjectLabels(),
          onProgress: ({ done, total, failed }) =>
            emit(run.id, { type: 'analyze:progress', done, total, failed: !!failed }),
        })
      : [];
    pending.forEach((p, k) => {
      classifications[p.index] = fresh[k];
    });

    const enriched = mails.map((mail, i) => {
      const classification = classifications[i];
      // 收件人身份决定这封邮件是「需要我处理」还是「需要我关注」
      const recipient = classifyRecipient(mail, instance);
      return {
        ...classification,
        instanceId: instance.id,
        recipientKind: recipient.kind,
        isDirect: recipient.isDirect,
        isCcOnly: recipient.isCcOnly,
        mail: {
          uid: mail.uid,
          folder: mail.folder,
          messageId: mail.messageId || null,
          inReplyTo: mail.inReplyTo || null,
          references: mail.references || [],
          subject: mail.subject,
          date: mail.date,
          from: mail.from,
          to: mail.to,
          cc: mail.cc,
          replyTo: mail.replyTo,
          seen: mail.seen,
          hasAttachments: !!mail.attachments?.filter((a) => !a.inline).length,
          attachments: (mail.attachments || []).filter((a) => !a.inline),
          snippet: mail.bodySnippet,
          size: mail.size,
        },
        context: contextByKey.get(store.analysisKey(mail.folder, mail.uid)) || [],
      };
    });

    store.upsertAnalyses(enriched.map((e) => ({ ...e, runId: run.id })));
    // 只把「直接发给我 + 高优先级 + 需回复」计入待办；仅抄送的高优先级进「需要你关注」
    const actionable = enriched.filter((e) => isDirectAction(e) && e.type !== 'spam');
    const ccAttention = enriched.filter((e) => isCcAttention(e));
    // 「需留意」：不需回复但有明确时限（不算进 needsReply，它自己一个口径）
    const worthNoting = enriched.filter((e) => isWorthNoting(e));
    // 起草队列：直接发给我的高优先级邮件
    const needsReply = actionable;
    bump({
      analyzed: enriched.length,
      needsReply: needsReply.length,
      attention: ccAttention.length,
      worthNoting: worthNoting.length,
      // 如实报告"这次白拿了几封"（已有草稿 → 复用，没花 token）
      reused: reusedCount,
      /** 真正调用模型分类的封数（= analyzed - reused） */
      classified: enriched.length - reusedCount,
    });
    store.persistState();
    emit(run.id, {
      type: 'analyzed',
      total: enriched.length,
      needsReply: needsReply.length,
      attention: ccAttention.length,
      breakdown: breakdown(enriched),
    });

    /* ------------------------------------------------ 6. 起草 */
    /*
     * 只为「还没有草稿」的邮件起草。
     *
     * 草稿 id 由「文件夹 + UID」推导，所以同一封邮件重复分析会命中同一条记录：
     *  - 已有待审核草稿：再起草会覆盖用户可能已经改过的正文，纯属倒退；
     *  - 已有已发送草稿：这封邮件已经处理完了，再生成一封「待审核」会诱导重复发送。
     * 因此这里显式跳过，并把跳过数量如实报告给界面。
     */
    const draftedKeys = new Set(
      store.listDrafts({ instanceId: instance.id }).map((d) => `${d.source?.folder}:${d.source?.uid}`),
    );
    const pendingDraft = needsReply.filter((e) => draftedKeys.has(`${e.folder}:${e.uid}`));
    const toDraft = needsReply.filter((e) => !draftedKeys.has(`${e.folder}:${e.uid}`)).slice(0, config.draft.maxDrafts);
    const skippedDraftCount = pendingDraft.length;
    if (skippedDraftCount) {
      log.info(`已有草稿的 ${skippedDraftCount} 封邮件不再重复起草`);
      emit(run.id, { type: 'draft:skipped', count: skippedDraftCount, total: needsReply.length });
    }
    const draftRecords = [];
    if (toDraft.length) {
      phase('drafting', { message: `起草 ${toDraft.length} 封回复`, total: toDraft.length });
      let draftDone = 0;
      await mapLimit(toDraft, config.draft.concurrency, async (entry) => {
        if (abort.cancelled) return null;
        const mail = mails.find((m) => m.folder === entry.folder && m.uid === entry.uid) || entry.mail;
        try {
          const generated = await draftReply({
            mail: { ...mail, body: clipForLlm(mail.bodyFull || mail.bodySnippet || '', config.scan.bodyCharsForLlm) },
            classification: entry,
            context: entry.context,
            client,
            config,
            instance,
          });

          const draft = {
            id: `draft_${entry.folder}_${entry.uid}`,
            instanceId: instance.id,
            runId: run.id,
            status: 'pending',
            source: {
              folder: entry.folder,
              uid: entry.uid,
              messageId: entry.mail.messageId,
              inReplyTo: entry.mail.inReplyTo,
              references: entry.mail.references,
              subject: entry.mail.subject,
              from: entry.mail.from,
              date: entry.mail.date,
              /** 来信正文快照：供「插入原文」与引文重生成使用，避免以后再去解析归档 */
              originalBody: String(mail.bodyFull || mail.bodySnippet || '').slice(0, ORIGINAL_BODY_SNAPSHOT_CHARS),
            },
            to: entry.mail.replyTo?.address || entry.mail.from?.address || '',
            cc: '',
            subject: generated.subject || ensureReplyPrefix(entry.mail.subject),
            body: generated.body,
            reason: generated.reason,
            notes: generated.notes,
            confidence: generated.confidence,
            language: generated.language,
            model: generated.model,
            usage: generated.usage,
            quoted: generated.quoted === true,
            quoteStyle: generated.quoteStyle || null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            mailbox: null,
            sentAt: null,
            sendResult: null,
            error: null,
          };

          if (config.draft.saveToMailbox && draftsBox) {
            try {
              const raw = buildMime({
                from: identitySender(instance.identity),
                to: draft.to,
                cc: draft.cc || undefined,
                replyTo: instance.identity.replyTo || undefined,
                subject: draft.subject,
                text: draft.body,
                inReplyTo: draft.source.inReplyTo || undefined,
                references: buildReferences(draft.source),
                messageId: makeMessageId(instance.identity.email, draft.subject),
              });
              const appended = await appendToMailbox(imap, draftsBox, raw, ['\\Draft']);
              if (appended) {
                draft.mailbox = { folder: appended.path, uid: appended.uid, savedAt: new Date().toISOString() };
              }
            } catch (err) {
              draft.error = `写入草稿箱失败：${err?.message || err}`;
              errors.push({ stage: 'appendDraft', uid: entry.uid, message: draft.error });
              log.warn(draft.error);
            }
          } else if (config.draft.saveToMailbox && !draftsBox) {
            draft.error = '未在服务器上找到草稿箱文件夹，草稿仅保存在本地';
          }

          store.addDraft(draft);
          draftRecords.push(draft);
          draftDone += 1;
          bump({ drafts: draftRecords.length });
          emit(run.id, {
            type: 'draft:created',
            draft: { id: draft.id, subject: draft.subject, to: draft.to, priority: entry.priority, error: draft.error },
            done: draftDone,
            total: toDraft.length,
          });
        } catch (err) {
          draftDone += 1;
          errors.push({ stage: 'draft', uid: entry.uid, subject: entry.mail?.subject, message: err?.message || String(err) });
          log.warn(`起草失败 UID=${entry.uid}：${err?.message || err}`);
          emit(run.id, { type: 'draft:failed', uid: entry.uid, message: err?.message || String(err) });
        }
        return null;
      });
      store.persistState();
    }

    /* ------------------------------------------------ 7. 简报 */
    phase('reporting', { message: '生成简报' });
    const stats = {
      total: enriched.length,
      needsReply: needsReply.length,
      drafts: draftRecords.length,
      skippedDrafts: skippedDraftCount,
      breakdown: breakdown(enriched),
      prioritized: sortByPriority(enriched),
    };
    const markdown = await generateDigest({ client, config, instance, stats, windowHours: hours, draftCount: draftRecords.length });
    const report = store.saveReport({
      instanceId: instance.id,
      runId: run.id,
      markdown,
      meta: { windowHours: hours, total: stats.total, needsReply: stats.needsReply, drafts: draftRecords.length, skippedDrafts: skippedDraftCount },
    });

    /*
     * 跟催扫描：放在分析之后。
     *
     * 「等谁回复」是纯本地线程匹配（免费）；「我承诺了什么」要用模型读我发出的邮件。
     * **它失败不能影响整次分析**——分析结果与报告已经落盘了，
     * 这里只把失败如实记进 run 的 errors，让用户看得到但不至于白跑一趟。
     */
    let followUp = null;
    try {
      followUp = await runFollowUpScan({ client, store, config });
    } catch (err) {
      errors.push({ stage: 'followup', message: err?.message || String(err) });
      log.warn(`跟催扫描失败（不影响本次分析结果）：${err?.message || err}`);
    }

    const result = {
      runId: run.id,
      instanceId: instance.id,
      instanceLabel: instance.label,
      windowHours: hours,
      windowLabel: describeWindow(hours),
      fetched: collected.length,
      analyzed: enriched.length,
      needsReply: needsReply.length,
      drafts: draftRecords.length,
      /** 因已有草稿（待审核或已发送）而跳过的数量 */
      skippedDrafts: skippedDraftCount,
      /**
       * 复用已有分析、没有重复调用模型的封数。
       * 与 `skippedDrafts` 的区别：那是"不再起草"，这是"连分类都不再花钱"。
       */
      reused: reusedCount,
      /** 取信被上限截断时的如实说明（空数组表示没有截断） */
      truncation,
      reportId: report.id,
      /** 跟催扫描结果（null = 未启用或未跑） */
      followUp,
      errors,
    };
    store.updateRun(run.id, {
      status: 'success',
      phase: 'done',
      finishedAt: new Date().toISOString(),
      errorCount: errors.length,
      result: { ...result, errors: undefined },
    });
    store.persistState();
    emit(run.id, { type: 'run:done', result, errors });
    return result;
  } catch (err) {
    const cancelled = err?.code === 'RUN_CANCELLED';
    store.updateRun(run.id, {
      status: cancelled ? 'cancelled' : 'failed',
      phase: cancelled ? 'cancelled' : 'error',
      finishedAt: new Date().toISOString(),
      error: err?.message || String(err),
      errorCount: errors.length + 1,
    });
    store.persistState();
    emit(run.id, { type: 'run:error', message: err?.message || String(err), code: err?.code || 'RUN_FAILED' });
    if (cancelled) return { runId: run.id, cancelled: true, errors };
    throw err;
  } finally {
    activeRuns.delete(instance.id);
    if (imap) await safeLogout(imap);
    // 释放账号许可：无论成功、失败还是排队超时，都要放，否则这个账号就再也用不了了
    releaseAccount?.();
  }
}

export function cancelRun(instanceId) {
  const active = activeRuns.get(instanceId);
  if (!active) return false;
  active.abort.cancelled = true;
  emit(active.runId, { type: 'run:cancelling' });
  return true;
}

/* ================================================================ 辅助 */

function breakdown(enriched) {
  const byType = {};
  const byPriority = {};
  for (const e of enriched) {
    byType[e.type] = (byType[e.type] || 0) + 1;
    byPriority[e.priority] = (byPriority[e.priority] || 0) + 1;
  }
  return { byType, byPriority };
}

function isOutgoing(instance, from) {
  const addr = String(from?.address || '').toLowerCase();
  if (!addr) return false;
  const own = new Set(
    [instance.identity.email, instance.imap.authUser, instance.smtp.authUser, instance.identity.replyTo]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase()),
  );
  return own.has(addr);
}

function buildReferences(source) {
  const refs = [...(source.references || [])];
  if (source.messageId && !refs.includes(source.messageId)) refs.push(source.messageId);
  return refs.slice(-20);
}

/* ------------------------------------------------------------ 简报生成 */

async function generateDigest({ client, config, instance, stats, windowHours, draftCount }) {
  const fallback = fallbackDigest({ stats, windowHours, draftCount });
  try {
    const prompt = buildReportPrompt({
      stats: { total: stats.total, needsReply: stats.needsReply },
      analyses: stats.prioritized,
      windowHours,
      drafts: draftCount,
    });
    const { text } = await client.complete({
      system: REPORT_SYSTEM,
      user: prompt,
      temperature: 0.4,
      maxTokens: 1200,
      jsonMode: false,
      label: '生成简报',
    });
    const md = String(text || '').trim();
    if (!md) return fallback;
    return [
      `# 邮件数字人简报 · ${instance.label}`,
      '',
      `> 统计窗口：${describeWindow(windowHours)} ｜ 共 ${stats.total} 封 ｜ 需回复 ${stats.needsReply} 封 ｜ 已起草 ${draftCount} 封${stats.skippedDrafts ? ` ｜ 已有草稿跳过 ${stats.skippedDrafts} 封` : ''}`,
      '',
      md,
      '',
      '---',
      '',
      '## 附录：逐封结论',
      '',
      ...stats.prioritized.map((a, i) => {
        const mail = a.mail || {};
        const labels = `**[${PRIORITY_LABELS[a.priority] || a.priority}] ${TYPE_LABELS[a.type] || a.type}**${a.needsReply ? ' · 需回复' : ''}`;
        return [
          `### ${i + 1}. ${mail.subject || '(无主题)'}`,
          '',
          `- ${labels}`,
          `- 发件人：${mail.from?.name ? `${mail.from.name} <${mail.from.address}>` : mail.from?.address || '未知'}`,
          `- 时间：${mail.date || '未知'}`,
          a.summary ? `- 要点：${a.summary}` : null,
          a.actions?.length ? `- 待办：${a.actions.join('；')}` : null,
          a.reason ? `- 判断依据：${a.reason}` : null,
          '',
        ]
          .filter(Boolean)
          .join('\n');
      }),
    ].join('\n');
  } catch (err) {
    log.warn(`简报生成失败，使用本地模板：${err?.message || err}`);
    return fallback;
  }
}

function fallbackDigest({ stats, windowHours, draftCount }) {
  const lines = [
    `# 邮件数字人简报`,
    '',
    `> 统计窗口：${describeWindow(windowHours)} ｜ 共 ${stats.total} 封 ｜ 需回复 ${stats.needsReply} 封 ｜ 已起草 ${draftCount} 封${stats.skippedDrafts ? ` ｜ 已有草稿跳过 ${stats.skippedDrafts} 封` : ''}`,
    '',
    '## 需要你处理',
    '',
  ];
  const needAction = stats.prioritized.filter((a) => a.needsReply);
  if (!needAction.length) lines.push('无', '');
  for (const a of needAction) {
    lines.push(
      `- **${a.mail?.subject || '(无主题)'}** — ${a.mail?.from?.address || ''}（${PRIORITY_LABELS[a.priority] || a.priority}）`,
      a.summary ? `  - ${a.summary}` : '',
    );
  }
  lines.push('', '## 值得知悉', '');
  const others = stats.prioritized.filter((a) => !a.needsReply).slice(0, 20);
  if (!others.length) lines.push('无', '');
  for (const a of others) {
    lines.push(`- [${TYPE_LABELS[a.type] || a.type}] ${a.mail?.subject || '(无主题)'} — ${a.mail?.from?.address || ''}`);
  }
  lines.push('', '## 建议动作', '', draftCount > 0 ? `1. 在界面中审核 ${draftCount} 封草稿并逐封确认发送。` : '1. 暂无需要发出的回复。');
  if (stats.skippedDrafts) lines.push(`2. 另有 ${stats.skippedDrafts} 封邮件已有草稿（待审核或已发送），本次未重复起草。`);
  return lines.filter((l) => l !== undefined).join('\n');
}

/* ------------------------------------------------------------ 单封重分析 */

/** 对已有分析记录重新起草（用户手动触发）。 */
export async function redraftOne({ folder, uid, instanceId, userInstruction }) {
  const config = getConfig();
  const instance = getInstance(instanceId);
  const entry = store.getAnalysis(folder, uid);
  if (!entry) throw new AppError('未找到该邮件的分析记录，请先运行一次分析。', { code: 'ANALYSIS_NOT_FOUND', status: 404 });

  const client = new LlmClient(config.llm);
  const raw = store.readRaw(folder, uid, entry.mail?.messageId);
  let body = '';
  if (raw) {
    const parsed = await parseMessage(raw);
    body = clipForLlm(stripQuoted(parsed.body), config.scan.bodyCharsForLlm);
  }
  const generated = await draftReply({
    mail: { ...entry.mail, body, bodyFull: body },
    classification: entry,
    context: entry.context || [],
    client,
    config,
    instance,
    userInstruction,
  });
  return { generated, entry, instance };
}
