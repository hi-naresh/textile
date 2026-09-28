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

/** Starting password for accounts the owner/developer creates or resets. The person must change it on first login. */
export const TEMP_PASSWORD = '12345678';

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
  if (pw === TEMP_PASSWORD) return 'Choose a password different from the starting password.';
  return null;
}

/** Spends about the same time as a real check, so "no such phone" and "wrong password" take equally long. */
let dummyHash: Promise<string> | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummyHash);
}
