/**
 * 内联 SVG 图标。
 *
 * 为什么不用 emoji：实测在 10.5px 的字号下，Windows 会把 💬/🔔/📄 回退到符号字体，
 * 渲染成 `●`/`⚠`/`■` 这类单色字形（用户截图里就是这样），三平台表现不可控。
 * 内联 SVG 则完全确定：颜色跟随 `currentColor`（因此自动适配三套主题）、
 * 尺寸不受字体影响、不依赖任何图标字体或图片资源。
 *
 * 用法：`icon('bell')` → 返回一个 `<span class="icon">`，内部是静态 SVG 标记。
 * 标记全部是开发者写死的字符串，不拼接任何用户输入，因此用 innerHTML 是安全的。
 */

import { h } from './dom.js';

const SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

/** 路径定义表：`{ name: '<path …/>' }`。 */
const PATHS = {
  /* ---- 邮件类型 ---- */
  // 待处理：闪电（"有活要干"）
  bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12l1-8.5Z" fill="currentColor" stroke="none"/>',
  // 询问：圆圈 + 问号
  question:
    '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.2a2.7 2.7 0 1 1 3.9 2.4c-.9.5-1.3 1.1-1.3 2v.4"/><path d="M12 17.3h.01"/>',
  // 会议：日历
  calendar:
    '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 9.5h17M8 3.5V6M16 3.5V6"/><path d="M7.5 13h3"/>',
  // 通知：铃铛
  bell: '<path d="M6.5 10a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5Z"/><path d="M10 18.5a2 2 0 0 0 4 0"/>',
  // 订阅：报纸
  news: '<rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 8h2.5a1.5 1.5 0 0 1 1.5 1.5V17a2 2 0 0 1-2 2H5"/><path d="M6.5 8.5h7M6.5 12h7M6.5 15.5h4"/>',
  // 知会：文档
  doc: '<path d="M14 3.5H7.5A2 2 0 0 0 5.5 5.5v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5L14 3.5Z"/><path d="M13.8 3.7V8.7h4.6"/><path d="M8.8 13h6.4M8.8 16.4h4.2"/>',
  // 社会：对话气泡
  chat: '<path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2a10 10 0 0 1-2.6-.34L4.5 20.5l1.2-3.3A6.9 6.9 0 0 1 3.5 12.2C3.5 8.2 7.3 5 12 5s8.5 3.2 8.5 7.2Z"/><path d="M9 12h.01M12 12h.01M15 12h.01"/>',
  // 垃圾：垃圾桶
  trash: '<path d="M4.5 7h15"/><path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="M6.5 7l.9 12a2 2 0 0 0 2 1.9h5.2a2 2 0 0 0 2-1.9L17.5 7"/><path d="M10.5 11v6M13.5 11v6"/>',

  /* ---- 界面 ---- */
  copy: '<rect x="9" y="9" width="11.5" height="11.5" rx="2.4"/><path d="M14.5 6.2V5.4A2.4 2.4 0 0 0 12.1 3H5.9a2.4 2.4 0 0 0-2.4 2.4v6.2A2.4 2.4 0 0 0 5.9 14h.8"/>',
  check: '<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>',
  download: '<path d="M12 3.5v11"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M4.5 19.5h15"/>',
  mailOpen: '<path d="M3.5 9.5 12 4l8.5 5.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V9.5Z"/><path d="M3.5 10 12 15l8.5-5"/>',
  sparkle: '<path d="M12 3.5 13.7 9l5.5 1.7-5.5 1.7L12 18l-1.7-5.6L4.8 10.7 10.3 9 12 3.5Z" fill="currentColor" stroke="none"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  filter: '<path d="M4 6h16l-6 7v5.5l-4 2V13L4 6Z"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  send: '<path d="M21 3 10.5 13.5"/><path d="M21 3l-6.5 18-4-8-8-4L21 3Z"/>',
};

/**
 * 取一个图标的 SVG 标记。
 * @param {string} name PATHS 里的键
 * @param {object} [options] { size, className }
 * @returns {string} SVG 标记字符串
 */
export function iconSvg(name, { size = 13, className = '' } = {}) {
  const path = PATHS[name] || PATHS.doc;
  return `<svg ${SVG_ATTRS} width="${size}" height="${size}" class="icon-svg ${className}" aria-hidden="true" focusable="false">${path}</svg>`;
}

/**
 * 图标元素。
 * @param {string} name
 * @param {object} [options] { size, className, title }
 * @returns {HTMLElement}
 */
export function icon(name, { size = 13, className = '', title = '' } = {}) {
  const el = h('span', { class: `icon ${className}`.trim(), title: title || null });
  el.innerHTML = iconSvg(name, { size });
  return el;
}

/** 邮件类型 → 图标名。与 type-meta.js 的类型一一对应。 */
export const TYPE_ICONS = {
  action_required: 'bolt',
  question: 'question',
  meeting: 'calendar',
  notification: 'bell',
  newsletter: 'news',
  fyi: 'doc',
  social: 'chat',
  spam: 'trash',
};
