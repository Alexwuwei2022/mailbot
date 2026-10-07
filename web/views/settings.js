/** 设置页：邮箱实例（服务器/端口/账号/授权码独立配置）、行为策略、大模型、自检。 */

import { api, getToken, setToken } from '../api.js';
/*
 * 主题切换从顶栏挪到了这里。
 * 与 app.js 存在循环依赖，但 themeSwitcher 是**函数声明**（会被提升），
 * 且只在渲染时调用，所以不会踩到 TDZ。
 */
import { themeSwitcher } from '../app.js';
import { confirmDialog, fmtBytes, fmtFull, h, mount, scrollToEl, toast, toastError } from '../dom.js';
import { renderInto, viewState } from '../view-state.js';

const STATUS_ICON = { ok: '✅', warn: '⚠️', error: '❌', skipped: '➖', running: '⏳' };

/**
 * @param {HTMLElement} root
 * @param {object} app
 * @param {{anchor?: string}} [options] 渲染后要定位到的区块标题（或其前缀）。
 *   跨视图回来的情况（「开始使用」/「运行与记录」点「返回设置」）走
 *   `app.navigate('settings', { anchor })` → `app.takeNavParams('settings')`，两条路等价。
 */
export function renderSettings(root, app, options = {}) {
  /*
   * 具名区块锚点。
   *
   * 为什么要锚点：从「开始使用」向导或「运行与记录」返回时，用户要落回**它对应的那张卡片**
   * （「外观」在设置页倒数第二块、「运行与记录」在末尾），否则得自己在十几块里找。
   * 用**标题**当锚点而不是序号：区块顺序由 SETTINGS_ORDER 决定，随时会调，
   * 序号一旦错位就会静默滚到别的卡片上（那比不滚更糟）。
   *
   * 注意首帧还在「加载配置中…」，那时没有任何 section.block，找不到就留给下一次 paint。
   */
  let pendingAnchor = typeof options?.anchor === 'string' ? options.anchor : (app?.takeNavParams?.('settings')?.anchor || null);

  // 状态托管给 app：切走再切回保留未保存的编辑与自检结果
  const { state } = viewState(app, 'settings', () => ({
    loading: true,
    error: null,
    config: null,
    presets: [],
    /** 大模型服务商预设（含常用模型名与申请 Key 的链接） */
    llmPresets: [],
    secretSources: null,
    calendarStatus: null,
    /** /api/meta：版本、数据目录、Node 版本（「关于」区块用） */
    meta: null,
    /** 定时任务状态（定时器在不在跑、上次结果） */
    schedule: null,
    runningSchedule: false,
    /** 存储占用（原文/孤儿/可回收/简报/台账/状态） */
    storage: null,
    cleaning: false,
    /** 最近一次清理的**如实结果**（删了几个、释放多少字节、失败几个） */
    lastCleanup: null,
    /** 备份导出选项与状态 */
    exportSecrets: false,
    exportRaw: false,
    exporting: false,
    /** 导入前的自动备份列表（可回滚） */
    safetyBackups: [],
    /** 密钥存储现状（/api/secrets） */
    secrets: null,
    secretsBusy: false,
    secretsPick: null,
    /** 访问与安全现状（/api/security） */
    security: null,
    securityBusy: false,
    /** 数据去向（/api/egress） */
    egress: null,
    /** 上次保存后的配置快照，用于判断是否有未保存改动 */
    savedSnapshot: null,
    activeInstance: null,
    diagnostics: null,
    diagnosing: false,
    saving: false,
    token: getToken(),
    fetched: false,
  }));

  const container = h('div', { class: 'view view-settings' });
  mount(root, container);

  const paint = () => {
    renderInto(container, app, 'settings', paintInner, () => renderSettings(root, app));
    organizeSettings(container);
    // 区块刚渲染出来才找得到锚点；找到后 pendingAnchor 归零，不再重复滚动
    pendingAnchor = revealSection(container, pendingAnchor);
  };

  /**
   * 「关于」里的快捷跳转（备份与恢复）：与跨视图锚点共用同一套具名区块定位。
   * 找不到就明说，而不是点了没反应。
   */
  const jumpToSection = (anchor) => {
    if (revealSection(container, anchor)) toast(`没有找到「${anchor}」区块`, 'info');
  };

  const paintInner = () => {
    if (state.loading) {
      mount(container, h('p', { class: 'muted pad', text: '加载配置中…' }));
      return;
    }
    if (state.error) {
      mount(container, h('p', { class: 'error pad', text: state.error }), h('button', { class: 'btn', onclick: load }, '重试'));
      return;
    }

    const cfg = state.config;
    const inst = cfg.instances.find((i) => i.id === state.activeInstance) || cfg.instances[0];

    mount(
      container,
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { text: '设置' }),
          h('p', { class: 'muted', text: '所有配置都保存在本机 data/config.json；授权码也可以放在 .env 里（更安全）。' }),
        ),
        h(
          'div',
          { class: 'head-actions' },
          h('button', { class: 'btn', onclick: () => runDiagnostics(true) }, state.diagnosing ? '自检中…' : '运行自检'),
          h('button', { class: 'btn btn-primary', onclick: save }, state.saving ? '保存中…' : '保存配置'),
        ),
      ),

      /* ---------------- 邮箱实例 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '邮箱账户' }),
          h(
            'div',
            { class: 'head-actions' },
            h(
              'select',
              {
                class: 'input select-small',
                onchange: (ev) => {
                  state.activeInstance = ev.target.value;
                  paint();
                },
              },
              ...cfg.instances.map((i) =>
                h('option', { value: i.id, selected: i.id === inst.id }, `${i.label}（${i.imap.authUser || '未配置'}）${i.id === cfg.defaultInstanceId ? ' · 默认' : ''}`),
              ),
            ),
            h(
              'button',
              {
                class: 'btn btn-small',
                onclick: () => {
                  const same = cfg.instances.find((i) => i.id === 'default' && !i.imap.authPass);
                  let id = 'instance';
                  let n = 2;
                  while (cfg.instances.some((i) => i.id === id)) id = `instance${n++}`;
                  void same;
                  cfg.instances.push({
                    id,
                    label: `邮箱 ${cfg.instances.length + 1}`,
                    enabled: true,
                    imap: { host: '', port: 993, secure: true, authUser: '', authPass: '' },
                    smtp: { host: '', port: 465, secure: true, authUser: '', authPass: '' },
                    identity: { name: '', email: '', replyTo: '' },
                  });
                  state.activeInstance = id;
                  paint();
                },
              },
              '新增邮箱',
            ),
          ),
        ),

        inst ? instanceForm(inst, cfg) : h('p', { class: 'muted pad', text: '暂无实例' }),
      ),

      /* ---------------- 行为策略 ---------------- */
      h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '分析与起草策略' })),
        h(
          'div',
          { class: 'form-grid' },
          field('回看窗口（小时）', numberInput(cfg.scan.windowHours, (v) => (cfg.scan.windowHours = v), { min: 1, max: 720 })),
          field(
            '检索按需回补上限',
            numberInput(cfg.search?.backfillMax ?? 40, (v) => {
              cfg.search = { ...(cfg.search || {}), backfillMax: v };
            }, { min: 0, max: 300 }),
            '对话查邮件时若本地未覆盖该时间段，最多按需拉取并分析多少封；0 = 关闭',
          ),
          field(
            '检索信封扫描上限',
            numberInput(cfg.search?.envelopeScanMax ?? 3000, (v) => {
              cfg.search = { ...(cfg.search || {}), envelopeScanMax: v };
            }, { min: 50, max: 3000 }),
            '只读信头（不花模型额度）的扫描上限；生效预算 = min(本值, max(回补上限 × 8, 600))——默认 600 封。' +
              '命中列表靠它保证完整，达到上限会明确提示「还有邮件未检查到」，并给出「已扫描 / 未检查 / 取到的 UID 总数」三个数',
          ),
          field('单次最大处理邮件数', numberInput(cfg.scan.maxMessages, (v) => (cfg.scan.maxMessages = v), { min: 1, max: 2000 })),
          field('扫描文件夹（逗号分隔）', textInput((cfg.scan.folders || []).join(','), (v) => (cfg.scan.folders = v.split(',').map((s) => s.trim()).filter(Boolean)))),
          field('会话上下文条数', numberInput(cfg.scan.threadContextCount, (v) => (cfg.scan.threadContextCount = v), { min: 0, max: 10 })),
          field('单封正文送模型上限（字符）', numberInput(cfg.scan.bodyCharsForLlm, (v) => (cfg.scan.bodyCharsForLlm = v), { min: 500, max: 60000 })),
          field(
            '回复语气',
            selectInput(cfg.draft.tone, (v) => (cfg.draft.tone = v), [
              ['formal', '正式商务'],
              ['concise', '简洁直接'],
              ['warm', '亲和友好'],
            ]),
          ),
          field(
            '回复语言',
            selectInput(cfg.draft.language, (v) => (cfg.draft.language = v), [
              ['auto', '跟随来信语言'],
              ['zh', '始终中文'],
              ['en', '始终英文'],
            ]),
          ),
          field('最多起草封数', numberInput(cfg.draft.maxDrafts, (v) => (cfg.draft.maxDrafts = v), { min: 1, max: 200 })),
          field('起草并发数', numberInput(cfg.draft.concurrency, (v) => (cfg.draft.concurrency = v), { min: 1, max: 8 })),
        ),
        h(
          'label',
          { class: 'field' },
          h(
            'span',
            {},
            '签名（追加在每封回复正文末尾）',
            h('span', { class: 'muted small', text: '　由程序逐字追加，模型不会改写它' }),
          ),
          h('textarea', {
            class: 'textarea textarea-signature',
            rows: 8,
            placeholder: '张三 | 示例事业部\n移动电话：138xxxx\n公司地址：…\n安全提示：\n1) …',
            value: cfg.draft.signature || '',
            oninput: (ev) => (cfg.draft.signature = ev.target.value),
          }),
        ),
        h(
          'div',
          { class: 'form-grid' },
          field(
            '原始邮件引文',
            selectInput(cfg.draft.quoteOriginal === false ? 'off' : cfg.draft.quoteStyle || 'zh-client', (v) => {
              cfg.draft.quoteOriginal = v !== 'off';
              if (v !== 'off') cfg.draft.quoteStyle = v;
            }, [
              ['zh-client', '附上原文（中文客户端风格）'],
              ['prefix', '附上原文（> 前缀风格）'],
              ['off', '不附原文'],
            ]),
            '收件人看到没有原文的回复会不知道你在回哪一句；引文固定加在**签名之下**（顺序：新正文 → 签名 → 引文）',
          ),
          field(
            '引文字符上限',
            numberInput(cfg.draft.quoteMaxChars ?? 2000, (v) => (cfg.draft.quoteMaxChars = v), { min: 200, max: 20000 }),
            '超长从尾部截断并标注，避免回复被历史堆满',
          ),
        ),
        h(
          'div',
          { class: 'switch-row' },
          switchInput('生成的草稿自动写入邮箱草稿箱', cfg.draft.saveToMailbox, (v) => (cfg.draft.saveToMailbox = v)),
          switchInput('发送后归档到「已发送」文件夹', !!cfg.draft.appendToSent, (v) => (cfg.draft.appendToSent = v)),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { text: '发送策略' }),
          selectInput(cfg.draft.sendPolicy, (v) => (cfg.draft.sendPolicy = v), [
            ['confirm', '逐封人工确认后发送（推荐）'],
            ['draft_only', '只生成草稿，永不发送'],
            ['auto', '允许批量自动发送'],
          ]),
          h('span', { class: 'muted small', text: '即使选择「允许批量自动发送」，界面仍会要求你二次确认。' }),
        ),
      ),

      /* ---------------- 大模型 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '大模型（OpenAI 兼容协议）' }),
          h(
            'button',
            {
              /* 与其它区块内动作（运行自检 / 刷新状态）用同一种按钮样式：
                 "绿字链接"混在按钮中间会让设置页看起来有三套视觉语言 */
              class: 'btn btn-small',
              onclick: async () => {
                try {
                  const r = await api.testLlm();
                  toast(`模型可用：${r.result.model}（${r.result.latencyMs}ms）`, 'success');
                } catch (err) {
                  toastError(err);
                }
              },
            },
            '测试连接',
          ),
        ),
        state.secretSources?.llmKeyFromEnv
          ? h('div', { class: 'alert alert-info', text: '检测到 .env 中的 DEEPSEEK_API_KEY，环境变量优先级高于此处填写的内容。' })
          : null,
        llmProviderPicker(cfg),
        h(
          'div',
          { class: 'form-grid' },
          field('Base URL', textInput(cfg.llm.baseUrl, (v) => (cfg.llm.baseUrl = v), { placeholder: 'https://api.deepseek.com' }), '兼容 OpenAI 协议的服务地址'),
          field('模型名', modelInput(cfg), '可直接输入，或从上方服务商的常用模型里选'),
          field(
            'API Key',
            passwordInput(cfg.llm.apiKey, (v) => (cfg.llm.apiKey = v), { placeholder: 'sk-…' }),
            '留空则沿用 .env 中的值；本机部署（Ollama 等）可以留空',
          ),
          field('Temperature', numberInput(cfg.llm.temperature, (v) => (cfg.llm.temperature = v), { min: 0, max: 2, step: 0.1 })),
          field('单批邮件数', numberInput(cfg.llm.classifyBatchSize, (v) => (cfg.llm.classifyBatchSize = v), { min: 1, max: 50 }), '越小越稳，越大越省调用次数'),
          field('失败重试次数', numberInput(cfg.llm.maxRetries, (v) => (cfg.llm.maxRetries = v), { min: 0, max: 8 })),
        ),
      ),

      /* ---------------- 定时与通知（主动性） ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '定时分析与通知' }),
          h('span', { class: 'muted small', text: '让它自己动起来，而不是等你点' }),
        ),
        h(
          'div',
          { class: 'pad' },
          h(
            'p',
            { class: 'muted small block-lead' },
            '定时分析会在设定时刻自动连邮箱、拉取并分析邮件（**会消耗大模型额度**），所以默认关闭。',
          ),
          field('启用定时分析', switchInput('', cfg.schedule?.enabled === true, (v) => {
            cfg.schedule = { ...(cfg.schedule || {}), enabled: v };
          }), '默认关闭：打开后会在你不知情时访问邮箱并调用大模型'),
          field(
            '每天几点跑（逗号分隔，24 小时制）',
            textInput((cfg.schedule?.times || []).join(','), (v) => {
              cfg.schedule = { ...(cfg.schedule || {}), times: v.split(',').map((s) => s.trim()).filter((s) => /^\d{1,2}:\d{2}$/.test(s)) };
            }),
            `按「设置 → 日历时区」的时刻计算（当前 ${state.config.calendar?.timeZone || 'Asia/Shanghai'}）；同一分钟只会跑一次`,
          ),
          field(
            '星期几（0=周日 … 6=周六，逗号分隔）',
            textInput((cfg.schedule?.days || []).join(','), (v) => {
              cfg.schedule = { ...(cfg.schedule || {}), days: v.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6) };
            }),
            '默认 1,2,3,4,5（工作日）',
          ),
          field('每次回看窗口（小时）', numberInput(cfg.schedule?.windowHours ?? 24, (v) => {
            cfg.schedule = { ...(cfg.schedule || {}), windowHours: v };
          }, { min: 1, max: 720 })),
          h('hr', { class: 'sep' }),
          field('页内提示', switchInput('', cfg.notify?.inApp !== false, (v) => {
            cfg.notify = { ...(cfg.notify || {}), inApp: v };
          }), '跑完在页面右下角弹一条'),
          field('浏览器桌面通知', switchInput('', cfg.notify?.browser === true, async (v) => {
            cfg.notify = { ...(cfg.notify || {}), browser: v };
            if (!v) {
              app.notifyBrowser = false;
              return;
            }
            // 打开就要立刻要权限：等跑完再要，用户根本不知道为什么突然弹窗
            if (typeof Notification === 'undefined') {
              toast('当前浏览器不支持桌面通知', 'error');
              cfg.notify.browser = false;
              return;
            }
            const perm = await Notification.requestPermission();
            if (perm === 'granted') {
              app.notifyBrowser = true;
              toast('已开启桌面通知', 'success');
            } else {
              cfg.notify.browser = false;
              toast('浏览器拒绝了通知权限，可在地址栏左侧的站点设置里改回来', 'error', 9000);
            }
          }), '需要页面开着（可以切到后台标签页），并且授权'),
          field('把简报寄给自己', switchInput('', cfg.notify?.email === true, (v) => {
            cfg.notify = { ...(cfg.notify || {}), email: v };
          }), '唯一在你没打开页面时也能收到的方式；只有确实有待办或新草稿时才寄，不会天天打扰'),
          field(
            '简报收件人',
            textInput(cfg.notify?.emailTo || '', (v) => {
              cfg.notify = { ...(cfg.notify || {}), emailTo: v.trim() };
            }),
            '留空则发给你自己的发件身份',
          ),
          scheduleStatusLine(),
        ),
      ),

      /* ---------------- 外观 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '外观' }),
          h('span', { class: 'muted small', text: '浅色 / 深色 / 绿色' }),
        ),
        h(
          'div',
          { class: 'pad' },
          h('div', { class: 'row-actions' }, themeSwitcher()),
          h('p', { class: 'muted small mt-2' }, '点击即生效并记住；没选过时跟随系统设置。'),
          h(
            'p',
            { class: 'muted small' },
            '想重看首次配置？',
            h(
              'button',
              { class: 'btn btn-small', onclick: () => app.navigate('setup') },
              '打开「开始使用」向导',
            ),
          ),
        ),
      ),

      /* ---------------- 运行与记录（入口） ---------------- */
      /*
       * 它以前是顶层导航的一项，现在收进设置：这是一页**查阅过去**的东西
       * （审计台账 / 运行历史），不是每天要点的功能，占顶层位置不划算。
       */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '运行与记录' }),
          h('span', { class: 'muted small', text: '操作台账（审计）与分析运行历史' }),
        ),
        h(
          'div',
          { class: 'pad' },
          h(
            'p',
            { class: 'muted small block-lead' },
            '它回答"之前到底发生了什么"：**操作台账**记录每一次改动外部系统的动作' +
              '（发邮件、同步草稿、建/删/改日程、清理数据、导入备份），含具体标题与主题，' +
              '追加在 data/audit.jsonl、永久保留、可筛选、可下载；**运行历史**是每次分析' +
              '拉取了多少、分析多少、起草多少、成功还是失败。',
          ),
          h(
            'div',
            { class: 'row-actions mt-2' },
            h('button', { class: 'btn btn-primary', onclick: () => app.navigate('records') }, '打开「运行与记录」'),
          ),
        ),
      ),
      /* ---------------- 数据去向（隐私） ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '数据去向' }),
          h('span', { class: 'muted small', text: '哪些内容会离开这台电脑' }),
        ),
        h('div', { class: 'pad' }, state.egress ? egressPanel() : h('p', { class: 'muted small', text: '加载中…' })),
      ),

      /* ---------------- 访问与安全 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '访问与安全' }),
          h('span', { class: 'muted small', text: '谁能连上、要不要登录、有没有加密' }),
        ),
        h('div', { class: 'pad' }, state.security ? securityPanel() : h('p', { class: 'muted small', text: '加载中…' })),
      ),

      /* ---------------- 密钥存储 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '密钥存储' }),
          h('span', { class: 'muted small', text: '授权码 / API Key / 令牌放在哪' }),
        ),
        h(
          'div',
          { class: 'pad' },
          state.secrets
            ? secretsPanel()
            : h('p', { class: 'muted small', text: '加载中…' }),
        ),
      ),

      /* ---------------- 备份与恢复 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '备份与恢复' }),
          h('span', { class: 'muted small', text: '换电脑 / 重装 / 以防万一' }),
        ),
        h(
          'div',
          { class: 'pad' },
          h(
            'p',
            { class: 'muted small block-lead' },
            '`data/` 里是**不可再生**的东西：几百封邮件的分析结论、草稿、简报、操作台账。' +
              '导出的压缩包**默认不含密钥**（授权码 / API Key / Google 令牌 / .env），可以放心放到网盘。',
          ),
          h(
            'div',
            { class: 'row-actions' },
            h(
              'button',
              {
                class: 'btn btn-primary',
                disabled: state.exporting,
                onclick: (ev) => exportBackup(ev.currentTarget),
              },
              state.exporting ? '导出中…' : '导出备份',
            ),
            h(
              'label',
              { class: 'form-check' },
              h('input', {
                type: 'checkbox',
                checked: state.exportSecrets === true,
                onchange: (e) => {
                  state.exportSecrets = e.target.checked;
                  paint();
                },
              }),
              '包含密钥',
            ),
            h(
              'label',
              { class: 'form-check' },
              h('input', {
                type: 'checkbox',
                checked: state.exportRaw === true,
                onchange: (e) => {
                  state.exportRaw = e.target.checked;
                  paint();
                },
              }),
              '包含邮件原文（体积大）',
            ),
          ),
          state.exportSecrets
            ? h(
                'p',
                { class: 'error small mt-2' },
                '⚠️ 勾选「包含密钥」后：压缩包里会有你的邮箱授权码、API Key 与 Google 令牌（明文）。' +
                  '**请勿通过聊天工具或邮件发出去**，用完请及时删除。',
              )
            : null,
          state.exportRaw
            ? h('p', { class: 'muted small mt-2' }, '包含原文会让压缩包大很多（几百 MB 也可能），导出会慢一些。')
            : null,

          h('hr', { class: 'sep' }),

          h('p', { class: 'muted small' }, '**恢复**：选择之前导出的 zip。程序会先显示里面有什么、缺什么，确认后才覆盖；覆盖前还会自动把当前数据再存一份。'),
          h(
            'div',
            { class: 'row-actions' },
            h('input', {
              type: 'file',
              accept: '.zip,application/zip',
              class: 'input',
              onchange: (e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) inspectAndImport(file);
              },
            }),
            h('button', { class: 'btn btn-small', onclick: loadBackups }, '刷新自动备份列表'),
          ),
          (state.safetyBackups || []).length
            ? h(
                'div',
                { class: 'storage-table mt-2' },
                ...state.safetyBackups.map((b) =>
                  h(
                    'div',
                    { class: 'storage-row' },
                    h('span', { class: 'storage-label', text: '自动备份' }),
                    h('span', { class: 'storage-count', text: fmtBytes(b.size) }),
                    h('span', { class: 'storage-size', text: b.at.slice(5, 16).replace('T', ' ') }),
                    h('span', { class: 'muted small storage-hint', text: b.name }),
                  ),
                ),
              )
            : null,
        ),
      ),

      /* ---------------- 关于 ---------------- */
      h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '关于' })),
        h(
          'div',
          { class: 'pad' },
          h(
            'div',
            { class: 'about-grid' },
            aboutRow('版本', state.meta?.version || '—', '报问题时请附上这个版本号'),
            aboutRow('Node', state.meta?.node || '—', '要求 ≥ 20'),
            aboutRow(
              '数据目录',
              state.meta?.dataDir || '—',
              '所有数据只在这台机器上；备份请用上面的',
              h(
                'button',
                { class: 'link-btn', type: 'button', onclick: () => jumpToSection('备份与恢复') },
                '「备份与恢复」',
              ),
            ),
            aboutRow('许可', 'MIT', '可自由使用、修改、分发'),
          ),
          h(
            'div',
            { class: 'row-actions mt-3' },
            h(
              'a',
              { class: 'btn btn-small', href: 'https://github.com/Alexwuwei2022/mailbot', target: '_blank', rel: 'noreferrer' },
              '项目主页 / 问题反馈',
            ),
            h(
              'a',
              { class: 'btn btn-small', href: 'https://github.com/Alexwuwei2022/mailbot/blob/main/docs/快速上手.md', target: '_blank', rel: 'noreferrer' },
              '快速上手（5 分钟）',
            ),
          ),
          h(
            'p',
            { class: 'muted small mt-2' },
            '**如何更新**：重新下载最新代码覆盖（**不要覆盖 `data/`** 与 `.env`），重启服务即可；' +
              '数据结构升级会在启动时自动迁移并在日志里写明。',
          ),
        ),
      ),

      /* ---------------- 存储与清理 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '存储与清理' }),
          h('div', { class: 'head-actions' }, h('button', { class: 'btn btn-small nowrap', onclick: loadStorage }, '刷新占用')),
        ),
        h(
          'div',
          { class: 'pad' },
          h(
            'p',
            { class: 'muted small block-lead' },
            '结论与原文要分开看：列表、统计、图表、简报、台账都在 state.json / reports / audit.jsonl 里；' +
              'data/raw/ 里是整封邮件原文（含附件），只影响「查看原文 / 下载附件 / 重新起草」。',
          ),
          storageTable(),
          h('hr', { class: 'sep' }),
          field(
            '分析记录上限',
            numberInput(cfg.retention?.maxAnalyses ?? 3000, (v) => {
              cfg.retention = { ...(cfg.retention || {}), maxAnalyses: v };
            }, { min: 100, max: 100000 }),
            '超出后删最旧的记录。⚠️ 这是历史记录本身的上限：调小会让旧邮件从列表/统计/搜索里消失（旧版本写死 3000，现在可调）',
          ),
          field(
            '归档原文保留天数',
            numberInput(cfg.retention?.rawDays ?? 0, (v) => {
              cfg.retention = { ...(cfg.retention || {}), rawDays: v };
            }, { min: 0, max: 3650 }),
            '0 = 永久保留（默认）。设为正数会删掉超期的原文：邮件还在服务器上时会回连重取，邮件已删除时就查不到了',
          ),
          h(
            'div',
            { class: 'row-actions mt-3' },
            h(
              'button',
              {
                class: 'btn',
                disabled: state.cleaning,
                onclick: async (ev) => {
                  // 先取一次最新占用：确认框里"N 个"必须与此刻磁盘上的实际情况一致
                  try {
                    state.storage = await api.storage();
                  } catch {
                    /* 取不到就沿用页面上的旧数字 */
                  }
                  const s = state.storage || {};
                  const ok = await confirmDialog({
                    title: '清理孤儿归档文件？',
                    message: h(
                      'div',
                      {},
                      h('p', { text: `将删除 ${s.orphan?.count ?? 0} 个没有任何分析记录指向的原文文件。` }),
                      h('p', { class: 'muted small', text: '这些文件已经没有任何界面入口能访问，删除不影响任何可查询的历史（列表/统计/简报/台账）。' }),
                    ),
                    confirmText: '清理孤儿',
                  });
                  if (!ok) return;
                  await runCleanup(ev.currentTarget, { mode: 'orphans' });
                },
              },
              '清理孤儿文件',
            ),
            h(
              'button',
              {
                class: 'btn',
                disabled: state.cleaning,
                onclick: async (ev) => {
                  const btn = ev.currentTarget;
                  const days = Number(cfg.retention?.rawDays) || 0;
                  if (days <= 0) {
                    toast(
                      '当前为永久保留（归档原文保留天数 = 0），按保留期清理不会删除任何原文：请先把保留天数设为大于 0 并保存；只想回收空间可以点「清理孤儿文件」。',
                      'info',
                      10_000,
                    );
                    return;
                  }
                  /*
                   * 先保存再清理：服务端**只认保存过的配置**（见 /api/storage/cleanup 的注释）。
                   * 不先保存就会出现"界面按 7 天算、服务端按 0 天算"的分歧，
                   * 用户看到"什么都没删"只会以为功能坏了。
                   */
                  if (hasUnsavedChanges()) {
                    btn.disabled = true;
                    try {
                      await save({ silent: true });
                      /*
                       * 配置已变，"可回收多少"必须按**新的**保留天数重算，
                       * 否则确认框里会写着旧天数算出来的条数（用户会以为数字是错的）。
                       * 这里只更新数据、不重绘：一重绘这个按钮就换成了新节点，
                       * 后面的「清理中…」就显示不出来了。
                       */
                      try {
                        state.storage = await api.storage();
                      } catch {
                        /* 取不到就用旧数字，确认框仍会写明"按刚才的扫描" */
                      }
                    } finally {
                      btn.disabled = false;
                    }
                    toast(`已先保存配置，按保存后的保留 ${days} 天清理`, 'info', 5000);
                  }
                  const expired = state.storage?.reclaimable?.expired;
                  const orphans = state.storage?.reclaimable?.orphans;
                  const ok = await confirmDialog({
                    title: `删除 ${days} 天前的邮件原文？`,
                    message: h(
                      'div',
                      {},
                      h('p', {
                        text:
                          `将删除超过 ${days} 天的原文归档（含附件）。按刚才的扫描：超期 ${expired?.count ?? 0} 个` +
                          (expired?.bytes ? `（${fmtBytes(expired.bytes)}）` : '') +
                          (orphans?.count ? `；同时清理 ${orphans.count} 个孤儿文件（没有任何分析记录指向，零风险）` : '') +
                          '。',
                      }),
                      /*
                       * 不可逆必须说在最显眼的位置：这句是用户点"确认"前唯一会读的警告。
                       * 界面**不给任何默认勾选的破坏性选项**——真删只有这一个明确按钮 + 二次确认。
                       */
                      h('p', {
                        class: 'error small',
                        text: '⚠️ 删除不可逆：删了就不能再查看这些邮件的原文，附件也下载不了（邮件已被服务器删除时连回源都拿不回来）。',
                      }),
                      h('p', {
                        class: 'muted small',
                        text: '结论（摘要/待办/统计/简报/台账）不受影响；已超期但仍在保留期内被分析/查看引用过的原文会自动保留。',
                      }),
                    ),
                    confirmText: '确认删除',
                    danger: true,
                  });
                  if (!ok) return;
                  await runCleanup(ev.currentTarget, { mode: 'retention', retentionDays: days });
                },
              },
              '按保留期清理原文',
            ),
          ),
          h('p', { class: 'muted small mt-2' }, storageRetentionNote()),
          h('p', {
            class: 'error small',
            text:
              '⚠️ 删除原文不可逆：删了就不能再查看这些邮件的原文，附件也下载不了；' +
              '界面不替你预选任何破坏性选项——不点上面的按钮、不做二次确认，什么都不会删。',
          }),
          lastCleanupBlock(),
          h(
            'p',
            { class: 'muted small mt-2' },
            '只动 data/raw/*.eml，绝不碰 state.json / reports / audit.jsonl —— 那三样才是"历史记录"本身。' +
              '每次清理都会记进操作台账（不可逆的数据损失，事后要能查）。',
          ),
        ),
      ),

      /* ---------------- 日历数字人 ---------------- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '日历数字人（Google Calendar）' }),
          h(
            'div',
            { class: 'head-actions' },
            h(
              'button',
              {
                class: 'btn btn-small',
                // 先保存再测试：用户填完字段直接点测试是自然操作，
                // 若只读服务端已保存的配置，就会报「缺少 clientId」这种看起来自相矛盾的错误。
                onclick: async (ev) => {
                  const btn = ev.currentTarget;
                  btn.disabled = true;
                  btn.textContent = '测试中…';
                  try {
                    if (hasUnsavedChanges()) {
                      await save({ silent: true });
                      toast('已自动保存当前配置，正在测试连接…', 'info', 4000);
                    }
                    const out = await api.calendarTest();
                    toast(`${out.message}（可访问 ${out.calendarCount} 个日历）`, 'success', 6000);
                  } catch (err) {
                    /*
                     * 授权类错误（从未授权 / 令牌被撤销）都**不是配置问题**：
                     * 不必让用户去翻 OAuth 凭据，直接引导他重新授权。
                     */
                    const authIssue =
                      err.code === 'GOOGLE_NOT_CONNECTED' || err.code === 'OAUTH_REFRESH_REVOKED' || err.code === 'OAUTH_NO_REFRESH_TOKEN';
                    if (authIssue) {
                      // 说明里含"7 天过期"的完整原因，短 toast 会截断，给足时间
                      toast(`${err.message}`, 'info', 20000);
                      state.calendarStatus = {
                        ...(state.calendarStatus || {}),
                        configured: true,
                        connected: false,
                        needsReauth: true,
                      };
                      paint();
                    } else {
                      toastError(err);
                    }
                  } finally {
                    btn.disabled = false;
                    btn.textContent = '测试连接';
                  }
                },
              },
              '测试连接',
            ),
            h(
              'button',
              {
                class: 'btn btn-small',
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: '断开 Google 日历？',
                    message: '会撤销本地保存的授权令牌。已写入日历的日程不受影响。',
                    confirmText: '断开',
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    const out = await api.calendarDisconnect();
                    toast(out.message, 'success');
                    await load();
                  } catch (err) {
                    toastError(err);
                  }
                },
              },
              '断开连接',
            ),
          ),
        ),
        state.calendarStatus
          ? h(
              'div',
              { class: 'alert ' + (state.calendarStatus.ready ? 'alert-ok' : 'alert-warn') + ' block-lead mt-4' },
              state.calendarStatus.ready
                ? `已连接${state.calendarStatus.email ? `：${state.calendarStatus.email}` : ''}　·　目标日历 ${state.calendarStatus.calendarId}`
                : state.calendarStatus.enabled
                  ? `尚未完成授权${state.calendarStatus.configProblems?.length ? `：${state.calendarStatus.configProblems.join('；')}` : ''}`
                  : '日历功能未启用',
            )
          : null,
        hasUnsavedChanges()
          ? h(
              'div',
              { class: 'alert alert-warn block-lead' },
              '有未保存的修改。点右上角「保存配置」后才会生效；点「测试连接」会自动先保存。',
            )
          : null,
        state.secretSources?.googleSecretFromEnv
          ? h('div', { class: 'alert alert-info block-lead' }, '检测到 .env 中的 GOOGLE_CLIENT_SECRET，环境变量优先级高于此处填写的内容。')
          : null,
        h(
          'div',
          { class: 'form-grid' },
          field('启用日历数字人', switchInput('', cfg.calendar.enabled, (v) => (cfg.calendar.enabled = v))),
          field(
            '目标日历 ID',
            textInput(cfg.calendar.calendarId, (v) => (cfg.calendar.calendarId = v), { placeholder: 'primary' }),
            'primary 表示主日历；也可填 xxx@group.calendar.google.com',
          ),
          field(
            '时区',
            textInput(cfg.calendar.timeZone, (v) => (cfg.calendar.timeZone = v), { placeholder: 'Asia/Shanghai' }),
            '所有自然语言时间都按这个时区解释',
          ),
          field(
            '网络代理（访问 Google 用）',
            textInput(cfg.calendar.proxy, (v) => (cfg.calendar.proxy = v), { placeholder: 'http://127.0.0.1:7890' }),
            '留空=直连。本程序不会自动使用系统代理；若浏览器能开 Google 而这里报网络错误，就填代理软件的 HTTP 端口。只影响日历，不影响收发邮件与大模型',
          ),
          field('「最近 N 天」窗口', numberInput(cfg.calendar.lookaheadDays, (v) => (cfg.calendar.lookaheadDays = v), { min: 1, max: 60 })),
          field('单次邮件转日程上限', numberInput(cfg.calendar.maxFromEmails, (v) => (cfg.calendar.maxFromEmails = v), { min: 1, max: 50 })),
          field(
            '参与者通知',
            selectInput(cfg.calendar.sendUpdates, (v) => (cfg.calendar.sendUpdates = v), [
              ['none', '不发送邀请邮件（推荐）'],
              ['all', '给所有参与者发邀请'],
              ['externalOnly', '只给外部参与者发'],
            ]),
            '由本数字人代写的日程，建议先人工确认后再通知他人',
          ),
        ),
        h('h4', { class: 'form-section' }, 'Google OAuth 客户端'),
        h(
          'div',
          { class: 'form-grid' },
          field('客户端 ID', textInput(cfg.calendar.google.clientId, (v) => (cfg.calendar.google.clientId = v), { placeholder: 'xxxx.apps.googleusercontent.com' })),
          field(
            '客户端密钥',
            passwordInput(cfg.calendar.google.clientSecret, (v) => (cfg.calendar.google.clientSecret = v), { placeholder: 'GOCSPX-…' }),
            '留空则沿用 .env 中的值',
          ),
          field(
            '授权重定向 URI',
            textInput(cfg.calendar.google.redirectUri, (v) => (cfg.calendar.google.redirectUri = v), { placeholder: state.calendarStatus?.suggestedRedirectUri || '' }),
            '必须与 Google Cloud 里登记的完全一致',
          ),
        ),
        h(
          'p',
          { class: 'muted small block-body' },
          `建议回调地址：${state.calendarStatus?.suggestedRedirectUri || '（保存后显示）'}。日历页有完整的分步配置指引。`,
        ),
      ),

      /* ---------------- 自检结果 ---------------- */
      state.diagnostics
        ? h(
            'section',
            { class: 'block' },
            h(
              'div',
              { class: 'block-head' },
              h('h3', { text: `自检结果（${state.diagnostics.ok ? '全部通过' : '存在问题'}）` }),
            ),
            h(
              'ul',
              { class: 'diag-list' },
              ...state.diagnostics.checks.map((c) =>
                h(
                  'li',
                  { class: `diag-item diag-${c.status}` },
                  h('span', { class: 'diag-icon', text: STATUS_ICON[c.status] || '•' }),
                  h(
                    'div',
                    {},
                    h('b', { text: c.label }),
                    h('div', { class: 'muted small', text: c.message }),
                    c.extra?.mailboxes
                      ? h(
                          'details',
                          {},
                          h('summary', { class: 'muted small', text: `查看 ${c.extra.mailboxes.length} 个文件夹` }),
                          h('div', { class: 'muted small mono', text: c.extra.mailboxes.map((m) => `${m.path}${m.specialUse ? ` (${m.specialUse})` : ''}`).join('\n') }),
                        )
                      : null,
                  ),
                ),
              ),
            ),
          )
        : null,
    );
  };

  /* ---------------------------------------------------------- 实例表单 */

  function instanceForm(inst, cfg) {
    const imapPassHint = state.secretSources?.imapPassFromEnv
      ? '检测到 .env 中的 MAILBOT_IMAP_PASS，环境变量优先。'
      : inst.imap.authPass
        ? '已配置（显示为 ***，不改动则保留）'
        : '请填写授权码 / 客户端专用密码';

    return h(
      'div',
      { class: 'instance-form' },
      h(
        'div',
        { class: 'form-grid' },
        field('邮箱名称（备注）', textInput(inst.label, (v) => (inst.label = v))),
        field(
          '服务商预设',
          selectInput('', (v) => {
            const preset = state.presets.find((p) => p.id === v);
            if (!preset) return;
            inst.imap.host = preset.imap.host;
            inst.imap.port = preset.imap.port;
            inst.imap.secure = preset.imap.secure;
            inst.smtp.host = preset.smtp.host;
            inst.smtp.port = preset.smtp.port;
            inst.smtp.secure = preset.smtp.secure;
            if (!inst.imap.authUser && inst.identity.email) inst.imap.authUser = inst.identity.email;
            paint();
            toast(preset.note, 'info', 7000);
          }, [['', '— 选择以自动填充 —'], ...state.presets.map((p) => [p.id, p.label])]),
        ),
      ),

      h('h4', { class: 'form-section' }, 'IMAP（收信）'),
      h(
        'div',
        { class: 'form-grid' },
        field('IMAP 服务器', textInput(inst.imap.host, (v) => (inst.imap.host = v), { placeholder: 'imap.exmail.qq.com' })),
        field('端口', numberInput(inst.imap.port, (v) => (inst.imap.port = v), { min: 1, max: 65535 }), 'SSL 通常 993'),
        field('加密方式', selectInput(inst.imap.secure ? 'ssl' : 'starttls', (v) => (inst.imap.secure = v === 'ssl'), [['ssl', 'SSL/TLS（993/143）'], ['starttls', 'STARTTLS / 明文（143）']])),
        field('IMAP 账号', textInput(inst.imap.authUser, (v) => (inst.imap.authUser = v), { placeholder: 'you@company.com' })),
        field('IMAP 授权码', passwordInput(inst.imap.authPass, (v) => (inst.imap.authPass = v), { placeholder: '••••••••' }), imapPassHint),
      ),

      h('h4', { class: 'form-section' }, 'SMTP（发信）'),
      h(
        'div',
        { class: 'form-grid' },
        field('SMTP 服务器', textInput(inst.smtp.host, (v) => (inst.smtp.host = v), { placeholder: 'smtp.exmail.qq.com' })),
        field('端口', numberInput(inst.smtp.port, (v) => (inst.smtp.port = v), { min: 1, max: 65535 }), 'SSL 通常 465，STARTTLS 常用 587'),
        field('加密方式', selectInput(inst.smtp.secure ? 'ssl' : 'starttls', (v) => (inst.smtp.secure = v === 'ssl'), [['ssl', 'SSL/TLS（465）'], ['starttls', 'STARTTLS（587/25）']])),
        field('SMTP 账号', textInput(inst.smtp.authUser, (v) => (inst.smtp.authUser = v), { placeholder: '默认与 IMAP 相同' })),
        field('SMTP 授权码', passwordInput(inst.smtp.authPass, (v) => (inst.smtp.authPass = v), { placeholder: '••••••••' }), state.secretSources?.smtpPassFromEnv ? '检测到 .env 中的 MAILBOT_SMTP_PASS，环境变量优先。' : '留空则复用 IMAP 授权码'),
        field(
          '认证方式',
          selectInput(inst.smtp.authMethod || 'auto', (v) => (inst.smtp.authMethod = v), [
            ['auto', '自动协商（默认）'],
            ['LOGIN', '强制 AUTH LOGIN'],
            ['PLAIN', '强制 AUTH PLAIN'],
          ]),
          '若报「535 authentication failed, system busy」，改用「强制 AUTH LOGIN」',
        ),
      ),

      h('h4', { class: 'form-section' }, '发件身份'),
      h(
        'div',
        { class: 'form-grid' },
        field('显示名', textInput(inst.identity.name, (v) => (inst.identity.name = v), { placeholder: '王磊' })),
        field('发件邮箱', textInput(inst.identity.email, (v) => (inst.identity.email = v), { placeholder: 'you@company.com' })),
        field('Reply-To（可选）', textInput(inst.identity.replyTo, (v) => (inst.identity.replyTo = v))),
      ),

      h(
        'div',
        { class: 'switch-row' },
        switchInput('启用该邮箱', inst.enabled !== false, (v) => (inst.enabled = v)),
        switchInput('设为默认邮箱', cfg.defaultInstanceId === inst.id, (v) => {
          if (v) cfg.defaultInstanceId = inst.id;
        }),
      ),

      h(
        'div',
        { class: 'editor-actions' },
        h(
          'button',
          {
            /* 这一块的主操作（保存 + 立刻验证能不能连上），所以用实心主按钮：
               与页面级「保存配置」同为实心，次级动作（运行自检 / 刷新状态 / 测试连接）
               一律描边——全页就只有这两级，不再有"绿字链接"这第三种。 */
            class: 'btn btn-primary',
            onclick: async () => {
              state.activeInstance = inst.id;
              await save();
              await runDiagnostics(true);
            },
          },
          '保存并自检该邮箱',
        ),
        cfg.instances.length > 1
          ? h(
              'button',
              {
                class: 'btn btn-danger-quiet',
                onclick: async () => {
                  const ok = await confirmDialog({
                    title: `删除邮箱「${inst.label}」？`,
                    message: '仅从本机配置中移除，不会影响邮箱服务器上的任何数据。',
                    confirmText: '删除',
                    danger: true,
                  });
                  if (!ok) return;
                  cfg.instances = cfg.instances.filter((i) => i.id !== inst.id);
                  if (cfg.defaultInstanceId === inst.id) cfg.defaultInstanceId = cfg.instances[0].id;
                  state.activeInstance = cfg.instances[0].id;
                  await save();
                },
              },
              '删除该邮箱',
            )
          : null,
      ),
    );
  }

  /* ---------------------------------------------------------- 控件 */

  /**
 * 导出备份。
 *
 * 走 fetch + Blob 而不是直接跳链接：**访问令牌在请求头里**，
 * 普通链接带不上（配了令牌就会 401）；而且这样能显示"导出中…"。
 */
