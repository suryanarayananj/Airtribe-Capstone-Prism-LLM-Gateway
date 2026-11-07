import { config } from './config.js';

/**
 * Cost from provider usage × data/model_pricing.json (never from client-declared tokens).
 * @param {string} providerModel
 * @param {{ prompt_tokens?: number, completion_tokens?: number } | undefined} usage
 * @returns {number}
 */
export function computeCostUsd(providerModel, usage) {
  const prices = config.modelPricing[providerModel];
  if (!prices || !usage) {
    return 0;
  }
  const prompt = Number(usage.prompt_tokens || 0);
  const completion = Number(usage.completion_tokens || 0);
  return (prompt * prices.input_per_1m + completion * prices.output_per_1m) / 1_000_000;
}

/**
 * @param {number} cost
 * @returns {string}
 */
export function formatCostUsd(cost) {
  if (!Number.isFinite(cost) || cost === 0) {
    return '0';
  }
  // Keep enough precision for tiny mock prices without scientific notation
  const fixed = cost.toFixed(8);
  return fixed.replace(/\.?0+$/, '') || '0';
}
