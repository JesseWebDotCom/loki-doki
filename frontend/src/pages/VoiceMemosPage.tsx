import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Square, Trash2 } from 'lucide-react'
import { PageShell } from '@/components/shared/PageShell'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SkeletonListRows } from '@/components/shared/SkeletonBlocks'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/cn'

interface Memo {
  id: string
  sessionId: string | null
  durationMs: number
  transcript: string | null
  createdAt: number
}

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function VoiceMemosPage() {
  const [memos, setMemos] = useState<Memo[] | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [recording, setRecording] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)

  usePublishUIContext({ label: 'Voice Memos', description: 'User is recording and reviewing voice memos.' })

  const load = useCallback(async () => {
    setStatus('loading')
    try {
      const r = await fetch('/api/voice/memos', { credentials: 'include' })
      if (!r.ok) throw new Error()
      const d = (await r.json()) as { memos: Memo[] }
      setMemos(d.memos)
      setStatus('ready')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const upload = useCallback(async (blob: Blob, durationMs: number) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append('audio', blob, 'memo.webm')
      fd.append('duration_ms', String(durationMs))
      const r = await fetch('/api/voice/memos', { method: 'POST', credentials: 'include', body: fd })
      if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error ?? 'Upload failed')
      toast.success('Memo saved')
      await load()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }, [load])

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunksRef.current = []
      rec.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        const duration = Date.now() - startedAtRef.current
        if (blob.size > 0) void upload(blob, duration)
      }
      recorderRef.current = rec
      startedAtRef.current = Date.now()
      rec.start()
      setRecording(true)
    } catch {
      toast.error('Microphone access denied')
    }
  }, [upload])

  const stopRecording = useCallback(() => {
    recorderRef.current?.stop()
    setRecording(false)
  }, [])

  const remove = useCallback(async (id: string) => {
    try {
      const r = await fetch(`/api/voice/memos/${id}`, { method: 'DELETE', credentials: 'include' })
      if (!r.ok) throw new Error()
      setMemos((cur) => cur?.filter((m) => m.id !== id) ?? cur)
    } catch {
      toast.error('Could not delete memo')
    }
  }, [])

  return (
    <PageShell>
      <PageContainer className="shrink-0">
        <PageHeader subtitle="Record, save, and transcribe audio notes offline." />
      </PageContainer>

      <div className="flex-1 overflow-y-auto">
        <PageContainer className="pb-8">
        {/* Record control */}
        <Card className="mb-5 flex flex-col items-center gap-3 border-border/60 py-8">
          <button
            onClick={recording ? stopRecording : () => void startRecording()}
            disabled={uploading}
            aria-label={recording ? 'Stop recording' : 'Record a memo'}
            className={cn(
              'flex size-20 items-center justify-center rounded-full text-white shadow-lg transition-all active:scale-95 disabled:opacity-50',
              // design-ok(adhoc-pulse): live recording indicator on the record control
              recording ? 'bg-destructive animate-pulse' : 'bg-brand',
            )}
          >
            {uploading ? <Spinner className="size-8 text-white" /> : recording ? <Square className="size-7" /> : <Mic className="size-8" />}
          </button>
          <p className="text-sm text-muted-foreground">
            {uploading ? 'Saving…' : recording ? 'Recording… tap to stop' : 'Tap to record a memo'}
          </p>
        </Card>

        {status === 'loading' && <SkeletonListRows count={4} />}
        {status === 'error' && <p className="py-8 text-center text-sm text-destructive">Couldn't load memos.</p>}
        {status === 'ready' && memos?.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">No memos yet.</p>
        )}

        <div className="space-y-3">
          {memos?.map((m) => (
            <Card key={m.id} className="border-border/60 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">{fmtDate(m.createdAt)} · {fmtDuration(m.durationMs)}</span>
                <button onClick={() => setDeleteId(m.id)} className="text-muted-foreground hover:text-destructive" aria-label="Delete memo">
                  <Trash2 className="size-4" />
                </button>
              </div>
              <audio controls preload="none" src={`/api/voice/memos/${m.id}`} className="mt-2 h-9 w-full" />
              {m.transcript && <p className="mt-2 text-sm leading-relaxed">{m.transcript}</p>}
            </Card>
          ))}
        </div>
        </PageContainer>
      </div>

      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={(o) => !o && setDeleteId(null)}
        title="Delete this memo?"
        description="This permanently removes the recording."
        confirmLabel="Delete"
        destructive
        onConfirm={() => { if (deleteId) void remove(deleteId); setDeleteId(null) }}
      />
    </PageShell>
  )
}
