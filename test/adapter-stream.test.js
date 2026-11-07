import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { extractUsageFromSse } from '../src/providers/adapter.js';

describe('extractUsageFromSse', () => {
  it('reads usage from the final chunk before [DONE]', () => {
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
      '',
      'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const usage = extractUsageFromSse(sse);
    assert.equal(usage.prompt_tokens, 3);
    assert.equal(usage.completion_tokens, 1);
  });
});
