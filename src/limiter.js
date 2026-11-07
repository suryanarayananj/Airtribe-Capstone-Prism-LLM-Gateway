import { PrismError } from './errors.js';

const WINDOW_MS = 60_000;

/** Default completion headroom when reserving TPM before the upstream responds. */
const DEFAULT_OUTPUT_RESERVE = 200;

/** @type {Map<string, { windowStart: number, count: number }>} */
const rpmBuckets = new Map();

/** @type {Map<string, { windowStart: number, tokens: number }>} */
const tpmBuckets = new Map();

/**
 * Rough prompt size for pre-flight TPM reserve (chars/4).
 * @param {unknown} messages
 */
export function estimatePromptTokens(messages) {
  if (!Array.isArray(messages)) {
    return 1;
  }
  let chars = 0;
  for (const message of messages) {
    chars += String(message?.content || '').length;
  }
  if (chars <= 0) {
    return 1;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

/**
 * @param {string} virtualKey
 * @param {number} now
 */
function getRpmBucket(virtualKey, now) {
  let bucket = rpmBuckets.get(virtualKey);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, count: 0 };
    rpmBuckets.set(virtualKey, bucket);
  }
  return bucket;
}

/**
 * @param {string} virtualKey
 * @param {number} now
 */
function getTpmBucket(virtualKey, now) {
  let bucket = tpmBuckets.get(virtualKey);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    bucket = { windowStart: now, tokens: 0 };
    tpmBuckets.set(virtualKey, bucket);
  }
  return bucket;
}

/**
 * Check and consume one RPM slot for a virtual key.
 * Synchronous critical section — no await between check and consume.
 *
 * @param {string} virtualKey
 * @param {number} rpmLimit
 */
export function checkAndConsumeRpm(virtualKey, rpmLimit) {
  const limit = Number(rpmLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new PrismError({
      statusCode: 429,
      type: 'rate_limit_exceeded',
      message: 'Rate limit is not configured for this key',
    });
  }

  const now = Date.now();
  const bucket = getRpmBucket(virtualKey, now);

  if (bucket.count >= limit) {
    throw new PrismError({
      statusCode: 429,
      type: 'rate_limit_exceeded',
      message: `Rate limit of ${limit} requests per minute exceeded`,
    });
  }

  bucket.count += 1;
}

/**
 * Reserve estimated tokens for this minute (sync). No-op when tpmLimit is null/empty.
 * @param {string} virtualKey
 * @param {number | null | undefined} tpmLimit
 * @param {number} reserveTokens
 * @returns {number} reserved amount (0 if TPM not enforced)
 */
export function checkAndReserveTpm(virtualKey, tpmLimit, reserveTokens) {
  if (tpmLimit == null || tpmLimit === '') {
    return 0;
  }
  const limit = Number(tpmLimit);
  if (!Number.isFinite(limit) || limit <= 0) {
    return 0;
  }

  const reserve = Math.max(0, Math.floor(Number(reserveTokens) || 0));
  if (reserve <= 0) {
    return 0;
  }

  const now = Date.now();
  const bucket = getTpmBucket(virtualKey, now);

  if (bucket.tokens + reserve > limit) {
    throw new PrismError({
      statusCode: 429,
      type: 'tpm_limit_exceeded',
      message: `Tokens-per-minute limit of ${limit} exceeded (used ${bucket.tokens} in window, need ${reserve} more)`,
    });
  }

  bucket.tokens += reserve;
  return reserve;
}

/**
 * Replace a prior reserve with actual provider usage (sync).
 * @param {string} virtualKey
 * @param {number} reserved
 * @param {number} actualTokens
 */
export function finalizeTpmUsage(virtualKey, reserved, actualTokens) {
  const reservedN = Math.max(0, Math.floor(Number(reserved) || 0));
  const actual = Math.max(0, Math.floor(Number(actualTokens) || 0));
  if (reservedN === 0 && actual === 0) {
    return;
  }

  const now = Date.now();
  const bucket = getTpmBucket(virtualKey, now);
  bucket.tokens = Math.max(0, bucket.tokens - reservedN + actual);
}

/**
 * Drop a reserve when the request fails before metering (sync).
 * @param {string} virtualKey
 * @param {number} reserved
 */
export function releaseTpmReservation(virtualKey, reserved) {
  const reservedN = Math.max(0, Math.floor(Number(reserved) || 0));
  if (reservedN === 0) {
    return;
  }
  const now = Date.now();
  const bucket = getTpmBucket(virtualKey, now);
  bucket.tokens = Math.max(0, bucket.tokens - reservedN);
}

/**
 * Build a pre-flight TPM reserve from messages.
 * @param {unknown} messages
 */
export function tpmReserveForMessages(messages) {
  return estimatePromptTokens(messages) + DEFAULT_OUTPUT_RESERVE;
}

/** Test helper: clear in-memory buckets. */
export function resetRpmBuckets() {
  rpmBuckets.clear();
}

/** Test helper: clear TPM buckets. */
export function resetTpmBuckets() {
  tpmBuckets.clear();
}

/**
 * Test helper: current RPM count in the active window (0 if none).
 * @param {string} virtualKey
 */
export function getRpmCount(virtualKey) {
  const bucket = rpmBuckets.get(virtualKey);
  if (!bucket) {
    return 0;
  }
  if (Date.now() - bucket.windowStart >= WINDOW_MS) {
    return 0;
  }
  return bucket.count;
}

/**
 * Test helper: tokens reserved/used in the active TPM window.
 * @param {string} virtualKey
 */
export function getTpmCount(virtualKey) {
  const bucket = tpmBuckets.get(virtualKey);
  if (!bucket) {
    return 0;
  }
  if (Date.now() - bucket.windowStart >= WINDOW_MS) {
    return 0;
  }
  return bucket.tokens;
}
