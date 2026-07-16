import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Volume2 } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Input } from '@/components/ui/input'
import { startMicCapture, type MicCaptureHandle } from '@/lib/voice/mic-capture'
import { SttCapture } from '@/lib/voice/stt-capture'
import { speak, stopSpeech, useVoicePlaying } from '@/lib/voice/voicePlaybackStore'
import { useActiveCompanion } from '@/hooks/useActiveCompanion'

// Simple end-to-end speech check for the profile Tester dialog: speak into the
// mic and watch the live transcript (STT), then have the companion read a line
// back (TTS). Reuses the production transports (SttCapture + voicePlaybackStore)
// so a pass here means the real hands-free path's plumbing works.
export function SpeechTester() {
  const { companion } = useActiveCompanion()

  // ── Speech to text ────────────────────────────────────────────────────────
  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [partial, setPartial] = useState('')
  const [finals, setFinals] = useState<string[]>([])
  const [sttError, setSttError] = useState<string | null>(null)

  const micRef = useRef<MicCaptureHandle | null>(null)
  const sttRef = useRef<SttCapture | null>(null)
  const rafRef = useRef(0)
  const micLevelRef = useRef(0)

  const stopStt = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    micRef.current?.stop()
    micRef.current = null
    sttRef.current?.close()
    sttRef.current = null
    setListening(false)
    setSpeaking(false)
    setMicLevel(0)
    setPartial('')
  }, [])

  const startStt = async () => {
    setSttError(null)
    setPartial('')
    const stt = new SttCapture()
    const opened = stt.open({
      onPartial: (text) => setPartial(text),
      onFinal: (text) => {
        setFinals((f) => [text || '(empty transcript)', ...f].slice(0, 10))
        stopStt()
      },
      onNoSpeech: () => {
        setFinals((f) => ['(no speech detected)', ...f].slice(0, 10))
        stopStt()
      },
      onVad: (isSpeaking) => setSpeaking(isSpeaking),
      onError: (msg) => {
        setSttError(`transcription error: ${msg}`)
        stopStt()
      },
      onClose: () => setListening(false),
    })
    if (!opened) {
      setSttError('could not open the transcription stream')
      return
    }
    sttRef.current = stt
    try {
      const mic = await startMicCapture({
        onFrame: (samples) => {
          let sum = 0
          for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!
          micLevelRef.current = Math.sqrt(sum / Math.max(1, samples.length))
          stt.sendFrame(samples)
        },
      })
      micRef.current = mic
      setListening(true)
      const tick = () => {
        setMicLevel(micLevelRef.current)
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      stt.close()
      setSttError(`could not start the microphone: ${String(e)}`)
    }
  }

  useEffect(() => () => stopStt(), [stopStt])

  // ── Text to speech ────────────────────────────────────────────────────────
  const playing = useVoicePlaying()
  const [ttsText, setTtsText] = useState('Loud and clear. If you can hear this, speech output works.')
  const [ttsError, setTtsError] = useState<string | null>(null)

  const speakNow = async () => {
    setTtsError(null)
    try {
      await speak({
        text: ttsText.trim() || 'This is a speech test.',
        ttsVoice: companion?.ttsVoice ?? undefined,
        characterId: companion?.id ?? undefined,
        speechRate: companion?.speechRate ?? 1.0,
      })
    } catch (e) {
      setTtsError(`could not play speech: ${String(e)}`)
    }
  }

  const micPct = Math.min(100, micLevel * 400)

  return (
    <div className="space-y-4">
      {/* STT */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-semibold">Speech to text</p>
          <button
            type="button"
            onClick={() => (listening ? stopStt() : void startStt())}
            className={cn(
              'flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]',
              listening ? 'border-destructive/50 text-destructive' : 'border-success/50 text-success',
            )}
          >
            {listening ? <><Square className="size-3" /> Stop</> : <><Mic className="size-3" /> Test</>}
          </button>
        </div>
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <span className="w-10 shrink-0">Mic</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
            <div className="h-full rounded-full bg-brand transition-[width] duration-75" style={{ width: `${micPct}%` }} />
          </div>
          <span className={cn('shrink-0 rounded-full px-1.5 py-0.5', speaking ? 'bg-success/15 text-success' : 'bg-foreground/5')}>
            {speaking ? 'speech' : 'quiet'}
          </span>
        </div>
        {listening && (
          <p className="min-h-4 text-xs italic text-muted-foreground">
            {partial || 'Listening. Say something; it stops on its own when you pause.'}
          </p>
        )}
        {sttError && <p className="rounded-card border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{sttError}</p>}
        {finals.length > 0 && (
          <div className="max-h-24 space-y-0.5 overflow-y-auto rounded-card border border-border bg-black/30 p-1.5 font-mono text-[10px] text-muted-foreground">
            {finals.map((t, i) => <div key={i} className="truncate">{t}</div>)}
          </div>
        )}
      </div>

      {/* TTS */}
      <div className="space-y-2">
        <p className="text-xs font-semibold">Text to speech</p>
        <div className="flex items-center gap-2">
          <Input value={ttsText} onChange={(e) => setTtsText(e.target.value)} placeholder="Text to speak" className="h-8 flex-1 text-xs" />
          <button
            type="button"
            onClick={() => (playing ? stopSpeech() : void speakNow())}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]',
              playing ? 'border-destructive/50 text-destructive' : 'border-success/50 text-success',
            )}
          >
            {playing ? <><Square className="size-3" /> Stop</> : <><Volume2 className="size-3" /> Speak</>}
          </button>
        </div>
        {companion && (
          <p className="text-[10px] text-muted-foreground">Speaks with {companion.name}'s voice, the same one the live companion uses.</p>
        )}
        {ttsError && <p className="rounded-card border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{ttsError}</p>}
      </div>
    </div>
  )
}
