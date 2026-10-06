/**
 * 邮件签名处理。
 *
 * 签名（含姓名、电话、地址、安全提示等）属于必须逐字固定的内容，不能交给模型即兴生成，
 * 否则每次措辞可能不同、甚至漏掉安全提示。因此：
 *   - 模型只写正文与敬语，不写署名；
 *   - 由本模块在「起草 / 重新起草」时确定性地追加签名；
 *   - 发送时直接复用草稿正文，不再二次追加（避免出现两个签名）。
 *
 * **位置规则**：回复正文的顺序固定为「新正文 → 签名 → 引文」。
 * 因此判断「有没有签名」不能只看正文是否**以签名结尾**——引文会跟在签名后面。
 * 早期版本用 `endsWith` 判断，加了引文之后就出现了
 * 「横幅一直提示缺签名，点「插入签名」却毫无反应」的死循环。
 */

const ZH_QUOTE_MARKER = '------------------ 原始邮件 ------------------';
const PREFIX_QUOTE_RE = /^在 .+ 写道：$/m;

/** 正文里引文块开始的位置（找不到返回 -1）。 */
export function quoteStartIndex(body) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const zh = text.indexOf(ZH_QUOTE_MARKER);
  const prefix = PREFIX_QUOTE_RE.exec(text);
  const candidates = [zh, prefix ? prefix.index : -1].filter((i) => i >= 0);
  return candidates.length ? Math.min(...candidates) : -1;
}

/** 正文是否包含指定签名。 */
export function hasSignature(body, signature) {
  const sign = normalizeSignature(signature);
  if (!sign) return false;
  return String(body ?? '')
    .replace(/\r\n/g, '\n')
    .includes(sign);
}

/**
 * 检查签名位置。
 * @returns {{present: boolean, ok: boolean, misplaced: boolean, index: number, quoteIndex: number}}
 */
export function inspectSignatureOrder(body, signature) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const sign = normalizeSignature(signature);
  const quoteIndex = quoteStartIndex(text);
  if (!sign) return { present: false, ok: false, misplaced: false, index: -1, quoteIndex };
  const index = text.indexOf(sign);
  const present = index >= 0;
  // 有引文时，签名必须出现在引文之前；没有引文时只要存在即可
  const misplaced = present && quoteIndex >= 0 && index > quoteIndex;
  return { present, ok: present && !misplaced, misplaced, index, quoteIndex };
}

/**
 * 把签名块拼接到正文的**正确位置**：正文 → 空行 → 签名 → （原有的引文）。
 *
 * - 已包含同一签名 → 原样返回（幂等）；
 * - 引文已在正文里 → 插到引文**之前**（而不是文末，否则签名会跑到引文下面）；
 * - 正文末尾若是旧版的"裸姓名行" → 交给 upgradeLegacySignature 处理。
 *
 * @param {string} body
 * @param {string} signature
 * @returns {string}
 */
export function appendSignature(body, signature) {
  const text = cleanBody(body);
  const sign = normalizeSignature(signature);
  if (!text) return sign;
  if (!sign) return text;
  // 幂等：已包含签名就不再追加（注意不是 endsWith——引文可能在签名之后）
  if (text.includes(sign)) return text;
  return insertSignature(text, sign);
}

/** 把签名插到引文之前（没有引文就追加到末尾）。 */
function insertSignature(text, sign) {
  const at = quoteStartIndex(text);
  if (at < 0) return `${text}\n\n${sign}`;
  const head = text.slice(0, at).trimEnd();
  const tail = text.slice(at).trimStart();
  return `${head}\n\n${sign}\n\n${tail}`;
}

/**
 * 把「被引文挤到下面」的签名搬回引文之前。
 * @returns {{body: string, moved: boolean}}
 */
