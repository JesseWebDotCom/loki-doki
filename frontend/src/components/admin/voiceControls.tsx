import { useCallback, useEffect, useRef, useState } from 'react'
import { Play, Download, Trash2, Mic, Square, Save, Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { RichOptionSelect, type RichOptionGroup } from '@/components/shared/RichOptionSelect'
import { DownloadProgress } from '@/components/shared/DownloadProgress'
import { speak } from '@/lib/voice/voicePlaybackStore'
import { startMicCapture, type MicCaptureHandle } from '@/lib/voice/mic-capture'
import { WakeWordLoop } from '@/lib/voice/wake-word-loop'
import { loadInstalledWakewords } from '@/lib/voice/wake-word-models'
import { onWakeDetected } from '@/lib/voice/wake-word-events'

// ── Kokoro voice picker (per-character + app default) ────────────────────────
interface KokoroVoice { id: string; name: string; language?: string; gender?: string }

export function VoicePicker({ value, onChange, previewName, voicesEndpoint = '/api/admin/voice/voices' }: { value: string; onChange: (v: string) => void; previewName?: string; /** Design: keen-percolating-swan. The end-user voice-customization sheet passes '/api/voice/voices' (requireAuth) instead of the admin-only default. */ voicesEndpoint?: string }) {
  const [voices, setVoices] = useState<KokoroVoice[]>([])
  useEffect(() => {
    fetch(voicesEndpoint, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { voices: [] }))
      .then((d: { voices: KokoroVoice[] }) => setVoices(d.voices ?? []))
      .catch(() => {})
  }, [voicesEndpoint])

  // Group by language; build qualified `kokoro:<id>` values. First group = default.
  const byLang = new Map<string, KokoroVoice[]>()
  for (const v of voices) {
    const lang = v.language || 'Other'
    if (!byLang.has(lang)) byLang.set(lang, [])
    byLang.get(lang)!.push(v)
  }
  const groups: RichOptionGroup[] = [
    { label: undefined, options: [{ value: '', label: 'App default', description: 'Use the app-wide default voice' }] },
    ...[...byLang.entries()].map(([lang, vs]) => ({
      label: lang,
      options: vs.map((v) => ({ value: `kokoro:${v.id}`, label: v.name, description: v.gender || undefined })),
    })),
  ]

  const preview = async () => {
    await speak({ text: `Hi, I'm ${previewName || 'your companion'}.`, ttsVoice: value || undefined })
  }

  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <RichOptionSelect groups={groups} value={value} onChange={onChange} placeholder="App default voice" />
      </div>
      <button type="button" onClick={() => void preview()} title="Preview voice" className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border hover:bg-foreground/5">
        <Play className="size-4" />
      </button>
    </div>
  )
}

// ── Installed wakeword picker ────────────────────────────────────────────────
interface InstalledWakeword { id: string; label: string }

export function WakewordSelect({ value, onChange, refreshKey }: { value: string; onChange: (v: string) => void; refreshKey?: number }) {
  const [installed, setInstalled] = useState<InstalledWakeword[]>([])
  useEffect(() => {
    fetch('/api/voice/wakewords', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : { detectors: [] }))
      .then((d: { detectors: InstalledWakeword[] }) => setInstalled(d.detectors ?? []))
      .catch(() => {})
  }, [refreshKey])
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className="ld-input">
      <option value="">App default</option>
      {installed.map((w) => <option key={w.id} value={w.id}>{w.label}</option>)}
      {installed.length === 0 && <option value="" disabled>No wake words installed — see browser below</option>}
    </select>
  )
}

// ── Custom wakeword trainer (type phrase → phonetics confirm → train) ────────
interface TrainedEntry { id: string; label: string; installed: boolean }

type TrainerPhase =
  | { tag: 'idle' }
  | { tag: 'checking' }
  | { tag: 'confirm'; rawPhrase: string; options: string[]; selected: number; custom: string }
  | { tag: 'training'; phrase: string; log: string[]; error: string | null }

