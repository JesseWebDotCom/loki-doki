/**
 * VoiceStreamer Utility
 * Manages raw PCM audio playback and high-precision viseme scheduling.
 * Logic extracted from the Animator Lab for App-Wide integration.
 */

export interface VisemeEvent {
  t: number;      // Execution time in AudioContext.currentTime units
  v: string;      // Viseme type (open, wide, o, neutral, etc)
}

export class VoiceStreamer {
  private ctx: AudioContext | null = null;
  private nextChunkStartTime: number = 0;
  private timeline: VisemeEvent[] = [];
  private timelineIdx: number = 0;
  private rafId: number | null = null;
  private onVisemeChange: (viseme: string) => void;
  private onEnd: () => void;

  constructor(onVisemeChange: (v: string) => void, onEnd: () => void) {
    this.onVisemeChange = onVisemeChange;
    this.onEnd = onEnd;
  }

  public setAudioContext(ctx: AudioContext) {
    this.ctx = ctx;
  }

  public async playChunk(pcmBuffer: ArrayBuffer, phonemes: string[], sampleRate: number, samplesPerPhoneme: number) {
    if (!this.ctx) return;
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    const pcm16 = new Int16Array(pcmBuffer);
    const audioBuffer = this.ctx.createBuffer(1, pcm16.length, sampleRate);
    const channelData = audioBuffer.getChannelData(0);
    
    // Convert PCM16 to Float32 [-1.0, 1.0]
    for (let i = 0; i < pcm16.length; i++) {
       channelData[i] = pcm16[i] / 32768.0;
    }

    const startTime = Math.max(this.ctx.currentTime + 0.05, this.nextChunkStartTime);
    this.nextChunkStartTime = startTime + audioBuffer.duration;

    const source = this.ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.ctx.destination);
    source.start(startTime);

    // Schedule Phonemes
    const sampleDuration = 1 / sampleRate;
    let offset = 0;
    let lastV = '';

    phonemes.forEach((p: string) => {
      const cleanP = p.replace(/[ˈːˌ.?!,]/g, '');
      if (!cleanP) return;

      const v = this.mapIPAToViseme(cleanP);
      if (v !== lastV) {
        // 38ms Lead: THE SWEET SPOT FOR VISUAL SYNC
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

      // Check if finished (allow 100ms buffer after last scheduled chunk)
      if (this.timelineIdx >= this.timeline.length && now > this.nextChunkStartTime + 0.1) {
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
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  public stop() {
    this.flush();
    if (this.ctx) {
       try {
         void this.ctx.close().catch(() => undefined);
       } catch {
         // Ignore repeated closes from teardown paths.
       }
       this.ctx = null;
    }
    this.onVisemeChange('closed');
  }
}
