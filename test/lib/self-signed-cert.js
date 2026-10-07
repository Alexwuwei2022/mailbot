/**
 * 用纯 Node 造一张最小自签证书（不依赖 openssl / cryptography）。
 *
 * 为什么需要它：验证「经 HTTP 代理访问 HTTPS」这条路径是否真的用上了 CONNECT 隧道，
 * 必须有一个真的 HTTPS 目标。这台机器没有 openssl，Python 也没装 cryptography，
 * 所以手工拼 DER 生成一张 CN=target.invalid 的自签证书。
 *
 * 只用于本地测试：目标主机名是一个永不解析的域名，配合假代理即可判定
 * "隧道到底有没有被使用"。
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
const utcTime = (date) => {
  const p = (n) => String(n).padStart(2, '0');
  const s = `${p(date.getUTCFullYear() % 100)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
};

// sha256WithRSAEncryption：OID + NULL，整体是一个 SEQUENCE
const SHA256_RSA = seq(Buffer.from('06092a864886f70d01010b', 'hex'), Buffer.from('0500', 'hex'));
// CN 的 OID
const CN = Buffer.from('0603550403', 'hex');

/** @returns {{key: string, cert: string, commonName: string}} */
export function makeSelfSignedCert(commonName = 'target.invalid') {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  /*
   * Name ::= SEQUENCE OF RDN，而每个 RDN 是 **SET** OF AttributeTypeAndValue。
   * 这里中间的 set 不能写成 seq —— 否则 OpenSSL 报 "wrong tag"。
   */
  const name = seq(set(seq(CN, utf8(commonName))));
  const now = new Date();
  /*
   * 序列号必须是**最短编码**的 DER INTEGER：INTEGER 有符号，先掩成 0x7f；
   * 而掩位有 1/128 的概率把首字节变成 0x00，那会多出一个"冗余前导零"，OpenSSL 3.x
   * 直接拒收整张证书（`ERR_OSSL_ASN1_ILLEGAL_PADDING`）。所以重摇到首字节非零。
   * 同一处修复也在 server/lib/x509.js（那份是真正在用的，这份是测试夹具）。
   */
  let serial;
  do {
    serial = crypto.randomBytes(8);
    serial[0] &= 0x7f; // 正数
  } while (serial[0] === 0);

  const tbs = seq(
    tlv(0xa0, int(Buffer.from([2]))), // version v3
    int(serial),
    SHA256_RSA,
    name, // issuer
    seq(utcTime(new Date(now.getTime() - 60_000)), utcTime(new Date(now.getTime() + 86_400_000))),
    name, // subject
    spki,
  );
  const signature = crypto.sign('sha256', tbs, privateKey);
  const certDer = seq(tbs, SHA256_RSA, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  // PEM 正文每行 64 字符；`(?=.)` 保证 base64 长度正好整除 64 时**不会**多留一个空行
  //（空行会让 OpenSSL 停读、DER 被截断 —— 同一处修复见 server/lib/x509.js 的详细说明）
  const b64 = (buf) => buf.toString('base64').replace(/(.{64})(?=.)/g, '$1\n');
  return {
    commonName,
    key: `-----BEGIN PRIVATE KEY-----\n${b64(privateKey.export({ type: 'pkcs8', format: 'der' }))}\n-----END PRIVATE KEY-----\n`,
    cert: `-----BEGIN CERTIFICATE-----\n${b64(certDer)}\n-----END CERTIFICATE-----\n`,
  };
}
