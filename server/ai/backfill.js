/**
 * 按需扩展分析范围。
 *
 * 背景：检索最初只在「本地已分析的邮件」里过滤，而常规分析只覆盖最近 24 小时。
 * 于是「查这个月某个人发来的邮件」会查不到——不是检索逻辑错，而是候选集本身不含这些邮件。
 *
 * 这里在检索前做一次**按需回补**：
 *   1. 先用 IMAP 服务端条件（时间 + 发件人）把候选邮件取回来，避免把整个月的邮件全拉下来；
 *   2. 跳过本地已分析过的（按 folder:uid 去重）；
 *   3. 只对新增的做一次分类分析并落库（含收件人身份判定）；
 *   4. 之后的检索就能命中它们了。
 *
 * 成本控制：单次回补有数量上限（默认 40 封），并且只分析新邮件；
 * 达到上限时如实告知用户「还有更多未纳入」，而不是假装查全了。
 */

import { getConfig, getInstance } from '../config/index.js';
import { log } from '../lib/util.js';
import { LlmClient } from '../llm/client.js';
import { classifyMails } from './analyze.js';
import { clipForLlm, makeSnippet, parseMessage, stripQuoted } from '../mail/parse.js';
import { classifyRecipient } from '../mail/recipient.js';
import { connect, fetchHeaders, fetchRawSourceWithin, safeLogout, searchUids } from '../mail/imap.js';
import { dayKey, zonedTimeToUtc } from '../calendar/time.js';
import * as store from '../store/state.js';

/** 单次检索最多回补分析多少封（防止一次查询烧掉大量 token）。 */
const MAX_BACKFILL = 40;

/**
 * 判断某个时间范围是否已经超出本地覆盖，需要回补。
 *
 * 本地已分析邮件的最早日期按**配置时区**折算成日期键，才能和 filters.dateFrom（本地日期）直接比较。
 * @returns {{needed: boolean, reason: string, missingFrom: string|null}}
 */
export function backfillNeeded(records, filters, timeZone) {
  const keys = records
    .map((r) => localDayKey(r.mail?.date || r.analyzedAt, timeZone))
    .filter(Boolean)
    .sort();
  if (!keys.length) {
    return { needed: true, reason: '本地还没有任何已分析的邮件', missingFrom: filters.dateFrom };
  }
  const oldest = keys[0];
  if (filters.dateFrom < oldest) {
    return {
      needed: true,
      reason: `检索起始日期 ${filters.dateFrom} 早于本地已分析的最早日期 ${oldest}`,
      missingFrom: filters.dateFrom,
    };
  }
  return { needed: false, reason: '', missingFrom: null };
}

/** 单次向 IMAP 索取的最大 UID 数。 */
const MAX_UID_SCAN = 5000;
/** 单次信封拉取的批量大小。 */
const ENVELOPE_BATCH = 250;
/**
 * 信封扫描总量上限（安全阀）。
 * 信封很小，整月通常几百封；这个上限只用于兜住「过去一年」这类超大范围查询。
 */
const MAX_ENVELOPE_SCAN = 3000;
/** 正文分析总量上限（安全阀）：信封命中极多时不至于无限分析。 */
const MAX_ANALYZE = 200;

/**
 * 第一步：拿到时间范围内的全部 UID。
 *
 * 不能直接「按 SINCE 拉最新 N 封信封」——那样会把时间中段/较早的邮件整段丢掉
 * （真实案例：一个月 356 封只取了最新 212 封，目标发件人的 10 封全在更早的位置）。
 * 先取全量 UID（很轻），再在本地做时间与发件人筛选，最后只对命中项拉信封与正文。
 */
