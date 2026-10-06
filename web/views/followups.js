/**
 * 跟催：我承诺了什么 / 等谁回复。
 *
 * ## 这一页解决什么问题
 *
 * 收件箱是"别人要我做什么"，但真正容易漏的是另外两件事：
 *   - **我答应过别人要做什么**（说出口就忘了，对方却在等）；
 *   - **我在等谁回话**（发出去了，对方没动静，几天后才想起来）。
 * 两者都在**我发出的邮件**里，收件箱视角永远看不到。
 *
 * ## 为什么"等对方回复"不花钱
 *
 * 对方回没回是一道纯比对题：我发出的邮件带 messageId，进来的邮件带
 * In-Reply-To / References。本地就能算准，交给模型既不划算也不可靠。
 * 只有"我承诺了什么"需要模型理解语义。
 *
 * ## 状态语义与「需要你处理」完全一致
 *
 * 已处理 / 稍后提醒 / 忽略——复用同一套按钮与含义，不另发明一套词。
 */

import { api } from '../api.js';
import { confirmDialog, fmtFull, h, mount, toast, toastError } from '../dom.js';
import { invalidateAll, markLoaded, renderInto, viewState } from '../view-state.js';

const STATUS_LABEL = { open: '进行中', done: '已完成', snoozed: '稍后提醒', ignored: '已忽略' };

