/**
 * 「开始使用」向导。
 *
 * ## 为什么需要它
 *
 * 交付给别人之后，**最大的流失点不是功能不够，而是第一次打开不知道从哪开始**：
 * 界面是空的、只有几行"尚未配置"的警告，剩下的得去读上千行的运维文档。
 * 这个页面把首次配置压成三步（邮箱 → 大模型 → 日历可选），每步都能"测一下"再往下走。
 *
 * ## 设计取舍
 *
 *   - **只放必需字段**：完整配置项仍在「设置」里，向导刻意不搬全套（字段越多越容易放弃）；
 *   - **每步都能立刻验证**：邮箱走自检（真连一次 IMAP/SMTP）、大模型走一次 ping，
 *     不验证就"下一步"等于把问题推到后面；
 *   - **保存即合并**：只提交本步改动的字段，其余配置原样保留（后端 deepMerge）。
 */

import { api } from '../api.js';
import { h, mount, toast, toastError } from '../dom.js';
import { invalidateAll, markLoaded, renderInto, viewState } from '../view-state.js';

const STEPS = [
  { id: 'mailbox', title: '连接邮箱', hint: '收信与发信都要用。授权码不是网页登录密码。' },
  { id: 'llm', title: '配置大模型', hint: '分析邮件要用它；不想让正文离开本机就选 Ollama。' },
  { id: 'calendar', title: '连接 Google 日历', hint: '可选。不用日历可以跳过。' },
];

