import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertLimits } from '../src/budget.js';
import { PrismError } from '../src/errors.js';

describe('assertLimits', () => {
  it('allows spend under budget', () => {
    assert.doesNotThrow(() =>
      assertLimits({
        spent: 0,
        budgetUsd: 0.00001,
        tokensUsed: 0,
      }),
    );
  });

  it('rejects when spend has reached budget', () => {
    assert.throws(
      () =>
        assertLimits({
          spent: 0.00001,
          budgetUsd: 0.00001,
          tokensUsed: 0,
        }),
      (err) =>
        err instanceof PrismError &&
        err.statusCode === 402 &&
        err.type === 'budget_exceeded',
    );
  });

  it('rejects when spend exceeds budget after a prior request', () => {
    assert.throws(
      () =>
        assertLimits({
          spent: 0.000014,
          budgetUsd: 0.00001,
          tokensUsed: 27,
        }),
      (err) => err instanceof PrismError && err.type === 'budget_exceeded',
    );
  });

  it('rejects when key token cap is exhausted', () => {
    assert.throws(
      () =>
        assertLimits({
          spent: 0,
          budgetUsd: 50,
          tokensUsed: 100,
          keyTokenCap: 100,
        }),
      (err) => err instanceof PrismError && err.type === 'budget_exceeded',
    );
  });

  it('rejects when user token cap is exhausted', () => {
    assert.throws(
      () =>
        assertLimits({
          spent: 0,
          budgetUsd: 50,
          tokensUsed: 5,
          userTokenCap: 5,
        }),
      (err) => err instanceof PrismError && err.type === 'budget_exceeded',
    );
  });
});
