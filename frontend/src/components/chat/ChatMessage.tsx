import { memo, useMemo, useState } from 'react'
import { Copy, Check, Pencil, RotateCcw, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { MarkdownRenderer } from './MarkdownRenderer'
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
}

interface ChatMessageProps {
  message: Message
  isLast?: boolean
  isGenerating?: boolean
  /** Stable across renders (see MessageList) — takes the message id, not bound per-row,
   *  so passing it doesn't defeat this component's memoization. */
  onRegenerate?: (messageId: string) => void
  /** Edit-and-resubmit a user message. Stable across renders (see MessageList). */
  onEdit?: (messageId: string, newText: string) => void
}

export const ChatMessage = memo(function ChatMessage({ message, isLast, isGenerating, onRegenerate, onEdit }: ChatMessageProps) {
  const isUser = message.role === 'user'

  // Strip <action> tags before display (they drive avatar animation instead).
  // Must be before any early return — Rules of Hooks.
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
      {/* Tool result blocks — appear before the prose commentary */}
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

      {!isActive && cleanContent.length > 0 && (
        <MessageActions content={message.content} onRegenerate={onRegenerate && !isGenerating ? () => onRegenerate(message.id) : undefined} />
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
        <div className="w-full max-w-[70%] rounded-2xl border border-border bg-card p-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() }
              if (e.key === 'Escape') setEditing(false)
            }}
            rows={Math.min(8, Math.max(2, draft.split('\n').length))}
            autoFocus
            className="w-full resize-y rounded-lg bg-transparent px-2 py-1.5 text-sm leading-relaxed outline-none"
          />
          <div className="flex items-center justify-between px-1 pt-1">
            <span className="text-[11px] text-muted-foreground">Replies after this point will be replaced</span>
            <div className="flex items-center gap-1">
              <button type="button" onClick={() => setEditing(false)} aria-label="Cancel edit" title="Cancel"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                <X className="size-3.5" />
              </button>
              <button type="button" onClick={save} aria-label="Save and resubmit" title="Save & resubmit"
                className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
                <Check className="size-3.5" />
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="group/usermsg flex items-center justify-end gap-1 px-4">
      {onEdit && (
        <button type="button" onClick={startEdit} aria-label="Edit message" title="Edit & resubmit"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/usermsg:opacity-100 focus-visible:opacity-100">
          <Pencil className="size-3.5" />
        </button>
      )}
      <div className="max-w-[70%] rounded-2xl bg-foreground text-background px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
        {message.content}
      </div>
    </div>
  )
}

function MessageActions({ content, onRegenerate }: { content: string; onRegenerate?: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }
  return (
    <div className="-mt-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
      <button type="button" onClick={copy} aria-label="Copy message" title="Copy"
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      {onRegenerate && (
        <button type="button" onClick={onRegenerate} aria-label="Regenerate response" title="Regenerate"
          className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
          <RotateCcw className="size-3.5" />
        </button>
      )}
    </div>
  )
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
