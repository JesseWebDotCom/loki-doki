// Writing Tools: a select-text / whole-draft rewrite popover, the in-app analog of
// Apple's system-wide Writing Tools. Given some `text` and an `onReplace` callback it
// offers Proofread, three Rewrite tones, Summarize, Key Points, Make List, and
// Translate, streams the model's result live, and lets the user Replace the text in
// place (keeping an "Original" toggle) or Copy the result. Backed by the shared
// `/api/writing-tools` SSE endpoint. Drop it around any trigger element; pass
// `onReplace` on editable surfaces to enable in-place replacement.

import { useCallback, useRef, useState } from 'react'
import { Popover } from 'radix-ui'
import {
  Briefcase, Check, Copy, Languages, List, ListChecks, RotateCcw,
  Scissors, SpellCheck, Sparkles, Text, Undo2,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { runWritingTool, REWRITE_ACTIONS, type WritingAction } from '@/lib/writingTools'

const ACTIONS: { action: WritingAction; label: string; icon: typeof Text }[] = [
  { action: 'proofread', label: 'Proofread', icon: SpellCheck },
  { action: 'friendly', label: 'Friendly', icon: Sparkles },
  { action: 'professional', label: 'Professional', icon: Briefcase },
  { action: 'concise', label: 'Concise', icon: Scissors },
  { action: 'summarize', label: 'Summary', icon: Text },
  { action: 'key_points', label: 'Key points', icon: ListChecks },
  { action: 'list', label: 'Make list', icon: List },
  { action: 'translate', label: 'Translate', icon: Languages },
]

const LANGUAGES = ['Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Chinese', 'Japanese', 'Hindi']

const LABEL: Record<WritingAction, string> = {
  proofread: 'Proofread', friendly: 'Friendly', professional: 'Professional', concise: 'Concise',
  summarize: 'Summary', key_points: 'Key points', list: 'List', translate: 'Translation',
}

type View = 'menu' | 'translate' | 'result'

export function WritingToolsPopover({
  text,
  onReplace,
  children,
  align = 'start',
  side = 'bottom',
  disabled,
}: {
  text: string
  onReplace?: (next: string) => void
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom'
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<View>('menu')
  const [action, setAction] = useState<WritingAction | null>(null)
  const [result, setResult] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applied, setApplied] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  const canReplace = typeof onReplace === 'function'

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setView('menu'); setAction(null); setResult(''); setBusy(false); setError(null); setApplied(false)
  }, [])

  const run = useCallback(
    async (a: WritingAction, targetLang?: string) => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setAction(a); setView('result'); setResult(''); setError(null); setBusy(true); setApplied(false)
      try {
        await runWritingTool(text, a, (tok) => setResult((r) => r + tok), { targetLang, signal: ctrl.signal })
      } catch (e) {
        if (!ctrl.signal.aborted) setError(e instanceof Error ? e.message : 'Writing Tools failed.')
      } finally {
        if (!ctrl.signal.aborted) setBusy(false)
      }
    },
    [text],
  )

  const onPick = useCallback(
    (a: WritingAction) => {
      if (a === 'translate') { setView('translate'); return }
      void run(a)
    },
    [run],
  )

  const replace = useCallback(() => {
    if (!canReplace || !result.trim()) return
    onReplace!(result)
    setApplied(true)
    toast.success('Text replaced')
  }, [canReplace, result, onReplace])

  const undo = useCallback(() => {
    if (!canReplace) return
    onReplace!(text)
    setApplied(false)
  }, [canReplace, text])

  const copy = useCallback(() => {
    void navigator.clipboard.writeText(result).then(() => toast.success('Copied'))
  }, [result])

  const isRewrite = action ? REWRITE_ACTIONS.includes(action) : false
  const hasText = text.trim().length > 0

  return (
    <Popover.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <Popover.Trigger asChild disabled={disabled || !hasText}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align={align}
          side={side}
          sideOffset={8}
          className="z-50 w-80 max-w-[92vw] rounded-card border border-border/60 bg-popover p-2 text-popover-foreground shadow-xl outline-none"
        >
          {view === 'menu' && (
            <div className="grid grid-cols-2 gap-1">
              {ACTIONS.map(({ action: a, label, icon: Icon }) => (
                <button
                  key={a}
                  type="button"
                  onClick={() => onPick(a)}
                  className="flex items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm font-medium hover:bg-accent"
                >
                  <Icon className="size-4 shrink-0 text-brand" aria-hidden />
                  <span className="truncate">{label}</span>
                </button>
              ))}
            </div>
          )}

          {view === 'translate' && (
            <div className="p-1">
              <p className="px-1 pb-2 text-xs font-semibold text-muted-foreground">Translate to</p>
              <div className="grid grid-cols-2 gap-1">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => void run('translate', lang)}
                    className="rounded-control px-2.5 py-2 text-left text-sm font-medium hover:bg-accent"
                  >
                    {lang}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={() => setView('menu')}
                className="mt-2 w-full rounded-control px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
              >
                Back
              </button>
            </div>
          )}

          {view === 'result' && (
            <div className="flex flex-col gap-2 p-1">
              <div className="flex items-center gap-1.5 px-1 text-xs font-semibold text-muted-foreground">
                <Sparkles className="size-3 text-brand" aria-hidden />
                {action ? LABEL[action] : ''}
                {busy && <Spinner size="sm" className="ml-auto" />}
              </div>

              {error ? (
                <p className="rounded-control bg-destructive/10 px-2 py-2 text-sm text-destructive">{error}</p>
              ) : (
                <div className="max-h-56 overflow-y-auto whitespace-pre-wrap rounded-control bg-muted/50 px-2.5 py-2 text-sm">
                  {result || (busy ? '' : 'No output.')}
                  {/* design-ok(adhoc-pulse): streaming caret, uses the app's sanctioned streaming-cursor keyframe */}
                  {busy && (
                    <span className="ml-0.5 inline-block h-4 w-1.5 animate-[streaming-cursor_1s_ease-in-out_infinite] bg-brand align-text-bottom" />
                  )}
                </div>
              )}

              {!error && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {canReplace && !applied && (
                    <Button size="sm" variant="default" onClick={replace} disabled={busy || !result.trim()}>
                      <Check className="size-3.5" /> {isRewrite ? 'Replace' : 'Use this'}
                    </Button>
                  )}
                  {canReplace && applied && (
                    <Button size="sm" variant="secondary" onClick={undo}>
                      <Undo2 className="size-3.5" /> Original
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={copy} disabled={busy || !result.trim()}>
                    <Copy className="size-3.5" /> Copy
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => action && void run(action)}
                    disabled={busy}
                    className="ml-auto"
                  >
                    <RotateCcw className="size-3.5" /> Redo
                  </Button>
                </div>
              )}

              {/* design-ok(hand-styled-button): compact in-popover link back to the tool menu */}
              <button
                type="button"
                onClick={reset}
                className="w-full rounded-control px-2 py-1.5 text-xs text-muted-foreground hover:bg-accent"
              >
                More tools
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
