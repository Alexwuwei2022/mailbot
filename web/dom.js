/** 轻量 DOM 工具。 */

import { authHeaders } from './api.js';

/**
 * 富文本：把文案里的 `**重点**` 渲染成真正的粗体。
 *
 * 背景：界面上大量说明文案是用 Markdown 习惯写的（`**重启服务**才生效`），
 * 但渲染层不解析它 → 星号被**原样显示**出来，看上去像代码残留。
 * 与其去改几百个调用点，不如在唯一的渲染原语 `h()` 里支持它一次。
 *
 * 三个刻意的不转换：
 *   ① `pre` / `code` / `textarea`：那些地方的文字必须**逐字原样**（邮件正文、引用、代码）；
 *   ② 没有成对星号的字符串：原样输出（避免把 `a*b` 这类内容吃掉）；
 *   ③ `title` 等属性：属性里的星号是数据，不参与排版。
 */
const RICH_TEXT_SKIP = new Set(['pre', 'code', 'textarea', 'script', 'style']);

/**
 * 把一段文案切成节点数组：`**重点**` 变粗体，其余原样。
 *
 * `text:` 属性和**作为子节点传入的字符串**都走这里——
 * 只处理前者会漏掉一半调用点（`h('span', {}, '文案 **粗**')` 就是后者）。
 */
function richNodes(text) {
  const str = String(text ?? '');
  if (!str.includes('**')) return [document.createTextNode(str)];
  const parts = str.split(/\*\*([^*]+)\*\*/g);
  if (parts.length === 1) return [document.createTextNode(str)];
  const nodes = [];
  // split 带捕获组：偶数下标是普通文字，奇数下标是要加粗的内容
  parts.forEach((part, index) => {
    if (!part) return;
    nodes.push(index % 2 === 1 ? h('strong', { text: part }) : document.createTextNode(part));
  });
  return nodes;
}

function setRichText(el, tag, value) {
  const text = String(value ?? '');
  if (RICH_TEXT_SKIP.has(String(tag).toLowerCase())) {
    el.textContent = text;
    return;
  }
  el.append(...richNodes(text));
}

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      // 只设 on* 属性，不再 addEventListener：两者同时设置会让处理器在真实浏览器里触发两次
      // （linkedom 会去重，所以测试发现不了）。设属性同时让事件可被包装/替换，
      // 设置页「未保存」提示就是靠包装 oninput 实现的。
      el[key.toLowerCase()] = value;
    } else if (key === 'html') el.innerHTML = value;
    else if (key === 'text') setRichText(el, tag, value);
    else {
      el.setAttribute(key, value === true ? '' : String(value));
      // 表单控件的 value/checked 是「属性 → 属性(property)」单向同步的：
      // 只 setAttribute 对 <textarea> 完全无效（textarea 没有 value 属性），
      // 对已挂载的 <input> 也只会成为 defaultValue。这里显式同步，保证初值能显示出来。
      if (key === 'value' && (tag === 'textarea' || tag === 'input')) el.value = String(value);
      if (key === 'checked' && tag === 'input') el.checked = value === true;
    }
  }
  append(el, children);
  return el;
}

