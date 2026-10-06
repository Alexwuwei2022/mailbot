/**
 * 收件人身份判定：这封邮件是「直接发给我」还是「抄送给我」。
 *
 * 为什么要单独判定：两者在行动含义上完全不同——
 *   直接发给我 = 需要我处理，可以起草回复；
 *   仅抄送给我 = 需要我知悉/关注，但通常不该由我回复（回复会越权，也容易造成职责混乱）。
 * 因此分析阶段就要把结论固化下来，后续视图与知识库直接按它分组。
 */

/**
 * @param {object} mail 邮件（from/to/cc/replyTo）
 * @param {object} instance 邮箱实例（identity/authUser）
 * @returns {{kind: 'direct'|'cc'|'bcc'|'self'|'unknown', isDirect: boolean, isCcOnly: boolean, matched: string[]}}
 */
export function classifyRecipient(mail, instance) {
  const own = ownAddresses(instance);
  if (!own.size) return { kind: 'unknown', isDirect: false, isCcOnly: false, matched: [] };

  const fromAddr = norm(mail?.from?.address);
  // 自己发的（已发送邮件或自己给自己）不参与「需要我处理/关注」的判断
  if (fromAddr && own.has(fromAddr)) {
    return { kind: 'self', isDirect: false, isCcOnly: false, matched: [fromAddr] };
  }

  const to = addresses(mail?.to).filter((a) => own.has(a));
  const cc = addresses(mail?.cc).filter((a) => own.has(a));
  const bcc = addresses(mail?.bcc).filter((a) => own.has(a));
  const matched = [...new Set([...to, ...cc, ...bcc])];

  if (to.length) return { kind: 'direct', isDirect: true, isCcOnly: false, matched };
  if (cc.length) return { kind: 'cc', isDirect: false, isCcOnly: true, matched };
  if (bcc.length) return { kind: 'bcc', isDirect: false, isCcOnly: true, matched };
  // 既不在 To 也不在 Cc：可能是邮件列表/别名投递，保守按「知悉」处理而不是「需要处理」
  return { kind: 'unknown', isDirect: false, isCcOnly: false, matched: [] };
}

/** 本邮箱所有「属于我」的地址。 */
export function ownAddresses(instance) {
  const list = [
    instance?.identity?.email,
    instance?.identity?.replyTo,
    instance?.imap?.authUser,
    instance?.smtp?.authUser,
  ]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().trim())
    .filter((s) => s.includes('@'));
  return new Set(list);
}

function norm(value) {
  const s = String(value || '').toLowerCase().trim();
  return s.includes('@') ? s : '';
}

function addresses(list) {
  if (!Array.isArray(list)) return [];
  return list.map((a) => (typeof a === 'string' ? norm(a) : norm(a?.address))).filter(Boolean);
}

/**
 * 「需要你关注」= 仅抄送我 + 高优先级。
 * 这类邮件值得放到显眼位置，但不进入起草队列。
 */
export function isCcAttention(analysis) {
  return analysis?.recipientKind === 'cc' && ['urgent', 'high'].includes(analysis?.priority);
}

/**
 * 「需要我处理」= 直接发给我 + 高优先级 + 确实需要回复。
 * 只保留高优先级，低优先级的直接投递不再占用首页的注意力。
 */
export function isDirectAction(analysis) {
  if (!analysis?.needsReply) return false;
  if (!['urgent', 'high'].includes(analysis?.priority)) return false;
  // 兼容历史数据：早期分析记录没有 recipientKind 字段，按「直接发给我」处理以免丢失待办
  if (analysis.recipientKind === undefined) return true;
  return analysis.recipientKind === 'direct';
}

/**
 * 「需留意」= 不需要回复，但有明确时限或需要你亲自去办。
 *
 * 与「需要你处理」的区别：那里是**要你回信**，这里是**别错过 / 要你动手**。
 *
 * 为什么不用本地规则推断（例如"有 actions 就算"）：实测模型几乎给**每一封**都填了
 * actions（连日用电费账单都有"按需查看并缴纳"），那样「需留意」会变成第二个收件箱，
 * 把首页注意力又淹了。所以判定权交给逐封分类的 `worthNoting`，这里只做**收敛**：
 *   - 垃圾邮件与纯知会（fyi）不进；
 *   - 低优先级不进（可延后的事不该占首页）；
 *   - 需要回复的不进（已在上面的清单里，避免同一封出现两次）。
 */
export function isWorthNoting(analysis) {
  if (!analysis?.worthNoting) return false;
  if (analysis.type === 'spam' || analysis.type === 'fyi') return false;
  if (analysis.priority === 'low') return false;
  if (isDirectAction(analysis)) return false;
  return true;
}
