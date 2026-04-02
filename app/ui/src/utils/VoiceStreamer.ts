/**
 * VoiceStreamer Utility
 * Manages sentence-level PCM chunks via fetch streaming (no-WAV pipeline).
 * Upgraded for high-precision viseme scheduling in the main LokiDoki app.
 */

export interface VisemeEvent {
  t: number;      // Execution time in AudioContext.currentTime units
  v: string;      // Viseme type (open, wide, o, neutral, etc)
}

type VoiceStreamOptions = {
  token: string
  voiceId?: string
  signal?: AbortSignal
  onChunkScheduled?: () => void
  onPlaybackStart?: () => void
}

export class VoiceStreamer {
  private ctx: AudioContext | null = null;
  private nextChunkStartTime: number = 0;
  private timeline: VisemeEvent[] = [];
  private timelineIdx: number = 0;
  private rafId: number | null = null;
  private isStreamActive: boolean = false;
  private activeSources = new Set<AudioBufferSourceNode>();
  private onVisemeChange: (viseme: string) => void;
  private onEnd: () => void;

  constructor(onVisemeChange: (v: string) => void, onEnd: () => void) {
    this.onVisemeChange = onVisemeChange;
    this.onEnd = onEnd;
  }

  public setAudioContext(ctx: AudioContext) {
    this.ctx = ctx;
  }

  public async prepare() {
    if (!this.ctx || this.ctx.state === "closed") {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
  }

  /**
   * Starts a streaming fetch request to the backend.
   * Parses the ndjson stream in real-time and schedules chunks.
   */
  public async stream(text: string, options: VoiceStreamOptions) {
    await this.prepare()

    this.isStreamActive = true;
    this.flush();

    try {
      const response = await fetch("/api/voices/stream", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${options.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          voice_id: options.voiceId || "",
        }),
        signal: options.signal,
      });

      if (!response.ok) {
        throw new Error(await response.text() || "Voice stream request failed.");
      }
      if (!response.body) throw new Error('ReadableStream not supported');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (options.signal?.aborted) {
          throw new DOMException("Voice stream aborted.", "AbortError");
        }
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep partial line in buffer

        for (const line of lines) {
           if (!line.trim()) continue;
           const chunk = JSON.parse(line);
           if (chunk.error) throw new Error(chunk.error);
           
           // Convert base64 to ArrayBuffer
           const binaryStr = atob(chunk.audio_base64);
           const pcmBuffer = new Uint8Array(binaryStr.length);
           for (let i = 0; i < binaryStr.length; i++) {
             pcmBuffer[i] = binaryStr.charCodeAt(i);
           }

           await this.playChunk(
             pcmBuffer.buffer, 
             chunk.phonemes, 
             chunk.sample_rate, 
             chunk.samples_per_phoneme,
             options
           );
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      console.error('VoiceStreamer: Fetch failed', err);
      throw err;
    } finally {
      this.isStreamActive = false;
    }
  }

  private async playChunk(
    pcmBuffer: ArrayBuffer,
    phonemes: string[],
    sampleRate: number,
    samplesPerPhoneme: number,
    options: VoiceStreamOptions
  ) {
    if (!this.ctx) return;
    const safePhonemes = Array.isArray(phonemes) ? phonemes : [];

    const pcm16 = new Int16Array(pcmBuffer);
    const audioBuffer = this.ctx.createBuffer(1, pcm16.length, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    
    for (let i = 0; i < pcm16.length; i++) {
       channelData[i] = pcm16[i] / 32768.0;
    }

    // High-precision timing: ensure chunks overlap perfectly
    const startTime = Math.max(this.ctx.currentTime + 0.05, this.nextChunkStartTime);
    this.nextChunkStartTime = startTime + audioBuffer.duration;

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);
    this.activeSources.add(source);
    source.onended = () => {
      this.activeSources.delete(source);
    };
    source.start(startTime);
    options.onChunkScheduled?.();
    if (startTime <= this.ctx.currentTime + 0.06) {
      options.onPlaybackStart?.();
    }

    // Schedule Phonemes
    const sampleDuration = 1 / sampleRate;
    let offset = 0;
    let lastV = '';

    safePhonemes.forEach((p: string) => {
      const cleanP = p.replace(/[ˈːˌ.?!,]/g, '');
      if (!cleanP) return;

      const v = this.mapIPAToViseme(cleanP);
      if (v !== lastV) {
        // 38ms Lead for visual parity
        this.timeline.push({ t: startTime + offset - 0.038, v });
        lastV = v;
      }
      offset += (samplesPerPhoneme * sampleDuration);
    });

    this.startScheduler();
  }

  private startScheduler() {
    if (this.rafId !== null) return;

    const tick = () => {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      
      while (this.timelineIdx < this.timeline.length && this.timeline[this.timelineIdx].t <= now) {
        this.onVisemeChange(this.timeline[this.timelineIdx].v);
        this.timelineIdx++;
      }

      // Done when stream is closed AND all chunks played
      if (!this.isStreamActive && this.timelineIdx >= this.timeline.length && now > this.nextChunkStartTime + 0.1) {
        this.onVisemeChange('closed');
        this.rafId = null;
        this.onEnd();
        return;
      }

      this.rafId = requestAnimationFrame(tick);
    };

    this.rafId = requestAnimationFrame(tick);
  }

  private mapIPAToViseme(p: string): string {
    const IPA_TO_VISEME: Record<string, string> = {
      'p': 'p', 'b': 'b', 'm': 'm', 'f': 'p', 'v': 'p',
      'a': 'open', 'æ': 'open', 'ɑ': 'open', 'ɒ': 'open', 'ʌ': 'open', 'aɪ': 'open', 'ə': 'open',
      'o': 'o', 'ɔ': 'o', 'u': 'o', 'ʊ': 'o', 'w': 'o', 'uː': 'o',
      'e': 'wide', 'i': 'wide', 'ɪ': 'wide', 'ɛ': 'wide', 'eɪ': 'wide', 'iː': 'wide', 
      's': 'wide', 'z': 'wide', 'ʃ': 'wide', 'ʒ': 'wide',
      't': 'neutral', 'd': 'neutral', 'n': 'neutral', 'k': 'neutral', 'g': 'neutral',
      'default': 'neutral'
    };
    return IPA_TO_VISEME[p] || IPA_TO_VISEME['default'];
  }

  public flush() {
    this.timeline = [];
    this.timelineIdx = 0;
    this.nextChunkStartTime = 0;
    this.activeSources.forEach((source) => {
      try {
        source.stop(0);
      } catch {
        // Source may already be stopped.
      }
      source.disconnect();
    });
    this.activeSources.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public stop() {
    this.isStreamActive = false;
    this.flush();
    this.onVisemeChange('closed');
  }

  public async destroy() {
    this.stop();
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