export function append(parent, children) {
  // pre/code/textarea 里的文字必须逐字原样（邮件正文、引用、代码）
  const literal = RICH_TEXT_SKIP.has(String(parent?.tagName || '').toLowerCase());
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    if (child instanceof Node) parent.append(child);
    else if (literal) parent.append(document.createTextNode(String(child)));
    else parent.append(...richNodes(child));
  }
  return parent;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function mount(el, ...children) {
  clear(el);
  append(el, children);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------ 格式化 */

/**
 * 展示时区。
 *
 * 默认用浏览器本地时区，但启动时会用后端 `/api/meta` 返回的 `calendar.timeZone` 覆盖它。
 * 原因：邮件与日程的时间语义属于**邮箱/日历所在时区**，如果用户在国外出差、
 * 或系统时区设成了 UTC，用浏览器时区渲染就会出现「邮件明明是中国时间下午 4 点，
 * 界面显示早上 8 点」这种自相矛盾的展示。
 */
let displayTimeZone = null;

/** 设置展示时区（boot 时调用一次）。传空值则回退浏览器本地时区。 */
export function setDisplayTimeZone(tz) {
  displayTimeZone = tz || null;
}

export function getDisplayTimeZone() {
  return displayTimeZone;
}

/** 按展示时区取出年月日时分（用 Intl 而不是 getHours，才能跨时区）。 */
function zonedParts(date, timeZone = displayTimeZone) {
  if (!timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const bag = {};
    for (const { type, value } of fmt.formatToParts(date)) {
      if (type !== 'literal') bag[type] = value;
    }
    return {
      year: Number(bag.year),
      // en-CA 给的是 24 小时制；某些实现在午夜给 "24"，这里归一化
      hour: Number(bag.hour) % 24,
      month: Number(bag.month),
      day: Number(bag.day),
      minute: Number(bag.minute),
    };
  } catch {
    // 时区名不被支持时退回本地时区，不要因为展示问题把页面搞崩
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
}

export function fmtTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  const p = (n) => String(n).padStart(2, '0');
  const t = zonedParts(d);
  return `${t.month}-${p(t.day)} ${p(t.hour)}:${p(t.minute)}`;
}

export function fmtFull(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const t = zonedParts(d);
  return `${t.year}-${p(t.month)}-${p(t.day)} ${p(t.hour)}:${p(t.minute)}`;
}

/**
 * 邮件列表用的时间：显示**发件时间**本身，而不是「3 小时前」。
 *
 * 为什么不用相对时间：邮件列表里「什么时候发的」本身就是关键信息
 * （要判断「今天必须回」还是「上周的已经过期」），而且用户明确要求看到发件时间。
 * 按邮箱客户端的惯例分级：今天只显示时刻，今年显示月日，更早显示完整日期。
 */
export function fmtMailTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const t = zonedParts(d);
  const hm = `${p(t.hour)}:${p(t.minute)}`;
  // 「今天」也必须按展示时区判断，否则跨时区时会把昨天当成今天
  const now = zonedParts(new Date());
  const sameDay = t.year === now.year && t.month === now.month && t.day === now.day;
  if (sameDay) return hm;
  if (t.year === now.year) return `${p(t.month)}-${p(t.day)} ${hm}`;
  return `${t.year}-${p(t.month)}-${p(t.day)} ${hm}`;
}

export function fmtBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = Number(bytes);
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function fmtAddress(addr) {
  if (!addr) return '未知';
  if (typeof addr === 'string') return addr;
  if (addr.name) return `${addr.name} <${addr.address}>`;
  return addr.address || '未知';
}