export function renderSetup(root, app) {
  const { state } = viewState(app, 'setup', () => ({
    loading: true,
    health: null,
    config: null,
    presets: [],
    step: null,
    busy: false,
    message: null,
  }));

  const container = h('div', { class: 'view view-setup' });
  mount(root, container);
  const paint = () => renderInto(container, app, 'setup', paintInner, () => renderSetup(root, app));

  function paintInner() {
    mount(container, view());
  }

  /* ------------------------------------------------------------ 视图 */

  function view() {
    if (state.loading) return h('p', { class: 'muted pad', text: '加载中…' });
    const health = state.health;
    const current = state.step || health?.nextStepId || (health?.ready ? 'done' : 'mailbox');

    return h(
      'div',
      {},
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { class: 'page-title', text: '开始使用' }),
          h('p', { class: 'muted', text: '三步就能用起来。随时可以回「设置」里细调。' }),
        ),
        /*
         * 「从哪来回哪去」：这个向导是从**设置 → 外观**里点开的，
         * 返回时带上锚点，直接落回那张卡片（否则用户回到设置页顶部还得自己找）。
         */
        h(
          'div',
          { class: 'head-actions' },
          h(
            'button',
            {
              class: 'btn',
              onclick: () => app.navigate('settings', { anchor: '外观' }),
            },
            '返回设置',
          ),
        ),
      ),
      stepIndicator(health, current),
      state.message ? h('div', { class: 'alert alert-info block-lead' }, state.message) : null,
      current === 'done' ? donePanel() : stepPanel(current),
    );
  }

  /** 顶部三步进度：完成打勾、当前高亮、可选步骤标注"可跳过" */
  function stepIndicator(health, current) {
    return h(
      'div',
      { class: 'setup-steps-row' },
      ...STEPS.map((s, i) => {
        const st = (health?.steps || []).find((x) => x.id === s.id);
        const done = !!st?.done;
        const active = current === s.id;
        return h(
          'button',
          {
            class: `setup-chip ${done ? 'setup-chip-done' : ''} ${active ? 'setup-chip-active' : ''}`,
            onclick: () => {
              state.step = s.id;
              state.message = null;
              paint();
            },
          },
          h('span', { class: 'setup-chip-index', text: done ? '✓' : String(i + 1) }),
          h('span', {}, s.title, s.id === 'calendar' ? h('span', { class: 'muted small', text: '（可跳过）' }) : null),
        );
      }),
      /*
       * 第四枚「可以用了」。
       *
       * 它**只在配好之后**才渲染（health.ready 为真），所以它的索引永远是该打勾的：
       * 早先这里写死了一个 →，结果本机（已配置完成）也显示箭头，看起来像"还没到"。
       * 前三枚是"完成打勾 / 未完成显示序号"，这一枚没有"未完成"形态，
       * 因此没有箭头分支——→ 只在真的表示"下一步去哪"时才用。
       */
      health?.ready
        ? h(
            'button',
            {
              class: `setup-chip setup-chip-done ${current === 'done' ? 'setup-chip-active' : ''}`,
              onclick: () => {
                state.step = 'done';
                paint();
              },
            },
            h('span', { class: 'setup-chip-index', text: '✓' }),
            h('span', { text: '可以用了' }),
          )
        : null,
    );
  }

  /* ------------------------------------------------------------ 各步 */

  function stepPanel(id) {
    const cfg = state.config || {};
    const inst = (cfg.instances || []).find((i) => i.id === cfg.defaultInstanceId) || (cfg.instances || [])[0] || {};
    const meta = STEPS.find((s) => s.id === id) || STEPS[0];

    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: meta.title }),
        h('span', { class: 'muted small', text: meta.hint }),
      ),
      h(
        'div',
        { class: 'pad' },
        id === 'mailbox' ? mailboxFields(inst) : null,
        id === 'llm' ? llmFields(cfg) : null,
        id === 'calendar' ? calendarFields(cfg) : null,
        h(
          'div',
          { class: 'row-actions mt-3' },
          h(
            'button',
            {
              class: 'btn btn-primary',
              disabled: state.busy,
              onclick: (ev) => saveAndTest(ev.currentTarget, id),
            },
            state.busy ? '处理中…' : id === 'calendar' ? '保存' : '保存并测试',
          ),
          id === 'calendar'
            ? h('button', { class: 'btn', disabled: state.busy, onclick: () => connectGoogle() }, '连接 Google 日历')
            : null,
          id === 'calendar'
            ? h(
                'button',
                {
                  class: 'btn',
                  onclick: () => {
                    state.step = state.health?.ready ? 'done' : 'mailbox';
                    paint();
                  },
                },
                '跳过这步',
              )
            : null,
          h(
            'button',
            {
              class: 'btn',
              onclick: () => {
                state.step = null;
                state.message = null;
                load();
              },
            },
            '刷新状态',
          ),
        ),
      ),
    );
  }

  function mailboxFields(inst) {
    const imap = inst.imap || {};
    const smtp = inst.smtp || {};
    const id = inst.identity || {};
    return h(
      'div',
      {},
      h('h4', { class: 'form-section', text: '收信（IMAP）' }),
      row(
        field('服务器', text(imap.host, (v) => (imap.host = v.trim()), 'imap.example.com')),
        field('端口', number(imap.port ?? 993, (v) => (imap.port = v), 1, 65535)),
      ),
      h(
        'label',
        { class: 'form-check' },
        h('input', { type: 'checkbox', checked: imap.secure !== false, onchange: (e) => (imap.secure = e.target.checked) }),
        '使用 SSL/TLS（993 通常是）',
      ),
      h('h4', { class: 'form-section', text: '发信（SMTP）' }),
      row(
        field('服务器', text(smtp.host, (v) => (smtp.host = v.trim()), 'smtp.example.com')),
        field('端口', number(smtp.port ?? 465, (v) => (smtp.port = v), 1, 65535)),
      ),
      h(
        'label',
        { class: 'form-check' },
        h('input', { type: 'checkbox', checked: smtp.secure !== false, onchange: (e) => (smtp.secure = e.target.checked) }),
        '使用 SSL/TLS（465 通常是）',
      ),
      h('h4', { class: 'form-section', text: '账号与身份' }),
      row(
        field('账号', text(imap.authUser, (v) => {
          imap.authUser = v.trim();
          smtp.authUser = v.trim();
        }, 'you@example.com')),
        field('授权码', password(imap.authPass, (v) => {
          imap.authPass = v;
          smtp.authPass = v;
        }), '邮箱设置里开启 IMAP/SMTP 后拿到的专用密码'),
      ),
      row(
        field('发件人邮箱', text(id.email, (v) => (id.email = v.trim()), '会出现在你发出的邮件里')),
        field('发件人姓名', text(id.name, (v) => (id.name = v))),
      ),
      h('p', { class: 'muted small' }, 'IMAP 与 SMTP 的服务器地址**常常不同**，请照邮箱帮助页分别填写。'),
    );
  }

  function llmFields(cfg) {
    const llm = cfg.llm || (cfg.llm = {});
    const presets = state.presets || [];
    const select = h(
      'select',
      {
        class: 'input',
        onchange: (e) => {
          const p = presets.find((x) => x.id === e.target.value);
          if (!p) return;
          llm.baseUrl = p.baseUrl;
          if (p.model) llm.model = p.model;
          state.message = `已套用「${p.label}」的地址与默认模型，接着填 API Key 即可。`;
          paint();
        },
      },
      h('option', { value: '', selected: !presets.some((p) => p.baseUrl === llm.baseUrl) }, '自定义 / 保持不变'),
      ...presets.map((p) => h('option', { value: p.id, selected: p.baseUrl === llm.baseUrl }, p.label)),
    );
    return h(
      'div',
      {},
      field('服务商', select, '不想让邮件正文离开本机 → 选 Ollama（本地模型）'),
      field('接口地址', text(llm.baseUrl, (v) => (llm.baseUrl = v.trim()), '带 /v1 的 OpenAI 兼容地址')),
      field('模型名', text(llm.model, (v) => (llm.model = v.trim()), '例如 deepseek-chat')),
      field('API Key', password(llm.apiKey, (v) => (llm.apiKey = v)), '保存在本机；也可以改放到 .env 的 DEEPSEEK_API_KEY'),
    );
  }

  function calendarFields(cfg) {
    const cal = cfg.calendar || (cfg.calendar = {});
    const g = cal.google || (cal.google = {});
    const st = (state.health?.steps || []).find((x) => x.id === 'calendar');
    return h(
      'div',
      {},
      h(
        'label',
        { class: 'form-check' },
        h('input', { type: 'checkbox', checked: cal.enabled === true, onchange: (e) => (cal.enabled = e.target.checked) }),
        '启用日历数字人',
      ),
      st && !st.done ? h('p', { class: 'muted small' }, `当前状态：${st.detail}`) : null,
      field('Client ID', text(g.clientId, (v) => (g.clientId = v.trim()))),
      field('Client Secret', password(g.clientSecret, (v) => (g.clientSecret = v))),
      field('回调地址', text(g.redirectUri, (v) => (g.redirectUri = v.trim())), '必须与 Google Cloud 里登记的完全一致'),
      h(
        'p',
        { class: 'muted small' },
        '不知道怎么建凭据？见 ',
        h('a', { href: 'https://github.com/Alexwuwei2022/mailbot/blob/main/docs/运行与配置文档.md', target: '_blank', rel: 'noreferrer' }, '运行与配置文档 §10'),
        '。授权时若 Google 提示"未验证应用"，点「继续」即可。',
      ),
    );
  }

  /* ------------------------------------------------------------ 完成 */

  function donePanel() {
    const health = state.health || {};
    return h(
      'section',
      { class: 'block' },
      h('div', { class: 'block-head' }, h('h3', { text: '可以开始用了' })),
      h(
        'div',
        { class: 'pad' },
        h('p', { class: 'muted' }, '下一步：到「邮件总览」点一次分析，看看它怎么读你的收件箱。'),
        h(
          'div',
          { class: 'stat-grid stat-grid-tight mt-2' },
          stat('版本', health.version || '—', `Node ${health.node || ''}`),
          stat('时区', health.timeZone || '—', '所有时间按它渲染'),
          stat('数据目录', health.dataDir || '—', '只在本机；记得偶尔导出备份'),
        ),
        h(
          'div',
          { class: 'row-actions mt-3' },
          h('button', { class: 'btn btn-primary', onclick: () => app.navigate('overview') }, '去邮件总览'),
          h('button', { class: 'btn', onclick: () => app.navigate('settings') }, '打开设置'),
        ),
      ),
    );
  }

  function stat(label, value, hint) {
    return h(
      'div',
      { class: 'stat-card' },
      h('div', { class: 'stat-label', text: label }),
      h('div', { class: 'stat-value', text: String(value) }),
      h('div', { class: 'stat-hint', text: hint }),
    );
  }

  /* ------------------------------------------------------------ 表单小工具 */

  function field(label, control, hint) {
    return h(
      'label',
      { class: 'form-field' },
      h('span', { class: 'form-label', text: label }),
      control,
      hint ? h('span', { class: 'muted small', text: hint }) : null,
    );
  }

  function row(...cells) {
    return h('div', { class: 'form-row' }, ...cells);
  }

  function text(value, oninput, placeholder) {
    return h('input', { class: 'input', type: 'text', value: value ?? '', placeholder: placeholder || '', oninput: (e) => oninput(e.target.value) });
  }

  function password(value, oninput) {
    return h('input', { class: 'input', type: 'password', value: value ?? '', oninput: (e) => oninput(e.target.value) });
  }

  function number(value, oninput, min, max) {
    return h('input', {
      class: 'input',
      type: 'number',
      value: value ?? '',
      min,
      max,
      oninput: (e) => oninput(Number(e.target.value)),
    });
  }

  /* ------------------------------------------------------------ 数据与动作 */

  async function load() {
    state.loading = !state.config;
    paint();
    try {
      const [health, cfgRes, meta] = await Promise.all([api.health(), api.getConfig(), api.meta()]);
      state.health = health;
      state.config = cfgRes.config;
      state.presets = meta?.llmPresets || cfgRes.llmPresets || [];
      state.step = state.step || health.nextStepId || (health.ready ? 'done' : 'mailbox');
      markLoaded(app, 'setup');
    } catch (err) {
      toastError(err);
    } finally {
      state.loading = false;
      paint();
    }
  }

  /** 保存本步改动；非日历步骤紧接着验证一次，不把问题推到后面。 */
  async function saveAndTest(btn, id) {
    const cfg = state.config;
    state.busy = true;
    paint();
    try {
      const patch = { instances: cfg.instances, llm: cfg.llm, calendar: cfg.calendar, defaultInstanceId: cfg.defaultInstanceId };
      await api.saveConfig(patch);
      state.message = '已保存。';
      if (id === 'calendar') {
        toast('已保存日历配置', 'success');
      } else {
        const result = await api.diagnostics(cfg.defaultInstanceId, true);
        const checks = (result.checks || []).filter((c) => (id === 'mailbox' ? c.id.startsWith('imap') || c.id.startsWith('smtp') : c.id.startsWith('llm')));
        const bad = checks.filter((c) => c.status === 'error' || c.status === 'warn');
        if (bad.length) {
          state.message = `保存成功，但验证有问题：${bad.map((c) => `${c.label} — ${c.message}`).join('；')}`;
          toast('配置已保存，但有项目未通过验证', 'error', 10_000);
        } else {
          state.message = `保存并验证通过：${checks.map((c) => `${c.label} ${c.message}`).join('；') || '已保存'}`;
          toast('验证通过', 'success');
        }
      }
      invalidateAll(app);
      await load();
      // 通过后自动进入下一步，减少点击
      if (!(state.message || '').includes('问题')) state.step = null;
    } catch (err) {
      toastError(err);
    } finally {
      state.busy = false;
      paint();
    }
  }

  async function connectGoogle() {
    try {
      const out = await api.calendarAuthUrl(state.config?.calendar?.google?.redirectUri);
      const win = window.open(out.url, 'mailbot-google-oauth', 'width=520,height=680');
      if (!win) {
        toast('浏览器拦截了弹窗，请允许弹窗后重试', 'error');
        return;
      }
      toast('已打开 Google 授权页，完成后回来点「刷新状态」', 'info', 8000);
    } catch (err) {
      toastError(err);
    }
  }

  paint();
  load();
}
