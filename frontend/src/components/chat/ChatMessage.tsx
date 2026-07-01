import { memo, useMemo, useState } from 'react'
import { Copy, Check, RotateCcw } from 'lucide-react'
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
}

export const ChatMessage = memo(function ChatMessage({ message, isLast, isGenerating, onRegenerate }: ChatMessageProps) {
  const isUser = message.role === 'user'

  // Strip <action> tags before display (they drive avatar animation instead).
  // Must be before any early return — Rules of Hooks.
  const cleanContent = useMemo(
    () => isUser ? message.content : stripEmotesForDisplay(message.content),
    [isUser, message.content],
  )

  if (isUser) {
    return (
      <div className="flex justify-end px-4">
        <div className="max-w-[70%] rounded-2xl bg-foreground text-background px-4 py-2.5 text-sm leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
      </div>
    )
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
