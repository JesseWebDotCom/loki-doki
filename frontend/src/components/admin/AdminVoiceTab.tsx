import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Play, Star, AudioLines, SpellCheck, Plus, Trash2, ChevronDown, ChevronRight, Pencil, Check, X } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { cn } from '@/lib/cn'
import { speak } from '@/lib/voice/voicePlaybackStore'
import { toast } from '@/lib/toast'

// ── Static Kokoro voice catalog ──────────────────────────────────────────────
const VOICE_CATALOG: Record<string, { character: string[] }> = {
  af_heart:     { character: ['warm', 'friendly', 'natural'] },
  af_bella:     { character: ['energetic', 'dynamic', 'engaging'] },
  af_nicole:    { character: ['clear', 'professional', 'articulate'] },
  af_aoede:     { character: ['musical', 'expressive', 'artistic'] },
  af_kore:      { character: ['balanced', 'versatile'] },
  af_sarah:     { character: ['neutral', 'calm', 'reliable'] },
  af_nova:      { character: ['bright', 'modern', 'upbeat'] },
  af_sky:       { character: ['soft', 'gentle', 'ASMR'] },
  af_alloy:     { character: ['professional', 'authoritative'] },
  af_jessica:   { character: ['friendly', 'approachable'] },
  af_river:     { character: ['flowing', 'natural', 'smooth'] },
  am_michael:   { character: ['deep', 'authoritative', 'commanding'] },
  am_fenrir:    { character: ['strong', 'bold', 'powerful'] },
  am_puck:      { character: ['playful', 'character-driven'] },
  am_echo:      { character: ['clear', 'resonant', 'memorable'] },
  am_eric:      { character: ['reliable', 'professional'] },
  am_liam:      { character: ['modern', 'relatable', 'friendly'] },
  am_onyx:      { character: ['rich', 'deep', 'elegant'] },
  am_adam:      { character: ['classic', 'versatile', 'dependable'] },
  am_santa:     { character: ['warm', 'jolly', 'festive'] },
  bf_emma:      { character: ['refined', 'elegant', 'sophisticated'] },
  bf_isabella:  { character: ['professional', 'articulate'] },
  bf_alice:     { character: ['clear', 'storytelling', 'engaging'] },
  bf_lily:      { character: ['gentle', 'pleasant', 'approachable'] },
  bm_george:    { character: ['authoritative', 'professional', 'commanding'] },
  bm_fable:     { character: ['narrative', 'expressive', 'storytelling'] },
  bm_lewis:     { character: ['reliable', 'clear', 'articulate'] },
  bm_daniel:    { character: ['modern', 'professional', 'versatile'] },
  jf_hina:      { character: ['gentle', 'youthful', 'sweet'] },
  jf_yuki:      { character: ['cool', 'elegant', 'refined'] },
  jf_sakura:    { character: ['warm', 'traditional', 'pleasant'] },
  jf_sora:      { character: ['bright', 'energetic', 'cheerful'] },
  jm_kaito:     { character: ['strong', 'confident', 'clear'] },
  zf_xiaoxiao:  { character: ['gentle', 'friendly', 'approachable'] },
  zf_yunxi:     { character: ['professional', 'clear', 'articulate'] },
  zf_xiaoyi:    { character: ['energetic', 'youthful', 'lively'] },
  zf_xiaoxuan:  { character: ['warm', 'expressive', 'engaging'] },
  zm_yunyang:   { character: ['strong', 'authoritative', 'commanding'] },
  zm_yunfeng:   { character: ['calm', 'mature', 'reliable'] },
  zm_yunhao:    { character: ['clear', 'professional', 'articulate'] },
  zm_yunxia:    { character: ['versatile', 'balanced'] },
  ef_sofia:     { character: ['warm', 'friendly', 'engaging'] },
  em_diego:     { character: ['confident', 'clear', 'professional'] },
  em_carlos:    { character: ['friendly', 'approachable', 'versatile'] },
  ff_siwis:     { character: ['elegant', 'refined', 'sophisticated'] },
  hf_priya:     { character: ['friendly', 'warm', 'approachable'] },
  hf_anjali:    { character: ['professional', 'clear', 'articulate'] },
  hm_arjun:     { character: ['strong', 'confident', 'authoritative'] },
  hm_raj:       { character: ['friendly', 'versatile', 'engaging'] },
  if_giulia:    { character: ['expressive', 'warm', 'engaging'] },
  im_marco:     { character: ['confident', 'professional', 'clear'] },
  pf_lucia:     { character: ['warm', 'friendly', 'natural'] },
  pm_joao:      { character: ['professional', 'clear', 'reliable'] },
  pm_pedro:     { character: ['friendly', 'approachable', 'versatile'] },
}

