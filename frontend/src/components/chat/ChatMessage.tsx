import { memo, useMemo, useState } from 'react'
import { Copy, Check, ChevronLeft, ChevronRight, Pencil, RotateCcw, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { MarkdownRenderer } from './MarkdownRenderer'
import { SourcesCard } from './SourcesCard'
import { BlockRenderer } from './blocks/BlockRenderer'
import type { Block } from './blocks/BlockRenderer'
import type { Source } from '@/lib/transformCitations'
import { stripEmotesForDisplay } from '@/lib/emoteParser'

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt?: Date
  blocks?: Block[]
  sources?: Source[]
  /** Transient status shown while a tool runs before tokens arrive (e.g. "Reading your document…"). */
  routingLabel?: string | null
  /** Which model produced this reply - shown as a hover badge in the actions row. */
  model?: string | null
  /** Reply was cut off (user stop or num_predict cap). */
  truncated?: boolean
  /** The user's thumbs rating on this reply. */
  feedback?: 'up' | 'down' | null
  /** Sibling regenerate variants of this reply (ids oldest → newest). */
  variants?: { groupId: string; index: number; count: number; ids: string[] }
}

interface ChatMessageProps {
  message: Message
  isLast?: boolean
  isGenerating?: boolean
  /** Stable across renders (see MessageList) - takes the message id, not bound per-row,
   *  so passing it doesn't defeat this component's memoization. */
  onRegenerate?: (messageId: string) => void
  /** Edit-and-resubmit a user message. Stable across renders (see MessageList). */
  onEdit?: (messageId: string, newText: string) => void
  /** Thumbs up/down on an assistant reply. Stable across renders (see MessageList). */
  onRate?: (messageId: string, rating: 'up' | 'down' | null) => void
  /** Flip to a sibling regenerate variant. Stable across renders (see MessageList). */
  onSwitchVariant?: (variantId: string) => void
}

export const ChatMessage = memo(function ChatMessage({ message, isLast, isGenerating, onRegenerate, onEdit, onRate, onSwitchVariant }: ChatMessageProps) {
  const isUser = message.role === 'user'

  // Strip <action> tags before display (they drive avatar animation instead).
  // Must be before any early return - Rules of Hooks.
  const cleanContent = useMemo(
    () => isUser ? message.content : stripEmotesForDisplay(message.content),
    [isUser, message.content],
  )

  if (isUser) {
    return <UserMessage message={message} onEdit={onEdit && !isGenerating ? onEdit : undefined} />
  }

  const isActive = isLast && isGenerating

  return (
    <div className={cn('group/msg flex flex-col gap-3 px-4 text-sm text-foreground/90', isActive && 'min-h-[1.5rem]')}>
      {/* Tool result blocks - appear before the prose commentary */}
      {message.blocks?.map((block, i) => (
        <BlockRenderer key={`${block.kind}-${i}`} block={block} />
      ))}

      {/* Prose with optional citation chips */}
      {cleanContent.length > 0 && (
        <MarkdownRenderer
          content={cleanContent}
          isStreaming={isActive && cleanContent.length > 0}
          sources={message.sources}
        />
      )}

      {/* While a tool runs before any tokens: show its status label, else plain dots. */}
      {isActive && message.content.length === 0 && (
        message.routingLabel
          ? <RoutingStatus label={message.routingLabel} />
          : <TypingDots />
      )}

      {/* Sources list under a settled answer that cited web results. */}
      {!isActive && message.sources && message.sources.length > 0 && (
        <SourcesCard sources={message.sources} />
      )}

      {/* Reply was cut off (stop button or the generation cap). */}
      {!isActive && message.truncated && cleanContent.length > 0 && (
        <span className="text-[11px] text-muted-foreground">Reply was cut off before it finished.</span>
      )}

      {!isActive && cleanContent.length > 0 && (
        <MessageActions
          message={message}
          onRegenerate={onRegenerate && !isGenerating ? () => onRegenerate(message.id) : undefined}
          onRate={onRate && !isGenerating ? onRate : undefined}
          onSwitchVariant={onSwitchVariant && !isGenerating ? onSwitchVariant : undefined}
        />
      )}
    </div>
  )
})

