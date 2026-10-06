/** 总览页：近 24 小时邮件结论、需要处理的清单、简报。 */

import { api } from '../api.js';
import { clear, confirmDialog, copyButton, fmtAddress, fmtFull, fmtMailTime, h, initials, makeActivatable, mount, openModal, scrollToEl, toast } from '../dom.js';
import { extractSummaryParagraph, renderMarkdown } from '../markdown.js';
import { typeMeta, typeTag } from '../type-meta.js';
import { icon } from '../icons.js';
import { invalidate as invalidateView, markLoaded, needsReload, renderInto, viewState } from '../view-state.js';

const PRIORITY_CLASS = { urgent: 'p-urgent', high: 'p-high', normal: 'p-normal', low: 'p-low' };

/** 只看紧急/高优先的筛选。 */
function applyPriorityFilter(list, state) {
  return state.priorityOnly ? list.filter((i) => ['urgent', 'high'].includes(i.priority)) : list;
}

export function renderOverview(root, app) {
  // 状态托管给 app：切走再切回保留展开/折叠等阅读位置
  const { state } = viewState(app, 'overview', () => ({
    loading: true,
    data: null,
    error: null,
    showAll: false,
    /** 「需要你关注」是否展开全部（默认只显示 5 条） */
    attentionShowAll: false,
    reportOpen: false,
    filter: 'all',
    /** 当前分析/展示的时间窗口（小时）。默认 24 小时，可切 3/7/30 天或自定义区间 */
    windowHours: 24,
    /** 自定义区间（{ from, to, label }），仅用于界面提示 */
    customRange: null,
    /** 最近一次预检结果 */
    lastPreview: null,
    /** 正在做分析前预检（按钮立刻置灰，避免重复点击弹多个确认框） */
    previewing: false,
    /** 只看紧急/高优先（点「紧急/高优先」卡片切换） */
    priorityOnly: false,
    /** 只看某个邮件类型（点「邮件构成」里的标签切换） */
    typeFilter: null,
  }));

  const container = h('div', { class: 'view view-overview' });
  mount(root, container);

  const paint = () => renderInto(container, app, 'overview', paintInner, () => renderOverview(root, app));
  const paintInner = () => {
    clear(container);

    if (state.loading) {
      container.append(skeleton());
      return;
    }
    if (state.error) {
      container.append(
        h(
          'div',
          { class: 'empty-state' },
          h('div', { class: 'empty-icon', text: '⚠️' }),
          h('h3', { text: '无法加载总览' }),
          h('p', { text: state.error }),
          h('button', { class: 'btn btn-primary', onclick: () => load() }, '重试'),
        ),
      );
      return;
    }

    const d = state.data;
    const stats = { ...(d.stats || {}), drafts: { total: 0, pending: 0, sent: 0, failed: 0, ...(d.stats?.drafts || {}) } };
    const priorityList = Array.isArray(d.priorityList) ? d.priorityList : [];
    const needAction = Array.isArray(d.needAction) ? d.needAction : [];
    /** 不需回复但有明确时限（到期提醒、待确认的会议…） */
    const worthNoting = Array.isArray(d.worthNoting) ? d.worthNoting : [];
    // attention 必须在这里就取出：下面的统计卡片/图例在渲染时就会用到它
    // （放在后面声明会触发 TDZ：Cannot access 'attention' before initialization）
    const attention = Array.isArray(d.attention) ? d.attention : [];
    const analyzed = stats.total > 0;

    container.append(
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { text: windowLabel(d.windowHours) }),
          h(
            'p',
            { class: 'muted' },
            d.lastRun
              ? `上次分析：${fmtFull(d.lastRun.startedAt)}${d.lastRun.status === 'success' ? '' : `（${d.lastRun.status}）`}`
              : '尚未运行过分析',
          ),
        ),        h(
          'div',
          { class: 'head-actions window-group' },
          windowPicker(),
          h(
            'button',
            { class: 'btn btn-primary', disabled: app.running || state.previewing, onclick: () => analyzeWindow() },
            app.running ? '分析中…' : state.previewing ? '预检中…' : `分析${windowLabel(state.windowHours)}`,
          ),
        ),
      ),
    );

    if (!analyzed) {
      container.append(
        h(
          'div',
          { class: 'empty-state' },
          h('div', { class: 'empty-icon', text: '📬' }),
          h('h3', { text: '还没有分析结果' }),
          h('p', { class: 'muted', text: '点击「分析最近 24 小时」，数字人会拉取邮件、逐封判断是否需要回复，并起草好邮件。' }),
        ),
      );
      return;
    }

    container.append(summaryCard());

    container.append(
      h(
        'section',
        { class: 'stat-grid' },
        statCard('邮件总数', stats.total, windowLabel(d.windowHours).replace(/^最近 /, '') + '内', {
          hint: `${windowLabel(d.windowHours)}内分析过的邮件总数（含通知与知会）`,
          onclick: () => jumpTo('notice', `值得知悉（${others.length}）`),
        }),
        statCard('需你处理', stats.needsReply, '直接发我 · 高优先', {
          variant: 'accent',
          hint: '直接发给我 + 高优先级 + 需回复。点数字可定位到清单',
          onclick: () => jumpTo('need', `需要你处理（${needAction.length}）`),
        }),
        statCard('需留意', stats.worthNoting ?? 0, '有期限但不需回复', {
          hint: '不用回信、但有明确时限或要你亲自去办的事（到期提醒、待确认的会议）。点数字可定位',
          onclick: () => jumpTo('worth', `需留意（${worthNoting.length}）`),
        }),
        statCard('需你关注', stats.attention ?? 0, '抄送我 · 高优先', {
          hint: '仅抄送给我 + 高优先级。点数字可定位到清单',
          onclick: () => jumpTo('attention', '需要你关注'),
        }),
        statCard('待审核草稿', stats.drafts.pending, `${stats.drafts.sent} 封已发送`, {
          hint: `${stats.drafts.pending} 封待审核 / ${stats.drafts.sent} 封已发送。点数字去审核`,
          onclick: () => app.navigate('drafts', { tab: 'pending' }),
        }),
        statCard('紧急 / 高优先', `${stats.urgent ?? 0} / ${stats.high ?? 0}`, '按优先级排序处理', {
          hint: '点击只看紧急与高优先级的邮件（再点一次恢复）',
          onclick: () => togglePriorityFilter(),
        }),
      ),
    );

    container.append(renderBreakdown(stats, state, paint, { needAction, attention }));

    /* 需要处理 */
    const shownNeed = applyPriorityFilter(needAction, state);
    container.append(
      h(
        'section',
        { class: 'block', dataset: { section: 'need' } },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: `需要你处理（${shownNeed.length}${shownNeed.length !== needAction.length ? `／${needAction.length}` : ''}）` }),
          state.priorityOnly
            ? h(
                'button',
                { class: 'link-btn', onclick: () => togglePriorityFilter() },
                '只看紧急/高优先 · 点击取消',
              )
            : h('span', { class: 'muted small', text: '直接发给我 · 高优先级 · 需回复' }),
        ),
        shownNeed.length
          ? h('div', { class: 'mail-list' }, ...shownNeed.map((item) => needActionRow(item, app)))
          : h('p', { class: 'muted pad', text: state.priorityOnly ? '这些邮件里没有紧急/高优先的。' : '当前没有需要你回复的邮件 🎉' }),
      ),
    );

    /*
     * 已闭环的三组（已处理 / 稍后提醒 / 已忽略）。
     *
     * 必须给回得来的入口：点错了、或者"其实还没处理完"，都可能要翻回去恢复。
     * 默认折叠——它们不该占据首页的重点位置，但也不能消失。
     */
    const groups = d.taskGroups || {};
    const closedTotal = (groups.done?.length || 0) + (groups.snoozed?.length || 0) + (groups.ignored?.length || 0);
    if (closedTotal) {
      const GROUP_META = [
        { id: 'done', label: '已处理', hint: '已经处理完的，不再出现在上面的清单里' },
        { id: 'snoozed', label: '稍后提醒', hint: '到时间会自动回到上面的清单' },
        { id: 'ignored', label: '已忽略', hint: '被你移出清单的' },
      ];
      const open = new Set(state.taskGroupsOpen || []);
      container.append(
        h(
          'section',
          { class: 'block', dataset: { section: 'task-groups' } },
          h(
            'div',
            { class: 'block-head' },
            h('h3', { text: `已经不在清单里（${closedTotal}）` }),
            h('span', { class: 'muted small', text: '点标题展开，可恢复为待办' }),
          ),
          h(
            'div',
            { class: 'task-group-list' },
            ...GROUP_META.filter((meta) => (groups[meta.id]?.length || 0) > 0).map((meta) => {
              const items = groups[meta.id];
              const isOpen = open.has(meta.id);
              return h(
                'div',
                { class: 'task-group' },
                h(
                  'button',
                  {
                    class: 'task-group-head',
                    onclick: () => {
                      const next = new Set(open);
                      if (isOpen) next.delete(meta.id);
                      else next.add(meta.id);
                      state.taskGroupsOpen = [...next];
                      paint();
                    },
                  },
                  h('span', { class: `caret ${isOpen ? 'caret-open' : ''}` }),
                  h('b', { text: `${meta.label}（${items.length}）` }),
                  h('span', { class: 'muted small', text: `　${meta.hint}` }),
                ),
                isOpen
                  ? h(
                      'div',
                      { class: 'mail-list' },
                      ...items.map((item) => closedTaskRow(item, app, meta.id)),
                    )
                  : null,
              );
            }),
          ),
        ),
      );
    }

    /*
     * 需留意：不需回复，但有明确时限。
     *
     * 单独一栏的理由：并进「需要你处理」会把它灌满（那份清单是"要你回信"），
     * 并进「值得知悉」又会被"看看就好"的内容淹掉——而这恰恰是"别错过"的东西。
     * 同样给 已处理/稍后/忽略，所以它也能被清空。
     */
    if (worthNoting.length) {
      container.append(
        h(
          'section',
          { class: 'block', dataset: { section: 'worth' } },
          h(
            'div',
            { class: 'block-head' },
            h('h3', { text: `需留意（${worthNoting.length}）` }),
            h('span', { class: 'muted small', text: '不需回复 · 但有明确时限或要你亲自去办' }),
          ),
          h('div', { class: 'mail-list' }, ...worthNoting.map((item) => worthNotingRow(item, app))),
        ),
      );
    }

    /* 需要你关注：仅抄送我且高优先级——通常不该由我回复，但要看 */
    if (attention.length) {
      const shownAttention = applyPriorityFilter(attention, state);
      /*
       * 这一栏加折叠，但「需要你处理」刻意不加。
       *
       * 理由：抄送件的性质是"看看就好"，一口气列十几行会把首页重点挤下去；
       * 而「需要你处理」是**待办清单**，默认全展开才有"一件事都没漏"的确定感——
       * 一旦折叠，漏看的代价是漏回一封重要邮件，比多滚两屏严重得多，
       * 况且它天然有限（需回复 + 高优先）。
       */
      const ATTENTION_PREVIEW = 5;
      const collapsed = !state.attentionShowAll && shownAttention.length > ATTENTION_PREVIEW;
      const visibleAttention = collapsed ? shownAttention.slice(0, ATTENTION_PREVIEW) : shownAttention;
      container.append(
        h(
          'section',
          { class: 'block', dataset: { section: 'attention' } },
          h(
            'div',
            { class: 'block-head' },
            h('h3', { text: `需要你关注（${shownAttention.length}${shownAttention.length !== attention.length ? `／${attention.length}` : ''}）` }),
            shownAttention.length > ATTENTION_PREVIEW
              ? h(
                  'button',
                  {
                    class: 'link-btn',
                    onclick: () => {
                      state.attentionShowAll = !state.attentionShowAll;
                      paint();
                    },
                  },
                  state.attentionShowAll ? '收起' : `展开全部 ${shownAttention.length} 封`,
                )
              : h('span', { class: 'muted small', text: '抄送给我 · 高优先级 · 一般无需我回复' }),
          ),
          h('div', { class: 'mail-list compact' }, ...visibleAttention.map((item) => attentionRow(item, app))),
          collapsed
            ? h(
                'button',
                {
                  class: 'link-btn more-hint',
                  onclick: () => {
                    state.attentionShowAll = true;
                    paint();
                  },
                },
                `还有 ${shownAttention.length - ATTENTION_PREVIEW} 封抄送邮件 · 点此展开`,
              )
            : null,
        ),
      );
    }

    /* 值得知悉 */
    const handled = new Set([...needAction, ...attention].map((n) => n.key));
    const othersRaw = priorityList.filter((p) => !handled.has(p.key));
    // 类型筛选（点「邮件构成」里的标签）+ 优先级筛选
    const others = othersRaw.filter((p) => (!state.typeFilter || p.type === state.typeFilter) && (!state.priorityOnly || ['urgent', 'high'].includes(p.priority)));
    const shown = state.showAll ? others : others.slice(0, 6);
    container.append(
      h(
        'section',
        { class: 'block', dataset: { section: 'notice' } },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: `值得知悉（${others.length}${others.length !== othersRaw.length ? `／${othersRaw.length}` : ''}）` }),
          state.typeFilter
            ? h(
                'button',
                { class: 'link-btn', onclick: () => { state.typeFilter = null; paint(); } },
                `只看「${typeMeta(state.typeFilter).label}」· 点击取消`,
              )
            : others.length > 6
              ? h(
                  'button',
                  { class: 'link-btn', onclick: () => { state.showAll = !state.showAll; paint(); } },
                  state.showAll ? '收起' : `展开全部 ${others.length} 封`,
                )
              : null,
        ),
        others.length
          ? h('div', { class: 'mail-list compact' }, ...shown.map((item) => noticeRow(item, app)))
          : h('p', { class: 'muted pad', text: state.typeFilter || state.priorityOnly ? '当前筛选条件下没有邮件。' : '暂无其它邮件。' }),
      ),
    );

    /* 简报 */
    if (d.report?.markdown) {
      container.append(
        h(
          'section',
          { class: 'block' },
          h(
            'div',
            { class: 'block-head' },
            h(
              'h3',
              {},
              `完整简报`,
              // 简报必须标明它属于哪个窗口：否则「最近 7 天」页面上展示一份 24 小时的简报会造成误读
              h('span', { class: 'muted small', text: `　${windowLabel(Number(d.report.windowHours) || d.windowHours)}` }),
            ),
            h(
              'div',
              { class: 'head-actions' },
              d.report.id
                ? h(
                    'a',
                    {
                      class: 'btn btn-small',
                      href: `/api/reports/${encodeURIComponent(d.report.id)}?format=raw`,
                      download: `简报-${String(d.report.createdAt || '').slice(0, 10)}.md`,
                    },
                    '下载 Markdown',
                  )
                : null,
              h(
                'button',
                { class: 'link-btn', onclick: () => { state.reportOpen = !state.reportOpen; paint(); } },
                state.reportOpen ? '收起' : '展开',
              ),
            ),
          ),
          state.reportOpen
            ? h('div', { class: 'markdown', html: renderMarkdown(d.report.markdown) })
            : h('p', { class: 'muted pad', text: `简报生成于 ${fmtFull(d.report.createdAt)}，点击「展开」查看完整内容。` }),
        ),
      );
    } else if (d.latestReport?.markdown) {
      // 当前窗口还没有简报，但别的窗口有：只给一句指路，**不展示内容**，避免窗口串味
      container.append(
        h(
          'section',
          { class: 'block' },
          h(
            'div',
            { class: 'block-head' },
            h('h3', { text: '完整简报' }),
            h('span', { class: 'muted small', text: '暂无本期简报' }),
          ),
          h(
            'p',
            { class: 'muted pad' },
            `最近一次简报针对的是${windowLabel(Number(d.latestReport.windowHours) || 24)}（生成于 ${fmtFull(d.latestReport.createdAt)}）。` +
              `点上方「分析${windowLabel(state.windowHours)}」即可生成本期简报。`,
          ),
        ),
      );
    }

    /* ---- 卡片交互：定位 / 筛选 ---- */

    /** 滚到某个分区并高亮（用户点卡片数字时的定位反馈）。 */
    function jumpTo(section, titleHint) {
      const el = container.querySelector(`[data-section="${section}"]`);
      if (!el) {
        toast(`当前没有「${titleHint}」分区`, 'info');
        return;
      }
      scrollToEl(el);
    }

    /** 只看紧急/高优先（再点一次恢复）。 */
    function togglePriorityFilter() {
      state.priorityOnly = !state.priorityOnly;
      state.showAll = state.priorityOnly ? true : state.showAll;
      paint();
      if (state.priorityOnly) jumpTo('need', '需要你处理');
    }
  };

  async function load() {
    // 数据在别处被改动过（起草/发送/改设置）→ 必须重取；否则保留阅读位置与展开状态
    if (state.data && !needsReload(app, 'overview')) {
      paint();
      return;
    }
    return refresh();
  }

  /** 强制重新取一次总览。 */
  async function refresh() {
    state.loading = !state.data;
    state.error = null;
    paint();
    try {
      state.data = await api.overview({ hours: state.windowHours });
      state.lastPreview = null;
      markLoaded(app, 'overview');
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      paint();
    }
  }

  /* ---- 一句话总结 ---- */

  /**
   * 一句话总结。
   *
   * 关键约束：**这段文字必须与下面的数字属于同一个时间窗口**。
   *
   * 之前的做法是"永远显示最近一次 AI 简报里的一句话"，于是切换窗口后立刻自相矛盾：
   * 标题写着「最近 7 天 · 95 封」，总结却说「近 24 小时 38 封邮件中…」
   * （因为那是上一次针对 24 小时跑出来的简报，用户还没点新的分析）。
   *
   * 现在分三种情况：
   *   1. 有**当前窗口**的简报 → 用它的一句话（同时标注窗口）；
   *   2. 没有当前窗口的简报 → 用本地统计**现场算一句**，并与卡片完全同源；
   *   3. 另外用一行小字说明"上一次 AI 简报针对的是哪个窗口"，避免用户误以为没生成。
   */
  function summaryCard() {
    const d = state.data;
    const fromReport = extractSummaryParagraph(d.report?.markdown);
    const latest = d.latestReport;
    const otherWindow = latest && !latest.isCurrentWindow ? windowLabel(Number(latest.windowHours) || 24) : null;

    // 情况 2：本地算一句，口径与卡片一致
    const local = [
      `${windowLabel(d.windowHours)}内共 ${d.stats.total} 封邮件`,
      d.stats.needsReply ? `其中 ${d.stats.needsReply} 封需要你处理` : '没有需要你处理的',
      d.stats.worthNoting ? `${d.stats.worthNoting} 封需要留意` : null,
      d.stats.attention ? `${d.stats.attention} 封需要关注` : null,
      d.stats.drafts?.pending ? `${d.stats.drafts.pending} 封草稿等你审核` : null,
    ]
      .filter(Boolean)
      .join('，');

    /*
     * 快照与实时的差别要**主动讲清楚**。
     *
     * 简报那段文字是"那次分析时"写下的，而卡片与清单是"打开页面时"实时算的；
     * 时间一滑，两个数字就会不一致（实测：简报写"近 24 小时共 11 封"，卡片写 5 封，
     * 用户会以为哪个数字算错了）。与其让用户怀疑，不如把口径直接摆出来。
     */
    const snap = d.report?.snapshot;
    const live = d.report?.live;
    const drift =
      fromReport && snap && Number.isFinite(snap.total) && Number.isFinite(live?.total) && snap.total !== live.total
        ? `简报写于 ${fmtFull(new Date(d.report.createdAt))}，当时窗口内 ${snap.total} 封；现在同一窗口是 ${live.total} 封——` +
          `数字不同是因为**时间在走**（旧邮件会滑出窗口），不是哪边算错了。`
        : null;

    return h(
      'section',
      { class: 'summary-card' },
      h(
        'div',
        { class: 'summary-label' },
        fromReport ? `一句话总结 · ${windowLabel(d.windowHours)}` : `本期概况 · ${windowLabel(d.windowHours)}`,
      ),
      h('p', { class: 'summary-text' }, fromReport || `${local}。`),
      drift ? h('p', { class: 'summary-note' }, drift) : null,
      !fromReport && otherWindow
        ? h(
            'p',
            { class: 'summary-note' },
            `上一次 AI 简报针对的是${otherWindow}（${fmtFull(latest.createdAt)}）。点「分析${windowLabel(d.windowHours)}」即可生成本期的 AI 总结。`,
          )
        : null,
      !fromReport && !otherWindow
        ? h('p', { class: 'summary-note' }, `还没有 AI 简报。点「分析${windowLabel(d.windowHours)}」生成一句话总结。`)
        : null,
    );
  }

  /* ---- 按时间段分析 ---- */

  /** 预设窗口（小时）。自定义区间会换算成对应小时数。 */
  const WINDOW_PRESETS = [
    { hours: 24, label: '最近 24 小时' },
    { hours: 24 * 3, label: '最近 3 天' },
    { hours: 24 * 7, label: '最近 7 天' },
    { hours: 24 * 30, label: '最近 30 天' },
  ];

  function windowPicker() {
    const select = h(
      'select',
      {
        class: 'input window-select',
        title: '选择分析的时间范围（放长假回来可以选 7 天/30 天，或自定义区间）',
        onchange: (ev) => {
          const value = ev.target.value;
          if (value === 'custom') {
            openCustomRange();
            return;
          }
          applyWindow(Number(value));
        },
      },
      ...WINDOW_PRESETS.map((p) =>
        h('option', { value: String(p.hours), selected: state.windowHours === p.hours }, p.label),
      ),
      // 当前窗口不是预设值（自定义区间）时，把它作为一项显示出来，避免选择框"跳回"预设
      WINDOW_PRESETS.some((p) => p.hours === state.windowHours) || state.customRange?.label
        ? null
        : h('option', { value: String(state.windowHours), selected: true }, `${windowLabel(state.windowHours)}（自定义）`),
      h('option', { value: 'custom' }, '自定义时间段…'),
    );
    return select;
  }

  /** 切换窗口：总览与「分析」按钮都跟着变（标题也会变，避免"最近 168 小时"）。 */
  function applyWindow(hours, customRange = null) {
    state.windowHours = hours;
    state.customRange = customRange;
    state.showAll = false;
    // 换窗口后旧数据不再是同一口径，必须重取
    invalidateView(app, 'overview');
    state.data = null;
    refresh();
  }

  /** 自定义起止日期（含首尾两天）。 */
  function openCustomRange() {
    const today = new Date();
    const iso = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
    const from = h('input', { class: 'input', type: 'date', value: iso(new Date(today.getTime() - 6 * 86_400_000)) });
    const to = h('input', { class: 'input', type: 'date', value: iso(today) });
    const overlay = h('div', { class: 'modal-overlay', onclick: (ev) => ev.target === overlay && close() });
    let closeModal = () => {};
    const close = () => {
      document.removeEventListener('keydown', onEsc);
      closeModal();
    };
    const onEsc = (ev) => {
      if (ev.key === 'Escape') close();
    };
    const submit = () => {
      const a = from.value ? new Date(`${from.value}T00:00:00`) : null;
      const b = to.value ? new Date(`${to.value}T23:59:59`) : null;
      if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return toast('请选择有效的起止日期', 'error');
      if (b < a) return toast('结束日期不能早于开始日期', 'error');
      const hours = Math.max(1, Math.min(24 * 30, Math.ceil((b - a) / 3_600_000)));
      close();
      applyWindow(hours, { from: from.value, to: to.value, label: `${from.value} ~ ${to.value}` });
      return undefined;
    };
    overlay.append(
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { class: 'modal-title', text: '自定义分析时间段' }),
        h(
          'div',
          { class: 'modal-body' },
          h('p', { class: 'muted small', text: '例如放长假回来，选择「放假前一天 ~ 今天」即可把期间的邮件一次性分析完。最长 30 天。' }),
          h('label', { class: 'field' }, h('span', { text: '开始日期' }), from),
          h('label', { class: 'field' }, h('span', { text: '结束日期' }), to),
        ),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: close }, '取消'),
          h('button', { class: 'btn btn-primary', onclick: submit }, '使用该时间段'),
        ),
      ),
    );
    closeModal = openModal(overlay);
    document.addEventListener('keydown', onEsc);
  }

  /**
   * 按当前窗口跑一次分析。
   *
   * 先做**只读预检**：把「这个窗口里有多少封、其中多少是新的、预计几次模型调用」摆出来，
   * 窗口较大时还要再确认一次——放宽到 30 天可能一次跑掉几百封，
   * 用户应当在花钱之前看到代价。
   */
  async function analyzeWindow() {
    if (app.running || state.previewing) return;
    const hours = state.windowHours;
    /*
     * 立刻置灰并重绘。
     * 预检要连一次邮箱，实测需要 1~2 秒；这段时间按钮如果还是可点的样子，
     * 用户会以为没反应而反复点击，从而弹出多个确认框。
     */
    state.previewing = true;
    paint();
    try {
      const preview = await api.runPreview(hours);
      state.lastPreview = preview;
      const heavy = preview.estimatedAnalyze > 120;
      /*
       * 文案必须与**实际运行行为**一致。
       *
       * 旧文案写"其中 N 封已分析过，**不会重复消耗**"——而分类阶段对窗口内全部邮件
       * 都会重跑（实测连续 6 轮都是 拉取 11 → 分析 11），属于拿错数字劝用户花钱。
       * 真实规则：只有**已有分析且已有草稿**的邮件才复用。
       */
      const lines = [
        `${preview.windowLabel}内共 ${preview.matched} 封邮件`,
        `本次将取出最新 ${preview.taken} 封（上限 ${preview.limit}）`,
        preview.reusable
          ? `其中 ${preview.reusable} 封已有草稿，会直接复用结论、不再重复消耗`
          : null,
        `预计分析约 ${preview.estimatedAnalyze} 封 · 约 ${preview.estimatedCalls} 次模型调用（含 1 次生成简报）`,
        preview.truncated ? `注意：超出上限的 ${preview.matched - preview.taken} 封本次不会分析（可缩短时间段分次处理）` : null,
      ].filter(Boolean);
      // 预检完成后就恢复按钮：确认框本身是模态的，不会重复点击
      state.previewing = false;
      paint();
      const ok = await confirmDialog({
        title: `确认分析${preview.windowLabel}？`,
        message: h('div', {}, ...lines.map((t) => h('p', { class: 'kv', text: t }))),
        confirmText: heavy ? `确认分析（约 ${preview.estimatedAnalyze} 封）` : '开始分析',
      });
      if (!ok) return;
    } catch (err) {
      state.previewing = false;
      paint();
      // 预检失败不阻断分析（例如网络抖动），但要让用户知道没拿到预估
      toast(`未能预检邮件数量（${err.message}），仍将直接开始分析`, 'info', 6000);
    }
    await app.analyze({ windowHours: hours });
    invalidateView(app, 'overview');
    await refresh();
  }

  load();
  return { reload: refresh, setWindow: applyWindow };
}

