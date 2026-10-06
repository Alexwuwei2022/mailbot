/**
 * 按项目时间线。
 *
 * 把同一件事的**收到的邮件、我发出的邮件、跟催、日程**按时间排成一条线，
 * 用来回答"这个项目从头到尾发生了什么"——单看收件箱永远看不出来。
 *
 * ## 两个必须说清楚的地方
 *
 * 1. **项目标签是模型给的，会飘**。所以这一页的核心操作之一是**重命名/合并**：
 *    把「华东投标」并进「华东区投标」，历史记录一起改写，旧名记成别名。
 * 2. **日程只来自本程序的操作留痕**（我在这里建/改过的日程）。
 *    别人在 Google 日历上直接建的不在这里——界面顶部如实说明，
 *    不能让用户以为这就是全部日程。
 */

import { api } from '../api.js';
import { confirmDialog, fmtFull, h, mount, toast, toastError } from '../dom.js';
import { invalidateAll, markLoaded, renderInto, viewState } from '../view-state.js';

/** 四种来源的显示名与配色（与后端 buildTimeline 的 kind 一一对应）。 */
const KIND_META = {
  mail: { label: '收到的邮件', icon: '📥' },
  draft: { label: '我发出的', icon: '📤' },
  followUp: { label: '跟催', icon: '⏳' },
  calendar: { label: '日程', icon: '📅' },
};