async function exportBackup(btn) {
  const label = btn?.textContent || '';
  state.exporting = true;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '导出中…';
  }
  try {
    const { blob, filename } = await api.exportBackup({ secrets: state.exportSecrets === true, raw: state.exportRaw === true });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    toast(`已导出 ${filename}（${fmtBytes(blob.size)}）`, 'success', 8000);
    if (state.exportSecrets) toast('提醒：这个包里有明文密钥，用完请及时删除', 'error', 12_000);
  } catch (err) {
    toastError(err);
  } finally {
    state.exporting = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
    paint();
  }
}

/** 先检查备份内容，让用户看清"里面有什么、缺什么"，再确认导入。 */
async function inspectAndImport(file) {
  if (!file) return;
  try {
    const info = await api.inspectBackup(file);
    const m = info.manifest;
    const lines = [
      `备份时间：${fmtFull(new Date(m.createdAt))}`,
      `程序版本：${m.appVersion}${m.schemaVersion ? `　数据结构 v${m.schemaVersion}` : ''}`,
      `包含：分析 ${m.counts?.analyses ?? '—'} 条 · 草稿 ${m.counts?.drafts ?? '—'} 条 · 简报 ${m.counts?.reports ?? 0} 份${m.counts?.raw ? ` · 邮件原文 ${m.counts.raw} 封` : ''}`,
      m.includeSecrets ? '含密钥：是（会一并覆盖配置）' : '含密钥：否（**保留你当前的授权码 / API Key**）',
    ];
    if (m.excluded?.length) lines.push(`不含：${m.excluded.join('；')}`);
    if (info.needsSecrets?.length) lines.push(`导入后需要你补填：${info.needsSecrets.join('、')}`);
    if (info.willMigrate) lines.push(`数据结构会从 v${m.schemaVersion} 自动迁移到当前版本`);
    if (info.skipped?.length) lines.push(`将跳过 ${info.skipped.length} 个不认识的文件`);

    const ok = await confirmDialog({
      title: '导入这个备份？',
      message: h(
        'div',
        {},
        h('p', { text: `文件：${file.name}（${fmtBytes(file.size)}）` }),
        ...lines.map((t) => h('p', { class: 'muted small', text: t })),
        h('p', { class: 'error small', text: '当前数据会被**覆盖**（程序会先自动把当前数据再备份一份，可回滚）。' }),
      ),
      confirmText: '确认导入',
      danger: true,
    });
    if (!ok) return;
    const out = await api.importBackup(file);
    toast(`${out.message}${out.safetyBackup ? '（旧数据已自动备份）' : ''}`, 'success', 10_000);
    // 数据全变了：让所有视图重新取数，并重载配置
    app.invalidateAll?.();
    state.fetched = false;
    state.config = null;
    state.storage = null;
    state.meta = null;
    // 重新进入设置页（用一个全新的视图状态，避免残留旧配置）
    if (app.viewStates) delete app.viewStates.settings;
    renderSettings(root, app);
    app.refreshCounts?.();
  } catch (err) {
    toastError(err);
  }
}

