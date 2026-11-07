import { createHash } from 'node:crypto';
import { pipeline } from '@xenova/transformers';
import { config } from './config.js';
import {
  getCacheEntriesForKeyModel,
  insertCacheEntry,
  incrementCacheHitCount,
  getCacheEntryStats,
  getLifetimeCacheHitStats,
} from './db.js';

/** @type {Awaited<ReturnType<typeof pipeline>> | null} */
let embedder = null;

const processStats = {
  hits: 0,
  misses: 0,
};

/**
 * Last user message — Must Have multi-turn keying (decision D21).
 * @param {object[]} messages
 */
export function cachePromptText(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && messages[i].content != null) {
      return String(messages[i].content);
    }
  }
  return '';
}

/**
 * Light normalization before embedding so question-frame paraphrases
 * ("What is X" / "Explain X") compare on intent, not wording.
 * Stored prompt_text stays the original; only the vector uses this.
 * @param {string} text
 */
export function normalizeCacheEmbedText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\s']/g, ' ')
    .replace(
      /\b(what is|what are|what's|whats|explain(?:\s+me|\s+to\s+me)?|tell me about|describe|define|how do i|how does|how can i|can you|please|steps to)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim();
}

async function getEmbedder() {
  if (!embedder) {
    embedder = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return embedder;
}

/**
 * @param {string} text
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text) {
  const extractor = await getEmbedder();
  const forEmbed = normalizeCacheEmbedText(text) || String(text || '').trim();
  const output = await extractor(forEmbed, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

/**
 * @param {Float32Array | number[]} a
 * @param {Float32Array | number[]} b
 */
export function cosineSimilarity(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) {
    return 0;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * @param {Float32Array} vector
 * @returns {Buffer}
 */
function vectorToBuffer(vector) {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/**
 * @param {Buffer | Uint8Array} buf
 * @returns {Float32Array}
 */
function bufferToVector(buf) {
  const copy = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return new Float32Array(
    copy.buffer,
    copy.byteOffset,
    copy.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
}

/**
 * Per-key semantic lookup. Never crosses virtual keys.
 *
 * @param {object} opts
 * @param {string} opts.virtualKey
 * @param {string} opts.model alias or model id used as cache partition
 * @param {object[]} opts.messages
 * @param {boolean} opts.enabled
 * @param {number} opts.threshold
 * @returns {Promise<{ hit: true, response: object, score: number } | { hit: false, score: number | null }>}
 */
export async function lookupSemanticCache({
  virtualKey,
  model,
  messages,
  enabled,
  threshold,
}) {
  if (!enabled) {
    processStats.misses += 1;
    return { hit: false, score: null };
  }

  const prompt = cachePromptText(messages);
  if (!prompt) {
    processStats.misses += 1;
    return { hit: false, score: null };
  }

  const query = await embedText(prompt);
  const entries = getCacheEntriesForKeyModel(virtualKey, model);

  let best = null;
  let bestScore = -1;
  for (const entry of entries) {
    const emb = bufferToVector(entry.embedding);
    const score = cosineSimilarity(query, emb);
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }

  if (best && bestScore >= threshold) {
    incrementCacheHitCount(best.id);
    processStats.hits += 1;
    return {
      hit: true,
      response: JSON.parse(best.response_json),
      score: bestScore,
      entryId: best.id,
      prompt,
    };
  }

  processStats.misses += 1;
  return { hit: false, score: bestScore < 0 ? null : bestScore };
}

/**
 * @param {number | null | undefined} keyTtlSeconds
 */
export function resolveCacheTtlSeconds(keyTtlSeconds) {
  const fromKey = Number(keyTtlSeconds);
  if (Number.isFinite(fromKey) && fromKey > 0) {
    return Math.floor(fromKey);
  }
  const fromConfig = Number(config.cacheTtlSeconds);
  if (Number.isFinite(fromConfig) && fromConfig > 0) {
    return Math.floor(fromConfig);
  }
  return 86_400;
}

/**
 * @param {number} ttlSeconds
 */
function expiresAtIso(ttlSeconds) {
  const ms = Date.now() + ttlSeconds * 1000;
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

export async function storeSemanticCache({
  virtualKey,
  model,
  messages,
  enabled,
  response,
  ttlSeconds = null,
}) {
  if (!enabled) {
    return;
  }
  if (!response?.choices?.[0]?.message?.content) {
    return;
  }

  const prompt = cachePromptText(messages);
  if (!prompt) {
    return;
  }

  const vector = await embedText(prompt);
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  const ttl = resolveCacheTtlSeconds(ttlSeconds);

  insertCacheEntry({
    virtualKey,
    model,
    promptHash,
    promptText: prompt,
    embedding: vectorToBuffer(vector),
    responseJson: JSON.stringify(response),
    expiresAt: expiresAtIso(ttl),
  });
}

/** Cache hits bill $0 — do not replay the original call’s token usage. */
const ZERO_USAGE = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
};

/**
 * Return a cached completion body with usage zeroed (hit is not metered again).
 * @param {object | null | undefined} cachedBody
 */
export function cacheHitResponseBody(cachedBody) {
  if (!cachedBody || typeof cachedBody !== 'object') {
    return cachedBody;
  }
  return {
    ...cachedBody,
    usage: { ...ZERO_USAGE },
  };
}

/**
 * Replay a cached chat.completion as OpenAI-style SSE chunks (not one giant blob).
 * @param {import('node:http').ServerResponse} clientRes
 * @param {object} cachedBody
 * @param {string} fallbackModel
 * @param {string} requestId
 */
export function writeCachedCompletionAsSse(
  clientRes,
  cachedBody,
  fallbackModel,
  requestId,
) {
  const content =
    cachedBody?.choices?.[0]?.message?.content ||
    cachedBody?.choices?.[0]?.delta?.content ||
    '';
  const id = cachedBody?.id || `chatcmpl-cache-${String(requestId).slice(0, 8)}`;
  const model = cachedBody?.model || fallbackModel;
  const created = Math.floor(Date.now() / 1000);
  const pieces = String(content).match(/\S+\s*/g) || [content || ''];

  clientRes.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    })}\n\n`,
  );

  for (const piece of pieces) {
    if (!piece) {
      continue;
    }
    clientRes.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
      })}\n\n`,
    );
  }

  clientRes.write(
    `data: ${JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { ...ZERO_USAGE },
    })}\n\n`,
  );
  clientRes.write('data: [DONE]\n\n');
  clientRes.end();
}

export function getProcessCacheStats() {
  const dbStats = getCacheEntryStats();
  const lifetime = getLifetimeCacheHitStats();
  const totalLookups = processStats.hits + processStats.misses;
  return {
    process_hits: processStats.hits,
    process_misses: processStats.misses,
    process_hit_rate: totalLookups
      ? processStats.hits / totalLookups
      : 0,
    lifetime_hits: lifetime.lifetimeHits,
    lifetime_requests: lifetime.lifetimeRequests,
    lifetime_hit_rate: lifetime.lifetimeHitRate,
    entries: dbStats.entries,
    cumulative_entry_hits: dbStats.hitCountSum,
  };
}