export function renderTimeline(root, app) {
  const { state } = viewState(app, 'timeline', () => ({
    loading: true,
    projects: [],
    unclassified: 0,
    current: null,
    data: null,
    error: null,
    calendarNote: '',
  }));

  const container = h('div', { class: 'view view-timeline' });
  mount(root, container);
  const paint = () => renderInto(container, app, 'timeline', paintInner, () => renderTimeline(root, app));

  function paintInner() {
    mount(container, view());
  }

  /* ------------------------------------------------------------ 视图 */

  function view() {
    if (state.loading) return h('p', { class: 'muted pad', text: '加载中…' });
    if (state.error) return h('div', { class: 'alert alert-error' }, h('b', { text: '加载失败：' }), state.error);

    const hasAny = state.projects.length > 0 || state.unclassified > 0;

    return h(
      'div',
      {},
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { class: 'page-title', text: '时间线' }),
          h('p', { class: 'muted', text: '同一件事的邮件、我发出的回复、跟催与日程，按时间串成一条线。' }),
        ),
        h(
          'div',
          { class: 'head-actions' },
          h('button', { class: 'btn btn-small', onclick: () => load(true) }, '刷新'),
        ),
      ),

      !hasAny
        ? h(
            'div',
            { class: 'empty-state' },
            h('p', { text: '还没有可归类的邮件。' }),
            h(
              'p',
              { class: 'muted small' },
              '项目标签是在**分析邮件**时由模型给出的（短标签，如「华东区投标」）。' +
                '先到「邮件总览」跑一次分析，之后这里就会按项目把同一件事串起来。',
            ),
          )
        : null,

      hasAny ? projectPicker() : null,
      state.current !== null ? timelineBody() : null,
    );
  }

  /** 项目选择：横向一排标签，点击切换；右侧是"重命名/合并"入口。 */
  function projectPicker() {
    const chip = (label, value, count) =>
      h(
        'button',
        {
          class: `setup-chip ${state.current === value ? 'setup-chip-active' : ''}`,
          onclick: () => selectProject(value),
        },
        h('span', { text: label }),
        h('span', { class: 'muted small', text: `（${count}）` }),
      );

    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: '选择项目' }),
        state.current
          ? h(
              'button',
              { class: 'btn btn-small', onclick: (ev) => openRename(ev.currentTarget) },
              '重命名 / 合并…',
            )
          : null,
      ),
      h(
        'div',
        { class: 'setup-steps-row pad' },
        ...state.projects.slice(0, 40).map((p) => chip(p.name, p.name, p.count)),
        state.unclassified ? chip('未归类', '', state.unclassified) : null,
      ),
      state.projects.some((p) => (p.aliases || []).length)
        ? h(
            'p',
            { class: 'muted small pad' },
            `已合并的旧名字：${state.projects
              .filter((p) => (p.aliases || []).length)
              .map((p) => `${p.aliases.join('、')} → ${p.name}`)
              .join('；')}`,
          )
        : null,
    );
  }

  function timelineBody() {
    const d = state.data;
    if (!d) return h('p', { class: 'muted pad', text: '加载中…' });
    if (!d.entries.length) {
      return h(
        'div',
        { class: 'empty-state' },
        h('p', { text: `「${state.current || '未归类'}」还没有记录。` }),
      );
    }
    const counts = Object.entries(d.counts || {})
      .map(([k, v]) => `${KIND_META[k]?.label || k} ${v}`)
      .join(' · ');

    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: state.current || '未归类' }),
        h('span', { class: 'muted small', text: counts }),
      ),
      h(
        'div',
        { class: 'pad' },
        d.calendarNote ? h('p', { class: 'muted small' }, `ℹ️ ${d.calendarNote}`) : null,
        h('div', { class: 'timeline' }, ...d.entries.map(entry)),
      ),
    );
  }

  /** 一条记录：时间 + 来源 + 标题 + 细节。 */
  function entry(e) {
    const meta = KIND_META[e.kind] || { label: e.kind, icon: '•' };
    return h(
      'div',
      { class: `tl-row tl-${e.kind}` },
      h('div', { class: 'tl-time muted small', text: fmtFull(new Date(e.at)) }),
      h('div', { class: 'tl-dot', text: meta.icon }),
      h(
        'div',
        { class: 'tl-main' },
        h('div', { class: 'tl-title', text: e.title }),
        h(
          'div',
          { class: 'tl-meta muted small' },
          h('span', { class: 'tag', text: meta.label }),
          /*
           * 来源比类别更具体（类别「跟催」→ 来源「等对方回复」/「我的承诺」），
           * 客户端的措辞能帮用户一眼分清这是谁欠谁，所以两者都显示、不重复时才显示。
           */
          e.source && e.source !== meta.label ? h('span', { text: e.source }) : null,
          e.meta?.from ? h('span', { text: `发件人：${e.meta.from}` }) : null,
          e.meta?.to ? h('span', { text: `收件人：${e.meta.to}` }) : null,
          e.meta?.counterparty ? h('span', { text: e.meta.counterparty }) : null,
          e.meta?.status ? h('span', { text: `状态：${statusLabel(e.meta.status)}` }) : null,
          e.meta?.needsReply ? h('span', { class: 'error', text: '需要回复' }) : null,
        ),
        e.detail ? h('div', { class: 'tl-detail muted small', text: e.detail }) : null,
      ),
    );
  }

  function statusLabel(s) {
    return { open: '进行中', done: '已完成', snoozed: '稍后', ignored: '已忽略' }[s] || s;
  }

  /* ------------------------------------------------------------ 动作 */

  async function load(force = false) {
    state.loading = !state.projects.length;
    paint();
    try {
      const out = await api.projects();
      state.projects = out.projects || [];
      state.unclassified = out.unclassified || 0;
      markLoaded(app, 'timeline');
      // 默认选项目最多的那个（通常是用户最关心的事）
      if (state.current === null) state.current = state.projects[0]?.name ?? '';
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      paint();
    }
    if (state.current !== null) await loadTimeline();
  }

  async function loadTimeline() {
    try {
      const out = await api.timeline(state.current);
      state.data = out;
      state.calendarNote = out.calendarNote || '';
    } catch (err) {
      toastError(err);
    }
    paint();
  }

  async function selectProject(value) {
    state.current = value;
    state.data = null;
    paint();
    await loadTimeline();
  }

  /**
   * 重命名 / 合并。
   *
   * 合并会**改写历史记录**，所以：①先说清会发生什么；②要求用户输入/确认目标名；
   * ③完成后如实报告"改了多少条"。
   */
  async function openRename(btn) {
    const from = state.current;
    const input = h('input', { class: 'input', type: 'text', value: from, placeholder: '目标项目名' });
    const ok = await confirmDialog({
      title: `重命名「${from}」`,
      message: h(
        'div',
        {},
        h('p', { class: 'small', text: '填一个**已有项目的名字**就等于合并：那个项目的历史记录会被一起改写，旧名会记成别名（下次分析再遇到也会归到一起）。' }),
        input,
        h('p', { class: 'muted small', text: '只改名字（改成新的、不存在的名字）也可以。' }),
      ),
      confirmText: '确认改名',
    });
    if (!ok) return;
    const to = input.value.trim();
    if (!to || to === from) {
      if (!to) toast('目标名字不能为空', 'error');
      return;
    }
    const label = btn?.textContent;
    if (btn) btn.textContent = '处理中…';
    try {
      const out = await api.renameProject(from, to);
      toast(out.message || '已改名', 'success', 8000);
      state.current = to;
      state.data = null;
      invalidateAll(app);
      await load(true);
    } catch (err) {
      toastError(err);
    } finally {
      if (btn) btn.textContent = label;
      paint();
    }
  }

  paint();
  load();
}
