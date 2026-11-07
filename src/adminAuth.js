import { PrismError } from './errors.js';

/**
 * Demo admin token from env (Phase 6).
 * @param {string | undefined} authorization
 */
export function assertAdminAuth(authorization) {
  const expected = process.env.PRISM_ADMIN_TOKEN || 'prism-admin-demo';
  if (!authorization || typeof authorization !== 'string') {
    throw new PrismError({
      statusCode: 401,
      type: 'authentication_error',
      message: 'Admin authorization required',
    });
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1].trim() : '';
  if (token !== expected) {
    throw new PrismError({
      statusCode: 401,
      type: 'authentication_error',
      message: 'Invalid admin token',
    });
  }
}