// User bubble with hover edit affordance. Editing swaps the bubble for a textarea;
// saving rewrites the message and re-runs the turn (everything after it is replaced).
function UserMessage({ message, onEdit }: { message: Message; onEdit?: (messageId: string, newText: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const startEdit = () => { setDraft(message.content); setEditing(true) }
  const save = () => {
    const text = draft.trim()
    setEditing(false)
    if (text && text !== message.content) onEdit?.(message.id, text)
  }

  if (editing) {
    return (
      <div className="flex justify-end px-4">
        <div className="w-full max-w-[70%] rounded-card border border-border bg-card p-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
              if (e.key === 'Escape') setEditing(false)
            }}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            autoFocus
            className="w-full resize-y rounded-control bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none"
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[11px] text-muted-foreground">Replies after this point will be replaced</span>
            <div className="flex items-center gap-1">
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setEditing(false)} aria-label="Cancel edit" title="Cancel"
                className="text-muted-foreground hover:text-foreground">
                <X className="size-3.5" />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={save} aria-label="Save and resubmit" title="Save & resubmit"
                className="text-muted-foreground hover:text-foreground">
                <Check className="size-3.5" />
              </Button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group/usermsg flex items-center justify-end gap-1 px-4">
      {onEdit && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={startEdit} aria-label="Edit message" title="Edit & resubmit"
          className="shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground group-hover/usermsg:opacity-100 focus-visible:opacity-100">
          <Pencil className="size-3.5" />
        </Button>
      )}
      <div className="max-w-[70%] rounded-card bg-foreground text-background px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  )
}

function MessageActions({ message, onRegenerate, onRate, onSwitchVariant }: {
  message: Message
  onRegenerate?: () => void
  onRate?: (messageId: string, rating: 'up' | 'down' | null) => void
  onSwitchVariant?: (variantId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  const v = message.variants
  return (
    <div className="-mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
      <Button type="button" variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy message" title="Copy"
        className="text-muted-foreground hover:text-foreground">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      {onRegenerate && (
        <Button type="button" variant="ghost" size="icon-sm" onClick={onRegenerate} aria-label="Regenerate response" title="Regenerate"
          className="text-muted-foreground hover:text-foreground">
          <RotateCcw className="size-3.5" />
        </Button>
      )}
      {onRate && (
        <>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Good response" title="Good response"
            onClick={() => onRate(message.id, message.feedback === 'up' ? null : 'up')}
            className={cn('hover:text-foreground', message.feedback === 'up' ? 'text-brand' : 'text-muted-foreground')}>
            <ThumbsUp className="size-3.5" />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Bad response" title="Bad response"
            onClick={() => onRate(message.id, message.feedback === 'down' ? null : 'down')}
            className={cn('hover:text-foreground', message.feedback === 'down' ? 'text-brand' : 'text-muted-foreground')}>
            <ThumbsDown className="size-3.5" />
          </Button>
        </>
      )}
      {/* Sibling regenerate variants: < 2/3 > flips between kept attempts. */}
      {onSwitchVariant && v && v.count > 1 && (
        <span className="ml-1 inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous version" title="Previous version"
            disabled={v.index <= 0}
            onClick={() => { const prev = v.ids[v.index - 1]; if (prev) onSwitchVariant(prev) }}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="tabular-nums">{v.index + 1}/{v.count}</span>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Next version" title="Next version"
            disabled={v.index >= v.count - 1}
            onClick={() => { const next = v.ids[v.index + 1]; if (next) onSwitchVariant(next) }}
            className="text-muted-foreground hover:text-foreground disabled:opacity-30">
            <ChevronRight className="size-3.5" />
          </Button>
        </span>
      )}
      {message.model && (
        <span className="ml-1 text-[11px] text-muted-foreground/70" title={`Answered by ${message.model}`}>
          {shortModelName(message.model)}
        </span>
      )}
    </div>
  )
}

/** "qwen3:8b-instruct-q4_K_M" → "qwen3:8b" - the badge is a hint, the title has it all. */
function shortModelName(model: string): string {
  const base = model.split('-')[0] ?? model
  return base.length > 24 ? `${base.slice(0, 24)}…` : base
}

function RoutingStatus({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2 py-1 text-sm text-muted-foreground">
      <span>{label}</span>
      <TypingDots />
    </span>
  )
}

function TypingDots() {
  return (
    <span className="inline-flex items-end gap-0.5 py-1">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block size-1.5 rounded-full bg-muted-foreground animate-[typing-dot-bounce_1.25s_ease-out_infinite]"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  )
}

export function TypingIndicator() {
  return (
    <div className="flex flex-row px-4">
      <TypingDots />
    </div>
  )
}
