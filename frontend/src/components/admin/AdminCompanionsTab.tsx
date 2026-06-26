import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, Trash2, Shuffle, Send, Square, ChevronLeft } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { cn } from '@/lib/cn'
import RiggedDicebearAvatar from '@/components/companion/RiggedDicebearAvatar'
import { coerceStyle } from '@/components/companion/styles'
import { CharacterAvatar } from '@/components/companion/CharacterAvatar'
import type { HeadTiltState } from '@/components/companion/useHeadTilt'
import type { Mood } from '@/components/companion/moods'
import { AVATAR_STYLES, fieldsForStyle, randomSeed, type RigField } from '@/components/companion/styleSchemas'
import { refreshCompanions } from '@/hooks/useActiveCompanion'
import { COMPANION_CATEGORIES } from '@/lib/companions/companionCategories'
import { VoicePicker, WakePhraseField } from '@/components/admin/voiceControls'
import { AdminBriefingTab } from '@/components/admin/AdminBriefingTab'
import { VoiceDefaults, PronunciationEditor } from '@/components/admin/AdminVoiceTab'
import { ContentDialGroup, MIN_DIALS } from '@/components/shared/contentDials'
import type { ContentDialValues, Candor, DialKey } from '@/components/shared/contentDials'

interface AdminCompanion {
  id: string
  name: string
  personalityPrompt: string
  backstory: string | null
  phoneticName: string | null
  replyStyle: 'brief' | 'balanced' | 'detailed' | 'auto'
  voiceId: string | null
  ttsVoice: string | null
  wakeWordModelId: string | null
  wakeWordPhrase: string | null
  speechRate: number | null
  expressiveness: number | null
  renderer: string
  style: string | null
  seed: string | null
  avatarConfig: Record<string, unknown>
  category: string | null
  isActive: boolean
  published: boolean
  content: ContentDialValues & { candor: Candor }
}

type Draft = Omit<AdminCompanion, 'id'> & { id: string | null }

const BLANK: Draft = {
  id: null, name: '', personalityPrompt: '', backstory: '', phoneticName: '',
  replyStyle: 'balanced', voiceId: '', ttsVoice: '', wakeWordModelId: '', wakeWordPhrase: '', speechRate: null, expressiveness: null, renderer: 'dicebear',
  style: 'avataaars', seed: randomSeed(), avatarConfig: {}, category: 'everyday', isActive: true, published: true,
  content: { ...MIN_DIALS, candor: 'balanced' },
}

type EditorTab = 'identity' | 'content' | 'voice' | 'appearance' | 'test' | 'access'

// ── Live preview using the exact v2 rigged avatar; buttons drive HeadTiltState ────
const PREVIEW_MOODS: Mood[] = ['neutral', 'happy', 'laugh', 'wink', 'love', 'surprised', 'confused', 'tired', 'sad', 'angry']

const TILT_STATES: { label: string; state: HeadTiltState }[] = [
  { label: 'Idle', state: 'dozing' },
  { label: 'Think', state: 'thinking' },
  { label: 'Speak', state: 'speaking' },
  { label: 'Listen', state: 'listening' },
  { label: 'Sick', state: 'sick' },
  { label: 'Sad', state: 'sad' },
  { label: 'Angry', state: 'angry' },
  { label: 'Shock', state: 'shocked' },
  { label: 'Sleep', state: 'sleeping' },
]

// Shared control state for the preview avatar; lives in the parent so the
// controls (rendered on the Test tab) drive the always-visible right-column avatar.
interface PreviewControls {
  tilt: HeadTiltState
  setTilt: (s: HeadTiltState) => void
  mood: Mood
  setMood: (m: Mood) => void
  manualTilt: number | null
  setManualTilt: (n: number | null) => void
}

// Right-column avatar — purely presentational, driven by the lifted controls.
function StudioPreview({ style, seed, avatarConfig, speaking, ctl }: { style: string; seed: string; avatarConfig: Record<string, unknown>; speaking: boolean; ctl: PreviewControls }) {
  const effectiveTilt = speaking ? 'speaking' : ctl.tilt
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="size-44 overflow-hidden rounded-2xl border border-border bg-card">
        <RiggedDicebearAvatar
          style={coerceStyle(style)}
          seed={seed || 'preview'}
          baseOptions={avatarConfig}
          tiltState={effectiveTilt}
          manualTiltDeg={ctl.manualTilt}
          speaking={speaking}
          mood={ctl.mood}
        />
      </div>
    </div>
  )
}

