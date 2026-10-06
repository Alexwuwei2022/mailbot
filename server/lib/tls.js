/**
 * 决定"用不用 HTTPS、用哪张证书"。
 *
 * 两种来源：
 *   1. **用户自己的证书**（`web.https.certFile` / `keyFile`）：给有正式证书的人用，
 *      浏览器不会警告。文件读不到就**明确报错**，绝不悄悄退化成 HTTP——
 *      "以为走的是 HTTPS，其实明文"是最坏的一种失败。
 *   2. **自签证书**（`web.https.selfSigned`）：落在 `data/tls/`，复用而不是每次重启重签
 *      （浏览器对自签例外是按指纹记的，每次都变会让人反复确认）。
 *      快过期前 30 天自动重签，并把新指纹打出来。
 *
 * 自签证书只保证**传输加密**，不保证身份可信：浏览器仍会警告。
 * 这一点在界面和日志里都会写明，不假装它是"安全连接"。
 */

import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { fingerprintOf, makeSelfSignedCert } from './x509.js';
import { log } from './util.js';

export const TLS_DIR = 'tls';

/** 读取用户提供的证书/私钥。 */
function readUserCert(httpsCfg, rootDir) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.resolve(rootDir, p));
  const certFile = resolve(String(httpsCfg.certFile));
  const keyFile = resolve(String(httpsCfg.keyFile));
  if (!fs.existsSync(certFile)) {
    throw new Error(`证书文件不存在：${certFile}`);
  }
  if (!fs.existsSync(keyFile)) {
    throw new Error(`私钥文件不存在：${keyFile}`);
  }
  const cert = fs.readFileSync(certFile, 'utf8');
  const key = fs.readFileSync(keyFile, 'utf8');
  if (!/-----BEGIN CERTIFICATE-----/.test(cert)) throw new Error(`不像 PEM 证书：${certFile}`);
  if (!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(key)) throw new Error(`不像 PEM 私钥：${keyFile}`);
  return { cert, key, certFile, keyFile, source: 'file', fingerprint256: fingerprintOf(cert) };
}

/** 自签证书的文件名（放在 data/tls 下） */
function selfSignedFiles(dataDir) {
  const dir = path.join(dataDir, TLS_DIR);
  return { dir, cert: path.join(dir, 'self-signed.crt'), key: path.join(dir, 'self-signed.key') };
}

/** 从 PEM 证书里读到期时间（交给 Node 自己的 X509 解析，不手搓） */
function readNotAfter(certPem) {
  try {
    return new Date(new X509Certificate(certPem).validTo);
  } catch {
    return null;
  }
}

/**
 * 解析出实际要用的 TLS 材料。
 *
 * @returns {null | {cert, key, source, fingerprint256, certFile?, keyFile?, notAfter?, altNames?, selfSigned?: boolean}}
 */
export async function resolveTls({ config, dataDir, rootDir = process.cwd(), forceRegenerate = false } = {}) {
  const httpsCfg = config?.web?.https || {};
  if (!httpsCfg.enabled) return null;

  if (httpsCfg.certFile && httpsCfg.keyFile) {
    const out = readUserCert(httpsCfg, rootDir);
    log.info(`HTTPS：使用自有证书 ${out.certFile}`);
    log.info(`证书指纹 SHA-256：${out.fingerprint256}`);
    return out;
  }

  if (!httpsCfg.selfSigned) {
    throw new Error(
      '已启用 HTTPS，但既没有提供 certFile/keyFile，也没打开 selfSigned。' +
        '请在「设置 → 访问与安全」里选一种（或关掉 HTTPS 继续用 HTTP）。',
    );
  }

  const files = selfSignedFiles(dataDir);
  fs.mkdirSync(files.dir, { recursive: true });
  const exists = fs.existsSync(files.cert) && fs.existsSync(files.key);
  if (exists && !forceRegenerate) {
    /*
     * 复用已有证书时要**容错**：证书/私钥可能损坏、不配对、或只写了一半
     * （实测遇到过一次 openssl 的 illegal padding，直接导致服务起不来）。
     * 这种情况应当重新签一张，而不是把用户挡在门外——自签证书本来就是可再生的。
     */
    try {
      const cert = fs.readFileSync(files.cert, 'utf8');
      const key = fs.readFileSync(files.key, 'utf8');
      // 校验一次配对关系：不配对时 createServer 会在握手阶段才报错，太晚
      const { X509Certificate, createPrivateKey } = await import('node:crypto');
      createPrivateKey(key);
      new X509Certificate(cert);
      const notAfter = readNotAfter(cert);
      const soon = notAfter && notAfter.getTime() - Date.now() < 30 * 86_400_000;
      if (!soon) {
        return {
          cert,
          key,
          source: 'self-signed',
          selfSigned: true,
          certFile: files.cert,
          keyFile: files.key,
          fingerprint256: fingerprintOf(cert),
          notAfter: notAfter ? notAfter.toISOString() : null,
        };
      }
      log.warn(`自签证书将于 ${notAfter?.toISOString()} 到期，自动重签一张`);
    } catch (err) {
      log.warn(`已有自签证书不可用（${err?.message || err}），将重新生成一张`);
    }
  }

  // 名称要覆盖用户实际会用的访问方式：localhost、回环、本机名、以及登记过的域名
  const altNames = [
    'localhost',
    '127.0.0.1',
    '::1',
    ...(Array.isArray(config?.web?.allowedHosts) ? config.web.allowedHosts : []),
    ...(httpsCfg.altNames || []),
  ]
    .map((s) => String(s).trim())
    .filter(Boolean);
  // 监听地址若是具体 IP/域名，也加进去（0.0.0.0 无意义，跳过）
  const bind = String(config?.web?.host || '');
  if (bind && bind !== '0.0.0.0' && bind !== '::') altNames.push(bind);

  const made = makeSelfSignedCert({ commonName: 'mailbot', altNames });
  fs.writeFileSync(files.cert, made.cert, { encoding: 'utf8', mode: 0o644 });
  fs.writeFileSync(files.key, made.key, { encoding: 'utf8', mode: 0o600 });
  log.info(`HTTPS：已生成自签证书（覆盖 ${made.altNames.join(', ')}），有效期至 ${made.notAfter}`);
  log.warn('自签证书只提供传输加密，浏览器仍会提示"不受信任"；要免警告请填自己的证书');
  log.info(`证书指纹 SHA-256：${made.fingerprint256}`);
  return {
    cert: made.cert,
    key: made.key,
    source: 'self-signed',
    selfSigned: true,
    certFile: files.cert,
    keyFile: files.key,
    fingerprint256: made.fingerprint256,
    notAfter: made.notAfter,
    altNames: made.altNames,
  };
}
