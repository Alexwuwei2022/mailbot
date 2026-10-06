/**
 * 内联 SVG 图表。
 *
 * 为什么不用图表库：本项目零依赖，且服务端也不该为了画几张柱状图引入绘图栈。
 * 这几个图形都足够简单（柱、堆叠条、热力网格、横条），自己拼 SVG 反而更可控：
 *   - 颜色走 CSS 变量（见 styles.css 的 .chart-*），**自动跟随浅色/深色/绿色三套主题**；
 *   - 尺寸用 viewBox + width:100%，窄屏自动缩放；
 *   - 数值用 <title> 做原生悬浮提示，不需要额外的事件与浮层。
 *
 * 所有函数都对**零数据**安全：全 0 或空数组时返回占位提示，不产生除零或 NaN 坐标。
 */

import { h } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';

/**
 * 创建 SVG 元素。
 *
 * 注意：`dom.js` 的 `h()` 用的是 createElement，对 SVG 不生效（会得到 HTMLUnknownElement，
 * 画不出来）；反过来，**HTML 元素也绝不能用 createElementNS 创建**——
 * 那样会得到 SVG 命名空间的 div，浏览器不渲染。所以这里严格分工：
 * `s()` 只用于 SVG 标签，HTML 外壳一律用 `h()`。
 */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') el.textContent = String(value);
    else el.setAttribute(key, String(value));
  }
  el.append(...children.filter(Boolean));
  return el;
}

function fmtValue(n, unit) {
  const v = Math.round((Number(n) || 0) * 10) / 10;
  return `${v}${unit || ''}`;
}

/** 图表外壳：标题 + SVG + 可选图例。外壳是 HTML，必须用 h() 创建。 */
function wrap(title, svg, { legend = null, note = null } = {}) {
  return h(
    'figure',
    { class: 'chart' },
    h('figcaption', { class: 'chart-title' }, title),
    svg,
    legend ? h('div', { class: 'chart-legend' }, ...legend) : null,
    note ? h('div', { class: 'chart-note' }, note) : null,
  );
}

function legendItem(label, className) {
  return h('span', { class: 'chart-legend-item' }, h('i', { class: `chart-swatch ${className}` }), label);
}

function emptyChart(title) {
  return wrap(title, h('div', { class: 'chart-empty' }, '暂无数据'));
}

/* ------------------------------------------------------------ 堆叠柱状图 */

/**
 * 按周负荷堆叠柱状图。
 * @param {object} input { title, unit, items: [{ label, segments: [{ value, className, name }] }] }
 */
export function stackedBarChart({ title, unit = 'h', items = [], width = 880, height = 190 } = {}) {
  const list = (items || []).filter(Boolean);
  const totals = list.map((it) => (it.segments || []).reduce((sum, sg) => sum + (Number(sg.value) || 0), 0));
  const max = Math.max(...totals, 0);
  if (!list.length || max <= 0) return emptyChart(title);

  const padTop = 12;
  const padBottom = 34;
  const barArea = height - padTop - padBottom;
  const step = width / list.length;
  const barW = Math.max(6, Math.min(46, step * 0.55));

  // 4 条参考线，让"多高算高"有依据
  const gridLines = [0.25, 0.5, 0.75, 1].map((r) =>
    s('line', {
      class: 'chart-grid',
      x1: 0,
      x2: width,
      y1: padTop + barArea * (1 - r),
      y2: padTop + barArea * (1 - r),
    }),
  );

  const bars = list.map((it, i) => {
    const x = i * step + (step - barW) / 2;
    let cursorY = padTop + barArea;
    const segs = (it.segments || []).map((sg) => {
      const value = Number(sg.value) || 0;
      const h = max > 0 ? (value / max) * barArea : 0;
      cursorY -= h;
      if (h <= 0) return null;
      return s('rect', {
        class: `chart-bar ${sg.className || ''}`.trim(),
        x,
        y: cursorY,
        width: barW,
        height: Math.max(0.6, h),
        rx: 2,
      }, s('title', { text: `${sg.name || ''} ${fmtValue(value, unit)}` }));
    });
    return s(
      'g',
      {},
      ...segs,
      s('title', { text: `${it.label}：合计 ${fmtValue(totals[i], unit)}` }),
      s('text', {
        class: 'chart-axis',
        x: x + barW / 2,
        y: height - 16,
        'text-anchor': 'middle',
        text: it.shortLabel || it.label,
      }),
      totals[i] > 0
        ? s('text', { class: 'chart-value', x: x + barW / 2, y: cursorY - 4, 'text-anchor': 'middle', text: fmtValue(totals[i], unit) })
        : null,
    );
  });

  /*
   * 刻意**不设 preserveAspectRatio="none"**：那会让图随容器非等比拉伸，
   * 热力图的方格会被压成长方形、柱状图高度也会失真。
   * 默认的等比缩放 + `height: auto` 已经能让图随宽度自适应。
   */
  const svg = s(
    'svg',
    { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title },
    ...gridLines,
    ...bars,
  );
  const segNames = (items[0]?.segments || []).map((sg) => legendItem(sg.name || '', sg.className || ''));
  return wrap(title, svg, { legend: segNames });
}