/** 人类可读的窗口描述（与后端 describeWindow 同一口径）。 */
function windowLabel(hours) {
  const h = Number(hours) || 24;
  if (h <= 24) return `最近 ${h} 小时`;
  const days = Math.round(h / 24);
  return h % 24 === 0 ? `最近 ${days} 天` : `最近 ${h} 小时`;
}

/* ------------------------------------------------------------ 片段 */

function skeleton() {
  return h(
    'div',
    { class: 'skeleton-wrap' },
    h('div', { class: 'skeleton sk-line w40' }),
    h('div', { class: 'skeleton sk-line w70' }),
    h('div', { class: 'skeleton sk-card' }),
    h('div', { class: 'skeleton sk-card' }),
  );
}

/**
 * 统计卡片。
 *
 * 卡片是**可点**的：数字本身在回答"有多少"，而点击要回答"在哪里"——
 * 所以每张卡片都带一个 `onclick`（定位到分区 / 跳草稿页 / 切换筛选）与一句口径说明。
 * 之前它们只是静态展示，用户看完数字还得自己在页面上找。
 *
 * @param {string} label
 * @param {string|number} value
 * @param {string} hint 卡片下方的口径说明
 * @param {object} [options] { variant, hint（悬浮提示）, onclick }
 */
function statCard(label, value, hint, { variant = '', onclick = null, hint: tooltip = '' } = {}) {
  const card = h(
    'div',
    {
      class: `stat-card ${variant} ${onclick ? 'stat-card-clickable' : ''}`.trim(),
      title: tooltip || hint,
      onclick: onclick || undefined,
    },
    h('div', { class: 'stat-label', text: label }),
    h('div', { class: 'stat-value', text: String(value) }),
    h('div', { class: 'stat-hint', text: hint }),
    onclick ? h('div', { class: 'stat-more', text: '查看 ›' }) : null,
  );
  if (onclick) makeActivatable(card, onclick, { label: `${label}：${value}，${tooltip || hint}` });
  return card;
}