/** 拉取"导入前自动备份"列表（可用于回滚）。 */
async function loadBackups() {
  try {
    const out = await api.backups();
    state.safetyBackups = out.backups || [];
  } catch {
    state.safetyBackups = [];
  }
  paint();
}

/**
 * 数据去向面板。
 *
 * 内容全部来自服务端按当前配置推导的结果（`/api/egress`），
 * 所以改了模型地址或代理，这里显示的**目的地**会跟着变——不会出现"文档说一套、实际做一套"。
 */
function egressPanel() {
  const e = state.egress;
  const llm = state.config?.llm || {};

  const kindLabel = { loopback: '本机', lan: '局域网另一台机器', public: '公网服务', mail: '邮件', proxy: '代理', invalid: '地址无效' };

  return h(
    'div',
    {},
    /* 仅本地模式 */
    h(
      'label',
      { class: 'form-check form-check-strong' },
      h('input', {
        type: 'checkbox',
        checked: llm.localOnly === true,
        onchange: (ev) => {
          llm.localOnly = ev.target.checked;
          paint();
        },
      }),
      h('b', { text: '仅本地模式：邮件内容只发给本机模型' }),
    ),
    h(
      'p',
      { class: 'muted small' },
      '打开后，任何指向**局域网另一台机器**或**公网服务**的模型地址都会被直接拒绝（不是提醒，是拒绝）。' +
        '适合用 Ollama 等本机模型的人。注意：局域网地址（192.168.x.x 等）也算"离开本机"。',
    ),
    e.blocked
      ? h(
          'p',
          { class: 'error small' },
          `⚠️ 当前配置下模型调用会被拒绝：模型地址是 ${e.llmHost || '（空）'}（${kindLabel[e.llmKind] || '未知'}）。` +
            '要么把它改成 http://127.0.0.1:11434 这类本机地址，要么关掉本开关。',
        )
      : null,

    /* 逐项去向 */
    h(
      'div',
      { class: 'storage-table mt-2' },
      ...(e.items || []).map((it) =>
        h(
          'div',
          { class: 'storage-row' },
          h('span', { class: `tag ${it.enabled ? (it.destinationKind === 'loopback' ? 'tag-ok' : 'tag-warn') : ''}`, text: it.enabled ? '会发送' : '未启用' }),
          h('span', { class: 'storage-label', text: it.feature }),
          h(
            'span',
            { class: 'muted small storage-hint' },
            it.enabled
              ? `→ ${it.destination}${it.destinationKind && kindLabel[it.destinationKind] ? `（${kindLabel[it.destinationKind]}）` : ''}｜发送：${it.sends.join('、')}${it.notSends?.length ? `｜**不发**：${it.notSends.join('、')}` : ''}`
              : '（未启用，不会发送任何内容）',
          ),
        ),
      ),
    ),

    h('h4', { class: 'form-section', text: '永远不离开这台电脑' }),
    h(
      'ul',
      { class: 'small muted' },
      ...(e.stays || []).map((s) => h('li', { text: s })),
    ),

    h(
      'div',
      { class: 'row-actions mt-3' },
      h(
        'button',
        {
          class: 'btn btn-primary',
          disabled: state.securityBusy,
          onclick: (ev) => saveEgress(ev.currentTarget),
        },
        state.securityBusy ? '保存中…' : '保存隐私设置',
      ),
      h('button', { class: 'btn', disabled: state.securityBusy, onclick: loadEgress }, '刷新去向'),
    ),
  );
}

