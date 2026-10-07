/** 主壳：导航、全局进度、视图切换、计数徽标。 */

import { api, subscribeProgress } from './api.js';
import { attachmentButton, copyButton, fmtAddress, fmtBytes, fmtFull, h, mount, openModal, setDisplayTimeZone, toast, toastError } from './dom.js';
import { THEMES, applyTheme, effectiveTheme, initTheme } from './theme.js';
import { invalidate, invalidateAll } from './view-state.js';
import { renderMailHtml, restoreImages } from './sanitize-html.js';
import { openAssignDialog } from './assign-project.js';
import { renderOverview } from './views/overview.js';
import { renderDrafts } from './views/drafts.js';
import { renderSearch } from './views/search.js';
import { renderCalendar } from './views/calendar.js';
import { renderKnowledge } from './views/knowledge.js';
import { renderFollowUp } from './views/followup.js';
import { renderLogin } from './views/login.js';
import { renderRecords } from './views/records.js';
import { renderSetup } from './views/setup.js';
import { renderSettings } from './views/settings.js';

/*
 * 顶层导航。
 *
 * 「跟催」与「时间线」合并成一项「跟进」（进页面后用页签切换，见 views/followup.js）；
 * 「运行与记录」不再占顶层位置，改从「设置 → 运行与记录」卡片进入（nav: false 表示
 * 只有导航不出按钮，但 navigate / #/records 仍然可用）。
 *
 * `label` 与视图 id 保持一对一：路由、导航、标题都从这里来，不要再各写一份清单。
 */
const VIEWS = [
  { id: 'overview', label: '邮件总览' },
  { id: 'drafts', label: '邮件草稿' },
  { id: 'search', label: '对话查邮件' },
  { id: 'calendar', label: '日历' },
  { id: 'knowledge', label: '知识库' },
  { id: 'followup', label: '跟进' },
  { id: 'setup', label: '开始使用' },
  { id: 'settings', label: '设置' },
  { id: 'records', label: '运行与记录', nav: false },
];

/**
 * 合并前的旧入口 → 新入口。
 *
 * `#/followups` 与 `#/timeline` 曾经是两个独立菜单项，用户的书签与文档里的链接
 * 都指向它们。这里做一次映射（落到「跟进」页并指定页签），让老链接继续能用——
 * 合并菜单不等于把老地址变成 404。
 */
const LEGACY_VIEW_ALIAS = {
  followups: { view: 'followup', tab: 'followups' },
  timeline: { view: 'followup', tab: 'timeline' },
};

/** 把（可能是旧的）视图 id 解析成 `{view, tab}`；`tab` 为空表示无需指定页签。 */
function resolveView(id) {
  const alias = LEGACY_VIEW_ALIAS[id];
  return alias ? { ...alias } : { view: id, tab: null };
}

/** 供测试与调试使用的应用实例。 */
export { app };

const PHASE_TEXT = {
  starting: '准备中…',
  // 同账号串行化：另一个邮箱操作还没结束时，本次分析在排队（不是卡死）
  queued: '等待邮箱空闲…',
  connecting: '连接邮箱…',
  fetching: '拉取邮件…',
  reading: '读取正文…',
  threads: '整理会话…',
  analyzing: 'AI 分析中…',
  drafting: '起草回复…',
  reporting: '生成简报…',
  done: '完成',
  error: '失败',
  cancelled: '已取消',
};

