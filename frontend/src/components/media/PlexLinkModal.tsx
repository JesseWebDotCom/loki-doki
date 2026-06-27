import { useEffect, useState } from 'react'
import { Loader2, ExternalLink, X, Copy, Check } from 'lucide-react'

// Centered modal for the plex.tv/link flow: copy the code, then open plex.tv/link and enter it.
// Rendered by whatever started the flow (banner / connect card) while it polls for approval.
export function PlexLinkModal({ pin, onClose }: { pin: { code: string; linkUrl: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Reset the "copied" check when a new code is issued.
  useEffect(() => setCopied(false), [pin?.code])

  if (!pin) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pin.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked — the code is selectable as a fallback */
    }
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-sm rounded-2xl border border-border bg-card p-6 text-center shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          title="Cancel"
          className="absolute right-3 top-3 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>

        <h2 className="text-lg font-semibold">Connect Plex</h2>

        <p className="mt-1 text-sm text-muted-foreground">Copy the code below:</p>
        <button
          onClick={copy}
          title="Copy code"
          className="group my-4 flex w-full items-center justify-center gap-3 rounded-xl bg-amber-500/10 py-4 ring-1 ring-amber-500/20 transition-colors hover:bg-amber-500/15"
        >
          <span className="select-all font-mono text-4xl font-bold tracking-[0.35em] text-amber-300">{pin.code}</span>
          {copied ? <Check className="size-5 text-emerald-400" /> : <Copy className="size-5 text-amber-300/70 group-hover:text-amber-300" />}
        </button>

        <p className="text-sm text-muted-foreground">
          Then open <span className="font-medium text-foreground">plex.tv/link</span> and enter it:
        </p>
        <a
          href={pin.linkUrl}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex items-center gap-2 rounded-xl bg-amber-500/20 px-4 py-2.5 text-sm font-medium text-amber-200 transition-colors hover:bg-amber-500/30"
        >
          Open plex.tv/link <ExternalLink className="size-4" />
        </a>

        <p className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Waiting for approval…
        </p>
      </div>
    </div>
  )
}
