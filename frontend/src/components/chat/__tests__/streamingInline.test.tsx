import { describe, expect, it } from 'vitest';

import type { PipelineEvent } from '../../../lib/api-types';
import {
  BLOCK_PATCH,
  RESPONSE_DONE,
  RESPONSE_INIT,
  RESPONSE_SNAPSHOT,
  reduceResponse,
} from '../../../lib/response-reducer';
import type { ResponseEnvelope } from '../../../lib/response-types';

function makeEvent(phase: string, data: Record<string, unknown>): PipelineEvent {
  return { phase, status: 'data', data };
}

function runSequence(events: PipelineEvent[]): ResponseEnvelope | undefined {
  let envelope: ResponseEnvelope | undefined;
  for (const event of events) {
    envelope = reduceResponse(envelope, event);
  }
  return envelope;
}

describe('streaming inline reducer flow', () => {
  it('flips streaming envelopes to complete while preserving the streamed summary through snapshot convergence', () => {
    const envelope = runSequence([
      makeEvent(RESPONSE_INIT, {
        request_id: 'turn-1',
        mode: 'standard',
        blocks: [
          { id: 'summary', type: 'summary' },
          { id: 'sources', type: 'sources' },
        ],
      }),
      makeEvent(BLOCK_PATCH, {
        block_id: 'summary',
        seq: 1,
        delta: 'Luke ',
      }),
      makeEvent(BLOCK_PATCH, {
        block_id: 'summary',
        seq: 2,
        delta: 'Skywalker',
      }),
      makeEvent(RESPONSE_SNAPSHOT, {
        envelope: {
          request_id: 'turn-1',
          mode: 'standard',
          status: 'complete',
          blocks: [
            {
              id: 'summary',
              type: 'summary',
              state: 'ready',
              seq: 2,
              content: 'Luke Skywalker',
            },
            {
              id: 'sources',
              type: 'sources',
              state: 'omitted',
              seq: 0,
              items: [],
            },
          ],
          source_surface: [],
        },
      }),
      makeEvent(RESPONSE_DONE, {
        request_id: 'turn-1',
        status: 'complete',
      }),
    ]);

    expect(envelope).toBeDefined();
    expect(envelope!.status).toBe('complete');
    const summary = envelope!.blocks.find((block) => block.id === 'summary');
    const sources = envelope!.blocks.find((block) => block.id === 'sources');
    expect(summary?.state).toBe('ready');
    expect(summary?.content).toBe('Luke Skywalker');
    expect(sources?.state).toBe('omitted');
  });
});