const app = {
  current: null,
  viewId: null,
  running: false,
  counts: null,
  progress: null,
  els: {},
  /** 各视图持久化的内部状态（切走再切回不丢上下文） */
  viewStates: {},
  /** 跨视图跳转参数（例如「已发送邮件」要直达草稿页的「已发送」标签） */
  navParams: {},

  /**
   * 切换视图。
   * @param {string} viewId
   * @param {object} [params] 传给目标视图的一次性参数，由目标视图用 takeNavParams 取走
   *   （例如 `navigate('settings', { anchor: '外观' })` 让设置页滚到「外观」卡片，
   *   或 `navigate('followup', { tab: 'timeline' })` 直接落到对应页签）
   */
  navigate(viewId, params) {
    // 合并前的旧入口（followups / timeline）先归一到「跟进」页并带上页签参数
    const target = resolveView(viewId);
    if (target.tab) params = { ...(params || {}), tab: target.tab };
    viewId = target.view;
    if (!VIEWS.some((v) => v.id === viewId)) viewId = 'overview';
    const sameView = viewId === this.viewId;
    if (params && typeof params === 'object') this.navParams[viewId] = { ...(this.navParams[viewId] || {}), ...params };
    this.viewId = viewId;
    location.hash = `#/${viewId}`;
    this.renderView();
    this.paintNav();
    /*
     * 切换标签页要回到顶部：否则从长列表底部跳到另一页，会停在半空的内容里
     * （同一页内带着跳转参数重绘时不重置，避免「跳到某封草稿」被顶掉）。
     *
     * 例外：带**锚点**的跳转（`navigate('settings', { anchor })`）已经在 renderView 里
     * 由目标视图自己滚到指定区块了，这里再回顶部会把刚定位好的位置顶掉
     * （而且 scrollPageToTop 400ms 后还有一次硬跳 0 的兜底）。
     */
    const anchored = !!(params && typeof params === 'object' && params.anchor);
    if (!sameView) {
      if (!anchored) scrollPageToTop();
      app.syncBackToTop?.();
    }
  },

  /** 取出并清空跳转参数（一次性，避免下次普通进入页面又被带偏） */
  takeNavParams(viewId) {
    const params = this.navParams[viewId] || null;
    this.navParams[viewId] = null;
    return params;
  },

  renderView() {
    const view = VIEWS.find((v) => v.id === this.viewId) || VIEWS[0];
    const factory = {
      overview: renderOverview,
      drafts: renderDrafts,
      search: renderSearch,
      calendar: renderCalendar,
      knowledge: renderKnowledge,
      followup: renderFollowUp,
      records: renderRecords,
      setup: renderSetup,
      settings: renderSettings,
    }[view.id];
    this.current = factory(this.els.main, this) || null;
  },

  reloadCurrent() {
    if (this.current?.reload) return this.current.reload();
    this.renderView();
    return Promise.resolve();
  },

  /**
   * 声明数据已变更，所有视图下次进入时重新取数。
   * 任何会改数据的操作（起草 / 发送 / 删除 / 重写 / 补签名 / 补引文 / 同步草稿箱 /
   * 跑分析 / 改设置）结束后都必须调用它，否则总览的按钮状态会停留在旧值。
   */
  invalidateAll() {
    invalidateAll(this);
  },

  /** 标记单个视图过期。 */
  invalidate(key) {
    invalidate(this, key);
  },

  /**
   * 数据变更后统一收尾：失效缓存 + 刷新徽标 + **按当前视图重新取数**。
   *
   * 与 analyze() 早先的写法相比，这里对**所有**视图都走 reload（而不是只对
   * overview/knowledge），因为草稿页的 `reload` 才会真正重新拉列表。
   */
  async syncAfterChange() {
    this.invalidateAll();
    await this.refreshCounts();
    const reloaded = this.current?.reload?.();
    if (reloaded && typeof reloaded.then === 'function') await reloaded;
    else await this.reloadCurrent();
  },

  /**
   * 处理一条进度事件。
   *
   * 抽成方法（而不是内联在 subscribeProgress 里）有两个好处：
   * 一是定时任务跑完时**用户没点过任何按钮**，这里必须主动失效缓存并重取，
   *   否则页面要等用户手动刷新才更新（总览页已经没有「刷新」按钮了）；
   * 二是前端渲染测试可以直接投递事件验证这条链路，而不需要模拟 EventSource。
   */
  onProgressEvent(event) {
    if (!event || event.type === 'stream:error') return;
    /*
     * 定时分析跑完的提醒。
     *
     * 独立于进度条：它可能在**你没看页面**的时候到（页面开着但切到别的标签页），
     * 所以除了页内弹条，还要按需发浏览器桌面通知——只有邮件能在你什么都没打开时找到你。
     */
    if (event.type === 'notify') {
      this.handleNotify(event);
      return;
    }
    this.showProgress(event);
    if (event.type === 'run:done' || event.type === 'run:error') {
      this.invalidateAll();
      // 跑完就刷新徽标与当前页数据
      Promise.resolve(this.refreshCounts())
        .then(() => this.reloadCurrent())
        .catch(() => {});
    }
  },

  /** 定时任务的通知：页内弹条 + （可选）桌面通知。 */
  handleNotify(event) {
    const bits = [];
    if (event.needsReply) bits.push(`需要你处理 ${event.needsReply} 封`);
    if (event.drafts) bits.push(`新起草 ${event.drafts} 封`);
    const text = bits.length ? `自动分析完成：${bits.join('，')}` : `自动分析完成：拉取 ${event.fetched ?? 0} 封，没有需要你处理的`;
    toast(text, bits.length ? 'success' : 'info', 8000);
    this.invalidateAll();
    Promise.resolve(this.refreshCounts()).catch(() => {});

    // 桌面通知：只有用户开了开关、且浏览器已授权才发
    if (!this.notifyBrowser || typeof Notification === 'undefined') return;
    if (Notification.permission !== 'granted') return;
    try {
      const n = new Notification('轻效 · 邮件与日历数字人', { body: text, tag: 'mailbot-schedule' });
      n.onclick = () => {
        window.focus();
        this.navigate('overview');
      };
    } catch {
      /* 某些浏览器在非安全上下文下会抛，忽略即可 */
    }
  },

  async refreshCounts() {
    try {
      const res = await api.status();
      this.counts = res.counts;
      this.running = res.running;
      this.paintNav();
    } catch {
      /* 静默 */
    }
  },

  paintNav() {
    for (const btn of this.els.navButtons) {
      const id = btn.dataset.view;
      btn.classList.toggle('active', id === this.viewId);
      /*
       * 「开始使用」是**向导**：配置完成后它对用户就是噪音，直接隐藏。
       * 但设置页里仍留一个入口（「重新看一遍首次配置」），不让人找不回来。
       */
      if (id === 'setup') btn.hidden = this.health?.ready === true;
      /*
       * 「开始使用」在配置未完成时给一个提示点：全新装好后用户第一眼看到的是空页面，
       * 导航上得有个明确的地方告诉他"还没配完"。
       */
      const setupTodo = this.health?.ready === false ? 1 : 0;
      /*
       * 跟催徽标只显示**超期**数（不是未完成总数）：跟催项会慢慢积累，
       * 全算上的话徽标一直挂个数字，久了就没人看了——与「需留意」同样的取舍。
       * 合并成「跟进」后徽标挂在合并项上（跟催仍是其中默认打开的那个页签）。
       */
      const badge =
        id === 'drafts'
          ? this.counts?.pendingDrafts
          : id === 'overview'
            ? this.counts?.needsReply
            : id === 'followup'
              ? this.counts?.followUpOverdue
              : id === 'setup'
                ? setupTodo
                : 0;
      let dot = btn.querySelector('.nav-badge');
      if (badge) {
        if (!dot) {
          dot = h('span', { class: 'nav-badge' });
          btn.append(dot);
        }
        dot.textContent = String(badge);
      } else if (dot) {
        dot.remove();
      }
    }
  },

  paintRunButton() {
    const btn = this.els.runBtn;
    if (!btn) return;
    btn.disabled = this.running;
    btn.textContent = this.running ? '分析中…' : '分析最近 24 小时';
  },


  /* 全局进度条 */
  showProgress(event) {
    const bar = this.els.progress;
    if (!bar) return;
    const text = PHASE_TEXT[event.phase] || event.message || event.phase || '';
    if (event.type === 'run:start') {
      bar.hidden = false;
      bar.classList.remove('progress-error', 'progress-done');
      mount(
        bar,
        h('div', { class: 'progress-inner' },
          h('div', { class: 'spinner' }),
          h('span', { class: 'progress-text', text: text || '开始分析…' }),
          h('button', { class: 'link-btn', onclick: () => app.cancelRun() }, '取消'),
        ),
      );
      return;
    }
    if (event.type === 'phase' || event.type === 'analyze:progress' || event.type === 'read:progress' || event.type === 'fetch:progress') {
      bar.hidden = false;
      const detail =
        event.type === 'analyze:progress'
          ? `AI 分析 ${event.done}/${event.total} 封`
          : event.type === 'read:progress'
            ? `读取正文 ${event.done}/${event.total}`
            : event.type === 'fetch:progress'
              ? `拉取 ${event.folder} ${event.done}/${event.total}`
              : text;
      const pct =
        event.total && event.done !== undefined
          ? Math.round((event.done / event.total) * 100)
          : event.type === 'phase'
            ? null
            : null;
      mount(
        bar,
        h('div', { class: 'progress-inner' },
          h('div', { class: 'spinner' }),
          h('span', { class: 'progress-text', text: detail }),
          pct !== null ? h('span', { class: 'muted small', text: `${pct}%` }) : null,
          h('button', { class: 'link-btn', onclick: () => app.cancelRun() }, '取消'),
        ),
      );
      return;
    }
    if (event.type === 'draft:created') {
      toast(`已起草：${event.draft.subject}`, 'success', 2600);
    }
    if (event.type === 'run:done') {
      bar.classList.add('progress-done');
      mount(
        bar,
        h('div', { class: 'progress-inner' },
          h('span', { class: 'progress-text', text: `分析完成：${event.result.analyzed} 封，需回复 ${event.result.needsReply} 封，起草 ${event.result.drafts} 封` }),
        ),
      );
      setTimeout(() => {
        bar.hidden = true;
      }, 6000);
    }
    if (event.type === 'run:error') {
      bar.classList.add('progress-error');
      mount(
        bar,
        h('div', { class: 'progress-inner' },
          h('span', { class: 'progress-text', text: `分析失败：${event.message}` }),
          h('button', { class: 'link-btn', onclick: () => (bar.hidden = true) }, '关闭'),
        ),
      );
    }
  },

  async analyze(options = {}) {
    if (this.running) return toast('已有分析在进行中', 'info');
    this.running = true;
    this.paintRunButton();
    this.showProgress({ type: 'run:start' });
    try {
      const res = await api.run({ trigger: options.trigger || 'manual', windowHours: options.windowHours, scope: options.scope });
      const r = res.result;
      if (r?.cancelled) {
        toast('已取消分析', 'info');
      } else {
        this.showProgress({ type: 'run:done', result: r });
        toast(`分析完成：${r.analyzed} 封邮件，起草 ${r.drafts} 封`, 'success', 5000);
      }
      await this.refreshCounts();
      // 跑完分析后所有页面（尤其是草稿页的列表）都必须重新取数
      this.invalidateAll();
      await this.reloadCurrent();
      return r;
    } catch (err) {
      this.showProgress({ type: 'run:error', message: err.message });
      toast(err.message, 'error', 7000);
      throw err;
    } finally {
      this.running = false;
      this.paintRunButton();
    }
  },

  async cancelRun() {
    try {
      await api.cancel();
      toast('已请求取消，等待当前步骤结束', 'info');
    } catch (err) {
      toast(err.message, 'error');
    }
  },

  /** 对某一封邮件单独起草回复 */
  async draftFor(key) {
    const [folder, uid] = String(key).split(':');
    const res = await api.run({ scope: { folder, uid: Number(uid) }, trigger: 'single' });
    // 起草会改变「这封邮件有没有草稿」——总览的按钮状态依赖它，必须失效
    this.invalidateAll();
    await this.refreshCounts();
    return res.result;
  },

  /**
   * 查看某封邮件的分析详情。
   *
   * 走 `/api/mails/:folder/:uid`（不受 24 小时窗口限制），因此「对话查邮件」里检索到的
   * 上个月的邮件也能打开。三种情况都要有明确出路，不能只弹一句「未找到」：
   *   - 有分析记录 → 直接展示；
   *   - 只有归档原文 → 展示原文摘录 + 「立即分析这一封」；
   *   - 本地什么都没有 → 用检索结果里已有的信息兜底展示，并提示可以现场分析。
   *
   * @param {string} key `folder:uid`
   * @param {object} [fallback] 调用方已知的邮件信息（检索结果行），用于兜底展示
   * @param {object} [options] { tab: 'analysis' | 'original' }
   */
  async showMail(key, fallback = null, options = {}) {
    const [folder, uidRaw] = String(key || '').split(':');
    const uid = Number(uidRaw);
    if (!folder || !Number.isFinite(uid)) return toast('这封邮件的标识不完整，无法打开详情', 'error');
    try {
      const detail = await api.mailDetail(folder, uid);
      showMailModal(detail, fallback, this, options.tab || 'analysis');
    } catch (err) {
      // 404（本地没有任何记录）不是错误路径：用已知信息兜底，仍然让用户能操作
      if (err.status === 404 || err.code === 'ANALYSIS_NOT_FOUND') {
        showMailModal(
          { found: false, analyzed: false, mail: { folder, uid }, analysis: null, draft: null, body: null, rawExcerpt: null, note: '' },
          fallback,
          this,
        );
        return;
      }
      toastError(err);
    }
  },
};

