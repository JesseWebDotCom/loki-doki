/**
 * VoiceStreamer
 * --------------
 * Streams ndjson PCM chunks from `/api/v1/audio/tts/stream` and plays
 * them through a WebAudio AudioContext as soon as each chunk arrives.
 * Phonemes are scheduled on a parallel timeline so a viseme callback can
 * fire ~38ms ahead of the corresponding audio for visual lip-sync.
 * Text segments (subtitles) are also scheduled to fire exactly when their
 * audio starts.
 *
 * NO WAV-on-disk anywhere in this pipeline. PCM in, AudioBuffer out.
 */

export interface TimelineEvent {
  t: number;
  v?: string; // viseme
  text?: string; // subtitle segment
}

export type VoiceStreamOptions = {
  voiceId?: string;
  speechRate?: number;
  sentencePause?: number;
  normalizeText?: boolean;
  signal?: AbortSignal;
  onPlaybackStart?: () => void;
};

export class VoiceStreamer {
  private ctx: AudioContext | null = null;
  private nextChunkStartTime = 0;
  private timeline: TimelineEvent[] = [];
  private timelineIdx = 0;
  private rafId: number | null = null;
  private isStreamActive = false;
  private stopped = false;
  private activeSources = new Set<AudioBufferSourceNode>();
  private onVisemeChange: (v: string) => void;
  private onTextChange: (text: string) => void;
  private onEnd: () => void;

  constructor(
    onVisemeChange: (v: string) => void = () => {},
    onEnd: () => void = () => {},
    onTextChange: (text: string) => void = () => {},
  ) {
    this.onVisemeChange = onVisemeChange;
    this.onEnd = onEnd;
    this.onTextChange = onTextChange;
  }

  public async prepare() {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx = new (window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  public async stream(text: string, options: VoiceStreamOptions = {}) {
    await this.prepare();
    this.stopped = false;
    this.isStreamActive = true;
    this.flush();

    try {
      const response = await fetch('/api/v1/audio/tts/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: options.voiceId,
          speech_rate: options.speechRate,
          sentence_pause: options.sentencePause,
          normalize_text: options.normalizeText,
        }),
        signal: options.signal,
      });
      if (!response.ok) {
        throw new Error((await response.text()) || 'Voice stream request failed.');
      }
      if (!response.body) throw new Error('ReadableStream not supported');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (this.stopped || options.signal?.aborted) {
          throw new DOMException('Voice stream aborted.', 'AbortError');
        }
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          const chunk = JSON.parse(line);
          if (chunk.error) throw new Error(chunk.error);

          const binaryStr = atob(chunk.audio_base64);
          const pcmBytes = new Uint8Array(binaryStr.length);
          for (let i = 0; i < binaryStr.length; i++) pcmBytes[i] = binaryStr.charCodeAt(i);

          this.playChunk(
            pcmBytes.buffer,
            chunk.phonemes,
            chunk.sample_rate,
            chunk.samples_per_phoneme,
            chunk.text || '',
            options,
          );
        }
      }
    } finally {
      this.isStreamActive = false;
    }
  }

  private playChunk(
    pcmBuffer: ArrayBuffer,
    phonemes: string[],
    sampleRate: number,
    samplesPerPhoneme: number,
    text: string,
    options: VoiceStreamOptions,
  ) {
    if (!this.ctx || this.stopped) return;
    const safePhonemes = Array.isArray(phonemes) ? phonemes : [];

    const pcm16 = new Int16Array(pcmBuffer);
    const audioBuffer = this.ctx.createBuffer(1, pcm16.length, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm16.length; i++) channelData[i] = pcm16[i] / 32768.0;

    const startTime = Math.max(this.ctx.currentTime + 0.05, this.nextChunkStartTime);
    this.nextChunkStartTime = startTime + audioBuffer.duration;

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);
    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
    source.start(startTime);

    if (startTime <= this.ctx.currentTime + 0.06) {
      options.onPlaybackStart?.();
    }

    // Schedule the subtitle text to appear exactly when audio starts
    if (text) {
      this.timeline.push({ t: startTime, text });
    }

    const sampleDuration = 1 / sampleRate;
    let offset = 0;
    let lastV = '';
    safePhonemes.forEach((p: string) => {
      const cleanP = p.replace(/[ˈːˌ.?!,]/g, '');
      if (!cleanP) return;
      const v = this.mapIPAToViseme(cleanP);
      if (v !== lastV) {
        this.timeline.push({ t: startTime + offset - 0.038, v });
        lastV = v;
      }
      offset += samplesPerPhoneme * sampleDuration;
    });

    // Visemes and text events might be slightly out of order if we aren't careful,
    // so sort the timeline by timestamp before the scheduler reads it.
    this.timeline.sort((a, b) => a.t - b.t);

    this.startScheduler();
  }

  private startScheduler() {
    if (this.rafId !== null) return;
    const tick = () => {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      
      let latestDueViseme: string | null = null;
      let latestDueText: string | null = null;

      while (
        this.timelineIdx < this.timeline.length &&
        this.timeline[this.timelineIdx].t <= now
      ) {
        const entry = this.timeline[this.timelineIdx];
        if (entry.v !== undefined) {
          latestDueViseme = entry.v;
        }
        if (entry.text !== undefined) {
          latestDueText = entry.text;
        }
        this.timelineIdx++;
      }

      if (latestDueViseme !== null) {
        this.onVisemeChange(latestDueViseme);
      }
      if (latestDueText !== null) {
        this.onTextChange(latestDueText);
      }

      if (
        !this.isStreamActive &&
        this.timelineIdx >= this.timeline.length &&
        now > this.nextChunkStartTime + 0.1
      ) {
        this.onVisemeChange('closed');
        this.onTextChange('');
        this.rafId = null;
        this.onEnd();
        return;
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private mapIPAToViseme(p: string): string {
    const map: Record<string, string> = {
      p: 'p', b: 'b', m: 'm', f: 'p', v: 'p',
      a: 'open', æ: 'open', ɑ: 'open', ɒ: 'open', ʌ: 'open', aɪ: 'open', ə: 'open',
      o: 'o', ɔ: 'o', u: 'o', ʊ: 'o', w: 'o', uː: 'o',
      e: 'wide', i: 'wide', ɪ: 'wide', ɛ: 'wide', eɪ: 'wide', iː: 'wide',
      s: 'wide', z: 'wide', ʃ: 'wide', ʒ: 'wide',
      t: 'neutral', d: 'neutral', n: 'neutral', k: 'neutral', g: 'neutral',
      default: 'neutral',
    };
    return map[p] || map.default;
  }

  public flush() {
    this.timeline = [];
    this.timelineIdx = 0;
    this.nextChunkStartTime = 0;
    this.activeSources.forEach((source) => {
      try { source.stop(0); } catch { /* already stopped */ }
      source.disconnect();
    });
    this.activeSources.clear();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public stop() {
    this.stopped = true;
    this.isStreamActive = false;
    this.flush();
    this.onVisemeChange('closed');
    this.onTextChange('');
    this.onEnd();
  }

  public get isActive(): boolean {
    return this.isStreamActive || this.activeSources.size > 0;
  }
}
