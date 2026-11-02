import { timingSafeEqual, createHmac, randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
export function equalSecret(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function requireSecret(value: string | undefined, name: string): string {
  if (!value || value.length < 32 || value.startsWith('replace-with')) throw new Error(`${name} must contain at least 32 random characters`);
  return value;
}
export function makeCookie(secret: string): string {
  const payload = `${Date.now() + 7 * 86400_000}.${randomBytes(16).toString('hex')}`;
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
export function validCookie(token: string, secret: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || Number(parts[0]) <= Date.now()) return false;
  const payload = parts.slice(0,2).join('.');
  return equalSecret(parts[2], createHmac('sha256', secret).update(payload).digest('base64url'));
}
export function assertProjectPath(cwd: string, roots: string[]): string {
  const strip = (path:string) => process.platform==='win32' ? path.startsWith('\\\\?\\UNC\\') ? '\\\\'+path.slice(8) : path.startsWith('\\\\?\\') ? path.slice(4) : path : path;
  const real = (path:string) => strip(realpathSync.native(strip(path)));
  const actual = real(cwd);
  if (!roots.some(root => { try{const part = relative(real(root), actual); return part === '' || (!part.startsWith('..') && !isAbsolute(part));}catch{return false;} })) throw new Error('This folder is not in the local project allowlist');
  return actual;
}
export function assertRelayUrl(input: string): URL {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash) throw new Error('Relay credentials belong in BRIDGE_TOKEN, not the URL');
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Expected a WebSocket relay URL');
  if (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Remote relay connections require wss://');
  return url;
}