/**
 * 邮件构成图例。
 *
 * 点某个类型 → 只筛「值得知悉」里的那一类（再点一次恢复），
 * 与列表里类型标签共用同一套图标与配色，所以图例和条目能一一对上。
 */
function renderBreakdown(stats, state, paint) {
  const types = Object.entries(stats.byType).sort((a, b) => b[1] - a[1]);
  return h(
    'section',
    { class: 'block' },
    h(
      'div',
      { class: 'block-head' },
      h('h3', { text: '邮件构成' }),
      typeLabel(stats, state, paint),
      h('span', { class: 'muted small', text: '点击可只看该类' }),
    ),
    h(
      'div',
      { class: 'chip-row' },
      ...types.map(([type, count]) => {
        const meta = typeMeta(type);
        const active = state.typeFilter === type;
        const chip = h(
          'span',
          {
            class: `chip chip-typed chip-clickable ${meta.className} ${active ? 'active' : ''}`.trim(),
            title: `只看「${meta.label}」（${count} 封）`,
            onclick: () => {
              state.typeFilter = active ? null : type;
              state.showAll = true;
              paint();
            },
          },
          h('span', { class: 'tag-icon' }, icon(meta.icon, { size: 12 })),
          h('b', { text: String(count) }),
          ` ${meta.label}`,
        );
        return makeActivatable(chip, () => chip.onclick(), { label: `只看${meta.label}，共 ${count} 封` });
      }),
    ),
  );
}