/* ------------------------------------------------------------ 横向条形图 */

/**
 * 横向条形图（用于 Top 榜）。
 *
 * ## 为什么用 HTML 而不是 SVG
 *
 * 原来用 SVG + viewBox，条高和行距是**画布坐标**，会随卡片宽度等比缩放：
 * 同样是 12 单位的条，在 1.3fr 的左列和 1fr 的中列渲染出来高度不同，
 * 行距也跟着变——用户看到的正是"三张图的柱子高矮、疏密不一致"。
 *
 * 改成 HTML/CSS 后，行高、条高、行距、字号都是**绝对像素**，与卡片宽度无关，
 * 所以左列两张与中列那张的柱子和间隔完全一致；文字也不再被缩放。
 * 代价是要用一次内联 `width:%`（唯一的动态值，无法用类名表达）。
 *
 * @param {object} input { title, unit, items: [{ label, value, hint, className }] }
 */
export function hBarChart({ title, unit = '', items = [] } = {}) {
  const list = (items || []).filter((it) => it && (Number(it.value) || 0) >= 0).slice(0, 10);
  const max = Math.max(...list.map((it) => Number(it.value) || 0), 0);
  if (!list.length || max <= 0) return emptyChart(title);

  const rows = list.map((it) => {
    const value = Number(it.value) || 0;
    const pct = max > 0 ? (value / max) * 100 : 0;
    return h(
      'div',
      {
        class: 'bar-row',
        title: `${it.label}：${fmtValue(value, unit)}${it.hint ? `（${it.hint}）` : ''}`,
      },
      h('span', { class: 'bar-label', text: String(it.label) }),
      h(
        'span',
        { class: 'bar-track' },
        // 唯一的动态样式：宽度百分比。有值至少给 2px，避免"有数据却看不见"
        h('i', { class: `bar-fill ${it.className || ''}`.trim(), style: `width:${value > 0 ? Math.max(2, pct) : 0}%` }),
      ),
      h('span', { class: 'bar-value', text: fmtValue(value, unit) }),
    );
  });

  return wrap(title, h('div', { class: 'bar-list' }, ...rows));
}

/* ------------------------------------------------------------ 堆叠条 */

/**
 * 单条堆叠条（用于"时间构成"）。
 *
 * 布局要点：这条是**整行宽度**的图，所以条本身要够粗才看得清。
 * 之前 barH=20 配 46 高的画布，渲染出来只有十几像素，像一条细线。
 * 现在条高 44，段内直接标"名称 + 小时 + 占比"，宽度不够时降级为只标占比。
 *
 * @param {object} input { title, unit, segments: [{ name, value, className }] }
 */
