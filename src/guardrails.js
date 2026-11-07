/**
 * Prompt safety checks: injection + PII.
 * Per-key policy modes: off | flag | block | redact
 * Defaults match historical behavior: injection=block, pii=flag.
 */

export const GUARDRAIL_MODES = ['off', 'flag', 'block', 'redact'];

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|above) (instructions|rules|prompts)/gi,
  /disregard (your|the) system prompt/gi,
  /you are now (dan|jailbroken|unrestricted)/gi,
  /reveal (your|the) system prompt/gi,
];

const PII_PATTERNS = [
  { id: 'pii_ssn', re: /\b\d{3}-\d{2}-\d{4}\b/g, label: 'SSN' },
  {
    id: 'pii_email',
    re: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    label: 'EMAIL',
  },
  {
    id: 'pii_phone',
    re: /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    label: 'PHONE',
  },
  {
    id: 'pii_card',
    re: /\b(?:\d[ -]*?){13,19}\b/g,
    label: 'CARD',
  },
];

/**
 * @param {unknown} mode
 * @param {'off' | 'flag' | 'block' | 'redact'} fallback
 */
export function normalizeGuardrailMode(mode, fallback) {
  const value = String(mode || '')
    .trim()
    .toLowerCase();
  if (GUARDRAIL_MODES.includes(value)) {
    return /** @type {'off' | 'flag' | 'block' | 'redact'} */ (value);
  }
  return fallback;
}

/**
 * @param {object | null | undefined} keyRecord
 */
export function policyFromKeyRecord(keyRecord) {
  return {
    injection: normalizeGuardrailMode(keyRecord?.guardrail_injection, 'block'),
    pii: normalizeGuardrailMode(keyRecord?.guardrail_pii, 'flag'),
  };
}

/**
 * @param {string} text
 * @param {{ injection?: string, pii?: string }} [policy]
 * @returns {{
 *   flags: string[],
 *   block: boolean,
 *   summary: string,
 *   redactedText: string,
 *   actions: string[],
 * }}
 */
export function inspectPrompt(text, policy = {}) {
  const injectionMode = normalizeGuardrailMode(policy.injection, 'block');
  const piiMode = normalizeGuardrailMode(policy.pii, 'flag');
  const flags = [];
  /** @type {string[]} */
  const actions = [];
  let raw = String(text || '');
  let redactedText = raw;

  let hasInjection = false;
  for (const re of INJECTION_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(raw)) {
      hasInjection = true;
      break;
    }
  }
  if (hasInjection && injectionMode !== 'off') {
    flags.push('injection');
    if (injectionMode === 'redact') {
      for (const re of INJECTION_PATTERNS) {
        re.lastIndex = 0;
        redactedText = redactedText.replace(re, '[REDACTED_INJECTION]');
      }
      actions.push('injection:redact');
    } else if (injectionMode === 'block') {
      actions.push('injection:block');
    } else {
      actions.push('injection:flag');
    }
  }

  /** @type {string[]} */
  const piiHits = [];
  for (const { id, re, label } of PII_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(raw)) {
      piiHits.push(id);
      if (piiMode === 'redact') {
        re.lastIndex = 0;
        redactedText = redactedText.replace(re, `[REDACTED_${label}]`);
      }
    }
  }
  if (piiHits.length && piiMode !== 'off') {
    flags.push(...piiHits);
    if (piiMode === 'redact') {
      actions.push('pii:redact');
    } else if (piiMode === 'block') {
      actions.push('pii:block');
    } else {
      actions.push('pii:flag');
    }
  }

  const block =
    (hasInjection && injectionMode === 'block') ||
    (piiHits.length > 0 && piiMode === 'block');

  const summary =
    flags.length === 0
      ? `guardrails: clean (injection=${injectionMode}, pii=${piiMode})`
      : `guardrails: ${flags.join(',')}; ${actions.join(',') || 'none'}`;

  return { flags, block, summary, redactedText, actions };
}

/**
 * Apply policy to the last user message (and return a shallow-copied messages array).
 * @param {object[]} messages
 * @param {{ injection?: string, pii?: string }} policy
 */
export function enforceGuardrailsOnMessages(messages, policy) {
  const list = Array.isArray(messages) ? messages.map((m) => ({ ...m })) : [];
  let lastUserIndex = -1;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i]?.role === 'user' && list[i].content != null) {
      lastUserIndex = i;
      break;
    }
  }
  if (lastUserIndex < 0) {
    return {
      messages: list,
      flags: [],
      block: false,
      summary: 'guardrails: clean (no user text)',
      actions: [],
      changed: false,
    };
  }

  const original = String(list[lastUserIndex].content);
  const inspected = inspectPrompt(original, policy);
  let changed = false;
  if (
    !inspected.block &&
    inspected.actions.some((action) => action.endsWith(':redact')) &&
    inspected.redactedText !== original
  ) {
    list[lastUserIndex] = {
      ...list[lastUserIndex],
      content: inspected.redactedText,
    };
    changed = true;
  }

  return {
    messages: list,
    flags: inspected.flags,
    block: inspected.block,
    summary: inspected.summary,
    actions: inspected.actions,
    changed,
  };
}

/**
 * Detect cheap-model refusal text (pack mock uses this phrase).
 * @param {object} completionBody
 */
export function isModelRefusal(completionBody) {
  const content = completionBody?.choices?.[0]?.message?.content || '';
  return /i['’]?m sorry, but i can['’]?t help with that/i.test(content);
}
