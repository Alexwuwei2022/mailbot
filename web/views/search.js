/**
 * 对话查邮件：用自然语言描述要找什么，数字人识别意图后查询相关邮件并分析。
 *
 * 支持按发件人 / 主题 / 正文内容 / 类型 / 优先级 / 时间范围检索，
 * 默认回看近 30 天，最长一年。筛选由服务端程序执行，模型只负责理解与总结。
 *
 * 「结论范围」下拉决定结论（模型分析）看命中里的哪 40 封：带摘录上限恒为 40 封，
 * 换策略只换视野（最近一批 / 每月都有代表 / 全范围等间隔），不会放大模型额度。
 */

import { api } from '../api.js';
import { copyButton, fmtAddress, fmtFull, h, mount, toast, toastError } from '../dom.js';
import { renderMarkdown } from '../markdown.js';
import { typeTag } from '../type-meta.js';
import { renderInto, viewState } from '../view-state.js';

const EXAMPLES = [
  '张总上个月发过哪些关于合同的邮件',
  '最近一周主题里有"告警"的邮件',
  '近一个月需要我处理的高优先级邮件',
  '正文提到光衰校验的邮件',
  '这个月抄送给我的重要邮件',
];

/*
 * 「结论范围」：决定把命中里的**哪** 40 封交给模型写结论。
 *
 * 三种策略的带摘录上限**都是 40 封**（额度闸门，与服务端 ANALYSIS_BASIS_LIMIT 一致），
 * 策略只决定「哪 40 封」——所以换策略不会多花模型额度，改变的只是结论的视野。
 * 因此每一项都必须把代价写出来（与 server/ai/search.js 的 BASIS_STRATEGIES 同一口径）：
 * 用户是在「看得细」和「看得全」之间做取舍，不写清代价就等于诱导他选错。
 */
const BASIS_OPTIONS = [
  {
    id: 'recent',
    name: '最近 40 封（默认）',
    short: '看得最细',
    cost: '看得最细：连续的最新一批，每封都有摘录。代价是范围较宽时（例如「7 月份以来」）早期邮件进不了结论。',
  },
  {
    id: 'monthly',
    name: '按月节选（每月最多 8 封）',
    short: '覆盖整段时间',
    cost: '覆盖整段时间：每个自然月都有代表，范围再宽也不会丢掉早期月份。代价是每个月的细节看得少。',
  },
  {
    id: 'even',
    name: '均衡采样（全范围等间隔）',
    short: '视野最匀',
    cost: '在全范围内等间隔取样（含最早与最新各一封），比按月节选更均匀。代价是会跳过中间月份的大部分邮件。',
  },
];

/*
 * 「命中的邮件」列表最多渲染多少条。
 *
 * 服务端默认最多返回 1000 条，一次性铺 1000 个 DOM 行会让页面卡住。
 * 因此这里再收一层：先渲染前 200 条，并**明确告诉用户还剩多少条**（可用「显示更多」继续）。
 * 与服务端一样的原则：可以少渲染，但绝不静默少给。
 */
const RENDER_STEP = 200;

