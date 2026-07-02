// Admin tab for podcast management: shared shows overview, script model, and default host config.

import { useEffect, useState } from 'react'
import { Mic, Users, Radio, Sparkles, KeyRound } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { toast } from '@/lib/toast'

interface SharedShow {
  id: string
  name: string
  ownerName: string
  style: string
  visibility: 'personal' | 'shared'
}

interface PodcastIndexState { configured: boolean; keyHint: string | null }

export function AdminPodcastsTab() {
  const [shows, setShows] = useState<SharedShow[]>([])
  const [loading, setLoading] = useState(true)
  const [scriptModel, setScriptModel] = useState('')
  const [installedModels, setInstalledModels] = useState<string[]>([])
  const [podcastIndex, setPodcastIndex] = useState<PodcastIndexState | null>(null)

  async function load() {
    const r = await fetch('/api/podcasts/shows', { credentials: 'include' })
    const d = await r.json() as { shows: SharedShow[] }
    setShows(d.shows ?? [])
    try {
      const s = await fetch('/api/podcasts/admin/settings', { credentials: 'include' })
      if (s.ok) {
        const sd = await s.json() as { scriptModel: string; installedModels: string[]; podcastIndex?: PodcastIndexState }
        setScriptModel(sd.scriptModel ?? '')
        setInstalledModels(sd.installedModels ?? [])
        setPodcastIndex(sd.podcastIndex ?? null)
      }
    } catch { /* settings section degrades to hidden */ }
  }

  useEffect(() => { load().finally(() => setLoading(false)) }, [])

  async function saveScriptModel(value: string) {
    setScriptModel(value)
    try {
      const r = await fetch('/api/podcasts/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ scriptModel: value }),
      })
      if (!r.ok) throw new Error()
      toast.success('Script model saved')
    } catch { toast.error('Could not save script model') }
  }

  const shared = shows.filter(s => s.visibility === 'shared')
  const all = shows

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold">Podcasts</h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          Overview of all podcast shows. Users manage their own shows from the Podcasts app.
          Shared shows appear in the Family listing for all users.
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Shows', value: all.length, icon: Radio },
          { label: 'Shared',      value: shared.length, icon: Users },
        ].map(s => (
          <div key={s.label} className="rounded-lg border border-border/60 bg-card p-3">
            <div className="flex items-center gap-2">
              <s.icon className="size-4 text-muted-foreground" />
              <span className="text-xs text-muted-foreground">{s.label}</span>
            </div>
            <p className="text-2xl font-bold mt-1">{loading ? '—' : s.value}</p>
          </div>
        ))}
      </div>

      {/* Script model */}
      <div className="rounded-lg border border-border/60 bg-card p-3 space-y-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Script model</span>
        </div>
        <p className="text-xs text-muted-foreground">
          Which model writes episode scripts. Long scripted dialogue is sensitive to model quality —
          if the main chat model is an uncensored variant, a stock instruct model usually sounds
          noticeably more natural here.
        </p>
        <select
          className="ld-input w-full max-w-sm"
          value={scriptModel}
          onChange={(e) => void saveScriptModel(e.target.value)}
        >
          <option value="">Follow main chat model</option>
          {installedModels.map(m => <option key={m} value={m}>{m}</option>)}
          {scriptModel && !installedModels.includes(scriptModel) && (
            <option value={scriptModel}>{scriptModel} (not installed)</option>
          )}
        </select>
      </div>

      {/* Podcast Index keys */}
      <PodcastIndexCard state={podcastIndex} onSaved={pi => setPodcastIndex(pi)} />

      {/* Shared shows list */}
      <div>
        <h4 className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">Family Shared Shows</h4>
        {loading ? (
          <div className="space-y-2">
            {[1, 2].map(i => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
          </div>
        ) : shared.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border py-10 text-muted-foreground">
            <Mic className="mb-2 size-8 opacity-30" />
            <p className="text-sm">No shared shows yet</p>
            <p className="text-xs mt-1">Users can share their shows from the Podcasts app</p>
          </div>
        ) : (
          <div className="space-y-2">
            {shared.map(show => (
              <div key={show.id} className="flex items-center gap-3 rounded-lg border border-border/60 bg-card px-3 py-2.5">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-purple-500/15">
                  <Mic className="size-4 text-purple-600" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{show.name}</p>
                  <p className="text-xs text-muted-foreground">by {show.ownerName} · {show.style}</p>
                </div>
                <div className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
                  Shared
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/** Optional PodcastIndex API credentials — richer directory trending/search when set. */
function PodcastIndexCard({ state, onSaved }: {
  state: PodcastIndexState | null
  onSaved: (state: PodcastIndexState | null) => void
}) {
  const [key, setKey] = useState('')
  const [secret, setSecret] = useState('')
  const [keyDirty, setKeyDirty] = useState(false)
  const [secretDirty, setSecretDirty] = useState(false)
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!keyDirty && !secretDirty) return
    setSaving(true)
    try {
      const r = await fetch('/api/podcasts/admin/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          // Only send fields the admin edited — undefined leaves the stored value alone,
          // an empty string clears it.
          ...(keyDirty && { podcastIndexKey: key.trim() }),
          ...(secretDirty && { podcastIndexSecret: secret.trim() }),
        }),
      })
      if (!r.ok) throw new Error()
      toast.success('Podcast Index settings saved')
      setKey(''); setSecret(''); setKeyDirty(false); setSecretDirty(false)
      // Re-read so the configured badge + key hint reflect the new state.
      const s = await fetch('/api/podcasts/admin/settings', { credentials: 'include' })
      if (s.ok) {
        const sd = await s.json() as { podcastIndex?: PodcastIndexState }
        onSaved(sd.podcastIndex ?? null)
      }
    } catch {
      toast.error('Could not save Podcast Index settings')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">Podcast Index (optional)</span>
        {state?.configured && (
          <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
            Configured{state.keyHint ? ` · ${state.keyHint}` : ''}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Free API keys from podcastindex.org unlock richer trending charts and search in the podcast
        directory. Without keys, browsing falls back to Apple's keyless directory — which still works fine.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className="ld-input w-full"
          placeholder={state?.configured ? 'API key (unchanged)' : 'API key'}
          value={key}
          onChange={e => { setKey(e.target.value); setKeyDirty(true) }}
        />
        <input
          type="password"
          className="ld-input w-full"
          placeholder={state?.configured ? 'API secret (unchanged)' : 'API secret'}
          value={secret}
          onChange={e => { setSecret(e.target.value); setSecretDirty(true) }}
        />
      </div>
      <button
        onClick={() => void save()}
        disabled={saving || (!keyDirty && !secretDirty)}
        className="rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-brand-foreground hover:opacity-90 disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  )
}
