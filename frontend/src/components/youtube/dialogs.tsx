import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  Music, Video as VideoIcon, Settings2, BookmarkCheck, HardDriveDownload,
} from 'lucide-react'
import { toast } from '@/lib/toast'
import { resLabel, fmtBytes } from '@/lib/youtube/format'
import * as yt from '@/lib/youtube/api'
import type { YtFormat } from '@/lib/youtube/api'

// ── Download (to device) ─────────────────────────────────────────────────────

export interface DownloadTarget { videoId: string; title: string; savedKind?: 'audio' | 'video' }

const CURATED: { key: string; label: string; body: { format?: string; audioFormat?: string } | null }[] = [
  { key: 'best-mp4',  label: 'Best quality (MP4)', body: { format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best' } },
  { key: '1080',      label: '1080p (MP4)',        body: { format: 'bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080]' } },
  { key: '720',       label: '720p (MP4)',         body: { format: 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]' } },
  { key: 'audio-m4a', label: 'Audio only (M4A)',   body: { audioFormat: 'm4a' } },
  { key: 'audio-mp3', label: 'Audio only (MP3)',   body: { audioFormat: 'mp3' } },
  { key: 'advanced',  label: 'Advanced: raw yt-dlp format…', body: null },
]

function triggerBrowserDownload(href: string) {
  const a = document.createElement('a')
  a.href = href; a.download = ''
  document.body.appendChild(a); a.click(); a.remove()
}

export function DownloadDialog({ target, onClose }: { target: DownloadTarget | null; onClose: () => void }) {
  const [choice, setChoice] = useState('best-mp4')
  const [raw, setRaw] = useState('')
  const [formats, setFormats] = useState<YtFormat[] | null>(null)
  const [phase, setPhase] = useState<'idle' | 'working' | 'failed'>('idle')
  const [pct, setPct] = useState(0)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    setChoice('best-mp4'); setRaw(''); setFormats(null); setPhase('idle'); setPct(0)
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    if (!target) return
    yt.getFormats(target.videoId).then(setFormats).catch(() => setFormats([]))
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [target?.videoId])

  async function start() {
    if (!target) return
    if (choice === 'advanced' && !raw.trim()) { toast.error('Enter a yt-dlp format'); return }
    const body = choice === 'advanced' ? { format: raw.trim() } : CURATED.find(c => c.key === choice)!.body!
    setPhase('working'); setPct(0)
    try {
      const d = await yt.startExport({ videoId: target.videoId, title: target.title, ...body })
      if (!d.jobId) { toast.error(d.error ?? 'Could not start download'); setPhase('failed'); return }
      const jobId = d.jobId
      pollRef.current = setInterval(async () => {
        const pr = await yt.getExport(jobId).catch(() => null)
        if (!pr) return
        if (pr.progress) setPct(Math.round(pr.progress.completed))
        if (pr.state === 'ready') {
          if (pollRef.current) clearInterval(pollRef.current)
          triggerBrowserDownload(yt.exportFileUrl(jobId))
          toast.success('Download ready'); onClose()
        } else if (pr.state === 'failed') {
          if (pollRef.current) clearInterval(pollRef.current)
          setPhase('failed'); toast.error('Download failed')
        }
      }, 1500)
    } catch { setPhase('failed'); toast.error('Could not start download') }
  }

  return (
    <Dialog open={!!target} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-md gap-3 p-4">
        <DialogHeader><DialogTitle className="pr-8 text-sm font-semibold leading-snug">Download to this device</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Choose download quality and options.</DialogDescription>
        <p className="line-clamp-2 text-xs text-muted-foreground">{target?.title}</p>
        {phase === 'working' ? (
          <div className="space-y-3 py-2">
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner /> Preparing your file…</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} /></div>
            <p className="text-xs text-muted-foreground">The file saves to your device automatically when ready.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {target?.savedKind && (
              <div className="space-y-1.5">
                <Button variant="outline" onClick={() => { triggerBrowserDownload(yt.fileUrl(target.videoId, target.savedKind!)); onClose() }}
                  className="w-full justify-start gap-2 border-success/40 bg-success/10 text-success hover:bg-success/15 hover:text-success">
                  <BookmarkCheck className="size-4" /> Download saved {target.savedKind} copy
                </Button>
                <p className="text-overline text-muted-foreground/60">or fetch a fresh copy at any quality</p>
              </div>
            )}
            <div className="space-y-1.5">
              {CURATED.map(c => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-control border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
                  <input type="radio" name="fmt" checked={choice === c.key} onChange={() => setChoice(c.key)} />
                  {c.key.startsWith('audio') ? <Music className="size-3.5 text-muted-foreground" /> : c.key === 'advanced' ? <Settings2 className="size-3.5 text-muted-foreground" /> : <VideoIcon className="size-3.5 text-muted-foreground" />}
                  {c.label}
                </label>
              ))}
            </div>
            {choice === 'advanced' && (
              <div className="space-y-1.5">
                <input value={raw} onChange={e => setRaw(e.target.value)} placeholder="e.g. 137+140  or  bestvideo[height<=2160]+bestaudio"
                  className="w-full rounded-control border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                {formats === null ? <p className="text-xs text-muted-foreground">Loading available formats…</p>
                : formats.length > 0 ? (
                  <div className="max-h-40 overflow-auto rounded-control border border-border/50 text-[11px]">
                    <table className="w-full"><tbody>
                      {formats.map(f => (
                        <tr key={f.formatId} className="cursor-pointer border-b border-border/30 last:border-0 hover:bg-muted/40" onClick={() => setRaw(f.formatId)}>
                          <td className="px-2 py-1 font-mono">{f.formatId}</td><td className="px-2 py-1">{f.ext}</td>
                          <td className="px-2 py-1">{f.resolution}</td><td className="px-2 py-1 text-muted-foreground">{f.note}</td>
                          <td className="px-2 py-1 text-right text-muted-foreground">{f.filesize ? fmtBytes(f.filesize) : ''}</td>
                        </tr>
                      ))}
                    </tbody></table>
                  </div>
                ) : <p className="text-xs text-muted-foreground">Couldn't list formats, but your raw string still works.</p>}
              </div>
            )}
            <Button onClick={start} className="w-full font-semibold">Download</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// ── Save offline ─────────────────────────────────────────────────────────────

export interface SaveTarget { videoId: string; title: string }

export function SaveDialog({ target, onClose, onSaved }: { target: SaveTarget | null; onClose: () => void; onSaved?: () => void }) {
  const [tiers, setTiers] = useState<number[]>([])
  const [cap, setCap] = useState<number | null>(null)
  const [choice, setChoice] = useState<string>('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setChoice(''); setTiers([]); setCap(null)
    if (!target) return
    yt.getSaveQuality().then(d => { setTiers(d.tiers ?? []); setCap(d.cap); setChoice(`h:${d.pref ?? d.cap}`) }).catch(() => {})
  }, [target?.videoId])

  async function save() {
    if (!target || !choice) return
    setSaving(true)
    const isAudio = choice.startsWith('audio')
    const kind = isAudio ? 'audio' : 'video'
    const audioFormat = choice === 'audio:mp3' ? 'mp3' : isAudio ? 'm4a' : undefined
    const maxHeight = isAudio ? undefined : Number(choice.slice(2))
    try {
      const d = await yt.saveOffline({ videoId: target.videoId, title: target.title, kind, maxHeight, audioFormat })
      if (d.error) { toast.error(d.error); return }
      if (d.status === 'already-saved') toast.success('Already in your Offline library')
      else if (d.status === 'in-progress') toast.info('Already saving…')
      else toast.success('Saving. Find it under Offline')
      onSaved?.(); onClose()
    } catch { toast.error('Could not save') } finally { setSaving(false) }
  }

  const videoTiers = tiers.filter(t => cap == null || t <= cap).slice().reverse()
  return (
    <Dialog open={!!target} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-md gap-3 p-4">
        <DialogHeader><DialogTitle className="pr-8 text-sm font-semibold leading-snug">Save offline</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Save this video for offline viewing.</DialogDescription>
        <p className="line-clamp-2 text-xs text-muted-foreground">{target?.title}</p>
        <div className="space-y-1.5">
          {videoTiers.map(t => (
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded-control border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
              <input type="radio" name="save" checked={choice === `h:${t}`} onChange={() => setChoice(`h:${t}`)} />
              <VideoIcon className="size-3.5 text-muted-foreground" /> {resLabel(t)} video (MP4)
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2 rounded-control border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
            <input type="radio" name="save" checked={choice === 'audio:m4a'} onChange={() => setChoice('audio:m4a')} />
            <Music className="size-3.5 text-muted-foreground" /> Audio only (M4A)
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-control border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
            <input type="radio" name="save" checked={choice === 'audio:mp3'} onChange={() => setChoice('audio:mp3')} />
            <Music className="size-3.5 text-muted-foreground" /> Audio only (MP3)
          </label>
        </div>
        {cap && <p className="text-[10px] text-muted-foreground/60">Max {resLabel(cap)} set by your admin.</p>}
        <Button onClick={save} disabled={saving || !choice} className="w-full font-semibold">
          {saving ? <Spinner className="text-primary-foreground" /> : <HardDriveDownload className="size-4" />} Save offline
        </Button>
      </DialogContent>
    </Dialog>
  )
}
