// Live conversation translation: a two-party interpreter. Each speaker taps their
// language's button, talks, and the app transcribes (local Whisper), translates
// (local LLM), and speaks the result in the other person's language. A text field is
// there for quiet rooms. The local answer to Apple's Live Translation, minus the
// cloud. Kokoro TTS can replace the browser synthesizer for its supported languages.

import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Volume2, ArrowLeftRight, Languages, Send } from 'lucide-react'
import { toast } from 'sonner'
import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { RichOptionSelect } from '@/components/shared/RichOptionSelect'
import { AiGeneratedBadge } from '@/components/shared/AiGeneratedBadge'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { cn } from '@/lib/cn'
import {
  LANGUAGES, MicRecorder, translateText, transcribePcm, speak, type Language,
} from '@/lib/translate'

const NOOP = () => {}

interface Turn { id: string; speaker: 'A' | 'B'; original: string; translation: string; toCode: string }

const langOptions = {
  options: LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
}
const byCode = (code: string): Language => LANGUAGES.find((l) => l.code === code) ?? LANGUAGES[0]

export function TranslatePage() {
  const [langA, setLangA] = useState<Language>(LANGUAGES[0])   // English
  const [langB, setLangB] = useState<Language>(LANGUAGES[1])   // Spanish
  const [turns, setTurns] = useState<Turn[]>([])
  const [recording, setRecording] = useState<'A' | 'B' | null>(null)
  const [busy, setBusy] = useState<'A' | 'B' | null>(null)
  const [draft, setDraft] = useState('')
  const [draftSide, setDraftSide] = useState<'A' | 'B'>('A')
  const recorderRef = useRef<MicRecorder | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)

  usePublishUIContext({ label: 'Translate', description: 'User is running a two-party live translation.' })
  useAppHeader({ query: '', setQuery: NOOP, searchable: false })

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [turns])

  const addTurn = useCallback(async (speaker: 'A' | 'B', original: string) => {
    const from = speaker === 'A' ? langA : langB
    const to = speaker === 'A' ? langB : langA
    if (!original.trim()) return
    setBusy(speaker)
    try {
      const translation = await translateText(original, from.name, to.name)
      setTurns((t) => [...t, { id: crypto.randomUUID(), speaker, original, translation, toCode: to.code }])
      speak(translation, to.code)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not translate')
    } finally {
      setBusy(null)
    }
  }, [langA, langB])

  const toggleTalk = useCallback(async (speaker: 'A' | 'B') => {
    // Stop the in-progress recording for this speaker.
    if (recording === speaker) {
      setRecording(null)
      const rec = recorderRef.current
      recorderRef.current = null
      if (!rec) return
      const pcm = rec.stop()
      setBusy(speaker)
      try {
        const text = await transcribePcm(pcm)
        if (!text) { toast.error('Did not catch that, try again'); return }
        await addTurn(speaker, text)
      } catch {
        toast.error('Transcription failed')
      } finally {
        setBusy(null)
      }
      return
    }
    // Start recording (only one speaker at a time).
    if (recording || busy) return
    try {
      const rec = new MicRecorder()
      await rec.start()
      recorderRef.current = rec
      setRecording(speaker)
    } catch {
      toast.error('Microphone access was blocked')
    }
  }, [recording, busy, addTurn])

  const sendDraft = useCallback(() => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void addTurn(draftSide, text)
  }, [draft, draftSide, addTurn])

  const swap = () => { setLangA(langB); setLangB(langA) }

  const TalkButton = ({ speaker, lang }: { speaker: 'A' | 'B'; lang: Language }) => {
    const isRec = recording === speaker
    const isBusy = busy === speaker
    return (
      <Button
        onClick={() => void toggleTalk(speaker)}
        disabled={(!!recording && !isRec) || (!!busy && !isBusy)}
        variant={isRec ? 'destructive' : 'default'}
        size="lg"
        className="h-14 flex-1"
      >
        {isBusy ? <Spinner size="default" /> : isRec ? <Square className="size-5" /> : <Mic className="size-5" />}
        {isRec ? 'Stop' : `Speak ${lang.label}`}
      </Button>
    )
  }

  return (
    <PageShell>
      <PageContainer className="flex h-full flex-col pb-4">
        <PageHeader subtitle="Two-party live translation. Everything runs on your hub." />

        {/* Language pair */}
        <div className="mb-3 flex items-center gap-2">
          <div className="flex-1">
            <RichOptionSelect groups={[langOptions]} value={langA.code} onChange={(v) => setLangA(byCode(v))} />
          </div>
          <Button variant="ghost" size="icon" onClick={swap} aria-label="Swap languages">
            <ArrowLeftRight className="size-4" />
          </Button>
          <div className="flex-1">
            <RichOptionSelect groups={[langOptions]} value={langB.code} onChange={(v) => setLangB(byCode(v))} />
          </div>
        </div>

        {/* Conversation */}
        <div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto rounded-card border border-border/50 bg-card/40 p-3">
          {turns.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 py-16 text-center text-muted-foreground">
              <Languages className="size-8 opacity-40" />
              <p className="text-sm">Tap a language button and start talking.</p>
            </div>
          ) : (
            turns.map((turn) => (
              <div key={turn.id} className={cn('flex', turn.speaker === 'A' ? 'justify-start' : 'justify-end')}>
                <Card className={cn('max-w-[85%] p-3', turn.speaker === 'A' ? 'rounded-tl-sm' : 'rounded-tr-sm')}>
                  <p className="text-xs text-muted-foreground">{turn.original}</p>
                  <p className="mt-1 text-base font-semibold leading-snug">{turn.translation}</p>
                  <div className="mt-1.5 flex items-center gap-2">
                    <AiGeneratedBadge label="Translated by Loki" tone="brand" />
                    <button
                      type="button"
                      aria-label="Play translation"
                      onClick={() => speak(turn.translation, turn.toCode)}
                      className="rounded-full p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
                    >
                      <Volume2 className="size-4" />
                    </button>
                  </div>
                </Card>
              </div>
            ))
          )}
        </div>

        {/* Talk controls */}
        <div className="mt-3 flex gap-2">
          <TalkButton speaker="A" lang={langA} />
          <TalkButton speaker="B" lang={langB} />
        </div>

        {/* Type fallback */}
        <form className="mt-2 flex items-center gap-2" onSubmit={(e) => { e.preventDefault(); sendDraft() }}>
          <div className="flex shrink-0 overflow-hidden rounded-full border border-border">
            {(['A', 'B'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setDraftSide(s)}
                className={cn('px-3 py-1.5 text-xs font-semibold', draftSide === s ? 'bg-brand text-brand-foreground' : 'text-muted-foreground')}
              >
                {(s === 'A' ? langA : langB).label}
              </button>
            ))}
          </div>
          <Input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Or type to translate…" />
          <Button type="submit" size="icon" disabled={!draft.trim()} aria-label="Translate">
            <Send className="size-4" />
          </Button>
        </form>
      </PageContainer>
    </PageShell>
  )
}
