import { useEffect, useRef, useState } from 'react'
import { Eye, EyeOff, Lock, X } from 'lucide-react'
import { usePrivacy } from '@/context/PrivacyContext'
import { cn } from '@/lib/cn'

// ── PIN dialog ────────────────────────────────────────────────────────────────

function PinDialog() {
  const { pinError, submitPin, cancelUnlock } = usePrivacy()
  const [pin, setPin] = useState('')
  const [loading, setLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { inputRef.current?.focus() }, [])

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!pin.trim() || loading) return
    setLoading(true)
    await submitPin(pin.trim())
    setLoading(false)
    setPin('')
  }

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-xs rounded-2xl border border-border/60 bg-card p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Lock className="size-4 text-muted-foreground" />
            <span className="text-sm font-semibold">Enter Privacy PIN</span>
          </div>
          <button onClick={cancelUnlock} className="rounded-md p-1 text-muted-foreground hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <form onSubmit={e => void onSubmit(e)} className="space-y-3">
          <input
            ref={inputRef}
            type="password"
            value={pin}
            onChange={e => setPin(e.target.value)}
            placeholder="PIN"
            autoComplete="off"
            className="w-full rounded-xl border border-border/60 bg-background px-4 py-2.5 text-center text-lg font-mono tracking-[0.4em] outline-none focus:border-brand/60"
          />
          {pinError && (
            <p className="text-center text-xs text-destructive">{pinError}</p>
          )}
          <button
            type="submit"
            disabled={loading || !pin.trim()}
            className="w-full rounded-xl bg-foreground py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {loading ? 'Verifying…' : 'Unlock'}
          </button>
        </form>

        <p className="mt-3 text-center text-[11px] text-muted-foreground/60">
          ⌘⇧P to toggle
        </p>
      </div>
    </div>
  )
}

// ── Floating pill ─────────────────────────────────────────────────────────────

function RevealedPill() {
  const { mode, secondsLeft, extend, keepOpen, hide } = usePrivacy()
  const isExtended = mode === 'extended'
  const timeout = secondsLeft !== null ? secondsLeft : null

  return (
    <div className={cn(
      'fixed bottom-5 right-5 z-[150] flex items-center gap-2 rounded-full border border-border/40 bg-card/90 px-3 py-1.5 shadow-lg backdrop-blur-sm',
      'text-xs font-medium transition-all',
    )}>
      <Eye className="size-3.5 text-amber-500 shrink-0" />
      {isExtended ? (
        <span className="text-muted-foreground">Private</span>
      ) : (
        <span className={cn('tabular-nums', timeout !== null && timeout <= 10 ? 'text-destructive' : 'text-muted-foreground')}>
          {timeout !== null ? `${timeout}s` : '—'}
        </span>
      )}
      {!isExtended && (
        <>
          <button
            onClick={extend}
            className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold hover:bg-muted/80 transition-colors"
          >
            +30s
          </button>
          <button
            onClick={keepOpen}
            className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold hover:bg-muted/80 transition-colors"
          >
            Keep open
          </button>
        </>
      )}
      <button
        onClick={hide}
        className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:text-foreground transition-colors"
        title="Hide adult content"
      >
        <EyeOff className="size-3" />
      </button>
    </div>
  )
}

// ── Root export ───────────────────────────────────────────────────────────────

export function PrivacyOverlay() {
  const { mode } = usePrivacy()
  if (mode === 'unlocking') return <PinDialog />
  if (mode === 'revealed' || mode === 'extended') return <RevealedPill />
  return null
}