export function fixSignatureOrder(body, signature) {
  const text = cleanBody(body);
  const sign = normalizeSignature(signature);
  if (!sign) return { body: text, moved: false };
  const order = inspectSignatureOrder(text, sign);
  if (!order.misplaced) return { body: text, moved: false };
  // 先把引文里的那份删掉，再插到引文之前
  const withoutSign = `${text.slice(0, order.index)}${text.slice(order.index + sign.length)}`;
  return { body: insertSignature(cleanBody(withoutSign), sign), moved: true };
}

function cleanBody(body) {
  return String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    // 连续 3 行以上空行一定是编辑残留（例如剥掉签名后留下的空洞）
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/**
 * 移除正文末尾的签名块（重新起草前调用，避免签名被送进模型并在结果里重复）。
 * 只移除「完全匹配当前配置」的签名；用户手改过签名时会保留，由其自行处理。
 */
export function stripSignature(body, signature) {
  const text = String(body ?? '').replace(/\r\n/g, '\n').trimEnd();
  const sign = normalizeSignature(signature);
  if (!sign) return text;
  const order = inspectSignatureOrder(text, sign);
  if (!order.present) return text;
  // 签名可能在引文之前（正常）或之后（异常），两处都要能剥掉
  return cleanBody(`${text.slice(0, order.index)}${text.slice(order.index + sign.length)}`);
}

/**
 * 兼容「旧草稿只写了姓名」的情况：若正文末尾是一行纯姓名（且该姓名正是新签名的首行名），
 * 把它替换为完整签名，而不是简单追加，避免出现「张三」+「张三 | 示例事业部」两行。
 *
 * @param {string} body
 * @param {string} signature 新签名
 * @param {string} [senderName] 发件人姓名（用于识别旧姓名行）
 * @returns {{body: string, replaced: boolean}}
 */
export function upgradeLegacySignature(body, signature, senderName) {
  const text = cleanBody(body);
  const sign = normalizeSignature(signature);
  if (!sign) return { body: text, replaced: false };
  if (text.includes(sign)) return { body: text, replaced: false };

  // 只在「引文之前的那段」里找旧姓名行，否则会把引文里的署名误判成待替换的姓名
  const at = quoteStartIndex(text);
  const head = at < 0 ? text : text.slice(0, at).trimEnd();
  const tail = at < 0 ? '' : text.slice(at).trimStart();
  const lines = head.split('\n');
  let last = lines.length - 1;
  while (last >= 0 && !lines[last].trim()) last -= 1;
  if (last < 0) return { body: text, replaced: false };

  const lastLine = lines[last].trim();
  const headLine = sign.split('\n')[0].trim();
  // 旧姓名行：整行就是姓名（新旧一致，或等于配置的发件人姓名）
  const nameOfHead = headLine.split(/[|｜]/)[0].trim();
  const isBareName =
    lastLine.length > 0 &&
    lastLine.length <= 12 &&
    !/[，。：:；;]/.test(lastLine) &&
    (lastLine === nameOfHead || (senderName && lastLine === String(senderName).trim()));
  if (!isBareName) return { body: text, replaced: false };

  const kept = lines.slice(0, last).join('\n').trimEnd();
  const withSign = kept ? `${kept}\n\n${sign}` : sign;
  return { body: tail ? `${withSign}\n\n${tail}` : withSign, replaced: true };
}

/**
 * 归一化签名：
 *   - 统一换行、去掉行尾空白
 *   - 去掉各行「公共的」前导缩进（避免从别处粘贴时整体缩进，同时保留有意为之的相对缩进）
 *   - 压缩连续空行
 */
export function normalizeSignature(signature) {
  const lines = String(signature ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));

  // 计算公共缩进（忽略空行）
  let indent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  const stripped = Number.isFinite(indent) && indent > 0 ? lines.map((line) => (line.trim() ? line.slice(indent) : line)) : lines;

  return stripped.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 签名块首行（用于日志与界面提示）。 */
export function signatureHeadline(signature) {
  const sign = normalizeSignature(signature);
  if (!sign) return '';
  return sign.split('\n')[0];
}
