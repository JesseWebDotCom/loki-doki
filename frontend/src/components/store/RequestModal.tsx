import { useState } from 'react'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { AppTool } from '@/components/shared/InstallDisclosureModal'

/** Sends an install request to the admin for apps a regular user can't enable. */
export function RequestModal({ tool, open, onClose }: { tool: AppTool | null; open: boolean; onClose: () => void }) {
  const [message, setMessage] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function send() {
    if (!tool) return
    setStatus('sending')
    try {
      const res = await fetch('/api/app-store/request', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolId: tool.id, toolName: tool.name, message: message.trim() || undefined }),
      })
      if (!res.ok) throw new Error()
      setStatus('sent')
    } catch { setStatus('error') }
  }

  function close() { setMessage(''); setStatus('idle'); onClose() }
  if (!tool) return null

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) close() }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Request {tool.name}</DialogTitle>
          <DialogDescription>Send an install request to your admin.</DialogDescription>
        </DialogHeader>
        {status === 'sent' ? (
          <p className="text-sm text-success">Request sent. Your admin will review it.</p>
        ) : (
          <div className="space-y-3">
            <textarea
              value={message} onChange={e => setMessage(e.target.value)}
              placeholder="Optional note for your admin..." rows={3}
              className="w-full rounded-control border border-input bg-transparent px-3 py-2 text-sm outline-none resize-none placeholder:text-muted-foreground focus-visible:border-ring"
            />
            {status === 'error' && <p className="text-xs text-destructive">Something went wrong. Try again.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={close}>{status === 'sent' ? 'Close' : 'Cancel'}</Button>
          {status !== 'sent' && (
            <Button size="sm" onClick={send} disabled={status === 'sending'}>
              {status === 'sending' ? 'Sending...' : 'Send Request'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