/** 保存隐私设置（只提交 llm 里的隐私相关字段，避免把 API Key 一起写坏）。 */
async function saveEgress(btn) {
  const llm = state.config?.llm || {};
  state.securityBusy = true;
  if (btn) btn.textContent = '保存中…';
  paint();
  try {
    await api.saveConfig({ llm: { localOnly: llm.localOnly === true } });
    state.egress = await api.egress();
    toast('已保存隐私设置', 'success', 6000);
  } catch (err) {
    toastError(err);
  } finally {
    state.securityBusy = false;
    if (btn) btn.textContent = '保存隐私设置';
    paint();
  }
}

async function loadEgress() {
  try {
    state.egress = await api.egress();
  } catch (err) {
    state.egress = null;
    toastError(err);
  }
  paint();
}

/**
 * 访问与安全面板。
 *
 * 立场是"把风险说出来"，不是给个绿灯：监听地址、令牌强度、HTTPS、域名白名单、
 * 会话策略逐项列出结论；任何一项是 error 就顶上一条红字。
 */
function securityPanel() {
  const s = state.security;
  const cfg = state.config || {};
  const web = cfg.web || {};
  const https = web.https || {};

  const levelTag = { ok: 'tag-ok', warn: 'tag-warn', error: 'tag-warn' };

  return h(
    'div',
    {},
    s.worst === 'error'
      ? h('p', { class: 'error small' }, '⚠️ 下面有需要处理的问题（标红项）：现在的设置存在真实风险。')
      : null,
    h(
      'div',
      { class: 'storage-table' },
      ...(s.checks || []).map((c) =>
        h(
          'div',
          { class: 'storage-row' },
          h('span', { class: `tag ${levelTag[c.level] || ''}`, text: c.level === 'ok' ? '正常' : c.level === 'warn' ? '注意' : '风险' }),
          /* 需要处理的项，标题也用红色：一排标签里光标签变色，眼睛还得逐行找 */
          h('span', { class: `storage-label${c.level === 'ok' ? '' : ' is-warn'}`, text: c.title }),
          h('span', { class: 'muted small storage-hint', text: c.detail }),
        ),
      ),
    ),

    /* 访问令牌 */
    h('h4', { class: 'form-section', text: '访问令牌' }),
    h(
      'p',
      { class: 'muted small' },
      '相当于这个服务的密码。登录后浏览器**只保存一个短期会话**（HttpOnly Cookie），不再保存令牌本身。',
    ),
    h(
      'div',
      { class: 'row-actions' },
      h(
        'button',
        {
          class: 'btn',
          disabled: state.securityBusy,
          onclick: (ev) => setToken2(ev.currentTarget, '__generate__', '生成一个新的强令牌'),
        },
        '生成新令牌',
      ),
      h(
        'button',
        {
          class: 'btn',
          disabled: state.securityBusy,
          onclick: (ev) => setToken2(ev.currentTarget, '', '清空访问令牌（任何能连上的人都能直接使用）'),
        },
        '清空令牌（不推荐）',
      ),
      h(
        'button',
        {
          class: 'btn btn-small',
          disabled: state.securityBusy,
          onclick: async () => {
            await api.logout();
            location.reload();
          },
        },
        '退出登录',
      ),
    ),
    h(
      'p',
      { class: 'muted small' },
      `当前令牌：${web.authToken ? '已设置（掩码显示，改它请用上面的按钮）' : '**未设置**'}　·　` +
        `强度：${s.token?.strength === 'strong' ? '强' : s.token?.strength === 'ok' ? '可用' : '弱'}　·　已登录设备 ${s.sessions?.count || 0} 个`,
    ),

    /* 会话策略 */
    h('h4', { class: 'form-section', text: '会话策略' }),
    h(
      'div',
      { class: 'form-row' },
      numField('空闲多久过期（小时）', web.sessionIdleHours ?? 12, (v) => (web.sessionIdleHours = v)),
      numField('最长多少天必须重新登录', web.sessionAbsoluteDays ?? 7, (v) => (web.sessionAbsoluteDays = v)),
    ),
    h(
      'p',
      { class: 'muted small' },
      '重启服务会让所有会话立即失效（会话只存在内存里，这是刻意的：省掉一个必须防篡改的落盘文件）。',
    ),

    /* 监听与域名 */
    h('h4', { class: 'form-section', text: '监听地址与域名白名单' }),
    h(
      'div',
      { class: 'form-row' },
      field(
        '监听地址',
        selectChoice(
          [
            { value: '127.0.0.1', label: '仅本机（推荐）' },
            { value: '0.0.0.0', label: '所有网卡（局域网可访问）' },
            { value: '__custom__', label: '指定地址…' },
          ],
          ['127.0.0.1', '0.0.0.0'].includes(web.host) ? web.host : '__custom__',
          (v) => {
            web.host = v === '__custom__' ? web.hostCustom || '' : v;
            paint();
          },
        ),
        '改完要重启服务才生效',
      ),
      !['127.0.0.1', '0.0.0.0'].includes(web.host)
        ? field('自定义监听地址', textInput(web.host, (v) => ((web.host = v), (web.hostCustom = v))))
        : null,
    ),
    field(
      '允许的域名（逗号分隔）',
      textInput((web.allowedHosts || []).join(', '), (v) => (web.allowedHosts = v.split(',').map((x) => x.trim()).filter(Boolean))),
      '仅当你用域名（反向代理/内网域名）访问时才需要填。域名可被解析到任意地址，正是 DNS rebinding 的载体，所以默认一个都不放',
    ),

    /* HTTPS */
    h('h4', { class: 'form-section', text: 'HTTPS' }),
    h(
      'label',
      { class: 'form-check' },
      h('input', { type: 'checkbox', checked: https.enabled === true, onchange: (e) => ((https.enabled = e.target.checked), paint()) }),
      '启用 HTTPS（改完要重启服务）',
    ),
    https.enabled
      ? h(
          'div',
          {},
          h('label', { class: 'form-check' }, h('input', { type: 'checkbox', checked: https.selfSigned !== false, onchange: (e) => ((https.selfSigned = e.target.checked), paint()) }), '没有正式证书时使用自签证书'),
          https.selfSigned === false
            ? h(
                'div',
                {},
                field('证书文件（PEM）', textInput(https.certFile || '', (v) => (https.certFile = v)), '可以是绝对路径，或相对程序目录'),
                field('私钥文件（PEM）', textInput(https.keyFile || '', (v) => (https.keyFile = v))),
              )
            : h(
                'p',
                { class: 'muted small' },
                '自签证书只保证**传输加密**，浏览器仍会提示"不受信任"（点继续访问即可）。要免警告就填自己的证书。',
              ),
          s.tls?.fingerprint256
            ? h('p', { class: 'muted small' }, `当前证书指纹 SHA-256：${s.tls.fingerprint256}${s.tls.notAfter ? `（有效期至 ${fmtFull(new Date(s.tls.notAfter))}）` : ''}`)
            : null,
        )
      : h('p', { class: 'muted small' }, s.loopbackOnly ? '只监听本机时明文不出本机，可以不开。' : '⚠️ 当前监听范围不止本机，建议开启：否则令牌与邮件内容在局域网链路上是明文。'),

    h(
      'div',
      { class: 'row-actions mt-3' },
      h(
        'button',
        {
          class: 'btn btn-primary',
          disabled: state.securityBusy,
          onclick: (ev) => saveSecurity(ev.currentTarget),
        },
        state.securityBusy ? '保存中…' : '保存访问与安全设置',
      ),
      h('button', { class: 'btn', disabled: state.securityBusy, onclick: loadSecurity }, '刷新状态'),
    ),
    /*
     * 「重置本地分析数据」原来在「服务与访问控制」块里，两块合并时不能把它弄丢——
     * 这是不可逆操作，界面上少一个入口，用户就只能去翻文档。
     */
    h(
      'div',
      { class: 'danger-zone mt-3' },
      h(
        'div',
        {},
        h('b', { text: '重置本地分析数据' }),
        h('p', { class: 'muted small', text: '删除 data/state.json 里的分析与草稿记录（原文件会备份），不影响邮箱里的邮件。' }),
      ),
      h(
        'button',
        {
          class: 'btn btn-danger-quiet',
          onclick: async () => {
            const ok = await confirmDialog({
              title: '重置本地分析数据？',
              message: '这只会清空本机的分析与草稿记录，邮件与邮箱草稿箱不受影响。',
              confirmText: '确认重置',
              danger: true,
            });
            if (!ok) return;
            try {
              await api.resetState();
              toast('已重置', 'success');
              app.refreshCounts?.();
            } catch (err) {
              toastError(err);
            }
          },
        },
        '重置',
      ),
    ),
    h('p', { class: 'muted small mt-2' }, '改动监听地址与 HTTPS 需要**重启服务**才生效（会话策略与令牌立即生效）。'),
  );
}

