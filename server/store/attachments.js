/**
 * 草稿附件存取。
 *
 * 设计要点：
 *   1. **内容落盘、元数据进 state.json**。附件可能十几 MB，塞进 state.json 会让
 *      每次读写状态都付出巨大代价；state 里只留 `{id, filename, contentType, size, file}`。
 *   2. `file` 只存**文件名**（不含目录）。数据目录可以整体搬家（文档里就有"迁移到另一台电脑"），
 *      存绝对路径一搬家就全失效。
 *   3. 落盘文件名一律是 `id__安全文件名`：id 由程序生成、全局唯一，
 *      用户可控的文件名只作为"可读后缀"，即使含有奇怪字符也影响不到磁盘布局。
 *   4. 不留孤儿：删除草稿、删除附件都会同步删文件；发送成功后会清掉内容（记录保留，
 *      用于展示"这封发出去了什么"），避免 data/attachments 无限增长。
 */

import fs from 'node:fs';
import path from 'node:path';
import { getPaths } from '../config/index.js';
import { log, newId } from '../lib/util.js';
import { safeFilename } from '../mail/parse.js';

/** base64 编码后的体积（含换行）。用于发送前的体积校验。 */
export function encodedSizeOf(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  // base64：每 3 字节 → 4 字符；再按每 76 字符加一个 CRLF 估算换行开销
  const base64Chars = Math.ceil(n / 3) * 4;
  const lineBreaks = Math.ceil(base64Chars / 76) * 2;
  return base64Chars + lineBreaks;
}

/** 一组附件的编码后总体积 + 每个 MIME 分部的固定开销（约 200 字节）。 */
export function totalEncodedSize(attachments) {
  return (attachments || []).reduce((sum, a) => sum + encodedSizeOf(a.size) + 200, 0);
}

function ensureDir() {
  const dir = getPaths().attachmentsDir;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 保存一个附件。
 * @param {object} input { filename, contentType, buffer }
 * @returns {{id: string, filename: string, contentType: string, size: number, file: string, savedAt: string}}
 */
export function saveAttachmentFile({ filename, contentType, buffer }) {
  const dir = ensureDir();
  const id = newId('att');
  const safe = safeFilename(filename, 'attachment');
  const file = `${id}__${safe}`;
  fs.writeFileSync(path.join(dir, file), buffer);
  return {
    id,
    filename: safe,
    contentType: String(contentType || 'application/octet-stream').split(';')[0].trim() || 'application/octet-stream',
    size: buffer.length,
    file,
    savedAt: new Date().toISOString(),
  };
}

/**
 * 读取附件内容。
 * @returns {Buffer|null}
 */
export function readAttachmentFile(attachment) {
  const file = attachment?.file;
  if (!file) return null;
  // 只允许 data/attachments 下的直接子文件：`file` 来自 state.json，
  // 但状态文件也是磁盘上的数据，多一道"不许越出目录"的校验成本极低。
  const dir = getPaths().attachmentsDir;
  const full = path.resolve(dir, path.basename(file));
  if (path.dirname(full) !== path.resolve(dir)) return null;
  try {
    return fs.readFileSync(full);
  } catch (err) {
    log.warn(`读取附件失败（${file}）：${err?.message || err}`);
    return null;
  }
}

/** 删除附件内容。找不到不算错误（可能已经清理过）。 */
export function removeAttachmentFile(attachment) {
  const file = attachment?.file;
  if (!file) return false;
  const dir = getPaths().attachmentsDir;
  const full = path.resolve(dir, path.basename(file));
  if (path.dirname(full) !== path.resolve(dir)) return false;
  try {
    fs.unlinkSync(full);
    return true;
  } catch (err) {
    if (err?.code !== 'ENOENT') log.warn(`删除附件失败（${file}）：${err?.message || err}`);
    return false;
  }
}

/** 目录占用（供界面提示与排查用）。 */
export function attachmentsUsage() {
  const dir = getPaths().attachmentsDir;
  try {
    const names = fs.readdirSync(dir);
    let bytes = 0;
    for (const n of names) {
      try {
        bytes += fs.statSync(path.join(dir, n)).size;
      } catch {
        /* 忽略单个文件 */
      }
    }
    return { count: names.length, bytes };
  } catch {
    return { count: 0, bytes: 0 };
  }
}
