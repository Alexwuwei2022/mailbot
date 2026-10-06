/**
 * 邮件类型的展示元数据：中文标签 + 图标 + 配色。
 *
 * 为什么单独抽一个模块：类型标签在总览、知识库、对话查邮件、检索结果四处都会出现，
 * 如果各写各的，同一种类型在四个页面会是四种颜色，反而更难认。
 *
 * 配色原则：
 *   - 8 种类型各占一个**色相**，一眼能区分（橙/蓝/紫/青/粉/灰蓝/黄绿/红）；
 *   - 图标用内联 SVG（见 icons.js），**不用 emoji**：emoji 在 10px 字号下会被系统回退成
 *     单色符号（实测 💬→●、🔔→⚠、📄→■），三平台表现不一致；
 *   - 颜色只通过 CSS 类给（见 styles.css 的 .type-*），这样三套主题可以各自调。
 */

import { TYPE_ICONS, icon } from './icons.js';

/** @type {Record<string, {label: string}>} */
export const TYPE_META = {
  action_required: { label: '待处理' },
  question: { label: '询问' },
  meeting: { label: '会议' },
  notification: { label: '通知' },
  newsletter: { label: '订阅' },
  fyi: { label: '知会' },
  social: { label: '社会' },
  spam: { label: '垃圾' },
};

/** 未知类型也要能显示，不要留空标签。 */
const FALLBACK = { label: '其它', icon: 'doc' };

/** 取某个类型的展示元数据（永不返回 null）。 */
export function typeMeta(type) {
  const key = String(type || '');
  const meta = TYPE_META[key];
  return {
    type: key,
    label: meta ? meta.label : FALLBACK.label,
    icon: TYPE_ICONS[key] || FALLBACK.icon,
    className: `type-${key || 'other'}`,
  };
}

/** 类型标签元素：`<span class="tag type-notification">[铃铛] 通知</span>`（图标是内联 SVG）。 */
export function typeTag(type, { h, extraClass = '' } = {}) {
  const meta = typeMeta(type);
  return h(
    'span',
    { class: `tag ${meta.className} ${extraClass}`.trim(), title: `类型：${meta.label}` },
    icon(meta.icon, { size: 12, className: 'tag-icon' }),
    meta.label,
  );
}
