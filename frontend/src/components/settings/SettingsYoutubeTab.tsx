import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/switch'
import { Spinner } from '@/components/ui/spinner'
import { useAuth } from '@/context/AuthContext'
import { readDeArrowEnabled, writeDeArrowEnabled } from '@/lib/youtube/dearrow'
import { EnhanceVideoUserSetting } from './EnhanceVideoSetting'

const SMART_DESCRIPTION_PREF_KEY = 'youtube.smart_description'

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

/** A single toggle row — matches the admin panel's convention (AdminAppsTab.tsx's "Lock
 *  layout" row): bordered card, no per-row icon (icons are reserved for a tab's own header
 *  strip), semibold title + smaller muted description, switch pinned right. */
function ToggleRow({ title, description, checked, onCheckedChange }: {
  title: string; description: string; checked: boolean; onCheckedChange: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-card border border-border/50 bg-background/50 px-4 py-3">
      <div>
        <p className="text-xs font-semibold">{title}</p>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  )
}

export function SettingsYoutubeAutoSkip() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const [prefs, setPrefs] = useState<Record<SkipCategory, boolean>>(DEFAULTS)
  const [saving, setSaving] = useState(false)

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

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-overline text-muted-foreground">Auto-skip segments</p>
        {saving && <Spinner size="sm" />}
      </div>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Choose which parts of a video are skipped automatically, using community-sourced
        SponsorBlock data. Turn one off to watch that section.
      </p>
      <div className="space-y-2">
        {ROWS.map(({ keys, label, description }) => (
          <ToggleRow
            key={keys.join('+')}
            title={label} description={description}
            checked={keys.every(k => prefs[k])} onCheckedChange={() => toggle(keys)}
          />
        ))}
      </div>
    </div>
  )
}

export function SettingsYoutubeVideoQuality() {
  return <EnhanceVideoUserSetting />
}

export function SettingsYoutubeTitlesThumbnails() {
  const [dearrow, setDearrow] = useState(readDeArrowEnabled)

  function toggleDearrow() {
    const next = !dearrow
    setDearrow(next)
    writeDeArrowEnabled(next)
  }

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Titles &amp; thumbnails</p>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Applies everywhere in the YouTube app, not just one video.
      </p>
      <ToggleRow
        title="Replace clickbait"
        description="Swap sensationalized titles and thumbnails for neutral, community-voted ones."
        checked={dearrow} onCheckedChange={toggleDearrow}
      />
    </div>
  )
}

export function SettingsYoutubeDescriptions() {
  const { user } = useAuth()
  const [smartDescription, setSmartDescription] = useState(true)

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (typeof data?.[SMART_DESCRIPTION_PREF_KEY] === 'boolean') {
          setSmartDescription(data[SMART_DESCRIPTION_PREF_KEY] as boolean)
        }
      })
      .catch(() => {})
  }, [user?.id])

  function toggleSmartDescription() {
    if (!user?.id) return
    const next = !smartDescription
    setSmartDescription(next)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [SMART_DESCRIPTION_PREF_KEY]: next }),
    }).catch(() => {})
  }

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Descriptions</p>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Applies everywhere in the app, and to Plex libraries too.
      </p>
      <ToggleRow
        title="Smart Description"
        description="Strip sponsor reads and promotional links from descriptions, or write one from the video's content when the real description is mostly ads."
        checked={smartDescription} onCheckedChange={toggleSmartDescription}
      />
    </div>
  )
}
