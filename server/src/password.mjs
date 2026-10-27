import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
// Bound expensive password work independently of HTTP rate limits.
let running = 0;
async function key(password, salt) {
  if (running >= 4) throw Object.assign(new Error('server_busy'), { statusCode: 503 });
  running++;
  try { return await derive(password, salt, 64, options); }
  finally { running--; }
}
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt-v1$${salt}$${(await key(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password, hash) {
  const parts = hash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt-v1' || !/^[a-f0-9]{32}$/.test(parts[1]) || !/^[a-f0-9]{128}$/.test(parts[2])) return false;
  return timingSafeEqual(await key(password, parts[1]), Buffer.from(parts[2], 'hex'));
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
