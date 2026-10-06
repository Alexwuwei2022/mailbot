/**
 * 知识库页：两个独立知识库
 *   - 邮件知识库：主题归类 + 对话式检索（可按发件人/主题/内容检索近一个月）
 *   - 日历知识库：今日/明日/近 N 天日程分析
 */

import { api } from '../api.js';
import { renderReviewCharts } from '../charts.js';
import { fmtAddress, fmtFull, h, mount, toast, toastError } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { typeTag } from '../type-meta.js';
import { markLoaded, needsReload, renderInto, viewState } from '../view-state.js';

const TABS = [
  { id: 'email', label: '邮件知识库' },
  { id: 'calendar', label: '日历知识库' },
];

const SEARCH_EXAMPLES = [
  '张总上个月发过哪些关于合同的邮件',
  '最近一周主题里有"告警"的邮件',
  '近一个月需要我回复的高优先级邮件',
  '正文提到光衰校验的邮件',
];

export function renderKnowledge(root, app) {
  const { state } = viewState(app, 'knowledge', () => ({
    tab: 'email',
    /* 邮件知识库 */
    loading: true,
    error: null,
    data: null,
    topic: null,
    question: '',
    asking: false,
    answer: null,
    answerError: null,
    /* 对话式检索 */
    searchInput: '',
    searchHistory: [],
    searching: false,
    searchResult: null,
    /* 日历知识库 */
    calLoading: false,
    calError: null,
    calData: null,
    calDays: 7,
  /** 回顾分析：输入、结果、进行中状态 */
  reviewInput: '',
  review: null,
  reviewing: false,
  reviewError: null,
  reviewExamples: null,
  }));

  const container = h('div', { class: 'view view-knowledge' });
  mount(root, container);

  const paint = () => renderInto(container, app, 'knowledge', paintInner, () => renderKnowledge(root, app));

  const paintInner = () => {
    mount(
      container,
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { text: '知识库' }),
          h('p', { class: 'muted', text: '邮件知识库用于归类与检索邮件；日历知识库用于查看与分析日程。' }),
        ),
        h(
          'div',
          { class: 'head-actions' },
          state.tab === 'email'
            ? h('button', { class: 'btn', onclick: () => loadEmail({ force: true }) }, '刷新邮件知识库')
            : h('button', { class: 'btn', onclick: () => loadCalendar({ force: true }) }, '刷新日历知识库'),
          h('button', { class: 'btn', onclick: () => app.navigate('overview') }, '返回总览'),
        ),
      ),
      h(
        'div',
        { class: 'tabs' },
        ...TABS.map((t) =>
          h(
            'button',
            {
              class: `tab ${state.tab === t.id ? 'active' : ''}`,
              onclick: () => {
                state.tab = t.id;
                paint();
                if (t.id === 'calendar') loadCalendar();
                else loadEmail();
              },
            },
            t.label,
          ),
        ),
      ),
      state.tab === 'email' ? emailKnowledge() : calendarKnowledge(),
    );
  };

  /* ============================================================ 邮件知识库 */

  function emailKnowledge() {
    if (state.loading) return h('p', { class: 'muted pad', text: '加载中…' });
    if (state.error) {
      return h(
        'div',
        { class: 'empty-state' },
        h('div', { class: 'empty-icon', text: '⚠️' }),
        h('h3', { text: '无法加载邮件知识库' }),
        h('p', { text: state.error }),
        h('button', { class: 'btn btn-primary', onclick: () => loadEmail({ force: true }) }, '重试'),
      );
    }
    const d = state.data;
    if (!d) return h('p', { class: 'muted pad', text: '暂无数据' });
    const entries = d.entries;

    return h(
      'div',
      {},
      /* --- 对话式检索 --- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '对话式检索' }),
          h('span', { class: 'muted small', text: '按发件人 / 主题 / 内容检索已分析的邮件（默认近 30 天）' }),
        ),
        h(
          'div',
          { class: 'search-panel' },
          h(
            'div',
            { class: 'ask-row' },
            h('input', {
              class: 'input',
              type: 'text',
              placeholder: '例如：张总上个月发过哪些关于合同的邮件',
              value: state.searchInput,
              oninput: (ev) => (state.searchInput = ev.target.value),
              onkeydown: (ev) => {
                if (ev.key === 'Enter') runSearch();
              },
            }),
            h(
              'button',
              { class: 'btn btn-primary', disabled: state.searching, onclick: runSearch },
              state.searching ? '检索中…' : '检索',
            ),
          ),
          h(
            'div',
            { class: 'chip-row' },
            ...SEARCH_EXAMPLES.map((q) =>
              h(
                'button',
                {
                  class: 'chip chip-btn',
                  onclick: () => {
                    state.searchInput = q;
                    paint();
                    const next = container.querySelector('.search-panel .input');
                    if (next) next.focus();
                  },
                },
                q,
              ),
            ),
          ),
          state.searchHistory.length
            ? h(
                'div',
                { class: 'search-history' },
                h('span', { class: 'muted small', text: '最近检索：' }),
                ...state.searchHistory.slice(0, 5).map((q) =>
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      onclick: () => {
                        state.searchInput = q;
                        runSearch();
                      },
                    },
                    q,
                  ),
                ),
              )
            : null,
        ),
        state.searchResult ? renderSearchResult(state.searchResult, app) : null,
      ),

      /* --- 主题分布 --- */
      h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '主题分布' })),
        d.topics.length
          ? h(
              'div',
              { class: 'chip-row' },
              h(
                'button',
                {
                  class: `chip chip-btn ${!state.topic ? 'active' : ''}`,
                  onclick: () => {
                    state.topic = null;
                    loadEmail({ force: true });
                  },
                },
                `全部 ${d.entries.length}`,
              ),
              ...d.topics.map((t) =>
                h(
                  'button',
                  {
                    class: `chip chip-btn ${state.topic === t.id ? 'active' : ''}`,
                    onclick: () => {
                      state.topic = t.id;
                      loadEmail({ force: true });
                    },
                  },
                  `${t.label} ${t.count}`,
                ),
              ),
            )
          : h('p', { class: 'muted pad', text: '尚无可归类的邮件。' }),
      ),

      h(
        'section',
        { class: 'stat-grid' },
        stat('邮件条目', d.keyFacts.total, `${d.windowHours} 小时内`),
        stat('需我处理', d.keyFacts.needsReply, '直接发我 · 高优先'),
        stat('需我关注', d.keyFacts.attention ?? 0, '抄送我 · 高优先'),
        stat('含明确截止', d.keyFacts.withDeadline, '从正文中抽取'),
      ),

      /* --- 问答 --- */
      h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '问一问（基于邮件内容回答）' })),
        h(
          'div',
          { class: 'ask-row' },
          h('input', {
            class: 'input',
            type: 'text',
            placeholder: '例如：本周有哪些需要我确认的截止时间？',
            value: state.question,
            oninput: (ev) => (state.question = ev.target.value),
            onkeydown: (ev) => {
              if (ev.key === 'Enter') askQuestion();
            },
          }),
          h('button', { class: 'btn btn-primary', disabled: state.asking, onclick: askQuestion }, state.asking ? '思考中…' : '提问'),
        ),
        state.answerError ? h('div', { class: 'alert alert-warn', text: state.answerError }) : null,
        state.answer
          ? h(
              'div',
              { class: 'answer-box' },
              h('div', { class: 'answer-text', text: state.answer.answer }),
              state.answer.insufficient ? h('p', { class: 'muted small', text: '（模型认为邮件资料不足以回答该问题）' }) : null,
              state.answer.evidence?.length
                ? h(
                    'div',
                    { class: 'evidence' },
                    h('div', { class: 'notes-title', text: '依据' }),
                    h(
                      'ul',
                      {},
                      ...state.answer.evidence.map((e) =>
                        h(
                          'li',
                          {},
                          h('b', { text: e.subject || '' }),
                          ` — ${e.from || ''}${e.date ? ` · ${fmtFull(e.date)}` : ''}`,
                          e.quote ? h('div', { class: 'muted small', text: e.quote }) : null,
                        ),
                      ),
                    ),
                  )
                : null,
            )
          : null,
      ),

      /* --- 条目 --- */
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: state.topic ? `主题邮件（${entries.length}）` : `全部邮件（${entries.length}）` }),
        ),
        entries.length
          ? h('div', { class: 'kb-list' }, ...entries.map((e) => kbRow(e, app)))
          : h('p', { class: 'muted pad', text: '没有符合条件的邮件。' }),
      ),

      d.people?.length
        ? h(
            'section',
            { class: 'block' },
            h('div', { class: 'block-head' }, h('h3', { text: `来信最多的联系人（${d.people.length}）` })),
            h(
              'div',
              { class: 'people-grid' },
              ...d.people.slice(0, 12).map((p) =>
                h(
                  'div',
                  { class: 'person' },
                  h('div', { class: 'person-name', text: p.name || p.address }),
                  h('div', { class: 'muted small', text: p.address }),
                  h('div', { class: 'muted small', text: `${p.count} 封 · 需回复 ${p.needsReply}` }),
                ),
              ),
            ),
          )
        : null,
    );
  }

  /** 检索结果：理解、统计、分析、命中列表。 */
  function renderSearchResult(result, app) {
    if (result.needMore) {
      return h('div', { class: 'search-result' }, h('div', { class: 'alert alert-warn', text: result.assistant }));
    }
    const s = result.stats || {};
    return h(
      'div',
      { class: 'search-result' },
      h(
        'div',
        { class: 'search-meta' },
        result.understood ? h('div', {}, h('b', { text: '我理解的是：' }), result.understood) : null,
        result.filters
          ? h(
              'div',
              { class: 'muted small' },
              `时间范围 ${result.filters.effectiveRange}`,
              result.filters.defaultedRange ? '（未指定，按默认近 30 天）' : '',
              `　扫描 ${s.scanned ?? 0} 封已分析邮件　命中 ${s.matched ?? 0} 封`,
              s.bodyHits ? `（其中正文检索补充 ${s.bodyHits} 封）` : '',
            )
          : null,
      ),
      result.assistant ? h('div', { class: 'markdown', html: renderMarkdown(result.assistant) }) : null,
      result.analysisError ? h('p', { class: 'muted small', text: `（分析降级为本地摘要：${result.analysisError}）` }) : null,
      result.items?.length
        ? h(
            'div',
            { class: 'kb-list' },
            ...result.items.map((it) =>
              h(
                'article',
                { class: 'kb-row' },
                h(
                  'div',
                  { class: 'kb-head' },
                  typeTag(it.type, { h }),
                  h('span', { class: `tag ${it.priority === 'urgent' ? 'p-urgent' : it.priority === 'high' ? 'p-high' : 'tag-quiet'}`, text: it.priorityLabel }),
                  h('span', { class: `tag ${it.recipientKind === 'cc' ? 'tag-cc' : 'tag-quiet'}`, text: it.recipientLabel }),
                  it.needsReply ? h('span', { class: 'tag tag-need', text: '需回复' }) : null,
                  it.notAnalyzed ? h('span', { class: 'tag tag-quiet', text: '未分析' }) : null,
                  h('span', { class: 'muted small', text: fmtFull(it.date) }),
                ),
                h('h4', { class: 'kb-subject', text: it.subject }),
                h('p', { class: 'muted small', text: fmtAddress(it.from) }),
                it.summary ? h('p', { class: 'kb-summary', text: it.summary }) : null,
                it.snippet && !it.summary ? h('p', { class: 'muted small', text: it.snippet }) : null,
                it.actions?.length ? h('ul', { class: 'action-list' }, ...it.actions.map((a) => h('li', { text: a }))) : null,
                h(
                  'div',
                  { class: 'editor-actions' },
                  h('button', { class: 'btn btn-small', onclick: () => app.showMail(it.key) }, '查看详情'),
                  it.hasDraft ? h('button', { class: 'btn btn-small', onclick: () => app.navigate('drafts') }, '查看草稿') : null,
                ),
              ),
            ),
          )
        : null,
    );
  }

  /* ============================================================ 日历回顾分析 */

  /**
   * 对话式回顾分析。
   *
   * 与「今日/明日/最近 N 天」那套**向前看**的分析并列：这套是**向后看**，
   * 回答"上个月我的时间花哪了、有没有结构性问题"。
   * 结果可导出 md（走简报的下载链路）。
   */
  function calendarReview() {
    const r = state.review;
    const examples = state.reviewExamples || [];
    const input = h('input', {
      class: 'input',
      type: 'text',
      placeholder: '例如：请详细分析过去 30 天的日历，并给出工作优化建议',
      value: state.reviewInput || '',
      oninput: (ev) => (state.reviewInput = ev.target.value),
      onkeydown: (ev) => {
        if (ev.key === 'Enter' && !state.reviewing) runReview();
      },
    });

    return h(
      'section',
      { class: 'block' },
      h(
        'div',
        { class: 'block-head' },
        h('h3', { text: '对话式回顾分析' }),
        h('span', { class: 'muted small', text: '向后看：过去 30 天 / 上个月 / 上季度 / 过去一年，可导出 Markdown' }),
      ),
      h(
        'div',
        { class: 'search-panel' },
        h(
          'div',
          { class: 'ask-row' },
          input,
          h(
            'button',
            { class: 'btn btn-primary', disabled: state.reviewing, onclick: runReview },
            state.reviewing ? '分析中…' : '分析并导出',
          ),
        ),
        examples.length
          ? h(
              'div',
              { class: 'chip-row' },
              ...examples.map((q) =>
                h(
                  'button',
                  {
                    class: 'chip chip-clickable',
                    onclick: () => {
                      state.reviewInput = q;
                      paint();
                      runReview();
                    },
                  },
                  q,
                ),
              ),
            )
          : null,
      ),

      state.reviewing
        ? h('p', { class: 'muted pad', text: '正在读取日程并分析…（过去一年数据可能需要十几秒）' })
        : null,
      state.reviewError ? h('div', { class: 'alert alert-warn block-note' }, state.reviewError) : null,
      r ? reviewResult(r) : null,
    );
  }

  /**
   * 图表区。
   *
   * 图是从**接口已返回的结构化数据**直接画的，而不是塞进 markdown——
   * 我们自己的 markdown 渲染器不支持代码块与表格，把图写进 md 在应用内根本显示不出来。
   * 导出文件那边另有一套 Unicode 条形图（见服务端 review-run.js），两边各司其职。
   */
  function chartsBlock(r) {
    try {
      const box = renderReviewCharts(r);
      if (!box) return null;
      return h(
        'div',
        {},
        h('div', { class: 'block-head flush-head' }, h('h3', { text: '图表' })),
        box,
      );
    } catch (err) {
      // 图表只是锦上添花，画不出来也不能让整页崩掉
      console.warn('图表渲染失败', err);
      return null;
    }
  }

  function reviewResult(r) {
    const t = r.totals || {};
    const s = r.structure || {};
    const u = r.understood || {};
    const src = r.source || {};
    return h(
      'div',
      { class: 'review-result' },
      h(
        'div',
        { class: 'alert alert-info block-note' },
        h('b', { text: `理解到的区间：` }),
        `${u.rangeLabel || r.range?.label}（${r.range?.from} ~ ${r.range?.to}，${r.range?.days} 天）`,
        u.focus?.length ? `　关注：${u.focus.join('、')}` : null,
        h('br'),
        `口径：日历条目 ${src.totalEntries} 条 → 占用时间 ${src.occupied ?? src.counted} 条，未计入占用 ${src.excluded} 条`,
        src.excluded ? `（${r.excludedNote}）` : null,
        h(
          'div',
          { class: 'muted small' },
          `两个视角：总占用 = 工作 + 生活；工作负荷 = 会议 + 独自工作 + 专注（不含生活）` +
            (src.oooDays ? `　休假/外出 ${src.oooDays} 天` : ''),
        ),
        src.meetingsByTitle
          ? h('div', { class: 'muted small' }, `说明：其中 ${src.meetingsByTitle} 场会议按标题识别（该日历用标题记录与会对象）`)
          : null,
        r.fetch?.truncated
          ? h('div', { class: 'muted small' }, `⚠️ 日程数超过单次上限 ${r.fetch.maxTotal} 条，本次只分析了前 ${r.fetch.fetched} 条`)
          : null,
      ),
      h(
        'div',
        { class: 'stat-grid stat-grid-tight' },
        stat('总占用', `${t.busyHours ?? 0}h`, `占工作表时段 ${t.occupancyRatio ?? 0}%`),
        stat('工作负荷', `${t.workBusyHours ?? t.workloadHours ?? 0}h`, `占 ${t.workloadLoadRatio ?? 0}%`),
        stat('生活/个人事务', `${t.lifeHours ?? 0}h`, `${t.lifeEntryCount ?? 0} 项 · 占总占用 ${t.lifeShareOfBusy ?? 0}%`),
        stat('会议', `${t.meetingCount ?? 0} 场`, `${t.meetingHours ?? 0} 小时`),
        stat('独自工作', `${t.workBlockCount ?? 0} 段`, `${t.workHours ?? 0} 小时`),
        stat('每工作日', `${t.busyHoursPerWorkday ?? 0}h`, `${t.meetingsPerWorkday ?? 0} 场会`),
        stat(
          '晚间 / 周末占用',
          `${s.eveningMeetings != null ? s.eveningMeetings + (s.eveningWork || 0) + (s.eveningLife || 0) : 0} / ${s.weekendMeetings != null ? s.weekendMeetings + (s.weekendWork || 0) + (s.weekendLife || 0) : 0}`,
          '含生活安排',
        ),
        stat('整块可用时间', `${s.deepBlockCount ?? 0} 段`, `合计 ${s.deepBlockHours ?? 0} 小时`),
      ),
      r.analysis
        ? h(
            'div',
            {},
            h(
              'div',
              { class: 'block-head flush-head' },
              h('h3', { text: '分析结果' }),
              h(
                'div',
                { class: 'head-actions' },
                r.reportId
                  ? h(
                      'a',
                      {
                        class: 'btn btn-small',
                        href: `/api/reports/${encodeURIComponent(r.reportId)}?format=raw`,
                        download: `日程回顾-${r.range?.from || ''}_${r.range?.to || ''}.md`,
                      },
                      '下载 Markdown',
                    )
                  : null,
                h('span', { class: 'muted small', text: `耗时 ${Math.round((r.elapsedMs || 0) / 1000)}s` }),
              ),
            ),
            h('div', { class: 'markdown analysis-md', html: renderMarkdown(r.analysis) }),
          )
        : null,
      // 图表放在叙述之后：先把结论读明白，再让图去支撑它
      chartsBlock(r),
      r.analysisError ? h('p', { class: 'muted small pad', text: `（AI 叙述降级为本地统计：${r.analysisError}）` }) : null,
      h(
        'p',
        { class: 'muted small pad' },
        '导出的 Markdown 含：分析叙述 + 统计附录（口径/总览/按周/参与人/问题清单）+ 完整日程清单，可离线核对每个数字。',
      ),
    );
  }

  /* ============================================================ 日历知识库 */

  function calendarKnowledge() {
    const review = calendarReview();
    if (state.calLoading) return h('div', {}, review, h('p', { class: 'muted pad', text: '正在获取日程…' }));
    if (state.calError) {
      return h(
        'div',
        {},
        review,
        h(
          'div',
          { class: 'empty-state' },
          h('div', { class: 'empty-icon', text: '📅' }),
          h('h3', { text: '无法加载日历知识库' }),
          h('p', { text: state.calError }),
          h('button', { class: 'btn btn-primary', onclick: () => loadCalendar({ force: true }) }, '重试'),
        ),
      );
    }
    const d = state.calData;
    if (!d) {
      return h(
        'div',
        {},
        review,
        h(
          'div',
          { class: 'empty-state' },
          h('div', { class: 'empty-icon', text: '📅' }),
          h('h3', { text: '还没有日历数据' }),
          h('p', { class: 'muted', text: '点上面的按钮获取今日 / 明日 / 最近 N 天的日程分析。' }),
          h('button', { class: 'btn btn-primary', onclick: () => loadCalendar({ force: true }) }, '获取日历数据'),
        ),
      );
    }
    const k = d.knowledge || {};
    return h(
      'div',
      {},
      review,
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: `日程知识库　${d.timeZone}` }),
          h(
            'select',
            {
              class: 'input select-small',
              onchange: (e) => {
                state.calDays = Number(e.target.value);
                loadCalendar({ force: true });
              },
            },
            ...[7, 3, 14, 30].map((n) => h('option', { value: n, selected: n === state.calDays }, `最近 ${n} 天`)),
          ),
        ),
        h(
          'div',
          { class: 'stat-grid stat-grid-tight' },
          stat('日程总数', k.totalEvents ?? 0, `最近 ${d.windowDays} 天`),
          stat('会议', k.meetings ?? 0, '非全天'),
          stat('全天事项', k.allDay ?? 0, '出差/假期等'),
          stat('参与人', k.participants ?? 0, '去重'),
          stat('由邮件生成', k.fromEmails ?? 0, '带来源标记'),
        ),
        d.analysis ? h('div', { class: 'markdown analysis-md', html: renderMarkdown(d.analysis) }) : null,
        d.analysisError ? h('p', { class: 'muted small', text: `（分析降级为本地摘要：${d.analysisError}）` }) : null,
        d.conflicts?.length
          ? h(
              'div',
              { class: 'alert alert-warn block-note' },
              `检测到 ${d.conflicts.length} 组时间重叠：${d.conflicts.map((c) => `「${c.a}」↔「${c.b}」`).join('，')}`,
            )
          : null,
        h(
          'div',
          { class: 'head-actions block-body' },
          h('button', { class: 'btn btn-small', onclick: () => app.navigate('calendar') }, '打开日历页（对话建日程）'),
        ),
      ),

      k.topics?.length
        ? h(
            'section',
            { class: 'block' },
            h('div', { class: 'block-head' }, h('h3', { text: '日程主题分布' })),
            h(
              'div',
              { class: 'chip-row' },
              ...k.topics.map((t) => h('span', { class: 'chip' }, h('b', { text: String(t.count) }), ` ${t.topic}`)),
            ),
          )
        : null,

      h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '按天明细' })),
        h(
          'div',
          { class: 'day-list' },
          ...d.days.map((day) =>
            h(
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
                          e.mailbotRef ? h('span', { class: 'tag tag-cc', text: '来自邮件' }) : null,
                        ),
                      ),
                    ),
                  )
                : h('p', { class: 'muted small', text: '没有安排' }),
            ),
          ),
        ),
      ),
    );
  }

  /* ============================================================ 数据 */

  async function loadEmail({ force = false } = {}) {
    // 别处跑过分析 / 改过配置时会递增数据版本，这时即使已有数据也要重取
    if (!force && state.data && !needsReload(app, 'knowledge')) {
      paint();
      return;
    }
    state.loading = !state.data;
    paint();
    try {
      state.data = await api.knowledge(state.topic ? { topic: state.topic } : {});
      state.error = null;
      markLoaded(app, 'knowledge');
    } catch (err) {
      state.error = err.message;
    } finally {
      state.loading = false;
      paint();
    }
  }

  /**
   * 跑一次日历回顾分析。
   *
   * 与邮件侧的对话检索一样：模型只解析意图，统计由服务端算，
   * 所以同一句话任何时候问，数字都是一样的。
   */
  async function runReview() {
    const q = String(state.reviewInput || '').trim();
    if (!q) return toast('请先输入要回顾的内容，例如「请详细分析过去 30 天的日历」', 'error');
    if (state.reviewing) return;
    state.reviewing = true;
    state.reviewError = null;
    paint();
    try {
      state.review = await api.calendarReview({ query: q });
    } catch (err) {
      state.reviewError = err.message;
      state.review = null;
    } finally {
      state.reviewing = false;
      paint();
    }
  }

  async function loadCalendar({ force = false } = {}) {
    if (!force && state.calData) {
      paint();
      return;
    }
    state.calLoading = !state.calData;
    paint();
    try {
      state.calData = await api.calendarKnowledge({ days: state.calDays });
      state.calError = null;
    } catch (err) {
      state.calError = err.message;
    } finally {
      state.calLoading = false;
      paint();
    }
    // 回顾分析的示例文案由服务端下发，避免两处各写一份
    if (!state.reviewExamples) {
      try {
        const res = await api.calendarReviewPresets();
        state.reviewExamples = res.examples || [];
      } catch {
        state.reviewExamples = [];
      }
      paint();
    }
  }

  async function runSearch() {
    const q = state.searchInput.trim();
    if (!q) return toast('请先输入要检索的内容', 'error');
    if (state.searching) return;
    state.searching = true;
    paint();
    try {
      const out = await api.searchEmails({ query: q });
      state.searchResult = out;
      state.searchHistory = [q, ...state.searchHistory.filter((x) => x !== q)].slice(0, 8);
    } catch (err) {
      toastError(err);
    } finally {
      state.searching = false;
      paint();
    }
  }

  async function askQuestion() {
    const q = state.question.trim();
    if (!q) return toast('请先输入问题', 'error');
    state.asking = true;
    state.answerError = null;
    paint();
    try {
      state.answer = await api.ask({ question: q, topic: state.topic || undefined });
    } catch (err) {
      state.answerError = err.message;
      state.answer = null;
    } finally {
      state.asking = false;
      paint();
    }
  }

  function kbRow(e, app) {
    return h(
      'article',
      { class: 'kb-row' },
      h(
        'div',
        { class: 'kb-head' },
        typeTag(e.type, { h }),
        h(
          'span',
          { class: `tag ${e.priority === 'urgent' ? 'p-urgent' : e.priority === 'high' ? 'p-high' : 'tag-quiet'}`, text: e.priorityLabel },
        ),
        e.isCcAttention ? h('span', { class: 'tag tag-cc', text: '需关注' }) : null,
        e.needsReply ? h('span', { class: 'tag tag-need', text: '需回复' }) : null,
        e.hasAttachments ? h('span', { class: 'tag tag-quiet', text: '有附件' }) : null,
        h('span', { class: 'muted small', text: fmtFull(e.date) }),
      ),
      h('h4', { class: 'kb-subject', text: e.subject }),
      h('p', { class: 'muted small', text: fmtAddress(e.from) }),
      e.summary ? h('p', { class: 'kb-summary', text: e.summary }) : null,
      e.actions?.length ? h('ul', { class: 'action-list' }, ...e.actions.map((a) => h('li', { text: a }))) : null,
      e.deadlines?.length ? h('div', { class: 'muted small' }, '时间线索：', h('span', { class: 'deadline-tag', text: e.deadlines.join(' / ') })) : null,
      e.attachments?.length
        ? h('div', { class: 'muted small', text: `附件：${e.attachments.map((f) => f.filename || f.contentType).join('、')}` })
        : null,
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

  loadEmail();
  return { reload: () => (state.tab === 'email' ? loadEmail({ force: true }) : loadCalendar({ force: true })) };
}
