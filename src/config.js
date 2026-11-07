import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, '..');

const DEFAULT_PORT = 8080;

function readJson(relativePath) {
  const fullPath = path.join(ROOT_DIR, relativePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

const seedKeys = readJson('data/seed_keys.json');
const gatewaySample = readJson('data/gateway_config.sample.json');
const modelPricing = readJson('data/model_pricing.json');

const upstreamMode = (process.env.PRISM_UPSTREAM || 'mock').toLowerCase();

/** @type {{ name: string, base_url: string, api_key: string }[]} */
let providers = gatewaySample.providers.map((p) => {
  const envUrl = process.env[`PRISM_${p.name.toUpperCase()}_BASE_URL`];
  const envKey = process.env[`PRISM_${p.name.toUpperCase()}_API_KEY`];
  return {
    ...p,
    base_url: envUrl || p.base_url,
    api_key: envKey || p.api_key,
  };
});

if (upstreamMode === 'openrouter') {
  const baseUrl = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
  const apiKey = process.env.OPENROUTER_API_KEY || '';
  providers = providers.map((p) => ({
    ...p,
    base_url: baseUrl,
    api_key: apiKey || p.api_key,
  }));
}

export const config = {
  host: process.env.PRISM_HOST || '0.0.0.0',
  port: Number(process.env.PRISM_PORT || DEFAULT_PORT),
  dbPath: path.resolve(ROOT_DIR, process.env.PRISM_DB_PATH || 'data/prism.db'),
  upstreamMode,
  providers,
  modelAliases: gatewaySample.model_aliases,
  retry: gatewaySample.retry,
  degradation: gatewaySample.degradation || {
    error_rate_threshold: 0.5,
    window_seconds: 60,
    p95_latency_ms: 5000,
  },
  /**
   * Stretch routing among healthy providers:
   * least_latency (default) | weighted | failover (config order only).
   * Optional weights: { alpha: 2, beta: 1 }. Override with PRISM_ROUTING_STRATEGY.
   */
  routing: {
    strategy:
      process.env.PRISM_ROUTING_STRATEGY ||
      gatewaySample.routing?.strategy ||
      'failover',
    weights: gatewaySample.routing?.weights || { alpha: 1, beta: 1 },
  },
  /** Default semantic-cache TTL in seconds (per-key override via cache_ttl_seconds). */
  cacheTtlSeconds: Number(process.env.PRISM_CACHE_TTL_SECONDS || 86_400),
  seedTenants: seedKeys.tenants,
  modelPricing,
  upstreamTimeoutMs: Number(process.env.PRISM_UPSTREAM_TIMEOUT_MS || 1_000),
  classifierModel:
    process.env.PRISM_CLASSIFIER_MODEL || 'openai/gpt-4o-mini',
};

/**
 * Resolve alias or raw model id to an ordered failover chain.
 * fast → [alpha-small, beta-small]; smart → [alpha-large, beta-large]
 * auto → requires autoTier ('fast'|'smart') from the router.
 *
 * @param {string} requested
 * @param {{ autoTier?: 'fast' | 'smart' }} [opts]
 * @returns {{ alias: string | null, models: string[], routeTier: string | null }}
 */
export function resolveModelChain(requested, opts = {}) {
  const aliasConfig = config.modelAliases[requested];
  if (!aliasConfig) {
    return { alias: null, models: [requested], routeTier: null };
  }
  if (requested === 'auto') {
    const tier = opts.autoTier === 'smart' ? 'smart' : 'fast';
    const tierCfg = config.modelAliases[tier];
    return {
      alias: 'auto',
      models: [tierCfg.primary, ...(tierCfg.fallbacks || [])],
      routeTier: tier,
    };
  }
  return {
    alias: requested,
    models: [aliasConfig.primary, ...(aliasConfig.fallbacks || [])],
    routeTier: requested,
  };
}

/**
 * Find provider registry entry that serves a model like alpha-small.
 * @param {string} providerModel
 */
export function findProviderForModel(providerModel) {
  const provider = config.providers.find(
    (p) => providerModel === `${p.name}-small` || providerModel === `${p.name}-large`,
  );
  return provider || null;
}

/** Prism slot → OpenRouter model id. Used only when PRISM_UPSTREAM=openrouter. */
export const OPENROUTER_MODEL_IDS = {
  'alpha-small': 'openai/gpt-4o-mini',
  'beta-small': 'google/gemini-2.0-flash-001',
  'alpha-large': 'google/gemini-2.0-flash-001',
  'beta-large': 'openai/gpt-4o-mini',
};

/**
 * Admin showcase: how aliases map to provider slots (mock names + OpenRouter ids).
 */
export function getProviderCatalog() {
  const aliases = [];
  for (const [alias, cfg] of Object.entries(config.modelAliases)) {
    if (alias === 'auto') {
      aliases.push({
        alias: 'auto',
        kind: 'router',
        description:
          'Classifies the prompt, then reuses the fast or smart chain below.',
        primary: null,
        fallbacks: [],
        resolves_via: ['fast', 'smart'],
      });
      continue;
    }
    const primary = cfg?.primary || null;
    const fallbacks = cfg?.fallbacks || [];
    aliases.push({
      alias,
      kind: 'tier',
      description:
        alias === 'fast'
          ? 'Cheaper / quicker tier (small slots).'
          : alias === 'smart'
            ? 'Stronger tier (large slots).'
            : 'Alias chain from gateway config.',
      primary,
      fallbacks,
      chain: primary ? [primary, ...fallbacks] : [],
    });
  }

  const slots = ['alpha-small', 'alpha-large', 'beta-small', 'beta-large'].map(
    (slot) => {
      const provider = findProviderForModel(slot);
      return {
        slot,
        provider: provider?.name || slot.split('-')[0],
        tier: slot.endsWith('-large') ? 'large' : 'small',
        mock_model_id: slot,
        openrouter_model_id:
          OPENROUTER_MODEL_IDS[slot] || slot,
        active_upstream_id: upstreamModelId(slot),
      };
    },
  );

  return {
    upstream_mode: config.upstreamMode,
    note:
      'In production, admins map friendly aliases (fast/smart/auto) to provider model ids. Prism keeps pack names alpha/beta; OpenRouter mode rewrites slots to real vendor ids.',
    providers: config.providers.map((p) => ({
      name: p.name,
      base_url: p.base_url,
      models: [`${p.name}-small`, `${p.name}-large`],
    })),
    aliases,
    slots,
  };
}

/**
 * Model id sent to the upstream HTTP API.
 * Mock providers expect alpha-small / beta-large. OpenRouter expects vendor ids.
 * @param {string} providerModel
 */
export function upstreamModelId(providerModel) {
  if (config.upstreamMode !== 'openrouter') {
    return providerModel;
  }
  const envName = `PRISM_OPENROUTER_${providerModel.toUpperCase().replaceAll('-', '_')}`;
  return process.env[envName] || OPENROUTER_MODEL_IDS[providerModel] || providerModel;
}
