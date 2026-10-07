/**
 * 草稿服务：本地草稿的增删改，以及「逐封人工确认后发送」。
 *
 * 发送策略由 config.draft.sendPolicy 与 config.web.allowSend 双重控制：
 *   - draft_only : 任何情况下都不允许从界面发送
 *   - confirm    : 必须携带 confirm=true 才真正发出（默认）
 *   - auto       : 允许批量发送接口；界面仍会二次确认
 */

import { getConfig, getInstance } from '../config/index.js';
import { AppError, log, retry, splitEmails } from '../lib/util.js';
import { LlmClient } from '../llm/client.js';
import { draftReply } from '../ai/analyze.js';
import {
  appendToMailbox,
  connect,
  deleteMessage,
  findDraftsMailbox,
  listMailboxes,
  safeLogout,
} from '../mail/imap.js';
import { buildMime, ensureReplyPrefix, identitySender, mailTimeZone, makeMessageId } from '../mail/compose.js';
import { acquireAccount } from '../mail/account-lock.js';
import { hasQuote } from '../mail/quote.js';
import { safeFilename } from '../mail/parse.js';
import { appendAudit } from '../store/audit.js';
import { inspectSignatureOrder, normalizeSignature } from '../mail/signature.js';
import {
  attachmentsUsage,
  encodedSizeOf,
  readAttachmentFile,
  removeAttachmentFile,
  saveAttachmentFile,
  totalEncodedSize,
} from '../store/attachments.js';
import { resetTransportPools, sendRaw } from '../mail/smtp.js';
import { setConfigReloadHook } from '../config/index.js';
import * as store from '../store/state.js';

// 配置一旦变化（主机/账号/授权码/认证方式），旧 SMTP 连接池必须丢弃
setConfigReloadHook(() => resetTransportPools());

function requireSendAllowed(config) {
  if (config.draft.sendPolicy === 'draft_only' || config.web.allowSend === false) {
    throw new AppError('当前配置为「只生成草稿，不发送」，发送已被禁用。可在「设置」中调整发送策略。', {
      code: 'SEND_DISABLED',
      status: 403,
    });
  }
}

function mergeReferences(draft) {
  const refs = [...(draft.source?.references || [])];
  if (draft.source?.messageId && !refs.includes(draft.source.messageId)) refs.push(draft.source.messageId);
  return refs.slice(-20);
}

/**
 * 用当前草稿内容重新组装 MIME（草稿箱同步 / 发送共用）。
 *
 * `date` 可以显式传入：发送时把「Date 头 / IMAP internal date / 本地 sentAt」
 * 统一成同一个瞬间，避免三处各取一次「现在」而出现毫秒级差异。
 */
function composeRaw(instance, draft, { date = new Date() } = {}) {
  return buildMime({
    from: identitySender(instance.identity),
    to: draft.to,
    cc: draft.cc || undefined,
    bcc: draft.bcc || undefined,
    replyTo: instance.identity.replyTo || undefined,
    subject: draft.subject,
    text: draft.body,
    html: draft.html || undefined,
    inReplyTo: draft.source?.inReplyTo || undefined,
    references: mergeReferences(draft),
    messageId: makeMessageId(instance.identity.email, draft.subject),
    date,
    timeZone: mailTimeZone(),
    // 附件内容从 data/attachments 读回（草稿记录里只有元数据）
    attachments: readDraftAttachments(draft),
  });
}

/**
 * 读回草稿的全部附件内容。
 *
 * 读不到内容的附件（文件被清理或丢失）会被**跳过并记录**，而不是让整封发送失败——
 * 但要留下日志，因为"以为发了附件结果没发"是很严重的静默失败。
 */
function readDraftAttachments(draft) {
  const list = Array.isArray(draft.attachments) ? draft.attachments : [];
  const out = [];
  for (const a of list) {
    const content = readAttachmentFile(a);
    if (!content) {
      log.warn(`附件内容缺失，已跳过：${a.filename}（${a.file || '无文件'}）`);
      continue;
    }
    out.push({ filename: a.filename, contentType: a.contentType, content });
  }
  return out;
}

