import { getMonthlyUsage, getUserById } from './db.js';
import { PrismError } from './errors.js';

/**
 * Current UTC year-month key, e.g. 2026-10.
 * @param {Date} [now]
 */
export function currentYearMonth(now = new Date()) {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/**
 * Pure budget/cap gate (unit-testable). Throws PrismError when exhausted.
 * @param {object} opts
 */
export function assertLimits({
  spent,
  budgetUsd,
  tokensUsed,
  keyTokenCap = null,
  userTokenCap = null,
}) {
  const budget = Number(budgetUsd);
  if (Number.isFinite(budget) && spent >= budget) {
    throw new PrismError({
      statusCode: 402,
      type: 'budget_exceeded',
      message: `Monthly budget of $${budget} exhausted for this key`,
    });
  }

  if (keyTokenCap != null) {
    const cap = Number(keyTokenCap);
    if (Number.isFinite(cap) && tokensUsed >= cap) {
      throw new PrismError({
        statusCode: 402,
        type: 'budget_exceeded',
        message: `Token cap of ${cap} exhausted for this key`,
      });
    }
  }

  if (userTokenCap != null) {
    const userCap = Number(userTokenCap);
    if (Number.isFinite(userCap) && tokensUsed >= userCap) {
      throw new PrismError({
        statusCode: 402,
        type: 'budget_exceeded',
        message: `User token cap of ${userCap} exhausted`,
      });
    }
  }
}

/**
 * Reject if monthly dollar budget or token caps are already exhausted.
 * @param {object} keyRecord
 */
export function assertBudgetAndCaps(keyRecord) {
  const yearMonth = currentYearMonth();
  const usage = getMonthlyUsage(keyRecord.virtual_key, yearMonth);
  const spent = usage?.cost_usd ?? 0;
  const tokensUsed =
    (usage?.prompt_tokens ?? 0) + (usage?.completion_tokens ?? 0);

  let userTokenCap = null;
  if (keyRecord.user_id != null) {
    const user = getUserById(keyRecord.user_id);
    userTokenCap = user?.token_cap ?? null;
  }

  assertLimits({
    spent,
    budgetUsd: keyRecord.monthly_budget_usd,
    tokensUsed,
    keyTokenCap: keyRecord.token_cap,
    userTokenCap,
  });
}