export function initials(addr) {
  const s = addr?.name || addr?.address || '?';
  const trimmed = String(s).trim();
  if (/[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(-2);
  return trimmed.slice(0, 2).toUpperCase();
}

/* ------------------------------------------------------------ Toast */

const URL_SPLIT_RE = /(https?:\/\/[^\s，。；：、"'）)】]+)/g;

/**
 * 把含 URL 的文本渲染成「文本 + 可点击链接」。
 * 后端错误里常带 Google 的启用链接，纯文本展示基本没法点，所以统一在这里转成链接。
 */
export function linkify(text) {
  return String(text ?? '')
    .split(URL_SPLIT_RE)
    .map((part, index) => {
      if (index % 2 === 1) {
        return h('a', { href: part, target: '_blank', rel: 'noreferrer noopener', text: part });
      }
      return document.createTextNode(part);
    });
}

let toastHost = null;

export function toast(message, type = 'info', timeout = 4200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: `toast toast-${type}` }, h('span', { class: 'toast-body' }, ...linkify(message)));
  toastHost.append(node);
  setTimeout(() => {
    node.classList.add('toast-out');
    setTimeout(() => node.remove(), 260);
  }, timeout);
  return node;
}

/**
 * 统一的 API 错误提示。
 * 「Google API 未启用」「到 Google 的网络不通」这两类错误必须给出可执行步骤，
 * 用弹窗保证能看清（toast 会被截断）。
 */
export function toastError(err) {
  const detail = err?.detail || {};
  if (err?.code === 'GOOGLE_API_DISABLED' && (detail.activationUrl || detail.project)) {
    showGoogleApiDisabled(detail);
    return;
  }
  if (err?.code === 'GOOGLE_NETWORK_ERROR' || detail.networkCode || detail.proxyError) {
    showGoogleNetworkHelp({ ...detail, message: err?.message || '' });
    return;
  }
  toast(err?.message || String(err), 'error', 9000);
}

/**
 * 「连不上 Google」的排查弹窗。
 *
 * 这类问题几乎都不是程序 bug：Node 不会自动使用系统代理，所以「浏览器能打开 Google、
 * 本程序不行」是常态。这里把原因、代码与下一步动作一次说清楚。
 */
function showGoogleNetworkHelp(detail) {
  const code = detail.networkCode || detail.proxyError || '';
  const reasons = {
    ENOTFOUND: 'DNS 解析失败：本机找不到这个域名（可能是没有外网 DNS 出口，或域名被污染）。',
    EAI_AGAIN: 'DNS 解析暂时失败，通常是本机网络/DNS 不稳定。',
    ECONNREFUSED: '连接被拒绝：目标端口（或你填的代理端口）没有服务在监听。',
    ETIMEDOUT: '连接超时：本机到这个地址的网络出口不通。国内网络访问 Google 必须走代理。',
    ECONNRESET: '连接被重置：常见于网络中间设备阻断了该连接。',
    PROXY_CONNECT_FAILED: '代理拒绝为这个地址建立隧道。',
    PROXY_AUTH_REQUIRED: '代理要求身份验证（407），请在代理地址里写成 http://用户名:密码@主机:端口。',
    PROXY_INVALID: '代理地址格式不对，正确写法如 http://127.0.0.1:7890。',
    PROXY_SOCKS_UNSUPPORTED: '不支持 SOCKS 代理，请填代理软件的 HTTP 端口。',
  };
  const reason = reasons[code] || detail.hint || '没有连上 Google。';
  const missingProxy = !detail.proxy && !detail.proxyError;

  const overlay = h(
    'div',
    { class: 'modal-overlay', onclick: (ev) => ev.target === overlay && overlay.remove() },
    h(
      'div',
      { class: 'modal modal-wide', role: 'dialog', 'aria-modal': 'true' },
      h('h3', { class: 'modal-title', text: '连不上 Google（日历服务）' }),
      h(
        'div',
        { class: 'modal-body' },
        h('p', { text: reason }),
        code ? h('p', { class: 'muted small mono', text: `错误代码：${code}` }) : null,
        h(
          'p',
          { class: 'muted small' },
          '注意：邮件与大模型走的是另一条网络路径，所以「邮件正常、日历报错」完全可能——它说明本机到 Google 的出口不通，而不是配置写错了。',
        ),
        h('h4', { class: 'form-section', text: '怎么解决' }),
        h(
          'ol',
          { class: 'setup-steps' },
          missingProxy
            ? h('li', { text: '本程序不会自动使用系统代理。先在代理/VPN 软件里确认「HTTP 代理」已开启，并记下端口（常见 7890 / 7897 / 10809）。' })
            : h('li', { text: `当前配置的代理是 ${detail.proxy || detail.proxyError}，请确认代理软件正在运行、端口正确、且允许访问 Google。` }),
          h('li', { text: '到「设置 → 日历数字人 → 网络代理（访问 Google 用）」填入，例如 http://127.0.0.1:7890，然后点「保存配置」。' }),
          h('li', { text: '回到这里重新点「测试连接」；自检里也会出现「Google 网络出口」这一项。' }),
          h('li', { text: '若代理软件只提供 SOCKS 端口，请改用它同时提供的 HTTP 端口（本程序暂不支持 SOCKS）。' }),
        ),
        h(
          'p',
          { class: 'muted small' },
          '提示：代理设置只作用于 Google（日历 / OAuth），不会影响你收发邮件和大模型的调用。',
        ),
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => overlay.remove() }, '知道了'),
        h(
          'button',
          {
            class: 'btn btn-primary',
            onclick: () => {
              overlay.remove();
              location.hash = '#/settings';
              // hash 相同时浏览器不会派发 hashchange，这里补一次，确保一定跳过去
              window.dispatchEvent(new window.Event('hashchange'));
            },
          },
          '去设置里填代理',
        ),
      ),
    ),
  );
  openModal(overlay);
}