/* ------------------------------------------------------------ 弹窗 */

/**
 * 邮件详情弹窗：两个页签。
 *
 *   「AI 分析」 —— 结论、待办、判断依据、关联草稿
 *   「原始邮件」 —— 邮件头 + **正文全文**（引用历史单独折叠）+ 附件 + 复制
 *
 * 为什么要有第二个页签：审稿时最需要的是"对方原话到底怎么说的"。
 * 只给一句 AI 摘要，用户还得回邮件客户端翻原信——这一步必须省掉。
 *
 * 正文只渲染**纯文本**（`<pre>`）：HTML 邮件原样注入会带来 XSS 面，
 * 而本项目所有分析都基于纯文本，展示纯文本也最忠实。
 *
 * @param {object} detail 后端 /api/mails/:folder/:uid 的返回
 * @param {object|null} fallback 调用方已知的邮件信息（检索结果行）
 * @param {object} app
 * @param {string} [initialTab] 'analysis' | 'original'
 */
/**
 * 正文块：纯文本，或（有 HTML 时）带切换与「显示图片」的容器。
 *
 * 净化只在**渲染的那一刻**做一次；切回纯文本不重新解析。
 */
/** 导出仅供测试：验证「渲染 HTML」入口的显示条件与按需获取行为。 */
export function makeBodyBlock(bodyInfo, plainBlock, loadHtml) {
  let html = typeof bodyInfo?.html === 'string' ? bodyInfo.html : '';
  /*
   * 服务端只给 hasHtml 这个**布尔标记**，不直接给正文（需求 F22.9：按需提供）。
   * 因此"这封邮件有没有 HTML"与"HTML 拿到了没"是两件事：
   * 前者决定按钮显不显示，后者在用户真的点下去时才补齐。
   */
  const canRender = !!html.trim() || bodyInfo?.hasHtml === true;
  if (!canRender) return plainBlock;

  const content = h('div', {}, plainBlock);
  let mode = 'text';
  let lastBlocked = 0;
  let showImagesBtn = null;

  const htmlBtn = h('button', { class: 'btn btn-small', onclick: () => switchTo('html') }, '渲染 HTML');
  const textBtn = h('button', { class: 'btn btn-small', onclick: () => switchTo('text') }, '纯文本');

  function paintButtons() {
    htmlBtn.classList.toggle('active', mode === 'html');
    textBtn.classList.toggle('active', mode === 'text');
    if (showImagesBtn) showImagesBtn.remove();
    showImagesBtn = null;
    if (mode === 'html' && lastBlocked > 0) {
      showImagesBtn = h(
        'button',
        {
          class: 'btn btn-small',
          onclick: () => {
            const n = restoreImages(content);
            lastBlocked = 0;
            paintButtons();
            if (n) app.toast?.('已显示 ' + n + ' 张远程图片（对方可能因此知道你打开了这封邮件）', 'warn');
          },
        },
        '显示图片（已拦 ' + lastBlocked + ' 张）',
      );
      toolbar.append(showImagesBtn);
    }
  }

  async function switchTo(next) {
    mode = next;
    if (next === 'html') {
      if (!html && typeof loadHtml === 'function') {
        htmlBtn.disabled = true;
        htmlBtn.textContent = '获取中…';
        try {
          html = (await loadHtml()) || '';
        } catch {
          html = '';
        }
        htmlBtn.disabled = false;
        htmlBtn.textContent = '渲染 HTML';
      }
      if (!html) {
        /*
         * 取不到就老实说，并把视图留在纯文本——
         * 不要给出一个"渲染了但空白"的状态，那会让人以为邮件本身是空的。
         */
        mode = 'text';
        content.replaceChildren(plainBlock);
        lastBlocked = 0;
        paintButtons();
        toast('取不到这封邮件的 HTML 正文，只能看纯文本', 'error');
        return;
      }
      const result = renderMailHtml(content, html, { allowRemoteImages: false });
      lastBlocked = result.blockedImages;
    } else {
      content.replaceChildren(plainBlock);
      lastBlocked = 0;
    }
    paintButtons();
  }

  const toolbar = h(
    'div',
    { class: 'mail-body-toolbar' },
    h('span', { class: 'muted small', text: '正文格式：' }),
    textBtn,
    htmlBtn,
  );
  paintButtons();
  return h('div', { class: 'mail-body-wrap' }, toolbar, content);
}

