/**
 * 外观模式的最早期初始化。
 *
 * 为什么必须是**独立的同步脚本**、而不是内联在 index.html 里，也不是 ES 模块：
 *
 *   1. 内联脚本会让 CSP 不得不放开 `script-src 'unsafe-inline'`——那等于放弃了
 *      CSP 对 XSS 的主要防护，代价太大；
 *   2. ES 模块默认是 defer 的，会等 HTML 解析完才执行，于是先按默认主题画一帧、
 *      再切成用户选的主题，肉眼可见地闪一下（FOUC）。
 *
 * 所以：普通 `<script src>`（同步、阻塞渲染）放在 `<head>` 里，既满足严格 CSP，
 * 又能在首帧之前把 `data-theme` 定下来。取值逻辑与 `web/theme.js` 保持一致。
 */
(function () {
  try {
    var t = localStorage.getItem('mailbot.theme');
    if (t !== 'light' && t !== 'dark' && t !== 'green') {
      t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t === 'light' ? 'light' : 'dark';
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
