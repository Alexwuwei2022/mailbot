/**
 * 分析层：把邮件交给大模型做分类判断，并为需要回复的邮件起草回复。
 */

import { AppError, chunk, clampNumber, log, mapLimit, truncate } from '../lib/util.js';
import { CLASSIFY_SYSTEM, REPLY_SYSTEM, buildClassifyPrompt, buildReplyPrompt } from '../llm/prompts.js';
import { appendSignature, normalizeSignature } from '../mail/signature.js';
import { attachQuote } from '../mail/quote.js';

const TYPES = new Set([
  'action_required',
  'question',
  'meeting',
  'notification',
  'newsletter',
  'fyi',
  'social',
  'spam',
]);
const PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3 };

export const TYPE_LABELS = {
  action_required: '待处理',
  question: '询问',
  meeting: '会议',
  notification: '通知',
  newsletter: '订阅',
  fyi: '知会',
  social: '社交通知',
  spam: '垃圾/钓鱼',
};

export const PRIORITY_LABELS = { urgent: '紧急', high: '高', normal: '普通', low: '低' };

/* ------------------------------------------------------------ 分类 */

/**
 * @param {object} params
 * @param {Array} params.mails 已附带正文的邮件
 * @param {LlmClient} params.client
 * @param {object} params.config
 * @param {(p:object)=>void} params.onProgress
 */
export async function classifyMails({ mails, client, config, onProgress }) {
  const batchSize = clampNumber(config.llm.classifyBatchSize, 1, 50, 12);
  const batches = chunk(mails, batchSize);
  let done = 0;

  const batchResults = await mapLimit(batches, Math.max(1, config.draft.concurrency), async (batch, batchIndex) => {
    const prompt = buildClassifyPrompt(batch, config.scan.windowHours);
    try {
      const { data, model } = await client.completeJson({
        system: CLASSIFY_SYSTEM,
        user: prompt,
        temperature: 0.1,
        label: `邮件分类（第 ${batchIndex + 1}/${batches.length} 批）`,
      });
      done += batch.length;
      onProgress?.({ done, total: mails.length, batch: batchIndex + 1, batches: batches.length });
      const items = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
      return normalizeClassificationBatch(items, batch, model);
    } catch (err) {
      log.warn(`第 ${batchIndex + 1} 批分类失败：${err?.message || err}`);
      done += batch.length;
      onProgress?.({ done, total: mails.length, batch: batchIndex + 1, batches: batches.length, failed: true });
      return batch.map((mail) => fallbackClassification(mail, err));
    }
  });

  const flat = batchResults.flat().filter(Boolean);
  const byUid = new Map(flat.map((a) => [`${a.folder}:${a.uid}`, a]));
  return mails.map((mail) => byUid.get(`${mail.folder}:${mail.uid}`) || fallbackClassification(mail, null));
}

function normalizeClassificationBatch(items, batch, model) {
  const used = new Set();
  const pickItem = (mail, position) => {
    // 先按 index 匹配（1-based），再按位置回退
    let found = items.find((it) => Number(it?.index) === position + 1 && !used.has(it));
    if (!found) found = items.find((it) => !used.has(it) && it?.subject && mail.subject && it.subject === mail.subject);
    if (!found) found = items[position];
    if (found) used.add(found);
    return found || {};
  };

  return batch.map((mail, position) => {
    const item = pickItem(mail, position);
    const type = TYPES.has(item.type) ? item.type : 'fyi';
    const priority = PRIORITIES.has(item.priority) ? item.priority : 'normal';
    const needsReply = typeof item.needsReply === 'boolean' ? item.needsReply : ['action_required', 'question'].includes(type);
    /*
     * 「需留意」：不需要回复，但有明确时限/需要亲自去办（到期提醒、待确认的会议…）。
     * 与 needsReply 互斥——需要回复的已经进了「需要你处理」，不该在两处同时出现。
     * 历史记录没有这个字段 → undefined → 当作 false（不改变旧数据的行为）。
     */
    const worthNoting = type === 'spam' || needsReply ? false : item.worthNoting === true;
    /*
     * 项目标签：用于把同一件事的邮件、日程、跟催串成时间线。
     *
     * 三道归一化都是必要的：
     *   - 去空格 + 限长（模型偶尔会写一整句）；
     *   - 垃圾/营销/验证码一律归空——它们不属于任何项目，
     *     给它们编标签只会把时间线冲垮；
     *   - 只留一个短标签，不做同义词合并（那需要用户确认，放在 /api/projects 里做）。
     */
    const projectRaw = typeof item.project === 'string' ? item.project.trim().replace(/\s+/g, '') : '';
    const project = type === 'spam' ? '' : tidyProject(projectRaw);
    return {
      folder: mail.folder,
      uid: mail.uid,
      messageId: mail.messageId,
      type,
      priority,
      needsReply: type === 'spam' ? false : needsReply,
      worthNoting,
      project,
      summary: typeof item.summary === 'string' ? item.summary.trim() : '',
      actions: Array.isArray(item.actions) ? item.actions.filter((a) => typeof a === 'string' && a.trim()).slice(0, 5) : [],
      language: typeof item.language === 'string' ? item.language : null,
      reason: typeof item.reason === 'string' ? item.reason.trim() : '',
      model: model || null,
      analyzedAt: new Date().toISOString(),
      failed: false,
    };
  });
}