/** 改访问令牌（可传 __generate__ 让服务端生成）。 */
async function setToken2(btn, value, what) {
  const ok = await confirmDialog({
    title: `确定要${what}？`,
    message: h(
      'div',
      {},
      h('p', { class: 'small', text: '所有已登录的设备会立即掉线，需要用新令牌重新登录。' }),
      value === ''
        ? h('p', { class: 'error small', text: '清空后**任何能访问这个地址的人都能直接使用**，包括读取邮件与发信。' })
        : h('p', { class: 'small', text: '新令牌会显示一次，请复制保存（界面里之后只显示掩码）。' }),
    ),
    confirmText: '确定',
    danger: value === '',
  });
  if (!ok) return;
  state.securityBusy = true;
  if (btn) btn.disabled = true;
  paint();
  try {
    const out = await api.setAuthToken(value);
    state.security = await api.security();
    if (out.authToken) {
      await confirmDialog({
        title: '新令牌（请复制保存）',
        message: h(
          'div',
          {},
          h('code', { class: 'token-reveal', text: out.authToken }),
          h('p', { class: 'muted small', text: '这个值只显示这一次；之后界面只显示掩码。' }),
          h('p', { class: 'small', text: '保存后请用新令牌重新登录本页面。' }),
        ),
        confirmText: '我已复制',
        cancelText: '知道了',
      });
      await api.logout();
      location.reload();
      return;
    }
    toast(out.message, 'success', 8000);
  } catch (err) {
    toastError(err);
  } finally {
    state.securityBusy = false;
    paint();
  }
}

