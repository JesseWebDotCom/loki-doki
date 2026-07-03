import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Upload, Trash2, Sparkles, Download } from 'lucide-react'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ListRow } from '@/components/shared/ListRow'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'

interface Doc {
  id: string
  filename: string
  status: 'pending' | 'ready' | 'failed'
  chunkCount: number
  size: number
  createdAt: number
}
interface Preset { id: string; label: string }

interface SectionState { index: number; title: string; body: string; done: boolean }

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: 'include' })
  if (!r.ok) throw new Error(`Error ${r.status}`)
  return r.json() as Promise<T>
}

// ── Documents ────────────────────────────────────────────────────────────────

function Documents({ projectId }: { projectId: string }) {
  const [docs, setDocs] = useState<Doc[]>([])
  const [uploading, setUploading] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    try { setDocs((await getJson<{ documents: Doc[] }>(`/api/projects/${projectId}/documents`)).documents) }
    catch { /* ignore */ }
  }, [projectId])

  useEffect(() => { void load() }, [load])

  // Poll while any document is still being processed.
  useEffect(() => {
    if (!docs.some((d) => d.status === 'pending')) return
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [docs, load])

  const upload = useCallback(async (file: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch(`/api/projects/${projectId}/documents`, { method: 'POST', credentials: 'include', body: fd })
      if (!r.ok) throw new Error()
      await load()
    } catch {
      toast.error('Upload failed')
    } finally {
      setUploading(false)
    }
  }, [projectId, load])

  const remove = useCallback(async (id: string) => {
    setDocs((cur) => cur.filter((d) => d.id !== id))
    await fetch(`/api/projects/${projectId}/documents/${id}`, { method: 'DELETE', credentials: 'include' }).catch(() => {})
  }, [projectId])

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          {docs.length} {docs.length === 1 ? 'document' : 'documents'}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
          className="h-auto gap-1 px-1.5 py-0.5 text-xs text-brand hover:bg-transparent hover:text-brand-hover"
        >
          {uploading ? <Spinner size="sm" className="size-3" /> : <Upload className="size-3" />} Add file
        </Button>
        <input
          ref={fileRef} type="file" hidden
          accept=".pdf,.txt,.md,.html,.htm,text/plain,text/markdown,application/pdf,text/html"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = '' }}
        />
      </div>
      {docs.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground/50">
          Add PDFs, text, or HTML to ground generated documents in your sources.
        </p>
      ) : (
        <Card variant="flat" className="divide-y divide-border/50">
          {docs.map((d) => (
            <ListRow
              key={d.id}
              className="rounded-none"
              leading={<FileText className="size-4 text-muted-foreground" />}
              title={d.filename}
              trailing={
                <>
                  <span className={cn(
                    'text-[10px] font-medium',
                    d.status === 'ready' ? 'text-success' : d.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                  )}>
                    {d.status === 'ready' ? `${d.chunkCount} chunks` : d.status === 'failed' ? 'failed' : 'processing…'}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void remove(d.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </>
              }
            />
          ))}
        </Card>
      )}
    </div>
  )
}

// ── Long-form generator ──────────────────────────────────────────────────────

function LongForm({ projectId }: { projectId: string }) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [preset, setPreset] = useState<string>('')
  const [request, setRequest] = useState('')
  const [running, setRunning] = useState(false)
  const [title, setTitle] = useState('')
  const [sections, setSections] = useState<SectionState[]>([])
  const [finalMd, setFinalMd] = useState<string | null>(null)

  useEffect(() => {
    void getJson<{ presets: Preset[] }>('/api/projects/long-form/presets').then((d) => setPresets(d.presets)).catch(() => {})
  }, [])

  const generate = useCallback(async () => {
    if (!request.trim()) return
    setRunning(true); setTitle(''); setSections([]); setFinalMd(null)
    try {
      const res = await fetch(`/api/projects/${projectId}/long-form`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request, preset: preset || null }),
      })
      if (!res.ok || !res.body) throw new Error('Generation failed')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() ?? ''
        for (const frame of frames) {
          const dataLine = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!dataLine) continue
          const e = JSON.parse(dataLine.slice(5).trim())
          if (e.type === 'outline') { setTitle(e.title); setSections(e.sections.map((s: { index: number; title: string }) => ({ ...s, body: '', done: false }))) }
          else if (e.type === 'section_token') setSections((cur) => cur.map((s) => s.index === e.index ? { ...s, body: s.body + e.token } : s))
          else if (e.type === 'section_done') setSections((cur) => cur.map((s) => s.index === e.index ? { ...s, done: true } : s))
          else if (e.type === 'done') setFinalMd(e.markdown)
          else if (e.type === 'error') toast.error(e.message)
        }
      }
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setRunning(false)
    }
  }, [projectId, request, preset])

  const download = useCallback(() => {
    if (!finalMd) return
    const blob = new Blob([finalMd], { type: 'text/markdown' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${(title || 'document').replace(/[^\w-]+/g, '-')}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }, [finalMd, title])

  return (
    <div className="space-y-2">
      <Textarea
        value={request}
        onChange={(e) => setRequest(e.target.value)}
        placeholder="Describe the document to generate from this project's sources…"
        className="h-20"
      />
      <div className="flex flex-wrap items-center gap-2">
        <select value={preset} onChange={(e) => setPreset(e.target.value)} className="rounded-control border border-border bg-background px-3 py-1.5 text-sm">
          <option value="">Free-form</option>
          {presets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <Button
          size="sm"
          onClick={() => void generate()}
          disabled={running || !request.trim()}
        >
          {running ? <Spinner size="sm" className="text-primary-foreground" /> : <Sparkles className="size-4" />} Generate
        </Button>
        {finalMd && (
          <Button
            variant="ghost"
            size="sm"
            onClick={download}
            className="h-auto gap-1 px-1.5 py-0.5 text-sm text-brand hover:bg-transparent hover:text-brand-hover"
          >
            <Download className="size-4" /> Download
          </Button>
        )}
      </div>

      {(title || sections.length > 0) && (
        <Card variant="flat" className="mt-2 space-y-3 p-4">
          {title && <h3 className="text-section">{title}</h3>}
          {sections.map((s) => (
            <div key={s.index}>
              <p className="flex items-center gap-1.5 text-sm font-bold">
                {s.title}
                {!s.done && running && <Spinner size="sm" className="size-3" />}
              </p>
              <p className="mt-0.5 whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{s.body}</p>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

export function ProjectDocumentsPanel({ projectId }: { projectId: string }) {
  return (
    <div className="mt-6 space-y-5">
      <Documents projectId={projectId} />
      <div>
        <p className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50">
          <Sparkles className="size-3" /> Generate a document
        </p>
        <LongForm projectId={projectId} />
      </div>
    </div>
  )
}