export function renderSearch(root, app) {
  const { state } = viewState(app, 'search', () => ({
    input: '',
    history: [],
    searching: false,
    result: null,
    /** 「结论范围」策略：recent（默认）/ monthly / even */
    basis: 'recent',
    /** 检索结果里展开详情的条目 key */
    expanded: null,
    /** 命中列表当前渲染了多少条 */
    shown: RENDER_STEP,
  }));

  const container = h('div', { class: 'view view-search' });
  mount(root, container);

  const paint = () => renderInto(container, app, 'search', paintInner, () => renderSearch(root, app));

  const paintInner = () => {
    const input = h('input', {
      class: 'input search-main-input',
      type: 'text',
      placeholder: '例如：张总上个月发过哪些关于合同的邮件',
      value: state.input,
      oninput: (ev) => (state.input = ev.target.value),
      onkeydown: (ev) => {
        if (ev.key === 'Enter') run();
      },
    });

    mount(
      container,
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { text: '对话查邮件' }),
          h('p', { class: 'muted', text: '不只最近 24 小时——按你的描述查询相关邮件并分析。' }),
        ),
        h(
          'div',
          { class: 'head-actions' },
          state.result ? h('button', { class: 'btn', onclick: () => run() }, state.searching ? '检索中…' : '重新检索') : null,
          h('button', { class: 'btn', onclick: () => app.navigate('overview') }, '邮件总览'),
        ),
      ),
      h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '用一句话描述你要找的邮件' })),
        h(
          'div',
          { class: 'search-panel' },
          h(
            'div',
            // 布局由共用的 .search-panel .ask-row 提供（知识库的检索面板用的是同一条规则）
            { class: 'ask-row' },
            input,
            h('button', { class: 'btn btn-primary', disabled: state.searching, onclick: run }, state.searching ? '检索中…' : '检索并分析'),
          ),
          h('p', { class: 'muted small', text: '支持：发件人 / 主题 / 正文内容 / 类型 / 优先级 / 时间范围。默认回看近 30 天，最长一年。' }),
          basisControl(),
          h(
            'div',
            { class: 'chip-row' },
            ...EXAMPLES.map((q) =>
              h(
                'button',
                {
                  class: 'chip chip-btn',
                  onclick: () => {
                    state.input = q;
                    paint();
                    const next = container.querySelector('.search-main-input');
                    if (next) next.focus();
                  },
                },
                q,
              ),
            ),
          ),
          state.history.length
            ? h(
                'div',
                { class: 'search-history' },
                h('span', { class: 'muted small', text: '最近检索：' }),
                ...state.history.slice(0, 6).map((q) =>
                  h(
                    'button',
                    {
                      class: 'link-btn',
                      onclick: () => {
                        state.input = q;
                        run();
                      },
                    },
                    q,
                  ),
                ),
              )
            : null,
        ),
      ),
      state.searching && !state.result
        ? h(
            'section',
            { class: 'block' },
            h(
              'div',
              { class: 'search-progress' },
              h('div', { class: 'spinner' }),
              h(
                'div',
                {},
                h('div', { text: '正在解析你的要求并检索…' }),
                h('div', { class: 'muted small', text: '若本地未覆盖该时间范围，会按需到邮箱拉取并分析这批邮件，可能需要一会儿。' }),
              ),
            ),
          )
        : null,
      state.result ? resultView(state.result, app) : hintView(),
    );
  };

  /* ---------------------------------------------------------- 结果 */

  /**
   * 「结论范围」控件：下拉 + 代价小字 + 生效提示。
   *
   * 命中列表本身永远是完整的；这里选的只是「结论（模型分析）看哪一批」。
   * 改动不会自动重跑检索（那会悄悄多花一次模型额度），而是明确提示需要重新检索。
   */
  function basisControl() {
    const current = BASIS_OPTIONS.find((o) => o.id === state.basis) || BASIS_OPTIONS[0];
    const select = h(
      'select',
      {
        id: 'search-basis',
        class: 'input search-basis-select',
        title: '决定结论依据哪 40 封邮件（带摘录上限恒为 40 封）',
        onchange: (ev) => {
          state.basis = ev.target.value;
          // 重新渲染，让代价小字与「需重新检索」提示跟着切换
          paint();
        },
      },
      /*
       * 选中项用 option 的 `selected` 属性表达，而不是事后写 `select.value`：
       * 后者在部分环境（linkedom 的渲染自检）里是只读的 getter，直接抛错会让整页白屏。
       * 属性在插入文档前设置，真实浏览器同样会选中它。
       */
      ...BASIS_OPTIONS.map((o) => h('option', { value: o.id, selected: o.id === current.id, text: `${o.name}｜${o.short}` })),
    );
    // 结果里带的口径与当前所选不一致时才提示「需重新检索」：
    // 老结果没有 strategy 字段（或还没检索过）时不该伪造一个「已改动」提示
    const shown = (state.result?.basis || state.result?.analysisBasis)?.strategy;
    const pending = !!state.result && !state.searching && typeof shown === 'string' && shown !== state.basis;
    return h(
      'div',
      { class: 'basis-row' },
      h('label', { class: 'muted small', for: 'search-basis', text: '结论范围（结论看哪些邮件）' }),
      select,
      h('span', { class: 'muted small search-basis-cost', text: current.cost }),
      h('span', {
        class: 'muted small search-basis-note',
        text: pending ? '已改动——点「检索并分析」后生效（命中列表不变，只换结论依据的那 40 封）。' : '三种策略的带摘录上限都是 40 封：换策略只换「哪 40 封」，不会放大模型额度。',
      }),
    );
  }

  function resultView(result, app) {
    if (result.needMore) {
      return h(
        'section',
        { class: 'block' },
        h('div', { class: 'block-head' }, h('h3', { text: '需要再确认一下' })),
        h('div', { class: 'alert alert-warn block-lead' }, result.assistant),
      );
    }
    const s = result.stats || {};
    const bf = s.backfill;
    /** 结论范围口径（basis 为规范名，analysisBasis 保留向后兼容） */
    const basis = result.basis || result.analysisBasis || null;
    const items = result.items || [];
    const listed = s.listed ?? items.length;
    const matched = s.matched ?? items.length;
    const shownItems = items.slice(0, state.shown);
    return h(
      'div',
      {},
      h(
        'section',
        { class: 'block' },
        h(
          'div',
          { class: 'block-head' },
          h('h3', { text: '检索条件与结果' }),
          // 命中数与展示数分开说：截断时用户必须一眼看到「还有多少没列出来」
          h('span', {
            class: 'muted small',
            text:
              matched > listed
                ? `命中 ${matched} 封 / 已列出前 ${listed} 封`
                : `命中 ${matched} 封 / 已扫描 ${s.scanned ?? 0} 封`,
          }),
        ),
        h(
          'div',
          { class: 'search-meta' },
          result.understood ? h('div', {}, h('b', { text: '我理解的是：' }), result.understood) : null,
          result.filters
            ? h(
                'div',
                { class: 'muted small' },
                `时间范围 ${result.filters.effectiveRange}`,
                result.filters.defaultedRange ? '（你未指定，按默认近 30 天）' : '',
                filterChips(result.filters),
              )
            : null,
          // 范围被收敛（超出 1 年上限）：显式说明，不静默改小
          result.filters?.rangeNote ? h('div', { class: 'muted small' }, `范围说明：${result.filters.rangeNote}`) : null,
          s.coverage
            ? h('div', { class: 'muted small' }, `本地已分析邮件覆盖 ${s.coverage.oldest} ~ ${s.coverage.newest}（共 ${s.coverage.count} 封）`)
            : h('div', { class: 'muted small' }, '本地还没有已分析的邮件，请先到「邮件总览」运行一次分析。'),
          // 结论范围：模型只读了有界子集，必须如实说清「基于哪一批、覆盖到哪一天」。
          // 一封都没命中时不写这句——「结论基于 0 封」只会让人困惑。
          basis && basis.count > 0
            ? h(
                'div',
                { class: 'muted small' },
                `${basis.line || `结论基于其中 ${basis.count} 封`}` +
                  `（带摘录上限 ${basis.limit ?? 40} 封，与列表上限无关；` +
                  `按${basis.orderLabel || (basis.order === 'date_asc' ? '时间正序' : '时间倒序')}）` +
                  (basis.headlines ? `；另有 ${basis.headlines} 封只给了标题与时间，不作逐条断言依据` : '') +
                  (basis.fellBack ? `。${basis.note}` : ''),
              )
            : null,
          s.envelopeOnly
            ? h('div', { class: 'muted small' }, `其中 ${s.envelopeOnly} 封只有信封信息（发件人/时间/主题），没有模型摘要`)
            : null,
          s.bodyHits ? h('div', { class: 'muted small' }, `其中 ${s.bodyHits} 封是通过 IMAP 正文检索补充的（尚未分析）`) : null,
        ),
        // 截断说明：命中数超过展示上限 / 信封扫描达到上限，都必须显式提示
        result.truncationNote
          ? h('div', { class: 'alert alert-warn block-lead' }, result.truncationNote)
          : null,
        // 按需回补说明：让用户知道「为什么这次能查到更早的邮件」
        bf?.attempted
          ? h(
              'div',
              { class: `alert ${bf.failed ? 'alert-warn' : 'alert-info'} block-lead` },
              bf.failed
                ? `按需拉取失败：${result.backfillNote || '未知错误'}`
                : bf.fetched > 0
                  ? `本地原先没有覆盖这个时间段，已按需到邮箱拉取 ${bf.fetched} 封并分析 ${bf.analyzed} 封${bf.truncated ? '（分析已达单次额度上限，未分析的命中仍列在下面）' : ''}。`
                  : bf.matched > 0
                    ? `已按需核对该范围的信封，命中 ${bf.matched} 封（都已分析过，无需重复分析）。`
                    : '已按需到邮箱查过这个范围，没有符合时间与发件人条件的邮件。',
            )
          : null,
        bf?.truncated && result.backfillNote ? h('p', { class: 'muted small pad', text: result.backfillNote }) : null,
        bf?.errors?.length
          ? h('p', { class: 'muted small pad', text: `部分文件夹拉取失败：${bf.errors.map((e) => `${e.folder}（${e.message}）`).join('；')}` })
          : null,
        result.assistant ? h('div', { class: 'markdown', html: renderMarkdown(result.assistant) }) : null,
        result.analysisError ? h('p', { class: 'muted small pad', text: `（分析降级为本地摘要：${result.analysisError}）` }) : null,
      ),
      items.length
        ? h(
            'section',
            { class: 'block' },
            h(
              'div',
              { class: 'block-head' },
              h('h3', { text: `命中邮件（${matched}）` }),
              listed < matched ? h('span', { class: 'muted small', text: `仅列出前 ${listed} 封` }) : null,
            ),
            h(
              'div',
              { class: 'kb-list' },
              ...shownItems.map((it) => resultRow(it, app)),
            ),
            items.length > shownItems.length
              ? h(
                  'div',
                  { class: 'editor-actions' },
                  h(
                    'button',
                    {
                      class: 'btn btn-small',
                      onclick: () => {
                        state.shown += RENDER_STEP;
                        paint();
                      },
                    },
                    `显示更多（还有 ${items.length - shownItems.length} 条）`,
                  ),
                )
              : null,
          )
        : null,
    );
  }

  function filterChips(filters) {
    const chips = [];
    if (filters.from?.length) chips.push(`发件人含「${filters.from.join('、')}」`);
    if (filters.to?.length) chips.push(`收件人含「${filters.to.join('、')}」`);
    if (filters.subject?.length) chips.push(`主题含「${filters.subject.join('、')}」`);
    if (filters.content?.length) chips.push(`内容含「${filters.content.join('、')}」`);
    if (filters.types?.length) chips.push(`类型 ${filters.types.join('/')}`);
    if (filters.priorities?.length) chips.push(`优先级 ${filters.priorities.join('/')}`);
    if (filters.needsReply) chips.push('仅需回复');
    if (filters.recipientKind === 'direct') chips.push('仅直接发我');
    if (filters.recipientKind === 'cc') chips.push('仅抄送我');
    if (filters.hasAttachments) chips.push('仅有附件');
    if (!chips.length) return null;
    return h('div', { class: 'chip-row mt-2' }, ...chips.map((c) => h('span', { class: 'chip' }, c)));
  }

  function resultRow(it, app) {
    const open = state.expanded === it.key;
    return h(
      'article',
      { class: `kb-row ${open ? 'kb-row-open' : ''}` },
      h(
        'div',
        { class: 'kb-head' },
        typeTag(it.type, { h }),
        h(
          'span',
          { class: `tag ${it.priority === 'urgent' ? 'p-urgent' : it.priority === 'high' ? 'p-high' : 'tag-quiet'}`, text: it.priorityLabel },
        ),
        h('span', { class: `tag ${it.recipientKind === 'cc' ? 'tag-cc' : 'tag-quiet'}`, text: it.recipientLabel }),
        it.needsReply ? h('span', { class: 'tag tag-need', text: '需回复' }) : null,
        it.hasAttachments ? h('span', { class: 'tag tag-quiet', text: '有附件' }) : null,
        // 区分「有摘要（已分析）」与「仅信封命中」：后者没有模型结论，用户不该以为它被分析过
        it.analyzed === false || it.notAnalyzed
          ? h('span', { class: 'tag tag-quiet', title: '只匹配到信封（发件人/时间/主题），没有模型摘要', text: '仅信封·未分析' })
          : null,
        h('span', { class: 'muted small', text: fmtFull(it.date) }),
      ),
      h('h4', { class: 'kb-subject', text: it.subject || '(无主题)' }),
      h('p', { class: 'muted small', text: fmtAddress(it.from) }),
      it.summary ? h('p', { class: 'kb-summary', text: it.summary }) : null,
      open
        ? h(
            'div',
            {},
            it.snippet ? h('blockquote', { class: 'quote', text: it.snippet }) : null,
            it.actions?.length ? h('ul', { class: 'action-list' }, ...it.actions.map((a) => h('li', { text: a }))) : null,
            it.reason ? h('p', { class: 'muted small', text: `判断依据：${it.reason}` }) : null,
            it.attachments?.length
              ? h('p', { class: 'muted small', text: `附件：${it.attachments.map((f) => f.filename || f.contentType).join('、')}` })
              : null,
          )
        : null,
      h(
        'div',
        { class: 'editor-actions' },
        h(
          'button',
          {
            class: 'btn btn-small',
            onclick: () => {
              state.expanded = open ? null : it.key;
              paint();
            },
          },
          open ? '收起' : '展开',
        ),
        // 传 it 作为兜底：即使本地没有这封邮件的记录，详情弹窗也能显示出已知信息
        h('button', { class: 'btn btn-small', onclick: () => app.showMail(it.key, it) }, '完整详情'),
        it.draftStatus === 'sent'
          ? h(
              'button',
              {
                class: 'btn btn-small btn-sent',
                onclick: () => app.navigate('drafts', { tab: 'sent', draftId: it.draftId }),
              },
              '已发送邮件',
            )
          : it.hasDraft
            ? h(
                'button',
                {
                  class: 'btn btn-small',
                  onclick: () => app.navigate('drafts', { tab: 'pending', draftId: it.draftId }),
                },
                '查看草稿',
              )
            : null,
        copyButton(() => `${it.subject || '(无主题)'}\n${fmtAddress(it.from)}　${fmtFull(it.date)}\n\n${it.snippet || it.summary || ''}`, {
          label: '复制',
          className: 'btn btn-small',
          title: '复制主题、发件人、时间与摘要',
        }),
      ),
    );
  }

  function hintView() {
    return h(
      'section',
      { class: 'block' },
      h('div', { class: 'block-head' }, h('h3', { text: '可以这样问' })),
      h(
        'ul',
        { class: 'setup-steps' },
        h('li', { text: '「张总上个月发过哪些关于合同的邮件」——按发件人 + 时间' }),
        h('li', { text: '「主题里有告警的邮件」——按主题关键词' }),
        h('li', { text: '「正文提到 XX 项目延期的邮件」——按正文内容（会回落到 IMAP 检索）' }),
        h('li', { text: '「近一个月需要我处理的高优先级邮件」——按收件方式 + 优先级' }),
        h('li', { text: '「这个月抄送给我的重要邮件」——只看抄送' }),
      ),
    );
  }

  /* ---------------------------------------------------------- 动作 */

  async function run() {
    const q = state.input.trim();
    if (!q) return toast('请先输入要检索的内容', 'error');
    if (state.searching) return;
    state.searching = true;
    state.expanded = null;
    state.shown = RENDER_STEP;
    paint();
    try {
      state.result = await api.searchEmails({ query: q, basis: state.basis });
      state.history = [q, ...state.history.filter((x) => x !== q)].slice(0, 10);
    } catch (err) {
      toastError(err);
    } finally {
      state.searching = false;
      paint();
    }
  }

  paint();
  return { reload: () => (state.result ? run() : Promise.resolve()) };
}