/** 类型筛选生效时，在图例右侧给一个取消入口。 */
function typeLabel(stats, state, paint) {
  if (!state.typeFilter) return null;
  return h(
    'button',
    {
      class: 'link-btn',
      onclick: () => {
        state.typeFilter = null;
        paint();
      },
    },
    `已筛选：${typeMeta(state.typeFilter).label} ✕`,
  );
}

function needActionRow(item, app) {
  // 整行可点 → 打开「原始邮件」（最常想做的事就是看看对方原话）
  const row = h(
    'article',
    {
      class: 'mail-row mail-row-clickable',
      title: '查看这封邮件（含原文全文）',
      onclick: (ev) => {
        if (ev.target.closest('button, a')) return; // 行内按钮自己处理
        app.showMail(item.key, item);
      },
    },
    h('div', { class: `avatar ${PRIORITY_CLASS[item.priority] || ''}`, text: initials(item.from) }),
    h(
      'div',
      { class: 'mail-main' },
      h(
        'div',
        { class: 'mail-title-line' },
        h('span', { class: `tag ${PRIORITY_CLASS[item.priority]}` , text: priorityLabel(item.priority) }),
        typeTag(item.type, { h }),
        h('span', { class: 'mail-subject', text: item.subject || '(无主题)' }),
      ),
      h(
        'div',
        { class: 'mail-meta' },
        h('span', { text: fmtAddress(item.from) }),
        h('span', { class: 'dot' }),
        // 邮件列表显示发件时间本身，便于判断「今天必须回」还是「已经过期」
        h('span', { text: fmtMailTime(item.date) }),
      ),
      item.summary ? h('p', { class: 'mail-summary', text: item.summary }) : null,
      item.actions?.length ? h('ul', { class: 'action-list' }, ...item.actions.map((a) => h('li', { text: a }))) : null,
    ),
    h('div', { class: 'mail-side' }, draftAction(item, app), taskActions(item, app)),
  );
  return makeActivatable(row, () => app.showMail(item.key, item), { label: `查看邮件：${item.subject || '(无主题)'}` });
}