export function renderFollowUps(root, app) {
  const { state } = viewState(app, 'followups', () => ({
    loading: true,
    items: [],
    all: [],
    summary: null,
    config: null,
    scanning: false,
    error: null,
    /** 是否展开已完成/已忽略 */
    showClosed: false,
  }));

  const container = h('div', { class: 'view view-followups' });
  mount(root, container);
  /*
   * paintFn 必须自己把节点挂进容器：`renderInto` 只负责"调用 + 兜错"，
   * 不做挂载。直接传 `view` 会让页面一片空白（view() 只是"返回"节点），
   * 这个坑我踩过一次。
   */
  const paint = () => renderInto(container, app, 'followups', paintInner, () => renderFollowUps(root, app));

  function paintInner() {
    mount(container, view());
  }

  /* ------------------------------------------------------------ 视图 */

  function view() {
    if (state.loading) return h('p', { class: 'muted pad', text: '加载中…' });
    if (state.error) {
      return h('div', { class: 'alert alert-error' }, h('b', { text: '加载失败：' }), state.error);
    }

    const open = state.items.filter((f) => f.status === 'open' || f.status === 'snoozed');
    const mine = open.filter((f) => f.kind === 'mine');
    const waiting = open.filter((f) => f.kind === 'waiting');
    const closed = state.all.filter((f) => f.status === 'done' || f.status === 'ignored');

    return h(
      'div',
      {},
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { class: 'page-title', text: '跟催' }),
          h('p', { class: 'muted', text: '我答应过别人什么、我在等谁回话——这两件事都在我发出的邮件里，收件箱看不到。' }),
        ),
        h(
          'div',
          { class: 'head-actions' },
          h(
            'button',
            {
              class: 'btn btn-primary',
              disabled: state.scanning,
              onclick: (ev) => scan(ev.currentTarget),
            },
            state.scanning ? '扫描中…' : '立即扫描',
          ),
        ),
      ),

      h(
        'div',
        { class: 'stat-grid stat-grid-tight' },
        statCard('我承诺的', mine.length, `${state.summary?.mine || 0} 条未完成`),
        statCard('等对方回复', waiting.length, `${state.summary?.waiting || 0} 条未回复`),
        statCard('已超期', state.summary?.overdue || 0, '有截止时间且已过期'),
      ),

      (state.config && !state.config.enabled)
        ? h('div', { class: 'alert alert-info block-lead' }, '跟催功能已在「设置」里关闭。')
        : null,

      !open.length
        ? h(
            'div',
            { class: 'empty-state' },
            h('p', { text: '还没有跟催项。' }),
            h(
              'p',
              { class: 'muted small' },
              '点「立即扫描」：程序会看你**最近发出的邮件**——从里面找出你答应过的事，' +
                '以及发出超过 ' +
                (state.config?.waitHours ?? 24) +
                ' 小时仍没等到回复的邮件。刚发出去的不会算，免得催自己。',
            ),
          )
        : null,

      mine.length ? group('我承诺的', mine, '这些是我在邮件里答应要做的事（截止时间来自我当时写的话）') : null,
      waiting.length ? group('等对方回复', waiting, '这些是我发出去的、对方还没回的邮件') : null,

      closed.length
        ? h(
            'section',
            { class: 'block' },
            h(
              'div',
              { class: 'block-head' },
              h('h3', { text: `已完成 / 已忽略（${closed.length}）` }),
              h(
                'button',
                {
                  class: 'btn btn-small',
                  onclick: () => {
                    state.showClosed = !state.showClosed;
                    paint();
                  },
                },
                state.showClosed ? '收起' : '展开',
              ),
            ),
            state.showClosed ? h('div', { class: 'pad' }, ...closed.map(row)) : null,
          )
        : null,
    );
  }

  function statCard(label, value, hint) {
    return h(
      'div',
      { class: 'stat-card' },
      h('div', { class: 'stat-label', text: label }),
      h('div', { class: 'stat-value', text: String(value) }),
      h('div', { class: 'stat-hint', text: hint }),
    );
  }

  function group(title, items, hint) {
    return h(
      'section',
      { class: 'block' },
      h('div', { class: 'block-head' }, h('h3', { text: `${title}（${items.length}）` }), h('span', { class: 'muted small', text: hint })),
      h('div', { class: 'pad' }, ...items.map(row)),
    );
  }

  /** 一条跟催：标题、来源与时间、截止或已等多久、操作按钮。 */
  function row(f) {
    const overdue = f.dueAt && new Date(f.dueAt).getTime() < Date.now() && f.status === 'open';
    const closedTag = f.status !== 'open' ? STATUS_LABEL[f.status] : null;

    return h(
      'div',
      { class: `followup-row ${overdue ? 'followup-overdue' : ''} ${f.status !== 'open' ? 'followup-closed' : ''}` },
      h(
        'div',
        { class: 'followup-main' },
        h('div', { class: 'followup-title', text: f.title }),
        h(
          'div',
          { class: 'followup-meta muted small' },
          f.kind === 'mine'
            ? null
            : h('span', { class: 'tag', text: `等 ${f.waitingHours ?? '?'} 小时` }),
          f.counterparty ? h('span', { text: f.counterparty }) : null,
          f.dueAt
            ? h('span', { class: overdue ? 'error' : '', text: `${overdue ? '已超期：' : '截止：'}${fmtFull(new Date(f.dueAt))}` })
            : null,
          h('span', { text: `来源：${f.subject || '(无主题)'}${f.since ? ` · ${fmtFull(new Date(f.since))}` : ''}` }),
          closedTag ? h('span', { class: 'tag', text: closedTag }) : null,
          f.closeReason ? h('span', { class: 'muted', text: `（${f.closeReason}）` }) : null,
        ),
        f.detail ? h('div', { class: 'followup-detail muted small', text: f.detail }) : null,
        f.replyTrackable === false
          ? h('div', { class: 'muted small', text: '（这封没有 Message-ID，无法自动判断对方是否已回；请手动确认后关闭）' })
          : null,
      ),
      h(
        'div',
        { class: 'followup-actions' },
        f.status !== 'done' ? h('button', { class: 'btn btn-small', onclick: () => setStatus(f.id, 'done') }, '已完成') : null,
        h('button', { class: 'btn btn-small', onclick: (ev) => snooze(f.id, ev.currentTarget) }, '稍后'),
        f.status !== 'ignored' ? h('button', { class: 'btn btn-small', onclick: () => setStatus(f.id, 'ignored') }, '忽略') : null,
        h('button', { class: 'btn btn-small', onclick: () => setStatus(f.id, 'open') }, '恢复'),
      ),
    );
  }

  /* ------------------------------------------------------------ 动作 */

  async function load(force = false) {
    state.loading = !state.items.length;
    paint();
    try {
      const out = await api.followups();
      state.items = out.items || [];
      state.all = out.all || [];
      state.summary = out.summary || null;
      state.config = out.config || null;
      markLoaded(app, 'followups');
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      paint();
    }
  }

  /** 扫描：会调模型（提取承诺），所以先告诉用户会发生什么。 */
  async function scan(btn) {
    const cfg = state.config || {};
    if (cfg.extractCommitments) {
      const ok = await confirmDialog({
        title: '开始扫描？',
        message: h(
          'div',
          {},
          h('p', { class: 'small', text: '「等对方回复」部分**完全本地**计算，不花钱。' }),
          h('p', { class: 'small', text: '「我承诺了什么」会用模型读你最近发出的邮件（数量很少，一次调用即可）。' }),
        ),
        confirmText: '开始扫描',
      });
      if (!ok) return;
    }
    state.scanning = true;
    if (btn) btn.textContent = '扫描中…';
    paint();
    try {
      const out = await api.followUpsScan();
      toast(out.message || '扫描完成', out.llmError ? 'error' : 'success', 10_000);
      invalidateAll(app);
      await load(true);
    } catch (err) {
      toastError(err);
    } finally {
      state.scanning = false;
      if (btn) btn.textContent = '立即扫描';
      paint();
    }
  }

  async function setStatus(id, status) {
    try {
      const out = await api.setFollowUpStatus(id, status);
      state.summary = out.summary || state.summary;
      toast(status === 'done' ? '已标记完成' : status === 'ignored' ? '已忽略（不再跟踪）' : '已恢复', 'success');
      invalidateAll(app);
      await load(true);
      app.refreshCounts?.();
    } catch (err) {
      toastError(err);
    }
  }

  /** 稍后提醒：与「需要你处理」用同一套预设，避免两处语义不一致。 */
  async function snooze(id, btn) {
    const options = [
      { label: '明天上午', hours: 24 },
      { label: '三天后', hours: 72 },
      { label: '下周一', hours: null },
    ];
    const choice = await new Promise((resolve) => {
      const box = h(
        'div',
        { class: 'modal-overlay' },
        h(
          'div',
          { class: 'modal modal-narrow', role: 'dialog', 'aria-modal': 'true' },
          h('h3', { class: 'modal-title', text: '稍后提醒' }),
          h(
            'div',
            { class: 'modal-actions' },
            ...options.map((o) =>
              h(
                'button',
                {
                  class: 'btn btn-small',
                  onclick: () => {
                    box.remove();
                    resolve(o);
                  },
                },
                o.label,
              ),
            ),
            h(
              'button',
              {
                class: 'btn btn-small',
                onclick: () => {
                  box.remove();
                  resolve(null);
                },
              },
              '取消',
            ),
          ),
        ),
      );
      document.body.append(box);
    });
    if (!choice) return;
    let until;
    if (choice.hours) {
      until = new Date(Date.now() + choice.hours * 3600_000).toISOString();
    } else {
      // 下一个周一上午 9 点
      const d = new Date();
      const day = d.getDay();
      const add = (8 - day) % 7 || 7;
      d.setDate(d.getDate() + add);
      d.setHours(9, 0, 0, 0);
      until = d.toISOString();
    }
    await setStatus(id, 'snoozed');
    try {
      await api.setFollowUpStatus(id, 'snoozed', until);
    } catch {
      /* 上面已经设置过状态，这里只是补时间 */
    }
  }

  paint();
  load();
}
