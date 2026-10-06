/**
 * 外观模式（主题）。
 *
 * 三种模式：
 *   light 浅色 —— 白底深字，适合明亮环境与打印/截图
 *   dark  深色 —— 中性深灰蓝，长时间阅读不刺眼（默认跟随系统）
 *   green 绿色 —— 深绿底 + 亮绿强调色，编辑感更强（参考 bartoszkolenda.com 的气质）
 *
 * 实现要点：
 *   1. 主题只通过 `<html data-theme="...">` + CSS 变量切换，不改任何组件代码；
 *   2. 选择存在 localStorage（纯本地显示偏好，不需要动服务端配置）；
 *   3. **未选择过时跟随系统**：这样老用户升级后外观不会突变；
 *   4. index.html 里有一段内联脚本先行设置 data-theme，避免首屏闪一下再变主题（FOUC）。
 */

const STORAGE_KEY = 'mailbot.theme';

/** 可选项。顺序即界面按钮顺序。 */
export const THEMES = [
  { id: 'light', label: '浅色', icon: '☀', hint: '白底深字，适合明亮环境' },
  { id: 'dark', label: '深色', icon: '☾', hint: '中性深色，长时间阅读不刺眼' },
  { id: 'green', label: '绿色', icon: '❧', hint: '深绿底 + 亮绿强调色' },
];

const IDS = THEMES.map((t) => t.id);

/** 读取用户显式选择的主题（没有则返回空串）。 */
export function storedTheme() {
  try {
    const value = localStorage.getItem(STORAGE_KEY) || '';
    return IDS.includes(value) ? value : '';
  } catch {
    return '';
  }
}

/** 系统偏好（无法判断时按深色）。 */
export function systemTheme() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** 当前生效的主题：显式选择优先，否则跟随系统。 */
export function effectiveTheme() {
  return storedTheme() || systemTheme();
}

/**
 * 应用主题。
 * @param {string} id light / dark / green
 * @param {object} [options] { persist: boolean } persist=false 时只应用不记忆（用于「跟随系统」）
 */
export function applyTheme(id, { persist = true } = {}) {
  const theme = IDS.includes(id) ? id : systemTheme();
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);
  // 让原生控件（滚动条、输入框、日期选择器）也用对应的亮/暗基底
  root.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  if (persist) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* 隐私模式下存储可能不可用，忽略即可 */
    }
  }
  return theme;
}

/**
 * 启动时初始化：有显式选择就应用它；没有就跟随系统，并监听系统变化。
 * @returns {() => void} 取消监听
 */
export function initTheme() {
  applyTheme(effectiveTheme(), { persist: false });
  try {
    if (!window.matchMedia) return () => {};
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      // 用户没有显式选择时，系统切换要跟着变
      if (!storedTheme()) applyTheme(systemTheme(), { persist: false });
    };
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if (mq.addListener) mq.addListener(onChange);
    return () => {
      if (mq.removeEventListener) mq.removeEventListener('change', onChange);
      else if (mq.removeListener) mq.removeListener(onChange);
    };
  } catch {
    return () => {};
  }
}
