/**
 * 纯 Node 生成自签 TLS 证书（不依赖 openssl，也不引入原生模块）。
 *
 * ## 为什么需要自己拼 DER
 *
 * 局域网加固要求"能用 HTTPS"，但不该强迫用户先去装 openssl 才能开启。
 * 项目又是零依赖路线，所以手工拼 DER 是唯一选择。它是**最小实现**，
 * 只包含浏览器真正会检查的东西：
 *
 *   - `subjectAltName`（SAN）——**现代浏览器只看 SAN，不看 CN**。
 *     只有 CN 的证书会被 Chrome/Edge/Safari 直接判为不匹配，等于白做。
 *   - 足够长的有效期（默认 825 天，Apple 对公共 CA 的上限，自签没那么严）。
 *   - `basicConstraints`（CA:FALSE）与 `keyUsage`/`extendedKeyUsage`（serverAuth）——
 *     有些客户端会检查这些。
 *
 * ## 它**不是**一个 CA
 *
 * 这是自签证书：浏览器一定会警告"不受信任"。它能保证的是**传输加密**
 * （同一局域网里的人抓不到明文），而不是"这个站点身份可信"。
 * 想要没有警告，就把自己的证书路径填进去（`web.https.certFile/keyFile`）。
 */

import crypto from 'node:crypto';

const tlv = (tag, content) => {
  const n = content.length;
  let lenBuf;
  if (n < 0x80) lenBuf = Buffer.from([n]);
  else {
    const bytes = [];
    let v = n;
    while (v > 0) {
      bytes.unshift(v & 0xff);
      v >>= 8;
    }
    lenBuf = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), lenBuf, content]);
};

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const int = (buf) => tlv(0x02, buf);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const ia5 = (s) => tlv(0x16, Buffer.from(s, 'ascii'));
const octet = (buf) => tlv(0x04, buf);
const oid = (hex) => tlv(0x06, Buffer.from(hex, 'hex'));
const bool = (v) => tlv(0x01, Buffer.from([v ? 0xff : 0x00]));
const utcTime = (date) => {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
};
const generalizedTime = (date) => {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x18, Buffer.from(s, 'ascii'));
};

// sha256WithRSAEncryption：OID + NULL，整体是一个 SEQUENCE
const SHA256_RSA = seq(oid('2a864886f70d01010b'), Buffer.from('0500', 'hex'));
const OID_CN = '550403';
const OID_SAN = '551d11';
const OID_BASIC = '551d13';
const OID_KEY_USAGE = '551d0f';
const OID_EXT_KEY_USAGE = '551d25';

