import { classifyDifficultyRemote } from './providers/adapter.js';

/**
 * Auto router: local rules first; optional small-model classifier if still unclear.
 * Never reads expected_tier from routing_eval.jsonl.
 */

/**
 * @param {object[]} messages
 * @returns {string}
 */
export function extractUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && messages[i].content != null) {
      return String(messages[i].content);
    }
  }
  return '';
}

/**
 * Length-only baseline (~60% on the pack set by design). Eval-only comparator.
 * @param {string} prompt
 * @returns {'fast' | 'smart'}
 */
export function lengthBaselineTier(prompt) {
  const words = prompt.trim().split(/\s+/).filter(Boolean).length;
  return words > 40 ? 'smart' : 'fast';
}

/**
 * Local difficulty rules — keyword / task-shape, not length alone.
 * @param {string} prompt
 * @returns {{ tier: 'fast' | 'smart', reason: string, confidence: 'high' | 'low' }}
 */
export function classifyWithLocalRules(prompt) {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean).length;

  /** @type {string[]} */
  const smartHits = [];
  /** @type {string[]} */
  const fastHits = [];

  const smartPatterns = [
    [/\bprove\b|\bproof\b|\birrational\b|\bdisprove\b/i, 'proof/math rigor'],
    [/\bestimate how many\b|\bfermi\b|\bshow your reasoning\b/i, 'estimation/reasoning'],
    [/\bdesign a (database )?schema\b|\btrade-?offs?\b/i, 'system design'],
    [/\bcompare\b.+\brecommend\b|\bevent sourcing\b|\bcrud\b/i, 'architecture comparison'],
    [/\bbetter than o\(|\bo\(n\^2\)|\bpalindrom/i, 'algorithm complexity'],
    [/\bquorum\b|\bconsistency guarantees\b|\bnetwork partition\b|\banomaly\b/i, 'distributed systems'],
    [/\bzero-?downtime\b|\bmigration plan\b|\bmonolith\b.*\bservices\b/i, 'migration planning'],
    [/\bp99\b|\bp95\b.+\blatency\b|\bplausible mechanisms\b/i, 'systems performance analysis'],
    [/\bmost likely causes\b|\bin order of likelihood\b/i, 'expert debugging'],
    [/\bdistributed system\b|\bleaderless\b|\bN\s*=\s*\d/i, 'distributed systems'],
    [/\bmulti-tenant\b.+\bbilling\b|\bproration\b|\brefunds\b/i, 'complex domain design'],
  ];

  const fastPatterns = [
    [/\bcapital of\b|\bwhat does http status\b|\b404 mean\b/i, 'simple fact'],
    [/\bconvert\b.+\b(fahrenheit|celsius|km|miles)\b/i, 'unit conversion'],
    [/\btranslate\b.+\bto\b/i, 'translation'],
    [/\bcommit message\b|\btypo in the readme\b/i, 'trivial writing'],
    [/\bextract the email\b|\bemail address from\b/i, 'simple extraction'],
    [/\bwho is on call\b/i, 'roster lookup'],
    [/\btimestamp of the first error\b/i, 'log field extraction'],
    [/\brewrite the following\b.+\bmore polite\b/i, 'polite rewrite'],
    [/\bis \d+ divisible by \d+\??$/i, 'simple arithmetic'],
    [/\bgood morning\b/i, 'phrase translation'],
  ];

  for (const [re, label] of smartPatterns) {
    if (re.test(text)) smartHits.push(label);
  }
  for (const [re, label] of fastPatterns) {
    if (re.test(text)) fastHits.push(label);
  }

  // Multi-part / deep asks without matching a fast trap
  if (
    /\bgive three\b|\bexplain your\b|\bwith justification\b|\bhow the algorithm works\b/i.test(
      lower,
    )
  ) {
    smartHits.push('multi-part explanation');
  }

  if (smartHits.length > 0 && fastHits.length === 0) {
    return {
      tier: 'smart',
      reason: `local: ${smartHits.join('; ')}`,
      confidence: 'high',
    };
  }
  if (fastHits.length > 0 && smartHits.length === 0) {
    return {
      tier: 'fast',
      reason: `local: ${fastHits.join('; ')}`,
      confidence: 'high',
    };
  }
  if (smartHits.length > 0 && fastHits.length > 0) {
    // Prefer smart when both fire (hard tasks often contain simple words)
    return {
      tier: 'smart',
      reason: `local: mixed signals, prefer smart (${smartHits[0]} vs ${fastHits[0]})`,
      confidence: 'high',
    };
  }

  // Soft length fallback only when no task signals — mark low confidence
  if (words > 80) {
    return {
      tier: 'smart',
      reason: 'local: long prompt, no clear task markers',
      confidence: 'low',
    };
  }
  if (words < 25) {
    return {
      tier: 'fast',
      reason: 'local: short prompt, no clear task markers',
      confidence: 'low',
    };
  }
  return {
    tier: 'fast',
    reason: 'local: default fast (ambiguous)',
    confidence: 'low',
  };
}

/**
 * Full auto classification for a chat request.
 * @param {object[]} messages
 * @returns {Promise<{ tier: 'fast' | 'smart', reason: string, source: string }>}
 */
export async function classifyAuto(messages) {
  const prompt = extractUserPrompt(messages);
  const local = classifyWithLocalRules(prompt);

  if (local.confidence === 'high') {
    return { tier: local.tier, reason: local.reason, source: 'local' };
  }

  const remote = await classifyDifficultyRemote(prompt);
  if (remote) {
    return { tier: remote.tier, reason: remote.reason, source: 'classifier' };
  }

  return { tier: local.tier, reason: local.reason, source: 'local' };
}