/**
 * 「需要你处理」的待办操作：已处理 / 稍后提醒 / 忽略。
 *
 * 这是把"一份报告"变成"一个能清空的清单"的关键——没有它，每次分析都会把
 * 已经处理过的邮件**再列一遍**，列表永远清不空。
 *
 * 这些是**本地状态**，不写 Google、不发邮件，所以不进操作台账。
 */
function taskActions(item, app) {
  const state = app.viewStates.overview;
  const busy = () => {
    state.taskBusy = true;
  };
  const done = async () => {
    busy();
    await setStatus(item, 'done', app);
  };
  const ignore = async () => {
    busy();
    await setStatus(item, 'ignored', app);
  };
  return h(
    'div',
    { class: 'task-actions' },
    h('button', { class: 'link-btn task-done', title: '从清单中移出，可在「已处理」里恢复', onclick: done }, '已处理'),
    h('button', { class: 'link-btn', title: '过一会儿再提醒我', onclick: () => openSnoozeDialog(item, app) }, '稍后'),
    h('button', { class: 'link-btn muted-link', title: '永久移出清单（可在「已忽略」里恢复）', onclick: ignore }, '忽略'),
  );
}

/** 打状态并刷新总览（失败要弹出来，不能静默）。 */
async function setStatus(item, status, app, extra = {}) {
  try {
    const out = await api.taskSetStatus(item.key, { status, ...extra });
    toast(out.message || '已更新', 'success');
    app.invalidate('overview');
    await app.reloadCurrent();
  } catch (err) {
    toastError(err);
  }
}