/** 保存访问与安全设置（只提交这一块字段）。 */
async function saveSecurity(btn) {
  const web = state.config?.web || {};
  state.securityBusy = true;
  if (btn) btn.textContent = '保存中…';
  paint();
  try {
    await api.saveConfig({
      web: {
        host: web.host,
        /* 端口与访问令牌也在这一块里改，必须一起提交——
           否则用户改完点「保存」什么都不会发生（漏提交比报错更难发现） */
        port: web.port,
        authToken: web.authToken,
        allowedHosts: web.allowedHosts || [],
        sessionIdleHours: web.sessionIdleHours,
        sessionAbsoluteDays: web.sessionAbsoluteDays,
        https: {
          enabled: web.https?.enabled === true,
          selfSigned: web.https?.selfSigned !== false,
          certFile: web.https?.certFile || '',
          keyFile: web.https?.keyFile || '',
          altNames: web.https?.altNames || [],
        },
      },
    });
    state.security = await api.security();
    toast('已保存（改监听地址与 HTTPS 需要重启服务生效）', 'success', 8000);
  } catch (err) {
    toastError(err);
  } finally {
    state.securityBusy = false;
    if (btn) btn.textContent = '保存访问与安全设置';
    paint();
  }
}

async function loadSecurity() {
  try {
    state.security = await api.security();
  } catch (err) {
    state.security = null;
    toastError(err);
  }
  paint();
}

/** 数字输入。 */
function numField(label, value, oninput) {
  return field(
    label,
    h('input', { class: 'input', type: 'number', min: 1, value: value ?? '', oninput: (e) => oninput(Number(e.target.value)) }),
  );
}

function textInput(value, oninput) {
  return h('input', { class: 'input', type: 'text', value: value ?? '', oninput: (e) => oninput(e.target.value) });
}

/**
 * 下拉框（选项数组在前）。
 *
 * 特意**不叫** selectInput：那个名字在本文件里已被页面原有的同名函数占用
 * （签名是 value/onChange/options），一旦重名就会覆盖它，导致所有旧调用把字符串
 * 当数组传 → options.map is not a function，整页崩掉。这个坑我踩过。
 */
function selectChoice(options, value, onchange) {
  return h(
    'select',
    { class: 'input', onchange: (e) => onchange(e.target.value) },
    ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );
}

/**
 * 超过这个长度的说明改成「?」提示。
 *
 * 为什么：设置页有 68 个字段，长说明（常常 2-4 行）会把同一行的字段撑得高矮不一，
 * 整页看起来就是"凌乱"。短的说明（「SSL 通常 993」）留一行反而有用，
 * 所以按长度分流，而不是一律塞进提示里。
 */
const HINT_TOOLTIP_MIN = 22;

/**
 * 标签后的「?」提示。
 *
 * 交互上选**点击展开**而不是纯 hover：hover 提示在触屏上根本出不来，
 * 而且用户想照着提示操作时会因为移开鼠标而消失。同时保留 title 属性，
 * 鼠标悬停也能看到（两种习惯都照顾）。
 */
function helpTip(text) {
  const box = h('span', { class: 'field-help-box' }, h('span', { class: 'field-help-text', text }));
  const btn = h(
    'button',
    {
      class: 'field-help',
      type: 'button',
      title: text,
      'aria-label': `说明：${text}`,
      onclick: (ev) => {
        // 点在 label 里，不阻止冒泡就会把焦点转到输入框上，提示反而关掉
        ev.preventDefault();
        ev.stopPropagation();
        box.classList.toggle('open');
      },
    },
    '?',
  );
  return h('span', { class: 'field-help-wrap' }, btn, box);
}

function fieldLabel(text, hint) {
  const long = typeof hint === 'string' && hint.length > HINT_TOOLTIP_MIN;
  return h(
    'span',
    { class: 'field-label-row' },
    h('span', { text }),
    long ? helpTip(hint) : null,
  );
}

/** 字段下方的说明；已在「?」里的不再重复显示。 */
function fieldHint(hint) {
  if (!hint || hint.length > HINT_TOOLTIP_MIN) return null;
  return h('span', { class: 'muted small', text: hint });
}

/** 统一的字段结构（全页只有这一份：设置页所有字段都该长这样）。 */
function field(label, control, hint) {
  return h(
    'label',
    { class: 'field' },
    fieldLabel(label, hint),
    control,
    fieldHint(hint),
  );
}

/**
 * 设置页的**阅读顺序**（按配置时的思考顺序排，而不是按开发时的添加顺序）。
 *
 * 为什么用"渲染后再排序"而不是把 JSX 搬来搬去：这个文件两千多行，
 * 手工搬动大段 JSX 出错风险高、diff 也没法评审。这里用一份标题顺序表，
 * 渲染完把区块**实际移动**到对应位置——DOM 顺序真的变了（Tab 顺序、读屏顺序都跟着），
 * 不是 CSS 的视觉障眼法。表里没有的区块保持原有相对顺序、放在末尾。
 *
 * 「关于」放最后：它是最少被打开的一块，不该夹在配置项中间（用户原话）。
 */
const SETTINGS_ORDER = [
  '邮箱账户',
  '分析与起草策略',
  '大模型',
  '日历数字人',
  '定时分析与通知',
  '服务与访问控制',
  '访问与安全',
  '数据去向',
  '密钥存储',
  '备份与恢复',
  '存储与清理',
  '外观',
  '运行与记录',
  '关于',
];

/**
 * 按具名锚点找到设置区块。
 *
 * 精确匹配优先，其次前缀匹配——标题带括号或补充说明（「大模型（OpenAI 兼容协议）」）
 * 时，用「大模型」也能定位到，与 SETTINGS_ORDER 的排序用的是同一套前缀规则。
 */
function findSection(container, anchor) {
  if (!anchor) return null;
  const titleOf = (block) => block.dataset?.section || block.querySelector('.block-head h3')?.textContent?.trim() || '';
  const blocks = [...container.querySelectorAll('section.block')];
  return blocks.find((b) => titleOf(b) === anchor) || blocks.find((b) => titleOf(b).startsWith(anchor)) || null;
}

/**
 * 滚动到具名区块并短暂高亮。
 *
 * 复用 `dom.scrollToEl`（内部已处理"最小 DOM 没有 scrollIntoView"与 `flash-target` 高亮），
 * 所以真实浏览器里落点有视觉反馈——用户能看清自己落在哪一张卡片上。
 *
 * @returns {string|null} 还没渲染出来时**原样返回**锚点，留给下一次 paint 再试
 *   （首帧仍是「加载配置中…」，那时一个 section.block 都没有）。
 */
function revealSection(container, anchor) {
  if (!anchor) return null;
  const block = findSection(container, anchor);
  if (!block) return anchor;
  scrollToEl(block);
  return null;
}

/**
 * 分区目录 + 区块顺序。
 *
 * 目录按**实际渲染出来的区块**生成，而不是硬编码一份清单：
 * 硬编码的目录一旦和页面不同步（改标题、加区块、条件隐藏），
 * 用户点了滚到别处——那比没有目录更糟。
 */
function organizeSettings(container) {
  const blocks = [...container.querySelectorAll('section.block')];
  if (!blocks.length) return;

  // ① 按 SETTINGS_ORDER 重排（用前缀匹配，标题带括号或补充说明也能对上）
  const rank = (block) => {
    const title = block.querySelector('.block-head h3')?.textContent?.trim() || '';
    const index = SETTINGS_ORDER.findIndex((name) => title.startsWith(name));
    return index === -1 ? SETTINGS_ORDER.length : index;
  };
  const sorted = blocks
    .map((block, index) => ({ block, index, rank: rank(block) }))
    // 同名的（或都不在表里的）保持原有相对顺序
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((item) => item.block);

  const parent = blocks[0].parentElement;
  for (const block of sorted) parent.append(block);

  // ② 重排后再生成目录（顺序才会与页面一致）
  container.querySelector('.settings-toc')?.remove();
  const items = [];
  sorted.forEach((block, index) => {
    const title = block.querySelector('.block-head h3')?.textContent?.trim();
    if (!title) return;
    const id = `settings-sec-${index}`;
    block.id = id;
    /*
     * 具名锚点：除了 `settings-sec-N` 这个**位置** id，再挂一个**语义**锚点，
     * 让「返回设置」能说清"我要落在哪一块"（用标题而不是序号，
     * 顺序调整时不会静默滚错卡片）。
     */
    block.dataset.section = title;
    items.push({ id, title });
  });
  if (items.length < 4) return;

  const chips = items.map((it) =>
    h(
      'button',
      {
        class: 'toc-chip',
        type: 'button',
        dataset: { target: it.id },
        onclick: () => {
          // scrollIntoView 在测试环境（linkedom）里不存在，缺了也不该让点击炸掉
          container.querySelector(`#${it.id}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
          setActive(it.id);
        },
      },
      it.title,
    ),
  );

  /** 选中态：加粗 + 高亮，让用户知道"当前在哪一块"。 */
  function setActive(id) {
    for (const chip of chips) {
      const on = chip.dataset.target === id;
      chip.classList.toggle('active', on);
      chip.setAttribute('aria-current', on ? 'true' : 'false');
    }
  }

  const nav = h(
    'nav',
    { class: 'settings-toc', 'aria-label': '设置分区' },
    h('span', { class: 'toc-label', text: '分区' }),
    h('div', { class: 'toc-chips' }, ...chips),
  );

  const head = container.querySelector('.page-head');
  if (head && head.nextSibling) container.insertBefore(nav, head.nextSibling);
  else container.append(nav);

  /*
   * 滚动时同步高亮：否则用户手动滚到别的区块，目录还highlight着上一个，
   * 那比不高亮更误导。取"最后一个已经滚过顶部偏移的区块"。
   */
  const offset = 130;
  const syncActive = () => {
    let current = items[0];
    for (const it of items) {
      const el = container.querySelector(`#${it.id}`);
      if (el && el.getBoundingClientRect().top <= offset) current = it;
    }
    setActive(current.id);
  };
  setActive(items[0].id);
  // 先摘掉上一次渲染挂的监听，避免每次重绘都累积一个
  if (container._tocScroll) window.removeEventListener('scroll', container._tocScroll);
  container._tocScroll = syncActive;
  window.addEventListener('scroll', syncActive, { passive: true });
  syncActive();
}

/**
 * 密钥存储面板。
 *
 * 三件事必须一眼看清，否则用户会一直猜：
 *   ①现在每个密钥**到底存在哪**（明文配置文件 / .env / 保管库）；
 *   ②保管库是**加密的**还是降级成了未加密文件；
 *   ③换成另一台电脑会发生什么。
 */
function secretsPanel() {
  const s = state.secrets;
  const backendLabel = s.currentBackend?.label || s.resolved || '—';
  const plain = (s.items || []).filter((i) => i.set && (i.location === 'config' || i.location === 'envFile' || i.location === 'envReal'));
  const inVault = (s.items || []).filter((i) => i.location === 'vault');
  const locText = { config: '明文在 config.json', envFile: '明文在 .env', envReal: '来自环境变量', vault: '系统保管库', none: '未设置' };

  const options = (s.backends || []).filter((b) => b.available);

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'kv-row' },
      h('span', { class: 'kv-label', text: '当前方式' }),
      h(
        'span',
        { class: 'kv-value' },
        s.mode === 'config' ? '明文写在配置文件里（默认）' : `${backendLabel}${s.currentBackend?.encrypted ? '' : '（**未加密**）'}`,
      ),
    ),
    s.degraded
      ? h('p', { class: 'error small' }, `⚠️ 已降级为未加密的本地文件：${s.degradeReason}`)
      : null,
    s.vaultOk === false
      ? h(
          'p',
          { class: 'error small' },
          `⚠️ 保管库读取失败：${s.vaultError}。**你的密钥没有被删除**，本次只是没能注入；修好后再刷新本页。`,
        )
      : null,

    h(
      'div',
      { class: 'storage-table mt-2' },
      ...(s.items || []).map((i) =>
        h(
          'div',
          { class: 'storage-row' },
          h('span', { class: 'storage-label', text: i.label }),
          h('span', { class: `tag ${i.location === 'vault' ? 'tag-ok' : i.set ? 'tag-warn' : ''}`, text: locText[i.location] || i.location }),
          h('span', { class: 'muted small storage-hint', text: i.set ? '' : '（空）' }),
        ),
      ),
    ),

    h(
      'p',
      { class: 'muted small mt-2' },
      '**威胁模型（不夸大）**：搬进保管库能防的是"`config.json` / `.env` 被拷走、被网盘同步、进了备份包、被人翻到"——' +
        '文件里不再有密钥，密文只有**这台机器的这个用户**能解开。它**防不住**以你的身份运行的恶意程序、' +
        '你离开时没锁屏的电脑。',
    ),
    h(
      'p',
      { class: 'muted small' },
      '**换电脑/重装系统**：保管库里的密钥解不开（这是它的设计目标），需要在「开始使用」或设置里重新填一次授权码。' +
        '导出的备份包**不含**保管库内容，所以别指望用它搬密钥。',
    ),
    (s.notCovered || []).length
      ? h('p', { class: 'muted small' }, `尚未纳入：${s.notCovered.join('；')}`)
      : null,

    h(
      'div',
      { class: 'row-actions mt-3' },
      s.mode === 'config'
        ? [
            ...(options.length
              ? [
                  h(
                    'button',
                    {
                      class: 'btn btn-primary',
                      disabled: state.secretsBusy,
                      onclick: (ev) => migrateSecrets(ev.currentTarget, s.bestMode || options[0].id),
                    },
                    state.secretsBusy ? '迁移中…' : `迁入「${options[0].label}」`,
                  ),
                ]
              : [h('span', { class: 'muted small', text: '本机没有可用的系统保管后端' })]),
            options.length > 1
              ? h(
                  'select',
                  {
                    class: 'input input-inline',
                    onchange: (e) => {
                      state.secretsPick = e.target.value;
                      paint();
                    },
                  },
                  ...options.map((b) =>
                    h('option', { value: b.id, selected: (state.secretsPick || options[0].id) === b.id }, `${b.label}${b.encrypted ? '' : '（未加密）'}`),
                  ),
                )
              : null,
          ]
        : [
            h(
              'button',
              {
                class: 'btn',
                disabled: state.secretsBusy,
                onclick: (ev) => revertSecrets(ev.currentTarget),
              },
              state.secretsBusy ? '处理中…' : '迁回明文（我不想用它了）',
            ),
            h(
              'button',
              {
                class: 'btn',
                disabled: state.secretsBusy,
                onclick: (ev) => migrateSecrets(ev.currentTarget, state.secretsPick || options[0]?.id || s.resolved),
              },
              '改用其它保管方式',
            ),
          ],
      h('button', { class: 'btn btn-small', disabled: state.secretsBusy, onclick: loadSecrets }, '刷新'),
    ),
    inVault.length
      ? h('p', { class: 'muted small mt-2' }, `已在保管库：${inVault.length} 项；明文残留：${plain.length} 项`)
      : h('p', { class: 'muted small mt-2' }, `明文残留：${plain.length} 项（任何能读 config.json 的人都能看到）`),
  );
}