/** 附件总量（编码后）与上限校验。发送前必须调用。 */
export function checkAttachmentBudget(draft) {
  const config = getConfig();
  const list = Array.isArray(draft.attachments) ? draft.attachments : [];
  const limit = config.draft.attachmentMaxBytes;
  const encoded = totalEncodedSize(list);
  const actual = list.reduce((s, a) => s + (Number(a.size) || 0), 0);
  return {
    count: list.length,
    actualBytes: actual,
    encodedBytes: encoded,
    limitBytes: limit,
    overBudget: encoded > limit,
    /** 还能再加多少原始字节（粗略） */
    remainingActualBytes: Math.max(0, Math.floor((limit - encoded) / (4 / 3))),
  };
}

/**
 * 给草稿补上「是否已带当前签名」的判断。
 *
 * 必须在服务端算：判断规则与「插入签名」共用同一套实现（包含 + 位于引文之上），
 * 否则前端各写一份就又会分叉——上一版就是前端用 `endsWith`、服务端用包含式幂等，
 * 结果横幅永远消不掉。
 */
function decorate(draft) {
  const config = getConfig();
  const signature = normalizeSignature(config.draft.signature);
  const style = config.draft.quoteStyle === 'prefix' ? 'prefix' : 'zh-client';
  const order = inspectSignatureOrder(draft.body, signature);
  return {
    ...draft,
    analysis: store.getAnalysis(draft.source?.folder, draft.source?.uid) || null,
    /** 正文里是否已经带了当前签名（且位置正确） */
    hasSignature: !!signature && order.ok,
    /** 签名存在但被引文挤到了下面——需要「整理署名位置」 */
    signatureMisplaced: !!signature && order.misplaced,
    quoted: hasQuote(draft.body, style) || draft.quoted === true,
    /*
     * 附件体积预算由服务端算好下发。
     * 界面虽然也能自己估算，但"能不能发"的判定必须与后端一致，
     * 否则会出现"界面说没问题、发出去被拒"的尴尬。
     */
    attachmentBudget: checkAttachmentBudget(draft),
  };
}

/* ------------------------------------------------------------ 读取 */

export function listDrafts(filter = {}) {
  return store.listDrafts(filter).map(decorate);
}

export function getDraft(id) {
  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  return decorate(draft);
}

/* ------------------------------------------------------------ 修改 */

export function updateDraft(id, patch = {}) {
  const current = store.getDraft(id);
  if (!current) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  if (current.status === 'sent' || current.status === 'sending') {
    throw new AppError('该草稿已发送，不能修改。', { code: 'DRAFT_ALREADY_SENT', status: 409 });
  }
  const allowed = ['to', 'cc', 'bcc', 'subject', 'body', 'html', 'reason', 'notes'];
  const clean = {};
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    if (key === 'notes') clean.notes = Array.isArray(patch.notes) ? patch.notes : String(patch.notes).split('\n').filter(Boolean);
    else clean[key] = String(patch[key]);
  }
  if (clean.to !== undefined && splitEmails(clean.to).length === 0) {
    throw new AppError('收件人不能为空', { code: 'DRAFT_NO_RECIPIENT', status: 400 });
  }
  if (clean.subject !== undefined && !clean.subject.trim()) {
    clean.subject = ensureReplyPrefix(current.source?.subject || '');
  }
  const updated = store.updateDraft(id, { ...clean, status: current.status === 'failed' ? 'pending' : current.status, error: null });
  store.persistState();
  return updated;
}

export function deleteDraft(id) {
  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  if (draft.status === 'sending') throw new AppError('草稿正在发送中', { code: 'DRAFT_BUSY', status: 409 });
  // 先清附件内容再删记录：否则 data/attachments 会攒下一堆没人引用的文件
  const freed = removeDraftAttachmentFiles(draft);
  store.removeDraft(id);
  store.persistState();
  appendAudit('draft.delete', {
    target: draft.subject || '(无主题)',
    source: draft.status === 'sent' ? '删除已发送草稿' : '删除待审核草稿',
    // to 可能是字符串（旧记录/测试）也可能是数组，统一交给 splitEmails
    extra: { to: splitEmails(draft.to).join(', '), freedAttachments: freed },
  });
  return { ok: true, deleted: id, freedAttachments: freed };
}

