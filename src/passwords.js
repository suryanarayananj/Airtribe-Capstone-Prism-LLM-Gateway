import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * @param {string} password
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * @param {string} password
 * @param {string | null | undefined} stored
 */
export function verifyPassword(password, stored) {
  if (!stored || !password) {
    return false;
  }
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) {
    return false;
  }
  const actual = scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(actual, expected);
}
