import { useCallback, useEffect, useRef, useState } from 'react'
import { Images, Link2, Pause, Play, Plus, SkipBack, SkipForward, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { useAuth } from '@/context/AuthContext'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'

// Photo Frame: an ambient slideshow of public iCloud Shared Albums. The whole
// feature rides the zero-credential share link (no Apple account, no password,
// unaffected by Advanced Data Protection), the cheapest win in the iCloud
// program. Photo URLs are short-lived CDN links, so the app refetches the list
// on mount rather than caching them.

interface FramePhoto {
  guid: string
  url: string
  width: number
  height: number
  caption: string | null
  album: string
}

interface FrameAlbum { token: string; name: string }

const ADVANCE_MS = 8000

function shuffle<T>(list: T[]): T[] {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function AlbumManager({ albums, onChanged }: { albums: FrameAlbum[]; onChanged: () => void }) {
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)

  async function add() {
    if (!link.trim()) return
    setBusy(true)
    try {
      const r = await fetch('/api/icloud/shared-albums', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ link }),
      })
      const body = await r.json().catch(() => null) as { album?: FrameAlbum; photoCount?: number; error?: string } | null
      if (!r.ok) toast.error(body?.error ?? 'Could not add the album')
      else {
        toast.success(`Added "${body?.album?.name}" (${body?.photoCount ?? 0} photos)`)
        setLink('')
        onChanged()
      }
    } catch { toast.error('Could not add the album') }
    setBusy(false)
  }

  async function remove(token: string) {
    await fetch(`/api/icloud/shared-albums/${token}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
    onChanged()
  }

  return (
    <div className="space-y-3">
      {albums.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {albums.map((a) => (
            <span key={a.token} className="inline-flex items-center gap-1.5 rounded-full bg-foreground/8 px-3 py-1 text-xs">
              {a.name}
              <button onClick={() => void remove(a.token)} aria-label={`Remove ${a.name}`}
                className="text-muted-foreground hover:text-foreground"><Trash2 className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Input value={link} placeholder="Paste an iCloud shared-album link" className="w-80"
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void add() }} />
        <Button variant="outline" onClick={add} disabled={busy || !link.trim()}>
          {busy ? <Spinner className="size-4" /> : <Plus className="size-4" />}Add album
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        On an iPhone: open the album in Photos, tap the album name, turn on <strong>Public Website</strong>,
        and paste the link here. Only albums shared this way are visible; no Apple sign-in involved.
      </p>
    </div>
  )
}

export function FramePage() {
  useAppHeader({ query: '', setQuery: () => {}, searchable: false })
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [albums, setAlbums] = useState<FrameAlbum[] | null>(null)
  const [photos, setPhotos] = useState<FramePhoto[] | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'disabled' | 'error'>('loading')
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [showManager, setShowManager] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async () => {
    try {
      const [albumsRes, photosRes] = await Promise.all([
        fetch('/api/icloud/shared-albums', { credentials: 'include' }),
        fetch('/api/icloud/shared-albums/photos', { credentials: 'include' }),
      ])
      if (albumsRes.status === 403) { setState('disabled'); return }
      const albumsBody = await albumsRes.json() as { albums: FrameAlbum[] }
      const photosBody = await photosRes.json() as { photos: FramePhoto[] }
      setAlbums(albumsBody.albums)
      setPhotos(shuffle(photosBody.photos))
      setIndex(0)
      setState('ready')
    } catch { setState('error') }
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (timer.current) clearInterval(timer.current)
    if (!paused && photos && photos.length > 1) {
      timer.current = setInterval(() => setIndex((i) => (i + 1) % photos.length), ADVANCE_MS)
    }
    return () => { if (timer.current) clearInterval(timer.current) }
  }, [paused, photos])

  const current = photos?.[index] ?? null
  const next = photos && photos.length > 1 ? photos[(index + 1) % photos.length] : null

  return (
    <PageShell>
      <PageContainer width="wide" className="py-2 pb-8">
        <PageHeader subtitle="Shared iCloud albums as an ambient family frame." />

        {state === 'disabled' ? (
          <div className="rounded-card border border-border/40 p-6 text-sm text-muted-foreground">
            <p className="mb-2 font-medium text-foreground/85">Photo Frame is turned off.</p>
            <p>
              {isAdmin
                ? <>Turn it on in <Link to="/admin/features" className="underline underline-offset-2">Admin → Features</Link>, then add a shared-album link here.</>
                : 'Ask a household admin to turn on Photo Frame in Admin.'}
            </p>
          </div>
        ) : state === 'error' ? (
          <p className="py-8 text-sm text-muted-foreground">Could not load the frame. Try again in a moment.</p>
        ) : state === 'loading' || !photos || !albums ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : photos.length === 0 ? (
          <div className="rounded-card border border-border/40 p-6 text-sm text-muted-foreground">
            <p className="mb-2 flex items-center gap-2 font-medium text-foreground/85">
              <Images className="size-4" />No albums yet
            </p>
            {isAdmin
              ? <AlbumManager albums={albums} onChanged={() => void load()} />
              : <p>Once an admin adds a shared album, family photos rotate here.</p>}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="relative overflow-hidden rounded-card bg-black" style={{ height: 'min(72vh, 860px)' }}>
              {current && (
                <img key={current.guid} src={current.url} alt={current.caption ?? 'Family photo'}
                  className="absolute inset-0 size-full object-contain" />
              )}
              {/* Preload the next slide so advances never flash empty. */}
              {next && <img src={next.url} alt="" className="hidden" />}
              {(current?.caption || current?.album) && (
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-4 pt-10">
                  {current.caption && <p className="text-sm font-medium text-white/90">{current.caption}</p>}
                  <p className="text-xs text-white/60">{current.album}</p>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" aria-label="Previous photo"
                  onClick={() => setIndex((i) => (i - 1 + photos.length) % photos.length)}>
                  <SkipBack className="size-4" />
                </Button>
                <Button variant="ghost" size="icon" aria-label={paused ? 'Play' : 'Pause'} onClick={() => setPaused(!paused)}>
                  {paused ? <Play className="size-4" /> : <Pause className="size-4" />}
                </Button>
                <Button variant="ghost" size="icon" aria-label="Next photo"
                  onClick={() => setIndex((i) => (i + 1) % photos.length)}>
                  <SkipForward className="size-4" />
                </Button>
                <span className="ml-2 text-xs tabular-nums text-muted-foreground">
                  {index + 1} / {photos.length}
                </span>
              </div>
              {isAdmin && (
                <Button variant="ghost" size="sm" onClick={() => setShowManager(!showManager)}>
                  <Link2 className="size-4" />Albums
                </Button>
              )}
            </div>

            {isAdmin && showManager && (
              <div className={cn('rounded-card border border-border/40 p-4')}>
                <AlbumManager albums={albums} onChanged={() => void load()} />
              </div>
            )}
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}
