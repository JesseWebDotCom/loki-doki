// Glue between the TTS audio scheduler and the character renderer. Ported from
// v2. Subscribes to per-sentence enqueue events and runs ONE audio-clock rAF
// loop shared across viseme + sentence-frame dispatch. The viseme path re-emits
// as v3 `Viseme` strings the DiceBear renderer consumes; sentence frames drive
// audio-aligned captions (start text + end marker).

import { VisemeScheduler } from "@/components/companion/viseme-scheduler";
import { visemeToCanonical, type VisemeId } from "@/components/companion/phonemeViseme";
import type { Viseme } from "@/components/companion/visemeMap";
import type { SentencePayload, TTSPlaybackScheduler } from "@/lib/voice/tts-playback-scheduler";

export type SentenceFrame =
  | { sentenceId: string; text: string; audio_t_start: number; end?: false }
  | { sentenceId: string; end: true };

export interface CharacterBridgeDeps {
  audioTimeSec?: () => number;
  scheduleTick?: (cb: (t: number) => void) => () => void;
}

interface BridgeEvent {
  t: number;
  fire: () => void;
}

class CharacterBridge {
  private viseme: VisemeScheduler | null = null;
  private detachScheduler: (() => void) | null = null;
  private listeners: ((v: Viseme) => void)[] = [];
  private sentenceListeners: ((f: SentenceFrame) => void)[] = [];
  private cancelListeners: (() => void)[] = [];

  private tickCbs: ((t: number) => void)[] = [];
  private stopLoop: (() => void) | null = null;
  private events: BridgeEvent[] = [];
  private autoSentenceCounter = 0;

  attach(scheduler: TTSPlaybackScheduler, deps?: CharacterBridgeDeps): void {
    this.detach();
    const ctx = scheduler.audioContext;
    const audioTimeSec = deps?.audioTimeSec ?? ((): number => ctx.currentTime);

    if (deps?.scheduleTick) {
      this.stopLoop = deps.scheduleTick((t) => this.runTicks(t));
    } else {
      let stopped = false;
      const loop = (): void => {
        if (stopped) return;
        this.runTicks(audioTimeSec());
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
      this.stopLoop = () => {
        stopped = true;
      };
    }

    this.viseme = new VisemeScheduler({
      audioTimeSec,
      scheduleTick: (cb) => {
        this.tickCbs.push(cb);
        return () => {
          this.tickCbs = this.tickCbs.filter((c) => c !== cb);
        };
      },
    });
    this.viseme.onViseme((v: VisemeId) => {
      const canonical = visemeToCanonical(v);
      this.listeners.forEach((l) => l(canonical));
    });

    this.tickCbs.push((t) => this.drainEvents(t));

    this.detachScheduler = scheduler.onSentenceEnqueue((payload, startAt) => {
      if (this.viseme) {
        if (payload.phonemes && payload.phonemes.length) {
          this.viseme.enqueuePhonemes(
            payload.phonemes.map((p) => ({ ph: p.viseme, t_start: p.t, t_end: p.t + p.d })),
            startAt,
          );
        } else {
          const pcm = decodeForFallback(payload.pcm_b64);
          this.viseme.enqueueAmplitude(pcm, startAt, payload.sample_rate);
        }
      }
      this.enqueueSentenceFrames(payload, startAt);
    });
  }

  detach(): void {
    if (this.detachScheduler) {
      this.detachScheduler();
      this.detachScheduler = null;
    }
    if (this.viseme) {
      this.viseme.cancel();
      this.viseme = null;
    }
    if (this.stopLoop) {
      this.stopLoop();
      this.stopLoop = null;
    }
    this.tickCbs = [];
    this.events = [];
  }

  cancel(): void {
    this.viseme?.cancel();
    this.events = [];
    // Closed mouth + clear caption when audio is cut (barge-in).
    this.listeners.forEach((l) => l("closed"));
    const listeners = this.cancelListeners.slice();
    for (const l of listeners) l();
  }

  onViseme(listener: (v: Viseme) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  onSentenceFrame(listener: (f: SentenceFrame) => void): () => void {
    this.sentenceListeners.push(listener);
    return () => {
      this.sentenceListeners = this.sentenceListeners.filter((l) => l !== listener);
    };
  }

  onCancel(listener: () => void): () => void {
    this.cancelListeners.push(listener);
    return () => {
      this.cancelListeners = this.cancelListeners.filter((l) => l !== listener);
    };
  }

  reset(): void {
    this.detach();
    this.listeners = [];
    this.sentenceListeners = [];
    this.cancelListeners = [];
    this.autoSentenceCounter = 0;
  }

  private runTicks(t: number): void {
    const cbs = this.tickCbs.slice();
    for (const cb of cbs) cb(t);
  }

  private drainEvents(now: number): void {
    while (this.events.length && this.events[0]!.t <= now) {
      const ev = this.events.shift()!;
      ev.fire();
    }
  }

  private enqueueSentenceFrames(payload: SentencePayload, startAt: number): void {
    const sentenceId = `s-${++this.autoSentenceCounter}`;
    const text = payload.display_text ?? payload.sentence;

    this.events.push({
      t: startAt,
      fire: () =>
        this.sentenceListeners.forEach((l) => l({ sentenceId, text, audio_t_start: startAt })),
    });

    const sentenceDuration = pcmDurationSeconds(payload.pcm_b64, payload.sample_rate);
    this.events.push({
      t: startAt + sentenceDuration,
      fire: () => this.sentenceListeners.forEach((l) => l({ sentenceId, end: true })),
    });

    this.events.sort((a, b) => a.t - b.t);
  }
}

let singleton: CharacterBridge | null = null;

export function getCharacterBridge(): CharacterBridge {
  if (!singleton) singleton = new CharacterBridge();
  return singleton;
}

export function attachCharacterBridge(scheduler: TTSPlaybackScheduler, deps?: CharacterBridgeDeps): void {
  getCharacterBridge().attach(scheduler, deps);
}

function decodeForFallback(b64: string): Float32Array {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const floats = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) floats[i] = samples[i]! / 32768;
  return floats;
}

function pcmDurationSeconds(b64: string, sampleRate: number): number {
  const padded = b64.length;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  const byteCount = (padded * 3) / 4 - padding;
  const sampleCount = Math.max(0, Math.floor(byteCount / 2));
  return sampleCount / sampleRate;
}