/**
 * 项目标签归一化。
 *
 * 长度上限与"明显不是项目"的排除都在这里做：标签一旦脏了，
 * 时间线就会变成一堆只有一封邮件的碎片，比没有时间线更糟。
 */
export function tidyProject(value, max = 16) {
  const p = String(value || '')
    .replace(/\s+/g, '')
    .replace(/^[\[【（(]+|[\]】）)]+$/g, '')
    .trim();
  if (!p) return '';
  if (p.length > max) return '';
  // 通用词当标签没有区分度（"邮件""通知""工作"），等于没归类
  if (/^(邮件|通知|公告|提醒|其他|其它|工作|事务|日常|无|none|null|n\/a)$/i.test(p)) return '';
  return p;
}

function fallbackClassification(mail, err) {
  return {
    folder: mail.folder,
    uid: mail.uid,
    messageId: mail.messageId,
    type: 'fyi',
    priority: 'normal',
    needsReply: false,
    // 记录形状必须与正常路径一致：漏了这个字段会让下游拿到 undefined
    worthNoting: false,
    project: '',
    summary: '',
    actions: [],
    language: null,
    reason: err ? `模型分析失败，已降级：${truncate(err.message || String(err), 120)}` : '模型未返回该封的结论',
    model: null,
    analyzedAt: new Date().toISOString(),
    failed: !!err,
  };
}

export function sortByPriority(analyses) {
  return [...analyses].sort((a, b) => {
    const p = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
    if (p !== 0) return p;
    return new Date(b.mail?.date || 0) - new Date(a.mail?.date || 0);
  });
}

/* ------------------------------------------------------------ 起草 */

/**
 * 为一封邮件起草回复。
 * @returns {Promise<object>} draft 片段（不含状态字段）
 */
export async function draftReply({ mail, classification, context, client, config, instance, userInstruction }) {
  const prompt = buildReplyPrompt({
    mail,
    classification,
    context,
    options: {
      userName: instance.identity.name || instance.identity.email,
      signature: config.draft.signature,
      tone: config.draft.tone,
      language: config.draft.language,
      userInstruction,
    },
  });

  const { data, usage, model } = await client.completeJson({
    system: REPLY_SYSTEM,
    user: prompt,
    temperature: 0.4,
    label: `起草回复：${truncate(mail.subject || '', 40)}`,
  });

  const rawBody = typeof data.body === 'string' ? data.body.replace(/\r\n/g, '\n').trim() : '';
  if (!rawBody) throw new AppError('模型未返回回复正文', { code: 'LLM_EMPTY_DRAFT', status: 502 });

  // 落款由程序确定性地追加（模型被明确要求不写署名）
  const signed = appendSignature(rawBody, config.draft.signature);

  // 引文必须加在**签名之下**：顺序为「新正文 → 签名 → 引文」。
  // 原文优先用调用方给的 bodyFull（引擎里已剥离引用历史），其次用送给模型的那段。
  const originalBody = mail.bodyFull || mail.body || mail.bodySnippet || '';
  const quoteResult = attachQuote({
    body: signed,
    mail,
    originalBody,
    config,
    timeZone: config.calendar?.timeZone,
  });
  const body = quoteResult.body;

  let subject = typeof data.subject === 'string' && data.subject.trim() ? data.subject.trim() : `Re: ${mail.subject || ''}`;
  if (!/^(re|答复|回复)\s*[:：]/i.test(subject)) subject = `Re: ${subject}`;

  const notes = Array.isArray(data.notes)
    ? data.notes.filter((n) => typeof n === 'string' && n.trim()).slice(0, 6)
    : typeof data.notes === 'string' && data.notes.trim()
      ? [data.notes.trim()]
      : [];

  return {
    subject,
    body,
    reason: typeof data.reason === 'string' ? data.reason.trim() : '',
    notes,
    language: typeof data.language === 'string' ? data.language : null,
    confidence: typeof data.confidence === 'number' ? Math.max(0, Math.min(1, data.confidence)) : null,
    usage: usage || null,
    model: model || null,
    signatureApplied: !!normalizeSignature(config.draft.signature),
    /** 是否带上了原始邮件引文；以及用的哪种风格（供界面提示与测试） */
    quoted: quoteResult.quoted,
    quoteStyle: quoteResult.quoteStyle,
    generatedAt: new Date().toISOString(),
  };
}