export function stackedBar({ title, unit = 'h', segments = [], width = 880, height = 96 } = {}) {
  const segs = (segments || []).filter((sg) => Number(sg.value) > 0);
  const total = segs.reduce((sum, sg) => sum + Number(sg.value), 0);
  if (!segs.length || total <= 0) return emptyChart(title);

  const barH = 44;
  const barY = 12;
  let x = 0;
  const parts = [];
  const labels = [];

  /*
   * 段内标签按**估算文字宽度**决定放什么，而不是用固定的宽度阈值。
   * 固定阈值（如"宽度 >12% 就放全称"）在中文长标签上会溢出到相邻色块，
   * 看起来就是"字挤在条上、压到隔壁颜色"。
   * 中文按 1 字宽、ASCII 按 0.55 字宽估算（11.5px 字号 ≈ 6.3 单位/中文字）。
   */
  const UNIT = 6.3;
  const textWidth = (str) => {
    let w = 0;
    for (const ch of String(str)) w += /[\u4e00-\u9fa5（）：·]/.test(ch) ? UNIT : UNIT * 0.55;
    return w;
  };

  for (const sg of segs) {
    const value = Number(sg.value) || 0;
    const w = (value / total) * width;
    const pct = Math.round((value / total) * 100);
    parts.push(
      s(
        'rect',
        { class: `chart-bar ${sg.className || ''}`.trim(), x, y: barY, width: Math.max(1, w), height: barH, rx: 3 },
        s('title', { text: `${sg.name} ${fmtValue(value, unit)}（占 ${pct}%）` }),
      ),
    );
    // 候选由详尽到简短，放得下哪个用哪个；都放不下就交给下面的图例
    const candidates = [`${sg.name} ${fmtValue(value, unit)} · ${pct}%`, `${fmtValue(value, unit)} · ${pct}%`, `${pct}%`];
    const labelY = barY + barH / 2 + 4;
    for (const text of candidates) {
      if (textWidth(text) + 12 <= w) {
        labels.push(s('text', { class: 'chart-inside-label', x: x + w / 2, y: labelY, 'text-anchor': 'middle', text }));
        break;
      }
    }
    x += w;
  }

  const svg = s(
    'svg',
    { class: 'chart-svg', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': title },
    s('g', {}, ...parts, ...labels),
    s('text', { class: 'chart-axis', x: 0, y: height - 8, text: `合计 ${fmtValue(total, unit)}` }),
  );
  return wrap(title, svg, { legend: segs.map((sg) => legendItem(sg.name, sg.className || '')) });
}

/* ------------------------------------------------------------ 热力图 */

/**
 * 每日忙碌热力图：每行一周（周一到周日），**行首标出该周的日期范围**。
 *
 * 行首的日期范围（如 `9.28~10.4`）是用户明确要求的：没有它就只能靠数格子猜"这是哪一周"。
 * 为此在左侧留出一条 64 单位的标签栏，格子在右边。
 *
 * @param {object} input { title, unit, days: [{ key, label, value, isWorkday }] }
 */
export function heatmap({ title, unit = 'h', days = [], cell = 24, gap = 5, gutter = 64 } = {}) {
  const list = (days || []).filter(Boolean);
  const max = Math.max(...list.map((d) => Number(d.value) || 0), 0);
  if (!list.length) return emptyChart(title);
  if (max <= 0) return wrap(title, h('div', { class: 'chart-empty' }, '这段时间没有任何日程记录'));

  // 与时间无关的纯排版：把第一天按"它自己的星期"放进网格
  const firstWeekday = Number(list[0].weekday ?? 1);
  const offset = (firstWeekday + 6) % 7; // 周一=0
  const cols = 7;
  const rows = Math.ceil((list.length + offset) / cols);
  const gridW = cols * (cell + gap) - gap;
  const width = gutter + gridW;
  const height = rows * (cell + gap) - gap + 16;

  const weekLabels = ['一', '二', '三', '四', '五', '六', '日'];
  const head = weekLabels.map((w, i) => s('text', { class: 'chart-axis', x: gutter + i * (cell + gap) + cell / 2, y: 10, 'text-anchor': 'middle', text: w }));

  const cells = list.map((d, i) => {
    const idx = i + offset;
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const value = Number(d.value) || 0;
    // 按强度分 5 档：0 单独一档，避免"有一点安排"和"没有安排"混在一起
    const level = value <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((value / max) * 4)));
    return s(
      'rect',
      {
        class: `chart-cell heat-${level}${d.isWorkday === false ? ' heat-weekend' : ''}`,
        x: gutter + col * (cell + gap),
        y: 16 + row * (cell + gap),
        width: cell,
        height: cell,
        rx: 3,
      },
      s('title', { text: `${d.label || d.key}：${value > 0 ? fmtValue(value, unit) : '无安排'}` }),
    );
  });

  /*
   * 行首日期范围。用**这一行实际覆盖到的天数**（首行/末行可能不满一周），
   * 而不是一律显示周一到周日——否则会标出窗口之外、根本没有数据的日期。
   */
  const md = (key) => {
    const m = String(key).match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m ? `${Number(m[1])}.${Number(m[2])}` : String(key);
  };
  const rowLabels = [];
  for (let r = 0; r < rows; r += 1) {
    const startIdx = Math.max(0, r * cols - offset);
    const endIdx = Math.min(list.length - 1, (r + 1) * cols - 1 - offset);
    if (endIdx < 0 || startIdx > list.length - 1) continue;
    const from = list[startIdx];
    const to = list[endIdx];
    const text = md(from.key) === md(to.key) ? md(from.key) : `${md(from.key)}~${md(to.key)}`;
    rowLabels.push(
      s('text', {
        class: 'chart-axis',
        x: gutter - 8,
        y: 16 + r * (cell + gap) + cell / 2 + 3.5,
        'text-anchor': 'end',
        text,
      }),
    );
  }

  /*
   * 热力图用**固定像素尺寸**（width/height 属性 + max-width:100%），不跟着卡片宽度放大。
   * 原因：它的 viewBox 很窄，若按 100% 宽度等比放大，
   * 一年份的 9 行会被拉成七百多像素高，格子也会大到失真。
   */
  const svg = s(
    'svg',
    {
      class: 'chart-svg chart-svg-fixed',
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      role: 'img',
      'aria-label': title,
    },
    ...head,
    ...cells,
    ...rowLabels,
  );
  return wrap(title, svg, {
    legend: [
      legendItem('无', 'heat-0'),
      legendItem('少', 'heat-1'),
      legendItem('中', 'heat-2'),
      legendItem('多', 'heat-3'),
      legendItem('满', 'heat-4'),
    ],
    note: `每格一天，左侧为该周日期范围；颜色越深表示当天日程占用越多（最多 ${fmtValue(max, unit)}）`,
  });
}

