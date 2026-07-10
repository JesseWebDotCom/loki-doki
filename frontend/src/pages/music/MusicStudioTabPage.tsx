// Studio "Tab" sub-tab: find (or upload) a Guitar Pro / MusicXML tab and follow it in sync
// with playback. Full fret-accurate tab data can't be reliably auto-transcribed from audio, so
// tabs come from the online search (GProTab imports) or the user's own files. Discovery is the
// front door: with no tab yet, the search IS the page (auto-run, results visible immediately)
// and upload is the secondary path; with a tab loaded, the viewer leads and search stays one
// visible "Find tabs" click away in the action row rather than buried below the score.
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Upload, Trash2, Guitar, Search } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { listStudioTabs, uploadStudioTab, saveTabAlign, deleteStudioTab, type StudioTab } from '@/lib/music/studioApi'
import { useStudioEngine } from '@/context/MusicStudioEngineContext'
import { TabWebSearch } from '@/components/music/studio/TabWebSearch'

const AlphaTabView = lazy(() => import('@/components/music/studio/AlphaTabView').then((m) => ({ default: m.AlphaTabView })))

const TAB_ACCEPT = '.gp,.gp3,.gp4,.gp5,.gpx,.musicxml,.xml'

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function TabUploadButton({ trackId, onUploaded, variant = 'default', size = 'default', label = 'Import tab file' }: {
  trackId: string; onUploaded: () => void
  variant?: 'default' | 'outline' | 'ghost'; size?: 'default' | 'sm'; label?: string
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      await uploadStudioTab(trackId, file, { title: file.name.replace(/\.[^.]+$/, '') })
      toast.success('Tab added')
      onUploaded()
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not add that tab') }
    finally { setUploading(false) }
  }

  return (
    <>
      <input ref={fileRef} type="file" accept={TAB_ACCEPT} className="hidden" onChange={(e) => void onFile(e)} />
      <Button variant={variant} size={size} onClick={() => fileRef.current?.click()} disabled={uploading}>
        {uploading ? <Spinner className="text-current" /> : <Upload className={size === 'sm' ? 'size-3.5' : 'size-4'} />} {label}
      </Button>
    </>
  )
}

function AlignControls({ trackId, tab, engine, onSaved }: {
  trackId: string; tab: StudioTab; engine: ReturnType<typeof useStudioEngine>['engine']; onSaved: () => void
}) {
  const [startSec, setStartSec] = useState(tab.align?.startSec ?? 0)
  const [endSec, setEndSec] = useState(tab.align?.endSec ?? (engine.getDuration() || 0))
  const [saving, setSaving] = useState(false)

  useEffect(() => { setStartSec(tab.align?.startSec ?? 0); setEndSec(tab.align?.endSec ?? (engine.getDuration() || 0)) }, [tab.id, tab.align, engine])

  async function save(next: { startSec: number; endSec: number }) {
    if (!(next.endSec > next.startSec)) { toast.error('End must be after start'); return }
    setSaving(true)
    try { await saveTabAlign(trackId, tab.id, next); onSaved() }
    catch { toast.error('Could not save sync points') }
    finally { setSaving(false) }
  }

  return (
    <Card>
      <CardHeader className="p-3 pb-1"><CardTitle className="text-sm text-muted-foreground">Sync this tab to the recording</CardTitle></CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 p-3 pt-1 text-sm">
        <span className="text-muted-foreground">Tab starts at</span>
        <span className="font-semibold tabular-nums">{fmt(startSec)}</span>
        <Button size="sm" variant="outline" disabled={saving}
          onClick={() => { const t = engine.getPosition(); setStartSec(t); void save({ startSec: t, endSec }) }}>
          Set to current
        </Button>
        <span className="ml-4 text-muted-foreground">Tab ends at</span>
        <span className="font-semibold tabular-nums">{fmt(endSec)}</span>
        <Button size="sm" variant="outline" disabled={saving}
          onClick={() => { const t = engine.getPosition(); setEndSec(t); void save({ startSec, endSec: t }) }}>
          Set to current
        </Button>
        {saving && <Spinner className="size-3.5" />}
      </CardContent>
    </Card>
  )
}

