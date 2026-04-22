/**
 * Voice-parity unit tests (chunk 16).
 *
 * Covers three contracts from
 * ``docs/rich-response/chunk-16-voice-parity.md``:
 *
 *   1. ``resolveSpokenText(envelope)`` prefers ``envelope.spoken_text``
 *      when non-empty, falls back to the summary-block content trimmed
 *      at a sentence boundary, and NEVER concatenates sources / media /
 *      follow-ups (design §20.2).
 *   2. ``ttsController.bargeIn()`` cancels the current utterance
 *      within 50 ms of the trigger and is idempotent on an already-
 *      idle controller.
 *   3. ``ttsController.speak()`` is snapshot-gated per ``messageKey``
 *      (design §20.4) — the second call for the same key is a no-op
 *      even when the text differs. Duplicate utterances don't stack.
 *   4. ``speakStatus`` enforces the ≤1-per-phase, >3s throttle.
 *
 * ``VoiceStreamer`` is mocked — we are unit-testing the controller,
 * not the audio pipeline.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  STATUS_THROTTLE_DELAY_MS,
  resolveSpokenText,
  ttsController,
} from '../tts';
import type { ResponseEnvelope } from '../../lib/response-types';

// ---------------------------------------------------------------------------
// Mock VoiceStreamer — the controller holds exactly one instance via
// module-load side effect, so we reach through its private field.
// ---------------------------------------------------------------------------

interface FakeStream {
  stream: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  lastOptions?: { signal?: AbortSignal; onPlaybackStart?: () => void };
  // Resolver for the pending stream promise — lets a test "finish"
  // playback by calling resolve(), or barge-in by aborting before the
  // resolver runs.
  resolveCurrent?: () => void;
  rejectCurrent?: (err: unknown) => void;
}

function attachFakeStreamer(): FakeStream {
  const fake: FakeStream = {
    stream: vi.fn(),
    stop: vi.fn(),
  };
  fake.stream.mockImplementation(
    (_text: string, opts: { signal?: AbortSignal; onPlaybackStart?: () => void }) => {
      fake.lastOptions = opts;
      return new Promise<void>((resolve, reject) => {
        fake.resolveCurrent = () => resolve();
        fake.rejectCurrent = (err) => reject(err);
        opts.signal?.addEventListener('abort', () => {
          const dom = new DOMException('aborted', 'AbortError');
          reject(dom);
        });
      });
    },
  );
  // Replace the streamer on the singleton controller.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).streamer = fake;
  return fake;
}

function resetController() {
  // Stop any in-flight utterance and clear snapshot guards between tests.
  ttsController.stop();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).spokenForKey.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).statusThrottle.turnStartedAt = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).statusThrottle.spokenPhases.clear();
  ttsController.setMuted(false);
}

beforeEach(() => {
  attachFakeStreamer();
  resetController();
});

// ---------------------------------------------------------------------------
// resolveSpokenText priority
// ---------------------------------------------------------------------------

describe('resolveSpokenText', () => {
  function makeEnvelope(overrides: Partial<ResponseEnvelope>): ResponseEnvelope {
    return {
      request_id: 'req',
      mode: 'standard',
      status: 'complete',
      blocks: [],
      source_surface: [],
      ...overrides,
    };
  }

  it('prefers envelope.spoken_text when populated', () => {
    const env = makeEnvelope({
      spoken_text: 'Luke heads out.',
      blocks: [
        {
          id: 'summary',
          type: 'summary',
          state: 'ready',
          seq: 1,
          content: 'Luke Skywalker is on Tatooine looking for Obi-Wan.',
        },
      ],
    });
    expect(resolveSpokenText(env)).toBe('Luke heads out.');
  });

  it('falls back to summary content trimmed at sentence boundary', () => {
    const content =
      'Anakin is a Jedi Knight. ' +
      'He married Padme in secret on Naboo. ' +
      'He later turned to the dark side. ' +
      'He became Darth Vader. ' +
      'He served the Emperor for decades until his redemption.';
    const env = makeEnvelope({
      blocks: [
        {
          id: 'summary',
          type: 'summary',
          state: 'ready',
          seq: 1,
          content,
        },
      ],
    });
    const out = resolveSpokenText(env);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith('.') || out.endsWith('!') || out.endsWith('?')).toBe(true);
  });

  it('returns empty string when neither spoken_text nor summary is ready', () => {
    const env = makeEnvelope({
      blocks: [
        { id: 'summary', type: 'summary', state: 'loading', seq: 0 },
      ],
    });
    expect(resolveSpokenText(env)).toBe('');
  });

  it('never reads source urls aloud even when summary is empty', () => {
    const env = makeEnvelope({
      blocks: [
        { id: 'summary', type: 'summary', state: 'ready', seq: 1, content: '' },
        {
          id: 'sources',
          type: 'sources',
          state: 'ready',
          seq: 1,
          items: [{ title: 'Wookieepedia', url: 'https://starwars.fandom.com/wiki/Naboo' }],
        },
      ],
    });
    const out = resolveSpokenText(env);
    expect(out).not.toContain('http');
    expect(out).not.toContain('Wookieepedia');
  });

  it('strips markdown + [src:N] markers from the fallback', () => {
    const env = makeEnvelope({
      blocks: [
        {
          id: 'summary',
          type: 'summary',
          state: 'ready',
          seq: 1,
          content: '**Luke** is from Tatooine [src:1].',
        },
      ],
    });
    const out = resolveSpokenText(env);
    expect(out).not.toContain('**');
    expect(out).not.toContain('[src:');
    expect(out).toContain('Luke is from Tatooine');
  });
});

// ---------------------------------------------------------------------------
// Barge-in + snapshot semantics
// ---------------------------------------------------------------------------

describe('ttsController barge-in + snapshot semantics', () => {
  it('bargeIn cancels the current utterance within one tick', async () => {
    const fake = attachFakeStreamer();
    const before = performance.now();
    const p = ttsController.speak('turn-1', 'Luke finds the droids on Tatooine.');
    ttsController.bargeIn();
    const elapsed = performance.now() - before;
    // 50 ms budget per design §20.4 — anything longer would be a bug.
    expect(elapsed).toBeLessThan(50);
    await expect(p).resolves.toBeUndefined();
    expect(fake.stop).toHaveBeenCalled();
  });

  it('bargeIn on an idle controller is a no-op', () => {
    const fake = attachFakeStreamer();
    expect(() => ttsController.bargeIn()).not.toThrow();
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it('speak is snapshot-gated — duplicate utterances for the same key do not stack', async () => {
    const fake = attachFakeStreamer();
    const p1 = ttsController.speak('turn-7', 'first paraphrase');
    const p2 = ttsController.speak('turn-7', 'second paraphrase');
    // Yield once so the first speak has entered the streamer stub.
    await Promise.resolve();
    // The second speak is a no-op — streamer.stream() must only have
    // been invoked once for this turn.
    expect(fake.stream).toHaveBeenCalledTimes(1);
    // Settle the pending stream promise so the test can exit without
    // hanging on the never-resolving streamer mock.
    ttsController.stop();
    await Promise.all([p1, p2]).catch(() => {
      /* abort rejection is expected */
    });
  });

  it('clearSpokenForKey allows the turn to speak again (explicit replay)', async () => {
    const fake = attachFakeStreamer();
    const p1 = ttsController.speak('turn-9', 'initial utterance');
    await Promise.resolve();
    ttsController.clearSpokenForKey('turn-9');
    const p2 = ttsController.speak('turn-9', 'replay utterance');
    await Promise.resolve();
    expect(fake.stream).toHaveBeenCalledTimes(2);
    ttsController.stop();
    await Promise.all([p1, p2]).catch(() => {});
  });
});

