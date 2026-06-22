// rAF-batched viseme scheduler aligned to an audio clock. Ported verbatim from v2.
// Holds a queue of audio-clock-absolute viseme events sorted by t; on each tick
// it dispatches all events the clock has crossed. Never blocks audio.

import { binsToVisemes, computeRmsBins, RMS_BIN_MS } from "./amplitude-fallback";
import { phonemeToViseme, type VisemeId } from "./phonemeViseme";

interface PhonemeFrame {
  ph: string;
  t_start: number;
  t_end: number;
}

interface ScheduledEvent {
  t: number; // absolute audio-clock seconds
  viseme: VisemeId;
}

export interface VisemeSchedulerDeps {
  audioTimeSec: () => number;
  scheduleTick: (cb: (t: number) => void) => () => void;
}

function defaultDeps(): VisemeSchedulerDeps {
  const audioTimeSec = (): number => performance.now() / 1000;
  const scheduleTick = (cb: (t: number) => void): (() => void) => {
    let stopped = false;
    const loop = (): void => {
      if (stopped) return;
      cb(audioTimeSec());
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    return () => {
      stopped = true;
    };
  };
  return { audioTimeSec, scheduleTick };
}

export class VisemeScheduler {
  private events: ScheduledEvent[] = [];
  private listeners: ((v: VisemeId) => void)[] = [];
  private stopTick: (() => void) | null = null;
  private deps: VisemeSchedulerDeps;

  constructor(deps?: VisemeSchedulerDeps) {
    this.deps = deps ?? defaultDeps();
  }

  enqueuePhonemes(phonemes: PhonemeFrame[], audioStartSec: number): void {
    for (const p of phonemes) {
      this.events.push({ t: audioStartSec + p.t_start, viseme: phonemeToViseme(p.ph) });
    }
    if (phonemes.length) {
      const last = phonemes[phonemes.length - 1]!;
      this.events.push({ t: audioStartSec + last.t_end, viseme: "sil" });
    }
    this.events.sort((a, b) => a.t - b.t);
    this.ensureLoop();
  }

  enqueueAmplitude(pcm: Float32Array, audioStartSec: number, sampleRate: number): void {
    const bins = computeRmsBins(pcm, sampleRate, RMS_BIN_MS);
    const visemes = binsToVisemes(bins);
    const binSec = RMS_BIN_MS / 1000;
    let prev: VisemeId | null = null;
    for (let i = 0; i < visemes.length; i += 1) {
      if (visemes[i] === prev) continue;
      this.events.push({ t: audioStartSec + i * binSec, viseme: visemes[i]! });
      prev = visemes[i]!;
    }
    if (prev !== "sil") {
      this.events.push({ t: audioStartSec + visemes.length * binSec, viseme: "sil" });
    }
    this.events.sort((a, b) => a.t - b.t);
    this.ensureLoop();
  }

  onViseme(listener: (v: VisemeId) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  cancel(): void {
    this.events = [];
    this.stopLoop();
  }

  private ensureLoop(): void {
    if (this.stopTick !== null || this.events.length === 0) return;
    this.stopTick = this.deps.scheduleTick((t) => this.tick(t));
  }

  private stopLoop(): void {
    if (this.stopTick) {
      this.stopTick();
      this.stopTick = null;
    }
  }

  private tick(now: number): void {
    while (this.events.length && this.events[0]!.t <= now) {
      const ev = this.events.shift()!;
      this.listeners.forEach((l) => l(ev.viseme));
    }
    if (this.events.length === 0) this.stopLoop();
  }
}
