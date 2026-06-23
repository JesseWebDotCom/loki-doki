// Voice playback client. Ported from v2 voice-preview.ts (filler/thinking-loop
// specifics removed).
//
// Owns one AudioContext + TTSPlaybackScheduler across multiple concurrent
// /api/tts/stream requests so the read-aloud path can fire one POST per
// completed sentence while the scheduler buffers them seamlessly. Sentence
// fetches run with bounded parallelism (pipeline N+1 while N plays) but
// scheduler.enqueue calls are serialized in issue order so audio never reorders.

import { TTSPlaybackScheduler, type SentencePayload } from "@/lib/voice/tts-playback-scheduler";
import { attachCharacterBridge, getCharacterBridge } from "@/lib/voice/tts-character-bridge";
import { splitSentences } from "@/lib/voice/sentence-chunker";

export interface VoicePlaybackOptions {
  text: string;
  ttsVoice?: string | null;
  characterId?: string | null;
  speechRate?: number;
  sentencePause?: number;
  /** Per-chunk emote-driven multiplier on the character's base speech rate. */
  rateScale?: number;
  /** Per-chunk emote-driven loudness gain applied to the synthesized PCM. */
  gain?: number;
}

export class VoicePlayback {
  private static readonly MAX_PARALLEL_SENTENCE_FETCHES = 2;
  private scheduler: TTSPlaybackScheduler | null = null;
  private aborts: AbortController[] = [];
  private inflight = 0;
  private playing = false;
  private listeners: ((playing: boolean) => void)[] = [];
  private activeFetches = 0;
  private fetchWaiters: Array<() => void> = [];
  private dispatchTail: Promise<void> = Promise.resolve();
  private pendingStartListeners: (() => void)[] = [];
  private pendingEndListeners: (() => void)[] = [];

  get isPlaying(): boolean {
    return this.playing;
  }

  onStateChange(listener: (playing: boolean) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  async prime(): Promise<void> {
    this.ensureScheduler();
    const ctx = this.scheduler?.audioContext;
    if (ctx?.state !== "suspended") return;
    try {
      await ctx.resume();
    } catch {
      /* keep queue alive even if resume rejects */
    }
  }

  /** Stop any prior playback and start a fresh utterance. */
  async play(opts: VoicePlaybackOptions): Promise<void> {
    this.stop();
    await this.prime();
    await this.enqueueText(opts);
  }

  /** Append a sentence to the playback queue without interrupting. */
  async enqueueText(opts: VoicePlaybackOptions): Promise<void> {
    await this.prime();
    const scheduler = this.scheduler;
    const abort = new AbortController();
    this.aborts.push(abort);
    this.inflight += 1;
    this.notify(true);

    const body = {
      text: opts.text,
      voice: opts.ttsVoice || undefined,
      characterId: opts.characterId || undefined,
      speechRate: opts.speechRate ?? 1.0,
      sentencePause: opts.sentencePause ?? 0.3,
      rateScale: opts.rateScale ?? 1.0,
      gain: opts.gain ?? 1.0,
    };

    const predecessorDrained = this.dispatchTail;
    let resolveDrain!: () => void;
    this.dispatchTail = new Promise<void>((r) => {
      resolveDrain = r;
    });

    try {
      const singleSentence = splitSentences(body.text).length <= 1;
      if (singleSentence) {
        await this.acquireFetchSlot(abort.signal);
      } else {
        await predecessorDrained;
      }
      const response = await fetch("/api/tts/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
        signal: abort.signal,
      });
      if (!response.ok || !response.body) {
        let code = "";
        try {
          code = (await response.clone().json())?.code ?? "";
        } catch {
          /* non-JSON body */
        }
        throw new Error(code ? `tts_stream_${response.status}:${code}` : `tts_stream_${response.status}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const bufferedPayloads: SentencePayload[] = [];
      let streamDone = false;
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(line);
          } catch {
            continue;
          }
          if (payload.done === true) {
            streamDone = true;
            break;
          }
          if (typeof payload.error === "string") {
            throw new Error(`voice_unavailable:${payload.error}`);
          }
          if (typeof payload.pcm_b64 === "string" && payload.pcm_b64) {
            if (abort.signal.aborted || this.scheduler !== scheduler) {
              streamDone = true;
              break;
            }
            const next = payload as unknown as SentencePayload;
            if (singleSentence) bufferedPayloads.push(next);
            else scheduler?.enqueue(next);
          }
        }
      }
      if (singleSentence) {
        await predecessorDrained;
        if (abort.signal.aborted || this.scheduler !== scheduler) return;
        for (const payload of bufferedPayloads) scheduler?.enqueue(payload);
        resolveDrain();
      }
    } finally {
      this.releaseFetchSlot();
      resolveDrain();
      this.aborts = this.aborts.filter((a) => a !== abort);
      this.inflight = Math.max(0, this.inflight - 1);
      this.maybeNotifyEnd();
    }
  }

  stop(): void {
    for (const abort of this.aborts) abort.abort();
    this.aborts = [];
    this.inflight = 0;
    if (this.scheduler) {
      getCharacterBridge().cancel();
      this.scheduler.cancelAll();
    }
    this.dispatchTail = Promise.resolve();
    this.activeFetches = 0;
    this.fetchWaiters = [];
    this.notify(false);
  }

  onPlaybackEnd(listener: () => void): () => void {
    if (this.scheduler) return this.scheduler.onPlaybackEnd(listener);
    this.pendingEndListeners.push(listener);
    return () => {
      this.pendingEndListeners = this.pendingEndListeners.filter((l) => l !== listener);
    };
  }

  onPlaybackStart(listener: () => void): () => void {
    if (this.scheduler) return this.scheduler.onPlaybackStart(listener);
    this.pendingStartListeners.push(listener);
    return () => {
      this.pendingStartListeners = this.pendingStartListeners.filter((l) => l !== listener);
    };
  }

  private ensureScheduler(): void {
    if (this.scheduler) return;
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctor();
    this.scheduler = new TTSPlaybackScheduler(ctx);
    attachCharacterBridge(this.scheduler);
    this.scheduler.onPlaybackEnd(() => this.maybeNotifyEnd());
    for (const l of this.pendingStartListeners) this.scheduler.onPlaybackStart(l);
    for (const l of this.pendingEndListeners) this.scheduler.onPlaybackEnd(l);
    this.pendingStartListeners = [];
    this.pendingEndListeners = [];
  }

  private maybeNotifyEnd(): void {
    if (this.inflight === 0 && !this.scheduler?.isPlaying) this.notify(false);
  }

  private notify(playing: boolean): void {
    if (this.playing === playing) return;
    this.playing = playing;
    this.listeners.forEach((l) => l(playing));
  }

  private async acquireFetchSlot(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    if (this.activeFetches < VoicePlayback.MAX_PARALLEL_SENTENCE_FETCHES) {
      this.activeFetches += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const release = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        this.fetchWaiters = this.fetchWaiters.filter((w) => w !== release);
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.fetchWaiters.push(release);
    });
  }

  private releaseFetchSlot(): void {
    if (this.activeFetches === 0) return;
    const next = this.fetchWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeFetches -= 1;
  }
}
