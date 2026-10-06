/** 设置页：邮箱实例（服务器/端口/账号/授权码独立配置）、行为策略、大模型、自检。 */

import { api, getToken, setToken } from '../api.js';
import { confirmDialog, fmtFull, h, mount, toast, toastError } from '../dom.js';
import { renderInto, viewState } from '../view-state.js';

const STATUS_ICON = { ok: '✅', warn: '⚠️', error: '❌', skipped: '➖', running: '⏳' };

export function renderSettings(root, app) {
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
    /** 定时任务状态（定时器在不在跑、上次结果） */
    schedule: null,
    runningSchedule: false,
    /** 存储占用（原文/孤儿/简报/台账/状态） */
    storage: null,
    cleaning: false,
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

  const paint = () => renderInto(container, app, 'settings', paintInner, () => renderSettings(root, app));

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
              class: 'link-btn',
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

      /* ---------------- 服务与安全 ---------------- */
      h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '服务与访问控制' })),
        h(
          'div',
          { class: 'form-grid' },
          field('监听地址', textInput(cfg.web.host, (v) => (cfg.web.host = v)), '默认 127.0.0.1，仅本机可访问'),
          field('端口', numberInput(cfg.web.port, (v) => (cfg.web.port = v), { min: 1, max: 65535 }), '修改后需重启服务'),
          field(
            '访问令牌',
            passwordInput(cfg.web.authToken, (v) => (cfg.web.authToken = v), { placeholder: '留空表示不校验' }),
            '填写后，浏览器需一致才可访问 API',
          ),
        ),
        h(
          'label',
          { class: 'field' },
          h('span', { text: '浏览器本地令牌（保存在 localStorage）' }),
          h('input', {
            class: 'input',
            type: 'text',
            value: state.token,
            placeholder: '与上面的访问令牌一致',
            oninput: (ev) => {
              state.token = ev.target.value;
              setToken(ev.target.value.trim());
            },
          }),
        ),
        h(
          'div',
          { class: 'danger-zone' },
          h('div', {}, h('b', { text: '重置本地分析数据' }), h('p', { class: 'muted small', text: '删除 data/state.json 里的分析与草稿记录（原文件会备份），不影响邮箱里的邮件。' })),
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
                  await fetch('/api/state/reset', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', 'x-mailbot-token': getToken() },
                    body: JSON.stringify({ confirm: true }),
                  }).then((r) => r.json());
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
                  const days = Number(cfg.retention?.rawDays) || 0;
                  if (days <= 0) {
                    toast('请先把「归档原文保留天数」设为大于 0 的值并保存（0 表示永久保留）。', 'info', 8000);
                    return;
                  }
                  const ok = await confirmDialog({
                    title: `删除 ${days} 天前的邮件原文？`,
                    message: h(
                      'div',
                      {},
                      h('p', { text: `将删除超过 ${days} 天的原文归档（含附件）。` }),
                      h('p', { class: 'muted small', text: '结论（摘要/待办/统计/简报/台账）不受影响；但邮件已被删除或超出服务器保留期时，原文与附件将彻底查不到。' }),
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
            class: 'btn',
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

  /** 存储占用明细表（原文 / 孤儿 / 简报 / 台账 / 状态）。 */
function storageTable() {
  const s = state.storage;
  if (!s) {
    return h('p', { class: 'muted small' }, '正在读取存储占用…');
  }
  const mb = (b) => `${(Number(b || 0) / 1024 / 1024).toFixed(1)} MB`;
  const rows = [
    ['归档原文', `${s.raw.count} 个`, mb(s.raw.bytes), '整封邮件原文（含附件）'],
    ['其中孤儿', `${s.orphan.count} 个`, mb(s.orphan.bytes), s.orphan.count ? '没有任何分析记录指向，可安全清理' : '没有孤儿文件 ✅'],
    ['简报文件', `${s.reports.count} 个`, mb(s.reports.bytes), 'AI 简报 markdown'],
    ['操作台账', `${s.audit.count} 个`, mb(s.audit.bytes), '永久保留'],
    ['状态文件', `${s.state.count} 个`, mb(s.state.bytes), `${s.analyses} 条分析 · ${s.drafts} 条草稿（上限 ${s.retention.maxAnalyses}）`],
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
    h(
      'p',
      { class: 'muted small mt-2' },
      s.retention.rawDays > 0
        ? `已设保留 ${s.retention.rawDays} 天（超期原文需点下面的按钮才会清理，不会自动删）`
        : '原文当前为永久保留；磁盘持续增长时，可设一个保留天数后手动清理。',
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

/** 执行一次清理（两种模式），结果如实汇报。 */
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
    const freed = `${(Number(out.bytes || 0) / 1024 / 1024).toFixed(1)} MB`;
    if (out.orphans + out.expired === 0) {
      toast('没有需要清理的文件', 'info');
    } else {
      toast(`${out.message}（孤儿 ${out.orphans} 个、超期 ${out.expired} 个，释放 ${freed}）`, 'success', 9000);
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
      h('span', { text: label }),
      control,
      hint ? h('span', { class: 'muted small', text: hint }) : null,
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
