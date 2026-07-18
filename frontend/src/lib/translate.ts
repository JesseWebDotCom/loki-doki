// Client for the live conversation translator: LLM text translation (POST
// /api/translate/text), mic capture routed through the existing one-shot Whisper
// endpoint (POST /api/voice/transcribe, raw f32le 16 kHz mono PCM), and spoken
// output via the browser's offline speech synthesis. Kokoro TTS can replace the
// spoken step for its supported languages later; SpeechSynthesis is used here because
// it covers the long tail of target languages Kokoro does not.

const opts: RequestInit = { credentials: 'include' }

export interface Language {
  code: string   // BCP-47, for speech synthesis voice selection
  name: string   // English name, handed to the translator model
  label: string  // shown in the UI
}

export const LANGUAGES: Language[] = [
  { code: 'en', name: 'English', label: 'English' },
  { code: 'es', name: 'Spanish', label: 'Español' },
  { code: 'fr', name: 'French', label: 'Français' },
  { code: 'de', name: 'German', label: 'Deutsch' },
  { code: 'it', name: 'Italian', label: 'Italiano' },
  { code: 'pt', name: 'Portuguese', label: 'Português' },
  { code: 'zh', name: 'Chinese', label: '中文' },
  { code: 'ja', name: 'Japanese', label: '日本語' },
  { code: 'ko', name: 'Korean', label: '한국어' },
  { code: 'hi', name: 'Hindi', label: 'हिन्दी' },
  { code: 'ar', name: 'Arabic', label: 'العربية' },
  { code: 'ru', name: 'Russian', label: 'Русский' },
]

export async function translateText(text: string, fromName: string, toName: string): Promise<string> {
  const r = await fetch('/api/translate/text', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, from: fromName, to: toName }),
  })
  const d = (await r.json().catch(() => null)) as { translation?: string; error?: string } | null
  if (!r.ok || !d?.translation) throw new Error(d?.error || 'Translation failed')
  return d.translation
}

/** Downsample a Float32 PCM buffer to 16 kHz (linear interpolation). */
function resampleTo16k(input: Float32Array, inRate: number): Float32Array {
  if (inRate === 16_000) return input
  const ratio = inRate / 16_000
  const outLen = Math.floor(input.length / ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i * ratio
    const idx = Math.floor(srcPos)
    const frac = srcPos - idx
    out[i] = (input[idx] ?? 0) * (1 - frac) + (input[idx + 1] ?? 0) * frac
  }
  return out
}

/**
 * Records mic audio and returns collected 16 kHz mono PCM. Kept minimal and
 * self-contained; ScriptProcessorNode is deprecated but universally supported and
 * simplest for a short push-to-talk clip.
 */
export class MicRecorder {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: ScriptProcessorNode | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private chunks: Float32Array[] = []
  private rate = 16_000

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
    // Prefer a 16 kHz context; browsers that ignore the hint are handled by resampling.
    this.ctx = new AudioContext({ sampleRate: 16_000 })
    this.rate = this.ctx.sampleRate
    this.source = this.ctx.createMediaStreamSource(this.stream)
    this.node = this.ctx.createScriptProcessor(4096, 1, 1)
    this.chunks = []
    this.node.onaudioprocess = (e) => {
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)))
    }
    this.source.connect(this.node)
    this.node.connect(this.ctx.destination)
  }

  /** Stop capture and return the recorded PCM at 16 kHz. */
  stop(): Float32Array {
    this.node?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.ctx?.close()
    const total = this.chunks.reduce((n, c) => n + c.length, 0)
    const merged = new Float32Array(total)
    let off = 0
    for (const c of this.chunks) { merged.set(c, off); off += c.length }
    this.chunks = []
    return resampleTo16k(merged, this.rate)
  }
}

/** Transcribe 16 kHz mono PCM via the one-shot Whisper endpoint. */
export async function transcribePcm(pcm: Float32Array): Promise<string> {
  const r = await fetch('/api/voice/transcribe', {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: pcm.buffer as ArrayBuffer,
  })
  if (!r.ok) return ''
  return ((await r.json()) as { text?: string }).text?.trim() ?? ''
}

/** Speak text out loud in the given language using the browser's offline synthesizer. */
export function speak(text: string, code: string): void {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
  window.speechSynthesis.cancel()
  const u = new SpeechSynthesisUtterance(text)
  const voice = window.speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith(code))
  if (voice) u.voice = voice
  u.lang = code
  window.speechSynthesis.speak(u)
}