async function collectUids({ instance, filters, client, timeZone }) {
  const config = getConfig();
  const out = [];
  const errors = [];
  const perFolder = {};
  // SINCE 的粒度是「天」，且由服务器按它自己的时区解释，因此这里故意用**本地零点对应的时刻**：
  // 例如本地 09-01 00:00 (+08:00) = 08-31 16:00 UTC，序列化成 31-Aug，比目标范围多一天。
  // 多取一天的代价只是头部扫描多一点，而少取一天会直接把边界邮件漏掉——宁可多，不可少。
  const since = localDayStart(filters.dateFrom, timeZone);
  for (const folder of config.scan.folders) {
    try {
      const { uids, total } = await searchUids(instance, { folder, since, client });
      perFolder[folder] = { matched: uids.length, total };
      const capped = uids.length > MAX_UID_SCAN ? uids.slice(-MAX_UID_SCAN) : uids;
      for (const uid of capped) {
        if (store.getAnalysis(folder, uid)) continue; // 已分析过的跳过，避免重复花 token
        out.push({ folder, uid });
      }
    } catch (err) {
      errors.push({ folder, message: err?.message || String(err) });
      log.warn(`回补无法读取 ${folder} 的 UID 列表：${err?.message || err}`);
    }
  }
  return { items: out, errors, perFolder };
}

/** 判断信封是否可能属于该发件人（关键词匹配到姓名或地址）。 */
function matchesSender(summary, terms) {
  if (!terms.length) return true;
  const hay = `${summary.from?.name || ''} ${summary.from?.address || ''}`.toLowerCase();
  return terms.some((t) => hay.includes(t));
}

/**
 * 把时刻换算成配置时区下的日期键（YYYY-MM-DD）。
 *
 * 日期边界必须按时区判断：邮件时间戳是 UTC，而用户（和邮件客户端）按本地时区看日期。
 * 例如 08-31 17:51 UTC 在北京时间属于 09-01——若按 UTC 日期比较会被挡在「9 月」之外。
 */
function localDayKey(value, timeZone) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return dayKey(d, timeZone);
}

/**
 * 把「本地日期」（YYYY-MM-DD）换算成该时区当天 00:00 的真实瞬间。
 * 用于给 IMAP 的 SINCE 一个「不早于目标范围」的下界。
 */
function localDayStart(day, timeZone) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(day || ''));
  if (!m) return new Date(0);
  return zonedTimeToUtc({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }, timeZone);
}

/** 判断信封是否落在检索时间范围内（按配置时区比较日期）。 */
function inDateRange(summary, filters, timeZone) {
  const key = summary.date ? localDayKey(summary.date, timeZone) : null;
  if (!key) return true; // 信封没给时间时不武断丢弃，交给后续分析
  return key >= filters.dateFrom && key <= filters.dateTo;
}

/**
 * 第二步：拉信封并精筛。
 *
 * 关键点一：**信封很小，整段拉完再筛**。有些服务器对 `UID FETCH 一段 UID` 的返回顺序不保证，
 * 若只取「最新 N 个 UID」的信封会漏掉时间中段的目标邮件。
 *
 * 关键点二：**不用 IMAP 的 ENVELOPE**。实测部分企业邮箱在大批量 `ENVELOPE` 查询下会
 * **确定性丢失响应**（60 封只回 41 封，且每次都缺同一批），而 `BODY[HEADER]` 稳定可靠。
 * 因此这里改用 fetchHeaders（头部查询 + 本地解析）。发件人过滤也必须在本地做，
 * 因为服务端 FROM 条件同样不可靠（实测有的服务器直接忽略它）。
 */