/* ------------------------------------------------------------ 附件 */

/** 删除某封草稿的全部附件文件，返回删除个数。 */
function removeDraftAttachmentFiles(draft) {
  const list = Array.isArray(draft?.attachments) ? draft.attachments : [];
  let n = 0;
  for (const a of list) {
    if (removeAttachmentFile(a)) n += 1;
  }
  return n;
}

/**
 * 给草稿添加一个附件。
 *
 * 体积规则：
 *   - 单个附件编码后超过总上限 → 直接拒绝（它自己就发不出去，留着只会让人白等）；
 *   - 累计超限 → **允许上传但不允许发送**，由界面提示删掉别的附件——
 *     直接拒绝会让用户困惑"为什么这个能传那个不能"。
 *
 * @param {string} id 草稿 id
 * @param {object} input { filename, contentType, buffer }
 */
export function addDraftAttachment(id, { filename, contentType, buffer }) {
  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  if (draft.status === 'sent') throw new AppError('该草稿已发送，不能再改附件。', { code: 'DRAFT_ALREADY_SENT', status: 409 });
  if (draft.status === 'sending') throw new AppError('草稿正在发送中', { code: 'DRAFT_BUSY', status: 409 });

  const config = getConfig();
  if (!buffer || !buffer.length) throw new AppError('附件内容为空', { code: 'ATTACHMENT_EMPTY', status: 400 });
  const limit = config.draft.attachmentMaxBytes;
  if (encodedSizeOf(buffer.length) > limit) {
    throw new AppError(
      `这个附件编码后约 ${fmtMb(encodedSizeOf(buffer.length))}，已超过单封上限 ${fmtMb(limit)}。请改用邮件里的下载链接或压缩后再发。`,
      { code: 'ATTACHMENT_TOO_LARGE', status: 413 },
    );
  }
  const current = Array.isArray(draft.attachments) ? draft.attachments : [];
  if (current.length >= config.draft.maxAttachments) {
    throw new AppError(`单封草稿最多 ${config.draft.maxAttachments} 个附件`, { code: 'TOO_MANY_ATTACHMENTS', status: 400 });
  }

  const saved = saveAttachmentFile({ filename: safeFilename(filename, `附件-${current.length + 1}`), contentType, buffer });
  const updated = store.updateDraft(id, { attachments: [...current, saved] });
  store.persistState();
  const budget = checkAttachmentBudget(updated);
  return { draft: { ...decorate(updated), attachmentBudget: budget }, attachment: saved, budget };
}

/** 移除某封草稿的附件（同时删除文件）。 */
export function removeDraftAttachment(id, attachmentId) {
  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  if (draft.status === 'sent') throw new AppError('该草稿已发送，不能再改附件。', { code: 'DRAFT_ALREADY_SENT', status: 409 });
  const current = Array.isArray(draft.attachments) ? draft.attachments : [];
  const target = current.find((a) => a.id === attachmentId);
  if (!target) throw new AppError('附件不存在', { code: 'ATTACHMENT_NOT_FOUND', status: 404 });
  removeAttachmentFile(target);
  const updated = store.updateDraft(id, { attachments: current.filter((a) => a.id !== attachmentId) });
  store.persistState();
  const budget = checkAttachmentBudget(updated);
  return { draft: { ...decorate(updated), attachmentBudget: budget }, budget };
}

/** 读取单个附件内容（供界面下载/核对）。 */
export function getDraftAttachment(id, attachmentId) {
  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  const target = (draft.attachments || []).find((a) => a.id === attachmentId);
  if (!target) throw new AppError('附件不存在', { code: 'ATTACHMENT_NOT_FOUND', status: 404 });
  const content = readAttachmentFile(target);
  if (!content) throw new AppError('附件内容已丢失（可能已被清理）', { code: 'ATTACHMENT_CONTENT_MISSING', status: 410 });
  return { attachment: target, content };
}

