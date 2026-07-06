import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, UploadCloud, Rss, Download, PauseCircle } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { ToggleRow } from '@/components/shared/ToggleRow'
import { Spinner } from '@/components/ui/spinner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/context/AuthContext'
import { readDeArrowEnabled, writeDeArrowEnabled } from '@/lib/youtube/dearrow'
import * as yt from '@/lib/youtube/api'
import type { Subscription } from '@/lib/youtube/api'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'
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
  return (
    <div className="space-y-8">
      <EnhanceVideoUserSetting />
      <SaveQualitySetting />
    </div>
  )
}

// The resolution used when saving videos offline (clamped to the admin cap). A video-quality
// preference, so it lives in the Video quality section rather than with channel management.
function SaveQualitySetting() {
  const { user } = useAuth()
  const [tiers, setTiers] = useState<number[]>([])
  const [cap, setCap] = useState<number | null>(null)
  const [pref, setPref] = useState<number | null>(null)

  useEffect(() => {
    yt.getSaveQuality().then(d => { setTiers(d.tiers ?? []); setCap(d.cap); setPref(d.pref) }).catch(() => {})
  }, [])

  async function savePref(value: number) {
    setPref(value)
    if (!user?.id) return
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'youtube.save_quality': value }),
    }).catch(() => {})
  }

  if (!tiers.length) return null
  return (
    <div className="flex items-center justify-between gap-3 rounded-card border border-border/50 bg-background/50 px-4 py-3">
      <div>
        <p className="text-xs font-semibold">Save quality</p>
        <p className="text-[11px] text-muted-foreground">Resolution used when you Save videos offline{cap ? ` (max ${cap}p set by admin)` : ''}.</p>
      </div>
      <select value={pref ?? cap ?? 1080} onChange={e => savePref(Number(e.target.value))} className="shrink-0 rounded-control border border-border bg-background px-2 py-1.5 text-sm">
        {tiers.filter(t => cap == null || t <= cap).map(t => <option key={t} value={t}>{t}p</option>)}
      </select>
    </div>
  )
}

