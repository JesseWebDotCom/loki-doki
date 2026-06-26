import { useState } from 'react'
import { FileText, Copy, Check, Download, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from '@/lib/toast'
import type { DocumentEditBlockData } from './types'

export function DocumentEditBlock({ data }: { data: DocumentEditBlockData }) {
  const [copied, setCopied] = useState(false)
  const [open, setOpen] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(data.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error('Could not copy to clipboard')
    }
  }

  function download() {
    // Hit the durable server endpoint (Content-Disposition forces the download with
    // the right filename). Same link persists in the chat message after reload.
    const a = document.createElement('a')
    a.href = data.downloadUrl
    a.download = data.editedFilename
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="mt-2 max-w-md rounded-lg border border-border bg-muted/30 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <FileText className="size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{data.editedFilename}</p>
          {data.instruction && (
            <p className="truncate text-xs text-muted-foreground">Edit: {data.instruction}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={download}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Download className="size-3.5" /> Download
        </button>
        <button
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted transition-colors"
        >
          {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button
          onClick={() => setOpen((v) => !v)}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {open ? 'Hide' : 'Preview'}
        </button>
      </div>

      {open && (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words border-t border-border bg-background/50 px-3 py-2 text-xs text-foreground/90">
          {data.text}
        </pre>
      )}
    </div>
  )
}
