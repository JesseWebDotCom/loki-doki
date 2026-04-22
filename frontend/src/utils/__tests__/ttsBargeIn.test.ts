import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ttsController } from '../tts';

interface PendingCall {
  options: { signal?: AbortSignal; onPlaybackStart?: () => void };
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface FakeStreamer {
  stop: ReturnType<typeof vi.fn>;
  stream: ReturnType<typeof vi.fn>;
  pendingCalls: PendingCall[];
}

function attachQueuedStreamer(): FakeStreamer {
  const fake: FakeStreamer = {
    stop: vi.fn(),
    stream: vi.fn(),
    pendingCalls: [],
  };
  fake.stream.mockImplementation(
    (_text: string, options: { signal?: AbortSignal; onPlaybackStart?: () => void }) =>
      new Promise<void>((resolve, reject) => {
        const call: PendingCall = {
          options,
          resolve,
          reject,
        };
        fake.pendingCalls.push(call);
        options.onPlaybackStart?.();
        options.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      }),
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).streamer = fake;
  return fake;
}

function resetController() {
  ttsController.stop();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).spokenForKey.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).streamingTurns.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).pendingStreamRequests.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ttsController as any).currentTurnMessageKey = null;
}

beforeEach(() => {
  attachQueuedStreamer();
  resetController();
});

describe('ttsController streaming barge-in', () => {
  it('stops the live utterance, aborts queued work, and drains the queue', async () => {
    const fake = attachQueuedStreamer();
    ttsController.beginStreamingTurn('msg-4', { enabled: true });
    ttsController.updateVisualCursor('msg-4', 999);
    ttsController.pushStreamingDelta(
      'msg-4',
      'Han shoots first. Chewie roars back. The Falcon jumps to lightspeed.',
    );
    await Promise.resolve();
    expect(fake.stream).toHaveBeenCalledTimes(1);

    fake.pendingCalls[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.stream).toHaveBeenCalledTimes(2);

    ttsController.bargeIn();
    await Promise.resolve();

    expect(fake.stop).toHaveBeenCalled();
    expect(fake.pendingCalls[1].options.signal?.aborted).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const turn = (ttsController as any).streamingTurns.get('msg-4');
    expect(turn.turnCancelled).toBe(true);
    expect(turn.utterances).toHaveLength(0);
  });

  it('prevents the next utterance from starting when barge-in lands in the fetch gap', async () => {
    const fake = attachQueuedStreamer();
    ttsController.beginStreamingTurn('msg-5', { enabled: true });
    ttsController.updateVisualCursor('msg-5', 999);
    ttsController.pushStreamingDelta('msg-5', 'Jyn runs. Cassian follows.');
    await Promise.resolve();
    expect(fake.stream).toHaveBeenCalledTimes(1);

    fake.pendingCalls[0].resolve();
    ttsController.bargeIn();
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.stream).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh turn to start cleanly after barge-in', async () => {
    const fake = attachQueuedStreamer();
    ttsController.beginStreamingTurn('msg-6', { enabled: true });
    ttsController.updateVisualCursor('msg-6', 999);
    ttsController.pushStreamingDelta('msg-6', 'Mando arrives.');
    await Promise.resolve();

    ttsController.bargeIn();
    ttsController.beginStreamingTurn('msg-7', { enabled: true });
    ttsController.updateVisualCursor('msg-7', 999);
    ttsController.pushStreamingDelta('msg-7', 'Grogu blinks.');
    await Promise.resolve();

    expect(fake.stream).toHaveBeenCalledTimes(2);
  });
});
