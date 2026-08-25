// The one label for AI-generated content across the app. Apple's Generative-AI HIG
// (and the BBC notification-summary incident) is the reference: anything a model
// wrote or summarized carries a small, consistent "made by AI" mark so a reader is
// never misled into thinking it is human-authored or verbatim source text. Use this
// on podcast insights, briefing digests, notification summaries, camera digests, and
// any other generated surface instead of hand-rolling a per-surface label.

import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/cn'

export type AiBadgeTone = 'muted' | 'brand'

export function AiGeneratedBadge({
  label = 'AI generated',
  tone = 'muted',
  className,
  title,
}: {
  /** Short, honest description of what produced the content, e.g. "Summarized by MaiPai". */
  label?: string
  tone?: AiBadgeTone
  className?: string
  /** Optional longer explanation shown on hover (e.g. a summary-accuracy caveat). */
  title?: string
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-xs font-semibold',
        tone === 'brand'
          ? 'bg-brand/12 text-brand'
          : 'bg-foreground/8 text-muted-foreground',
        className,
      )}
    >
      <Sparkles className="size-3" aria-hidden />
      {label}
    </span>
  )
}