// Expression / state controls — rendered on the Test tab.
function StudioControls({ ctl }: { ctl: PreviewControls }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-3">
      <div className="flex flex-wrap gap-1.5">
        {TILT_STATES.map((s) => (
          <button
            key={s.state}
            onClick={() => ctl.setTilt(s.state)}
            className={cn('rounded-md border px-2 py-1 text-[11px]', ctl.tilt === s.state ? 'border-violet-500 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {PREVIEW_MOODS.map((m) => (
          <button
            key={m}
            onClick={() => ctl.setMood(m)}
            className={cn('rounded-md border px-2 py-1 text-[11px] capitalize', ctl.mood === m ? 'border-emerald-500 text-foreground' : 'border-border text-muted-foreground hover:text-foreground')}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="flex w-full items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Tilt</span>
        <input
          type="range" min={-30} max={30} step={1}
          value={ctl.manualTilt ?? 0}
          onChange={(e) => ctl.setManualTilt(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer"
        />
        <button onClick={() => ctl.setManualTilt(null)} className="text-[11px] text-muted-foreground hover:text-foreground" title="Resume auto">auto</button>
      </div>
    </div>
  )
}

// ── Live tester (streams a reply from the unsaved draft persona) ─────────────────
function StudioTester({ persona, replyStyle, onSpeaking }: { persona: string; replyStyle: string; onSpeaking: (v: { speaking: boolean; thinking: boolean }) => void }) {
  const [log, setLog] = useState<{ role: 'user' | 'assistant'; content: string }[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || busy) return
    setInput('')
    const history = log.slice(-6)
    setLog((p) => [...p, { role: 'user', content: text }, { role: 'assistant', content: '' }])
    setBusy(true)
    onSpeaking({ speaking: false, thinking: true })

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/admin/companions/test', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personalityPrompt: persona, replyStyle, message: text, history }),
        signal: controller.signal,
      })
      const reader = res.body?.getReader()
      if (!reader) throw new Error('no stream')
      const dec = new TextDecoder()
      let buf = ''
      let event = 'message'
      let got = false
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          if (line.startsWith('event:')) event = line.slice(6).trim()
          else if (line.startsWith('data:')) {
            const data = line.slice(line.charAt(5) === ' ' ? 6 : 5)
            if (event === 'token') {
              if (!got) { got = true; onSpeaking({ speaking: true, thinking: false }) }
              setLog((p) => { const n = [...p]; n[n.length - 1] = { role: 'assistant', content: n[n.length - 1]!.content + data }; return n })
            }
          }
        }
      }
    } catch { /* aborted or failed */ }
    finally { setBusy(false); onSpeaking({ speaking: false, thinking: false }); abortRef.current = null }
  }, [input, busy, log, persona, replyStyle, onSpeaking])

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card">
      <div className="max-h-96 min-h-48 space-y-2 overflow-y-auto p-3 text-sm">
        {log.length === 0 ? (
          <p className="text-xs text-muted-foreground">Send a message to preview this persona (nothing is saved).</p>
        ) : log.map((m, i) => (
          <div key={i} className={cn('whitespace-pre-wrap', m.role === 'user' ? 'text-foreground' : 'text-muted-foreground')}>
            <span className="mr-1.5 text-[10px] uppercase tracking-wide opacity-50">{m.role}</span>{m.content || '…'}
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2 border-t border-border p-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send() }}
          placeholder="Test message…"
          className="flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/50"
        />
        {busy ? (
          <button onClick={() => abortRef.current?.abort()} className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background"><Square className="size-3 fill-current" /></button>
        ) : (
          <button onClick={send} disabled={!input.trim()} className="flex size-7 items-center justify-center rounded-lg bg-foreground text-background disabled:opacity-20"><Send className="size-3.5" /></button>
        )}
      </div>
    </div>
  )
}

