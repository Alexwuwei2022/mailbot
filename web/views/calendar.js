/** 日历页：对话建日程 + 今日/明日/近 7 天分析 + 邮件转日程。 */

import { api } from '../api.js';
import { confirmDialog, h, mount, openModal, toast, toastError } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { renderInto, viewState } from '../view-state.js';

const KIND_LABEL = { meeting: '会议', deadline: '截止', delivery: '交付', reminder: '提醒' };

export function renderCalendar(root, app) {
  const { state, hydrated } = viewState(app, 'calendar', () => ({
    loading: true,
    error: null,
    status: null,
    insight: null,
    loadingInsight: false,
    sessionId: null,
    messages: [],
    pending: null,
    sending: false,
    suggestions: null,
    loadingSuggestions: false,
  /** 扫描过程中的说明（含"会自动补一次分析"的提示） */
  loadingHint: '',
    days: 7,
    hint: null,
    /** 是否已经成功取过数据（用于判断切回时要不要重新拉取） */
    fetched: false,
  }));

  const container = h('div', { class: 'view view-calendar' });
  mount(root, container);

  /* ---------------------------------------------------------- 渲染 */

  const paint = () => renderInto(container, app, 'calendar', paintInner, () => {
    state.loading = true;
    state.error = null;
    state.insight = null;
    state.messages = [];
    state.pending = null;
    state.sessionId = null;
    state.fetched = false;
    state.hint = null;
    renderCalendar(root, app);
  });

  /**
   * 打开 Google 授权页。
   *
   * 抽成函数是因为它现在有**三个**入口：授权前的引导区、页头的"重新连接"、
   * 以及**报错页**——错误文案里写着"请重新点击「连接 Google 日历」"，
   * 而原先报错页只给了一个「重试」按钮：**文案承诺的动作在页面上并不存在**。
   */
  async function connectGoogle(btn) {
    const label = btn?.textContent || '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '正在打开授权页…';
    }
    try {
      const out = await api.calendarAuthUrl(state.status?.suggestedRedirectUri);
      const win = window.open(out.url, 'mailbot-google-oauth', 'width=520,height=680');
      if (!win) {
        toast('浏览器拦截了弹窗。请允许弹窗后重试，或复制授权链接手动打开。', 'error', 8000);
        return null;
      }
      toast('已打开 Google 授权页，完成后窗口会自动关闭', 'info', 6000);
      return out;
    } catch (err) {
      toastError(err);
      return null;
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = label;
      }
    }
  }

  const paintInner = () => {
    if (state.loading) {
      mount(container, h('p', { class: 'muted pad', text: '加载中…' }));
      return;
    }
    if (state.error) {
      /*
       * 授权类错误（令牌被撤销 / 从未连接）**不能只给「重试」**：
       * 重试一百次也没用，唯一出路是重新授权。所以这里直接把那个按钮摆出来，
       * 并说明最可能的原因（测试状态下 refresh token 只有 7 天）。
       */
      const authBroken =
        state.errorCode === 'OAUTH_REFRESH_REVOKED' ||
        state.errorCode === 'OAUTH_REFRESH_FAILED' ||
        state.errorCode === 'OAUTH_NO_REFRESH_TOKEN' ||
        state.errorCode === 'GOOGLE_NOT_CONNECTED';
      mount(
        container,
        h(
          'div',
          { class: 'empty-state' },
          h('div', { class: 'empty-icon', text: authBroken ? '🔑' : '⚠️' }),
          h('h3', { text: authBroken ? '需要重新连接 Google 日历' : '无法加载日历' }),
          h('p', { text: state.error }),
          authBroken
            ? h(
                'p',
                { class: 'muted small' },
                '这是授权过期，不是配置错——代理、OAuth 凭据都不用动。点上面的按钮重新授权一次即可。' +
                  '最常见的原因是 OAuth 同意屏幕仍处于「测试」发布状态：**测试状态下 refresh token 只有 7 天有效期**，' +
                  '到期就必须重新授权；把发布状态改为「已发布」即可免去这个周期。',
              )
            : null,
          h(
            'div',
            { class: 'row-actions mt-3' },
            authBroken
              ? h('button', { class: 'btn btn-primary', onclick: (ev) => connectGoogle(ev.currentTarget) }, '重新连接 Google 日历')
              : null,
            h('button', { class: authBroken ? 'btn' : 'btn btn-primary', onclick: load }, '重试'),
            h('button', { class: 'btn', onclick: () => app.navigate('settings') }, '日历设置'),
          ),
        ),
      );
      return;
    }

    const status = state.status;
    mount(
      container,
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { text: '日历数字人' }),
          h(
            'p',
            { class: status.needsReauth ? 'error' : 'muted' },
            status.needsReauth
              ? `授权已失效，需要重新连接${status.email ? `（上次连接的是 ${status.email}）` : ''}　·　时区 ${status.timeZone}`
              : status.ready
                ? `已连接 Google 日历${status.email ? `（${status.email}）` : ''}　·　时区 ${status.timeZone}`
                : '用自然语言描述日程即可写入 Google 日历；也可以把邮件转成日程。',
          ),
        ),
        h(
          'div',
          { class: 'head-actions' },
          // 授权失效时，"刷新日历"没有意义，直接给"重新连接"
          status.needsReauth
            ? h('button', { class: 'btn btn-primary nowrap', onclick: (ev) => connectGoogle(ev.currentTarget) }, '重新连接 Google 日历')
            : status.ready
              ? h(
                  'button',
                  {
                    class: 'btn',
                    disabled: state.loadingInsight,
                    onclick: () => refreshAll(),
                  },
                  state.loadingInsight ? '刷新中…' : '刷新日历',
                )
              : null,
          h('button', { class: 'btn', onclick: () => app.navigate('settings') }, '日历设置'),
        ),
      ),
    );

    if (!status.enabled || !status.ready) {
      container.append(connectPanel(status));
      return;
    }

    container.append(
      h(
        'div',
        { class: 'calendar-layout' },
        /*
         * 「从邮件生成日程」放在左栏、紧跟「对话建日程」之后。
         *
         * 之前它在右栏最底部：两个"产生日程"的入口被整栏分析内容隔开，
         * 用户从对话区要一路滚到底才能找到邮件扫描，等于把同一类操作拆到两处。
         * 待确认卡片（pendingPanel）仍紧跟对话区——它本身就是对话的确认步骤。
         */
        h('div', { class: 'calendar-left' }, chatPanel(), pendingPanel(), suggestionsPanel()),
        h('div', { class: 'calendar-right' }, insightPanel()),
      ),
    );
  };

  /* ---------------------------------------------------------- 未连接 */

  function connectPanel(status) {
    const steps = state.hint?.setupSteps || [
      '打开 Google Cloud Console，创建项目并启用 Google Calendar API',
      '配置 OAuth 同意屏幕（用户类型选「外部」），把你的 Google 账号加入「测试用户」',
      '创建「Web 应用」类型的 OAuth 客户端 ID',
      `授权重定向 URI 填：${status.suggestedRedirectUri}`,
      '把客户端 ID 与密钥填到「设置 → 日历」，保存后回到本页点「连接」',
    ];
    return h(
      'div',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', {
          text: status.needsReauth ? '需要重新连接 Google 日历' : status.enabled ? '还需要完成 Google 授权' : '日历功能未启用',
        }),
      ),
      h(
        'div',
        { class: 'setup-inner' },
        /*
         * 授权失效要走**和"从未授权"不同的话术**：
         * 配置全都是对的，让用户去翻 OAuth 凭据只会白折腾。
         * 这里把最可能的原因（测试发布状态下 refresh token 只有 7 天）直接说出来。
         */
        status.needsReauth
          ? h(
              'div',
              { class: 'alert alert-warn block-lead' },
              h('div', {}, h('b', { text: '上次的授权已经失效，需要重新授权一次。' })),
              h(
                'div',
                { class: 'small mt-1' },
                '这不是配置错——OAuth 凭据、代理都不用改。' +
                  (status.email ? `上次连接的是 ${status.email}。` : '') +
                  (status.lastRefreshError ? `Google 返回：${status.lastRefreshError}` : ''),
              ),
              h(
                'div',
                { class: 'small mt-2' },
                h('b', { text: '为什么会过期？' }),
                '最常见的原因是 Google Cloud 里 OAuth 同意屏幕仍是「**测试**」发布状态——' +
                  '测试状态下 refresh token 只有 **7 天**有效期，到期后必须重新授权。' +
                  '把发布状态改为「已发布」就能免去这个 7 天周期。',
              ),
            )
          : null,
        status.enabled
          ? h(
              'div',
              {},
              h('p', { class: 'muted small', text: `建议的回调地址（需与 Google Cloud 里填写的完全一致）：${status.suggestedRedirectUri}` }),
              h(
                'div',
                { class: 'alert alert-info block-lead' },
                h('div', {}, h('b', { text: '授权时请务必选择已加入「测试用户」的那个 Google 账号。' })),
                h(
                  'div',
                  { class: 'small mt-1' },
                  'OAuth 同意屏幕处于「测试」状态时，只有测试用户名单里的账号能授权；用别的账号登录会看到「尚未完成 Google 验证流程 / access_denied」。',
                ),
                h(
                  'div',
                  { class: 'small mt-2' },
                  h('b', { text: '中途会看到「此应用未经 Google 验证」的警告页' }),
                  '：这是测试应用的正常确认步骤（页面会写明「您获得了授权」）。' +
                    '请点左侧的「继续」，不要点右侧高亮的「返回到安全网页」——后者等于放弃授权。' +
                    '如需长期使用，可在 OAuth 同意屏幕页面点「发布应用」。',
                ),
              ),
              h(
                'div',
                { class: 'editor-actions' },
                h(
                  'button',
                  {
                    class: 'btn btn-primary',
                    disabled: !status.configured,
                    onclick: (ev) => connectGoogle(ev.currentTarget),
                  },
                  status.needsReauth ? '重新连接 Google 日历' : '连接 Google 日历',
                ),
                h(
                  'button',
                  {
                    class: 'btn',
                    onclick: async () => {
                      try {
                        const out = await api.calendarAuthUrl(status.suggestedRedirectUri);
                        await navigator.clipboard?.writeText(out.url);
                        toast('授权链接已复制，可在浏览器打开', 'success');
                      } catch (err) {
                        toastError(err);
                      }
                    },
                  },
                  '复制授权链接',
                ),
              ),
              !status.configured
                ? h(
                    'div',
                    { class: 'alert alert-warn mt-3' },
                    `还缺少：${status.configProblems.join('；')}`,
                  )
                : null,
            )
          : h('p', { class: 'muted', text: '请到「设置 → 日历」勾选「启用日历数字人」，填写 Google OAuth 凭据后回到本页。' }),
        h('h4', { class: 'form-section' }, '配置步骤'),
        h('ol', { class: 'setup-steps' }, ...steps.map((s) => h('li', { text: s }))),
        state.hint?.note ? h('p', { class: 'muted small', text: state.hint.note }) : null,
      ),
    );
  }

  /* ---------------------------------------------------------- 对话 */

  function chatPanel() {
    const examples = ['明天下午三点和客户电话沟通 30 分钟', '下周三下午两点项目评审会，会议室B，李工参加', '看看我这周有什么安排'];
    const input = h('textarea', {
      class: 'textarea chat-input',
      rows: 3,
      placeholder: '用一句话描述日程，例如「明天上午 10 点和张总开会，1 小时，会议室 A」',
      onkeydown: (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          send();
        }
      },
    });

    async function send() {
      const text = input.value.trim();
      if (!text || state.sending) return;
      state.messages.push({ role: 'user', content: text, at: new Date().toISOString() });
      input.value = '';
      state.sending = true;
      paint();
      try {
        const out = await api.calendarChat({ sessionId: state.sessionId, message: text });
        state.sessionId = out.sessionId;
        state.messages.push({ role: 'assistant', content: out.assistant, at: new Date().toISOString(), kind: out.kind });
        state.pending = out.pending || null;
        if (out.kind === 'list') {
          state.insight = { ...(state.insight || {}), ...(out.analysis || {}) };
        }
        if (out.kind === 'confirm') {
          state.lastEvent = out.event;
        }
      } catch (err) {
        state.messages.push({ role: 'assistant', content: `出错：${err.message}`, at: new Date().toISOString(), error: true });
        toastError(err);
      } finally {
        state.sending = false;
        const area = container.querySelector('.chat-body');
        paint();
        const next = container.querySelector('.chat-body');
        if (next) next.scrollTop = next.scrollHeight;
        void area;
      }
    }

    return h(
      'section',
      { class: 'block chat-block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: '对话建日程' }),
        state.messages.length
          ? h(
              'button',
              {
                class: 'link-btn',
                onclick: () => {
                  state.sessionId = null;
                  state.messages = [];
                  state.pending = null;
                  paint();
                },
              },
              '新对话',
            )
          : null,
      ),
      h(
        'div',
        { class: 'chat-body' },
        state.messages.length === 0
          ? h(
              'div',
              { class: 'chat-empty' },
              h('p', { class: 'muted small', text: '试试这样说：' }),
              ...examples.map((e) =>
                h(
                  'button',
                  {
                    class: 'chip chip-btn',
                    onclick: () => {
                      input.value = e;
                      paint();
                      const next = container.querySelector('.chat-input');
                      if (next) next.focus();
                    },
                  },
                  e,
                ),
              ),
            )
          : h(
              'div',
              { class: 'chat-messages' },
              ...state.messages.map((m) =>
                h(
                  'div',
                  { class: `chat-msg chat-${m.role}${m.error ? ' chat-error' : ''}` },
                  h('div', { class: 'chat-bubble', text: m.content }),
                ),
              ),
            ),
      ),
      h(
        'div',
        { class: 'chat-compose' },
        input,
        h(
          'button',
          { class: 'btn btn-primary', disabled: state.sending, onclick: send },
          state.sending ? '解析中…' : '发送',
        ),
      ),
      h('p', { class: 'muted small chat-tip', text: 'Ctrl/⌘ + Enter 发送。写入日历前一定会先给你确认。' }),
    );
  }

  /* ---------------------------------------------------------- 待确认 */

  function pendingPanel() {
    if (!state.pending) return null;
    const ev = state.pending.event;
    return h(
      'section',
      { class: 'block' },
      h('div', { class: 'block-head' }, h('h3', { text: '待写入的日程' })),
      h(
        'div',
        { class: 'pending-inner' },
        h('p', {}, h('b', { text: ev.summary })),
        h('p', { class: 'muted small' }, ev.allDay ? `${ev.date}（全天）` : `${ev.startLocal} → ${ev.endLocal}（${ev.durationMinutes} 分钟）`),
        ev.location ? h('p', { class: 'muted small', text: `地点：${ev.location}` }) : null,
        ev.attendees?.length ? h('p', { class: 'muted small', text: `参与人：${ev.attendees.join('、')}` }) : null,
        ev.description ? h('p', { class: 'muted small', text: `备注：${ev.description}` }) : null,
        h(
          'div',
          { class: 'editor-actions' },
          h(
            'button',
            {
              class: 'btn btn-primary',
              onclick: async (ev2) => {
                const btn = ev2.currentTarget;
                btn.disabled = true;
                btn.textContent = '写入中…';
                try {
                  const out = await api.calendarCommit({ sessionId: state.sessionId });
                  toast(out.message, 'success');
                  state.pending = null;
                  state.messages.push({ role: 'assistant', content: `✅ ${out.message}`, at: new Date().toISOString() });
                  await refreshInsight();
                } catch (err) {
                  toastError(err);
                  btn.disabled = false;
                  btn.textContent = '确认写入日历';
                }
              },
            },
            '确认写入日历',
          ),
          h(
            'button',
            {
              class: 'btn',
              onclick: async () => {
                try {
                  await api.calendarCancelPending(state.sessionId);
                  state.pending = null;
                  paint();
                  toast('已取消', 'info');
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '取消',
          ),
        ),
      ),
    );
  }

  /* ---------------------------------------------------------- 日程分析 */

  function insightPanel() {
    const insight = state.insight;
    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: `今天 · 明天 · 最近 ${state.days} 天` }),
        h(
          'div',
          { class: 'head-actions' },
          h(
            'select',
            {
              class: 'input select-small',
              onchange: (e) => {
                state.days = Number(e.target.value);
                // 换了窗口就属于「用户主动要看新数据」，直接重新取
                refreshAll();
              },
            },
            ...[7, 3, 14, 30].map((d) => h('option', { value: d, selected: d === state.days }, `最近 ${d} 天`)),
          ),
        ),
      ),
      !insight
        ? h('p', { class: 'muted pad', text: state.loadingInsight ? '正在获取日程…' : '点击右上角「刷新日程」获取。' })
        : h(
            'div',
            { class: 'insight-inner' },
            h(
              'div',
              { class: 'stat-grid stat-grid-tight' },
              stat('今日', insight.stats.today, '条日程'),
              stat('明日', insight.stats.tomorrow, '条日程'),
              stat('有安排', `${insight.stats.busyDays}/${insight.stats.days}`, '天'),
              stat('忙碌时长', insight.stats.busyHours, '小时（去重叠）'),
            ),
            insight.conflicts?.length
              ? h(
                  'div',
                  { class: 'alert alert-warn mb-3' },
                  `检测到 ${insight.conflicts.length} 组时间重叠：${insight.conflicts.map((c) => `「${c.a}」↔「${c.b}」`).join('，')}`,
                )
              : null,
            insight.analysis ? h('div', { class: 'markdown analysis-md', html: renderMarkdown(insight.analysis) }) : null,
            insight.analysisError ? h('p', { class: 'muted small', text: `（分析降级为本地摘要：${insight.analysisError}）` }) : null,
            h('h4', { class: 'form-section' }, '按天明细'),
            h('div', { class: 'day-list' }, ...insight.days.map((d) => dayRow(d))),
          ),
    );
  }

  function dayRow(day) {
    return h(
      'div',
      { class: `day-block ${day.isToday ? 'day-today' : ''}` },
      h(
        'div',
        { class: 'day-head' },
        h('b', { text: day.label }),
        h('span', { class: 'muted small', text: day.count ? `${day.count} 条 · ${day.busyHours} 小时` : '空闲' }),
      ),
      day.events.length
        ? h(
            'ul',
            { class: 'event-list' },
            ...day.events.map((e) =>
              h(
                'li',
                { class: 'event-item' },
                h('span', { class: `event-time ${e.allDay ? 'event-allday' : ''}`, text: e.timeLabel }),
                h(
                  'div',
                  { class: 'event-main' },
                  h('span', { class: 'event-summary', text: e.summary }),
                  e.location ? h('span', { class: 'muted small', text: `　@${e.location}` }) : null,
                  e.attendees?.length ? h('div', { class: 'muted small', text: `参与人：${e.attendees.slice(0, 4).join('、')}` }) : null,
                ),
                e.id
                  ? h(
                      'div',
                      { class: 'event-actions' },
                      h('button', { class: 'link-btn', onclick: () => openEventEditor(e) }, '编辑'),
                      h(
                        'button',
                        {
                          class: 'link-btn danger-link',
                          onclick: async () => {
                            const ok = await confirmDialog({
                              title: '删除这个日程？',
                              message: h('div', {}, h('p', { text: e.summary }), h('p', { class: 'muted small', text: e.allDay ? e.date : `${e.startLocal} → ${e.endLocal}` })),
                              confirmText: '删除',
                              danger: true,
                            });
                            if (!ok) return;
                            try {
                              await api.calendarDeleteEvent(e.id);
                              toast('已删除', 'success');
                              await refreshInsight();
                            } catch (err) {
                              toastError(err);
                            }
                          },
                        },
                        '删除',
                      ),
                    )
                  : null,
              ),
            ),
          )
        : h('p', { class: 'muted small', text: '没有安排' }),
    );
  }

  /* ---------------------------------------------------------- 邮件转日程 */

  /* ------------------------------------------------- 从邮件生成日程：写入前可改 */

  /** `startLocal` 是 "YYYY-MM-DD HH:MM"，`datetime-local` 要 "YYYY-MM-DDTHH:MM"。 */
  function toInputValue(local) {
    const m = String(local || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    return m ? `${m[1]}T${m[2]}` : '';
  }

  function fromInputValue(value) {
    return String(value || '').replace('T', ' ').trim();
  }

  /**
   * 写入前编辑日程。
   *
   * 邮件里抽出来的时间常常"差一点"：会议主题需要改得更清楚、时间要顺延、
   * 地点得补上。所以确认这一步不是走过场，得让人能改。
   * 复用后端已有的 `override` 能力（`acceptEmailSuggestion` 会把 override 合并进草稿再解析），
   * 因此这里只需要一个表单。
   */
  /**
   * 日程表单弹窗（「写入前确认」与「修改已有日程」共用）。
   *
   * 抽出来是为了让两条路径的字段、校验、日期/时间输入格式**完全一致**——
   * 各写一套的话，很快就会出现"这里能填结束时间那里不能"的分叉。
   *
   * @param {object} o { title, subtitle, evidence, initial, submitText, busyText, onSubmit }
   */
  function openEventFormModal({ title, subtitle, evidence, initial = {}, submitText = '保存', busyText = '保存中…', onSubmit }) {
    const st = {
      summary: initial.summary || '',
      allDay: !!initial.allDay,
      start: toInputValue(initial.startLocal),
      end: toInputValue(initial.endLocal),
      date: initial.date || (initial.startLocal ? String(initial.startLocal).slice(0, 10) : ''),
      location: initial.location || '',
      description: initial.description || '',
    };
    let close = () => {};

    const field = (label, input, hint) =>
      h(
        'label',
        { class: 'form-field' },
        h('span', { class: 'form-label', text: label }),
        input,
        hint ? h('span', { class: 'muted small', text: hint }) : null,
      );

    const summaryInput = h('input', {
      class: 'input',
      type: 'text',
      value: st.summary,
      oninput: (e) => (st.summary = e.target.value),
    });
    const locationInput = h('input', {
      class: 'input',
      type: 'text',
      value: st.location,
      placeholder: '可留空',
      oninput: (e) => (st.location = e.target.value),
    });
    const descInput = h('textarea', {
      class: 'input',
      rows: 3,
      placeholder: '可留空',
      oninput: (e) => (st.description = e.target.value),
    });
    descInput.value = st.description;

    const startInput = h('input', {
      class: 'input',
      type: 'datetime-local',
      value: st.start,
      oninput: (e) => (st.start = e.target.value),
    });
    const endInput = h('input', {
      class: 'input',
      type: 'datetime-local',
      value: st.end,
      oninput: (e) => (st.end = e.target.value),
    });
    const dateInput = h('input', {
      class: 'input',
      type: 'date',
      value: st.date,
      oninput: (e) => (st.date = e.target.value),
    });
    const allDayBox = h('input', {
      type: 'checkbox',
      checked: st.allDay,
      onchange: (e) => {
        st.allDay = e.target.checked;
        paint2();
      },
    });

    const timed = h('div', { class: 'form-row' }, field('开始', startInput), field('结束', endInput));
    const allDayRow = h('div', { class: 'form-row' }, field('日期', dateInput, '全天事项只需填日期'));
    const slot = h('div', {}, st.allDay ? allDayRow : timed);
    function paint2() {
      slot.replaceChildren(st.allDay ? allDayRow : timed);
    }

    const saveBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        onclick: async (e) => {
          const btn = e.currentTarget;
          if (!String(st.summary).trim()) return toast('请填写日程主题', 'error');
          const patch = st.allDay
            ? { summary: st.summary.trim(), allDay: true, allDayStart: st.date, location: st.location, description: st.description }
            : {
                summary: st.summary.trim(),
                allDay: false,
                startLocal: fromInputValue(st.start),
                endLocal: fromInputValue(st.end),
                location: st.location,
                description: st.description,
              };
          if (!st.allDay && (!patch.startLocal || !patch.endLocal)) return toast('请填写开始与结束时间', 'error');
          btn.disabled = true;
          btn.textContent = busyText;
          try {
            await onSubmit(patch, { close });
          } catch (err) {
            toastError(err);
          } finally {
            btn.disabled = false;
            btn.textContent = submitText;
          }
        },
      },
      submitText,
    );

    const overlay = h(
      'div',
      { class: 'modal-overlay', onclick: (e) => e.target === overlay && close() },
      h(
        'div',
        { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { class: 'modal-title', text: title }),
        h(
          'div',
          { class: 'modal-body' },
          subtitle ? h('p', { class: 'muted small', text: subtitle }) : null,
          evidence ? h('blockquote', { class: 'quote', text: evidence }) : null,
          field('主题', summaryInput),
          h('label', { class: 'form-check' }, allDayBox, '全天事项'),
          slot,
          field('地点', locationInput),
          field('说明', descInput),
        ),
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => close() }, '取消'),
          saveBtn,
        ),
      ),
    );
    close = openModal(overlay);
    summaryInput.focus?.();
  }

  /** 从邮件建议写入日历：写入前可改。 */
  function openSuggestionEditor(sug) {
    openEventFormModal({
      title: '写入日历前确认',
      subtitle: `来自邮件：${sug.mail?.from?.name || sug.mail?.from?.address || ''}　${sug.mail?.subject || ''}`,
      evidence: sug.evidence,
      initial: sug.event || {},
      submitText: '确认写入',
      busyText: '写入中…',
      onSubmit: async (patch, { close }) => {
        const out = await api.calendarAcceptSuggestion({ suggestion: sug, override: patch });
        toast(out.message, 'success');
        state.suggestions.suggestions = state.suggestions.suggestions.filter((x) => x.id !== sug.id);
        close();
        await refreshInsight();
      },
    });
  }

  /**
   * 修改一条**已有**日程（改的是已经写进 Google 的那条）。
   * 以前只能"删了重建"，这是日历最基本的操作。
   */
  function openEventEditor(ev) {
    openEventFormModal({
      title: '修改日程',
      subtitle: `正在修改日历上的「${ev.summary}」${ev.mailbotRef ? '（由邮件生成）' : ''}`,
      initial: ev,
      submitText: '保存修改',
      busyText: '保存中…',
      onSubmit: async (patch, { close }) => {
        const out = await api.calendarUpdateEvent(ev.id, patch);
        toast(out.message || '已保存修改', 'success');
        close();
        await refreshInsight();
      },
    });
  }

  function suggestionsPanel() {
    const s = state.suggestions;
    const win = s?.window;
    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: '从邮件生成日程' }),
        /*
         * 块头里**只放按钮**。
         *
         * 之前把「窗口：…」这段长文字也塞进 `.head-actions`，而那个容器是 flex-wrap:wrap 的，
         * 于是文字一长就把按钮挤到下一行（用户截图里按钮掉到了标题下面）。
         * 窗口信息改到下面单独一行显示。
         */
        h(
          'div',
          { class: 'head-actions' },
          h(
            'button',
            {
              class: 'btn btn-small nowrap',
              disabled: state.loadingSuggestions,
              onclick: async () => {
                state.loadingSuggestions = true;
                // 窗口内没有可用邮件时后端会自动先补一次邮件分析，所以可能等得久一点——先说清楚
                state.loadingHint = '正在扫描最近 24 小时邮件（必要时会先补一次分析，可能需要十几秒）…';
                paint();
                try {
                  state.suggestions = await api.calendarFromEmails({ windowHours: 24 });
                  state.accepting = {};
                } catch (err) {
                  toastError(err);
                } finally {
                  state.loadingSuggestions = false;
                  state.loadingHint = '';
                  paint();
                }
              },
            },
            state.loadingSuggestions ? '扫描中…' : '扫描最近 24 小时邮件',
          ),
        ),
      ),
      // 扫过一次之后才谈得上"窗口"，所以单独一行显示，不参与块头排版
      win ? h('p', { class: 'muted small block-lead' }, `扫描窗口：${win.label}（${win.sinceLabel} 起）`) : null,
      // 自动补过分析就说明一下，免得用户以为"扫描怎么等这么久"
      s?.autoAnalyzed?.ok && s.autoAnalyzed.analyzed > 0
        ? h(
            'p',
            { class: 'muted small block-lead' },
            `窗口内原本没有已分析的邮件，已自动分析最近 24 小时：拉取 ${s.autoAnalyzed.fetched} 封、新分析 ${s.autoAnalyzed.analyzed} 封。`,
          )
        : null,
      s?.autoAnalyzed && !s.autoAnalyzed.ok
        ? h('p', { class: 'muted small block-lead' }, `自动补分析未成功：${s.autoAnalyzed.error}`)
        : null,
      !s
        ? h('p', { class: 'muted pad', text: state.loadingHint || '从「最近 24 小时」已分析的邮件里找出确定的会议/截止时间，逐条确认后写入日历。' })
        : s.suggestions.length === 0
          ? h('p', { class: 'muted pad', text: s.note || '没有从邮件中找到可用的时间信息。' })
          : h(
              'div',
              { class: 'suggestion-list' },
              ...s.suggestions.map((sug) =>
                h(
                  'div',
                  { class: 'suggestion' },
                  h(
                    'div',
                    { class: 'suggestion-head' },
                    h('span', { class: 'tag tag-need', text: KIND_LABEL[sug.kind] || '日程' }),
                    h('b', { text: sug.event.summary }),
                    sug.confidence != null ? h('span', { class: 'muted small', text: `置信度 ${(sug.confidence * 100).toFixed(0)}%` }) : null,
                  ),
                  h('p', { class: 'muted small' }, sug.event.allDay ? `${sug.event.date}（全天）` : `${sug.event.startLocal} → ${sug.event.endLocal}`),
                  // 时间是程序规整过的就说清楚，免得用户以为模型识别出来的就是整点
                  sug.timeAdjusted
                    ? h('p', { class: 'muted small' }, '时间已规整：开始对齐到整点/半点，时长不足 30 分钟的按 30 分钟（可在写入前修改）')
                    : null,
                  h('p', { class: 'muted small', text: `来自：${sug.mail.from?.name || sug.mail.from?.address || ''}　${sug.mail.subject || ''}` }),
                  sug.evidence ? h('blockquote', { class: 'quote', text: sug.evidence }) : null,
                  h(
                    'div',
                    { class: 'editor-actions' },
                    h(
                      'button',
                      {
                        class: 'btn btn-small btn-primary',
                        onclick: () => openSuggestionEditor(sug),
                      },
                      '编辑后写入',
                    ),
                    h(
                      'button',
                      {
                        class: 'btn btn-small btn-quiet',
                        onclick: async (ev) => {
                          const btn = ev.currentTarget;
                          btn.disabled = true;
                          btn.textContent = '写入中…';
                          try {
                            const out = await api.calendarAcceptSuggestion({ suggestion: sug });
                            toast(out.message, 'success');
                            state.suggestions.suggestions = state.suggestions.suggestions.filter((x) => x.id !== sug.id);
                            await refreshInsight();
                          } catch (err) {
                            toastError(err);
                          } finally {
                            btn.disabled = false;
                            btn.textContent = '直接写入';
                            paint();
                          }
                        },
                      },
                      '直接写入',
                    ),
                  ),
                ),
              ),
            ),
    );
  }

  function stat(label, value, hint) {
    return h(
      'div',
      { class: 'stat-card' },
      h('div', { class: 'stat-label', text: label }),
      h('div', { class: 'stat-value', text: String(value ?? 0) }),
      h('div', { class: 'stat-hint', text: hint }),
    );
  }

  /* ---------------------------------------------------------- 数据 */

  async function refreshInsight() {
    state.loadingInsight = true;
    paint();
    try {
      state.insight = await api.calendarInsight({ days: state.days });
    } catch (err) {
      toastError(err);
    } finally {
      state.loadingInsight = false;
      paint();
    }
  }

  /** 连接状态与配置提示（不触碰对话记录）。 */
  async function loadStatus({ repaint = true } = {}) {
    state.status = await api.calendarStatus();
    state.error = null;
    if (state.status.enabled && !state.status.ready) {
      try {
        state.hint = await api.calendarConfigHint();
      } catch {
        state.hint = null;
      }
    }
  }

  /** 「刷新日历」：状态 + 日程一起重新取；对话记录与待确认日程保持不变。 */
  async function refreshAll() {
    state.loadingInsight = true;
    paint();
    try {
      await loadStatus({ repaint: false });
      if (state.status.ready) {
        state.insight = await api.calendarInsight({ days: state.days });
      }
    } catch (err) {
      toastError(err);
    } finally {
      state.loadingInsight = false;
      paint();
    }
  }

  /**
   * 首次进入才拉取数据；之后切回本页直接复用上次结果，不自动刷新。
   * 用户想更新时点「刷新日历」。
   */
  async function load() {
    if (hydrated && state.fetched) {
      paint();
      return;
    }
    state.loading = true;
    paint();
    try {
      await loadStatus({ repaint: false });
      if (state.status.ready) {
        state.insight = await api.calendarInsight({ days: state.days });
      }
      state.fetched = true;
    } catch (err) {
      state.error = err.message;
      // 记下错误码：授权类错误要给出"重新连接"而不是无意义的"重试"
      state.errorCode = err.code || null;
    } finally {
      state.loading = false;
      paint();
    }
  }

  // OAuth 弹窗完成后自动刷新
  const onMessage = (event) => {
    if (event?.data?.type !== 'mailbot-google-oauth') return;
    if (event.data.ok) {
      toast('Google 日历授权成功', 'success');
      load();
      return;
    }
    // 失败时给完整指引：授权失败几乎总是「测试用户没加」这类配置问题，
    // 一条会被截断的 toast 说不清，所以用弹窗。
    toast('Google 日历授权未完成，请看下方说明', 'error', 6000);
    showAuthHelp();
    load();
  };
  window.addEventListener('message', onMessage);

  function showAuthHelp() {
    let closeModal = () => {};
    const overlay = h(
      'div',
      { class: 'modal-overlay', onclick: (ev) => ev.target === overlay && closeModal() },
      h(
        'div',
        { class: 'modal modal-wide', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { class: 'modal-title', text: '授权被 Google 拒绝时的排查步骤' }),
        h(
          'div',
          { class: 'modal-body' },
          h('p', { text: '最常见的原因是：OAuth 同意屏幕处于「测试」状态，而你登录用的 Google 账号不在「测试用户」名单里。' }),
          h(
            'ol',
            { class: 'setup-steps' },
            h('li', { text: '打开 Google Cloud Console → API 和服务 → OAuth 同意屏幕' }),
            h('li', { text: '在「测试用户」区域点「添加用户」，填入你登录时用的那个 Gmail 地址（一字不差）' }),
            h('li', { text: '保存后等约 1 分钟生效，回到本页重新点「连接 Google 日历」' }),
            h('li', { text: '登录时务必选择你添加过的那个账号，换账号会再次被拒' }),
            h('li', { text: '想长期使用（并解除 7 天令牌限制），可在同一页面点「发布应用」' }),
          ),
          h('p', { class: 'muted small mt-4' }, '如果是 redirect_uri_mismatch 或 invalid_client，则检查设置页的回调地址与客户端凭据是否与 Google Cloud 完全一致。'),
        ),
        h('div', { class: 'modal-actions' }, h('button', { class: 'btn btn-primary', onclick: () => closeModal() }, '知道了')),
      ),
    );
    closeModal = openModal(overlay);
  }

  load();
  return { reload: load };
}