/** 发送成功后清理附件内容：记录保留（便于回看发了什么），文件删掉（内容已在服务器邮件里）。 */
function cleanupSentAttachments(draft) {
  const list = Array.isArray(draft?.attachments) ? draft.attachments : [];
  if (!list.length) return 0;
  let n = 0;
  for (const a of list) {
    if (removeAttachmentFile(a)) n += 1;
  }
  if (n) log.info(`发送成功，已清理 ${n} 个附件的本地副本`);
  return n;
}

/** 供界面展示的附件统计（banner 用）。 */
export function attachmentSummary() {
  const usage = attachmentsUsage();
  return { ...usage, maxBytes: getConfig().draft.attachmentMaxBytes };
}

function fmtMb(bytes) {
  return `${(Number(bytes) / 1048576).toFixed(1)} MB`;
}

/**
 * 用 AI 重新起草（可附额外指令）。
 */
export async function regenerateDraft(id, userInstruction) {
  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  if (draft.status === 'sent') throw new AppError('该草稿已发送，不能重新起草。', { code: 'DRAFT_ALREADY_SENT', status: 409 });

  const config = getConfig();
  const instance = getInstance(draft.instanceId);
  const client = new LlmClient(config.llm);
  const record = draft.source?.uid ? store.getAnalysis(draft.source.folder, draft.source.uid) : null;
  const raw = draft.source?.uid ? store.readRaw(draft.source.folder, draft.source.uid, draft.source.messageId) : null;

  let body = '';
  if (raw) {
    const { parseMessage, stripQuoted, clipForLlm } = await import('../mail/parse.js');
    const parsed = await parseMessage(raw);
    body = clipForLlm(stripQuoted(parsed.body), config.scan.bodyCharsForLlm);
  }

  const generated = await draftReply({
    mail: { ...(record?.mail || draft.source), body, bodyFull: body },
    classification: record || { type: 'action_required', priority: 'normal', summary: draft.reason },
    context: record?.context || [],
    client,
    config,
    instance,
    userInstruction,
  });

  const updated = store.updateDraft(id, {
    subject: generated.subject,
    body: generated.body,
    reason: generated.reason,
    notes: generated.notes,
    confidence: generated.confidence,
    model: generated.model,
    quoted: generated.quoted === true,
    quoteStyle: generated.quoteStyle || null,
    regeneratedAt: new Date().toISOString(),
    status: 'pending',
    error: null,
    // 记下来信正文快照：以后再「插入原文」/重新生成引文就不必回源解析
    source: { ...(draft.source || {}), originalBody: String(draft.source?.originalBody || body || '').slice(0, 8000) },
  });
  store.persistState();
  // 若已同步到服务器草稿箱，尝试覆盖（无法原地替换时给出提示）
  let mailboxNote = null;
  if (draft.mailbox?.uid && config.draft.saveToMailbox) {
    mailboxNote = '草稿已更新；邮箱草稿箱里仍是旧版本，可点「同步到草稿箱」后替换旧草稿。';
  }
  return { draft: updated, mailboxNote };
}

/**
 * 把当前草稿内容写入邮箱草稿箱。
 *
 * IMAP 的 APPEND 只能新建，不能原地替换，所以**每次同步都要先删掉上一份**：
 * 否则反复点「同步到草稿箱」会在服务器上留下一串同名副本，
 * 既占空间，也容易让人在手机/Outlook 里挑到旧版本发出去。
 * 删除是 best-effort：删不掉（例如已被手动清理）不影响本次写入。
 */