const LANG_GROUPS: { key: string; flag: string; label: string }[] = [
  { key: 'a', flag: '🇺🇸', label: 'American English' },
  { key: 'b', flag: '🇬🇧', label: 'British English'  },
  { key: 'j', flag: '🇯🇵', label: 'Japanese'          },
  { key: 'z', flag: '🇨🇳', label: 'Mandarin Chinese'  },
  { key: 'e', flag: '🇪🇸', label: 'Spanish'           },
  { key: 'f', flag: '🇫🇷', label: 'French'            },
  { key: 'h', flag: '🇮🇳', label: 'Hindi'             },
  { key: 'i', flag: '🇮🇹', label: 'Italian'           },
  { key: 'p', flag: '🇧🇷', label: 'Portuguese'        },
  { key: 'k', flag: '🇰🇷', label: 'Korean'            },
  { key: 'r', flag: '🇷🇺', label: 'Russian'           },
]

function parseVoiceId(id: string) {
  const raw = id.startsWith('kokoro:') ? id.slice(7) : id
  const prefix = raw.split('_')[0] ?? ''
  const langKey = prefix[0] ?? ''
  const genderKey = prefix[1] ?? ''
  const group = LANG_GROUPS.find((g) => g.key === langKey)
  return {
    langKey,
    flag: group?.flag ?? '🌐',
    language: group?.label ?? 'Unknown',
    gender: genderKey === 'f' ? 'Female' : genderKey === 'm' ? 'Male' : null,
    character: VOICE_CATALOG[raw]?.character ?? [],
  }
}

interface KokoroVoice { id: string; name: string; language?: string; gender?: string }

// ── Voices browser (full catalog grid) ────────────────────────────────────────

