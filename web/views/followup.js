/**
 * 「跟进」页：把「跟催」与「时间线」合成一个菜单项下的两个页签。
 *
 * ## 为什么是页签而不是把两个视图重写成一份代码
 *
 * 两个视图各自把内部状态（跟催的展开/筛选、时间线的项目选择、排序方向）托管在
 * `app.viewStates` 里，互相独立。这里只换**挂载点**：点哪个页签就把哪个视图渲染到
 * 下方的 panel 里，切回来时它们各自的状态还在——用户不会因为"切了个页签"丢掉
 * 正在看的项目。反过来若把两边揉成一份代码，改一处要动两处，风险远大于收益。
 *
 * ## 为什么默认落在「跟催」
 *
 * 跟催是"今天要做什么"（行动导向），时间线是"这件事的来龙去脉"（回溯导向）。
 * 前者更常看，且跟催是合并前排在前面的一项。
 *
 * ## 旧链接
 *
 * `#/followups` 与 `#/timeline` 仍然可用：app.js 会把它们解析成 `{ tab }` 参数
 * 交给这里（`takeNavParams`），所以书签与文档里的老链接不会失效。
 *
 * ## 页签写在地址里（`#/followup/timeline`）
 *
 * 页签是**视图级**的状态，用户会想直接刷新/收藏/分享"时间线"那一个地址。分工是：
 *   - 地址 → 页签：由 app.js 的 `hashchange` → `navigate` 处理（含旧地址 `#/timeline`），
 *     视图只从 `takeNavParams` 里取一次结果。视图**不自己养 hashchange 监听器**——
 *     那种监听器在视图反复重绘时很容易累积（设置页目录的滚动监听就漏过一次）。
 *   - 页签 → 地址：点页签时调 `app.syncTabHash()` 把地址同步过去（并让路由指纹跟着走，
 *     免得随后的 hashchange 被当成"用户换了地址"再整视图重绘一遍）。
 *   - **不重绘整视图**：页签切换是纯页内切换，DOM 由这里的 `paint()` 更新；
 *     后退/前进会走一遍路由（视图整体重绘一次），这是刻意的：地址的变化由路由统一处理。
 */

import { h, mount } from '../dom.js';
import { viewState } from '../view-state.js';
import { renderFollowUps } from './followups.js';
import { renderTimeline } from './timeline.js';

/** 页签定义。id 与两个视图的 viewState 键一致，跨视图跳转可以直接按 id 指定。 */
const TABS = [
  { id: 'followups', label: '跟催' },
  { id: 'timeline', label: '时间线' },
];

export function renderFollowUp(root, app) {
  const { state } = viewState(app, 'followup', () => ({ tab: TABS[0].id }));

  /*
   * 页签是一次性跳转参数（`navigate('followup', { tab: 'timeline' })`，也是地址
   * `#/followup/timeline` 落地的方式）。取走之后就只认 state：用户手动切的页签
   * 不该被下一次重绘顶回去。
   */
  const nav = app.takeNavParams?.('followup');
  if (nav?.tab && TABS.some((t) => t.id === nav.tab)) state.tab = nav.tab;
  // 状态被外部改坏（或旧版本残留）时兜底，保证永远有一个可达的页签
  if (!TABS.some((t) => t.id === state.tab)) state.tab = TABS[0].id;

  const container = h('div', { class: 'view view-followup' });
  // panel 是复用的挂载点：切页签只是把另一个视图渲染进去，不动外层结构
  const panel = h('div', { class: 'followup-panel' });
  mount(root, container);

  const paint = () => {
    mount(
      container,
      h(
        'div',
        { class: 'tabs followup-tabs', role: 'tablist', 'aria-label': '跟进视图切换' },
        ...TABS.map((t) =>
          h(
            'button',
            {
              class: `tab ${state.tab === t.id ? 'active' : ''}`,
              type: 'button',
              role: 'tab',
              'aria-selected': state.tab === t.id ? 'true' : 'false',
              // 测试与调试用的稳定标识（与文案解耦）
              dataset: { tab: t.id },
              onclick: () => {
                if (state.tab === t.id) return;
                state.tab = t.id;
                // 只同步地址，不重绘：DOM 由下面这行 paint() 更新（可选调用，便于测试替身）
                app.syncTabHash?.('followup', t.id);
                paint();
              },
            },
            t.label,
          ),
        ),
      ),
      panel,
    );
    /*
     * 只渲染当前页签：两个视图各自会取数，同时渲染等于白白多打一倍接口。
     * `embedded: true` 让子视图收起自己的大标题——页签条上已经写着「跟催 ／ 时间线」，
     * 再来一个同级标题就是同一句话说两遍（子视图的内部逻辑一个字没动，
     * 只是多了一个可选的渲染开关；不传时它们的行为与以前完全一致）。
     */
    if (state.tab === 'timeline') renderTimeline(panel, app, { embedded: true });
    else renderFollowUps(panel, app, { embedded: true });
  };

  paint();
}