function showGoogleApiDisabled(detail) {
  const overlay = h(
    'div',
    { class: 'modal-overlay', onclick: (ev) => ev.target === overlay && overlay.remove() },
    h(
      'div',
      { class: 'modal modal-wide', role: 'dialog', 'aria-modal': 'true' },
      h('h3', { class: 'modal-title', text: 'Google Calendar API 尚未启用' }),
      h(
        'div',
        { class: 'modal-body' },
        h(
          'p',
          { text: `你的 Google Cloud 项目${detail.project ? `（编号 ${detail.project}）` : ''}里还没有启用「Google Calendar API」。授权本身是成功的，只是这个接口还没打开。` },
        ),
        h(
          'ol',
          { class: 'setup-steps' },
          h('li', { text: '点下面的按钮打开 Google Cloud 的 API 库页面（已自动带上你的项目）' }),
          h('li', { text: '点蓝色的「启用」按钮' }),
          h('li', { text: '等待 1–2 分钟让配置生效（Google 提示可能更久，可稍后重试）' }),
          h('li', { text: '回到本页，重新点「确认写入日历」' }),
        ),
        detail.activationUrl
          ? h('p', { style: { marginTop: '12px' } }, h('a', { href: detail.activationUrl, target: '_blank', rel: 'noreferrer noopener', text: detail.activationUrl }))
          : null,
      ),
      h(
        'div',
        { class: 'modal-actions' },
        h('button', { class: 'btn', onclick: () => overlay.remove() }, '关闭'),
        detail.activationUrl
          ? h(
              'a',
              { class: 'btn btn-primary', href: detail.activationUrl, target: '_blank', rel: 'noreferrer noopener' },
              '打开启用页面',
            )
          : null,
      ),
    ),
  );
  openModal(overlay);
}

/** 简单确认弹窗（返回 Promise<boolean>）。 */
/**
 * 打开一个模态浮层：挂到 body、锁住页面滚动、把焦点移进弹窗。
 *
 * 锁滚动是"模态"的关键之一：否则用户能滚到弹窗背后的内容，
 * 在深色主题下遮罩本来就不明显，一滚就更看不出谁在上面。
 *
 * @param {HTMLElement} overlay 已构建好的 `.modal-overlay`
 * @returns {() => void} 关闭并解锁
 */
export function openModal(overlay) {
  if (!overlay) return () => {};
  const previous = document.activeElement;
  document.body.append(overlay);
  document.body.classList.add('modal-open');
  // 页面主体设为 inert：Tab 不会跑到背后的界面上（不支持时静默跳过）
  const appRoot = document.querySelector('.app');
  try {
    if (appRoot && 'inert' in appRoot) appRoot.inert = true;
  } catch {
    /* 忽略 */
  }
  let closed = false;
  return () => {
    if (closed) return;
    closed = true;
    try {
      if (appRoot && 'inert' in appRoot) appRoot.inert = false;
    } catch {
      /* 忽略 */
    }
    overlay.remove();
    // 还有别的弹窗开着就别解锁
    if (!document.querySelector('.modal-overlay')) document.body.classList.remove('modal-open');
    try {
      previous?.focus?.();
    } catch {
      /* 忽略 */
    }
  };
}

export function confirmDialog({ title, message, confirmText = '确认', cancelText = '取消', danger = false, details }) {
  return new Promise((resolve) => {
    let closeModal = () => {};
    const close = (value) => {
      document.removeEventListener('keydown', onKey);
      closeModal();
      resolve(value);
    };
    const onKey = (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation();
        close(false);
      }
    };
    const overlay = h(
      'div',
      { class: 'modal-overlay', onclick: (ev) => ev.target === overlay && close(false) },
      h(
        'div',
        { class: 'modal modal-confirm', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('h3', { class: 'modal-title', text: title }),
        h('div', { class: 'modal-body' }, typeof message === 'string' ? h('p', { text: message }) : message),
        details ? h('pre', { class: 'modal-details', text: details }) : null,
        h(
          'div',
          { class: 'modal-actions' },
          h('button', { class: 'btn', onclick: () => close(false) }, cancelText),
          h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => close(true) }, confirmText),
        ),
      ),
    );
    closeModal = openModal(overlay);
    document.addEventListener('keydown', onKey);
    setTimeout(() => overlay.querySelector('.modal-actions .btn-primary, .modal-actions .btn-danger')?.focus(), 30);
  });
}

export function el(tag, attrs, ...children) {
  return h(tag, attrs, ...children);
}

/* ------------------------------------------------------------ 交互小工具 */

/**
 * 复制文本到剪贴板。
 *
 * 优先用 `navigator.clipboard`（需要安全上下文，本应用跑在 127.0.0.1 上满足条件）；
 * 权限被拒或环境不支持时回退到隐藏 textarea + `document.execCommand('copy')`。
 * @returns {Promise<boolean>}
 */
export async function copyText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 落到下面的兜底 */
  }
  try {
    const area = document.createElement('textarea');
    area.value = value;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const ok = document.execCommand ? document.execCommand('copy') : false;
    area.remove();
    return !!ok;
  } catch {
    return false;
  }
}

