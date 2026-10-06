/**
 * 邮件 HTML 正文的安全渲染（零依赖，跑在浏览器里）。
 *
 * ## 为什么必须自己净化
 *
 * 邮件 HTML 是**外部输入**，可以包含任何东西：`<script>`、`onerror=`、
 * `javascript:` 链接、被 iframe 套住的钓鱼表单、以及用来追踪"你打开了吗"的远程图片。
 * 我们不需要一个完整的 HTML 渲染器，只需要**白名单**：不在名单里的一律丢掉。
 *
 * 白名单比黑名单可靠得多——黑名单永远漏（新的标签、新的属性、编码绕过），
 * 而白名单的策略是"没被明确允许的就是不允许"。
 *
 * ## 三个刻意的决定
 *
 * 1. **默认阻断远程图片**。这不是洁癖：邮件里的 `<img src="https://tracker/...">`
 *    一旦加载，对方立刻知道你**何时、用哪个 IP、打开了几次**。
 *    所以默认把图片替换成占位符，用户点了「显示图片」才真的去取。
 *    内联图片（`cid:` 附件）不受影响——它本来就在本机。
 *
 * 2. **丢掉所有 `style` 属性**。CSS 能做的事远超"改个颜色"：
 *    `background:url(...)` 同样能追踪、`position:fixed` 能盖住界面做点击劫持。
 *    保留结构标签（表格、列表、标题）已经足够让邮件可读。
 *    代价是排版会朴素一些——这是刻意换取的安全。
 *
 * 3. **危险标签连同内容一起删掉**（`script`/`style`/`iframe`/`form`），
 *    其余不认识的标签只**拆掉标签本身、保留里面的文字**——
 *    这样即使遇到没见过的标签，用户也还能看到内容，不会整封变空白。
 */

/** 允许保留的标签。不在名单里的一律拆掉（保留文字）。 */
const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'caption', 'code', 'dd', 'div', 'dl', 'dt', 'em',
  'figcaption', 'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img',
  'li', 'ol', 'p', 'pre', 'q', 's', 'small', 'span', 'strike', 'strong', 'sub',
  'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

/** 危险标签：连内容一起删（留着内容也没有意义，甚至有害）。 */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'form', 'input', 'button', 'select', 'option', 'textarea', 'link', 'meta',
  'base', 'svg', 'math', 'video', 'audio', 'source', 'track', 'canvas', 'template',
]);

/** 各标签允许保留的属性。没有列的标签只保留极少通用属性。 */
const ALLOWED_ATTRS = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'title', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  table: ['border', 'cellpadding', 'cellspacing'],
  '*': ['title', 'dir', 'lang'],
};

/** 允许的 URL 协议（href 用）。 */
const SAFE_HREF = /^(https?:|mailto:)/i;
/** 允许的图片地址：网络图片 + 内联附件（cid:）+ data:image。 */
const SAFE_IMG = /^(https?:|cid:|data:image\/)/i;

/**
 * 判断一个属性值里的 URL 是否安全。
 *
 * 必须先把控制字符与空白剥掉再判断：`java\tscript:`、`java\nscript:`、
 * ` javascript:` 都是能绕过朴素字符串匹配的经典写法。
 */
export function isSafeUrl(value, { forImage = false } = {}) {
  const v = String(value || '')
    .replace(/[\u0000-\u0020\u007f]+/g, '')
    .trim();
  if (!v) return false;
  return forImage ? SAFE_IMG.test(v) : SAFE_HREF.test(v);
}

