/**
 * 极简 Markdown 渲染（标题/列表/加粗/行内代码/引用/分隔线）。
 * 所有文本先转义，确保模型输出不会注入 HTML。
 */

function esc(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>');
}

export function renderMarkdown(markdown) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let listType = null;

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      closeList();
      continue;
    }
    if (/^<!--/.test(line.trim())) continue;
    if (/^---+$/.test(line.trim())) {
      closeList();
      out.push('<hr>');
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = Math.min(6, heading[1].length + 2); // h1 → h3，避免与页面标题冲突
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        out.push('<ol>');
        listType = 'ol';
      }
      out.push(`<li>${inline(ordered[1])}</li>`);
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        out.push('<ul>');
        listType = 'ul';
      }
      out.push(`<li>${inline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('\n');
}

/** 从简报里抽出「一句话总结」段落。 */
export function extractSummaryParagraph(markdown) {
  if (!markdown) return '';
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  const idx = lines.findIndex((l) => /^##\s*一句话总结/.test(l.trim()));
  const candidates = idx >= 0 ? lines.slice(idx + 1) : lines;
  for (const line of candidates) {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('>') || t.startsWith('<!--')) continue;
    return t.replace(/^[-*]\s*/, '');
  }
  return '';
}