/** 迁移确认：把"会发生什么"讲清楚再动手。 */
async function migrateSecrets(btn, mode) {
  const s = state.secrets;
  const backend = (s.backends || []).find((b) => b.id === mode);
  const ok = await confirmDialog({
    title: `把密钥迁到「${backend?.label || mode}」？`,
    message: h(
      'div',
      {},
      h('p', { class: 'small', text: '程序会：①把当前所有密钥写进保管库；②读回来逐项比对；③比对通过后，才把 config.json 与 .env 里的明文清空。' }),
      h('p', { class: 'small', text: '任何一步失败都会回滚，密钥不会丢。' }),
      backend && !backend.encrypted
        ? h('p', { class: 'error small', text: '⚠️ 这个后端**不加密**：只是把密钥挪进单独一个 600 权限的文件。' })
        : null,
      h('p', { class: 'muted small', text: `换电脑后需要重新填写授权码（${backend?.detail || ''}）。` }),
    ),
    confirmText: '确认迁移',
  });
  if (!ok) return;
  const label = btn?.textContent;
  state.secretsBusy = true;
  if (btn) btn.textContent = '迁移中…';
  paint();
  try {
    const out = await api.secretsMigrate(mode);
    state.secrets = out.status;
    toast(out.message || '已迁移', 'success', 8000);
    state.config = null;
    invalidate(app, 'settings');
  } catch (err) {
    toastError(err);
  } finally {
    state.secretsBusy = false;
    if (btn) btn.textContent = label;
    paint();
  }
}

async function revertSecrets(btn) {
  const ok = await confirmDialog({
    title: '把密钥迁回明文？',
    message: h(
      'div',
      {},
      h('p', { class: 'small', text: '密钥会重新写进 `config.json`（明文），保管库里的副本会被清空。' }),
      h('p', { class: 'small', text: '之后**不要**把 config.json 放进网盘或提交到代码仓库。' }),
    ),
    confirmText: '确认迁回',
    danger: true,
  });
  if (!ok) return;
  state.secretsBusy = true;
  if (btn) btn.textContent = '处理中…';
  paint();
  try {
    const out = await api.secretsRevert();
    state.secrets = out.status;
    toast(out.message || '已迁回明文', 'success', 8000);
    if (out.warning) toast(out.warning, 'error', 12_000);
    state.config = null;
    invalidate(app, 'settings');
  } catch (err) {
    toastError(err);
  } finally {
    state.secretsBusy = false;
    paint();
  }
}

async function loadSecrets() {
  try {
    state.secrets = await api.secrets();
  } catch (err) {
    state.secrets = null;
    toastError(err);
  }
  paint();
}

/**
 * 「关于」里的一行：标签 / 值 / 说明。
 *
 * 说明用**可变参数**而不是单个字符串：有的说明里要嵌一个可点的按钮
 * （例如「备份请用上面的「备份与恢复」」）。
 */
function aboutRow(label, value, ...hint) {
  return h(
    'div',
    { class: 'about-row' },
    h('span', { class: 'about-label', text: label }),
    h('span', { class: 'about-value', text: String(value) }),
    h('span', { class: 'muted small about-hint' }, ...hint),
  );
}

/**
 * 存储占用明细表（原文 / 孤儿 / 可回收 / 简报 / 台账 / 状态 / data 合计）。
 *
 * 「可回收空间」是关键的一项：它回答"现在点清理到底能省多少"。
 * 数字来自服务端的 `reclaimable`——与真正删除时**共用同一份判据**
 * （见 `server/store/state.js` 的 `planRawCleanup`），
 * 所以不会出现"显示 40 MB 可回收、真删只删了 2 MB"这种对不上的事。
 */
function storageTable() {
  const s = state.storage;
  if (!s) {
    return h('p', { class: 'muted small' }, '正在读取存储占用…');
  }
  const mb = (b) => `${(Number(b || 0) / 1024 / 1024).toFixed(1)} MB`;
  const rec = s.reclaimable || { orphans: s.orphan || { count: 0, bytes: 0 }, expired: { count: 0, bytes: 0 }, total: s.orphan || { count: 0, bytes: 0 }, permanent: s.retention?.rawDays === 0 };
  const rows = [
    ['归档原文', `${s.raw.count} 个`, mb(s.raw.bytes), '整封邮件原文（含附件）'],
    ['其中孤儿', `${s.orphan.count} 个`, mb(s.orphan.bytes), s.orphan.count ? '没有任何分析记录指向，可安全清理' : '没有孤儿文件 ✅'],
    [
      '可回收空间',
      `${rec.total.count} 个`,
      rec.total.bytes ? `约 ${fmtBytes(rec.total.bytes)}` : '0 B',
      rec.permanent
        ? '当前为永久保留：保留期清理不会删除任何原文，可回收的只有孤儿文件'
        : `超期 ${rec.expired.count} 个（${fmtBytes(rec.expired.bytes)}）+ 孤儿 ${rec.orphans.count} 个（${fmtBytes(rec.orphans.bytes)}）；点下面的按钮才会真的删`,
    ],
    ['简报文件', `${s.reports.count} 个`, mb(s.reports.bytes), 'AI 简报 markdown'],
    ['操作台账', `${s.audit.count} 个`, mb(s.audit.bytes), '永久保留'],
    ['状态文件', `${s.state.count} 个`, mb(s.state.bytes), `${s.analyses} 条分析 · ${s.drafts} 条草稿（上限 ${s.retention.maxAnalyses}）`],
    [
      'data 目录合计',
      s.total ? `${s.total.count} 个文件` : '—',
      s.total ? mb(s.total.bytes) : '—',
      '含原文 / 简报 / 台账 / 附件 / 证书；清理原文后这一项应下降',
    ],
  ];
  return h(
    'div',
    { class: 'storage-table' },
    ...rows.map(([label, count, size, hint]) =>
      h(
        'div',
        { class: 'storage-row' },
        h('span', { class: 'storage-label', text: label }),
        h('span', { class: 'storage-count', text: count }),
        h('span', { class: 'storage-size', text: size }),
        h('span', { class: 'muted small storage-hint', text: hint }),
      ),
    ),
  );
}

/**
 * 「保留期」这一句必须把两种情况说清，而不是给一个含糊的 0：
 * 永久保留时明说"保留期清理不会删除任何原文"（这正是用户当前配置的情形）。
 */
function storageRetentionNote() {
  const s = state.storage;
  if (!s) return '保留策略读取中…';
  const rec = s.reclaimable;
  if (rec?.note) return rec.note;
  return s.retention.rawDays > 0
    ? `已设保留 ${s.retention.rawDays} 天（超期原文需点下面的按钮才会清理，不会自动删）`
    : '当前为永久保留（保留天数 = 0）：保留期清理不会删除任何原文。';
}

/**
 * 最近一次清理的**如实结果**。
 *
 * 为什么不能只用 toast：toast 几秒就没了，而"到底删了几个、释放了多少、data 目录变成多大"
 * 是用户点完按钮最想知道、且过后还想再确认一次的事（尤其"其实一个都没删"这种结论）。
 */