/**
 * 「稍后提醒」的时间选择。
 *
 * 给几个常用档位而不是只让用户填时间：绝大多数"稍后"就是"下午再看"或"明天再看"，
 * 少一次输入就少一次放弃使用这个功能的理由。到期后**会自动回到清单**。
 */
function openSnoozeDialog(item, app) {
  const at = (days, hour) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const options = [
    { label: '今天下午 14:00', when: at(0, 14), hint: '' },
    { label: '今天 18:00', when: at(0, 18), hint: '' },
    { label: '明天早上 09:00', when: at(1, 9), hint: '最常用' },
    { label: '3 天后 09:00', when: at(3, 9), hint: '' },
    { label: '下周一 09:00', when: nextMonday(), hint: '' },
  ].filter((o) => o.when.getTime() > Date.now());

  let close = () => {};
  const overlay = h(
    'div',
    { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() },
    h(
      'div',
      { class: 'modal modal-narrow', role: 'dialog', 'aria-modal': 'true' },
      h('h3', { class: 'modal-title', text: '稍后提醒' }),
      h(
        'div',
        { class: 'modal-body' },
        h('p', { class: 'muted small', text: `${item.subject || '(无主题)'}——到期后会自己回到「需要你处理」` }),
        h(
          'div',
          { class: 'snooze-options' },
          ...options.map((o) =>
            h(
              'button',
              {
                class: 'btn snooze-option',
                onclick: async () => {
                  close();
                  await setStatus(item, 'snoozed', app, { snoozeUntil: o.when.toISOString() });
                },
              },
              o.label,
              o.hint ? h('span', { class: 'muted small', text: `　${o.hint}` }) : null,
            ),
          ),
        ),
      ),
      h('div', { class: 'modal-actions' }, h('button', { class: 'btn', onclick: () => close() }, '取消')),
    ),
  );
  close = openModal(overlay);
}

