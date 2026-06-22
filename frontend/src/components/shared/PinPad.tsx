import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫']
const MAX = 6
const MIN_SUBMIT = 4

export interface PinPadProps {
  /** 'set' — enter then confirm (two passes, mismatch error). 'verify' — single entry, calls onComplete immediately. */
  mode: 'set' | 'verify'
  /** Called with the PIN when entry is complete. In verify mode, caller is responsible for actual verification. */
  onComplete: (pin: string) => void
  /** External error to display (e.g. "Wrong PIN — 3 attempts left"). Cleared on next key press. */
  error?: string
  loading?: boolean
  onBack?: () => void
  title?: string
  subtitle?: string
}

export function PinPad({
  mode,
  onComplete,
  error: externalError,
  loading = false,
  onBack,
  title,
  subtitle,
}: PinPadProps) {
  const [pin, setPin]           = useState('')
  const [confirm, setConfirm]   = useState('')
  const [stage, setStage]       = useState<'enter' | 'confirm'>('enter')
  const [localError, setError]  = useState('')
  const inputRef                = useRef<HTMLInputElement>(null)

  const activePin = stage === 'confirm' ? confirm : pin
  const error     = externalError ?? localError

  useEffect(() => { inputRef.current?.focus() }, [stage])

  // When the caller reports an error (wrong PIN), clear the entered digits
  useEffect(() => {
    if (externalError) {
      setPin('')
      setConfirm('')
    }
  }, [externalError])

  // Clear local error on any new input
  function clearError() {
    if (localError) setError('')
  }

  function handleComplete(value: string) {
    if (mode === 'verify') {
      onComplete(value)
      return
    }

    // 'set' mode — two-pass
    if (stage === 'enter') {
      setStage('confirm')
      return
    }

    // Confirming
    if (value === pin) {
      onComplete(pin)
    } else {
      setError("PINs don't match — try again.")
      setPin('')
      setConfirm('')
      setStage('enter')
    }
  }

  function pressKey(k: string) {
    if (loading) return
    clearError()

    if (k === '⌫') {
      if (stage === 'confirm') setConfirm((p) => p.slice(0, -1))
      else setPin((p) => p.slice(0, -1))
      return
    }

    const current = stage === 'confirm' ? confirm : pin
    if (current.length >= MAX) return

    const next = current + k
    if (stage === 'confirm') setConfirm(next)
    else setPin(next)

    if (next.length >= MIN_SUBMIT) handleComplete(next)
  }

  function handleKeyInput(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value.replace(/\D/g, '').slice(0, MAX)
    clearError()
    if (stage === 'confirm') {
      setConfirm(val)
      if (val.length >= MIN_SUBMIT) handleComplete(val)
    } else {
      setPin(val)
      if (val.length >= MIN_SUBMIT) handleComplete(val)
    }
  }

  // Resolve display text
  const displayTitle = title ?? (
    mode === 'set'
      ? (stage === 'enter' ? 'Create a PIN' : 'Confirm your PIN')
      : 'Enter your PIN'
  )
  const displaySubtitle = subtitle ?? (
    mode === 'set'
      ? (stage === 'enter' ? '4–6 digits' : 'Re-enter your PIN to confirm')
      : undefined
  )

  return (
    <div className="flex flex-col items-center">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-6 flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="size-4" /> Back
        </button>
      )}

      <p className="text-base font-semibold">{displayTitle}</p>
      {displaySubtitle && (
        <p className="mt-1 text-sm text-muted-foreground">{displaySubtitle}</p>
      )}

      {/* Dot indicators */}
      <div className="mt-6 flex gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className={cn(
              'size-3.5 rounded-full border-2 transition-all duration-150',
              i < activePin.length
                ? 'border-foreground bg-foreground scale-110'
                : 'border-foreground/30 bg-transparent',
            )}
          />
        ))}
      </div>

      {error && (
        <p className="mt-3 text-xs text-red-400 text-center max-w-[200px] animate-in fade-in">
          {error}
        </p>
      )}

      {/* Hidden real input for hardware keyboard */}
      <input
        ref={inputRef}
        type="tel"
        inputMode="numeric"
        value={activePin}
        onChange={handleKeyInput}
        className="sr-only"
        maxLength={MAX}
        aria-label="PIN"
        autoFocus
      />

      {/* Visual keypad */}
      <div className="mt-6 grid grid-cols-3 gap-3">
        {KEYS.map((k, i) =>
          k === '' ? (
            <div key={i} />
          ) : (
            <button
              key={i}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pressKey(k)}
              disabled={loading}
              className={cn(
                'flex size-16 items-center justify-center rounded-full text-lg font-semibold',
                'bg-foreground/8 hover:bg-foreground/15 active:bg-foreground/25',
                'transition-colors disabled:opacity-40',
                k === '⌫' && 'text-base',
              )}
            >
              {loading && k === '⌫' ? <Loader2 className="size-4 animate-spin" /> : k}
            </button>
          ),
        )}
      </div>
    </div>
  )
}