const isIpv4 = (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** GeneralName：dNSName 用 [2]、iPAddress 用 [7]（都是隐式标签，内容直接内联） */
function generalName(value) {
  const v = String(value).trim();
  if (isIpv4(v)) {
    return tlv(0x87, Buffer.from(v.split('.').map(Number)));
  }
  // IPv6 字面量：转成 16 字节
  if (v.includes(':')) {
    const hex = expandIpv6(v);
    if (hex) return tlv(0x87, Buffer.from(hex, 'hex'));
  }
  return tlv(0x82, Buffer.from(v, 'ascii'));
}

function expandIpv6(input) {
  const s = input.replace(/^\[|\]$/g, '');
  const [head, tail] = s.split('::');
  const parse = (part) => (part ? part.split(':').filter(Boolean) : []);
  let groups = parse(head);
  if (tail !== undefined) {
    const t = parse(tail);
    const fill = 8 - groups.length - t.length;
    if (fill < 0) return null;
    groups = [...groups, ...Array(fill).fill('0'), ...t];
  }
  if (groups.length !== 8) return null;
  return groups.map((g) => g.padStart(4, '0')).join('');
}

/**
 * 造一张自签证书。
 *
 * @param {object} options
 * @param {string} [options.commonName] 主要名称（同时会写进 SAN）
 * @param {string[]} [options.altNames] 额外的 SAN（域名或 IP）
 * @param {number} [options.days] 有效期天数
 * @returns {{key: string, cert: string, commonName: string, altNames: string[], notAfter: string, fingerprint256: string}}
 */
export function makeSelfSignedCert({ commonName = 'localhost', altNames = [], days = 825 } = {}) {
  const names = [...new Set([commonName, ...altNames].map((s) => String(s).trim()).filter(Boolean))];
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });

  /*
   * Name ::= SEQUENCE OF RDN，而每个 RDN 是 **SET** OF AttributeTypeAndValue。
   * 中间的 set 不能写成 seq —— 否则 OpenSSL 报 "wrong tag"。
   */
  const name = seq(set(seq(oid(OID_CN), utf8(commonName))));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 5 * 60_000);
  const notAfter = new Date(now.getTime() + days * 86_400_000);
  /*
   * 序列号：必须是一个**最短编码**的 DER INTEGER。
   *
   *   - INTEGER 是**有符号**的，首字节最高位为 1 会被读成负数，所以先掩成 0x7f；
   *   - 但掩位有 1/128 的概率把首字节变成 **0x00**，那就多出一个"冗余前导零"——
   *     DER 不允许（只有当下一个字节最高位为 1 时，前导 0x00 才是必需的）。
   *
   * 这不是纸上谈兵：OpenSSL 3.x 会**直接拒收**整张证书，报
   * `ERR_OSSL_ASN1_ILLEGAL_PADDING : asn1 encoding routines::illegal padding`。
   * CI 上就是这么偶发红的（`test (windows-latest / node 22)` 的"启用 HTTPS 后真的走 TLS"），
   * 本机压测 300 次复现 2 次；把首字节强制成 0x00 时几乎必现，强制成 0x01 时 5/5 通过。
   * 所以这里**重摇**到首字节非零为止，而不是把非法编码交给运气。
   */
  let serial;
  do {
    serial = crypto.randomBytes(8);
    serial[0] &= 0x7f;
  } while (serial[0] === 0);

  const extensions = seq(
    // basicConstraints: CA=FALSE（critical）
    seq(oid(OID_BASIC), bool(true), octet(seq())),
    // keyUsage: digitalSignature | keyEncipherment（critical）
    seq(oid(OID_KEY_USAGE), bool(true), octet(tlv(0x03, Buffer.from([0x05, 0xa0])))),
    // extendedKeyUsage: serverAuth
    seq(oid(OID_EXT_KEY_USAGE), octet(seq(oid('2b06010505070301')))),
    // subjectAltName：浏览器真正看的就是它
    seq(oid(OID_SAN), octet(seq(...names.map(generalName)))),
  );

  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // version v3
    int(serial),
    SHA256_RSA,
    name, // issuer（自签：与 subject 相同）
    seq(
      // 2050 之后必须用 GeneralizedTime，这里按年份自动选
      notBefore.getUTCFullYear() >= 2050 ? generalizedTime(notBefore) : utcTime(notBefore),
      notAfter.getUTCFullYear() >= 2050 ? generalizedTime(notAfter) : utcTime(notAfter),
    ),
    name, // subject
    spki,
    tlv(0xa3, extensions), // [3] EXPLICIT Extensions
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  /*
   * PEM 正文每行 64 字符。
   *
   * ⚠️ 这里的 `(?=.)` 不是装饰：写成 `replace(/(.{64})/g, '$1\n')` 时，**base64 长度正好是 64 的整数倍**
   * 的那一档会在末尾多出一个换行，而模板里紧接着又有一个 `\n`，于是 BEGIN/END 之间多出一个**空行**——
   * OpenSSL 读到空行就停了，DER 被截断，整张证书被拒收。
   *
   * 这不是理论：本机实测（证书 DER 767 字节 → base64 恰好 1024 = 16×64）
   * `tls.createSecureContext` 报 `SSL_CTX_use_certificate_chain`、`new X509Certificate()` 报
   * `ERR_OSSL_ASN1_WRONG_TAG ... wrong tag`；把 commonName 改一个字母（DER 761 字节 → base64 1016）
   * 立刻就好。而这个长度由**允许的域名/IP 列表**决定，也就是说约 1/16 的配置会撞上——
   * 用户开启 HTTPS 后证书直接被拒，正是 CI 上"启用 HTTPS 后真的走 TLS"偶发红的那一类。
   */
  const b64 = (buf) => buf.toString('base64').replace(/(.{64})(?=.)/g, '$1\n');

  return {
    commonName,
    altNames: names,
    notAfter: notAfter.toISOString(),
    fingerprint256: fingerprintOf(certDer),
    key: `-----BEGIN PRIVATE KEY-----\n${b64(privateKey.export({ type: 'pkcs8', format: 'der' }))}\n-----END PRIVATE KEY-----\n`,
    cert: `-----BEGIN CERTIFICATE-----\n${b64(certDer)}\n-----END CERTIFICATE-----\n`,
  };
}

/** 证书指纹（SHA-256，冒号分隔的大写十六进制，与浏览器/openssl 显示一致）。 */
export function fingerprintOf(certDerOrPem) {
  const der = Buffer.isBuffer(certDerOrPem)
    ? certDerOrPem
    : Buffer.from(
        String(certDerOrPem)
          .replace(/-----[^-]+-----/g, '')
          .replace(/\s+/g, ''),
        'base64',
      );
  return crypto
    .createHash('sha256')
    .update(der)
    .digest('hex')
    .toUpperCase()
    .replace(/(..)(?=.)/g, '$1:');
}
