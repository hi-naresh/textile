// Password hashing with Node's built-in scrypt (no extra dependency).
// Stored as "scrypt$N$r$p$saltB64$hashB64" so the cost can be raised later without breaking old hashes.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'crypto';

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

function scrypt(password: string, salt: Buffer, keylen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(password, salt, keylen, opts, (err, key) => (err ? reject(err) : resolve(key))));
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * One-time starting password for an account the owner / developer creates or resets, e.g. "maple-4821-river".
 * Random per account (a fixed starting password would let anyone who knows the phone number sign in first).
 * Shown once to whoever set it up; the person must choose their own at first sign-in.
 */
export function newTempPassword(): string {
  const words = ['maple', 'river', 'cotton', 'silk', 'loom', 'thread', 'indigo', 'saffron', 'monsoon', 'amber', 'cedar', 'lotus', 'pearl', 'tiger', 'coral', 'jasmine', 'mango', 'neem', 'peacock', 'banyan'];
  const b = randomBytes(6);
  return `${words[b[0] % words.length]}-${1000 + (b.readUInt16BE(1) % 9000)}-${words[b[3] % words.length]}${b[4] % 10}`;
}

/** Passwords too easy to guess (old demo / starting passwords included). */
const WEAK = new Set(['12345678', '123456789', '1234567890', 'password', 'password1', 'qwerty123', '11111111', '00000000', 'abcd1234']);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(password, salt, expected.length, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Checked on sign up and password change. Returns an error message, or null when fine. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (pw.length > PASSWORD_MAX) return `Password must be ${PASSWORD_MAX} characters or fewer.`;
  if (WEAK.has(pw.toLowerCase())) return 'That password is too easy to guess. Choose another.';
  if (/^\d+$/.test(pw)) return 'Use some letters as well as numbers.';
  return null;
}

/** Spends about the same time as a real check, so "no such phone" and "wrong password" take equally long. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummyHash);
}
