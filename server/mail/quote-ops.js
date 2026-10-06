/**
 * 把原始邮件引文补进已有草稿正文。
 *
 * 与「插入签名」同样的理由：草稿是用户要审核的内容，**不自动改写**，
 * 只提供显式操作 + 界面提示。用于「先有草稿、后开启引文」的情况
 * （例如草稿是升级前生成的，或用户中途把 `draft.quoteOriginal` 打开了）。
 *
 * 安全边界：已发送的草稿绝不动（那是已经发出去的证据）。
 */

import { getConfig } from '../config/index.js';
import { log } from '../lib/util.js';
import { appendQuote, buildQuoteBlock, hasQuote, QUOTE_STYLES } from './quote.js';
import { parseMessage, splitQuoted } from './parse.js';
import * as store from '../store/state.js';

/**
 * @param {object} options
 * @param {string[]} [options.ids] 指定草稿 id；省略则处理全部未发送草稿
 * @param {string} [options.instanceId]
 * @returns {Promise<{style: string, applied: Array, skipped: Array, total: number}>}
 */
export async function applyQuoteToDrafts({ ids, instanceId } = {}) {
  const config = getConfig();
  const style = QUOTE_STYLES.includes(config.draft.quoteStyle) ? config.draft.quoteStyle : 'zh-client';

  const targets = store
    .listDrafts({ instanceId })
    .filter((d) => (ids?.length ? ids.includes(d.id) : true))
    .filter((d) => d.status !== 'sent');

  const applied = [];
  const skipped = [];

  for (const draft of targets) {
    const body = String(draft.body || '').replace(/\r\n/g, '\n').trimEnd();
    if (!body) {
      skipped.push({ id: draft.id, reason: '正文为空' });
      continue;
    }
    if (hasQuote(body, style)) {
      skipped.push({ id: draft.id, reason: '已包含引文' });
      continue;
    }

    const record = draft.source?.uid ? store.getAnalysis(draft.source.folder, draft.source.uid) : null;
    const originalBody = await resolveOriginalBody(draft, record);
    if (!originalBody) {
      skipped.push({ id: draft.id, reason: '本地没有这封邮件的原文，无法生成引文' });
      continue;
    }

    const quote = buildQuoteBlock({
      mail: record?.mail || draft.source || {},
      body: originalBody,
      timeZone: config.calendar?.timeZone,
      style,
      maxChars: config.draft.quoteMaxChars,
    });
    const next = appendQuote(body, quote, style);

    store.updateDraft(draft.id, {
      body: next,
      quoted: true,
      quoteStyle: style,
      quotedAt: new Date().toISOString(),
      // 正文变了，草稿箱副本已过期
      mailbox: draft.mailbox ? { ...draft.mailbox, stale: true } : null,
    });
    applied.push({ id: draft.id, subject: draft.subject, addedChars: next.length - body.length });
  }

  store.persistState();
  if (applied.length) log.info(`已为 ${applied.length} 封草稿补上原始邮件引文（风格 ${style}）`);
  return { style, applied, skipped, total: targets.length };
}

/**
 * 草稿对应的原始来信正文（只取"新内容"，避免引文滚雪球）。
 *
 * 三种来源，按可靠性排序：
 *   1. 起草时留下的快照 `draft.source.originalBody`（最准，且不用再解析）
 *   2. 本地归档原文 `data/raw/*.eml`（老草稿走这条路）
 *   3. 分析记录里的摘要（最后兜底，内容可能不全）
 */
async function resolveOriginalBody(draft, record) {
  const snapshot = draft.source?.originalBody;
  if (snapshot) return splitQuoted(snapshot).fresh;

  const { folder, uid } = draft.source || {};
  if (folder && uid) {
    const raw = store.findRaw(folder, uid);
    if (raw) {
      try {
        const parsed = await parseMessage(raw);
        const { fresh } = splitQuoted(parsed.body);
        if (fresh) return fresh;
      } catch (err) {
        log.debug(`读取归档原文失败（${folder}:${uid}）：${err?.message || err}`);
      }
    }
  }
  const snippet = record?.mail?.snippet || '';
  return snippet ? splitQuoted(snippet).fresh : '';
}

/** 草稿正文是否已经带上引文（供界面提示用）。 */
export function draftHasQuote(draft, style) {
  const s = QUOTE_STYLES.includes(style) ? style : 'zh-client';
  return hasQuote(draft?.body, s);
}