// ── Per-user access matrix ──────────────────────────────────────────────────────
function AccessMatrix({ characterId }: { characterId: string }) {
  const [rows, setRows] = useState<{ userId: string; nickname: string; role: string; state: 'on' | 'off' }[]>([])
  useEffect(() => {
    fetch(`/api/admin/companions/${characterId}/grants`, { credentials: 'include' })
      .then((r) => r.ok ? r.json() : [])
      .then(setRows).catch(() => {})
  }, [characterId])

  const toggle = async (userId: string, next: 'on' | 'off') => {
    setRows((p) => p.map((r) => r.userId === userId ? { ...r, state: next } : r))
    await fetch(`/api/admin/companions/${characterId}/grants/${userId}`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state: next }),
    }).catch(() => {})
  }

  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.userId} className="flex items-center justify-between rounded-lg border border-border px-3 py-1.5 text-sm">
          <span>{r.nickname}{r.role === 'admin' && <span className="ml-1.5 text-[10px] text-muted-foreground">admin</span>}</span>
          <button
            onClick={() => toggle(r.userId, r.state === 'on' ? 'off' : 'on')}
            className={cn('rounded-md px-2 py-0.5 text-xs font-medium', r.state === 'on' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-rose-500/15 text-rose-400')}
          >
            {r.state === 'on' ? 'Allowed' : 'Blocked'}
          </button>
        </div>
      ))}
    </div>
  )
}

// ── Appearance field renderers ──────────────────────────────────────────────────
// Color fields (every option has a hex color) → compact circle swatches.
// All other fields → a plain <select> dropdown.
function AppearanceField({ field, current, onSet }: { field: RigField; current: string | null; onSet: (field: RigField, value: string | null) => void }) {
  const isColorField = field.options.length > 0 && field.options.every((o) => !!o.color)

  if (isColorField) {
    return (
      <div className="flex flex-wrap gap-2">
        {field.hasNone && (
          <button
            type="button"
            onClick={() => onSet(field, null)}
            title="None"
            className={cn(
              'size-6 rounded-full border-2 bg-transparent text-[9px] text-muted-foreground',
              current === null ? 'border-violet-400' : 'border-dashed border-border hover:border-white/40',
            )}
          >
            ×
          </button>
        )}
        {field.options.map((o) => (
          <button
            key={o.value}
            type="button"
            onClick={() => onSet(field, o.value)}
            title={o.label ?? o.value}
            style={{ background: o.color }}
            className={cn('size-6 rounded-full border-2 transition-transform', current === o.value ? 'border-violet-400 scale-110' : 'border-transparent hover:border-white/40')}
          />
        ))}
      </div>
    )
  }

  return (
    <select
      value={current ?? ''}
      onChange={(e) => onSet(field, e.target.value || null)}
      className="ld-input"
    >
      {field.hasNone && <option value="">None</option>}
      {field.options.map((o) => (
        <option key={o.value} value={o.value}>{o.label ?? o.value}</option>
      ))}
    </select>
  )
}

// ── Main tab ────────────────────────────────────────────────────────────────────
export type CompanionView = 'characters' | 'voice' | 'briefing'

