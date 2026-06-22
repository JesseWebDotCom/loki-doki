import { memo, useMemo } from 'react'
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
}

interface ChatMessageProps {
  message: Message
  isLast?: boolean
  isGenerating?: boolean
}

export const ChatMessage = memo(function ChatMessage({ message, isLast, isGenerating }: ChatMessageProps) {
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
    <div className={cn('flex flex-col gap-3 px-4 text-sm text-foreground/90', isActive && 'min-h-[1.5rem]')}>
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

      {/* Typing dots while waiting for first token or waiting for prose after blocks */}
      {isActive && message.content.length === 0 && (
        <TypingDots />
      )}
    </div>
  )
})

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
