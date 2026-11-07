import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelChain } from '../src/config.js';
import { classifyWithLocalRules } from '../src/router.js';

describe('resolveModelChain', () => {
  it('maps fast to alpha-small then beta-small', () => {
    const { models, routeTier } = resolveModelChain('fast');
    assert.deepEqual(models, ['alpha-small', 'beta-small']);
    assert.equal(routeTier, 'fast');
  });

  it('maps smart to alpha-large then beta-large', () => {
    const { models, routeTier } = resolveModelChain('smart');
    assert.deepEqual(models, ['alpha-large', 'beta-large']);
    assert.equal(routeTier, 'smart');
  });

  it('maps auto using router tier without reading eval labels', () => {
    const smart = resolveModelChain('auto', { autoTier: 'smart' });
    assert.deepEqual(smart.models, ['alpha-large', 'beta-large']);
    assert.equal(smart.routeTier, 'smart');
    const fast = resolveModelChain('auto', { autoTier: 'fast' });
    assert.deepEqual(fast.models, ['alpha-small', 'beta-small']);
  });
});

describe('classifyWithLocalRules traps', () => {
  it('routes short proof to smart', () => {
    const r = classifyWithLocalRules(
      'Prove that the square root of 2 is irrational.',
    );
    assert.equal(r.tier, 'smart');
  });

  it('routes long roster lookup to fast', () => {
    const r = classifyWithLocalRules(
      'Monday - Priya, Tuesday - Chen. Who is on call this Thursday?',
    );
    assert.equal(r.tier, 'fast');
  });
});
