import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Bookmark, FileText, Video, Music, Clock, Check, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { detectSaveTarget } from '@/lib/saveTarget'
import { createItem } from '@/lib/bookmarks/api'
import { useAuth } from '@/context/AuthContext'

// Capture dispatcher opened by the bookmarklet / PWA share target as a same-origin
// popup, so the session cookie is sent (SameSite=Strict allows top-level navigation).
// It dispatches the captured URL to the right app's existing endpoints.

const opts: RequestInit = { credentials: 'include' }
const J = { 'Content-Type': 'application/json' }

function ActionButton({ icon: Icon, label, onClick, busy, done }: { icon: typeof Bookmark; label: string; onClick: () => void; busy?: boolean; done?: boolean }) {
  return (
    <Button
      variant="outline"
      onClick={onClick}
      disabled={busy || done}
      className={cn('h-auto w-full justify-start gap-3 rounded-control px-4 py-3 text-left text-sm font-medium',
        done && 'border-success/40 bg-success/10 text-success disabled:opacity-100')}
    >
      {done ? <Check className="size-5 shrink-0" /> : busy ? <Spinner className="size-5 shrink-0" /> : <Icon className="size-5 shrink-0" />}
      <span>{label}</span>
    </Button>
  )
}

export function SavePage() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [params] = useSearchParams()
  const rawUrl = params.get('url') ?? ''
  const [title, setTitle] = useState(params.get('title') ?? '')
  const [makeGlobal, setMakeGlobal] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const target = detectSaveTarget(rawUrl)

  useEffect(() => { document.title = 'Save to MaiPai' }, [])

  function closeSoon() { setTimeout(() => { try { window.close() } catch { /* not script-opened */ } }, 800) }

  async function run(key: string, fn: () => Promise<void>, successMsg: string) {
    setBusy(key)
    try { await fn(); setDone(key); toast.success(successMsg); closeSoon() }
    catch (e) { toast.error(e instanceof Error ? e.message : 'Failed to save') }
    finally { setBusy(null) }
  }

  async function ytSave(kind: 'audio' | 'video') {
    if (target.type !== 'youtube') return
    const res = await fetch('/api/youtube/save', { ...opts, method: 'POST', headers: J, body: JSON.stringify({ videoId: target.videoId, kind, title }) })
    if (!res.ok) throw new Error('YouTube save failed')
  }
  async function ytWatchLater() {
    if (target.type !== 'youtube') return
    const res = await fetch(`/api/youtube/collections/watch-later/${target.videoId}`, { ...opts, method: 'PUT', headers: J, body: JSON.stringify({ title }) })
    if (!res.ok) throw new Error('Failed to add to Watch Later')
  }
  async function saveReader(type: 'live' | 'offline') {
    await createItem({ type, url: rawUrl, title: title.trim() || undefined, makeGlobal: isAdmin && makeGlobal })
  }
  async function hubSave() {
    if (target.type !== 'video') return
    const res = await fetch(`/api/videos/${target.source}/save`, { ...opts, method: 'POST', headers: J, body: JSON.stringify({ videoId: target.videoId, kind: 'video' }) })
    if (!res.ok) throw new Error('Save failed')
  }

  if (!rawUrl) {
    return <div className="flex min-h-screen items-center justify-center bg-background p-6 text-muted-foreground">No URL to save.</div>
  }

  return (
    <div className="min-h-screen bg-background pb-8">
      <PageContainer width="narrow" className="max-w-md">
        <PageHeader title="Save to MaiPai" className="pt-6 pb-4" />
        <a href={rawUrl} target="_blank" rel="noopener noreferrer" className="mb-4 flex items-center gap-1 truncate text-xs text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3 shrink-0" /><span className="truncate">{rawUrl}</span>
        </a>

        <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Title" className="mb-4" />

        {isAdmin && (
          <label className="mb-4 flex items-start gap-2 rounded-control border border-border bg-card/50 p-3 text-sm">
            <input type="checkbox" checked={makeGlobal} onChange={e => setMakeGlobal(e.target.checked)} className="mt-0.5 size-4 rounded border-border" />
            <span>
              <span className="font-medium">Share with everyone</span>
              <span className="block text-xs text-muted-foreground">Saves as a global bookmark visible to all users. Off = only you can see it.</span>
            </span>
          </label>
        )}

        <div className="space-y-2">
          {target.type === 'youtube' ? (
            <>
              <ActionButton icon={Video} label="Save offline (video)" busy={busy === 'v'} done={done === 'v'} onClick={() => run('v', () => ytSave('video'), 'Saving video offline…')} />
              <ActionButton icon={Music} label="Save offline (audio)" busy={busy === 'a'} done={done === 'a'} onClick={() => run('a', () => ytSave('audio'), 'Saving audio offline…')} />
              <ActionButton icon={Clock} label="Watch later" busy={busy === 'wl'} done={done === 'wl'} onClick={() => run('wl', ytWatchLater, 'Added to Watch Later')} />
              <ActionButton icon={Bookmark} label="Add as bookmark" busy={busy === 'b'} done={done === 'b'} onClick={() => run('b', () => saveReader('live'), 'Bookmarked')} />
            </>
          ) : target.type === 'video' ? (
            <>
              <ActionButton icon={Video} label="Save offline (video)" busy={busy === 'v'} done={done === 'v'} onClick={() => run('v', hubSave, 'Saving video offline…')} />
              <ActionButton icon={Bookmark} label="Add as bookmark" busy={busy === 'b'} done={done === 'b'} onClick={() => run('b', () => saveReader('live'), 'Bookmarked')} />
            </>
          ) : (
            <>
              <ActionButton icon={FileText} label="Save to read later (offline)" busy={busy === 'off'} done={done === 'off'} onClick={() => run('off', () => saveReader('offline'), 'Saving article…')} />
              <ActionButton icon={Bookmark} label="Add bookmark (live link)" busy={busy === 'live'} done={done === 'live'} onClick={() => run('live', () => saveReader('live'), 'Bookmarked')} />
            </>
          )}
        </div>
      </PageContainer>
    </div>
  )
}
