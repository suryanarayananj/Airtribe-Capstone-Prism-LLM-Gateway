import {
  accessModeAllowsApi,
  findVirtualKey,
  getUserById,
  normalizeAccessMode,
} from './db.js';
import { PrismError } from './errors.js';

/** Header set by /app/chat when it proxies to /v1 so Chat-only keys still work. */
export const CHAT_PROXY_HEADER = 'x-prism-chat-proxy';
export const CHAT_PROXY_VALUE = 'prism-internal';

/**
 * @param {string | undefined} authorization
 * @returns {string | null}
 */
export function extractBearer(authorization) {
  if (!authorization || typeof authorization !== 'string') {
    return null;
  }
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Authenticate virtual key from Authorization header.
 * @param {string | undefined} authorization
 * @param {{ allowChatProxy?: boolean }} [opts]
 * @returns {object} keyRecord from SQLite
 */
export function authenticateVirtualKey(authorization, opts = {}) {
  const virtualKey = extractBearer(authorization);
  if (!virtualKey) {
    throw new PrismError({
      statusCode: 401,
      type: 'authentication_error',
      message: 'Missing or invalid Authorization Bearer token',
    });
  }

  const keyRecord = findVirtualKey(virtualKey);
  if (!keyRecord || keyRecord.status !== 'active') {
    throw new PrismError({
      statusCode: 401,
      type: 'authentication_error',
      message: 'Invalid virtual key',
    });
  }

  if (keyRecord.user_id) {
    const user = getUserById(keyRecord.user_id);
    if (!user) {
      throw new PrismError({
        statusCode: 403,
        type: 'permission_error',
        message:
          'This key is linked to a user that no longer exists. Ask an admin to fix the key before using the API.',
      });
    }
    const mode = normalizeAccessMode(user.access_mode);
    if (!accessModeAllowsApi(mode) && !opts.allowChatProxy) {
      throw new PrismError({
        statusCode: 403,
        type: 'permission_error',
        message:
          'This key is Chat-only. Use the Prism chat app, or ask an admin to set access to API or Both.',
      });
    }
  }

  return keyRecord;
}

/**
 * Enforce model/alias allowlist on the key.
 * @param {object} keyRecord
 * @param {string} requestedModel
 */
export function assertModelAllowed(keyRecord, requestedModel) {
  let allowlist = [];
  try {
    allowlist = JSON.parse(keyRecord.model_allowlist || '[]');
  } catch {
    allowlist = [];
  }

  if (!allowlist.includes(requestedModel)) {
    throw new PrismError({
      statusCode: 403,
      type: 'model_not_allowed',
      message: `Model or alias '${requestedModel}' is not allowed for this key`,
    });
  }
}