/* ------------------------------------------------------------ 组装 */

/**
 * 把一份回顾聚合结果画成图表区。
 * @param {object} agg runCalendarReview 返回的结构（totals/structure/weekly/topics/topPeople/durations/locations）
 */
export function renderReviewCharts(agg) {
  if (!agg) return null;
  const weekly = (agg.weekly || []).filter((w) => w.meetingCount || w.busyHours);
  const t = agg.totals || {};
  const durations = agg.durations || [];
  const people = agg.topPeople || [];
  const topics = agg.topics || [];
  const lifeKinds = agg.lifeKinds || [];
  const days = agg.dayStats || [];

  /*
   * 布局按用户给的版式（三列，左列更宽）：
   *
   *   [ 按周工作负荷                              ] 整行
   *   [ 时间构成（总占用）                         ] 整行
   *   [ 活动时长分布 ] [ 工作主题分布  ][ 每日忙碌分布  ]
   *   [ 生活/个人事务 ]   ↑ 中右两张各跨两行
   *   [ 占用时间最多的人                           ] 整行
   *
   * 中间这一行用**嵌套 grid + 显式位置**，不依赖外层自动排布：
   * 图是有条件出现的（没有主题/没有生活条目就不画），
   * 自动排布会在缺图时把后面的图挤到左边去，版式跟着变；
   * 显式定位则缺图只留一个空格，其余各就各位。
   */
  const grid = h('div', { class: 'chart-grid' });
  const wide = (el) => {
    if (el) el.classList.add('chart-span-3');
    return el;
  };

  // ① 按周负荷（会议 vs 独自工作）——趋势最直观，整行
  const weeklyChart = stackedBarChart({
    title: '按周工作负荷',
    items: weekly.map((w) => ({
      label: w.week,
      shortLabel: String(w.week).split(' ~ ')[0].slice(5),
      segments: [
        { name: '会议', value: w.meetingHours || 0, className: 'seg-meeting' },
        { name: '独自工作', value: Math.max(0, Math.round(((w.busyHours || 0) - (w.meetingHours || 0)) * 10) / 10), className: 'seg-work' },
      ],
    })),
  });

  // ② 时间构成（含生活：用户记日历就是为了标记"这段时间我占用了"）——整行，条才够宽够粗
  const composition = stackedBar({
    title: '时间构成（总占用）',
    segments: [
      { name: '会议', value: t.meetingHours || 0, className: 'seg-meeting' },
      { name: '独自工作', value: t.workHours || 0, className: 'seg-work' },
      { name: '专注块', value: t.focusHours || 0, className: 'seg-focus' },
      { name: '生活/个人', value: t.lifeHours || 0, className: 'seg-life' },
    ],
  });

  // ③ 中间一行：左列上下两张，中列与右列各跨两行
  const durationsChart = durations.length
    ? hBarChart({
        title: '活动时长分布（项）',
        items: durations.map((d) => ({ label: d.label.replace(/（.*?）/, ''), value: d.count, hint: `${d.hours}h` })),
      })
    : null;
  const lifeChart = lifeKinds.length
    ? hBarChart({
        title: '生活/个人事务（小时）',
        unit: 'h',
        items: lifeKinds.slice(0, 8).map((l) => ({ label: l.name, value: l.hours, hint: `${l.count} 项`, className: 'seg-life' })),
      })
    : null;
  const topicsChart = topics.length
    ? hBarChart({ title: '工作主题分布（项）', items: topics.slice(0, 8).map((x) => ({ label: x.topic, value: x.count, hint: `${x.count} 项` })) })
    : null;
  const heatChart = heatmap({
    title: '每日忙碌分布',
    days: days.map((d) => ({ key: d.key, label: d.label, value: d.busyHours || 0, weekday: new Date(`${d.key}T12:00:00`).getDay(), isWorkday: d.isWorkday })),
  });

  const leftCharts = [durationsChart, lifeChart].filter(Boolean);
  const midRow = h('div', { class: 'chart-midrow' });
  /*
   * 左列是**一个容器**里的上下两张，而不是两个独立网格行。
   *
   * 之前把两张图放进 grid 的第 1、2 行，行高会被中列那张跨两行的图撑开，
   * 于是"活动时长分布"和"生活/个人事务"之间出现一大段空隙（用户截图指出的正是这里）。
   * 收进一个 flex 列后，两张图紧挨着，多余的空间留在列尾而不是夹在中间。
   */
  const leftCol = h('div', { class: 'chart-midrow-left' }, ...leftCharts);
  midRow.append(leftCol);
  if (topicsChart) {
    topicsChart.classList.add('chart-cell-mid');
    midRow.append(topicsChart);
  }
  heatChart.classList.add('chart-cell-right');
  midRow.append(heatChart);

  const peopleChart = people.length
    ? hBarChart({
        title: '占用时间最多的人（小时）',
        unit: 'h',
        width: 880,
        items: people.slice(0, 10).map((p) => ({ label: p.name, value: p.hours, hint: `${p.count} 次` })),
      })
    : null;

  grid.append(wide(weeklyChart), wide(composition), midRow);
  if (peopleChart) grid.append(wide(peopleChart));
  return grid;
}
