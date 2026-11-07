import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  cosineSimilarity,
  cachePromptText,
  normalizeCacheEmbedText,
} from '../src/cache.js';

describe('cache helpers', () => {
  it('cosineSimilarity is 1 for identical vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    assert.ok(Math.abs(cosineSimilarity(a, a) - 1) < 1e-6);
  });

  it('cachePromptText uses last user message', () => {
    const text = cachePromptText([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
    ]);
    assert.equal(text, 'second');
  });

  it('normalizeCacheEmbedText drops question-frame wording', () => {
    assert.equal(
      normalizeCacheEmbedText('What is Nural Network'),
      normalizeCacheEmbedText('Explain me Nural Network'),
    );
    assert.equal(normalizeCacheEmbedText('What is Nural Network'), 'nural network');
  });
});