function nextMonday() {
  const d = new Date();
  const day = d.getDay();
  const delta = (8 - day) % 7 || 7;
  d.setDate(d.getDate() + delta);
  d.setHours(9, 0, 0, 0);
  return d;
}

/**
 * 「需留意」的一行。
 *
 * 与「需要你处理」的区别：**不给「起草回复」**——这类邮件本来就不需要回复，
 * 摆一个起草按钮只会诱导用户去回一封不必回的邮件。
 * 但保留 已处理/稍后/忽略，这样它同样能被清空。
 */
function worthNotingRow(item, app) {
  return h(
    'article',
    {
      class: 'mail-row mail-row-clickable',
      title: '查看这封邮件（含原文全文）',
      onclick: (ev) => {
        if (ev.target.closest('button, a')) return;
        app.showMail(item.key, item);
      },
    },
    h('div', { class: `avatar ${PRIORITY_CLASS[item.priority] || ''}`, text: initials(item.from) }),
    h(
      'div',
      { class: 'mail-main' },
      h(
        'div',
        { class: 'mail-title-line' },
        h('span', { class: `tag ${PRIORITY_CLASS[item.priority]}`, text: priorityLabel(item.priority) }),
        typeTag(item.type, { h }),
        h('span', { class: 'mail-subject', text: item.subject || '(无主题)' }),
      ),
      h(
        'div',
        { class: 'mail-meta' },
        h('span', { text: fmtAddress(item.from) }),
        h('span', { class: 'dot' }),
        h('span', { text: fmtMailTime(item.date) }),
      ),
      item.summary ? h('p', { class: 'mail-summary', text: item.summary }) : null,
      item.actions?.length ? h('ul', { class: 'action-list' }, ...item.actions.map((a) => h('li', { text: a }))) : null,
    ),
    h('div', { class: 'mail-side' }, taskActions(item, app)),
  );
}

/** 「已处理 / 稍后提醒 / 已忽略」里的一行：显示状态与恢复入口。 */
function closedTaskRow(item, app, group) {
  return h(
    'article',
    {
      class: 'mail-row mail-row-clickable',
      title: '查看这封邮件（含原文全文）',
      onclick: (ev) => {
        if (ev.target.closest('button, a')) return;
        app.showMail(item.key, item);
      },
    },
    h(
      'div',
      { class: 'mail-main' },
      h('div', { class: 'mail-title-line' }, h('span', { class: 'mail-subject', text: item.subject || '(无主题)' })),
      h(
        'div',
        { class: 'mail-meta' },
        h('span', { text: fmtAddress(item.from) }),
        h('span', { class: 'dot' }),
        h('span', { text: fmtMailTime(item.date) }),
        stateNote(item, app),
      ),
    ),
    h('div', { class: 'mail-side' }, restoreAction(item, app, group === 'snoozed' ? '立即提醒' : '恢复为待办')),
  );
}