export function MusicStudioTabPage() {
  const { trackId, track, engine } = useStudioEngine()
  const qc = useQueryClient()
  const [activeId, setActiveId] = useState<string | null>(null)
  // "Find tabs" toggle for the with-tab layout. Latched once opened so re-collapsing keeps the
  // fetched results mounted (toggling shouldn't refire the multi-engine search).
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchEverOpened, setSearchEverOpened] = useState(false)

  const { data: tabs = [] } = useQuery({ queryKey: ['studio-tabs', trackId], queryFn: () => listStudioTabs(trackId) })
  const invalidate = () => qc.invalidateQueries({ queryKey: ['studio-tabs', trackId] })
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0] ?? null

  async function onDelete(tabId: string) {
    try { await deleteStudioTab(trackId, tabId); toast.success('Tab removed'); await invalidate() }
    catch { toast.error('Could not remove tab') }
  }

  function toggleSearch() {
    setSearchOpen((o) => !o)
    setSearchEverOpened(true)
  }

  if (!track) return null

  if (tabs.length === 0) {
    // No tab yet → finding one IS the page: the search auto-runs with the song pre-filled, so
    // importable results are visible without any digging. Uploading a file is the alternate path.
    return (
      <div className="space-y-3">
        <div className="flex items-start gap-3 px-1">
          <div className="grid size-10 shrink-0 place-items-center rounded-card bg-brand/15">
            <Guitar className="size-5 text-brand" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Follow a tab in sync with playback</p>
            <p className="text-sm text-muted-foreground">Import a tab below and it scrolls with the stems - mute or slow down any instrument to practice along.</p>
          </div>
        </div>

        <TabWebSearch trackId={trackId} artist={track.artist} title={track.title} />

        <Card variant="dashed">
          <CardContent className="flex flex-wrap items-center justify-center gap-3 py-4 text-sm text-muted-foreground">
            Already have a Guitar Pro or MusicXML file?
            <TabUploadButton trackId={trackId} onUploaded={invalidate} variant="outline" size="sm" />
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {tabs.length > 1 ? (
          tabs.map((t) => (
            <Button key={t.id} size="sm" variant={t.id === active?.id ? 'default' : 'outline'} onClick={() => setActiveId(t.id)}>
              {t.title}{t.instrument ? ` · ${t.instrument}` : ''}
            </Button>
          ))
        ) : active && (
          <p className="truncate text-sm font-semibold">{active.title}{active.instrument ? ` · ${active.instrument}` : ''}</p>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button variant="outline" size="sm" onClick={toggleSearch} className={cn(searchOpen && 'bg-accent text-foreground')}>
            <Search className="size-3.5" /> Find tabs
          </Button>
          <TabUploadButton trackId={trackId} onUploaded={invalidate} variant="outline" size="sm" label="Import file" />
          {active && (
            <Button variant="ghost" size="icon-sm" onClick={() => void onDelete(active.id)} aria-label="Remove tab" className="text-muted-foreground hover:text-destructive">
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {searchEverOpened && (
        <div className={cn(!searchOpen && 'hidden')}>
          <TabWebSearch trackId={trackId} artist={track.artist} title={track.title} />
        </div>
      )}

      {active && (
        <>
          {active.status === 'failed' ? (
            <p className="text-sm text-destructive">{active.tabError ?? 'Could not read this tab file.'}</p>
          ) : (
            <Suspense fallback={<div className="flex justify-center py-16"><Spinner size="lg" /></div>}>
              <AlphaTabView fileUrl={active.fileUrl} engine={engine} align={active.align}
                // Lock the tab to THIS recording's measured beat grid (like lyrics lock to
                // measured line times) - written tempo rarely matches the real take.
                autoSync={{ bpm: track.bpm, beats: track.beats }} />
            </Suspense>
          )}

          <AlignControls trackId={trackId} tab={active} engine={engine} onSaved={invalidate} />
        </>
      )}
    </div>
  )
}
