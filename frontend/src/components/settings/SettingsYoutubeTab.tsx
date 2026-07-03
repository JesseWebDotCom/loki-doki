import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { SkipForward, Wand2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/context/AuthContext'
import { readDeArrowEnabled, writeDeArrowEnabled } from '@/lib/youtube/dearrow'

// Mirror of backend SKIP_CATEGORIES (sponsorblock.ts) — keep keys + defaults in sync.
export type SkipCategory =
  | 'sponsor' | 'selfpromo' | 'interaction' | 'intro' | 'outro' | 'preview' | 'music_offtopic'

// One UI row may drive several SponsorBlock keys (intros & outros move together).
const ROWS: { keys: SkipCategory[]; label: string; description: string; default: boolean }[] = [
  { keys: ['sponsor'],          label: 'Sponsors',              description: 'Paid promotions and product placements',   default: true  },
  { keys: ['selfpromo'],        label: 'Self-promotion',        description: "Unpaid plugs for the creator's own stuff", default: true  },
  { keys: ['interaction'],      label: 'Interaction reminders', description: '"Like and subscribe" prompts',             default: true  },
  { keys: ['intro', 'outro'],   label: 'Intros & outros',       description: 'Channel intros, end cards and credits',    default: false },
  { keys: ['preview'],          label: 'Previews & recaps',     description: "Recaps of earlier content or what's next", default: true  },
  { keys: ['music_offtopic'],   label: 'Non-music sections',    description: 'Off-topic talking in music videos',        default: true  },
]

const DEFAULTS = Object.fromEntries(
  ROWS.flatMap(r => r.keys.map(k => [k, r.default])),
) as Record<SkipCategory, boolean>
const PREF_KEY = 'youtube.skip_categories'

export function SettingsYoutubeTab() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [prefs, setPrefs] = useState<Record<SkipCategory, boolean>>(DEFAULTS)
  const [saving, setSaving] = useState(false)
  const [dearrow, setDearrow] = useState(readDeArrowEnabled)

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        const saved = data?.[PREF_KEY]
        if (saved && typeof saved === 'object') {
          setPrefs({ ...DEFAULTS, ...(saved as Partial<Record<SkipCategory, boolean>>) })
        }
      })
      .catch(() => {})
  }, [user?.id])

  function toggle(keys: SkipCategory[]) {
    if (!user?.id) return
    const on = !keys.every(k => prefs[k])  // all-on → off, otherwise → on
    const next = { ...prefs, ...Object.fromEntries(keys.map(k => [k, on])) }
    setPrefs(next)
    setSaving(true)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [PREF_KEY]: next }),
    })
      // Drop cached SponsorBlock results so open/next videos pick up the new choices.
      .then(() => qc.invalidateQueries({ queryKey: ['yt-sb'] }))
      .finally(() => setSaving(false))
  }

  function toggleDearrow() {
    const next = !dearrow
    setDearrow(next)
    writeDeArrowEnabled(next)
  }

  return (
    <div className="p-4 space-y-6">
      <div>
        <div className="flex items-center justify-between mb-1">
          <p className="text-sm font-medium">Auto-skip segments</p>
          {saving && <Spinner size="sm" />}
        </div>
        <p className="text-xs text-muted-foreground mb-4">
          Choose which parts of a video are skipped automatically, using community-sourced
          SponsorBlock data. Turn one off to watch that section.
        </p>
        <div className="space-y-1">
          {ROWS.map(({ keys, label, description }) => (
            <div
              key={keys.join('+')}
              className="flex items-center gap-4 rounded-control px-3 py-3 hover:bg-muted/40 transition-colors"
            >
              <SkipForward className="size-4 text-muted-foreground shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
              <Switch checked={keys.every(k => prefs[k])} onCheckedChange={() => toggle(keys)} />
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-medium mb-1">Titles &amp; thumbnails</p>
        <p className="text-xs text-muted-foreground mb-4">
          Applies everywhere in the YouTube app, not just one video.
        </p>
        <div className="flex items-center gap-4 rounded-control px-3 py-3 hover:bg-muted/40 transition-colors">
          <Wand2 className="size-4 text-muted-foreground shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Replace clickbait</p>
            <p className="text-xs text-muted-foreground">
              Swap sensationalized titles and thumbnails for neutral, community-voted ones.
            </p>
          </div>
          <Switch checked={dearrow} onCheckedChange={toggleDearrow} />
        </div>
      </div>
    </div>
  )
}
