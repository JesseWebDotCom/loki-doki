import { useEffect, useState } from 'react'
import { ShieldCheck, Flame, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import {
  ContentDialGroup, MIN_DIALS, MAX_DIALS, DIAL_KEYS, levelIdx, dialsEqual, normalizeDials,
} from '@/components/shared/contentDials'
import type { ContentDialValues, Candor, DialKey } from '@/components/shared/contentDials'

type Preset = 'safe' | 'open' | 'custom'

// Mirror of the backend's deriveUserCeiling for first-load display when the user has
// not yet saved explicit dials.
function deriveFromLegacy(prefs: Record<string, unknown>): ContentDialValues {
  const stored = prefs['content_dials']
  if (stored && typeof stored === 'object') return normalizeDials(stored as Partial<Record<DialKey, unknown>>)
  const base: ContentDialValues = prefs['safe_mode'] === false ? { ...MAX_DIALS } : { ...MIN_DIALS }
  const prot = prefs['protections'] as Record<string, unknown> | undefined
  if (prot) {
    if (prot['blockProfanity']) base.profanity = 'off'
    if (prot['blockSensitiveTopics']) { base.violence = 'off'; base.substances = 'off' }
  }
  return base
}

function clampToCeiling(dials: ContentDialValues, ceiling: ContentDialValues): ContentDialValues {
  const out = { ...dials }
  for (const k of DIAL_KEYS) {
    if (levelIdx(k, out[k]) > levelIdx(k, ceiling[k])) out[k] = ceiling[k]
  }
  return out
}

function detectPreset(dials: ContentDialValues, candor: Candor): Preset {
  if (dialsEqual(dials, MIN_DIALS) && candor === 'balanced') return 'safe'
  if (dialsEqual(dials, MAX_DIALS) && candor === 'blunt') return 'open'
  return 'custom'
}

export function SettingsPrivacyTab() {
  const { user } = useAuth()
  const [dials, setDials] = useState<ContentDialValues>({ ...MIN_DIALS })
  const [candor, setCandor] = useState<Candor>('balanced')
  const [ceiling, setCeiling] = useState<ContentDialValues>({ ...MAX_DIALS })
  const [style, setStyle] = useState<Record<string, unknown>>({})
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!user) return
    Promise.all([
      fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' }).then(r => r.ok ? r.json() : {}),
      fetch('/api/content/ceiling', { credentials: 'include' }).then(r => r.ok ? r.json() : null),
    ]).then(([prefs, ceilingRes]: [Record<string, unknown>, { ceiling: ContentDialValues } | null]) => {
      const cap = ceilingRes ? normalizeDials(ceilingRes.ceiling, MAX_DIALS) : { ...MAX_DIALS }
      setCeiling(cap)
      setDials(clampToCeiling(deriveFromLegacy(prefs), cap))
      const st = (prefs['interaction_style'] as Record<string, unknown> | undefined) ?? {}
      setStyle(st)
      setCandor((st['candor'] as Candor) ?? 'balanced')
      setLoaded(true)
    }).catch(() => setLoaded(true))
  }, [user?.id])

  const persist = async (nextDials: ContentDialValues, nextCandor: Candor) => {
    if (!user) return
    setSaving(true)
    try {
      await fetch(`/api/users/${user.id}/preferences`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content_dials: nextDials, interaction_style: { ...style, candor: nextCandor } }),
        credentials: 'include',
      })
      setSaved(true); setTimeout(() => setSaved(false), 1500)
    } finally { setSaving(false) }
  }

  const applyDial = (key: DialKey, value: string) => {
    const next = { ...dials, [key]: value }
    setDials(next); void persist(next, candor)
  }
  const applyCandor = (value: Candor) => { setCandor(value); void persist(dials, value) }

  const applyPreset = (preset: Preset) => {
    if (preset === 'custom') return
    const target = preset === 'safe' ? { ...MIN_DIALS } : clampToCeiling({ ...MAX_DIALS }, ceiling)
    const nextCandor: Candor = preset === 'safe' ? 'balanced' : 'blunt'
    setDials(target); setCandor(nextCandor); void persist(target, nextCandor)
  }

  if (!loaded) return <p className="text-sm text-muted-foreground">Loading…</p>

  const preset = detectPreset(dials, candor)
  const presets: { id: Preset; label: string; icon: typeof ShieldCheck; desc: string }[] = [
    { id: 'safe', label: 'Safe', icon: ShieldCheck, desc: 'Clean and family-friendly' },
    { id: 'open', label: 'Open', icon: Flame, desc: 'Unfiltered, blunt, explicit' },
    { id: 'custom', label: 'Custom', icon: SlidersHorizontal, desc: 'Tune each dial yourself' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Content</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Controls what the AI will say. A safety floor (illegal/harmful content) always applies and cannot be turned off.
        </p>
      </div>

      {/* Presets */}
      <div className="grid grid-cols-3 gap-2">
        {presets.map(({ id, label, icon: Icon, desc }) => (
          <button
            key={id}
            type="button"
            onClick={() => applyPreset(id)}
            className={cn(
              'flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors',
              preset === id ? 'border-brand bg-brand/5' : 'border-border/60 hover:bg-muted/50',
              id === 'custom' && 'cursor-default',
            )}
          >
            <Icon className={cn('size-4', preset === id ? 'text-brand' : 'text-muted-foreground')} />
            <span className="text-sm font-medium">{label}</span>
            <span className="text-[11px] text-muted-foreground">{desc}</span>
          </button>
        ))}
      </div>

      {/* Dials */}
      <div className="rounded-xl border border-border/50 bg-card p-4">
        <ContentDialGroup
          values={dials}
          ceiling={ceiling}
          includeCandor
          candor={candor}
          onDial={applyDial}
          onCandor={applyCandor}
        />
        {!dialsEqual(ceiling, MAX_DIALS) && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            Some levels are limited by your administrator.
          </p>
        )}
      </div>

      <p className="h-4 text-xs text-muted-foreground">{saving ? 'Saving…' : saved ? 'Saved' : ''}</p>
    </div>
  )
}
