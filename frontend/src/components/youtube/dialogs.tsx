import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  Loader2, Plus, Trash2, UploadCloud, Music, Video as VideoIcon, Settings2, BookmarkPlus, BookmarkCheck, Rss,
  Download, PauseCircle,
} from 'lucide-react'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import { resLabel, fmtBytes } from '@/lib/youtube/format'
import * as yt from '@/lib/youtube/api'
import type { YtFormat, Subscription } from '@/lib/youtube/api'
import { useUnsubscribeConfirm } from '@/components/youtube/UnsubscribeDialog'

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
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Preparing your file…</div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted"><div className="h-full bg-red-600 transition-all" style={{ width: `${pct}%` }} /></div>
            <p className="text-xs text-muted-foreground">The file saves to your device automatically when ready.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {target?.savedKind && (
              <div className="space-y-1.5">
                <button onClick={() => { triggerBrowserDownload(yt.fileUrl(target.videoId, target.savedKind!)); onClose() }}
                  className="flex w-full items-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm font-medium text-emerald-500 hover:bg-emerald-500/20">
                  <BookmarkCheck className="size-4" /> Download saved {target.savedKind} copy
                </button>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">or fetch a fresh copy at any quality</p>
              </div>
            )}
            <div className="space-y-1.5">
              {CURATED.map(c => (
                <label key={c.key} className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
                  <input type="radio" name="fmt" checked={choice === c.key} onChange={() => setChoice(c.key)} />
                  {c.key.startsWith('audio') ? <Music className="size-3.5 text-muted-foreground" /> : c.key === 'advanced' ? <Settings2 className="size-3.5 text-muted-foreground" /> : <VideoIcon className="size-3.5 text-muted-foreground" />}
                  {c.label}
                </label>
              ))}
            </div>
            {choice === 'advanced' && (
              <div className="space-y-1.5">
                <input value={raw} onChange={e => setRaw(e.target.value)} placeholder="e.g. 137+140  or  bestvideo[height<=2160]+bestaudio"
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
                {formats === null ? <p className="text-xs text-muted-foreground">Loading available formats…</p>
                : formats.length > 0 ? (
                  <div className="max-h-40 overflow-auto rounded-md border border-border/50 text-[11px]">
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
                ) : <p className="text-xs text-muted-foreground">Couldn't list formats — your raw string still works.</p>}
              </div>
            )}
            <button onClick={start} className="w-full rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500">Download</button>
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
      else toast.success('Saving — find it under Offline')
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
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
              <input type="radio" name="save" checked={choice === `h:${t}`} onChange={() => setChoice(`h:${t}`)} />
              <VideoIcon className="size-3.5 text-muted-foreground" /> {resLabel(t)} video (MP4)
            </label>
          ))}
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
            <input type="radio" name="save" checked={choice === 'audio:m4a'} onChange={() => setChoice('audio:m4a')} />
            <Music className="size-3.5 text-muted-foreground" /> Audio only (M4A)
          </label>
          <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border/60 px-3 py-2 text-sm hover:bg-muted/50">
            <input type="radio" name="save" checked={choice === 'audio:mp3'} onChange={() => setChoice('audio:mp3')} />
            <Music className="size-3.5 text-muted-foreground" /> Audio only (MP3)
          </label>
        </div>
        {cap && <p className="text-[10px] text-muted-foreground/60">Max {resLabel(cap)} set by your admin.</p>}
        <button onClick={save} disabled={saving || !choice}
          className="flex w-full items-center justify-center gap-2 rounded-md bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50">
          {saving ? <Loader2 className="size-4 animate-spin" /> : <BookmarkPlus className="size-4" />} Save offline
        </button>
      </DialogContent>
    </Dialog>
  )
}

// ── Manage channels + save-quality preference ────────────────────────────────

