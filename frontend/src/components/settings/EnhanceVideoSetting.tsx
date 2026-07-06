import { useEffect, useState } from 'react'
import { Sparkles } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/context/AuthContext'

// Shared control for the household-wide "enhance downloaded videos" policy. App-neutral (governs
// YouTube saves, the clipper, etc.) so any admin/settings surface can drop it in:
//   - variant="admin": a Switch for the household default (media.enhance_default)
//   - variant="user":  a tri-state override (media.enhance_mode: default | always | never)
// Enhancement is a background denoise+sharpen re-encode: the original plays instantly and the
// crisper version swaps in when it's ready, so there's never anything to wait for.

export const ENHANCE_MODE_PREF_KEY = 'media.enhance_mode'
type EnhanceMode = 'default' | 'always' | 'never'

const MODES: { value: EnhanceMode; label: string }[] = [
  { value: 'default', label: 'Use default' },
  { value: 'always', label: 'Always on' },
  { value: 'never', label: 'Off' },
]

function SegmentedControl({ value, onChange }: { value: EnhanceMode; onChange: (v: EnhanceMode) => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-control border border-border bg-background p-0.5">
      {MODES.map((m) => (
        <button
          key={m.value}
          type="button"
          onClick={() => onChange(m.value)}
          className={`rounded-[calc(var(--radius-control)-2px)] px-2.5 py-1 text-xs transition-colors ${
            value === m.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

/** Admin household-default toggle. */
export function EnhanceVideoAdminSetting() {
  const [enabled, setEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/admin/media/enhance-default', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { enabled?: boolean } | null) => { if (d) setEnabled(d.enabled === true) })
      .catch(() => {})
  }, [])

  function save(next: boolean) {
    setEnabled(next)
    fetch('/api/admin/media/enhance-default', {
      method: 'PUT', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    }).catch(() => {})
  }

  return (
    <div className="space-y-3">
      <p className="text-overline text-muted-foreground/60">Video enhancement</p>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium">Enhance saved videos by default</p>
          <p className="text-[10px] text-muted-foreground/60">
            Background denoise &amp; sharpen after a save. Users can override this in their own settings.
          </p>
        </div>
        <Switch checked={enabled ?? false} disabled={enabled === null} onCheckedChange={save} />
      </div>
    </div>
  )
}

/** Per-user tri-state override. */
export function EnhanceVideoUserSetting() {
  const { user } = useAuth()
  const [mode, setMode] = useState<EnhanceMode>('default')

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        const v = data?.[ENHANCE_MODE_PREF_KEY]
        if (v === 'always' || v === 'never' || v === 'default') setMode(v)
      })
      .catch(() => {})
  }, [user?.id])

  function save(next: EnhanceMode) {
    if (!user?.id) return
    setMode(next)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [ENHANCE_MODE_PREF_KEY]: next }),
    }).catch(() => {})
  }

  return (
    <div>
      <p className="text-sm font-medium mb-1">Video quality</p>
      <p className="text-xs text-muted-foreground mb-4">
        Applies to every video you save offline, across apps.
      </p>
      <div className="flex items-center gap-4 rounded-control px-3 py-3 hover:bg-muted/40 transition-colors">
        <Sparkles className="size-4 text-muted-foreground shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Enhance saved videos</p>
          <p className="text-xs text-muted-foreground">
            Sharpen and clean up compressed video in the background. The original plays right
            away; the enhanced version swaps in when it's ready.
          </p>
        </div>
        <SegmentedControl value={mode} onChange={save} />
      </div>
    </div>
  )
}
