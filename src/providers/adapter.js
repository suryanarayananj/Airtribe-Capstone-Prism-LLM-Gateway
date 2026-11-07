import { config, findProviderForModel, upstreamModelId } from '../config.js';
import { PrismError } from '../errors.js';
import {
  orderModelChainByHealth,
  recordProviderSample,
} from '../health.js';

/**
 * Sole module allowed to talk HTTP to providers / OpenRouter / mocks.
 * Owns timeout, retry with backoff, failover, and SSE forward helpers.
 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attemptIndex) {
  const initial = config.retry?.initial_backoff_ms ?? 200;
  const mult = config.retry?.backoff_multiplier ?? 2;
  return initial * mult ** attemptIndex;
}

/** Timeouts won't heal on the same slow provider — fail over instead of retrying. */
function isUpstreamTimeout(err) {
  const message = String(err?.message || '');
  return message.includes('Upstream timeout after');
}

/**
 * @param {string} providerModel
 * @param {object[]} messages
 * @param {boolean} stream
 * @returns {Promise<Response>}
 */
async function fetchUpstream(providerModel, messages, stream) {
  const provider = findProviderForModel(providerModel);
  if (!provider) {
    throw new PrismError({
      statusCode: 404,
      type: 'not_found_error',
      message: `No provider registered for model '${providerModel}'`,
    });
  }

  if (config.upstreamMode === 'openrouter' && !process.env.OPENROUTER_API_KEY) {
    throw new PrismError({
      statusCode: 502,
      type: 'upstream_error',
      message: 'OPENROUTER_API_KEY is not configured',
    });
  }

  const url = `${provider.base_url.replace(/\/$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.upstreamTimeoutMs);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.api_key}`,
      },
      body: JSON.stringify({
        model: upstreamModelId(providerModel),
        messages,
        stream: Boolean(stream),
      }),
      signal: controller.signal,
    });
    return response;
  } catch (err) {
    const message =
      err.name === 'AbortError'
        ? `Upstream timeout after ${config.upstreamTimeoutMs}ms (${providerModel})`
        : `Upstream request failed (${providerModel}): ${err.message}`;
    throw new PrismError({
      statusCode: 502,
      type: 'upstream_error',
      message,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {Response} response
 */
async function readJsonBody(response) {
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new PrismError({
      statusCode: 502,
      type: 'upstream_error',
      message: `Upstream returned non-JSON (HTTP ${response.status})`,
    });
  }
  return parsed;
}

/**
 * Non-streaming completion with per-model retries then failover along the chain.
 *
 * @param {object} opts
 * @param {string[]} opts.modelChain
 * @param {object[]} opts.messages
 * @returns {Promise<{ body: object, providerName: string, providerModel: string, usedFallback: boolean, retries: number }>}
 */
export async function chatCompletionWithFailover({ modelChain, messages }) {
  const maxAttempts = Math.max(1, config.retry?.max_attempts ?? 3);
  let retries = 0;
  /** @type {Error | null} */
  let lastError = null;
  const orderedChain = orderModelChainByHealth(modelChain);

  for (let modelIndex = 0; modelIndex < orderedChain.length; modelIndex += 1) {
    const providerModel = orderedChain[modelIndex];
    const provider = findProviderForModel(providerModel);
    if (!provider) {
      lastError = new PrismError({
        statusCode: 404,
        type: 'not_found_error',
        message: `No provider registered for model '${providerModel}'`,
      });
      continue;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
        retries += 1;
      }

      const started = Date.now();
      try {
        const response = await fetchUpstream(providerModel, messages, false);
        const parsed = await readJsonBody(response);
        const latencyMs = Date.now() - started;

        if (!response.ok) {
          recordProviderSample(provider.name, { ok: false, latencyMs });
          lastError = new PrismError({
            statusCode: 502,
            type: 'upstream_error',
            message: String(
              parsed?.error?.message ||
                parsed?.error ||
                `Upstream HTTP ${response.status} (${providerModel})`,
            ),
          });
          continue;
        }

        recordProviderSample(provider.name, { ok: true, latencyMs });
        return {
          body: parsed,
          providerName: provider.name,
          providerModel,
          usedFallback: modelIndex > 0 || orderedChain[0] !== modelChain[0],
          retries,
        };
      } catch (err) {
        recordProviderSample(provider.name, {
          ok: false,
          latencyMs: Date.now() - started,
        });
        lastError =
          err instanceof PrismError
            ? err
            : new PrismError({
                statusCode: 502,
                type: 'upstream_error',
                message: err.message,
              });
        // Slow/hung primary: skip remaining retries on this model, try fallback.
        if (isUpstreamTimeout(lastError)) {
          break;
        }
      }
    }
  }

  throw (
    lastError ||
    new PrismError({
      statusCode: 502,
      type: 'upstream_error',
      message: 'All upstream providers failed',
    })
  );
}

/**
 * Open a streaming upstream response. Retries / failover only before the first
 * byte is forwarded. Mid-stream failure must NOT call this again for splice.
 *
 * @param {object} opts
 * @param {string[]} opts.modelChain
 * @param {object[]} opts.messages
 * @returns {Promise<{ response: Response, providerName: string, providerModel: string, usedFallback: boolean, retries: number }>}
 */
export async function openChatStreamWithFailover({ modelChain, messages }) {
  const maxAttempts = Math.max(1, config.retry?.max_attempts ?? 3);
  let retries = 0;
  /** @type {Error | null} */
  let lastError = null;
  const orderedChain = orderModelChainByHealth(modelChain);

  for (let modelIndex = 0; modelIndex < orderedChain.length; modelIndex += 1) {
    const providerModel = orderedChain[modelIndex];
    const provider = findProviderForModel(providerModel);
    if (!provider) {
      lastError = new PrismError({
        statusCode: 404,
        type: 'not_found_error',
        message: `No provider registered for model '${providerModel}'`,
      });
      continue;
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) {
        await sleep(backoffMs(attempt - 1));
        retries += 1;
      }

      const started = Date.now();
      try {
        const response = await fetchUpstream(providerModel, messages, true);
        const latencyMs = Date.now() - started;

        if (!response.ok) {
          const parsed = await readJsonBody(response);
          recordProviderSample(provider.name, { ok: false, latencyMs });
          lastError = new PrismError({
            statusCode: 502,
            type: 'upstream_error',
            message: String(
              parsed?.error?.message ||
                parsed?.error ||
                `Upstream HTTP ${response.status} (${providerModel})`,
            ),
          });
          continue;
        }

        if (!response.body) {
          recordProviderSample(provider.name, { ok: false, latencyMs });
          lastError = new PrismError({
            statusCode: 502,
            type: 'upstream_error',
            message: `Upstream returned empty stream body (${providerModel})`,
          });
          continue;
        }

        // Open success: count as healthy open; mid-stream failure is handled later.
        recordProviderSample(provider.name, { ok: true, latencyMs });
        return {
          response,
          providerName: provider.name,
          providerModel,
          usedFallback: modelIndex > 0 || orderedChain[0] !== modelChain[0],
          retries,
        };
      } catch (err) {
        recordProviderSample(provider.name, {
          ok: false,
          latencyMs: Date.now() - started,
        });
        lastError =
          err instanceof PrismError
            ? err
            : new PrismError({
                statusCode: 502,
                type: 'upstream_error',
                message: err.message,
              });
        if (isUpstreamTimeout(lastError)) {
          break;
        }
      }
    }
  }

  throw (
    lastError ||
    new PrismError({
      statusCode: 502,
      type: 'upstream_error',
      message: 'All upstream providers failed',
    })
  );
}