/** 「稍后提醒」显示到什么时候为止；有备注也一并显示。 */
function stateNote(item, app) {
  const all = app.viewStates.overview?.data?.taskStates || {};
  const st = all[item.key];
  if (!st) return null;
  const bits = [];
  if (st.status === 'snoozed' && st.snoozeUntil) bits.push(`提醒时间 ${fmtFull(new Date(st.snoozeUntil))}`);
  if (st.status === 'done' && st.updatedAt) bits.push(`处理于 ${fmtFull(new Date(st.updatedAt))}`);
  if (st.note) bits.push(`备注：${st.note}`);
  if (!bits.length) return null;
  return h('span', { class: 'muted', text: `　${bits.join('　')}` });
}

/** 「已处理 / 稍后提醒 / 已忽略」里的快捷恢复。 */
function restoreAction(item, app, label = '恢复为待办') {
  return h(
    'button',
    { class: 'link-btn', onclick: async () => setStatus(item, 'open', app) },
    label,
  );
}

/**
 * 「需要你处理」右侧的操作按钮。
 *
 * 关键在于**按草稿的真实状态区分**：
 *  - 已发送：这封邮件已经处理完了，按钮变成「已发送邮件」，点击直达草稿页的「已发送」标签；
 *  - 待审核／发送失败：给「查看草稿」，去待审核列表继续处理；
 *  - 还没有草稿：给「起草回复」。
 *
 * 之所以必须区分，是因为重复点「分析最近 24 小时」时引擎不会再为已有草稿的邮件起草，
 * 如果界面仍显示「查看草稿」，用户根本不知道那封草稿其实早就发出去了。
 */
function draftAction(item, app) {
  const status = item.draftStatus;
  if (status === 'sent') {
    return h(
      'button',
      {
        class: 'btn btn-small btn-sent',
        title: item.draftSentAt ? `已于 ${fmtFull(item.draftSentAt)} 发送` : '已发送',
        onclick: () => app.navigate('drafts', { tab: 'sent', draftId: item.draftId }),
      },
      '已发送邮件',
    );
  }
  if (item.hasDraft) {
    return h(
      'button',
      {
        class: 'btn btn-small btn-primary',
        onclick: () => app.navigate('drafts', { tab: 'pending', draftId: item.draftId }),
      },
      status === 'failed' ? '查看草稿（发送失败）' : '查看草稿',
    );
  }
  return h(
    'button',
    {
      class: 'btn btn-small',
      onclick: async (ev) => {
        const btn = ev.currentTarget;
        btn.disabled = true;
        btn.textContent = '起草中…';
        try {
          await app.draftFor(item.key);
          toast('草稿已生成，请到「邮件草稿」审核', 'success');
          app.navigate('drafts', { tab: 'pending' });
        } catch (err) {
          toast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = '起草回复';
        }
      },
    },
    '起草回复',
  );
}

/** 「需要你关注」的一行：明确标注抄送，且不提供起草入口（避免越权回复）。 */
function attentionRow(item, app) {
  const row = h(
    'article',
    {
      class: 'mail-row mail-row-clickable',
      title: '查看这封邮件（含原文全文）',
      onclick: (ev) => {
        if (ev.target.closest('button, a')) return;
        app.showMail(item.key, item);
      },
    },
    h('div', { class: `avatar ${PRIORITY_CLASS[item.priority] || ''}`, text: initials(item.from) }),
    h(
      'div',
      { class: 'mail-main' },
      h(
        'div',
        { class: 'mail-title-line' },
        h('span', { class: 'tag tag-cc', text: '抄送给我' }),
        h('span', { class: `tag ${PRIORITY_CLASS[item.priority] || ''}`, text: priorityLabel(item.priority) }),
        typeTag(item.type, { h }),
        h('span', { class: 'mail-subject', text: item.subject || '(无主题)' }),
      ),
      h(
        'div',
        { class: 'mail-meta' },
        h('span', { text: fmtAddress(item.from) }),
        h('span', { class: 'dot' }),
        h('span', { text: fmtMailTime(item.date) }),
      ),
      item.summary ? h('p', { class: 'mail-summary', text: item.summary }) : null,
    ),
    h(
      'div',
      { class: 'mail-side' },
      h(
        'button',
        { class: 'btn btn-small', onclick: () => app.showMail(item.key, item) },
        '查看',
      ),
    ),
  );
  return makeActivatable(row, () => app.showMail(item.key, item), { label: `查看邮件：${item.subject || '(无主题)'}` });
}

function noticeRow(item, app) {
  // 「值得知悉」最怕「看不出是哪封」：主题/发件人/时间任一缺失都要给出可辨认的兜底，
  // 绝不能只剩一个空壳行（曾出现过整列都是「(无主题) + 时间 —」的难看且无用状态）。
  const hasSubject = !!String(item.subject || '').trim();
  const subject = hasSubject ? item.subject : '(无主题)';
  const from = item.from?.name || item.from?.address || '未知发件人';
  const when = item.date || item.analyzedAt;
  const ref = !hasSubject || !item.from ? `${item.folder || 'INBOX'} #${item.uid}` : '';
  const row = h(
    'div',
    {
      class: 'notice-row',
      title: `${subject}\n${from}\n${fmtFull(when)}${ref ? `\n${ref}` : ''}`,
      onclick: () => app.showMail(item.key, item),
    },
    typeTag(item.type, { h, extraClass: 'tag-quiet' }),
    h(
      'span',
      { class: `notice-subject ${hasSubject ? '' : 'is-empty'}` },
      subject,
      ref ? h('span', { class: 'notice-ref', text: ref }) : null,
    ),
    h('span', { class: 'notice-from', text: from }),
    h('span', { class: 'notice-time', text: fmtMailTime(when) }),
  );
  return makeActivatable(row, () => app.showMail(item.key, item), { label: `查看邮件：${subject}` });
}

function priorityLabel(p) {
  return { urgent: '紧急', high: '高', normal: '普通', low: '低' }[p] || p;
}