// Channel management: add/import subscriptions, per-channel auto-save, the save-quality
// preference, and the automation master switch. Lives here (in the app's Settings page)
// rather than the old floating "Manage channels" modal.
export function SettingsYoutubeChannels() {
  const qc = useQueryClient()
  const [subs, setSubs] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  // Automation master switch + global keep-N default.
  const [paused, setPaused] = useState(false)
  const [keepDefault, setKeepDefault] = useState(10)
  const [isAdmin, setIsAdmin] = useState(false)
  const { ask: askUnsub, dialog: unsubDialog } = useUnsubscribeConfirm()

  // Refresh the feed/subs caches the rest of the app reads whenever channels change here.
  const onChanged = () => { qc.invalidateQueries({ queryKey: ['yt-subs'] }); qc.invalidateQueries({ queryKey: ['yt-feed'] }) }

  async function load() { setSubs(await yt.getSubscriptions()) }

  useEffect(() => {
    setLoading(true)
    load().finally(() => setLoading(false))
    yt.getAutomation().then(a => { setPaused(a.paused); setKeepDefault(a.keepDefault); setIsAdmin(a.isAdmin) }).catch(() => {})
  }, [])

  // Optimistically patch a subscription's automation settings.
  async function patchSub(id: string, patch: Partial<Pick<Subscription, 'autoSave' | 'autoSaveKind' | 'autoSaveKeep'>>) {
    setSubs(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
    await yt.updateSubscription(id, patch).catch(() => {})
    onChanged()
  }

  async function togglePause(v: boolean) {
    setPaused(v)
    await yt.setAutomation({ paused: v }).catch(() => {})
  }

  async function saveKeepDefault(n: number) {
    setKeepDefault(n)
    await yt.setAutomation({ keepDefault: n }).catch(() => {})
  }

  async function handleAdd() {
    const trimmed = input.trim()
    if (!trimmed || adding) return
    setAdding(true); setError(null)
    try {
      const d = await yt.addSubscription(trimmed)
      if (d.error) { setError(d.error); return }
      setInput(''); await load(); onChanged()
    } finally { setAdding(false) }
  }

  function handleDelete(id: string) {
    const sub = subs.find(x => x.id === id)
    if (!sub) return
    askUnsub({
      name: sub.title || sub.handle || 'this channel',
      sourceRef: `${sub.kind}:${sub.externalId}`,
      kind: sub.kind === 'playlist' ? 'playlist' : 'channel',
      onUnsubscribe: async () => {
        await yt.deleteSubscription(id)
        setSubs(prev => prev.filter(s => s.id !== id)); onChanged()
      },
    })
  }

  async function handleCsvImport(file: File) {
    setImporting(true); setError(null)
    try {
      const d = await yt.importSubscriptions(await file.text())
      if (d.error) { setError(d.error); return }
      await load(); onChanged()
    } finally { setImporting(false) }
  }

  return (
    <div className="space-y-8">
      {unsubDialog}

      <div className="space-y-2">
        <p className="text-overline text-muted-foreground">Add channels</p>
        <p className="text-[11px] text-muted-foreground/70 -mt-1">
          Follow a channel or playlist to build your feed.
        </p>
        <div className="flex gap-2 pt-1">
          <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="Paste @handle, channel URL, or playlist URL…"
            className="flex-1 rounded-control border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
          <Button variant="secondary" onClick={handleAdd} disabled={!input.trim() || adding} className="shrink-0 gap-1.5">
            {adding ? <Spinner size="sm" /> : <Plus className="size-3.5" />} Add
          </Button>
        </div>
        <button onClick={() => fileInputRef.current?.click()} disabled={importing}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
          {importing ? <Spinner size="sm" /> : <UploadCloud className="size-3.5" />} Import from Google Takeout (subscriptions.csv)
        </button>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) void handleCsvImport(f) }} />
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <div className="space-y-2">
        <p className="text-overline text-muted-foreground">Your channels</p>
        {loading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
        ) : subs.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">No subscriptions yet</p>
        ) : (
          <div className="space-y-2">
            {subs.map(sub => (
              <div key={sub.id} className="rounded-card border border-border/50 bg-background/50 px-3 py-2">
                <div className="flex items-center gap-3">
                  {sub.thumbnailUrl
                    ? <img src={yt.ytImageProxy(sub.thumbnailUrl)} alt={sub.title} referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-full object-cover" />
                    : <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"><Rss className="size-4 text-muted-foreground" /></div>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{sub.title}</p>
                    <p className="truncate text-xs text-muted-foreground">{sub.handle ?? sub.externalId} · {sub.kind}</p>
                  </div>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5" title="Auto-save new uploads offline">
                    <Download className="size-3.5 text-muted-foreground" />
                    <Switch checked={sub.autoSave} onCheckedChange={v => void patchSub(sub.id, { autoSave: v })} />
                  </label>
                  <button onClick={() => handleDelete(sub.id)} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Remove"><Trash2 className="size-4" /></button>
                </div>
                {sub.autoSave && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/40 pl-11 pt-2 text-xs text-muted-foreground">
                    <span>Save as</span>
                    <select value={sub.autoSaveKind} onChange={e => void patchSub(sub.id, { autoSaveKind: e.target.value as 'audio' | 'video' })}
                      className="rounded-control border border-border bg-background px-2 py-1 text-foreground">
                      <option value="video">Video</option>
                      <option value="audio">Audio</option>
                    </select>
                    <span>· keep latest</span>
                    <input type="number" min={0} value={sub.autoSaveKeep ?? ''} placeholder={String(keepDefault)}
                      onChange={e => void patchSub(sub.id, { autoSaveKeep: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })}
                      className="w-16 rounded-control border border-border bg-background px-2 py-1 text-foreground" />
                    <span>videos</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Automation master switch: freezes auto-save + auto-podcast without losing per-channel settings. */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3 rounded-card border border-border/50 bg-background/50 px-4 py-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-semibold"><PauseCircle className="size-3.5" /> Pause automation</p>
            <p className="text-[11px] text-muted-foreground">Stop auto-saving and auto-generating podcasts. Your per-channel settings are kept.</p>
          </div>
          <Switch checked={paused} onCheckedChange={v => void togglePause(v)} />
        </div>
        {isAdmin && (
          <div className="flex items-center justify-between gap-3 rounded-card border border-border/50 bg-background/50 px-4 py-3">
            <div>
              <p className="text-xs font-semibold">Default videos kept per channel</p>
              <p className="text-[11px] text-muted-foreground">Rolling cap on auto-saved videos when a channel has no override.</p>
            </div>
            <input type="number" min={1} value={keepDefault}
              onChange={e => { const n = Math.max(1, Math.floor(Number(e.target.value) || 1)); setKeepDefault(n) }}
              onBlur={e => void saveKeepDefault(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className="w-20 shrink-0 rounded-control border border-border bg-background px-2 py-1.5 text-sm" />
          </div>
        )}
      </div>
    </div>
  )
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