function showMailModal(detail, fallback, app, initialTab = 'analysis') {
  const analysis = detail.analysis || null;
  const bodyInfo = detail.body || null;
  const mail = { ...(fallback || {}), ...(detail.mail || {}) };
  // 原始邮件头以原文解析结果为准（更权威），列表项只作兜底
  const original = bodyInfo?.available
    ? {
        subject: bodyInfo.subject || mail.subject,
        from: bodyInfo.from || mail.from,
        to: bodyInfo.to?.length ? bodyInfo.to : mail.to,
        cc: bodyInfo.cc?.length ? bodyInfo.cc : mail.cc,
        date: bodyInfo.date || mail.date,
        messageId: bodyInfo.messageId || mail.messageId,
        attachments: bodyInfo.attachments?.length ? bodyInfo.attachments : mail.attachments,
      }
    : mail;

  const hasDraft = !!detail.draft;
  const sent = detail.draft?.status === 'sent';
  const bodyAvailable = bodyInfo?.available === true;
  const overlay = h('div', { class: 'modal-overlay' });
  let closeModal = () => {};
  const close = () => closeModal();
  overlay.onclick = (ev) => ev.target === overlay && close();

  /* ---------------------------------------------------------- 主操作 */

  /** 底部主操作：有草稿就去看草稿，没有就现起草。 */
  function draftAction() {
    if (hasDraft) {
      return h(
        'button',
        {
          class: 'btn btn-primary',
          onclick: () => {
            close();
            app.navigate('drafts', { tab: sent ? 'sent' : 'pending', draftId: detail.draft.id });
          },
        },
        sent ? '查看已发送邮件' : '查看草稿',
      );
    }
    return h(
      'button',
      {
        class: 'btn btn-primary',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = '起草中…';
          try {
            await app.draftFor(`${mail.folder}:${mail.uid}`);
            close();
            toast('草稿已生成', 'success');
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

  /** 没有分析记录时的补救入口：就地把这一封拉下来分析。 */
  function analyzeAction() {
    if (analysis) return null;
    return h(
      'button',
      {
        class: 'btn',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          btn.textContent = '分析中…';
          try {
            const result = await app.draftFor(`${mail.folder}:${mail.uid}`);
            // 单封分析同时会走一遍起草逻辑：如果这封确实需要回复，会顺手生成草稿
            if (result?.drafts > 0) {
              toast('已分析这一封，并生成了回复草稿', 'success', 5000);
              close();
              app.navigate('drafts', { tab: 'pending' });
              return;
            }
            toast('已分析这一封', 'success');
            close();
            await app.reloadCurrent();
          } catch (err) {
            toast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = '立即分析这一封';
          }
        },
      },
      '立即分析这一封',
    );
  }

  /* ---------------------------------------------------------- 页签内容 */

  function analysisPanel() {
    return h(
      'div',
      { class: 'panel-body' },
      !analysis ? h('div', { class: 'alert alert-info' }, detail.note || '这封邮件还没有做过 AI 分析。') : null,
      analysis?.summary ? h('blockquote', { class: 'quote', text: analysis.summary }) : null,
      analysis?.actions?.length
        ? h(
            'div',
            { class: 'panel-section' },
            h('div', { class: 'panel-label' }, '待办'),
            h('ul', { class: 'action-list' }, ...analysis.actions.map((a) => h('li', { text: a }))),
          )
        : null,
      analysis?.reason ? h('p', { class: 'muted small', text: `判断依据：${analysis.reason}` }) : null,
      analysis
        ? h(
            'p',
            { class: 'muted small' },
            `类型：${analysis.typeLabel || '—'}　优先级：${analysis.priorityLabel || '—'}　` +
              `收件方式：${analysis.recipientKind === 'cc' ? '仅抄送我' : analysis.recipientKind === 'direct' ? '直接发我' : '未知'}`,
          )
        : null,
      detail.draft
        ? h(
            'p',
            { class: 'muted small' },
            `关联草稿：${sent ? `已于 ${fmtFull(detail.draft.sentAt)} 发送` : '待审核'}（${detail.draft.subject}）` +
              (detail.draft.quoted ? '　·　已带原文引文' : '　·　未带原文引文'),
          )
        : null,
      mail.snippet && !analysis ? h('p', { text: mail.snippet }) : null,
    );
  }

  function originalPanel() {
    const atts = original.attachments || [];
    const head = h(
      'dl',
      { class: 'mail-head-list' },
      metaRow('发件人', fmtAddress(original.from)),
      metaRow('收件人', (original.to || []).map(fmtAddress).join('、') || '—'),
      (original.cc || []).length ? metaRow('抄送', original.cc.map(fmtAddress).join('、')) : null,
      metaRow('时间', fmtFull(original.date)),
      original.messageId ? metaRow('Message-ID', original.messageId, { mono: true }) : null,
    );

    if (!bodyAvailable) {
      return h(
        'div',
        { class: 'panel-body' },
        head,
        h('div', { class: 'alert alert-warn' }, bodyInfo?.reason || '本地没有这封邮件的原文，无法显示全文。'),
      );
    }

    /*
     * 正文：有 HTML 版本时给一个「渲染 HTML / 纯文本」切换。
     *
     * 为什么默认**不**直接渲染 HTML：
     *   ① HTML 是外部输入，渲染前必须过白名单净化（见 web/sanitize-html.js）；
     *   ② 纯文本更"可信"——不受样式干扰，能看到原始换行；
     *   ③ 罪魁祸首是远程图片：一渲染就可能替对方确认"我打开过"。
     *      所以渲染后若拦下了图片，明确告诉用户拦了几张，由他决定要不要加载。
     */
    const plainBlock = h('pre', { class: 'mail-body-text', text: bodyInfo.text || '（正文为空）' });
    const textBlock = makeBodyBlock(bodyInfo, plainBlock, () =>
      api.mailDetail(mail.folder, mail.uid, { withHtml: true }).then((d) => d?.body?.html || ''),
    );
    const quotedBlock = bodyInfo.quoted
      ? h(
          'details',
          { class: 'mail-quoted' },
          h('summary', { text: `查看引用历史（${bodyInfo.quoted.length} 字）` }),
          h('pre', { class: 'mail-body-text muted small', text: bodyInfo.quoted }),
        )
      : null;

    return h(
      'div',
      { class: 'panel-body' },
      head,
      atts.length ? attachmentList(atts) : null,
      h(
        'div',
        { class: 'panel-toolbar' },
        h('span', { class: 'muted small', text: `${bodyInfo.chars} 字${bodyInfo.source === 'imap' ? '　·　刚刚从服务器取回' : '　·　来自本地归档'}` }),
        copyButton(() => bodyInfo.text || '', { label: '复制正文', title: '复制原始邮件正文' }),
      ),
      textBlock,
      quotedBlock,
    );
  }

  /**
   * 附件清单。
   *
   * 关键点：**序号必须与后端下载接口用的一致**。两边都用
   * `visibleAttachments()` 过滤内嵌图片，所以这里的下标可以直接当接口参数。
   * 附件内容本来就随原文存在本地归档里，点「保存」不会再去连邮箱。
   */
  function attachmentList(atts) {
    return h(
      'div',
      { class: 'attachment-list' },
      h(
        'div',
        { class: 'panel-label' },
        `附件（${atts.length}）`,
        h('span', { class: 'muted small', text: '　保存在本机，不会自动下载' }),
      ),
      ...atts.map((a, i) => {
        const name = a.filename || `附件-${i + 1}`;
        return h(
          'div',
          { class: 'attachment-row' },
          h('span', { class: 'attachment-icon', text: '📎' }),
          h(
            'span',
            { class: 'attachment-name', title: name },
            name,
          ),
          h('span', { class: 'attachment-meta', text: attachmentMeta(a) }),
          attachmentButton(() => api.attachmentUrl(mail.folder, mail.uid, i), name),
        );
      }),
    );
  }

  /** 附件的大小与类型提示。 */
  function attachmentMeta(a) {
    const size = typeof a.size === 'number' && a.size > 0 ? fmtBytes(a.size) : '';
    const type = String(a.contentType || '').split(';')[0].replace('application/', '').replace('image/', '');
    return [type, size].filter(Boolean).join(' · ');
  }

  function metaRow(label, value, { mono = false } = {}) {
    return h(
      'div',
      { class: 'mail-head-row' },
      h('dt', { text: label }),
      h('dd', { class: mono ? 'mono' : '', text: value || '—' }),
    );
  }

  /* ---------------------------------------------------------- 组装 */

  const tabs = [
    { id: 'analysis', label: 'AI 分析' },
    { id: 'original', label: '原始邮件', disabled: false },
  ];
  let active = tabs.some((t) => t.id === initialTab) ? initialTab : 'analysis';
  const tabBar = h('div', { class: 'tabs tabs-inline modal-tabs', role: 'tablist' });
  const panel = h('div', { class: 'modal-panel' });

  const paintTabs = () => {
    mount(
      tabBar,
      ...tabs.map((t) =>
        h(
          'button',
          {
            class: `tab ${active === t.id ? 'active' : ''}`,
            role: 'tab',
            'aria-selected': active === t.id ? 'true' : 'false',
            onclick: () => {
              active = t.id;
              paintTabs();
            },
          },
          t.label,
          t.id === 'original' && bodyAvailable ? h('span', { class: 'tab-badge', text: `${bodyInfo.chars} 字` }) : null,
        ),
      ),
    );
    mount(panel, active === 'original' ? originalPanel() : analysisPanel());
  };
  paintTabs();

  const modal = h(
    'div',
    { class: 'modal modal-wide modal-mail', role: 'dialog', 'aria-modal': 'true' },
    h(
      'div',
      { class: 'modal-head' },
      h('h3', { class: 'modal-title', text: original.subject || mail.subject || analysis?.subject || '(无主题)' }),
      h('div', { class: 'modal-head-actions' }, copyButton(() => String(original.messageId || ''), { label: '复制 Message-ID', className: 'btn btn-small btn-quiet' })),
    ),
    tabBar,
    panel,
    h(
      'div',
      { class: 'modal-actions' },
      /*
       * 归类入口也放在邮件详情里：用户从"这封邮件归错类了"的现场出发时，
       * 不该被要求先回到时间线页面去找它。
       */
      (mail.folder && mail.uid)
        ? h(
            'button',
            {
              class: 'btn',
              onclick: () =>
                openAssignDialog({
                  folder: mail.folder,
                  uid: mail.uid,
                  title: original.subject || mail.subject || '',
                  current: analysis?.project || '',
                  onDone: () => {
                    close();
                    app.refreshCounts?.();
                  },
                }),
            },
            '归类到项目…',
          )
        : null,
      h('button', { class: 'btn', onclick: close }, '关闭'), analyzeAction(), draftAction()),
  );
  overlay.append(modal);
  closeModal = openModal(overlay);
}

/* ------------------------------------------------------------ 启动 */

/** 品牌名。改这里一处即可（顶栏、标题、页脚都引用它）。 */
export const BRAND = '轻效 | Ease & Effect';

function buildShell(root) {
  // 只有非 nav:false 的项才生成导航按钮（「运行与记录」从设置页进入，不占顶层）
  const navButtons = VIEWS.filter((v) => v.nav !== false).map((v) =>
    h('button', { class: 'nav-btn', dataset: { view: v.id }, onclick: () => app.navigate(v.id) }, v.label),
  );
  const progress = h('div', { class: 'progress-bar', hidden: true });

  /*
   * 返回顶部。
   *
   * 页面本身（window/document）才是滚动容器：`.main` 没有 overflow，
   * 所以长列表（例如「值得知悉」展开一百多封）会把整个页面撑长。
   * 因此监听 window 的滚动，超过一屏的一半才出现，避免在短页面里打扰。
   */
  const backToTop = h(
    'button',
    {
      class: 'back-to-top',
      type: 'button',
      title: '返回顶部',
      'aria-label': '返回顶部',
      hidden: true,
      onclick: () => scrollPageToTop(),
    },
    h('span', { class: 'back-to-top-arrow', text: '↑' }),
    h('span', { class: 'back-to-top-text', text: '顶部' }),
  );

  // 右上角品牌标志（Logo 图片 + 名称）。分析入口只保留在「邮件总览」页内，这里不再放「分析最近 24 小时」。
  const logo = h(
    'div',
    { class: 'brand-lockup', title: `${BRAND} · 邮箱与日历数字人` },
    h('img', { class: 'topbar-logo', src: './assets/logo.png', alt: BRAND }),
    h('span', { class: 'topbar-brand-name', text: BRAND }),
  );

  const shell = h(
    'div',
    { class: 'app' },
    h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'brand' },
        h('span', { class: 'brand-mark', text: '✉' }),
        h(
          'div',
          {},
          h('div', { class: 'brand-name', text: '邮箱与日历数字人' }),
          h('div', { class: 'brand-sub', text: 'IMAP/SMTP · Google 日历 · 按对话意图取数' }),
        ),
      ),
      h('nav', { class: 'nav', role: 'tablist' }, ...navButtons),
      /*
       * 顶栏只留品牌标识与进度：外观模式挪到了设置页。
       * 顶栏挤太多东西会让导航在普通宽度下换行（外观三连按钮本身要占约 200px）。
       */
      h('div', { class: 'topbar-actions' }, logo),
    ),
    progress,
    h('main', { class: 'main', id: 'main' }),
    backToTop,
    h(
      'footer',
      { class: 'footer' },
      h('span', { text: '邮箱与日历数字人 | © 2026 mail.wwu@gmail.com | 供个人/内部使用' }),
    ),
  );

  mount(root, shell);
  app.els = { navButtons, progress, main: shell.querySelector('#main'), backToTop };
  bindBackToTop(backToTop);
}