async function resolveCandidates({ instance, filters, items, client, maxEnvelopes, timeZone, onProgress }) {
  const byFolder = new Map();
  for (const it of items) {
    if (!byFolder.has(it.folder)) byFolder.set(it.folder, []);
    byFolder.get(it.folder).push(it.uid);
  }

  const matched = [];
  let scanned = 0;
  const errors = [];

  for (const [folder, uidsRaw] of byFolder) {
    const uids = [...uidsRaw];
    for (let i = 0; i < uids.length; i += ENVELOPE_BATCH) {
      if (scanned >= maxEnvelopes) break;
      const batch = uids.slice(i, i + ENVELOPE_BATCH);
      let summaries = [];
      try {
        summaries = await fetchHeaders(instance, { folder, uids: batch, client });
      } catch (err) {
        errors.push({ folder, message: err?.message || String(err) });
        log.warn(`回补拉取头部失败（${folder}）：${err?.message || err}`);
        break;
      }
      scanned += summaries.length;
      for (const s of summaries) {
        if (!inDateRange(s, filters, timeZone)) continue;
        if (!matchesSender(s, filters.from)) continue;
        matched.push({ ...s, folder });
      }
      onProgress?.({ phase: 'filtering', message: `已扫描 ${scanned} 封头部，命中 ${matched.length} 封` });
    }
  }

  // 按时间升序返回，便于后续按序分析
  matched.sort((a, b) => new Date(a.date || 0) - new Date(b.date || 0));
  return { candidates: matched, scanned, errors };
}

/**
 * 分析并落库一批邮件（含收件人身份判定）。
 * fetchRawSourceWithin 依赖信箱已被打开，因此这里按文件夹显式打开一次。
 */
async function analyzeCandidates({ instance, candidates, client: llm, imap, config, onProgress }) {
  if (!candidates.length) return { analyzed: 0, failed: 0, total: 0 };

  const fetched = [];
  const byFolder = new Map();
  for (const c of candidates) {
    if (!byFolder.has(c.folder)) byFolder.set(c.folder, []);
    byFolder.get(c.folder).push(c);
  }

  for (const [folder, list] of byFolder) {
    let lock;
    try {
      lock = await imap.getMailboxLock(folder, { readOnly: true });
    } catch (err) {
      log.warn(`回补无法打开 ${folder}：${err?.message || err}`);
      continue;
    }
    try {
      for (const c of list) {
        try {
          const raw = await fetchRawSourceWithin(imap, c.uid);
          if (!raw) throw new Error('服务器未返回原文');
          const parsed = await parseMessage(raw);
          store.saveRaw(c.folder, c.uid, c.messageId || parsed.messageId, raw);
          const body = stripQuoted(parsed.body);
          fetched.push({
            ...c,
            subject: parsed.subject || c.subject,
            inReplyTo: parsed.inReplyTo || c.inReplyTo,
            references: parsed.references || [],
            attachments: parsed.attachments?.length ? parsed.attachments : c.attachments,
            bodyFull: body,
            bodySnippet: makeSnippet(body, config.scan.snippetChars),
          });
        } catch (err) {
          log.debug(`回补读取失败 UID=${c.uid}：${err?.message || err}`);
        }
      }
    } finally {
      lock.release();
    }
  }

  if (!fetched.length) return { analyzed: 0, failed: candidates.length, total: candidates.length };

  const forLlm = fetched.map((m) => ({ ...m, body: clipForLlm(m.bodyFull || m.bodySnippet, config.scan.bodyCharsForLlm) }));
  const classifications = await classifyMails({
    mails: forLlm,
    client: llm,
    config,
    onProgress: (p) => onProgress?.({ ...p, phase: 'analyzing' }),
  });

  const enriched = fetched.map((mail, i) => {
    const classification = classifications[i];
    const recipient = classifyRecipient(mail, instance);
    return {
      ...classification,
      instanceId: instance.id,
      recipientKind: recipient.kind,
      isDirect: recipient.isDirect,
      isCcOnly: recipient.isCcOnly,
      onDemand: true,
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
      context: [],
    };
  });

  store.upsertAnalyses(enriched.map((e) => ({ ...e, runId: null })));
  store.persistState();
  const failed = enriched.filter((e) => e.failed).length;
  log.info(`按需回补：拉取 ${fetched.length} 封，分析完成 ${enriched.length - failed} 封，失败 ${failed} 封`);
  return { analyzed: enriched.length - failed, failed, total: candidates.length, records: enriched };
}

/**
 * 主入口：确保本地分析覆盖到 filters 指定的范围。
 *
 * @returns {Promise<{attempted: boolean, fetched: number, analyzed: number, truncated: boolean, errors: Array, note: string}>}
 */
