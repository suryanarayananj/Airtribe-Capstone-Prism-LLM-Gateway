import { config, findProviderForModel } from './config.js';

/**
 * In-memory provider health samples for degradation-based failover
 * and Stretch least-latency / weighted routing among healthy providers.
 */

/** @type {Map<string, { at: number, ok: boolean, latencyMs: number }[]>} */
const samplesByProvider = new Map();

function windowMs() {
  const seconds = Number(config.degradation?.window_seconds ?? 60);
  return Math.max(5, seconds) * 1000;
}

function prune(providerName, now = Date.now()) {
  const cutoff = now - windowMs();
  const list = samplesByProvider.get(providerName) || [];
  const next = list.filter((sample) => sample.at >= cutoff);
  samplesByProvider.set(providerName, next);
  return next;
}

/**
 * @param {string} providerName
 * @param {{ ok: boolean, latencyMs: number }} sample
 */
export function recordProviderSample(providerName, sample) {
  if (!providerName) {
    return;
  }
  const now = Date.now();
  const list = prune(providerName, now);
  list.push({
    at: now,
    ok: Boolean(sample.ok),
    latencyMs: Math.max(0, Number(sample.latencyMs) || 0),
  });
  samplesByProvider.set(providerName, list);
}

function percentile(sorted, p) {
  if (!sorted.length) {
    return null;
  }
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[idx];
}

/**
 * @param {string} providerName
 */
export function getProviderHealth(providerName) {
  const list = prune(providerName);
  const total = list.length;
  const errors = list.filter((sample) => !sample.ok).length;
  const latencies = list
    .map((sample) => sample.latencyMs)
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);
  const errorRate = total ? errors / total : 0;
  const p95 = percentile(latencies, 95);
  const avg =
    latencies.length === 0
      ? null
      : latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length;

  const errorThreshold = Number(config.degradation?.error_rate_threshold ?? 0.5);
  const p95Threshold = Number(config.degradation?.p95_latency_ms ?? 5000);
  const degraded =
    total >= 3 &&
    (errorRate >= errorThreshold ||
      (p95 != null && p95 >= p95Threshold));

  return {
    name: providerName,
    samples: total,
    errors,
    error_rate: errorRate,
    avg_latency_ms: avg,
    p95_latency_ms: p95,
    degraded,
    weight: providerWeight(providerName),
    thresholds: {
      error_rate: errorThreshold,
      p95_latency_ms: p95Threshold,
      window_seconds: Number(config.degradation?.window_seconds ?? 60),
      min_samples: 3,
    },
  };
}

export function listProviderHealth() {
  const names = new Set(config.providers.map((provider) => provider.name));
  for (const name of samplesByProvider.keys()) {
    names.add(name);
  }
  return [...names].sort().map((name) => getProviderHealth(name));
}

export function getRoutingStrategy() {
  const raw = String(
    config.routing?.strategy || process.env.PRISM_ROUTING_STRATEGY || 'least_latency',
  )
    .trim()
    .toLowerCase();
  if (raw === 'weighted' || raw === 'failover' || raw === 'least_latency') {
    return raw;
  }
  return 'least_latency';
}

/**
 * @param {string} providerName
 */
function providerWeight(providerName) {
  const fromRouting = config.routing?.weights?.[providerName];
  if (Number.isFinite(Number(fromRouting)) && Number(fromRouting) > 0) {
    return Number(fromRouting);
  }
  const provider = config.providers.find((p) => p.name === providerName);
  const fromProvider = provider?.weight;
  if (Number.isFinite(Number(fromProvider)) && Number(fromProvider) > 0) {
    return Number(fromProvider);
  }
  return 1;
}

/**
 * @param {string} providerModel
 */
function providerNameForModel(providerModel) {
  return findProviderForModel(providerModel)?.name || null;
}

/**
 * Sort key for healthy models: lower is tried first.
 * @param {string} providerModel
 * @param {'failover' | 'least_latency' | 'weighted'} strategy
 * @param {number} indexInOriginal
 */
function healthySortKey(providerModel, strategy, indexInOriginal) {
  const name = providerNameForModel(providerModel);
  const health = name ? getProviderHealth(name) : null;
  const avg =
    health?.avg_latency_ms == null || !Number.isFinite(health.avg_latency_ms)
      ? Number.POSITIVE_INFINITY
      : health.avg_latency_ms;
  const weight = name ? providerWeight(name) : 1;

  if (strategy === 'failover') {
    return { primary: indexInOriginal, secondary: 0 };
  }
  if (strategy === 'weighted') {
    // Higher weight and lower latency win: score = latency / weight
    const score =
      avg === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : avg / weight;
    return { primary: score, secondary: indexInOriginal };
  }
  // least_latency (default Stretch)
  return { primary: avg, secondary: indexInOriginal };
}

/**
 * True when this provider model should be skipped (degraded), unless every
 * remaining option is degraded — caller must keep at least one candidate.
 * @param {string} providerModel
 */
export function isProviderModelDegraded(providerModel) {
  const provider = findProviderForModel(providerModel);
  if (!provider) {
    return false;
  }
  return getProviderHealth(provider.name).degraded;
}

/**
 * Reorder chain:
 * 1) healthy before degraded
 * 2) among healthy: failover | least_latency | weighted (Stretch)
 * 3) among degraded: same strategy (last resort)
 *
 * @param {string[]} modelChain
 */
export function orderModelChainByHealth(modelChain) {
  const strategy = getRoutingStrategy();
  const healthy = [];
  const degraded = [];
  for (const model of modelChain) {
    if (isProviderModelDegraded(model)) {
      degraded.push(model);
    } else {
      healthy.push(model);
    }
  }

  const sortGroup = (group) =>
    [...group]
      .map((model, index) => ({
        model,
        key: healthySortKey(model, strategy, index),
      }))
      .sort((a, b) => {
        if (a.key.primary !== b.key.primary) {
          return a.key.primary - b.key.primary;
        }
        return a.key.secondary - b.key.secondary;
      })
      .map((row) => row.model);

  if (!healthy.length) {
    return sortGroup(modelChain);
  }
  return [...sortGroup(healthy), ...sortGroup(degraded)];
}

/** Test helper */
export function resetProviderHealth() {
  samplesByProvider.clear();
}
