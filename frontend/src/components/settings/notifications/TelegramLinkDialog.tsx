// One-time-code dialog for linking a Telegram account: shows the 6-char code + a
// t.me deep link, then polls channel status until the bot confirms the link.

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Check, Copy, ExternalLink } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { StatusDot } from '@/components/shared/StatusDot'
import type { ChannelStatus } from '@/lib/notifications'

interface LinkCode {
  code: string
  expiresAt: number
  deepLink: string | null
  botUsername: string | null
}

export function TelegramLinkDialog({ open, onOpenChange, onLinked }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onLinked: () => void
}) {
  const [link, setLink] = useState<LinkCode | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [copied, setCopied] = useState(false)
  const linkedRef = useRef(false)

  // Fetch a fresh code every time the dialog opens.
  useEffect(() => {
    if (!open) { setLink(null); setError(null); linkedRef.current = false; return }
    fetch('/api/notify/channels/telegram/link-code', { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        const data = await r.json() as LinkCode & { error?: string }
        if (!r.ok) throw new Error(data.error ?? 'Could not create a link code')
        setLink(data)
      })
      .catch((e: Error) => setError(e.message))
  }, [open])

  // Countdown + poll for the link landing.
  useEffect(() => {
    if (!open || !link) return
    const tick = setInterval(() => {
      setRemaining(Math.max(0, Math.round((link.expiresAt - Date.now()) / 1000)))
    }, 1000)
    const poll = setInterval(() => {
      fetch('/api/notify/channels', { credentials: 'include' })
        .then((r) => (r.ok ? (r.json() as Promise<ChannelStatus>) : null))
        .then((data) => {
          if (data?.telegram?.linked && !linkedRef.current) {
            linkedRef.current = true
            toast.success('Telegram linked 🎉')
            onLinked()
            onOpenChange(false)
          }
        })
        .catch(() => {})
    }, 3000)
    return () => { clearInterval(tick); clearInterval(poll) }
  }, [open, link, onLinked, onOpenChange])

  const copy = () => {
    if (!link) return
    void navigator.clipboard.writeText(`/start ${link.code}`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const mins = Math.floor(remaining / 60)
  const secs = String(remaining % 60).padStart(2, '0')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Link Telegram</DialogTitle>
        </DialogHeader>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : !link ? (
          <div className="flex h-24 items-center justify-center">
            <Spinner size="lg" />
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Open Telegram and send this code to{' '}
              {link.botUsername ? <span className="font-medium text-foreground">@{link.botUsername}</span> : 'the household bot'}:
            </p>

            <div className="flex items-center justify-center gap-3">
              <p className="font-mono text-3xl tracking-[0.3em] select-all">{link.code}</p>
              <Button variant="ghost" size="icon" className="size-8" onClick={copy} aria-label="Copy /start command">
                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
              </Button>
            </div>

            {link.deepLink && (
              <Button asChild className="w-full gap-2">
                <a href={link.deepLink} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" /> Open Telegram
                </a>
              </Button>
            )}

            <p className="flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground">
              <StatusDot status="warn" pulse />
              Waiting for the bot to confirm… code expires in {mins}:{secs}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
