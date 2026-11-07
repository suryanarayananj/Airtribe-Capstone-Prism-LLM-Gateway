import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pipeSseToClient } from '../src/providers/adapter.js';

describe('pipeSseToClient mid-stream failure', () => {
  it('ends the client with an error event and does not throw for splice', async () => {
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hello "}}]}\n\n',
    ];

    const upstreamBody = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(chunks[0]));
        controller.error(new Error('socket reset'));
      },
    });

    const written = [];
    const clientRes = {
      write(buf) {
        written.push(Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf));
      },
      end() {
        written.push('__END__');
      },
    };

    const fakeResponse = { body: upstreamBody };
    const { midStreamError } = await pipeSseToClient(fakeResponse, clientRes);

    assert.ok(midStreamError);
    const joined = written.join('');
    assert.match(joined, /upstream_error/);
    assert.ok(written.includes('__END__'));
    // No second provider content (would look like beta:) — only error path
    assert.doesNotMatch(joined, /beta:/);
  });
});
