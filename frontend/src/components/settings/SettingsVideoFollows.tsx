// Followed-creators automation for the generic hub sources (TikTok/Vimeo/Reddit) - the
// non-YouTube twin of SettingsYoutubeChannels' per-channel controls, finally consuming
// the backend's per-follow autoSave/autoSaveKind/autoSaveKeep (PATCH /api/videos/follows/:id).

import { useEffect, useState } from 'react'
import { Download, Rss, Trash2 } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { SOURCE_META } from '@/lib/videos/sources'
import { listFollows, removeFollow, patchFollow, type VideoFollow } from '@/lib/videos/api'

export function SettingsVideoFollows() {
  const [follows, setFollows] = useState<VideoFollow[]>([])
  const [loading, setLoading] = useState(true)
  const [unfollowTarget, setUnfollowTarget] = useState<VideoFollow | null>(null)

  useEffect(() => {
    listFollows()
      .then(r => setFollows(r.follows))
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  async function patch(id: string, p: Parameters<typeof patchFollow>[1]) {
    setFollows(prev => prev.map(f => (f.id === id ? { ...f, ...p } as VideoFollow : f)))
    await patchFollow(id, p).catch(() => {})
  }

  async function handleUnfollow(f: VideoFollow) {
    setFollows(prev => prev.filter(x => x.id !== f.id))
    await removeFollow(f.id).catch(() => {})
  }

  return (
    <div className="space-y-2">
      <p className="text-overline text-muted-foreground">Followed creators</p>
      <p className="text-[11px] text-muted-foreground/70 -mt-1">
        Creators you follow on TikTok, Vimeo, and Reddit. Auto-save downloads their new
        uploads offline (and into your Plex library, if provisioned), keeping the latest N.
      </p>
      {loading ? (
        <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : follows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No followed creators yet - follow one from any TikTok/Vimeo/Reddit creator page.
        </p>
      ) : (
        <div className="space-y-2">
          {follows.map(f => {
            const meta = SOURCE_META[f.source]
            return (
              <div key={f.id} className="rounded-card border border-border/50 bg-background/50 px-3 py-2">
                <div className="flex items-center gap-3">
                  {f.thumbnailUrl
                    ? <img src={f.thumbnailUrl} alt={f.title} referrerPolicy="no-referrer" className="size-8 shrink-0 rounded-full object-cover" />
                    : <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted"><Rss className="size-4 text-muted-foreground" /></div>}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{f.title || f.externalId}</p>
                    <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
                      <span className={`inline-block size-1.5 rounded-full ${meta?.dotClass ?? 'bg-muted-foreground'}`} />
                      {meta?.label ?? f.source} · {f.handle ?? f.externalId}
                    </p>
                  </div>
                  <label className="flex shrink-0 cursor-pointer items-center gap-1.5" title="Auto-save new uploads offline">
                    <Download className="size-3.5 text-muted-foreground" />
                    <Switch checked={f.autoSave} onCheckedChange={v => void patch(f.id, { autoSave: v })} />
                  </label>
                  <button onClick={() => setUnfollowTarget(f)} className="shrink-0 text-muted-foreground hover:text-destructive" aria-label="Unfollow">
                    <Trash2 className="size-4" />
                  </button>
                </div>
                {f.autoSave && (
                  <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border/40 pl-11 pt-2 text-xs text-muted-foreground">
                    <span>Save as</span>
                    <select value={f.autoSaveKind} onChange={e => void patch(f.id, { autoSaveKind: e.target.value as 'audio' | 'video' })}
                      className="rounded-control border border-border bg-background px-2 py-1 text-foreground">
                      <option value="video">Video</option>
                      <option value="audio">Audio</option>
                    </select>
                    <span>· keep latest</span>
                    <input type="number" min={0} value={f.autoSaveKeep ?? ''} placeholder="10"
                      onChange={e => void patch(f.id, { autoSaveKeep: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })}
                      className="w-16 rounded-control border border-border bg-background px-2 py-1 text-foreground" />
                    <span>videos (0 = all)</span>
                    <label className="flex cursor-pointer items-center gap-1.5" title="Delete auto-saved copies once fully watched">
                      <span>· remove once watched</span>
                      <Switch checked={f.removeWatched} onCheckedChange={v => void patch(f.id, { removeWatched: v })} />
                    </label>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      <ConfirmDialog
        open={!!unfollowTarget}
        onOpenChange={(open) => { if (!open) setUnfollowTarget(null) }}
        title="Unfollow creator?"
        description={`Stop following "${unfollowTarget?.title || unfollowTarget?.externalId}"? Auto-save stops; already-downloaded videos are kept.`}
        confirmLabel="Unfollow"
        onConfirm={() => unfollowTarget && void handleUnfollow(unfollowTarget)}
      />
    </div>
  )
}