export function ManageChannelsDialog({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged?: () => void }) {
  const { user } = useAuth()
  const [subs, setSubs] = useState<Subscription[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [tiers, setTiers] = useState<number[]>([])
  const [cap, setCap] = useState<number | null>(null)
  const [pref, setPref] = useState<number | null>(null)
  // Automation master switch + global keep-N default.
  const [paused, setPaused] = useState(false)
  const [keepDefault, setKeepDefault] = useState(10)
  const [isAdmin, setIsAdmin] = useState(false)
  const { ask: askUnsub, dialog: unsubDialog } = useUnsubscribeConfirm()

  async function load() { setSubs(await yt.getSubscriptions()) }

  useEffect(() => {
    if (!open) return
    setLoading(true)
    load().finally(() => setLoading(false))
    yt.getSaveQuality().then(d => { setTiers(d.tiers ?? []); setCap(d.cap); setPref(d.pref) }).catch(() => {})
    yt.getAutomation().then(a => { setPaused(a.paused); setKeepDefault(a.keepDefault); setIsAdmin(a.isAdmin) }).catch(() => {})
  }, [open])

  // Optimistically patch a subscription's automation settings.
  async function patchSub(id: string, patch: Partial<Pick<Subscription, 'autoSave' | 'autoSaveKind' | 'autoSaveKeep'>>) {
    setSubs(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s))
    await yt.updateSubscription(id, patch).catch(() => {})
    onChanged?.()
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
      setInput(''); await load(); onChanged?.()
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
        setSubs(prev => prev.filter(s => s.id !== id)); onChanged?.()
      },
    })
  }

  async function handleCsvImport(file: File) {
    setImporting(true); setError(null)
    try {
      const d = await yt.importSubscriptions(await file.text())
      if (d.error) { setError(d.error); return }
      await load(); onChanged?.()
    } finally { setImporting(false) }
  }

  async function savePref(value: number) {
    setPref(value)
    if (!user?.id) return
    await fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'youtube.save_quality': value }),
    }).catch(() => {})
  }

  return (
    <>
    <Dialog open={open} onOpenChange={o => { if (!o) onClose() }}>
      <DialogContent className="max-w-lg gap-4 p-4">
        <DialogHeader><DialogTitle className="text-sm font-semibold">Manage channels</DialogTitle></DialogHeader>
        <DialogDescription className="sr-only">Add or remove channels for this podcast.</DialogDescription>
        <div className="space-y-3">
          <div className="flex gap-2">
            <input type="text" value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
              placeholder="Paste @handle, channel URL, or playlist URL…"
              className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
            <button onClick={handleAdd} disabled={!input.trim() || adding}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-secondary px-3 py-2 text-sm font-medium hover:bg-secondary/80 disabled:opacity-50">
              {adding ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />} Add
            </button>
          </div>
          <button onClick={() => fileInputRef.current?.click()} disabled={importing}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground disabled:opacity-50">
            {importing ? <Loader2 className="size-3.5 animate-spin" /> : <UploadCloud className="size-3.5" />} Import from Google Takeout (subscriptions.csv)
          </button>
          <input ref={fileInputRef} type="file" accept=".csv,text/csv" className="hidden"
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleCsvImport(f) }} />
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <div className="max-h-64 overflow-auto">
          {loading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</div>
          ) : subs.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No subscriptions yet</p>
          ) : (
            <div className="space-y-2">
              {subs.map(sub => (
                <div key={sub.id} className="rounded-lg border border-border/60 bg-card px-3 py-2">
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
                        className="rounded-md border border-border bg-background px-2 py-1 text-foreground">
                        <option value="video">Video</option>
                        <option value="audio">Audio</option>
                      </select>
                      <span>· keep latest</span>
                      <input type="number" min={0} value={sub.autoSaveKeep ?? ''} placeholder={String(keepDefault)}
                        onChange={e => void patchSub(sub.id, { autoSaveKeep: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })}
                        className="w-16 rounded-md border border-border bg-background px-2 py-1 text-foreground" />
                      <span>videos</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {tiers.length > 0 && (
          <div className="border-t border-border/60 pt-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Save quality</p>
                <p className="text-xs text-muted-foreground">Resolution used when you Save videos offline{cap ? ` (max ${cap}p set by admin)` : ''}.</p>
              </div>
              <select value={pref ?? cap ?? 1080} onChange={e => savePref(Number(e.target.value))} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm">
                {tiers.filter(t => cap == null || t <= cap).map(t => <option key={t} value={t}>{t}p</option>)}
              </select>
            </div>
          </div>
        )}
        {/* Automation master switch — freezes auto-save + auto-podcast without losing per-channel settings. */}
        <div className="border-t border-border/60 pt-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium"><PauseCircle className="size-3.5" /> Pause automation</p>
              <p className="text-xs text-muted-foreground">Stop auto-saving and auto-generating podcasts. Your per-channel settings are kept.</p>
            </div>
            <Switch checked={paused} onCheckedChange={v => void togglePause(v)} />
          </div>
          {isAdmin && (
            <div className="mt-3 flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Default videos kept per channel</p>
                <p className="text-xs text-muted-foreground">Rolling cap on auto-saved videos when a channel has no override.</p>
              </div>
              <input type="number" min={1} value={keepDefault}
                onChange={e => { const n = Math.max(1, Math.floor(Number(e.target.value) || 1)); setKeepDefault(n) }}
                onBlur={e => void saveKeepDefault(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                className="w-20 rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
    {unsubDialog}
    </>
  )
}
