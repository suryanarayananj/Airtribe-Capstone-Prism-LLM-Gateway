/**
 * Pre-send token/cost estimate (heuristic). Not the metered bill.
 * Token guess ≈ ceil(chars / 4); output size is assumed until the model replies.
 */

export function estimateTextTokens(text) {
  const raw = String(text || '');
  if (!raw.trim()) {
    return 0;
  }
  return Math.max(1, Math.ceil(raw.length / 4));
}

export function estimatePromptTokens(messages, draft) {
  let total = 0;
  for (const message of messages || []) {
    total += estimateTextTokens(message?.content) + 4;
  }
  total += estimateTextTokens(draft);
  return total;
}

export function resolveEstimateModel(requested, pricing) {
  if (!pricing) {
    return null;
  }
  if (pricing.aliases?.[requested]) {
    return pricing.aliases[requested];
  }
  if (pricing.models?.[requested]) {
    return requested;
  }
  return pricing.aliases?.fast || null;
}

export function formatEstimateCost(cost) {
  if (!Number.isFinite(cost) || cost === 0) {
    return '0';
  }
  const fixed = cost.toFixed(8);
  return fixed.replace(/\.?0+$/, '') || '0';
}

/**
 * @returns {null | {
 *   promptTokens: number,
 *   completionTokens: number,
 *   totalTokens: number,
 *   providerModel: string,
 *   costUsd: number,
 *   costLabel: string,
 * }}
 */
export function estimateRequestCost({ draft, messages, model, pricing }) {
  if (!String(draft || '').trim() || !pricing || !model) {
    return null;
  }
  const providerModel = resolveEstimateModel(model, pricing);
  const prices = providerModel ? pricing.models?.[providerModel] : null;
  if (!prices) {
    return null;
  }
  const promptTokens = estimatePromptTokens(messages, draft);
  const completionTokens = Math.max(
    1,
    Number(pricing.assumed_output_tokens) || 200,
  );
  const costUsd =
    (promptTokens * Number(prices.input_per_1m || 0) +
      completionTokens * Number(prices.output_per_1m || 0)) /
    1_000_000;
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    providerModel,
    costUsd,
    costLabel: formatEstimateCost(costUsd),
  };
}
