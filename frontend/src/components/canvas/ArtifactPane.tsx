// The Canvas pane. Mounted ONCE globally (AppShell) so it can float over any app -
// on the chat page it reads as a right-side panel; off-chat it slides over whatever
// screen you're on. Reads the global artifact store (no props). Lazy-loads the
// CodeMirror editor so it never touches the main bundle.

import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { X, Copy, Check, Download, Code2, Eye, ChevronDown, History, Sparkles, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { MarkdownRenderer } from '@/components/chat/MarkdownRenderer'
import { useTheme } from '@/context/ThemeContext'
import { toast } from '@/lib/toast'
import {
  useArtifactState, closePane, setLocalContent, saveArtifact, askEdit, revertToVersion,
} from '@/lib/canvas/artifactStore'

const CanvasEditor = lazy(() => import('./CanvasEditor'))

type ViewMode = 'edit' | 'preview'

export function ArtifactPane() {
  const { paneOpen, open } = useArtifactState()
  const { effectiveTheme } = useTheme()
  const { pathname } = useLocation()
  // Canvas is a Chat-app surface only: it hides when you switch to another app (the
  // artifact is preserved and reappears when you return to chat, or from /canvas).
  const onChat = pathname.startsWith('/chat')
  const [copied, setCopied] = useState(false)
  const [view, setView] = useState<ViewMode>('edit')
  const [showExport, setShowExport] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  const [editText, setEditText] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // A code artifact has no separate "preview"; documents/html do. Default a fresh
  // (non-streaming) doc/html open to its rendered preview; code always edits.
  const artifactId = open?.id
  useEffect(() => {
    if (!open) return
    setView(open.type === 'code' ? 'edit' : open.streaming ? 'edit' : 'preview')
  }, [artifactId, open?.streaming, open?.type]) // eslint-disable-line react-hooks/exhaustive-deps

  // Debounced auto-save of local edits.
  const onEdit = (v: string) => {
    setLocalContent(v)
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => { void saveArtifact() }, 800)
  }

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  if (!paneOpen || !open || !onChat) return null

  const canPreview = open.type !== 'code'
  const typeLabel = open.type === 'code' ? (open.language || 'Code') : open.type === 'html' ? 'HTML' : 'Document'

  async function copy() {
    if (!open) return
    try {
      await navigator.clipboard.writeText(open.content)
      setCopied(true); setTimeout(() => setCopied(false), 1500)
    } catch { toast.error('Could not copy') }
  }

  function download(format: string) {
    if (!open) return
    setShowExport(false)
    const a = document.createElement('a')
    a.href = `/api/artifacts/${open.id}/export?format=${format}`
    document.body.appendChild(a); a.click(); a.remove()
  }

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full flex-col border-l border-border bg-background shadow-xl md:w-[32rem] lg:w-[40rem]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{open.title}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {typeLabel}
            {open.streaming && (
              <span className="inline-flex items-center gap-1 text-primary">
                <Spinner size="sm" className="text-primary" /> writing…
              </span>
            )}
            {open.dirty && !open.streaming && <span className="text-muted-foreground">· unsaved</span>}
          </p>
        </div>

        {canPreview && !open.streaming && (
          <div className="flex overflow-hidden rounded-card border border-border">
            <button
              type="button" onClick={() => setView('edit')}
              className={`flex items-center gap-1 px-2 py-1 text-xs ${view === 'edit' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <Code2 className="size-3.5" /> Edit
            </button>
            <button
              type="button" onClick={() => setView('preview')}
              className={`flex items-center gap-1 px-2 py-1 text-xs ${view === 'preview' ? 'bg-muted text-foreground' : 'text-muted-foreground'}`}
            >
              <Eye className="size-3.5" /> Preview
            </button>
          </div>
        )}

        {open.versions.length > 1 && (
          <div className="relative">
            <Button variant="ghost" size="icon-sm" onClick={() => setShowVersions((v) => !v)} title="Version history">
              <History className="size-4" />
            </Button>
            {showVersions && (
              <div className="absolute right-0 top-full z-10 mt-1 max-h-72 w-56 overflow-auto rounded-card border border-border bg-popover shadow-md">
                {open.versions.map((v, i) => (
                  <button
                    key={v.id} type="button"
                    onClick={() => { setShowVersions(false); void revertToVersion(v.id) }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
                  >
                    <RotateCcw className="size-3 shrink-0 text-muted-foreground" />
                    <span className="flex-1 truncate">
                      {i === 0 ? 'Current' : v.author === 'user' ? 'Your edit' : 'Assistant'}
                      {v.summary ? ` · ${v.summary}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <Button variant="ghost" size="icon-sm" onClick={copy} title="Copy">
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </Button>
        <div className="relative">
          <Button variant="ghost" size="icon-sm" onClick={() => setShowExport((v) => !v)} title="Export">
            <Download className="size-4" />
          </Button>
          {showExport && (
            <div className="absolute right-0 top-full z-10 mt-1 w-32 overflow-hidden rounded-card border border-border bg-popover shadow-md">
              {(['md', 'txt', 'html', 'pdf'] as const).map((f) => (
                <button
                  key={f} type="button" onClick={() => download(f)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-muted"
                >
                  <ChevronDown className="size-3 opacity-0" /> .{f}
                </button>
              ))}
            </div>
          )}
        </div>
        <Button variant="ghost" size="icon-sm" onClick={closePane} title="Close">
          <X className="size-4" />
        </Button>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {view === 'preview' && open.type === 'document' ? (
          <div className="h-full overflow-auto px-4 py-3">
            <MarkdownRenderer content={open.content} />
          </div>
        ) : view === 'preview' && open.type === 'html' ? (
          <iframe
            title={open.title}
            sandbox="allow-scripts"
            srcDoc={open.content}
            className="h-full w-full border-0 bg-white"
          />
        ) : (
          <Suspense fallback={<div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Spinner /> Loading editor…</div>}>
            <div className="h-full overflow-auto">
              <CanvasEditor
                value={open.content}
                type={open.type}
                language={open.language}
                onChange={onEdit}
                readOnly={open.streaming}
                dark={effectiveTheme === 'dark'}
              />
            </div>
          </Suspense>
        )}
      </div>

      {/* Ask the assistant to edit this artifact */}
      <form
        className="flex items-center gap-2 border-t border-border px-3 py-2"
        onSubmit={async (e) => {
          e.preventDefault()
          const instruction = editText.trim()
          if (!instruction || open.streaming) return
          setEditText('')
          const ok = await askEdit(instruction)
          if (!ok) { setEditText(instruction); toast.error('Edit failed. Try again.') }
        }}
      >
        <Sparkles className="size-4 shrink-0 text-primary" />
        <input
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          disabled={open.streaming}
          placeholder="Ask to edit: make it shorter, add error handling..."
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
        />
        <Button type="submit" size="sm" disabled={open.streaming || !editText.trim()}>
          {open.streaming ? <Spinner size="sm" /> : 'Edit'}
        </Button>
      </form>
    </div>
  )
}