function lastCleanupBlock() {
  const r = state.lastCleanup;
  if (!r) return null;
  const when = new Date(r.at);
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${p(when.getMonth() + 1)}-${p(when.getDate())} ${p(when.getHours())}:${p(when.getMinutes())}`;
  const before = r.dataBefore?.bytes ?? r.before?.bytes ?? 0;
  const after = r.dataAfter?.bytes ?? r.after?.total?.bytes ?? r.after?.raw?.bytes ?? 0;
  const rows = [
    ['删除文件', `${r.deletedCount} 个`, '', `孤儿 ${r.orphans} 个 · 超期 ${r.expired} 个`],
    [
      '释放空间',
      `${r.freedText}`,
      '',
      // 精确字节数必须给出来：MB 是四舍五入过的，"释放 0.0 MB"和"一个字节都没释放"是两回事
      `精确 ${Number(r.freedBytes || 0).toLocaleString('en-US')} 字节（= 被删文件大小之和，估算值不算数）`,
    ],
    ['data 目录', `${fmtBytes(before)} → ${fmtBytes(after)}`, '', '删除前 → 删除后'],
    [
      '保留 / 失败',
      `${r.kept} / ${r.failed}`,
      '',
      r.permanent
        ? '当前为永久保留，未按保留期删除任何原文'
        : `超期但因近期分析/查看被保护 ${r.protectedByRecentAnalysis || 0} 个` + (r.failed ? `；${r.failed} 个删除失败（详见服务端日志）` : ''),
    ],
  ];
  return h(
    'div',
    { class: 'mt-3' },
    h('p', { class: 'small', text: `最近一次清理（${stamp}）：${r.message}` }),
    h(
      'div',
      { class: 'storage-table mt-2' },
      ...rows.map(([label, value, extra, hint]) =>
        h(
          'div',
          { class: 'storage-row' },
          h('span', { class: 'storage-label', text: label }),
          h('span', { class: 'storage-count', text: value }),
          h('span', { class: 'storage-size', text: extra }),
          h('span', { class: 'muted small storage-hint', text: hint }),
        ),
      ),
    ),
  );
}

/** 拉一次存储占用并重绘。 */
async function loadStorage() {
  try {
    state.storage = await api.storage();
  } catch {
    state.storage = null;
  }
  paint();
}

/**
 * 执行一次清理（两种模式），结果如实汇报。
 *
 * 释放量一律用**服务端返回的精确字节数**（`freedBytes`）：
 * 曾经前端自己把字节数四舍五入成 MB 再报给用户，
 * 16384 字节就变成了「释放 0.0 MB」——用户合理地以为清理没生效。
 */
async function runCleanup(btn, payload) {
  state.cleaning = true;
  const label = btn?.textContent || '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '清理中…';
  }
  try {
    const out = await api.storageCleanup(payload);
    state.storage = out.after;
    state.lastCleanup = { ...out, at: Date.now() };
    if (out.deletedCount === 0) {
      // 一个都没删时**不能**说"清理完成"：要把原因原样带给用户
      toast(out.message || '没有需要清理的文件', out.failed ? 'error' : 'info', 12_000);
    } else {
      toast(out.message, 'success', 12_000);
    }
    if (out.failed) toast(`有 ${out.failed} 个文件删除失败，详见服务端日志`, 'error', 9000);
  } catch (err) {
    toastError(err);
  } finally {
    state.cleaning = false;
    if (btn) {
      btn.disabled = false;
      btn.textContent = label;
    }
    paint();
  }
}

/**
 * 定时任务的实时状态 + 「立即试一次」。
 *
 * 为什么要有它：定时功能最怕"以为开了其实没生效"——开关是开着的，
 * 但服务没重启、时刻写错、星期不含今天，用户只能干等。
 * 这里直接把"定时器在不在跑、上次什么时候跑的、结果如何"摆出来。
 */
function scheduleStatusLine() {
  const s = state.schedule;
  if (!s) {
    return h(
      'div',
      { class: 'muted small mt-3' },
      '正在读取定时任务状态…',
      h('button', { class: 'btn btn-small', onclick: loadScheduleStatus }, '刷新状态'),
    );
  }
  const last = s.lastRunAt
    ? `${fmtFull(new Date(s.lastRunAt))}${s.lastResult ? `（待办 ${s.lastResult.needsReply ?? '—'}、草稿 ${s.lastResult.drafts ?? '—'}）` : ''}`
    : '还没跑过';
  return h(
    'div',
    { class: 'schedule-status mt-3' },
    h(
      'p',
      { class: 'muted small' },
      s.ticking
        ? `定时器运行中：${(s.times || []).join('、') || '（未设时刻）'}　时区 ${s.timeZone}`
        : s.enabled
          ? '配置已开启，但定时器未运行——保存配置或重启服务后会启动'
          : '定时分析未开启',
    ),
    h('p', { class: 'muted small', text: `上次执行：${last}` }),
    s.lastError ? h('p', { class: 'error small', text: `上次失败：${s.lastError}` }) : null,
    h(
      'div',
      { class: 'row-actions mt-2' },
      h('button', { class: 'btn btn-small', onclick: loadScheduleStatus }, '刷新状态'),
      h(
        'button',
        {
          class: 'btn btn-small',
          disabled: state.runningSchedule,
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            state.runningSchedule = true;
            btn.disabled = true;
            btn.textContent = '执行中…';
            try {
              const out = await api.runScheduleNow();
              toast(out.error ? `执行失败：${out.error}` : '已按定时任务的方式跑完一次', out.error ? 'error' : 'success', 9000);
              await loadScheduleStatus();
              app.refreshCounts?.();
            } catch (err) {
              toastError(err);
            } finally {
              state.runningSchedule = false;
              btn.disabled = false;
              btn.textContent = '立即试一次';
            }
          },
        },
        '立即试一次',
      ),
    ),
    h('p', { class: 'muted small', text: '「立即试一次」不受设定时刻限制，用来确认邮箱与大模型都通。' }),
  );
}

/** 拉一次定时任务状态并重绘该区块。 */
async function loadScheduleStatus() {
  try {
    state.schedule = await api.scheduleStatus();
  } catch {
    state.schedule = null;
  }
  paint();
}

function field(label, control, hint) {
    // 字段变化时要让「有未保存的修改」提示出现，而该提示只在重绘时生成。
    // 只在「从干净变脏」的那一刻重绘一次，避免边输入边重绘打断输入。
    if (control && control.tagName === 'INPUT' && typeof control.oninput === 'function') {
      const existing = control.oninput;
      control.oninput = (ev) => {
        const wasClean = !hasUnsavedChanges();
        existing.call(control, ev);
        if (wasClean && hasUnsavedChanges()) paint();
      };
    }
    return h(
      'label',
      { class: 'field' },
      fieldLabel(label, hint),
      control,
      fieldHint(hint),
    );
  }

  function textInput(value, onChange, opts = {}) {
    return h('input', {
      class: 'input',
      type: 'text',
      value: value ?? '',
      placeholder: opts.placeholder || '',
      oninput: (ev) => onChange(ev.target.value),
    });
  }

  function passwordInput(value, onChange, opts = {}) {
    return h('input', {
      class: 'input',
      type: 'password',
      value: value ?? '',
      placeholder: opts.placeholder || '',
      autocomplete: 'new-password',
      oninput: (ev) => onChange(ev.target.value),
    });
  }

  function numberInput(value, onChange, opts = {}) {
    return h('input', {
      class: 'input',
      type: 'number',
      value: value ?? '',
      min: opts.min,
      max: opts.max,
      step: opts.step || 1,
      oninput: (ev) => onChange(Number(ev.target.value)),
    });
  }

  /**
   * 大模型服务商选择器。
   *
   * 设计要点：
   *   - 选择服务商会**同时写入 baseUrl 与模型名**（这两项必须配套，单改一个必然调不通）；
   *   - 只改这两个字段，**不动 API Key**（换服务商时旧 Key 显然无效，但清空它会让用户
   *     在没备份的情况下丢掉已填内容；界面用提示引导他重新填写）；
   *   - 如果当前 baseUrl 与任何预设都不匹配，就显示「自定义」并选中它，
   *     绝不因为"匹配不上"而悄悄改写用户手填的地址。
   */
  function llmProviderPicker(cfg) {
    const presets = state.llmPresets || [];
    if (!presets.length) return null;
    const match = presets.find((p) => sameBaseUrl(p.baseUrl, cfg.llm.baseUrl));
    const current = match ? match.id : 'custom';
    const active = match || null;

    const select = selectInput(
      current,
      (v) => {
        const preset = presets.find((p) => p.id === v);
        if (!preset) {
          // 选了「自定义」：保留现有值，只让用户自己去填
          state.llmProvider = 'custom';
          paint();
          return;
        }
        cfg.llm.baseUrl = preset.baseUrl;
        cfg.llm.model = preset.defaultModel || preset.models[0] || cfg.llm.model;
        state.llmProvider = preset.id;
        paint();
      },
      [
        ...presets.map((p) => [p.id, `${p.label}　·　${p.baseUrl}`]),
        ['custom', '自定义（自己填 Base URL 与模型名）'],
      ],
    );

    return h(
      'div',
      { class: 'llm-provider' },
      h('label', { class: 'field' }, h('span', { text: '服务商预设' }), select),
      active
        ? h(
            'p',
            { class: 'muted small llm-provider-note' },
            active.note,
            active.keyUrl
              ? h(
                  'a',
                  { class: 'inline-link', href: active.keyUrl, target: '_blank', rel: 'noreferrer noopener' },
                  '　→ 申请 API Key',
                )
              : null,
            active.needsKey === false ? '　（本机部署无需 Key）' : null,
          )
        : h('p', { class: 'muted small llm-provider-note' }, '当前是自定义地址；选择上面的服务商会自动填好 Base URL 与模型名。'),
    );
  }

  /** 模型名输入：既是输入框，也从当前服务商的常用模型里给候选。 */
  function modelInput(cfg) {
    const listId = 'llm-model-candidates';
    const preset = (state.llmPresets || []).find((p) => sameBaseUrl(p.baseUrl, cfg.llm.baseUrl));
    return h(
      'div',
      { class: 'model-input' },
      h('input', {
        class: 'input',
        type: 'text',
        list: preset ? listId : null,
        value: cfg.llm.model ?? '',
        placeholder: 'deepseek-chat',
        oninput: (ev) => (cfg.llm.model = ev.target.value),
      }),
      preset
        ? h(
            'datalist',
            { id: listId },
            ...preset.models.map((m) => h('option', { value: m })),
          )
        : null,
    );
  }

  /** 比较 baseUrl 时忽略协议尾斜杠与大小写，避免"看着一样却匹配不上"。 */
  function sameBaseUrl(a, b) {
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\/+$/, '');
    return norm(a) === norm(b) && norm(a) !== '';
  }

  function selectInput(value, onChange, options) {
    return h(
      'select',      { class: 'input', onchange: (ev) => onChange(ev.target.value) },
      ...options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)),
    );
  }

  function switchInput(label, checked, onChange) {
    return h(
      'label',
      { class: 'switch' },
      h('input', { type: 'checkbox', checked: !!checked, onchange: (ev) => onChange(ev.target.checked) }),
      h('span', { text: label }),
    );
  }

  /* ---------------------------------------------------------- 动作 */

  async function save({ silent = false } = {}) {
    state.saving = true;
    if (!silent) paint();
    try {
      const res = await api.saveConfig(state.config);
      state.config = res.config;
      state.savedSnapshot = JSON.stringify(state.config);
      state.activeInstance = state.config.instances.some((i) => i.id === state.activeInstance)
        ? state.activeInstance
        : state.config.instances[0]?.id;
      if (!silent) toast(res.restartHint ? `已保存。${res.restartHint}` : '配置已保存', 'success', res.restartHint ? 8000 : 3000);
      app.refreshCounts?.();
      // 配置会影响别的页面（签名横幅、引文横幅、展示时区），必须让它们重新取数
      app.invalidateAll?.();
      // 重新取状态，让「已连接/未配置」提示与磁盘一致
      try {
        state.calendarStatus = await api.calendarStatus();
      } catch {
        /* 忽略 */
      }
      return res;
    } catch (err) {
      toastError(err);
      throw err;
    } finally {
      state.saving = false;
      if (!silent) paint();
    }
  }

  /**
   * 表单里是否有未保存的改动。
   * 用快照比较而不是逐个输入框插桩——字段多、又有动态新增实例，漏插一个就会出现
   * 「改了但没保存却以为已生效」的错觉。
   */
  function hasUnsavedChanges() {
    if (!state.savedSnapshot) return false;
    try {
      return JSON.stringify(state.config) !== state.savedSnapshot;
    } catch {
      return false;
    }
  }

  async function runDiagnostics(deep) {
    state.diagnosing = true;
    paint();
    try {
      const res = await api.diagnostics(state.activeInstance || undefined, deep);
      state.diagnostics = res.result;
      toast(res.ok ? '自检通过' : '自检发现问题，请查看下方明细', res.ok ? 'success' : 'error', 6000);
    } catch (err) {
      toastError(err);
    } finally {
      state.diagnosing = false;
      paint();
    }
  }

  async function load() {
    // 已加载过就不再自动重取，避免切回页面时冲掉未保存的编辑
    if (state.fetched && state.config) {
      paint();
      return;
    }
    state.loading = !state.config;
    paint();
    try {
      const [cfgRes, metaRes] = await Promise.all([api.getConfig(), api.meta()]);
      state.config = cfgRes.config;
      // /api/meta 已经返回版本、数据目录、Node 版本，「关于」区块直接用它
      state.meta = metaRes;
      // 旧版本保存的 config.json 可能没有这些后加的字段，补上默认值，
      // 否则输入框初值会是 undefined、保存时又把它当成「没改」而漏掉
      if (state.config.calendar) state.config.calendar.proxy = state.config.calendar.proxy || '';
      state.savedSnapshot = JSON.stringify(state.config);
      state.presets = cfgRes.presets || metaRes.presets || [];
      state.llmPresets = metaRes.llmPresets || cfgRes.llmPresets || [];
      state.secretSources = cfgRes.secretSources || metaRes.secretSources || {};
      if (!state.activeInstance) state.activeInstance = state.config.defaultInstanceId;
      // 日历状态单独取，失败不影响设置页其它部分
      try {
        state.calendarStatus = await api.calendarStatus();
      } catch {
        state.calendarStatus = null;
      }
      // 定时任务状态同理：取不到也要能正常显示设置
      try {
        state.schedule = await api.scheduleStatus();
        app.notifyBrowser = state.config?.notify?.browser === true;
      } catch {
        state.schedule = null;
      }
      // 存储占用
      try {
        state.storage = await api.storage();
      } catch {
        state.storage = null;
      }
      // 密钥存储现状 + 导入前的自动备份列表
      try {
        state.secrets = await api.secrets();
      } catch {
        state.secrets = null;
      }
      // 访问与安全现状
      try {
        state.security = await api.security();
      } catch {
        state.security = null;
      }
      // 数据去向
      try {
        state.egress = await api.egress();
      } catch {
        state.egress = null;
      }
      try {
        state.safetyBackups = (await api.backups()).backups || [];
      } catch {
        state.safetyBackups = [];
      }
      state.fetched = true;
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      paint();
    }
  }

  load();
  return { reload: load };
}