/**
 * 把附件保存到本机。
 *
 * 优先用 **File System Access API**（`showSaveFilePicker`）：可以让用户**自己挑目录与文件名**，
 * 也就能做到"另存为到桌面/项目文件夹"。它只在 Chromium 系浏览器可用，且必须在用户手势里调用
 * （由按钮点击触发，满足条件）。
 * 其它浏览器（Firefox / Safari）没有这个能力，退化为**普通下载**——存到浏览器的默认下载目录，
 * 这是浏览器沙箱的硬限制，不是程序偷懒。
 *
 * @param {string} url 附件接口地址
 * @param {string} filename 建议文件名
 * @returns {Promise<{saved: boolean, mode: 'picker'|'download'|'cancelled'|'failed', bytes?: number, error?: string}>}
 */
export async function saveAttachment(url, filename) {
  const picker = typeof window !== 'undefined' ? window.showSaveFilePicker : null;
  if (typeof picker === 'function') {
    let handle = null;
    try {
      handle = await picker({ suggestedName: filename });
    } catch (err) {
      // 用户在"另存为"对话框里点了取消：不是错误，也不要再偷偷下载一份
      if (err?.name === 'AbortError') return { saved: false, mode: 'cancelled' };
      // 其它失败（如浏览器策略禁止）→ 走下面的普通下载
      handle = null;
    }
    if (handle) {
      try {
        const res = await fetch(url, { headers: authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return { saved: true, mode: 'picker', bytes: blob.size };
      } catch (err) {
        return { saved: false, mode: 'failed', error: err?.message || String(err) };
      }
    }
  }

  // 普通下载：浏览器自己决定落盘位置（默认下载目录）
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    setTimeout(() => a.remove(), 0);
    return { saved: true, mode: 'download' };
  } catch (err) {
    return { saved: false, mode: 'failed', error: err?.message || String(err) };
  }
}

/**
 * 附件下载按钮。带"保存中…"状态，避免用户连点。
 * @param {() => string} getUrl 延迟取地址
 * @param {string} filename
 */
export function attachmentButton(getUrl, filename) {
  const btn = h('button', { class: 'btn btn-small btn-attachment', title: `保存附件：${filename}` }, '保存');
  btn.onclick = async (ev) => {
    ev.stopPropagation();
    btn.disabled = true;
    btn.textContent = '保存中…';
    const out = await saveAttachment(getUrl(), filename);
    btn.disabled = false;
    btn.textContent = '保存';
    if (out.mode === 'cancelled') return;
    if (!out.saved) {
      toast(`保存失败：${out.error || '未知原因'}`, 'error', 7000);
      return;
    }
    toast(
      out.mode === 'download'
        ? '已交给浏览器下载（保存位置由浏览器的下载设置决定；Chrome/Edge 会弹出目录选择）'
        : `已保存：${filename}`,
      'success',
      4500,
    );
  };
  return btn;
}

export function copyButton(getText, { label = '复制', className = 'btn btn-small', title = '' } = {}) {
  const btn = h('button', { class: className, title: title || `复制${label}` }, label);
  btn.onclick = async (ev) => {
    // 行本身可能是可点的（打开详情），复制按钮不能连带触发
    ev.stopPropagation();
    const ok = await copyText(getText());
    if (!ok) {
      toast('复制失败，请手动选择文本', 'error');
      return;
    }
    btn.textContent = '已复制';
    btn.disabled = true;
    setTimeout(() => {
      btn.textContent = label;
      btn.disabled = false;
    }, 1600);
  };
  return btn;
}

/** 短暂高亮某个元素（用于「从统计卡片跳到分区」这类定位反馈）。 */
export function flash(node, className = 'flash-target') {
  if (!node) return;
  node.classList.add(className);
  setTimeout(() => node.classList.remove(className), 1600);
}

/** 平滑滚动到某个元素并高亮它。 */
export function scrollToEl(node, { block = 'start' } = {}) {
  if (!node) return;
  // 先判存在再调用：jsdom/linkedom 这类最小 DOM 没有 scrollIntoView，
  // 而「回退到无参调用」会把 TypeError 再抛一次。
  try {
    if (typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block });
  } catch {
    /* 不支持平滑滚动时忽略即可，定位本身不依赖它 */
  }
  flash(node);
}

/**
 * 让一个元素可被键盘操作（Enter / Space 触发）。
 * 列表行是 div，光有 onclick 键盘用户够不到。
 */
export function makeActivatable(node, onActivate, { label = '' } = {}) {
  node.setAttribute('role', 'button');
  node.setAttribute('tabindex', '0');
  if (label) node.setAttribute('aria-label', label);
  node.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') return;
    ev.preventDefault();
    onActivate(ev);
  });
  return node;
}
