import { randomUUID } from 'node:crypto';
import { config, resolveModelChain } from '../config.js';
import {
  authenticateVirtualKey,
  assertModelAllowed,
  CHAT_PROXY_HEADER,
  CHAT_PROXY_VALUE,
} from '../auth.js';
import { assertBudgetAndCaps, currentYearMonth } from '../budget.js';
import {
  checkAndConsumeRpm,
  checkAndReserveTpm,
  finalizeTpmUsage,
  releaseTpmReservation,
  tpmReserveForMessages,
} from '../limiter.js';
import { computeCostUsd, formatCostUsd } from '../metering.js';
import { incrementUsage, insertCacheHit, insertRequestLog } from '../db.js';
import { PrismError } from '../errors.js';
import { classifyAuto } from '../router.js';
import {
  cachePromptText,
  cacheHitResponseBody,
  lookupSemanticCache,
  storeSemanticCache,
  writeCachedCompletionAsSse,
} from '../cache.js';
import {
  enforceGuardrailsOnMessages,
  isModelRefusal,
  policyFromKeyRecord,
} from '../guardrails.js';
import { recordProviderSample } from '../health.js';
import {
  chatCompletionWithFailover,
  openChatStreamWithFailover,
  pipeSseToClient,
} from '../providers/adapter.js';

/**
 * Data plane: auth → allowlist → RPM → TPM → budget → guardrails → route → cache → upstream → meter + log.
 *
 * @param {import('fastify').FastifyInstance} app
 */