// ---------------------------------------------------------------------------
// speakStatus throttle
// ---------------------------------------------------------------------------

describe('ttsController.speakStatus throttle', () => {
  it('rejects phrases emitted before the throttle gate opens', async () => {
    ttsController.resetStatusThrottle();
    const ok = await ttsController.speakStatus('phase-1', 'Looking up context');
    expect(ok).toBe(false);
  });

  it('accepts one phrase per phase once the 3s gate elapses', async () => {
    ttsController.resetStatusThrottle();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ttsController as any).statusThrottle.turnStartedAt =
      Date.now() - (STATUS_THROTTLE_DELAY_MS + 100);

    const p1 = ttsController.speakStatus('phase-1', 'Checking sources');
    // The first speakStatus is now awaiting the (never-resolving)
    // streamer mock. Let it register its spoken-phases entry, then
    // cancel so the follow-up calls can observe the throttle state.
    await Promise.resolve();
    ttsController.stop();
    const first = await p1.catch(() => false);
    const duplicate = await ttsController.speakStatus('phase-1', 'Checking sources');
    // speakStatus for a new phase re-enters the streamer — same
    // pattern: let it register, then stop to settle the promise.
    const p3 = ttsController.speakStatus('phase-2', 'Pulling a summary');
    await Promise.resolve();
    ttsController.stop();
    const different = await p3.catch(() => false);

    expect(first).toBe(true);
    expect(duplicate).toBe(false); // already spoke this phase
    expect(different).toBe(true); // new phase is allowed
  });

  it('throttle resets on a new turn', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ttsController as any).statusThrottle.turnStartedAt =
      Date.now() - (STATUS_THROTTLE_DELAY_MS + 100);
    const p1 = ttsController.speakStatus('phase-1', 'Checking sources');
    await Promise.resolve();
    ttsController.stop();
    await p1.catch(() => false);

    // New turn — clock re-arms from "now".
    ttsController.resetStatusThrottle();
    const immediately = await ttsController.speakStatus('phase-1', 'Checking sources');
    expect(immediately).toBe(false);
  });

  it('muted controller never speaks status phrases', async () => {
    ttsController.setMuted(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (ttsController as any).statusThrottle.turnStartedAt =
      Date.now() - (STATUS_THROTTLE_DELAY_MS + 100);
    const ok = await ttsController.speakStatus('phase-1', 'Checking sources');
    expect(ok).toBe(false);
  });
});
