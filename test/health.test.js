import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  getRoutingStrategy,
  orderModelChainByHealth,
  recordProviderSample,
  resetProviderHealth,
  getProviderHealth,
} from '../src/health.js';

describe('provider health / degradation', () => {
  beforeEach(() => {
    resetProviderHealth();
  });

  it('keeps original order when no samples', () => {
    const chain = ['alpha-small', 'beta-small'];
    assert.deepEqual(orderModelChainByHealth(chain), chain);
  });

  it('moves degraded provider models to the end', () => {
    for (let i = 0; i < 4; i += 1) {
      recordProviderSample('alpha', { ok: false, latencyMs: 10 });
    }
    recordProviderSample('beta', { ok: true, latencyMs: 20 });

    assert.equal(getProviderHealth('alpha').degraded, true);
    assert.equal(getProviderHealth('beta').degraded, false);

    assert.deepEqual(orderModelChainByHealth(['alpha-small', 'beta-small']), [
      'beta-small',
      'alpha-small',
    ]);
  });

  it('does not drop every candidate when all are degraded', () => {
    for (let i = 0; i < 4; i += 1) {
      recordProviderSample('alpha', { ok: false, latencyMs: 10 });
      recordProviderSample('beta', { ok: false, latencyMs: 10 });
    }
    const chain = ['alpha-small', 'beta-small'];
    const ordered = orderModelChainByHealth(chain);
    assert.equal(ordered.length, 2);
    assert.ok(ordered.includes('alpha-small'));
    assert.ok(ordered.includes('beta-small'));
  });

  it('prefers lower average latency among healthy providers (Stretch)', () => {
    // Default strategy is least_latency
    assert.equal(getRoutingStrategy(), 'least_latency');

    for (let i = 0; i < 3; i += 1) {
      recordProviderSample('alpha', { ok: true, latencyMs: 200 });
      recordProviderSample('beta', { ok: true, latencyMs: 40 });
    }

    assert.deepEqual(orderModelChainByHealth(['alpha-small', 'beta-small']), [
      'beta-small',
      'alpha-small',
    ]);
  });
});