export async function registerChatRoutes(app) {
  app.post('/v1/chat/completions', async (request, reply) => {
    const started = Date.now();
    const requestId = randomUUID();
    const body = request.body || {};
    /** @type {object[]} */
    let messages = body.messages;
    const requestedModel = body.model;
    const wantStream = body.stream === true;

    /** @type {object | null} */
    let keyRecord = null;
    /** @type {string | null} */
    let status = null;
    /** @type {string | null} */
    let errorType = null;
    let resolvedProvider = null;
    let resolvedModel = null;
    let promptTokens = 0;
    let completionTokens = 0;
    let costUsd = 0;
    let retries = 0;
    let cacheHeader = 'miss';
    let usedFallback = false;
    /** @type {string | null} */
    let routeReason = null;
    /** Tokens reserved against the TPM window for this request (0 if TPM off). */
    let tpmReserved = 0;

    const finishLog = () => {
      try {
        insertRequestLog({
          requestId,
          virtualKey: keyRecord?.virtual_key ?? null,
          requestedModel: requestedModel ?? null,
          resolvedProvider,
          resolvedModel,
          status: status || 'error',
          promptTokens,
          completionTokens,
          costUsd,
          cache: cacheHeader,
          fallback: usedFallback,
          routeReason,
          retries,
          latencyMs: Date.now() - started,
          errorType,
        });
      } catch (logErr) {
        request.log.error({ err: logErr }, 'failed to write request_logs');
      }
    };

    const recordUsage = ({ cacheHit = false } = {}) => {
      if (!keyRecord) {
        return;
      }
      incrementUsage({
        virtualKey: keyRecord.virtual_key,
        yearMonth: currentYearMonth(),
        requests: 1,
        promptTokens,
        completionTokens,
        costUsd,
        cacheHits: cacheHit ? 1 : 0,
      });
    };

    const cacheEnabled = () => Boolean(keyRecord?.cache_enabled);
    const cacheThreshold = () => {
      const t = Number(keyRecord?.cache_similarity);
      return Number.isFinite(t) ? t : 0.85;
    };

    try {
      if (!Array.isArray(messages) || messages.length === 0) {
        throw new PrismError({
          statusCode: 400,
          type: 'invalid_request_error',
          message: 'messages must be a non-empty array',
        });
      }

      if (!requestedModel || typeof requestedModel !== 'string') {
        throw new PrismError({
          statusCode: 400,
          type: 'invalid_request_error',
          message: 'model is required',
        });
      }

      const proxyHeader = String(
        request.headers[CHAT_PROXY_HEADER] || '',
      ).toLowerCase();
      keyRecord = authenticateVirtualKey(request.headers.authorization, {
        allowChatProxy: proxyHeader === CHAT_PROXY_VALUE,
      });

      const knownAliases = Object.keys(config.modelAliases);
      const isAlias = knownAliases.includes(requestedModel);
      const looksLikeProviderModel =
        requestedModel.endsWith('-small') || requestedModel.endsWith('-large');

      if (!isAlias && !looksLikeProviderModel) {
        throw new PrismError({
          statusCode: 404,
          type: 'not_found_error',
          message: `Unknown model or alias '${requestedModel}'`,
        });
      }

      assertModelAllowed(keyRecord, requestedModel);
      checkAndConsumeRpm(keyRecord.virtual_key, keyRecord.rpm_limit);
      tpmReserved = checkAndReserveTpm(
        keyRecord.virtual_key,
        keyRecord.tpm_limit,
        tpmReserveForMessages(messages),
      );
      assertBudgetAndCaps(keyRecord);

      const guardPolicy = policyFromKeyRecord(keyRecord);
      const guard = enforceGuardrailsOnMessages(messages, guardPolicy);
      routeReason = guard.summary;
      if (guard.block) {
        const blockedOn = guard.flags.includes('injection')
          ? 'injection pattern'
          : 'PII';
        throw new PrismError({
          statusCode: 400,
          type: 'invalid_request_error',
          message: `Prompt blocked by guardrails (${blockedOn} detected)`,
        });
      }
      messages = guard.messages;

      /** @type {'fast' | 'smart' | undefined} */
      let autoTier;
      if (requestedModel === 'auto') {
        const decision = await classifyAuto(messages);
        autoTier = decision.tier;
        routeReason = `${guard.summary}; ${decision.tier} (${decision.source}): ${decision.reason}`;
      }

      let { models: modelChain } = resolveModelChain(requestedModel, {
        autoTier,
      });

      // Cache partition = requested alias/model (per-key + model)
      const cacheModel = requestedModel;

      const cacheResult = await lookupSemanticCache({
        virtualKey: keyRecord.virtual_key,
        model: cacheModel,
        messages,
        enabled: cacheEnabled(),
        threshold: cacheThreshold(),
      });

      if (cacheResult.hit) {
        cacheHeader = 'hit';
        insertCacheHit({
          cacheEntryId: cacheResult.entryId,
          requestId,
          virtualKey: keyRecord.virtual_key,
          model: cacheModel,
          score: cacheResult.score,
          promptText: cacheResult.prompt,
        });
        costUsd = 0;
        promptTokens = 0;
        completionTokens = 0;
        // Cache hits are $0 and do not burn TPM beyond releasing the pre-flight reserve.
        releaseTpmReservation(keyRecord.virtual_key, tpmReserved);
        tpmReserved = 0;
        resolvedProvider = 'cache';
        // Prefer the stored upstream model id — cache partition may be an alias (fast/smart).
        resolvedModel =
          (typeof cacheResult.response?.model === 'string' &&
          cacheResult.response.model
            ? cacheResult.response.model
            : null) || cacheModel;
        status = 'cache_hit';
        recordUsage({ cacheHit: true });
        finishLog();

        const cachedBody = cacheResult.response;

        if (wantStream) {
          reply.hijack();
          reply.raw.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'x-prism-provider': `cache/${cacheModel}`,
            'x-prism-cache': 'hit',
            'x-prism-fallback': 'false',
          });
          writeCachedCompletionAsSse(
            reply.raw,
            cachedBody,
            cacheModel,
            requestId,
          );
          return;
        }

        reply.header('x-prism-provider', `cache/${cacheModel}`);
        reply.header('x-prism-cache', 'hit');
        reply.header('x-prism-fallback', 'false');
        reply.header('x-prism-cost-usd', '0');
        return cacheHitResponseBody(cachedBody);
      }

      if (wantStream) {
        const opened = await openChatStreamWithFailover({
          modelChain,
          messages,
        });

        resolvedProvider = opened.providerName;
        resolvedModel = opened.providerModel;
        usedFallback = opened.usedFallback;
        retries = opened.retries;

        reply.hijack();
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'x-prism-provider': `${opened.providerName}/${opened.providerModel}`,
          'x-prism-cache': cacheHeader,
          'x-prism-fallback': usedFallback ? 'true' : 'false',
        });

        const { usage, content, midStreamError } = await pipeSseToClient(
          opened.response,
          reply.raw,
        );

        promptTokens = Number(usage?.prompt_tokens || 0);
        completionTokens = Number(usage?.completion_tokens || 0);
        costUsd = computeCostUsd(opened.providerModel, usage || undefined);

        if (midStreamError) {
          recordProviderSample(opened.providerName, {
            ok: false,
            latencyMs: Date.now() - started,
          });
          status = 'upstream_error';
          errorType = 'upstream_error';
          finalizeTpmUsage(
            keyRecord.virtual_key,
            tpmReserved,
            promptTokens + completionTokens,
          );
          tpmReserved = 0;
          finishLog();
          return;
        }

        if (content) {
          try {
            await storeSemanticCache({
              virtualKey: keyRecord.virtual_key,
              model: cacheModel,
              messages,
              enabled: cacheEnabled(),
              response: {
                id: `chatcmpl-${requestId.slice(0, 8)}`,
                object: 'chat.completion',
                model: opened.providerModel,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content },
                    finish_reason: 'stop',
                  },
                ],
                usage: usage || undefined,
              },
              ttlSeconds: keyRecord.cache_ttl_seconds,
            });
          } catch {
            /* reply already sent; a cache write must not drop the log */
          }
        }

        finalizeTpmUsage(
          keyRecord.virtual_key,
          tpmReserved,
          promptTokens + completionTokens,
        );
        tpmReserved = 0;
        recordUsage();
        status = 'ok';
        finishLog();
        return;
      }

      let result = await chatCompletionWithFailover({
        modelChain,
        messages,
      });

      let escalated = false;
      // Cheap-model refusal → stronger tier (pack mock: [refuse] on *-small)
      if (isModelRefusal(result.body)) {
        const smartChain = resolveModelChain('smart').models;
        const escalatedResult = await chatCompletionWithFailover({
          modelChain: smartChain,
          messages,
        });
        result = escalatedResult;
        escalated = true;
        routeReason = `${routeReason || ''}; escalated_to_smart`.replace(
          /^; /,
          '',
        );
      }

      resolvedProvider = result.providerName;
      resolvedModel = result.providerModel;
      usedFallback = result.usedFallback;
      retries = result.retries;
      promptTokens = Number(result.body.usage?.prompt_tokens || 0);
      completionTokens = Number(result.body.usage?.completion_tokens || 0);
      costUsd = computeCostUsd(result.providerModel, result.body.usage);

      await storeSemanticCache({
        virtualKey: keyRecord.virtual_key,
        model: cacheModel,
        messages,
        enabled: cacheEnabled(),
        response: result.body,
        ttlSeconds: keyRecord.cache_ttl_seconds,
      });

      finalizeTpmUsage(
        keyRecord.virtual_key,
        tpmReserved,
        promptTokens + completionTokens,
      );
      tpmReserved = 0;
      recordUsage();
      status = 'ok';
      finishLog();

      reply.header(
        'x-prism-provider',
        `${result.providerName}/${result.providerModel}`,
      );
      reply.header('x-prism-cache', cacheHeader);
      reply.header('x-prism-fallback', usedFallback ? 'true' : 'false');
      if (escalated) {
        reply.header('x-prism-escalation', 'true');
      }
      reply.header('x-prism-cost-usd', formatCostUsd(costUsd));

      return result.body;
    } catch (err) {
      if (keyRecord && tpmReserved > 0) {
        releaseTpmReservation(keyRecord.virtual_key, tpmReserved);
        tpmReserved = 0;
      }
      if (reply.raw.headersSent) {
        return;
      }
      if (err instanceof PrismError) {
        errorType = err.type;
        status = statusForErrorType(err.type);
        finishLog();
      } else {
        status = 'error';
        errorType = 'server_error';
        finishLog();
      }
      throw err;
    }
  });
}

/**
 * @param {string} type
 */
function statusForErrorType(type) {
  switch (type) {
    case 'authentication_error':
      return 'rejected_auth';
    case 'model_not_allowed':
      return 'rejected_allowlist';
    case 'rate_limit_exceeded':
      return 'rejected_rate_limit';
    case 'tpm_limit_exceeded':
      return 'rejected_tpm';
    case 'budget_exceeded':
      return 'rejected_budget';
    case 'not_found_error':
      return 'rejected_not_found';
    case 'invalid_request_error':
      return 'rejected_invalid';
    case 'upstream_error':
      return 'upstream_error';
    default:
      return 'error';
  }
}