function VoicesBrowser({
  voices, defaultVoice, savingVoice, onSetDefault,
}: {
  voices: KokoroVoice[]
  defaultVoice: string
  savingVoice: string
  onSetDefault: (voiceId: string) => void
}) {
  const voicesByLang = new Map<string, KokoroVoice[]>()
  for (const v of voices) {
    const raw = v.id.startsWith('kokoro:') ? v.id.slice(7) : v.id
    const key = raw[0] ?? ''
    if (!voicesByLang.has(key)) voicesByLang.set(key, [])
    voicesByLang.get(key)!.push(v)
  }
  const langSections = LANG_GROUPS.filter((g) => voicesByLang.has(g.key))

  return (
    <div className="space-y-8">
      {voices.length === 0 && (
        <p className="rounded-xl border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
          No voices available — check that the voice server is running.
        </p>
      )}
      {langSections.map((group) => (
        <section key={group.key}>
          <h3 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <span className="text-base leading-none">{group.flag}</span>
            {group.label}
          </h3>
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
            {(voicesByLang.get(group.key) ?? []).map((v) => {
              const kokoroId = `kokoro:${v.id}`
              const isDefault = defaultVoice === kokoroId
              const isSaving = savingVoice === kokoroId
              const { gender, character } = parseVoiceId(v.id)
              return (
                <div
                  key={v.id}
                  className={cn(
                    'group flex flex-col gap-2 rounded-xl border p-3 transition-all',
                    isDefault
                      ? 'border-violet-500/60 bg-violet-500/[0.07] shadow-sm shadow-violet-500/10'
                      : 'border-border hover:border-foreground/20 hover:bg-foreground/[0.02]',
                  )}
                >
                  {/* Name + actions */}
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold leading-tight">{v.name}</p>
                      <p className={cn(
                        'mt-0.5 text-[11px] font-medium',
                        gender === 'Female' ? 'text-rose-400' : gender === 'Male' ? 'text-sky-400' : 'text-muted-foreground',
                      )}>
                        {gender === 'Female' ? '♀' : gender === 'Male' ? '♂' : ''} {gender ?? '—'}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {/* Play */}
                      <button
                        type="button"
                        onClick={() => void speak({ text: `Hi, I am ${v.name}.`, ttsVoice: kokoroId })}
                        title="Preview"
                        className="flex size-7 items-center justify-center rounded-full bg-white/[0.06] text-muted-foreground hover:bg-white/10 hover:text-foreground"
                      >
                        <Play className="size-3 fill-current" />
                      </button>
                      {/* Star = set/show default */}
                      <button
                        type="button"
                        onClick={() => { if (!isDefault) onSetDefault(kokoroId) }}
                        disabled={isSaving}
                        title={isDefault ? 'Default voice' : 'Set as default'}
                        className="flex size-7 items-center justify-center rounded-full bg-white/[0.06] hover:bg-white/10 disabled:opacity-40"
                      >
                        <Star className={cn(
                          'size-3.5 transition-colors',
                          isDefault ? 'fill-violet-400 text-violet-400' : 'text-muted-foreground/40 hover:text-muted-foreground',
                        )} />
                      </button>
                    </div>
                  </div>

                  {/* Character chips */}
                  {character.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {character.slice(0, 3).map((c) => (
                        <span key={c} className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[10px] text-white/45">
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}

// ── Compact voice defaults card ───────────────────────────────────────────────
//
// Voice config is really two choices — the default voice and the default wake
// word. This card shows the current pick for each with a "Change" button that
// opens the full browser (preview / test / pick) in a dialog.

export function VoiceDefaults() {
  const [voices, setVoices] = useState<KokoroVoice[]>([])
  const [defaultVoice, setDefaultVoice] = useState('')
  const [savingVoice, setSavingVoice] = useState('')
  const [voiceOpen, setVoiceOpen] = useState(false)

  const loadVoices = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/voice/voices', { credentials: 'include' })
      if (r.ok) setVoices((await r.json() as { voices: KokoroVoice[] }).voices ?? [])
    } catch { /* offline */ }
  }, [])

  const loadSettings = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/voice/settings', { credentials: 'include' })
      if (r.ok) {
        const s = ((await r.json() as { settings: Record<string, unknown> }).settings) ?? {}
        setDefaultVoice(typeof s['voice.app_default_voice'] === 'string' ? s['voice.app_default_voice'] as string : '')
      }
    } catch { /* offline */ }
  }, [])

  useEffect(() => {
    void loadVoices(); void loadSettings()
  }, [loadVoices, loadSettings])

  const patchSettings = async (patch: Record<string, unknown>) => {
    const r = await fetch('/api/admin/voice/settings', { credentials: 'include' })
    const current = r.ok ? (await r.json() as { settings: Record<string, unknown> }).settings : {}
    await fetch('/api/admin/voice/settings', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...current, ...patch }),
    })
  }

  const setVoiceDefault = async (voiceId: string) => {
    setSavingVoice(voiceId)
    try { await patchSettings({ 'voice.app_default_voice': voiceId }); setDefaultVoice(voiceId) }
    finally { setSavingVoice('') }
  }

  const currentVoiceName = useMemo(() => {
    const match = voices.find((v) => `kokoro:${v.id}` === defaultVoice)
    if (match) {
      const { flag } = parseVoiceId(match.id)
      return `${flag} ${match.name}`
    }
    return defaultVoice ? defaultVoice.replace(/^kokoro:/, '') : 'Not set'
  }, [voices, defaultVoice])

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <AudioLines className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Voice defaults</h3>
        <span className="text-xs text-muted-foreground">Used by companions unless overridden</span>
      </div>

      <DefaultRow
        icon={<Play className="size-4 fill-current" />}
        label="Default voice"
        value={currentVoiceName}
        onChange={() => setVoiceOpen(true)}
      />

      {/* Voice browser */}
      <Dialog open={voiceOpen} onOpenChange={setVoiceOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader><DialogTitle>Choose a default voice</DialogTitle></DialogHeader>
          <DialogDescription className="sr-only">Pick the default text-to-speech voice.</DialogDescription>
          <div className="max-h-[65vh] overflow-y-auto pr-1">
            <VoicesBrowser
              voices={voices}
              defaultVoice={defaultVoice}
              savingVoice={savingVoice}
              onSetDefault={(id) => void setVoiceDefault(id)}
            />
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

// ── Unified pronunciation editor ──────────────────────────────────────────────
// Shows all packs (collapsible, with toggle + editable items) then custom rules.

interface PronunciationItem { id: string; term: string; replacement: string }
interface PronunciationPack {
  id: string; slug: string; name: string; appKey: string | null
  description: string | null; enabled: boolean; builtIn: boolean; itemCount: number
}

const APP_KEY_LABELS: Record<string, string> = { chat: 'Chat', maps: 'Maps', music: 'Music' }

function AddRuleRow({ onAdd }: { onAdd: (term: string, replacement: string) => Promise<void> }) {
  const [term, setTerm] = useState('')
  const [replacement, setReplacement] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (!term.trim() || !replacement.trim()) return
    setSaving(true)
    try { await onAdd(term.trim(), replacement.trim()); setTerm(''); setReplacement('') }
    catch { toast.error('Could not save') }
    finally { setSaving(false) }
  }

  return (
    <div className="flex flex-wrap items-end gap-2 border-t border-border/60 pt-3">
      <div className="min-w-[7rem] flex-1">
        <input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Word / phrase"
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm" />
      </div>
      <div className="min-w-[7rem] flex-1">
        <input value={replacement} onChange={(e) => setReplacement(e.target.value)} placeholder="Say it like…"
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          className="w-full rounded-lg border border-border bg-background px-3 py-1.5 text-sm" />
      </div>
      {replacement.trim() && (
        <button type="button" title="Preview" onClick={() => void speak({ text: `This says ${replacement.trim()}.` })}
          className="flex size-9 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground hover:text-foreground">
          <Play className="size-3.5 fill-current" />
        </button>
      )}
      <button type="button" onClick={() => void submit()} disabled={saving || !term.trim() || !replacement.trim()}
        className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">
        <Plus className="size-3.5" /> Add
      </button>
    </div>
  )
}

function ItemRow({
  item, onSave, onDelete,
}: {
  item: PronunciationItem
  onSave: (id: string, term: string, replacement: string) => Promise<void>
  onDelete: (id: string) => void
}) {
  const [editing, setEditing] = useState(false)
  const [term, setTerm] = useState(item.term)
  const [replacement, setReplacement] = useState(item.replacement)
  const termRef = useRef<HTMLInputElement>(null)

  const startEdit = () => { setTerm(item.term); setReplacement(item.replacement); setEditing(true) }
  const cancel = () => setEditing(false)
  const save = async () => {
    if (!term.trim() || !replacement.trim()) return
    await onSave(item.id, term.trim(), replacement.trim())
    setEditing(false)
  }

  useEffect(() => { if (editing) termRef.current?.focus() }, [editing])

  if (editing) {
    return (
      <div className="flex items-center gap-2 py-1.5">
        <input ref={termRef} value={term} onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') cancel() }}
          className="w-28 rounded border border-border bg-background px-2 py-1 text-xs font-medium" />
        <span className="text-muted-foreground">→</span>
        <input value={replacement} onChange={(e) => setReplacement(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') cancel() }}
          className="flex-1 rounded border border-border bg-background px-2 py-1 text-xs text-muted-foreground" />
        <button onClick={() => void save()} className="text-emerald-500 hover:text-emerald-400"><Check className="size-3.5" /></button>
        <button onClick={cancel} className="text-muted-foreground hover:text-foreground"><X className="size-3.5" /></button>
      </div>
    )
  }

  return (
    <div className="group flex items-center gap-2 py-1.5 text-sm">
      <span className="w-28 truncate font-medium">{item.term}</span>
      <span className="text-muted-foreground">→</span>
      <span className="flex-1 truncate text-muted-foreground">{item.replacement}</span>
      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
        <button onClick={() => void speak({ text: item.replacement })} title="Preview"
          className="text-muted-foreground hover:text-foreground"><Play className="size-3 fill-current" /></button>
        <button onClick={startEdit} title="Edit"
          className="text-muted-foreground hover:text-foreground"><Pencil className="size-3" /></button>
        <button onClick={() => onDelete(item.id)} title="Delete"
          className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3" /></button>
      </div>
    </div>
  )
}

function PackSection({ pack, onToggle }: { pack: PronunciationPack; onToggle: (id: string, enabled: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<PronunciationItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [toggling, setToggling] = useState(false)

  const loadItems = useCallback(async () => {
    try {
      const r = await fetch(`/api/admin/voice/pronunciation-packs/${pack.id}/items`, { credentials: 'include' })
      if (r.ok) setItems((await r.json() as { items: PronunciationItem[] }).items ?? [])
      setLoaded(true)
    } catch { /* offline */ }
  }, [pack.id])

  const toggle = open
  useEffect(() => { if (toggle && !loaded) void loadItems() }, [toggle, loaded, loadItems])

  const handleToggle = async () => {
    setToggling(true)
    try {
      const r = await fetch(`/api/admin/voice/pronunciation-packs/${pack.id}`, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !pack.enabled }),
      })
      if (r.ok) onToggle(pack.id, !pack.enabled)
    } catch { /* offline */ }
    finally { setToggling(false) }
  }

  const addItem = async (term: string, replacement: string) => {
    const r = await fetch(`/api/admin/voice/pronunciation-packs/${pack.id}/items`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, replacement }),
    })
    if (!r.ok) throw new Error()
    setItems((await r.json() as { items: PronunciationItem[] }).items ?? [])
  }

  const saveItem = async (id: string, term: string, replacement: string) => {
    const r = await fetch(`/api/admin/voice/pronunciation-packs/${pack.id}/items`, {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, term, replacement }),
    })
    if (!r.ok) throw new Error()
    setItems((await r.json() as { items: PronunciationItem[] }).items ?? [])
  }

  const deleteItem = (id: string) => {
    setItems((cur) => cur.filter((i) => i.id !== id))
    void fetch(`/api/admin/voice/pronunciation-packs/${pack.id}/items/${id}`, { method: 'DELETE', credentials: 'include' })
  }

  const itemCount = loaded ? items.length : pack.itemCount

  return (
    <div className="border-b border-border/60 last:border-0">
      {/* Header row */}
      <div className="flex items-center gap-2 px-4 py-3">
        <button type="button" onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left">
          {open ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
          <span className="text-sm font-medium">{pack.name}</span>
          {pack.appKey && (
            <span className="rounded-full bg-foreground/[0.06] px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              {APP_KEY_LABELS[pack.appKey] ?? pack.appKey}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">{itemCount} rules</span>
        </button>
        <button
          type="button" disabled={toggling} onClick={() => void handleToggle()}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50',
            pack.enabled ? 'bg-violet-600' : 'bg-foreground/20',
          )}
        >
          <span className={cn('pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-lg transition-transform', pack.enabled ? 'translate-x-4' : 'translate-x-0')} />
        </button>
      </div>

      {/* Expanded items */}
      {open && (
        <div className="px-4 pb-4">
          {pack.description && <p className="mb-3 text-xs text-muted-foreground">{pack.description}</p>}
          {!loaded ? (
            <p className="py-2 text-xs text-muted-foreground">Loading…</p>
          ) : items.length === 0 ? (
            <p className="py-2 text-xs text-muted-foreground">No rules yet.</p>
          ) : (
            <div className="divide-y divide-border/40">
              {items.map((item) => (
                <ItemRow key={item.id} item={item} onSave={saveItem} onDelete={deleteItem} />
              ))}
            </div>
          )}
          <AddRuleRow onAdd={addItem} />
        </div>
      )}
    </div>
  )
}

export function PronunciationEditor() {
  const [packs, setPacks] = useState<PronunciationPack[]>([])
  const [custom, setCustom] = useState<PronunciationItem[]>([])

  const loadPacks = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/voice/pronunciation-packs', { credentials: 'include' })
      if (r.ok) setPacks((await r.json() as { packs: PronunciationPack[] }).packs ?? [])
    } catch { /* offline */ }
  }, [])

  const loadCustom = useCallback(async () => {
    try {
      const r = await fetch('/api/admin/voice/pronunciations', { credentials: 'include' })
      if (r.ok) setCustom((await r.json() as { pronunciations: PronunciationItem[] }).pronunciations ?? [])
    } catch { /* offline */ }
  }, [])

  useEffect(() => { void loadPacks(); void loadCustom() }, [loadPacks, loadCustom])

  const handlePackToggle = (id: string, enabled: boolean) =>
    setPacks((cur) => cur.map((p) => p.id === id ? { ...p, enabled } : p))

  const addCustom = async (term: string, replacement: string) => {
    const r = await fetch('/api/admin/voice/pronunciations', {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ term, replacement }),
    })
    if (!r.ok) throw new Error()
    setCustom((await r.json() as { pronunciations: PronunciationItem[] }).pronunciations ?? [])
  }

  const saveCustom = async (id: string, term: string, replacement: string) => {
    const r = await fetch('/api/admin/voice/pronunciations', {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, term, replacement }),
    })
    if (!r.ok) throw new Error()
    setCustom((await r.json() as { pronunciations: PronunciationItem[] }).pronunciations ?? [])
  }

  const deleteCustom = (id: string) => {
    setCustom((cur) => cur.filter((r) => r.id !== id))
    void fetch(`/api/admin/voice/pronunciations/${id}`, { method: 'DELETE', credentials: 'include' })
  }

  return (
    <section className="rounded-2xl border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <SpellCheck className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold">Pronunciation rules</h3>
        <span className="text-xs text-muted-foreground">Respellings applied to TTS audio everywhere</span>
      </div>

      {/* Built-in packs */}
      {packs.map((pack) => (
        <PackSection key={pack.id} pack={pack} onToggle={handlePackToggle} />
      ))}

      {/* Custom rules (always on) */}
      <div className="px-4 pb-4 pt-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Custom rules</p>
        {custom.length === 0 ? (
          <p className="py-1 text-xs text-muted-foreground">No custom rules yet.</p>
        ) : (
          <div className="mb-1 divide-y divide-border/40">
            {custom.map((item) => (
              <ItemRow key={item.id} item={item} onSave={saveCustom} onDelete={deleteCustom} />
            ))}
          </div>
        )}
        <AddRuleRow onAdd={addCustom} />
      </div>
    </section>
  )
}

// Keep legacy exports so any other import sites don't break.
export function PronunciationPacks() { return null }
export function PronunciationLexicon() { return null }

function DefaultRow({
  icon, label, value, onChange,
}: {
  icon: React.ReactNode
  label: string
  value: string
  onChange: () => void
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-foreground/5 text-muted-foreground">
        {icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-medium">{value}</p>
      </div>
      <button
        type="button"
        onClick={onChange}
        className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
      >
        Change
      </button>
    </div>
  )
}