// 'auto' = train across the full diverse voice set (speaker-independent). This
// is the reliable default: training on a single TTS voice overfits to that one
// timbre and barely fires on a real human voice.
const TRAINING_VOICE_AUTO = 'auto'

export function CustomWakewordTrainer({ onAdded, characterId }: { onAdded?: (modelId: string) => void; characterId?: string }) {
  const [inputPhrase, setInputPhrase] = useState('')
  const [trainingVoice, setTrainingVoice] = useState(TRAINING_VOICE_AUTO)
  const [availableVoices, setAvailableVoices] = useState<{ id: string; name: string }[]>([])
  const [phase, setPhase] = useState<TrainerPhase>({ tag: 'idle' })
  const [trained, setTrained] = useState<TrainedEntry[]>([])
  const [trainInstalled, setTrainInstalled] = useState<boolean | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const loadTrained = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/wakewords/catalog', { credentials: 'include' })
      if (res.ok) {
        const d = await res.json() as { trained?: TrainedEntry[]; trainInstalled?: boolean }
        setTrained(d.trained ?? [])
        setTrainInstalled(d.trainInstalled ?? false)
      }
    } catch { /* offline */ }
  }, [])
  useEffect(() => { void loadTrained() }, [loadTrained])

  useEffect(() => {
    fetch('/api/admin/voice/voices', { credentials: 'include' })
      .then(r => r.ok ? r.json() : { voices: [] })
      .then((d: { voices: { id: string; name: string }[] }) => setAvailableVoices(d.voices ?? []))
      .catch(() => {})
  }, [])

  const cancel = () => {
    abortRef.current?.abort()
    setPhase({ tag: 'idle' })
  }

  // ── Step 1: Ask LLM for phonetic options ────────────────────────────────────
  const checkPhonetics = async () => {
    const raw = inputPhrase.trim()
    if (!raw) return
    setInputPhrase('')
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ tag: 'checking' })
    try {
      const res = await fetch('/api/admin/wakewords/phonetics', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phrase: raw }),
        signal: ctrl.signal,
      })
      if (res.status === 503 || !res.ok) {
        // LLM offline — skip straight to training with raw phrase
        void startTraining(raw)
        return
      }
      const d = await res.json() as { options?: string[] }
      const opts = (d.options ?? []).filter(Boolean)
      if (opts.length === 0) {
        void startTraining(raw)
        return
      }
      setPhase({ tag: 'confirm', rawPhrase: raw, options: opts, selected: 0, custom: '' })
    } catch (err) {
      if ((err as Error).name === 'AbortError') { setPhase({ tag: 'idle' }); return }
      // Network error — skip to training
      void startTraining(raw)
    }
  }

  // ── Step 2: Train with chosen pronunciation ──────────────────────────────────
  // `phrase` = phonetic spelling fed to TTS; `label` = what the user typed (shown in UI)
  const startTraining = async (phrase: string, label?: string) => {
    const displayLabel = label ?? phrase
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ tag: 'training', phrase: displayLabel, log: [`Training "${displayLabel}"…`], error: null })

    const addLog = (msg: string) =>
      setPhase((p) => p.tag === 'training' ? { ...p, log: [...p.log.slice(-20), msg] } : p)

    let completed = false
    try {
      const res = await fetch('/api/admin/wakewords/train', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        // Pass the character so the backend attaches the model directly — the
        // model is useless until a character points at it, and relying on a
        // later form Save silently drops it (companion falls back to hey_jarvis).
        body: JSON.stringify({ phrase, label: displayLabel, characterId, trainingVoice }),
        signal: ctrl.signal,
      })
      if (!res.ok || !res.body) throw new Error(await res.text())
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const dataLine = part.split('\n').find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          try {
            const ev = JSON.parse(dataLine.slice(5).trim()) as { status?: string; msg?: string; modelId?: string; error?: string }
            if (ev.msg) addLog(ev.msg)
            if (ev.status === 'complete' && ev.modelId) {
              completed = true
              addLog('✓ Done — model ready')
              setPhase((p) => p.tag === 'training' ? { ...p, error: null } : p)
              await loadTrained()
              onAdded?.(ev.modelId)
            }
            if (ev.status === 'error') throw new Error(ev.error ?? 'Training failed')
          } catch (e) {
            if ((e as Error).name !== 'SyntaxError') throw e
          }
        }
      }
      if (!completed) setPhase((p) => p.tag === 'training' ? { ...p, error: 'Stream ended unexpectedly' } : p)
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        setPhase({ tag: 'idle' })
      } else {
        setPhase((p) => p.tag === 'training' ? { ...p, error: String(err) } : p)
      }
    }
  }

  const remove = async (id: string) => {
    await fetch(`/api/admin/wakewords/${id}`, { method: 'DELETE', credentials: 'include' })
    await loadTrained()
    onAdded?.('')
  }

  const isIdle = phase.tag === 'idle'

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-muted-foreground">
        Type the phrase you'll say aloud — e.g. <span className="font-mono text-foreground/70">hey loki</span>. The AI will suggest phonetic spellings so the TTS trains on the right sounds.
      </p>

      {trainInstalled === false && (
        <p className="rounded-card border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          "Wake Word Training" is not installed — add it in Admin → Features first (~160 MB Python venv).
        </p>
      )}

      {/* ── idle / checking: phrase input + voice picker ── */}
      {(isIdle || phase.tag === 'checking') && (
        <div className="space-y-1.5">
          <div className="flex gap-2">
            <input
              value={inputPhrase}
              onChange={(e) => setInputPhrase(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void checkPhonetics() }}
              placeholder="e.g.  hey loki  or  computer"
              className="ld-input flex-1"
              disabled={phase.tag === 'checking' || trainInstalled === false}
            />
            <button
              type="button"
              onClick={() => void checkPhonetics()}
              disabled={phase.tag === 'checking' || !inputPhrase.trim() || trainInstalled === false}
              className="shrink-0 rounded-full border border-border px-3 py-1.5 text-xs transition-colors hover:bg-foreground/5 disabled:opacity-50"
            >
              {phase.tag === 'checking'
                ? <span className="inline-flex items-center gap-1.5"><Spinner size="sm" className="text-current" />Checking…</span>
                : 'Add'}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground shrink-0">Training voice</span>
            <select
              value={trainingVoice}
              onChange={(e) => setTrainingVoice(e.target.value)}
              disabled={phase.tag === 'checking' || trainInstalled === false}
              className="ld-input flex-1 text-[11px]"
            >
              <option value={TRAINING_VOICE_AUTO}>All voices (recommended)</option>
              {availableVoices.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <p className="text-[10px] text-muted-foreground">All voices trains across many timbres so the detector recognizes your real voice. Pick a single voice only if you want it to respond to that one voice.</p>
        </div>
      )}

      {/* ── confirm: pick phonetic pronunciation ── */}
      {phase.tag === 'confirm' && (
        <div className="space-y-2 rounded-card border border-border bg-background/50 p-3">
          <p className="text-[11px] text-muted-foreground">
            How should <span className="font-medium text-foreground">"{phase.rawPhrase}"</span> be pronounced? Pick the closest — the TTS will train on this exact spelling.
          </p>
          <div className="space-y-1">
            {phase.options.map((opt, i) => (
              <label key={i} className={cn('flex cursor-pointer items-center gap-2 rounded-control border px-2 py-1.5 text-[11px] transition-colors', phase.selected === i && phase.custom === '' ? 'border-brand/50 bg-brand/10' : 'border-border hover:bg-foreground/5')}>
                <input
                  type="radio"
                  name="phonetic"
                  className="accent-brand"
                  checked={phase.selected === i && phase.custom === ''}
                  onChange={() => setPhase({ ...phase, selected: i, custom: '' })}
                />
                <span className="flex-1 font-mono">{opt}</span>
                <button
                  type="button"
                  title="Preview"
                  onClick={() => void speak({ text: opt })}
                  className="flex size-5 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
                >
                  <Play className="size-3" />
                </button>
              </label>
            ))}
          </div>
          <div className="space-y-1">
            <p className="text-[10px] text-muted-foreground">None of these? Type your own:</p>
            <div className="flex gap-2">
              <input
                value={phase.custom}
                onChange={(e) => setPhase({ ...phase, custom: e.target.value })}
                placeholder="e.g.  hey LOH-kee"
                className="ld-input flex-1 text-xs"
              />
              {phase.custom.trim() && (
                <button
                  type="button"
                  title="Preview custom"
                  onClick={() => void speak({ text: phase.custom.trim() })}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border hover:bg-foreground/5"
                >
                  <Play className="size-3" />
                </button>
              )}
            </div>
          </div>
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                const chosen = phase.custom.trim() || phase.options[phase.selected] || phase.rawPhrase
                void startTraining(chosen, phase.rawPhrase)
              }}
              className="flex-1 rounded-full border border-brand/50 bg-brand/10 py-1.5 text-[11px] font-medium text-brand hover:bg-brand/20"
            >
              Train with this pronunciation
            </button>
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              className="h-auto px-3 py-1.5 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-muted-foreground"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* ── training: SSE progress log ── */}
      {phase.tag === 'training' && (
        <div className="space-y-2">
          <div className="rounded-card border border-border bg-background/50 p-2 font-mono text-[10px] text-muted-foreground">
            {phase.log.slice(-8).map((l, i) => <div key={i}>{l}</div>)}
            {phase.error && <div className="text-destructive">{phase.error}</div>}
            {/* design-ok(adhoc-pulse): typing-indicator-style activity affordance for the streaming SSE training log, not a loading skeleton */}
            {!phase.error && <div className="animate-pulse">…</div>}
          </div>
          {!phase.error && (
            <Button
              type="button"
              variant="outline"
              onClick={cancel}
              className="h-auto border-destructive/30 px-3 py-1 text-[11px] text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              Cancel
            </Button>
          )}
          {phase.error && (
            <button type="button" onClick={() => setPhase({ tag: 'idle' })} className="rounded-full border border-border px-3 py-1 text-[11px] text-muted-foreground hover:bg-foreground/5">
              Dismiss
            </button>
          )}
        </div>
      )}

      {/* ── trained phrases list ── */}
      {trained.length > 0 && (
        <div className="space-y-1">
          {trained.map((t) => (
            <div key={t.id} className={cn('flex items-center gap-2 rounded-control border px-2 py-1.5 text-[11px]', t.installed ? 'border-success/20 bg-success/5' : 'border-warning/30 bg-warning/5')}>
              <span className="flex-1 truncate font-medium">{t.label}</span>
              {!t.installed && <span className="text-[10px] text-warning">model missing</span>}
              <button type="button" onClick={() => void remove(t.id)} title="Remove" className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Wakeword download browser (admin) ────────────────────────────────────────
interface CatalogEntry { id: string; file: string; label: string; description: string; approxBytes: number; installed: boolean }
interface Progress { completed: number; total: number; speedBps: number; etaSeconds: number; status?: string }

export function WakewordBrowser() {
  const [entries, setEntries] = useState<CatalogEntry[]>([])
  const [coreInstalled, setCoreInstalled] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/wakewords/catalog', { credentials: 'include' })
      if (res.ok) { const d = await res.json() as { entries: CatalogEntry[]; coreInstalled: boolean }; setEntries(d.entries); setCoreInstalled(d.coreInstalled) }
    } catch { /* offline */ }
  }, [])
  useEffect(() => { void load() }, [load])

  const install = async (id: string) => {
    setBusyId(id); setProgress(null); setError(null)
    const ctrl = new AbortController(); abortRef.current = ctrl
    try {
      const res = await fetch('/api/admin/wakewords/import', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }), signal: ctrl.signal,
      })
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''; let evt = ''
      while (true) {
        const { value, done } = await reader.read(); if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
          if (line.startsWith('event:')) evt = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            let data: Progress & { error?: string }
            try { data = JSON.parse(line.slice(5).trim()) } catch { continue } // skip malformed frame
            if (evt === 'progress') setProgress(data)
            else if (evt === 'error') setError(data.error || 'Download failed')
            else if (evt === 'done') { await load(); setBusyId(null); setProgress(null) }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(String(e))
    } finally {
      if (abortRef.current === ctrl) abortRef.current = null
      setBusyId((b) => (b === id ? null : b))
    }
  }

  const remove = async (id: string) => {
    await fetch(`/api/admin/wakewords/${id}`, { method: 'DELETE', credentials: 'include' })
    await load()
  }

  return (
    <div className="space-y-2">
      {!coreInstalled && (
        <p className="rounded-card border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          Install the “Wake Word” engine in the Features panel first (downloads the shared models).
        </p>
      )}
      {busyId && (progress || error) && (
        <DownloadProgress
          label={entries.find((e) => e.id === busyId)?.label ?? 'Wake word'}
          status={error ? 'error' : 'downloading'}
          downloadedBytes={progress?.completed}
          totalBytes={progress?.total}
          speedBps={progress?.speedBps}
          etaSeconds={progress?.etaSeconds}
          error={error ?? undefined}
          onCancel={() => abortRef.current?.abort()}
        />
      )}
      <div className="grid grid-cols-2 gap-1.5">
        {entries.map((e) => (
          <div key={e.id} className={cn('flex items-center gap-2 rounded-control border px-2 py-1.5 text-[11px]', e.installed ? 'border-success/30 bg-success/5' : 'border-border')}>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{e.label}</div>
              <div className="truncate text-muted-foreground">{e.description}</div>
            </div>
            {e.installed
              ? <button type="button" onClick={() => void remove(e.id)} title="Remove" className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></button>
              : <button type="button" disabled={busyId !== null} onClick={() => void install(e.id)} title="Download" className="flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 hover:bg-foreground/5 disabled:opacity-50"><Download className="size-3" /></button>}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Wake phrase field (Whisper phrase wake) ──────────────────────────────────
// Phrase-based wake needs no training: Whisper transcribes the mic and matches
// the configured phrase as words, so "hey loki" is never confused with "hey
// alexa". The "right" phrase is whatever Whisper actually TRANSCRIBES when you
// say it (Whisper may hear "low key", "loki", "loaky"…), so the record-and-hear
// helper below is this path's equivalent of the trained model's phonetic check:
// say it, see what Whisper heard, and use that exact text as the phrase.
export function WakePhraseField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [recording, setRecording] = useState(false)
  const [heard, setHeard] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const micRef = useRef<MicCaptureHandle | null>(null)
  const framesRef = useRef<Float32Array[]>([])
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const finish = useCallback(async () => {
    if (stopTimerRef.current) { clearTimeout(stopTimerRef.current); stopTimerRef.current = null }
    micRef.current?.stop(); micRef.current = null
    setRecording(false)
    const total = framesRef.current.reduce((n, f) => n + f.length, 0)
    if (total === 0) { setError('No audio captured'); return }
    const pcm = new Float32Array(total)
    let off = 0
    for (const f of framesRef.current) { pcm.set(f, off); off += f.length }
    framesRef.current = []
    try {
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm.buffer as ArrayBuffer,
      })
      const text = res.ok ? (((await res.json()) as { text?: string }).text ?? '').trim() : ''
      setHeard(text || '(nothing heard — try again, closer to the mic)')
    } catch (e) { setError(String(e)) }
  }, [])

  const record = async () => {
    setError(null); setHeard(null); framesRef.current = []
    try {
      micRef.current = await startMicCapture({ onFrame: (s) => framesRef.current.push(s.slice()) })
      setRecording(true)
      stopTimerRef.current = setTimeout(() => void finish(), 2500) // ~2.5s window
    } catch (e) { setError(`mic blocked: ${String(e)}`) }
  }

  useEffect(() => () => { micRef.current?.stop(); if (stopTimerRef.current) clearTimeout(stopTimerRef.current) }, [])

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
  const heardClean = heard ? norm(heard) : ''
  const matches = heardClean && value.trim() && heardClean.includes(norm(value))

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g.  hey loki"
          className="ld-input flex-1"
        />
        <button
          type="button"
          onClick={() => (recording ? void finish() : void record())}
          className={cn('flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-2 text-sm', recording ? 'border-destructive/50 text-destructive' : 'border-border hover:bg-foreground/5')}
          title="Say the phrase and see exactly what Whisper transcribes"
        >
          {recording ? <><Square className="size-3.5" /> Stop</> : <><Mic className="size-3.5" /> Test</>}
        </button>
      </div>
      {recording && <p className="text-[11px] text-brand">Listening… say your wake phrase clearly.</p>}
      {heard && (
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground">Whisper heard:</span>
          <span className="font-mono text-foreground/80">"{heard}"</span>
          {matches
            ? <span className="flex items-center gap-1 text-success"><Check className="size-3" /> matches</span>
            : heardClean && <button type="button" onClick={() => onChange(heard!.replace(/[.?!,]+$/, ''))} className="rounded-full border border-border px-1.5 py-0.5 hover:bg-foreground/5">Use this</button>}
        </div>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

// ── Live wakeword tester ─────────────────────────────────────────────────────
// A self-contained diagnostic: engage the mic + wake loop and show the live mic
// input level, the wake score vs threshold, and detections — so you can see
// exactly where the pipeline breaks (no mic level = mic; level but score stuck
// at 0 = ORT/model; score climbs but won't fire = threshold too high).
export function WakewordTester({ initialModelId, allowSave = true }: { initialModelId?: string; allowSave?: boolean } = {}) {
  const [running, setRunning] = useState(false)
  const [micLevel, setMicLevel] = useState(0)
  const [score, setScore] = useState(0)
  const [threshold, setThreshold] = useState(0.5)
  const [modelId, setModelId] = useState(initialModelId ?? 'hey_jarvis')
  const [detectors, setDetectors] = useState<{ id: string; label: string; defaultThreshold?: number }[]>([])
  const [coreInstalled, setCoreInstalled] = useState<boolean | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [copied, setCopied] = useState(false)

  const micRef = useRef<MicCaptureHandle | null>(null)
  const loopRef = useRef<WakeWordLoop | null>(null)
  const offWakeRef = useRef<(() => void) | null>(null)
  const rafRef = useRef(0)
  const micLevelRef = useRef(0)
  const scoreRef = useRef(0)
  const recentRef = useRef<Float32Array[]>([])   // rolling ~2s mic window
  const recentLenRef = useRef(0)

  useEffect(() => {
    fetch('/api/voice/wakewords', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { coreInstalled: boolean; detectors: { id: string; label: string; defaultThreshold?: number }[] } | null) => {
        if (d) {
          setCoreInstalled(d.coreInstalled); setDetectors(d.detectors ?? [])
          // Preselect the character's own model when opened from its editor.
          const pre = initialModelId && d.detectors?.some((x) => x.id === initialModelId) ? initialModelId : d.detectors?.[0]?.id
          if (pre) setModelId(pre)
        }
        else setCoreInstalled(false)
      })
      .catch(() => setCoreInstalled(false))
  }, [])

  // Show the selected model's saved sensitivity so the slider reflects what
  // actually fires in production (not a generic 0.5 default).
  useEffect(() => {
    const d = detectors.find((x) => x.id === modelId)
    if (d?.defaultThreshold != null) setThreshold(d.defaultThreshold)
    setSaveState('idle')
  }, [modelId, detectors])

  const saveThreshold = async () => {
    setSaveState('saving')
    try {
      const res = await fetch(`/api/admin/wakewords/${modelId}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ defaultThreshold: threshold }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error ?? `HTTP ${res.status}`)
      setDetectors((ds) => ds.map((d) => (d.id === modelId ? { ...d, defaultThreshold: threshold } : d)))
      setSaveState('saved')
      addLog(`saved sensitivity ${threshold.toFixed(2)} — live now`)
    } catch (e) {
      setSaveState('idle')
      setError(`could not save: ${String(e)}`)
    }
  }

  const addLog = (m: string) => setLog((l) => [`${new Date().toLocaleTimeString()}  ${m}`, ...l].slice(0, 50))

  const copyLog = async () => {
    try {
      await navigator.clipboard.writeText([...log].reverse().join('\n'))  // oldest → newest
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { setError('clipboard blocked — select the log text manually') }
  }

  const flattenRecent = (): Float32Array => {
    const out = new Float32Array(recentLenRef.current)
    let off = 0
    for (const chunk of recentRef.current) { out.set(chunk, off); off += chunk.length }
    return out
  }

  // Transcribe the audio captured around a detection so the log shows the actual
  // words heard — makes it obvious whether it fired on the phrase or on noise.
  const transcribeClip = async (pcm: Float32Array): Promise<string> => {
    if (pcm.length === 0) return ''
    try {
      const res = await fetch('/api/voice/transcribe', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm.buffer as ArrayBuffer,
      })
      return res.ok ? (((await res.json()) as { text?: string }).text ?? '') : ''
    } catch { return '' }
  }

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current)
    loopRef.current?.setEnabled(false)
    loopRef.current = null
    micRef.current?.stop()
    micRef.current = null
    offWakeRef.current?.()
    offWakeRef.current = null
    setRunning(false)
    setScore(0)
    setMicLevel(0)
    recentRef.current = []
    recentLenRef.current = 0
  }, [])

  const start = async () => {
    setError(null)
    setLog([])
    recentRef.current = []
    recentLenRef.current = 0
    try {
      await loadInstalledWakewords(true)
      const loop = new WakeWordLoop({ modelId, thresholdOverride: threshold })
      loop.onScore = (s) => { scoreRef.current = s }
      loop.onError = (e) => setError(`engine error: ${String(e)}`)
      offWakeRef.current = onWakeDetected((ev) => {
        if (ev.modelId !== modelId) return
        const clip = flattenRecent()
        void transcribeClip(clip).then((text) =>
          addLog(`✅ DETECTED ${ev.score.toFixed(2)} — heard: ${text ? `"${text}"` : '(no clear speech)'}`))
      })
      loopRef.current = loop
      const mic = await startMicCapture({
        onFrame: (s) => {
          // Keep a rolling ~2s window (32k samples @ 16kHz) to transcribe on a hit.
          recentRef.current.push(s.slice()); recentLenRef.current += s.length
          while (recentLenRef.current > 32_000 && recentRef.current.length > 1) {
            recentLenRef.current -= recentRef.current.shift()!.length
          }
          let sum = 0
          for (let i = 0; i < s.length; i++) sum += s[i]! * s[i]!
          micLevelRef.current = Math.sqrt(sum / Math.max(1, s.length))
          loop.pushFrame(s)
        },
      })
      micRef.current = mic
      loop.setEnabled(true)
      setRunning(true)
      addLog('listening — say the wake phrase')
      const tick = () => {
        setMicLevel(micLevelRef.current)
        setScore(scoreRef.current)
        rafRef.current = requestAnimationFrame(tick)
      }
      rafRef.current = requestAnimationFrame(tick)
    } catch (e) {
      setError(`could not start: ${String(e)}`)
    }
  }

  useEffect(() => () => stop(), [stop])
  useEffect(() => { loopRef.current?.setThresholdOverride(threshold) }, [threshold])

  const micPct = Math.min(100, micLevel * 400)
  const scorePct = Math.min(100, score * 100)

  return (
    <div className="space-y-2">
      {coreInstalled === false && (
        <p className="rounded-card border border-warning/30 bg-warning/10 px-2 py-1.5 text-[11px] text-warning">
          Wake word engine not installed — add it in the Features panel first.
        </p>
      )}
      <div className="flex items-center gap-2">
        <select value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={running} className="ld-input flex-1">
          {detectors.length === 0 && <option value="hey_jarvis">hey jarvis</option>}
          {detectors.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
        <button
          type="button"
          onClick={() => (running ? stop() : void start())}
          className={cn('flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px]', running ? 'border-destructive/50 text-destructive' : 'border-success/50 text-success')}
        >
          {running ? <><Square className="size-3" /> Stop</> : <><Mic className="size-3" /> Test</>}
        </button>
      </div>

      {/* Mic input level */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="w-10 shrink-0">Mic</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div className="h-full rounded-full bg-brand transition-[width] duration-75" style={{ width: `${micPct}%` }} />
        </div>
      </div>
      {/* Wake score vs threshold */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="w-10 shrink-0">Score</span>
        <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-foreground/10">
          <div className={cn('h-full rounded-full transition-[width] duration-75', score >= threshold ? 'bg-success' : 'bg-brand')} style={{ width: `${scorePct}%` }} />
          <div className="absolute top-[-2px] h-[10px] w-px bg-foreground/70" style={{ left: `${threshold * 100}%` }} title="threshold" />
        </div>
        <span className="w-7 shrink-0 text-right tabular-nums">{score.toFixed(2)}</span>
      </div>
      {/* Threshold slider + persist. Higher = stricter (fewer false fires). */}
      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="w-10 shrink-0">Sens.</span>
        <input type="range" min={0.2} max={0.95} step={0.05} value={threshold} onChange={(e) => { setThreshold(Number(e.target.value)); setSaveState('idle') }} className="h-1 flex-1 cursor-pointer" />
        <span className="w-7 shrink-0 text-right tabular-nums">{threshold.toFixed(2)}</span>
        {allowSave && (
          <button
            type="button"
            onClick={() => void saveThreshold()}
            disabled={saveState === 'saving'}
            title="Save this sensitivity as the model's live threshold"
            className={cn('flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px]', saveState === 'saved' ? 'border-success/50 text-success' : 'border-border hover:bg-foreground/5')}
          >
            {saveState === 'saved' ? <><Check className="size-3" /> Saved</> : <><Save className="size-3" /> Save</>}
          </button>
        )}
      </div>
      <p className="text-[10px] text-muted-foreground">
        {allowSave
          ? 'Raise sensitivity (→) if random speech triggers it; lower (←) if your phrase won\'t fire. Save to apply it to the live companion.'
          : 'Raise sensitivity (→) if random speech triggers it; lower (←) if your phrase won\'t fire. Changes here only affect this test.'}
      </p>

      {error && <p className="rounded-card border border-destructive/30 bg-destructive/10 px-2 py-1 text-[11px] text-destructive">{error}</p>}
      {log.length > 0 && (
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Log</span>
            <button type="button" onClick={() => void copyLog()} className="flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-[10px] hover:bg-foreground/5">
              {copied ? <><Check className="size-3" /> Copied</> : <><Copy className="size-3" /> Copy</>}
            </button>
          </div>
          <div className="max-h-32 overflow-y-auto rounded-card border border-border bg-black/30 p-1.5 font-mono text-[10px] text-muted-foreground">
            {log.map((l, i) => <div key={i} className="truncate">{l}</div>)}
          </div>
        </div>
      )}
    </div>
  )
}
