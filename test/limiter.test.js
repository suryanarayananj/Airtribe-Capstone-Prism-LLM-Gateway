import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkAndConsumeRpm,
  checkAndReserveTpm,
  estimatePromptTokens,
  finalizeTpmUsage,
  getRpmCount,
  getTpmCount,
  releaseTpmReservation,
  resetRpmBuckets,
  resetTpmBuckets,
  tpmReserveForMessages,
} from '../src/limiter.js';
import { PrismError } from '../src/errors.js';

describe('checkAndConsumeRpm', () => {
  beforeEach(() => {
    resetRpmBuckets();
  });

  it('admits up to the limit and rejects the next', () => {
    const key = 'test-key-rpm';
    const limit = 10;
    for (let i = 0; i < limit; i += 1) {
      checkAndConsumeRpm(key, limit);
    }
    assert.equal(getRpmCount(key), limit);
    assert.throws(
      () => checkAndConsumeRpm(key, limit),
      (err) =>
        err instanceof PrismError &&
        err.statusCode === 429 &&
        err.type === 'rate_limit_exceeded',
    );
  });

  it('does not over-admit under a sync burst at the ceiling', () => {
    const key = 'test-key-burst';
    const limit = 10;
    let admitted = 0;
    let rejected = 0;

    for (let i = 0; i < 50; i += 1) {
      try {
        checkAndConsumeRpm(key, limit);
        admitted += 1;
      } catch (err) {
        if (err instanceof PrismError && err.type === 'rate_limit_exceeded') {
          rejected += 1;
        } else {
          throw err;
        }
      }
    }

    assert.equal(admitted, limit);
    assert.equal(rejected, 40);
    assert.equal(getRpmCount(key), limit);
  });
});

describe('TPM limiter', () => {
  beforeEach(() => {
    resetTpmBuckets();
  });

  it('skips when tpm_limit is null', () => {
    assert.equal(checkAndReserveTpm('k-null', null, 500), 0);
    assert.equal(getTpmCount('k-null'), 0);
  });

  it('reserves tokens and rejects when the window would exceed the limit', () => {
    const key = 'test-key-tpm';
    const limit = 1000;
    const reserved = checkAndReserveTpm(key, limit, 600);
    assert.equal(reserved, 600);
    assert.equal(getTpmCount(key), 600);

    assert.throws(
      () => checkAndReserveTpm(key, limit, 500),
      (err) =>
        err instanceof PrismError &&
        err.statusCode === 429 &&
        err.type === 'tpm_limit_exceeded',
    );
    assert.equal(getTpmCount(key), 600);
  });

  it('finalizes reserve to actual usage without over-counting', () => {
    const key = 'test-key-tpm-final';
    const reserved = checkAndReserveTpm(key, 5000, 400);
    finalizeTpmUsage(key, reserved, 120);
    assert.equal(getTpmCount(key), 120);
  });

  it('releases reserve on failure', () => {
    const key = 'test-key-tpm-release';
    const reserved = checkAndReserveTpm(key, 5000, 300);
    releaseTpmReservation(key, reserved);
    assert.equal(getTpmCount(key), 0);
  });

  it('estimates prompt tokens from message text', () => {
    assert.equal(estimatePromptTokens([{ role: 'user', content: 'abcd' }]), 1);
    assert.equal(
      estimatePromptTokens([{ role: 'user', content: 'a'.repeat(8) }]),
      2,
    );
    assert.ok(tpmReserveForMessages([{ role: 'user', content: 'hi' }]) > 200);
  });
});
