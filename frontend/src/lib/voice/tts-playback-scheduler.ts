// TTS playback scheduler — ported from v2 (Phase C).
//
// Decodes per-sentence base64 int16 PCM into AudioBuffers and schedules each at
// max(now + PRE_BUFFER_S, nextStart) so sentences play back-to-back without gaps
// while later sentences are still being fetched/synthesized. This is the core of
// the "stream output as fast as it arrives" behavior.

export interface SentencePayload {
  sentence: string
  /** Original pre-normalization text for subtitle display. */
  display_text?: string
  sample_rate: number
  pcm_b64: string
  phonemes?: { viseme: string; t: number; d: number }[]
  words?: { word: string; t: number; d: number }[]
  sentence_pause?: number
}

const PRE_BUFFER_S = 0.05

export class TTSPlaybackScheduler {
  private nextStart = 0
  private playing = false
  private gain: GainNode
  private playbackStartListeners: (() => void)[] = []
  private playbackEndListeners: (() => void)[] = []
  private sentenceEnqueueListeners: ((payload: SentencePayload, startAt: number) => void)[] = []
  private activeNodes: AudioBufferSourceNode[] = []

  constructor(private ctx: AudioContext) {
    this.gain = ctx.createGain()
    this.gain.gain.value = 1.0
    this.gain.connect(ctx.destination)
  }

  get isPlaying(): boolean {
    return this.playing
  }

  setOutputGain(g: number): void {
    this.gain.gain.value = Math.max(0, Math.min(2, g))
  }

  enqueue(payload: SentencePayload): void {
    const buffer = decodePcmBase64(this.ctx, payload.pcm_b64, payload.sample_rate)
    const source = this.ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)

    const now = this.ctx.currentTime
    const startAt = Math.max(now + PRE_BUFFER_S, this.nextStart)
    source.start(startAt)
    const wasPlaying = this.playing
    this.playing = true
    if (!wasPlaying) this.playbackStartListeners.forEach((l) => l())
    this.activeNodes.push(source)
    this.nextStart = startAt + buffer.duration + (payload.sentence_pause ?? 0.3)

    source.onended = () => {
      this.activeNodes = this.activeNodes.filter((n) => n !== source)
      if (this.activeNodes.length === 0) {
        this.playing = false
        this.playbackEndListeners.forEach((l) => l())
      }
    }

    this.sentenceEnqueueListeners.forEach((l) => l(payload, startAt))
  }

  cancelAll(): void {
    for (const node of this.activeNodes) {
      try {
        node.stop(0)
        node.disconnect()
      } catch {
        /* ignore */
      }
    }
    this.activeNodes = []
    if (this.playing) {
      this.playing = false
      this.playbackEndListeners.forEach((l) => l())
    }
    this.nextStart = this.ctx.currentTime
  }

  onPlaybackStart(listener: () => void): () => void {
    this.playbackStartListeners.push(listener)
    return () => {
      this.playbackStartListeners = this.playbackStartListeners.filter((l) => l !== listener)
    }
  }

  onPlaybackEnd(listener: () => void): () => void {
    this.playbackEndListeners.push(listener)
    return () => {
      this.playbackEndListeners = this.playbackEndListeners.filter((l) => l !== listener)
    }
  }

  onSentenceEnqueue(listener: (payload: SentencePayload, startAt: number) => void): () => void {
    this.sentenceEnqueueListeners.push(listener)
    return () => {
      this.sentenceEnqueueListeners = this.sentenceEnqueueListeners.filter((l) => l !== listener)
    }
  }

  get audioContext(): AudioContext {
    return this.ctx
  }
}

function decodePcmBase64(ctx: AudioContext, b64: string, sampleRate: number): AudioBuffer {
  const bin = atob(b64)
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2))
  const floats = new Float32Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) floats[i] = samples[i]! / 32768
  const buffer = ctx.createBuffer(1, floats.length || 1, sampleRate)
  buffer.copyToChannel(floats, 0)
  return buffer
}