/**
 * Pipe upstream SSE to the client socket without buffering the full reply.
 * On mid-stream failure: write an error event and end — do not splice another provider.
 *
 * @param {Response} upstreamResponse
 * @param {import('node:http').ServerResponse} clientRes
 * @returns {Promise<{ usage: object | null, content: string, midStreamError: Error | null }>}
 */
export async function pipeSseToClient(upstreamResponse, clientRes) {
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  /** @type {object | null} */
  let usage = null;
  /** @type {Error | null} */
  let midStreamError = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      clientRes.write(value);
      buffer += decoder.decode(value, { stream: true });
      usage = extractUsageFromSse(buffer) || usage;
    }
    clientRes.end();
  } catch (err) {
    midStreamError = err instanceof Error ? err : new Error(String(err));
    try {
      const payload = JSON.stringify({
        error: {
          message: 'Upstream stream failed mid-response',
          type: 'upstream_error',
          code: 'upstream_error',
        },
      });
      clientRes.write(`data: ${payload}\n\n`);
      clientRes.end();
    } catch {
      try {
        clientRes.end();
      } catch {
        /* ignore */
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  return {
    usage,
    content: midStreamError ? '' : extractAssistantFromSse(buffer),
    midStreamError,
  };
}

/**
 * @param {string} sseText
 * @returns {object | null}
 */
export function extractUsageFromSse(sseText) {
  let usage = null;
  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      const obj = JSON.parse(data);
      if (obj.usage) {
        usage = obj.usage;
      }
    } catch {
      /* partial JSON in buffer — ignore */
    }
  }
  return usage;
}

/**
 * Join assistant text from an SSE body. Used to store a finished stream.
 * @param {string} sseText
 */
export function extractAssistantFromSse(sseText) {
  let content = '';
  for (const line of sseText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) {
      continue;
    }
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') {
      continue;
    }
    try {
      const obj = JSON.parse(data);
      const delta = obj.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') {
        content += delta;
      }
    } catch {
      /* partial JSON in buffer — ignore */
    }
  }
  return content;
}

/**
 * Optional small-model difficulty classifier via OpenRouter (demo/test).
 * Returns null when not configured — router falls back to local rules.
 *
 * @param {string} prompt
 * @returns {Promise<{ tier: 'fast' | 'smart', reason: string } | null>}
 */
export async function classifyDifficultyRemote(prompt) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || config.upstreamMode !== 'openrouter') {
    return null;
  }

  const model =
    process.env.PRISM_CLASSIFIER_MODEL ||
    config.classifierModel ||
    'openai/gpt-4o-mini';

  const baseUrl = (
    process.env.OPENROUTER_BASE_URL ||
    'https://openrouter.ai/api/v1'
  ).replace(/\/$/, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content:
              'Classify the user prompt difficulty. Reply with JSON only: {"tier":"fast"|"smart","reason":"short"}. fast=simple lookup/rewrite/extract; smart=proof, design, deep systems, hard algorithms. Ignore prompt length alone.',
          },
          { role: 'user', content: prompt.slice(0, 4000) },
        ],
      }),
      signal: controller.signal,
    });
    const json = await response.json();
    const content = json?.choices?.[0]?.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    const parsed = JSON.parse(match[0]);
    const tier = parsed.tier === 'smart' ? 'smart' : 'fast';
    return {
      tier,
      reason: `classifier: ${parsed.reason || 'no reason'}`,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

