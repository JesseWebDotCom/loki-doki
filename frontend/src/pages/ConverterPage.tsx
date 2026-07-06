import { useEffect, useRef, useState, useCallback } from 'react'
import { UploadCloud, Download, X, ArrowRight, CheckCircle2, AlertCircle, Image as ImageIcon, Music2, Film } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { useAppHeader } from '@/context/BreadcrumbSearchContext'
import { cn } from '@/lib/cn'
import {
  getCapabilities, getRecent, startConversion, cancelConversion, downloadArtifact,
  extOf, familyOf, familyLabel, humanBytes, isLossy,
  type Capabilities, type ConversionRow, type MediaFamily,
} from '@/lib/converter/api'

const FAMILY_ICON: Record<MediaFamily, typeof ImageIcon> = { image: ImageIcon, audio: Music2, video: Film }

type Phase = 'idle' | 'starting' | 'running' | 'done' | 'error'

export function ConverterPage() {
  const [caps, setCaps] = useState<Capabilities | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [target, setTarget] = useState<string>('')
  const [quality, setQuality] = useState(90)
  const [phase, setPhase] = useState<Phase>('idle')
  const [statusText, setStatusText] = useState('')
  const [error, setError] = useState('')
  const [downloadErr, setDownloadErr] = useState('')
  const [resultId, setResultId] = useState('')
  const [resultName, setResultName] = useState('')
  const [recent, setRecent] = useState<ConversionRow[]>([])
  const [dragging, setDragging] = useState(false)

  const jobRef = useRef<string>('')
  const esRef = useRef<EventSource | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  usePublishUIContext({
    label: 'File Converter',
    description: 'User is converting a file between formats on the Converter page.',
  })

  useAppHeader({ query: '', setQuery: () => {}, searchable: false, settingsHref: '/apps/converter/settings' })

  useEffect(() => {
    getCapabilities().then(setCaps).catch(() => setError('Could not load converter capabilities.'))
    refreshRecent()
    return () => { esRef.current?.close() }
  }, [])

  // Build (and tear down) an object-URL preview whenever the selected file changes.
  useEffect(() => {
    if (!file) { setPreviewUrl(null); return }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [file])

  function refreshRecent() {
    getRecent().then(setRecent).catch(() => {})
  }

  const srcExt = file ? extOf(file.name) : ''
  const family: MediaFamily | null = file && caps ? familyOf(srcExt, caps) : null
  // Hide the input format itself, and the jpg/jpeg alias of it, from the target list.
  const alias = srcExt === 'jpg' ? 'jpeg' : srcExt === 'jpeg' ? 'jpg' : ''
  const outputs = family && caps
    ? caps.families[family].outputs.filter((o) => o !== srcExt && o !== alias)
    : []

  const pickFile = useCallback((f: File | null) => {
    esRef.current?.close()
    setFile(f)
    setTarget('')
    setPhase('idle')
    setError('')
    setDownloadErr('')
    setStatusText('')
    setResultId('')
  }, [])

  function onDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const f = e.dataTransfer.files?.[0]
    if (f) pickFile(f)
  }

  async function handleConvert() {
    if (!file || !target) return
    setPhase('starting')
    setError('')
    setDownloadErr('')
    setStatusText('Uploading…')
    try {
      const { jobId } = await startConversion(file, target, isLossy(target) ? quality : undefined)
      jobRef.current = jobId
      setPhase('running')
      setStatusText('Queued…')

      const es = new EventSource(`/api/converter/stream/${jobId}`, { withCredentials: true })
      esRef.current = es
      es.addEventListener('queue', (ev) => {
        const d = JSON.parse((ev as MessageEvent).data)
        setStatusText(d.position > 0 ? `Queued (position ${d.position})…` : 'Converting…')
      })
      es.addEventListener('start', () => setStatusText('Converting…'))
      es.addEventListener('done', (ev) => {
        const d = JSON.parse((ev as MessageEvent).data)
        setResultId(d.conversionId)
        setResultName(d.outputName)
        setPhase('done')
        es.close()
        refreshRecent()
      })
      es.addEventListener('error', (ev) => {
        const data = (ev as MessageEvent).data
        if (data) {
          try { setError(JSON.parse(data).error ?? 'Conversion failed') } catch { setError('Conversion failed') }
          setPhase('error')
          es.close()
          refreshRecent()
        }
      })
      es.addEventListener('cancelled', () => { setPhase('idle'); setStatusText(''); es.close() })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed to start')
      setPhase('error')
    }
  }

  function handleCancel() {
    if (jobRef.current) cancelConversion(jobRef.current)
    esRef.current?.close()
    setPhase('idle')
    setStatusText('')
  }

  async function handleDownload(id: string, name: string) {
    setDownloadErr('')
    try {
      await downloadArtifact(id, name)
    } catch (err) {
      setDownloadErr(err instanceof Error ? err.message : 'Download failed')
    }
  }

  const busy = phase === 'starting' || phase === 'running'

  return (
    <PageShell>
      <PageContainer className="pb-10">
        <PageHeader subtitle="Convert images, audio, and video between formats locally. No upload needed." />

        <div className="space-y-5">
          {/* Dropzone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
            className={cn(
              'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed p-8 text-center transition-colors',
              dragging ? 'border-brand bg-brand/10' : 'border-border/60 bg-card hover:bg-foreground/5',
            )}
          >
            <UploadCloud className="size-8 text-muted-foreground" />
            {file ? (
              <div className="text-sm">
                <span className="font-semibold text-foreground">{file.name}</span>
                <span className="text-muted-foreground"> · {humanBytes(file.size)}</span>
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">Drop a file here, or click to browse</div>
            )}
            <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
          </div>

          {/* Format selection + preview */}
          {file && (
            <Card className="p-5">
              {!family ? (
                <div className="flex items-center gap-2 text-sm text-warning">
                  <AlertCircle className="size-4" />
                  Unsupported file type (.{srcExt || '?'}). Try an image, audio, or video file.
                </div>
              ) : (
                <>
                  {/* Preview */}
                  {previewUrl && (
                    <div className="mb-4 flex justify-center rounded-card bg-foreground/5 p-3">
                      {family === 'image' && (
                        <img src={previewUrl} alt={file.name} className="max-h-56 max-w-full rounded-control object-contain" />
                      )}
                      {family === 'audio' && (
                        <audio controls src={previewUrl} className="w-full max-w-md" />
                      )}
                      {family === 'video' && (
                        <video controls src={previewUrl} className="max-h-56 max-w-full rounded-control" />
                      )}
                    </div>
                  )}

                  <div className="mb-3 flex items-center gap-2 text-overline text-muted-foreground">
                    <span className="rounded-full bg-foreground/10 px-2 py-0.5">{familyLabel(family)}</span>
                    <span>.{srcExt}</span>
                    <ArrowRight className="size-3.5" />
                    <span>Convert to</span>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {outputs.map((o) => (
                      <Button
                        key={o}
                        size="sm"
                        variant={target === o ? 'default' : 'secondary'}
                        onClick={() => setTarget(o)}
                        disabled={busy}
                        className="uppercase"
                      >
                        {o}
                      </Button>
                    ))}
                  </div>

                  {/* Quality (lossy targets only) */}
                  {target && isLossy(target) && (
                    <div className="mt-4 flex items-center gap-3">
                      <label className="text-overline text-muted-foreground">Quality</label>
                      <input
                        type="range" min={10} max={100} value={quality}
                        onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                        disabled={busy}
                        className="flex-1 accent-brand"
                      />
                      <span className="w-9 text-right text-sm tabular-nums text-foreground">{quality}</span>
                    </div>
                  )}

                  {/* Action row */}
                  <div className="mt-5 flex flex-wrap items-center gap-3">
                    {!busy && phase !== 'done' && (
                      <Button onClick={handleConvert} disabled={!target}>
                        Convert
                      </Button>
                    )}
                    {busy && (
                      <>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Spinner /> {statusText}
                        </div>
                        <Button variant="secondary" size="icon" onClick={handleCancel} aria-label="Cancel conversion">
                          <X className="size-4" />
                        </Button>
                      </>
                    )}
                    {phase === 'done' && resultId && (
                      <>
                        <Button
                          onClick={() => handleDownload(resultId, resultName)}
                          className="bg-success text-success-foreground hover:bg-success/90"
                        >
                          <Download className="size-4" /> Download {resultName}
                        </Button>
                        <CheckCircle2 className="size-5 text-success" />
                      </>
                    )}
                  </div>

                  {error && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
                      <AlertCircle className="size-4" /> {error}
                    </div>
                  )}
                  {downloadErr && (
                    <div className="mt-3 flex items-center gap-2 text-sm text-destructive">
                      <AlertCircle className="size-4" /> {downloadErr}
                    </div>
                  )}
                </>
              )}
            </Card>
          )}

          {/* What you can convert: guidance shown when nothing is selected yet */}
          {!file && caps && (
            <Card className="p-5">
              <h2 className="mb-3 text-sm font-semibold text-foreground">What you can convert</h2>
              <div className="space-y-3">
                {(['image', 'audio', 'video'] as MediaFamily[]).map((fam) => {
                  const Icon = FAMILY_ICON[fam]
                  return (
                    <div key={fam} className="flex gap-3">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <div className="text-overline text-muted-foreground">{familyLabel(fam)}</div>
                        <div className="text-sm text-foreground/80">{caps.families[fam].outputs.join(', ')}</div>
                      </div>
                    </div>
                  )
                })}
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Conversions run locally on this device.
                {caps.vipsAvailable
                  ? ' AVIF/HEIC supported via libvips.'
                  : ' Install libvips on the server to add AVIF/HEIC.'}
              </p>
            </Card>
          )}

          {/* Recent conversions */}
          {recent.length > 0 && (
            <div>
              <SectionHeader title="Recent" className="mb-2" />
              <Card>
                {recent.map((r) => (
                  <div key={r.id} className="flex items-center gap-3 border-b border-border/40 px-4 py-2.5 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-foreground">{r.outputName}</div>
                      <div className="text-xs text-muted-foreground">
                        .{r.inputFormat} → .{r.outputFormat} · {r.engine}
                        {r.outputBytes != null && ` · ${humanBytes(r.outputBytes)}`}
                      </div>
                    </div>
                    {r.state === 'ready' ? (
                      <button onClick={() => handleDownload(r.id, r.outputName)} className="text-muted-foreground hover:text-foreground" title="Download">
                        <Download className="size-4" />
                      </button>
                    ) : (
                      <span className={cn(
                        'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase',
                        r.state === 'failed' || r.state === 'cancelled' ? 'bg-destructive/15 text-destructive' : 'bg-foreground/10 text-muted-foreground',
                      )}>
                        {r.state}
                      </span>
                    )}
                  </div>
                ))}
              </Card>
              {downloadErr && !file && (
                <div className="mt-2 flex items-center gap-2 px-1 text-sm text-destructive">
                  <AlertCircle className="size-4" /> {downloadErr}
                </div>
              )}
            </div>
          )}
        </div>
      </PageContainer>
    </PageShell>
  )
}