/**
 * 返回顶部按钮的滚动联动。
 *
 * 用 `passive` 监听并只在**跨越阈值时**改一次 DOM：滚动事件每秒可能触发几十次，
 * 每次都写 hidden/class 会造成明显的滚动掉帧。
 */
function bindBackToTop(button) {
  if (!button) return;
  const THRESHOLD = 320;
  let shown = false;
  const sync = () => {
    const y = window.scrollY || document.documentElement?.scrollTop || 0;
    const next = y > THRESHOLD;
    if (next === shown) return;
    shown = next;
    button.hidden = !next;
    button.classList.toggle('is-visible', next);
  };
  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync, { passive: true });
  sync();
  app.syncBackToTop = sync;
}

/**
 * 平滑回到页面顶部。
 *
 * 先判存在再调用：最小 DOM 环境（测试用的 linkedom）没有 `window.scrollTo`，
 * 而"回退到无参调用"会把 TypeError 再抛一次——这个坑之前在 scrollToEl 上踩过一次。
 */
export function scrollPageToTop() {
  if (typeof window?.scrollTo !== 'function') return;
  try {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch {
    /* 不支持对象参数时忽略，下面的兜底会处理 */
  }
  // 某些环境下平滑滚动不生效（或被 prefers-reduced-motion 关掉），兜一次底
  setTimeout(() => {
    try {
      if ((window.scrollY || 0) > 4) window.scrollTo(0, 0);
    } catch {
      /* 忽略 */
    }
  }, 400);
}

/**
 * 外观模式切换（浅色 / 深色 / 绿色）。
 *
 * 三个按钮常驻顶栏：外观是随时可能想调的东西，埋进设置页反而找不到。
 * 点击即生效并记住；没点过的时候跟随系统（老用户升级后外观不会突变）。
 */
/** 导出给设置页复用（顶栏已不再放它，避免窄屏换行）。 */
export function themeSwitcher() {
  const buttons = [];
  const paint = () => {
    const active = effectiveTheme();
    for (const btn of buttons) {
      const on = btn.dataset.theme === active;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  };
  const group = h('div', { class: 'theme-switch', role: 'group', 'aria-label': '外观模式' });
  for (const theme of THEMES) {
    const btn = h(
      'button',
      {
        class: 'theme-btn',
        dataset: { theme: theme.id },
        title: `${theme.label}（${theme.hint}）`,
        onclick: () => {
          applyTheme(theme.id);
          paint();
        },
      },
      h('span', { class: 'theme-icon', 'aria-hidden': 'true', text: theme.icon }),
      theme.label,
    );
    buttons.push(btn);
    group.append(btn);
  }
  paint();
  app.els.themeButtons = buttons;
  app.paintTheme = paint;
  return group;
}

export function boot() {
  const root = document.getElementById('root');
  // 外观模式要在渲染外壳之前定下来，否则切换按钮的选中态会对不上。
  // initTheme() 返回取消监听函数（系统外观变化时自动跟随）。
  app.stopThemeWatch = initTheme();

  /*
   * 先问一句"要不要登录"。
   *
   * 放在建外壳之前：没登录时整个界面都没有意义（每个接口都会 401），
   * 直接给一张登录卡片比"先渲染一堆空列表再报错"清楚得多。
   */
  if (!app.bootChecked) {
    app.bootChecked = true;
    api
      .session()
      .then((s) => {
        if (s?.needLogin) renderLogin(root, app);
        else bootShellAndViews(root);
      })
      .catch(() => bootShellAndViews(root));
    return;
  }
  bootShellAndViews(root);
}

/** 建外壳、接事件、渲染首屏。 */
function bootShellAndViews(root) {
  buildShell(root);

  subscribeProgress((event) => app.onProgressEvent(event));

  window.addEventListener('hashchange', () => {
    const id = location.hash.replace(/^#\/?/, '') || 'overview';
    if (id !== app.viewId) app.navigate(id);
  });

  /*
   * 首屏视图来自地址栏。旧链接（#/followups、#/timeline）在这里也解析一次，
   * 否则 `VIEWS.some(...)` 会把它们判成无效 id 而退回总览——书签就白存了。
   */
  const initial = resolveView(location.hash.replace(/^#\/?/, '') || 'overview');
  app.viewId = VIEWS.some((v) => v.id === initial.view) ? initial.view : 'overview';
  if (initial.tab) {
    app.navParams[app.viewId] = { ...(app.navParams[app.viewId] || {}), tab: initial.tab };
    // 把地址栏改写回新入口，避免刷新一次又走一遍兼容分支
    try {
      location.hash = `#/${app.viewId}`;
    } catch {
      /* 最小 DOM 环境里 location 可能是只读对象，忽略即可 */
    }
  }
  app.paintNav();
  app.renderView();
  app.refreshCounts();
  setInterval(() => app.refreshCounts(), 20_000);

  // 取一次展示时区：界面所有时间都按邮箱/日历所在时区渲染，而不是浏览器时区
  api
    .meta()
    .then((meta) => {
      if (meta?.timeZone) {
        setDisplayTimeZone(meta.timeZone);
        app.timeZone = meta.timeZone;
        // 时区变了意味着所有已渲染的时间都要重画
        app.invalidateAll();
        app.reloadCurrent();
      }
    })
    .catch(() => {});

  /*
   * 桌面通知是否开启由**服务端配置**说了算（设置页里的开关），
   * 这里只在启动时读一次；浏览器权限由设置页在打开开关时申请。
   */
  api
    .getConfig()
    .then((res) => {
      app.notifyBrowser = res?.config?.notify?.browser === true;
    })
    .catch(() => {});

  /*
   * 体检一次：配置没配完时（全新安装）自动把用户送到「开始使用」向导，
   * 并在导航上留下提示点。这是交付给他人时最关键的第一次体验。
   */
  api
    .health()
    .then((health) => {
      app.health = health;
      app.paintNav();
      if (!health?.ready && (health?.fresh || !location.hash.replace(/^#\/?/, ''))) {
        app.navigate('setup');
      }
    })
    .catch(() => {});
}
