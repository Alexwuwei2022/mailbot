/**
 * 按项目时间线：把同一件事的**邮件、日程、我发出的邮件、跟催**合成一条按时间排序的线。
 *
 * ## 三条设计原则
 *
 * 1. **聚合全在本地**。分类时模型只给一个 `project` 短标签，剩下的事情
 *    （分组、排序、计数、合并）全是确定性代码——模型不参与，也就不会出现
 *    "同一件事这次算在一起、下次算开了"的情况。
 *
 * 2. **标签会飘，所以必须能人工收拾**。模型今天写「华东区投标」、明天写「华东投标」，
 *    这不是模型的错（它没有记忆），但用户会看到时间线碎成两半。
 *    因此提供**重命名/合并**：把 B 并入 A 之后，历史记录会被一起改写，
 *    并把这个旧名字记成 A 的别名，**下次扫描再遇到 B 也会归到 A**。
 *
 * 3. **每条都要能说清"从哪来"**。时间线混了四类数据，界面上必须标注来源
 *    （邮件 / 我发出的 / 日程 / 跟催），否则用户看到一个标题会不知道它是什么。
 */

/** 项目标签的匹配键：忽略大小写、空格与常见标点。 */
export function projectKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s·・,，.。:：;；\-—_/\\|()（）[\]【】]+/g, '');
}

/**
 * 项目登记表：把分析记录里出现过的标签，加上用户登记过的别名，合成一份清单。
 *
 * 别名的作用是"让合并结果活下来"：用户把「华东投标」并进「华东区投标」之后，
 * 后续邮件即使又写成「华东投标」，也要落到同一个项目里。
 *
 * @returns {Array<{key, name, count, aliases, lastAt, hasFollowUp}>}
 */
export function listProjects({ analyses = [], drafts = [], followUps = {}, registry = {}, now = new Date() } = {}) {
  const byKey = new Map();

  const touch = (name) => {
    const key = projectKey(name);
    if (!key) return null;
    if (!byKey.has(key)) byKey.set(key, { key, name: String(name).trim(), count: 0, aliases: [], sources: {}, lastAt: null });
    return byKey.get(key);
  };

  // ① 用户登记过的项目先建出来（即使暂时没有邮件，也不该从清单里消失）
  for (const rec of Object.values(registry || {})) {
    if (!rec?.name) continue;
    const hit = touch(rec.name);
    if (hit) hit.aliases = Array.isArray(rec.aliases) ? rec.aliases.slice() : [];
  }

  /** 别名 → 规范名（用户登记过的合并关系优先） */
  const aliasTo = new Map();
  for (const rec of Object.values(registry || {})) {
    if (!rec?.name) continue;
    for (const a of rec.aliases || []) aliasTo.set(projectKey(a), projectKey(rec.name));
  }
  const canonical = (name) => {
    const k = projectKey(name);
    return aliasTo.get(k) || k;
  };

  const add = (name, at, source) => {
    const key = canonical(name);
    if (!key) return;
    if (!byKey.has(key)) {
      // 规范名用别名指向的目标；取登记表里的原名更稳定
      const target = Object.values(registry || {}).find((r) => projectKey(r?.name) === key);
      byKey.set(key, { key, name: target?.name || String(name).trim(), count: 0, aliases: target?.aliases || [], sources: {}, lastAt: null });
    }
    const rec = byKey.get(key);
    rec.count += 1;
    rec.sources[source] = (rec.sources[source] || 0) + 1;
    if (at && (!rec.lastAt || new Date(at) > new Date(rec.lastAt))) rec.lastAt = at;
  };

  for (const a of analyses) {
    if (!a?.project) continue;
    add(a.project, a.mail?.date || a.analyzedAt, 'mail');
  }
  for (const d of drafts) {
    if (!d?.project) continue;
    add(d.project, d.sentAt || d.createdAt, 'draft');
  }
  for (const f of Object.values(followUps || {})) {
    if (!f?.project) continue;
    add(f.project, f.since || f.createdAt, 'followUp');
  }

  return [...byKey.values()].sort((a, b) => b.count - a.count || String(a.name).localeCompare(String(b.name)));
}

/**
 * 组装一条时间线。
 *
 * @param {object} params
 * @param {string} params.project 项目名（可为空 = 未归类）
 * @param {Array} params.analyses 分析记录
 * @param {Array} params.drafts 草稿（会挑出已发送的）
 * @param {object} params.followUps 跟催表
 * @param {Array} params.audit 操作台账记录（日程的本地来源，见下）
 *
 * 日程为什么从台账取：日程的真身在 Google 上，本地只有操作留痕
 * （`calendar.event.create/update/delete` 的 target 就是标题）。
 * 这样时间线**完全离线可用**，代价是"别人在 Google 上直接建的日程看不到"——
 * 这一点在界面上要如实说明，不能让用户以为这就是全部日程。
 */
