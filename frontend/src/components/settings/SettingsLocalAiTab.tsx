// Local AI: the user-facing "everything runs on your hub, nothing leaves the house"
// report, plus the chat-history retention control (month / year / forever), a direct
// privacy parity with Apple's Siri app. The retention choice is enforced by the daily
// sweep in backend/src/lib/chatRetention.ts.

import { useEffect, useState } from 'react'
import {
  ShieldCheck, MessageSquare, Wand2, ImageIcon, Eye, Languages, FileText, Check,
} from 'lucide-react'
import { cn } from '@/lib/cn'
import { useAuth } from '@/context/AuthContext'
import { Card } from '@/components/ui/card'

type Retention = 'forever' | 'year' | 'month'

const RETENTION_OPTS: { id: Retention; label: string; note: string }[] = [
  { id: 'forever', label: 'Keep forever', note: 'Never auto-delete' },
  { id: 'year', label: '1 year', note: 'Delete chats older than a year' },
  { id: 'month', label: '30 days', note: 'Delete chats older than a month' },
]

const CAPABILITIES: { icon: typeof MessageSquare; label: string; detail: string }[] = [
  { icon: MessageSquare, label: 'Companion chat & memory', detail: 'Local language model, grounded in your notes and inventory' },
  { icon: Wand2, label: 'Writing Tools & summaries', detail: 'Proofread, rewrite, and summarize on-device' },
  { icon: ImageIcon, label: 'Image generation & Clean Up', detail: 'Local diffusion models, never uploaded' },
  { icon: Eye, label: 'Vision & camera search', detail: 'Photos and footage analyzed on your hub' },
  { icon: Languages, label: 'Translation', detail: 'Speech and text translated locally' },
  { icon: FileText, label: 'Notification & podcast summaries', detail: 'Digests written by the local model' },
]

export function SettingsLocalAiTab() {
  const { user } = useAuth()
  const [retention, setRetention] = useState<Retention>('forever')

  useEffect(() => {
    if (!user) return
    fetch(`/api/users/${user.id}/preferences`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((prefs: Record<string, unknown>) => {
        const v = prefs['chat.retention']
        if (v === 'year' || v === 'month') setRetention(v)
      })
      .catch(() => {})
  }, [user])

  const save = (next: Retention) => {
    setRetention(next)
    if (!user) return
    fetch(`/api/users/${user.id}/preferences`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 'chat.retention': next }),
    }).catch(() => {})
  }

  return (
    <div className="space-y-6 p-4">
      {/* The headline: nothing leaves the house. */}
      <Card className="flex items-start gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-control bg-brand/12 text-brand">
          <ShieldCheck className="size-5" />
        </div>
        <div>
          <p className="font-semibold">Your AI runs at home</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Every AI feature here runs on your own hub using local models. Nothing you say, type, or capture is sent to
            an outside company, and there are no per-request cloud costs. This is the whole point of Loki Doki.
          </p>
        </div>
      </Card>

      <div>
        <p className="mb-2 text-sm font-semibold">What runs locally</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {CAPABILITIES.map((cap) => (
            <div key={cap.label} className="flex items-start gap-2.5 rounded-control border border-border/50 bg-card p-3">
              <cap.icon className="mt-0.5 size-4 shrink-0 text-brand" />
              <div>
                <p className="text-sm font-medium">{cap.label}</p>
                <p className="text-xs text-muted-foreground">{cap.detail}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <p className="text-sm font-semibold">Chat history</p>
        <p className="mb-2 mt-0.5 text-xs text-muted-foreground">
          Choose how long your companion conversations are kept before they are automatically deleted.
        </p>
        <div className="grid gap-2 sm:grid-cols-3">
          {RETENTION_OPTS.map((opt) => {
            const active = retention === opt.id
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => save(opt.id)}
                className={cn(
                  'flex flex-col rounded-control border p-3 text-left transition-colors',
                  active ? 'border-brand bg-brand/5' : 'border-border/60 hover:border-border',
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-semibold">
                  {active && <Check className="size-3.5 text-brand" />}
                  {opt.label}
                </span>
                <span className="mt-0.5 text-xs text-muted-foreground">{opt.note}</span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
