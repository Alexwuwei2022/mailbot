/**
 * 最小 ZIP 读写（**纯 Node，零依赖**）。
 *
 * ## 为什么要自己写
 *
 * 备份要给出一个"双击就能打开"的压缩包，而本项目刻意只有 3 个运行时依赖
 * （imapflow / mailparser / nodemailer）。为了导出去引一个压缩库不划算，
 * 而 Node 自带 `zlib` 已经提供了 deflate —— 缺的只是 ZIP 那层容器格式。
 *
 * 支持范围（刻意只做需要的子集）：
 *   - 压缩方法 0（store）与 8（deflate）；
 *   - UTF-8 文件名（通用标志位 bit 11）—— 备份里有中文文件名；
 *   - 读取时校验 CRC32，解出的内容不对就报错，绝不"静默给出坏数据"。
 *
 * 不支持的（遇到就明确报错，而不是猜）：ZIP64、加密、多卷、data descriptor。
 */

import zlib from 'node:zlib';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/** 通用标志位：bit 11 = 文件名是 UTF-8 */
const FLAG_UTF8 = 0x0800;

/* ------------------------------------------------------------------ CRC32 */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ 写 */

/** 把 Date 转成 DOS 时间（ZIP 用的老格式，秒精度 2 秒）。 */
function dosDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date: day };
}

/**
 * 生成 ZIP。
 *
 * @param {Array<{name: string, data: Buffer|string, date?: Date}>} entries
 * @param {object} [options] { compress: boolean } 默认压缩（文本压缩率很高）
 * @returns {Buffer}
 */
export function createZip(entries, { compress = true } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    const crc = crc32(raw);
    let method = METHOD_STORE;
    let body = raw;
    if (compress && raw.length > 0) {
      const deflated = zlib.deflateRawSync(raw, { level: 6 });
      // 压不小就别压（小文件常见），store 更省事也更快
      if (deflated.length < raw.length) {
        method = METHOD_DEFLATE;
        body = deflated;
      }
    }
    const { time, date } = dosDateTime(entry.date);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(SIG_LOCAL, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(SIG_CENTRAL, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(FLAG_UTF8, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    // 外部属性：普通文件 0644。注意 `<<` 是**有符号** 32 位运算，
    // 0o100644 << 16 会变成负数，这里必须 >>> 0 转回无符号。
    cd.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/* ------------------------------------------------------------------ 读 */

function findEocd(buf) {
  // 从尾部往前找 EOCD（注释最长 65535，所以最多回退 64KB + 22）
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 读取 ZIP。
 *
 * @param {Buffer} buf
 * @returns {Array<{name: string, data: Buffer, size: number}>}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) {
    throw new Error('不是有效的 ZIP：内容太短');
  }
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 ZIP：找不到结尾标记（EOCD）');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = [];

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(ptr) !== SIG_CENTRAL) throw new Error(`ZIP 中央目录第 ${i + 1} 项损坏`);
    const method = buf.readUInt16LE(ptr + 10);
    const crc = buf.readUInt32LE(ptr + 16);
    const csize = buf.readUInt32LE(ptr + 20);
    const usize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOffset) !== SIG_LOCAL) throw new Error(`ZIP 项「${name}」的本地头损坏`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(dataStart, dataStart + csize);

    let data;
    if (method === METHOD_STORE) data = Buffer.from(body);
    else if (method === METHOD_DEFLATE) data = zlib.inflateRawSync(body);
    else throw new Error(`ZIP 项「${name}」使用了不支持压缩方式（${method}）；目前只支持 store 与 deflate`);

    if (data.length !== usize) throw new Error(`ZIP 项「${name}」长度不符：期望 ${usize}，实际 ${data.length}`);
    if (crc32(data) !== crc) throw new Error(`ZIP 项「${name}」校验失败（CRC32 不符），文件可能已损坏`);
    entries.push({ name, data, size: usize });
  }
  return entries;
}

/**
 * 校验条目名是否安全（防 zip-slip）。
 *
 * 导入的是**用户从外部拿来的文件**，必须假设它是恶意的：
 * `../../.env` 这类名字被拼进路径就会写到数据目录之外。
 */
export function isSafeEntryName(name) {
  const n = String(name || '');
  if (!n) return false;
  if (n.startsWith('/') || n.startsWith('\\')) return false;
  if (/^[a-zA-Z]:/.test(n)) return false; // Windows 绝对路径
  if (n.split(/[\\/]/).some((seg) => seg === '..')) return false;
  if (n.includes('\0')) return false;
  return true;
}