export async function syncDraftToMailbox(id) {
  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  const config = getConfig();
  const instance = getInstance(draft.instanceId);

  let imap;
  let releaseAccount = null;
  try {
    // 写草稿箱也是这个账号上的 IMAP 操作，同样排队（不要在一次分析旁边多开一条连接）
    releaseAccount = await acquireAccount(instance, { label: `同步草稿到草稿箱（${instance.label}）` });
    imap = await connect(instance);
    const draftsBox = await findDraftsMailbox(imap, config.draft.draftsMailbox);
    if (!draftsBox) throw new AppError('服务器上未找到草稿箱文件夹（\\Drafts）', { code: 'DRAFTS_MAILBOX_MISSING', status: 404 });

    let replaced = null;
    const previous = draft.mailbox;
    if (previous?.uid) {
      try {
        await deleteMessage(imap, previous.folder || draftsBox, previous.uid);
        replaced = { folder: previous.folder || draftsBox, uid: previous.uid };
      } catch (err) {
        log.warn(`清理旧草稿副本失败（${previous.folder} #${previous.uid}）：${err?.message || err}`);
      }
    }

    const appended = await appendToMailbox(imap, draftsBox, composeRaw(instance, draft), ['\\Draft']);
    const updated = store.updateDraft(id, {
      mailbox: appended ? { folder: appended.path, uid: appended.uid, savedAt: new Date().toISOString() } : null,
      error: appended ? null : '服务器未确认草稿写入',
    });
    store.persistState();
    // 往服务器草稿箱里写东西也是改外部状态，留台账
    appendAudit('draft.sync', {
      target: draft.subject || '(无主题)',
      source: '同步到邮箱草稿箱',
      extra: { folder: draftsBox, uid: appended?.uid ?? null, replacedPrevious: !!replaced },
    });
    return { draft: updated, mailbox: updated.mailbox, replaced };
  } finally {
    if (imap) await safeLogout(imap);
    releaseAccount?.();
  }
}

/* ------------------------------------------------------------ 发送 */

/**
 * 发送一封草稿。必须显式 confirm=true。
 * @param {string} id
 * @param {object} options { confirm, deleteMailboxDraft, appendToSent }
 */
