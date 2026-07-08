// Per-source save quality + auto-enhance for the hub sources (TikTok/Vimeo/Reddit) -
// mirrors SettingsYoutubeVideoQuality's tier pattern, one row per source. Preferences
// write through the generic /preferences endpoint (videos.save_quality.<source>,
// media.enhance_mode.<source>); the admin caps have their own /api/videos routes.

import { useEffect, useState } from 'react'
import { useAuth } from '@/context/AuthContext'
import { SOURCE_META } from '@/lib/videos/sources'
import type { VideoSource } from '@/lib/videos/api'

interface SourceQuality {
  source: string
  cap: number
  pref: number | null
  effective: number
  enhanceMode: 'default' | 'always' | 'never'
  enhanceDefault: boolean | null
  enhanceEffective: boolean
}

interface QualityResponse {
  tiers: number[]
  householdEnhanceDefault: boolean
  sources: SourceQuality[]
}

export function SettingsVideosQuality() {
  const { user } = useAuth()
  const [data, setData] = useState<QualityResponse | null>(null)

  useEffect(() => {
    fetch('/api/videos/quality', { credentials: 'include' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => setData(d as QualityResponse | null))
      .catch(() => {})
  }, [])

  async function savePref(key: string, value: unknown) {
    if (!user?.id) return
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: value }),
    }).catch(() => {})
  }

  if (!data) return null

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Source quality &amp; enhance</p>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Resolution used when saving each source's videos offline, and whether saved videos
        get the background clarity enhance. "Household default" follows the admin-wide
        enhance setting ({data.householdEnhanceDefault ? 'on' : 'off'}).
      </p>
      <div className="space-y-2 pt-1">
        {data.sources.map(s => {
          const meta = SOURCE_META[s.source as VideoSource]
          return (
            <div key={s.source} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-card border border-border/50 bg-background/50 px-4 py-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold">
                <span className={`inline-block size-1.5 rounded-full ${meta?.dotClass ?? 'bg-muted-foreground'}`} />
                {meta?.label ?? s.source}
              </p>
              <div className="flex items-center gap-3 text-xs">
                <label className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Save at</span>
                  <select
                    value={s.pref ?? s.cap}
                    onChange={e => {
                      const v = Number(e.target.value)
                      setData(d => d && { ...d, sources: d.sources.map(x => (x.source === s.source ? { ...x, pref: v } : x)) })
                      void savePref(`videos.save_quality.${s.source}`, v)
                    }}
                    className="rounded-control border border-border bg-background px-2 py-1 text-foreground"
                  >
                    {data.tiers.filter(t => t <= s.cap).map(t => <option key={t} value={t}>{t}p</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-1.5">
                  <span className="text-muted-foreground">Enhance</span>
                  <select
                    value={s.enhanceMode}
                    onChange={e => {
                      const v = e.target.value as SourceQuality['enhanceMode']
                      setData(d => d && { ...d, sources: d.sources.map(x => (x.source === s.source ? { ...x, enhanceMode: v } : x)) })
                      void savePref(`media.enhance_mode.${s.source}`, v)
                    }}
                    className="rounded-control border border-border bg-background px-2 py-1 text-foreground"
                  >
                    <option value="default">Household default</option>
                    <option value="always">Always</option>
                    <option value="never">Never</option>
                  </select>
                </label>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
