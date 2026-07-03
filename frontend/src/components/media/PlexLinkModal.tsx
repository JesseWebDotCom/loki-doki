import { useEffect, useState } from 'react'
import { ExternalLink, Copy, Check } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'

// Centered modal for the plex.tv/link flow: copy the code, then open plex.tv/link and enter it.
// Rendered by whatever started the flow (banner / connect card) while it polls for approval.
export function PlexLinkModal({ pin, onClose }: { pin: { code: string; linkUrl: string } | null; onClose: () => void }) {
  const [copied, setCopied] = useState(false)

  // Reset the "copied" check when a new code is issued.
  useEffect(() => setCopied(false), [pin?.code])

  if (!pin) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pin.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      /* clipboard blocked; the code is selectable as a fallback */
    }
  }

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="max-w-sm gap-0 text-center">
        <DialogTitle>Connect Plex</DialogTitle>

        <DialogDescription className="mt-1">Copy the code below:</DialogDescription>
        <Button
          variant="tinted"
          onClick={() => void copy()}
          title="Copy code"
          className="group my-4 h-auto w-full justify-center gap-3 rounded-control bg-warning/10 py-4 ring-1 ring-warning/20 hover:bg-warning/15"
        >
          <span className="select-all font-mono text-4xl font-bold tracking-[0.35em] text-warning">{pin.code}</span>
          {copied ? <Check className="size-5 text-success" /> : <Copy className="size-5 text-warning/70 group-hover:text-warning" />}
        </Button>

        <p className="text-sm text-muted-foreground">
          Then open <span className="font-medium text-foreground">plex.tv/link</span> and enter it:
        </p>
        <Button asChild variant="tinted" className="mx-auto mt-3 gap-2 bg-warning/20 text-warning hover:bg-warning/30">
          <a href={pin.linkUrl} target="_blank" rel="noreferrer">
            Open plex.tv/link <ExternalLink className="size-4" />
          </a>
        </Button>

        <p className="mt-5 flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Spinner size="sm" className="size-3" /> Waiting for approval…
        </p>
      </DialogContent>
    </Dialog>
  )
}
