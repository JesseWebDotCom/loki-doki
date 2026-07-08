import { useEffect, useState } from 'react'
import { ToggleRow } from '@/components/shared/ToggleRow'
import { useAuth } from '@/context/AuthContext'

const SMART_TITLES_PREF_KEY = 'videos.smart_titles'

// Hub-wide (not YouTube-specific) — currently only affects TikTok's watch page, the only
// source whose native metadata has no real title, only a caption. Central so any future
// caption-only source reuses the same toggle instead of growing its own.
export function SettingsVideoTitles() {
  const { user } = useAuth()
  const [smartTitles, setSmartTitles] = useState(true)

  useEffect(() => {
    if (!user?.id) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: Record<string, unknown> | null) => {
        if (typeof data?.[SMART_TITLES_PREF_KEY] === 'boolean') {
          setSmartTitles(data[SMART_TITLES_PREF_KEY] as boolean)
        }
      })
      .catch(() => {})
  }, [user?.id])

  function toggleSmartTitles() {
    if (!user?.id) return
    const next = !smartTitles
    setSmartTitles(next)
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [SMART_TITLES_PREF_KEY]: next }),
    }).catch(() => {})
  }

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Titles</p>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Applies to sources whose videos have no real title, only a caption (TikTok).
      </p>
      <ToggleRow
        title="Smart Titles"
        description="Distill a short, YouTube-style title from the caption instead of showing the full caption as the title."
        checked={smartTitles} onCheckedChange={toggleSmartTitles}
      />
    </div>
  )
}