export function buildTimeline({ project = '', analyses = [], drafts = [], followUps = {}, audit = [] } = {}) {
  const want = projectKey(project);
  const match = (name) => (want ? projectKey(name) === want : !projectKey(name));
  const entries = [];

  for (const a of analyses) {
    if (!match(a.project)) continue;
    entries.push({
      at: a.mail?.date || a.analyzedAt,
      kind: 'mail',
      source: '收到的邮件',
      title: a.mail?.subject || '(无主题)',
      detail: a.summary || '',
      meta: {
        from: a.mail?.from?.name || a.mail?.from?.address || '',
        needsReply: !!a.needsReply,
        worthNoting: !!a.worthNoting,
        priority: a.priority || 'normal',
        folder: a.folder,
        uid: a.uid,
      },
    });
  }

  for (const d of drafts) {
    if (d?.status !== 'sent' || !match(d.project)) continue;
    entries.push({
      at: d.sentAt || d.createdAt,
      kind: 'draft',
      source: '我发出的邮件',
      title: d.subject || '(无主题)',
      detail: '',
      meta: { to: Array.isArray(d.to) ? d.to.join(', ') : d.to || '', draftId: d.id, messageId: d.messageId || null },
    });
  }

  for (const f of Object.values(followUps || {})) {
    if (!match(f.project)) continue;
    entries.push({
      at: f.since || f.createdAt,
      kind: 'followUp',
      source: f.kind === 'mine' ? '我的承诺' : '等对方回复',
      title: f.title || '(无标题)',
      detail: f.detail || '',
      meta: { status: f.status, dueAt: f.dueAt || null, counterparty: f.counterparty || '', id: f.id },
    });
  }

  /*
   * 日程：只认带项目标签的台账记录。
   * 台账里的日程标题不一定等于项目名，所以这里用"标题包含项目名"来匹配——
   * 宁可少收几条，也不要凭时间相近硬塞进来（那是编造关联）。
   */
  for (const r of audit) {
    if (!/^calendar\.event\.(create|update)$/.test(r?.action || '')) continue;
    /*
     * 「未归类」视图**不包含日程**：台账里的日程只有标题，没有项目标签，
     * 我们无从判断它属于谁。硬塞进去等于编造关联，比少显示更糟。
     */
    if (!want) continue;
    const title = r.target || '';
    if (!title) continue;
    if (!projectKey(title).includes(want)) continue;
    entries.push({
      at: r.at,
      kind: 'calendar',
      source: '日程',
      title,
      detail: r.extra?.when || '',
      meta: { action: r.action, eventId: r.extra?.eventId || null, localOnly: true },
    });
  }

  return entries
    .filter((e) => e.at && !Number.isNaN(new Date(e.at).getTime()))
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

/**
 * 把 `from` 合并进 `to`。
 *
 * 三件事一起做，缺一不可：
 *   ① 改写历史记录里的标签（否则时间线里旧的那半还在）；
 *   ② 把旧名记成别名（否则下次扫描又冒出来）；
 *   ③ 返回改了多少条，让界面能如实告诉用户"合并了什么"。
 *
 * @returns {{moved: {analyses, drafts, followUps}, registry}}
 */
export function mergeProjects({ from, to, analyses = [], drafts = [], followUps = {}, registry = {} }) {
  const fromName = String(from || '').trim();
  const toName = String(to || '').trim();
  if (!fromName || !toName) return { moved: { analyses: 0, drafts: 0, followUps: 0 }, registry };
  if (projectKey(fromName) === projectKey(toName)) {
    return { moved: { analyses: 0, drafts: 0, followUps: 0 }, registry };
  }

  // ① 历史记录：这里只**返回改写后的对象**，落盘交给调用方（保持本模块无副作用）
  let aCount = 0;
  const nextAnalyses = analyses.map((a) => {
    if (projectKey(a?.project) !== projectKey(fromName)) return a;
    aCount += 1;
    return { ...a, project: toName };
  });
  let dCount = 0;
  const nextDrafts = drafts.map((d) => {
    if (projectKey(d?.project) !== projectKey(fromName)) return d;
    dCount += 1;
    return { ...d, project: toName };
  });
  let fCount = 0;
  const nextFollowUps = {};
  for (const [id, f] of Object.entries(followUps || {})) {
    if (projectKey(f?.project) !== projectKey(fromName)) {
      nextFollowUps[id] = f;
      continue;
    }
    fCount += 1;
    nextFollowUps[id] = { ...f, project: toName };
  }

  // ② 登记表：目标项目存在则并入别名，否则新建
  const nextRegistry = { ...(registry || {}) };
  const targetKey = projectKey(toName);
  let target = Object.values(nextRegistry).find((r) => projectKey(r?.name) === targetKey);
  const aliases = new Set([...(target?.aliases || []), fromName]);
  if (projectKey(fromName)) aliases.add(fromName);
  if (target) {
    nextRegistry[target.key || targetKey] = { ...target, name: toName, aliases: [...aliases] };
  } else {
    nextRegistry[targetKey] = { key: targetKey, name: toName, aliases: [...aliases], createdAt: new Date().toISOString() };
  }
  // 把被合并掉的那个项目条目删掉（它已经变成别名了）
  for (const [k, rec] of Object.entries(nextRegistry)) {
    if (k !== (target?.key || targetKey) && projectKey(rec?.name) === projectKey(fromName)) delete nextRegistry[k];
  }

  return { moved: { analyses: aCount, drafts: dCount, followUps: fCount }, nextAnalyses, nextDrafts, nextFollowUps, registry: nextRegistry };
}
