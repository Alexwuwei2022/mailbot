/**
 * 把当前配置里的签名补进已有草稿正文。
 *
 * 用于「先有草稿、后配置签名」的情况：草稿是用户要审核的内容，
 * 因此不自动改写，而是提供一个显式操作 + 界面提示。
 *
 * 位置规则：签名必须在**引文之前**（顺序：新正文 → 签名 → 引文）。
 * 早期实现用「正文是否以签名结尾」判断，加了引文之后签名不再位于末尾，
 * 于是这里会误判为"缺签名"，而 appendSignature 又是包含式幂等 —— 结果点了没反应、
 * 横幅永远消不掉。现在统一用 hasSignature / inspectSignatureOrder 判断。
 */

import { getConfig, getInstance } from '../config/index.js';
import { AppError, log } from '../lib/util.js';
import { appendSignature, fixSignatureOrder, inspectSignatureOrder, normalizeSignature, upgradeLegacySignature } from '../mail/signature.js';
import * as store from '../store/state.js';

/**
 * @param {object} options
 * @param {string[]} [options.ids] 指定草稿 id；省略则处理全部未发送草稿
 * @param {string} [options.instanceId]
 * @param {boolean} [options.reorderOnly] 只整理位置（把引文下面的签名搬回上面），不新增签名
 * @returns {{signature: string, applied: Array, skipped: Array, total: number}}
 */
export function applySignatureToDrafts({ ids, instanceId, reorderOnly = false } = {}) {
  const config = getConfig();
  const signature = normalizeSignature(config.draft.signature);
  if (!signature) {
    throw new AppError('尚未配置签名。请在「设置 → 分析起草策略 → 签名」中填写后再试。', {
      code: 'SIGNATURE_NOT_CONFIGURED',
      status: 400,
    });
  }

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

    const order = inspectSignatureOrder(body, signature);
    if (order.ok) {
      skipped.push({ id: draft.id, reason: '已包含当前签名' });
      continue;
    }

    // 情况一：签名存在但被引文挤到了下面 → 搬回引文之前
    if (order.misplaced) {
      const fixed = fixSignatureOrder(body, signature);
      store.updateDraft(draft.id, {
        body: fixed.body,
        signatureAppliedAt: new Date().toISOString(),
        mailbox: draft.mailbox ? { ...draft.mailbox, stale: true } : null,
      });
      applied.push({ id: draft.id, subject: draft.subject, mode: 'reordered', addedChars: fixed.body.length - body.length });
      continue;
    }

    if (reorderOnly) {
      skipped.push({ id: draft.id, reason: '正文里没有当前签名（本次只整理位置）' });
      continue;
    }

    // 情况二：确实没有签名 → 插到引文之前
    let senderName = '';
    try {
      senderName = getInstance(draft.instanceId).identity.name || '';
    } catch {
      senderName = '';
    }
    const upgraded = upgradeLegacySignature(body, signature, senderName);
    const next = upgraded.replaced ? upgraded.body : appendSignature(body, signature);
    const after = inspectSignatureOrder(next, signature);
    if (!after.ok) {
      skipped.push({ id: draft.id, reason: '插入后仍未通过位置校验，已跳过' });
      continue;
    }

    store.updateDraft(draft.id, {
      body: next,
      signatureAppliedAt: new Date().toISOString(),
      // 已同步到草稿箱的副本内容已变，标记为过期，提示重新同步
      mailbox: draft.mailbox ? { ...draft.mailbox, stale: true } : null,
    });
    applied.push({
      id: draft.id,
      subject: draft.subject,
      mode: upgraded.replaced ? 'replaced' : 'appended',
      addedChars: next.length - body.length,
    });
  }

  store.persistState();
  if (applied.length) {
    const reordered = applied.filter((a) => a.mode === 'reordered').length;
    log.info(`已为 ${applied.length} 封草稿处理签名（其中 ${reordered} 封仅调整了位置）`);
  }
  return { signature, applied, skipped, total: targets.length };
}

/** 草稿正文是否已经带上当前签名（且位于引文之上）。供界面提示用。 */
export function draftHasCurrentSignature(draft, signature) {
  const sign = normalizeSignature(signature);
  if (!sign) return false;
  return inspectSignatureOrder(draft?.body, sign).ok;
}
