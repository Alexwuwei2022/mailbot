/**
 * 「运行与记录」页。
 *
 * 两件事放在一起，因为它们回答同一个问题——**"之前到底发生了什么"**：
 *   1. **操作记录**：改了外部系统（Google 日历 / 邮箱）的写操作台账，
 *      追加在 `data/audit.jsonl`、永久保留；
 *   2. **分析运行历史**：每次「分析邮件」拉了多少、分析多少、起草多少、成功与否
 *      （这份数据一直存在 `state.json` 的 runs 里、接口也有，只是以前没有界面）。
 *
 * 为什么要有它：控制台日志关窗即失，而"建了哪条日程、发了哪封邮件"必须事后查得到。
 * 审计记录**含具体标题与主题**（用户要求可查性优先），文档里已写明这点。
 */

import { api } from '../api.js';
import { fmtFull, h, mount, toast, toastError } from '../dom.js';
import { markLoaded, needsReload, renderInto, viewState } from '../view-state.js';

const GROUPS = ['邮件', '日历'];

function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : fmtFull(d);
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

export function renderRecords(root, app) {
  const { state } = viewState(app, 'records', () => ({
    audit: null,
    runs: null,
    loading: true,
    error: null,
    backfilling: false,
    filters: { group: '', action: '', q: '', onlyFailed: false },
  }));

  const container = h('div', { class: 'view view-records' });
  mount(root, container);
  const paint = () => renderInto(container, app, 'records', paintInner, () => renderRecords(root, app));

  function paintInner() {
    mount(container, view());
  }

  /* ------------------------------------------------------------ 视图 */

  function view() {
    if (state.error) {
      return h(
        'div',
        { class: 'empty-state' },
        h('div', { class: 'empty-icon', text: '🧾' }),
        h('h3', { text: '无法加载记录' }),
        h('p', { text: state.error }),
        h('button', { class: 'btn btn-primary', onclick: () => loadRecords({ force: true }) }, '重试'),
      );
    }
    if (state.loading && !state.audit) return h('p', { class: 'muted pad', text: '加载中…' });
    return h('div', {}, auditPanel(), runsPanel());
  }

  /* ---------------------------------------------------- 操作记录 */

  function auditPanel() {
    const data = state.audit || {};
    const stats = data.stats || {};
    const items = data.items || [];
    const f = state.filters;
    const actions = data.actions || {};
    const hasRecords = (stats.total ?? 0) > 0;

    const actionOptions = Object.entries(actions)
      .filter(([, meta]) => !f.group || meta.group === f.group)
      .map(([id, meta]) => ({ value: id, label: meta.label }));

    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: '操作记录' }),
        h(
          'div',
          { class: 'head-actions' },
          h('button', { class: 'btn btn-small nowrap', onclick: () => loadRecords({ force: true }) }, '刷新'),
          h(
            'button',
            {
              class: 'btn btn-small nowrap',
              disabled: state.backfilling,
              onclick: backfill,
            },
            state.backfilling ? '补录中…' : '补录历史',
          ),
          /*
           * 没有记录时**禁用**下载：否则会下载到一个 0 字节空文件，
           * 打开一看是空的，只会以为"功能坏了"（用户实测踩到过）。
           */
          hasRecords
            ? h('a', { class: 'btn btn-small nowrap', href: '/api/audit/download', download: 'audit.jsonl' }, '下载 JSONL')
            : h('button', { class: 'btn btn-small nowrap', disabled: true, title: '还没有记录可下载' }, '下载 JSONL'),
        ),
      ),

      h(
        'div',
        { class: 'stat-grid stat-grid-tight' },
        stat('记录总数', stats.total ?? 0, '永久保留'),
        stat('邮件操作', stats.byGroup?.邮件 ?? 0, '发送 / 同步 / 删除'),
        stat('日历操作', stats.byGroup?.日历 ?? 0, '创建 / 删除日程'),
        stat('最近一次', stats.lastAt ? fmtTime(stats.lastAt) : '—', '按配置时区显示'),
      ),

      h(
        'div',
        { class: 'search-panel' },
        h(
          'div',
          { class: 'ask-row' },
          selectInput(
            [{ value: '', label: '全部类别' }, ...GROUPS.map((g) => ({ value: g, label: g }))],
            f.group,
            (v) => {
              f.group = v;
              f.action = '';
              paint();
              // 筛选条件变了必须**强制重取**，否则会被"已加载过"的缓存挡掉
              loadRecords({ force: true });
            },
          ),
          selectInput([{ value: '', label: '全部动作' }, ...actionOptions], f.action, (v) => {
            f.action = v;
            paint();
            loadRecords({ force: true });
          }),
          h('input', {
            class: 'input',
            type: 'text',
            placeholder: '搜索标题 / 主题 / 收件人',
            value: f.q,
            oninput: (e) => {
              f.q = e.target.value;
            },
            onkeydown: (e) => {
              if (e.key === 'Enter') loadRecords({ force: true });
            },
          }),
          h('button', { class: 'btn', onclick: () => loadRecords({ force: true }) }, '筛选'),
          h(
            'label',
            { class: 'form-check' },
            h('input', {
              type: 'checkbox',
              checked: f.onlyFailed,
              onchange: (e) => {
                f.onlyFailed = e.target.checked;
                paint();
                loadRecords({ force: true });
              },
            }),
            '只看失败',
          ),
        ),
      ),

      !items.length
        ? h(
            'div',
            { class: 'pad' },
            h('p', { class: 'muted', text: '还没有操作记录。' }),
            h(
              'p',
              { class: 'muted small mt-2' },
              '台账是本功能上线后才开始记的——在此之前创建过的日程不会自动出现在这里。' +
                '可以点上面的「补录历史」：程序会去 Google 日历里找出由本程序创建的日程（它们带有来源标记）补回来。',
            ),
          )
        : h(
            'div',
            { class: 'audit-list' },
            ...items.map(auditRow),
          ),

      data.truncated
        ? h('p', { class: 'muted small pad', text: `命中 ${data.total} 条，这里只显示最近 ${items.length} 条；完整记录请点「下载 JSONL」。` })
        : null,
      data.file ? h('p', { class: 'muted small pad' }, `台账文件：${data.file}（JSONL，一行一条，可直接备份或用 Excel 打开）`) : null,
    );
  }

  function auditRow(r) {
    const extra = r.extra || {};
    const bits = [
      r.source || null,
      extra.to ? `收件人：${extra.to}` : null,
      extra.start ? `时间：${extra.start}` : null,
      extra.attachments?.length ? `附件 ${extra.attachments.length} 个` : null,
      extra.mailSubject ? `来源邮件：${extra.mailSubject}` : null,
      extra.mailFrom ? `发件人：${extra.mailFrom}` : null,
      extra.edited ? '写入前改过内容' : null,
      extra.folder ? `文件夹：${extra.folder}` : null,
    ].filter(Boolean);

    return h(
      'div',
      { class: `audit-row ${r.ok ? '' : 'audit-failed'}` },
      h('span', { class: `tag ${r.ok ? 'tag-ok' : 'tag-need'}` }, r.ok ? r.label : `${r.label}·失败`),
      h(
        'div',
        { class: 'audit-main' },
        h('div', { class: 'audit-target', text: r.target || '(无标题)' }),
        bits.length ? h('div', { class: 'muted small', text: bits.join('　·　') }) : null,
        r.error ? h('div', { class: 'audit-error', text: r.error }) : null,
      ),
      h('span', { class: 'muted small nowrap', text: fmtTime(r.at) }),
    );
  }

  function selectInput(options, value, onchange) {
    return h(
      'select',
      { class: 'input select-small', onchange: (e) => onchange(e.target.value) },
      ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
    );
  }

  /* ---------------------------------------------------- 运行历史 */

  function runsPanel() {
    const runs = state.runs || [];
    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: '分析运行历史' }),
        h('span', { class: 'muted small', text: '最近 30 次' }),
      ),
      !runs.length
        ? h('p', { class: 'muted pad', text: '还没有分析记录。' })
        : h(
            'div',
            { class: 'run-list' },
            h(
              'div',
              { class: 'run-row run-row-head' },
              h('span', { text: '开始时间' }),
              h('span', { text: '拉取' }),
              h('span', { text: '分析' }),
              h('span', { text: '需回复' }),
              h('span', { text: '草稿' }),
              h('span', { text: '结果' }),
            ),
            ...runs.map((r) =>
              h(
                'div',
                { class: `run-row ${r.status === 'success' ? '' : 'run-row-bad'}` },
                h('span', { class: 'muted small', text: fmtTime(r.startedAt) }),
                h('span', { text: String(r.counts?.fetched ?? '—') }),
                h('span', { text: String(r.counts?.analyzed ?? '—') }),
                h('span', { text: String(r.counts?.needsReply ?? '—') }),
                h('span', { text: String(r.counts?.drafts ?? '—') }),
                h('span', { class: 'run-status', text: runStatusText(r) }),
              ),
            ),
          ),
    );
  }

  function runStatusText(r) {
    if (r.status === 'success') {
      const secs = Math.max(0, Math.round((new Date(r.finishedAt || r.startedAt) - new Date(r.startedAt)) / 1000));
      return `成功 · 耗时 ${secs}s`;
    }
    if (r.status === 'cancelled') return '已取消';
    if (r.status === 'failed') return `失败：${r.error || '未知原因'}`;
    return r.status || '—';
  }

  /* ---------------------------------------------------- 数据 */

  /**
   * 从 Google 日历补录历史台账。
   *
   * 只读 Google + 只追加本地文件，不会新建/改动任何日程；
   * 已补过的按日程 id 去重，可以放心重复点。
   *
   * 用户实测过"点了没反应、几分钟不返回"：那时是**先查 Google 再补本地**，
   * 网络不通就把整件事拖死。现在服务端先补本地（瞬时完成）、Google 那一步限时 20 秒，
   * 前端再加 40 秒兜底超时——任何情况下都会给出一句明确结果，不会无限转圈。
   */
  async function backfill() {
    if (state.backfilling) return;
    state.backfilling = true;
    paint();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 40_000);
    try {
      const out = await api.auditBackfill({ signal: controller.signal });
      const cal = out.calendar || {};
      const parts = [];
      if (out.fromChat) parts.push(`从本地会话记录补录 ${out.fromChat} 条`);
      if (out.fromCalendar) parts.push(`从 Google 日历补录 ${out.fromCalendar} 条`);
      if (out.chatSkipped + (cal.skipped || 0)) parts.push(`已有记录跳过 ${out.chatSkipped + (cal.skipped || 0)} 条`);
      if (!parts.length) parts.push('没有需要补录的记录（都已在台账里）');
      if (cal.error) {
        // Google 这一路失败不影响本地那部分：如实说明，但不要报成整体失败
        toast(`${parts.join('，')}。Google 日历这一路未成功：${cal.error}`, 'warn', 12_000);
      } else {
        if (cal.truncated) parts.push('（日程数超出单次上限，可能未扫全）');
        toast(parts.join('，'), out.added > 0 ? 'success' : 'info');
      }
    } catch (err) {
      if (err?.name === 'AbortError') {
        toast('补录超时（>40 秒）。本地记录通常瞬时完成，多半是访问 Google 的网络不通——可以先完成本地补录，稍后再试。', 'warn', 12_000);
      } else {
        toastError(err);
      }
    } finally {
      clearTimeout(timer);
      state.backfilling = false;
      await loadRecords({ force: true });
    }
  }

  async function loadRecords({ force = false } = {}) {
    if (!force && state.audit && !needsReload(app, 'records')) {
      paint();
      return;
    }
    state.loading = !state.audit;
    paint();
    const f = state.filters;
    try {
      const [audit, runs] = await Promise.all([
        api.audit({
          group: f.group || undefined,
          action: f.action || undefined,
          q: f.q || undefined,
          ok: f.onlyFailed ? '0' : undefined,
          limit: 200,
        }),
        api.runs(),
      ]);
      state.audit = audit;
      state.runs = runs.runs || [];
      state.error = null;
      markLoaded(app, 'records');
    } catch (err) {
      state.error = err.message;
      toastError(err);
    } finally {
      state.loading = false;
      paint();
    }
  }

  paint();
  loadRecords();
}