/** 结果里带上"拦了多少张远程图"，界面才能给用户一个明确的提示。 */
export function sanitizeMailHtml(html, { allowRemoteImages = false } = {}) {
  const out = { html: '', blockedImages: 0, removedScripts: 0, removedForms: 0, dropped: 0 };
  if (!html || typeof html !== 'string') return out;

  /*
   * 用一个游离的 div 解析，而不是 DOMParser。
   *
   * 两个理由：
   *   ① `div.innerHTML = html` 在浏览器里**不会执行**脚本（这点和 DOMParser 一样安全），
   *      而且它本来就是"片段"语义，不会凭空造出 head/body；
   *   ② 实测 linkedom（测试环境用的轻量 DOM）的 DOMParser 不完整：它会把片段内容
   *      丢到 body **外面**，于是遍历 body 什么都拿不到、整封邮件渲染成空白。
   *
   * 取不到 document 就返回空结果——调用方会退回纯文本，不会把页面弄崩。
   */
  const doc = globalThis.document || globalThis.window?.document;
  if (!doc?.createElement) return out;
  const root = doc.createElement('div');
  root.innerHTML = String(html);

  const walk = (node) => {
    for (const child of [...node.childNodes]) {
      // 文本节点：直接留着（浏览器不会把文本当标签解析）
      if (child.nodeType === 3) continue;
      if (child.nodeType !== 1) {
        child.remove();
        continue;
      }
      const tag = child.tagName.toLowerCase();

      if (DROP_WITH_CONTENT.has(tag)) {
        if (tag === 'script') out.removedScripts += 1;
        if (tag === 'form' || tag === 'input' || tag === 'button') out.removedForms += 1;
        child.remove();
        continue;
      }

      if (!ALLOWED_TAGS.has(tag)) {
        /*
         * 不认识的标签：**只拆标签、保留内容**。
         * 直接删掉整棵子树会让用户看到一封空白邮件，而我还不知道对方写了什么——
         * 那是"安全"过头变成了"不可用"。
         */
        out.dropped += 1;
        walk(child);
        const parent = child.parentNode;
        if (parent) {
          while (child.firstChild) parent.insertBefore(child.firstChild, child);
          child.remove();
        }
        continue;
      }

      // 属性白名单
      const allow = new Set([...(ALLOWED_ATTRS[tag] || []), ...ALLOWED_ATTRS['*']]);
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (!allow.has(name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        if (name === 'href' && !isSafeUrl(attr.value)) {
          // 危险链接：去掉 href，保留文字（用户至少知道这里原本有个链接）
          child.removeAttribute('href');
          child.setAttribute('data-blocked-href', '1');
          continue;
        }
        if (name === 'src') {
          const isCid = /^cid:/i.test(String(attr.value).trim());
          if (!isSafeUrl(attr.value, { forImage: true })) {
            child.removeAttribute('src');
            continue;
          }
          /*
           * 远程图片默认不加载：把地址挪到 data-blocked-src，
           * 用户点「显示图片」时再换回来（见 restoreImages）。
           * cid: 是内联附件，本来就在本机，不算"对外发请求"，直接放行。
           */
          if (!allowRemoteImages && !isCid) {
            child.removeAttribute('src');
            child.setAttribute('data-blocked-src', attr.value);
            out.blockedImages += 1;
          }
        }
      }

      if (tag === 'a' && child.getAttribute('href')) {
        // 外链一律新窗口打开，并切断 opener（否则对方页面能操作本页）
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }

      walk(child);
    }
  };

  walk(root);
  out.html = root.innerHTML;
  return out;
}

/**
 * 恢复被拦下的远程图片（用户点了「显示图片」）。
 *
 * 在**已经净化过的** HTML 上操作，所以不用再走一遍白名单。
 */
export function restoreImages(container) {
  let restored = 0;
  for (const img of container.querySelectorAll('img[data-blocked-src]')) {
    const src = img.getAttribute('data-blocked-src');
    if (src && isSafeUrl(src, { forImage: true })) {
      img.setAttribute('src', src);
      restored += 1;
    }
    img.removeAttribute('data-blocked-src');
  }
  return restored;
}

/** 把已净化的 HTML 挂进容器（唯一入口，避免别处绕过净化）。 */
export function renderMailHtml(container, html, options) {
  const result = sanitizeMailHtml(html, options);
  container.innerHTML = result.html;
  return result;
}