export function AdminCompanionsTab({ view = 'characters' }: { view?: CompanionView } = {}) {
  const [list, setList] = useState<AdminCompanion[]>([])
  const [draft, setDraft] = useState<Draft | null>(null)
  const [preview, setPreview] = useState({ speaking: false, thinking: false })
  const [previewTilt, setPreviewTilt] = useState<HeadTiltState>('dozing')
  const [previewMood, setPreviewMood] = useState<Mood>('neutral')
  const [previewManualTilt, setPreviewManualTilt] = useState<number | null>(null)
  const ctl: PreviewControls = {
    tilt: previewTilt, setTilt: setPreviewTilt,
    mood: previewMood, setMood: setPreviewMood,
    manualTilt: previewManualTilt, setManualTilt: setPreviewManualTilt,
  }
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState<EditorTab>('identity')
  const [confirmRemove, setConfirmRemove] = useState(false)

  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/companions', { credentials: 'include' })
      if (res.ok) setList(await res.json())
    } catch { /* offline */ }
  }, [])
  useEffect(() => { loadList() }, [loadList])
  // Reset any open editor when the admin navigates to a different companion view.
  useEffect(() => { setDraft(null) }, [view])

  const selectDraft = (c: AdminCompanion) => {
    setDraft({ ...c, backstory: c.backstory ?? '', phoneticName: c.phoneticName ?? '', voiceId: c.voiceId ?? '', ttsVoice: c.ttsVoice ?? '', wakeWordModelId: c.wakeWordModelId ?? '', wakeWordPhrase: c.wakeWordPhrase ?? '', content: c.content ?? { ...MIN_DIALS, candor: 'balanced' } })
    setTab('identity')
  }
  const newDraft = () => {
    setDraft({ ...BLANK, seed: randomSeed(), avatarConfig: {} })
    setTab('identity')
  }

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => d ? { ...d, [key]: value } : d)
  const setDial = (key: DialKey, value: string) => setDraft((d) => d ? { ...d, content: { ...d.content, [key]: value } } : d)
  const setCandor = (value: Candor) => setDraft((d) => d ? { ...d, content: { ...d.content, candor: value } } : d)

  const setRig = (field: RigField, value: string | null) => {
    setDraft((d) => {
      if (!d) return d
      const cfg = { ...d.avatarConfig }
      const probKey = `${field.key}Probability`
      if (value === null) {
        delete cfg[field.key]
        if (field.hasNone) cfg[probKey] = 0
      } else {
        cfg[field.key] = [value]
        if (field.hasNone) cfg[probKey] = 100
      }
      return { ...d, avatarConfig: cfg }
    })
  }

  const save = async () => {
    if (!draft || !draft.name.trim()) return
    setSaving(true)
    const body = {
      name: draft.name, personalityPrompt: draft.personalityPrompt, backstory: draft.backstory || null,
      phoneticName: draft.phoneticName || null, replyStyle: draft.replyStyle, voiceId: draft.voiceId || null,
      ttsVoice: draft.ttsVoice || null, wakeWordModelId: null, wakeWordPhrase: draft.wakeWordPhrase || null, speechRate: draft.speechRate, expressiveness: draft.expressiveness,
      renderer: draft.renderer, style: draft.style, seed: draft.seed, avatarConfig: draft.avatarConfig,
      category: draft.category, isActive: draft.isActive, published: draft.published, content: draft.content,
    }
    try {
      const res = await fetch(draft.id ? `/api/admin/companions/${draft.id}` : '/api/admin/companions', {
        method: draft.id ? 'PATCH' : 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (res.ok) { const saved = await res.json() as AdminCompanion; await loadList(); refreshCompanions(); selectDraft(saved) }
    } finally { setSaving(false) }
  }

  const remove = async () => {
    if (!draft?.id) { setDraft(null); return }
    await fetch(`/api/admin/companions/${draft.id}`, { method: 'DELETE', credentials: 'include' })
    setDraft(null); await loadList(); refreshCompanions()
  }

  const tabs: { id: EditorTab; label: string }[] = [
    { id: 'identity', label: 'Identity' },
    { id: 'content', label: 'Content' },
    { id: 'voice', label: 'Voice' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'test', label: 'Test' },
    ...(draft?.id ? [{ id: 'access' as EditorTab, label: 'Access' }] : []),
  ]

  return (
    <div className="flex h-full min-h-0 flex-col p-4">
      {view === 'briefing' && <AdminBriefingTab />}

      {view === 'voice' && (
        <div className="space-y-4">
          <div>
            <h2 className="text-lg font-semibold">Voice &amp; Wake words</h2>
            <p className="text-sm text-muted-foreground">Default voice and wake word used when a companion has none of its own. Per-companion voices are set in each character&apos;s Identity tab.</p>
          </div>
          <VoiceDefaults />
          <PronunciationEditor />
        </div>
      )}

      {view === 'characters' && !draft && (
        /* ── Card grid landing ─────────────────────────────────────────── */
        <>
          <div className="mb-5 flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold">Companions</h2>
              <p className="text-sm text-muted-foreground">Create and manage the companions available across the app.</p>
            </div>
            <button onClick={newDraft} className="flex items-center gap-2 rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background hover:opacity-90">
              <Plus className="size-4" /> New companion
            </button>
          </div>

          {list.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border py-16 text-center">
              <p className="text-sm text-muted-foreground">No companions yet. Create one to get started.</p>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
                {list.map((c) => (
                  <div
                    key={c.id}
                    className="group relative flex flex-col items-center rounded-2xl border border-border bg-card p-4 text-center transition-colors hover:border-border/80"
                  >
                    <div className="absolute right-2 top-2 flex gap-1">
                      {!c.published && <span className="rounded-full bg-foreground/10 px-1.5 py-0.5 text-[10px] text-muted-foreground">Draft</span>}
                      {!c.isActive && <span className="rounded-full bg-rose-500/15 px-1.5 py-0.5 text-[10px] text-rose-400">Off</span>}
                    </div>
                    <button
                      type="button"
                      onClick={() => selectDraft(c)}
                      className="size-24 overflow-hidden rounded-full"
                      aria-label={`Edit ${c.name}`}
                    >
                      <CharacterAvatar character={c} size={96} viewPreset="head" pokeable />
                    </button>
                    <p className="mt-3 w-full truncate text-sm font-medium">{c.name}</p>
                    {c.backstory && <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{c.backstory}</p>}
                    <div className="mt-3 flex w-full gap-1.5">
                      <button
                        onClick={() => selectDraft(c)}
                        className="flex-1 rounded-lg bg-foreground/5 px-2 py-1.5 text-xs font-medium transition-colors hover:bg-foreground/10"
                      >
                        Edit
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {view === 'characters' && draft && (
        /* ── Editor ────────────────────────────────────────────────────── */
        <div className="flex min-h-0 flex-1 flex-col">
          <button
            onClick={() => setDraft(null)}
            className="mb-4 flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ChevronLeft className="size-4" /> All companions
          </button>
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-y-auto lg:grid-cols-[1fr_280px]">
            {/* Left: tabbed editor */}
            <div className="flex min-h-0 flex-col gap-4">
              {/* Tab nav */}
              <div className="flex gap-0.5 overflow-x-auto border-b border-border">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      'shrink-0 px-3 py-2 text-sm transition-colors',
                      tab === t.id
                        ? '-mb-px border-b-2 border-violet-500 text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>

              {/* Identity */}
              {tab === 'identity' && (
                <div className="space-y-3">
                  <Field label="Name"><input value={draft.name} onChange={(e) => set('name', e.target.value)} className="ld-input" placeholder="Loki" /></Field>
                  <Field label="Description"><input value={draft.backstory ?? ''} onChange={(e) => set('backstory', e.target.value)} className="ld-input" placeholder="A cheerful helper" /></Field>
                  <Field label="Persona / system prompt">
                    <textarea value={draft.personalityPrompt} onChange={(e) => set('personalityPrompt', e.target.value)} rows={6} className="ld-input resize-y" placeholder="You are Loki, a warm and witty companion who…" />
                  </Field>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Reply style">
                      <select value={draft.replyStyle} onChange={(e) => set('replyStyle', e.target.value as Draft['replyStyle'])} className="ld-input">
                        <option value="auto">Auto</option>
                        <option value="brief">Brief</option>
                        <option value="balanced">Balanced</option>
                        <option value="detailed">Detailed</option>
                      </select>
                    </Field>
                    <Field label="Store category">
                      <select value={draft.category ?? ''} onChange={(e) => set('category', e.target.value || null)} className="ld-input">
                        <option value="">Uncategorized</option>
                        {COMPANION_CATEGORIES.map((cat) => <option key={cat.key} value={cat.key}>{cat.name}</option>)}
                      </select>
                    </Field>
                  </div>
                </div>
              )}

              {/* Content level */}
              {tab === 'content' && (
                <div className="space-y-3">
                  <Field label="Content level">
                    <div className="rounded-lg border border-border/50 bg-card/50 p-3">
                      <ContentDialGroup values={draft.content} includeCandor candor={draft.content.candor} onDial={setDial} onCandor={setCandor} />
                      <p className="mt-3 text-[11px] text-muted-foreground">
                        This character's fixed content level. Users whose content settings are lower than this won't be able to use it.
                      </p>
                    </div>
                  </Field>
                </div>
              )}

              {/* Voice & wake word */}
              {tab === 'voice' && (
                <div className="space-y-3">
                  <Field label="Voice">
                    <VoicePicker value={draft.ttsVoice ?? ''} onChange={(v) => set('ttsVoice', v)} previewName={draft.name} />
                  </Field>
                  {/* Wake word = a spoken phrase. Whisper matches your words, so
                      "hey loki" is never confused with "hey alexa" — no training,
                      no model files, one way to set it up. */}
                  <Field label="Wake word">
                    <WakePhraseField value={draft.wakeWordPhrase ?? ''} onChange={(v) => set('wakeWordPhrase', v)} />
                  </Field>
                  <Field label="Speech rate">
                    <input type="number" step="0.05" min="0.8" max="1.3" value={draft.speechRate ?? ''} onChange={(e) => set('speechRate', e.target.value === '' ? null : Number(e.target.value))} className="ld-input" placeholder="1.0" />
                  </Field>
                  {/* How far emote/punctuation prosody swings from neutral (0 = flat narrator, 1 = theatrical). */}
                  <Field label="Expressiveness">
                    <div className="flex items-center gap-2">
                      <input type="range" min="0" max="1" step="0.05" value={draft.expressiveness ?? 0.6} onChange={(e) => set('expressiveness', Number(e.target.value))} className="flex-1" />
                      <span className="text-xs tabular-nums w-9 text-right">{(draft.expressiveness ?? 0.6).toFixed(2)}</span>
                    </div>
                  </Field>
                </div>
              )}

              {/* Appearance */}
              {tab === 'appearance' && (
                <div className="space-y-3">
                  <div className="flex items-end gap-2">
                    <Field label="Style">
                      <select value={draft.style ?? 'avataaars'} onChange={(e) => set('style', e.target.value)} className="ld-input">
                        {AVATAR_STYLES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                      </select>
                    </Field>
                    <button onClick={() => set('seed', randomSeed())} className="mb-0.5 flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm hover:bg-foreground/5">
                      <Shuffle className="size-3.5" /> Randomize
                    </button>
                  </div>
                  {fieldsForStyle(draft.style ?? 'avataaars').map((field) => {
                    const current = (draft.avatarConfig[field.key] as string[] | undefined)?.[0] ?? null
                    return (
                      <Field key={field.key} label={field.label}>
                        <AppearanceField field={field} current={current} onSet={setRig} />
                      </Field>
                    )
                  })}
                </div>
              )}

              {/* Test */}
              {tab === 'test' && (
                <div className="space-y-3">
                  <StudioControls ctl={ctl} />
                  <StudioTester persona={draft.personalityPrompt} replyStyle={draft.replyStyle} onSpeaking={setPreview} />
                </div>
              )}

              {/* Access */}
              {tab === 'access' && draft.id && (
                <AccessMatrix characterId={draft.id} />
              )}
            </div>

            {/* Right column: preview + actions (always visible) */}
            <div className="space-y-4">
              <StudioPreview style={draft.style ?? 'avataaars'} seed={draft.seed ?? 'preview'} avatarConfig={draft.avatarConfig} speaking={preview.speaking} ctl={ctl} />
              <div className="space-y-2 rounded-xl border border-border p-3">
                <Toggle label="Enabled" value={draft.isActive} onChange={(v) => set('isActive', v)} />
                <Toggle label="Published" value={draft.published} onChange={(v) => set('published', v)} />
              </div>
              <div className="flex gap-2">
                <button onClick={save} disabled={saving || !draft.name.trim()} className="flex-1 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40">
                  {saving ? 'Saving…' : draft.id ? 'Save' : 'Create'}
                </button>
                {draft.id && (
                  <button onClick={() => setConfirmRemove(true)} className="flex items-center justify-center rounded-lg border border-border px-3 py-2 text-sm text-rose-400 hover:bg-rose-500/10">
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Delete ${draft?.name ?? 'companion'}?`}
        description="This companion will be permanently removed. Conversations referencing them will remain."
        confirmLabel="Delete"
        destructive
        onConfirm={remove}
      />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button onClick={() => onChange(!value)} className="flex w-full items-center justify-between text-sm">
      <span>{label}</span>
      <span className={cn('relative h-5 w-9 rounded-full transition-colors', value ? 'bg-violet-600' : 'bg-foreground/15')}>
        <span className={cn('absolute top-0.5 size-4 rounded-full bg-white transition-transform', value ? 'translate-x-4' : 'translate-x-0.5')} />
      </span>
    </button>
  )
}
