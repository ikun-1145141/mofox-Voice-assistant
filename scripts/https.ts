import 'reflect-metadata';
import * as x509 from '@peculiar/x509';
import { createPrivateKey, createPublicKey, randomBytes, webcrypto, X509Certificate as NativeCertificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DATA, loadConfig, saveConfig } from '../apps/server/src/config.js';

// Signatures and private-key handling use Node's native WebCrypto implementation.
const crypto = webcrypto as unknown as Crypto;
x509.cryptoProvider.set(crypto);
const rsa: RsaHashedKeyGenParams = {
  name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1])
};
const DAY = 86400000;
const directory = path.join(DATA, 'certs');
const caCertPath = path.join(directory, 'rootCA.pem');
const caKeyPath = path.join(directory, 'rootCA-key.pem');

function serialNumber(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0]! & 0x7f) | 1;
  return bytes.toString('hex');
}

function privateKeyPem(der: ArrayBuffer): string {
  const base64 = Buffer.from(der).toString('base64').match(/.{1,64}/g)!.join('\n');
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----\n`;
}

async function optionalPem(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function loadOrCreateCa(): Promise<{ cert: x509.X509Certificate; key: CryptoKey }> {
  const [certPem, keyPem] = await Promise.all([optionalPem(caCertPath), optionalPem(caKeyPath)]);
  if ((certPem === null) !== (keyPem === null)) {
    throw new Error('本地 CA 证书或私钥缺失。请恢复 data/certs 中成对的 rootCA 文件，脚本不会自动更换已信任的 CA。');
  }
  if (certPem !== null && keyPem !== null) {
    const cert = new x509.X509Certificate(certPem);
    const native = new NativeCertificate(certPem);
    const privateKey = createPrivateKey(keyPem);
    if (privateKey.asymmetricKeyType !== 'rsa' || !native.ca || !native.verify(native.publicKey)) {
      throw new Error('现有本地 CA 必须是有效的 RSA 自签名 CA，原文件已保留。');
    }
    const keyPublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
    const certPublic = native.publicKey.export({ type: 'spki', format: 'der' });
    if (!keyPublic.equals(certPublic)) throw new Error('本地 CA 私钥与证书不匹配，原文件已保留。');
    if (cert.notBefore.getTime() > Date.now() || cert.notAfter.getTime() <= Date.now()) {
      throw new Error('本地 CA 不在有效期内，请先处理 CA 更新及访问设备的信任配置，原文件已保留。');
    }
    // Preserve an existing CA and migrate the old forge PKCS#1 key to PKCS#8.
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });
    const key = await crypto.subtle.importKey('pkcs8', new Uint8Array(pkcs8).buffer, rsa, false, ['sign']);
    if (!keyPem.includes('-----BEGIN PRIVATE KEY-----')) {
      await writeFile(caKeyPath, privateKeyPem(new Uint8Array(pkcs8).buffer), { mode: 0o600 });
    }
    return { cert, key };
  }
  const keys = await crypto.subtle.generateKey(rsa, true, ['sign', 'verify']);
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serialNumber(), name: 'CN=MoFox Voice Local CA',
    notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 5 * 365 * DAY),
    signingAlgorithm: rsa, keys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey)
    ]
  });
  await writeFile(caKeyPath, privateKeyPem(await crypto.subtle.exportKey('pkcs8', keys.privateKey)), { mode: 0o600, flag: 'wx' });
  await writeFile(caCertPath, `${cert.toString('pem')}\n`, { flag: 'wx' });
  return { cert, key: keys.privateKey };
}

await mkdir(directory, { recursive: true });
const ca = await loadOrCreateCa();
const ips = [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flatMap(items =>
  (items ?? []).filter(item => item.family === 'IPv4').map(item => item.address)
)])];
const keys = await crypto.subtle.generateKey(rsa, true, ['sign', 'verify']);
const cert = await x509.X509CertificateGenerator.create({
  serialNumber: serialNumber(), subject: 'CN=localhost', issuer: ca.cert.subject,
  notBefore: new Date(Date.now() - 60000),
  notAfter: new Date(Math.min(Date.now() + 365 * DAY, ca.cert.notAfter.getTime())),
  signingAlgorithm: rsa, publicKey: keys.publicKey, signingKey: ca.key,
  extensions: [
    new x509.BasicConstraintsExtension(false, undefined, true),
    new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
    new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
    new x509.SubjectAlternativeNameExtension([{ type: 'dns', value: 'localhost' }, ...ips.map(value => ({ type: 'ip' as const, value }))]),
    await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    await x509.AuthorityKeyIdentifierExtension.create(ca.cert.publicKey)
  ]
});
if (!await cert.verify({ publicKey: ca.cert.publicKey })) throw new Error('新生成的服务证书验证失败，未启用 HTTPS。');
const config = await loadConfig();
config.server.certPath = path.join(directory, 'server.pem');
config.server.keyPath = path.join(directory, 'server-key.pem');
await writeFile(config.server.certPath, `${cert.toString('pem')}\n`);
await writeFile(config.server.keyPath, privateKeyPem(await crypto.subtle.exportKey('pkcs8', keys.privateKey)), { mode: 0o600 });
await saveConfig(config);
console.log(`HTTPS 已配置，重启服务生效。\n请把 ${caCertPath} 安装为访问设备信任的证书。\n主机 IP 改变后重跑 npm run https。`);
console.log(ips.filter(ip => ip !== '127.0.0.1').map(ip => `https://${ip}:${config.server.port}`).join('\n'));