export async function ensureCoverage({ instanceId, filters, onProgress } = {}) {
  const config = getConfig();
  const timeZone = config.calendar?.timeZone || 'Asia/Shanghai';
  const instance = getInstance(instanceId);
  const records = store.listAnalyses({ instanceId: instance.id, limit: 5000 });
  const check = backfillNeeded(records, filters, timeZone);
  const skipped = { attempted: false, fetched: 0, analyzed: 0, truncated: false, errors: [], note: '', reason: check.reason };
  if (!check.needed) return skipped;

  // 实例配置不完整时不去连：否则用户看到的是「IMAP 认证失败」，
  // 而真实原因只是邮箱还没配好——那是另一个问题，不该混在检索结果里。
  if (!instance.imap?.host || !instance.imap?.authUser || !instance.imap?.authPass) {
    return {
      ...skipped,
      reason: '邮箱未配置完整，无法按需拉取',
      note: '本地未覆盖该时间段，且邮箱配置不完整（缺少 IMAP 服务器/账号/授权码），无法按需拉取。请先到「设置 → 邮箱账户」补全配置。',
    };
  }

  const budget = config.search?.backfillMax ?? MAX_BACKFILL;
  const maxEnvelopes = Math.min(MAX_ENVELOPE_SCAN, Math.max(budget * 8, 600));
  const llm = new LlmClient(config.llm);

  // 整段回补只开一条 IMAP 连接（企业邮箱通常限制并发连接数）
  let imap;
  try {
    imap = await connect(instance);
    onProgress?.({ phase: 'searching', message: `正在列出 ${check.missingFrom} 以来的邮件…` });
    const { items, errors, perFolder } = await collectUids({ instance, filters, client: imap, timeZone });
    if (!items.length) {
      return {
        ...skipped,
        attempted: true,
        errors,
        perFolder,
        note: errors.length
          ? `按需拉取失败：${errors.map((e) => `${e.folder}: ${e.message}`).join('；')}`
          : '按需检查后发现该范围内没有尚未分析的邮件。',
      };
    }

    onProgress?.({ phase: 'filtering', message: `在 ${items.length} 封未分析邮件中筛选…` });
    const { candidates, scanned, errors: filterErrors } = await resolveCandidates({
      instance,
      filters,
      items,
      client: imap,
      maxEnvelopes,
      timeZone,
      onProgress,
    });
    const allErrors = [...errors, ...filterErrors];

    if (!candidates.length) {
      return {
        ...skipped,
        attempted: true,
        errors: allErrors,
        perFolder,
        scanned,
        note: allErrors.length
          ? `按需拉取部分失败：${allErrors.map((e) => `${e.folder}: ${e.message}`).join('；')}`
          : `按需扫描了 ${scanned} 封信封，没有符合时间与发件人条件的。`,
      };
    }

    const analyzeLimit = Math.min(budget, MAX_ANALYZE);
    const toAnalyze = candidates.slice(0, analyzeLimit);
    onProgress?.({ phase: 'analyzing', message: `正在按需分析 ${toAnalyze.length} 封邮件…`, total: toAnalyze.length });
    const res = await analyzeCandidates({ instance, candidates: toAnalyze, client: llm, imap, config, onProgress });

    const truncated = candidates.length > toAnalyze.length;
    return {
      attempted: true,
      fetched: toAnalyze.length,
      matched: candidates.length,
      scanned,
      analyzed: res.analyzed,
      failed: res.failed,
      truncated,
      errors: allErrors,
      perFolder,
      note: truncated
        ? `匹配到 ${candidates.length} 封，本次只分析了最新的 ${toAnalyze.length} 封（上限 ${analyzeLimit}）。可把「检索按需回补上限」调大后重试。`
        : '',
      reason: check.reason,
    };
  } finally {
    if (imap) await safeLogout(imap);
  }
}

export { MAX_BACKFILL };