export async function sendDraft(id, options = {}) {
  const config = getConfig();
  requireSendAllowed(config);

  const { confirm = false, deleteMailboxDraft = true, appendToSent } = options;
  if (!confirm) {
    throw new AppError('发送需要人工确认：请在界面点击确认，或传入 confirm=true。', {
      code: 'CONFIRM_REQUIRED',
      status: 428,
    });
  }

  const draft = store.getDraft(id);
  if (!draft) throw new AppError('草稿不存在', { code: 'DRAFT_NOT_FOUND', status: 404 });
  if (draft.status === 'sending') throw new AppError('该草稿正在发送中', { code: 'DRAFT_BUSY', status: 409 });
  if (draft.status === 'sent') throw new AppError('该草稿已发送，请勿重复发送。', { code: 'DRAFT_ALREADY_SENT', status: 409 });

  const recipients = splitEmails(draft.to);
  if (recipients.length === 0) throw new AppError('收件人为空，无法发送', { code: 'DRAFT_NO_RECIPIENT', status: 400 });

  /*
   * 附件体积必须在**发送前**拦住。
   *
   * base64 编码会让体积膨胀约 1/3：一个 18 MB 的附件编码后 24 MB，
   * 而多数企业邮箱的上限是 20 MB。如果不拦，用户会看到一句来自服务器的
   * "message too large"，既看不懂也不知道该怎么办。
   */
  const budget = checkAttachmentBudget(draft);
  if (budget.overBudget) {
    throw new AppError(
      `附件太大：${budget.count} 个附件合计约 ${fmtMb(budget.actualBytes)}，编码后约 ${fmtMb(budget.encodedBytes)}，` +
        `超过单封上限 ${fmtMb(budget.limitBytes)}。请删掉部分附件，或改用压缩包/网盘链接。`,
      { code: 'ATTACHMENT_BUDGET_EXCEEDED', status: 413, detail: budget },
    );
  }

  const instance = getInstance(draft.instanceId);
  store.updateDraft(id, { status: 'sending', error: null });
  store.persistState();

  try {
    // 用与草稿箱完全一致的 MIME 原文发送，保证「发出 = 审核所见」
    const raw = composeRaw(instance, draft);
    const sender = identitySender(instance.identity);
    const result = await sendRaw(instance, raw, {
      envelope: {
        from: sender?.address,
        to: [...recipients, ...splitEmails(draft.cc), ...splitEmails(draft.bcc)],
      },
      label: `发送回复：${draft.subject}`,
    });

    // 发送成功后：清理服务器草稿副本 + 追加到已发送（按需）
    const notes = [];
    const wantSent = appendToSent ?? config.draft.appendToSent ?? false;
    if ((deleteMailboxDraft && draft.mailbox?.uid) || wantSent) {
      let imap;
      let releaseAccount = null;
      try {
        /*
         * 邮件已经发出去了，这里只是收尾（清服务器草稿副本 / 归档到已发送），
         * 因此**不能因为邮箱正忙就把整次发送判失败**：排队等一小会儿，等不到就照旧只记一条 note。
         */
        releaseAccount = await acquireAccount(instance, {
          label: `发送后收尾（${instance.label}）`,
          waitMs: 10_000,
        });
        imap = await connect(instance);
        if (deleteMailboxDraft && draft.mailbox?.uid) {
          try {
            await deleteMessage(imap, draft.mailbox.folder, draft.mailbox.uid);
            notes.push('已从服务器草稿箱移除该草稿');
          } catch (err) {
            notes.push(`服务器草稿清理失败：${err?.message || err}（可手动删除）`);
          }
        }
        if (wantSent) {
          const boxes = await listMailboxes(imap);
          const sentBox =
            config.draft.sentMailbox ||
            boxes.find((b) => b.specialUse === '\\Sent')?.path ||
            boxes.find((b) => /^(sent|已发送)(邮件)?$/i.test(b.name))?.path;
          if (sentBox) {
            await appendToMailbox(imap, sentBox, composeRaw(instance, draft), ['\\Seen']);
            notes.push(`已归档到 ${sentBox}`);
          } else {
            notes.push('未找到「已发送」文件夹，未做归档');
          }
        }
      } catch (err) {
        log.warn(`发送后处理失败：${err?.message || err}`);
        notes.push(`发送后处理失败：${err?.message || err}`);
      } finally {
        if (imap) await safeLogout(imap);
        releaseAccount?.();
      }
    }

    const updated = store.updateDraft(id, {
      status: 'sent',
      sentAt: new Date().toISOString(),
      sendResult: { ...result, notes },
      mailbox: deleteMailboxDraft ? null : draft.mailbox,
      error: null,
    });
    store.persistState();
    /*
     * 内容已经随邮件发出去了，本地附件副本就没必要再占磁盘：
     * 保留元数据（名字/大小）以便回看"这封发了什么"，删掉文件本体。
     * 已经发过的那封邮件在服务器上仍然是完整的。
     */
    const freed = cleanupSentAttachments(draft);
    const finalDraft = freed ? store.updateDraft(id, { attachmentsCleanedAt: new Date().toISOString() }) : updated;
    if (freed) store.persistState();
    log.info(`草稿 ${id} 已发送至 ${recipients.join(', ')}`);
    // 发信是不可撤回的写操作，必须留台账（含收件人与主题，便于事后核对）
    appendAudit('draft.send', {
      target: draft.subject || '(无主题)',
      source: '界面确认发送',
      extra: {
        to: recipients.join(', '),
        cc: splitEmails(draft.cc).join(', ') || null,
        attachments: (draft.attachments || []).map((a) => a.filename).filter(Boolean),
        messageId: result?.messageId || null,
        notes,
      },
    });
    return { draft: finalDraft || updated, result: { ...result, notes } };
  } catch (err) {
    store.updateDraft(id, { status: 'failed', error: err?.message || String(err) });
    appendAudit('draft.send', {
      target: draft.subject || '(无主题)',
      source: '界面确认发送',
      ok: false,
      error: err?.message || String(err),
      extra: { to: recipients.join(', ') },
    });
    store.persistState();
    throw err;
  }
}

/** 批量发送（仍需 confirm=true）。任一失败不影响其它。 */
export async function sendDrafts(ids, options = {}) {
  const results = [];
  for (const id of ids) {
    try {
      const r = await sendDraft(id, options);
      results.push({ id, ok: true, messageId: r.result.messageId, notes: r.result.notes });
    } catch (err) {
      results.push({ id, ok: false, code: err?.code || 'SEND_FAILED', message: err?.message || String(err) });
    }
  }
  return results;
}
