import { useEffect, useState } from "react"
import { LoaderCircle, Sparkles } from "lucide-react"

import { AssistantMessageCard } from "@/components/assistant-message-card"
import { ChatCopyButton } from "@/components/chat-copy-button"
import { ChatTypingIndicator } from "@/components/chat-typing-indicator"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

type ChatMessage = {
  role: "user" | "assistant"
  content: string
  created_at?: string
  pending?: boolean
  debug?: {
    startedAtMs?: number
    durationMs?: number
  }
  meta?: {
    request_type: string
    route: string
    reason: string
    turn_id?: string
    voice_summary?: string
    response_style?: string
    skill_route?: {
      outcome: string
      reason: string
      candidate?: {
        skill_id: string
        action: string
      } | null
    }
    execution?: {
      provider: string
      backend: string
      model: string
      acceleration: string
    }
    skill_result?: {
      skill: string
      action: string
    }
    rendered_response?: {
      summary: string
      metadata: Record<string, unknown>
    }
    prompt_debug?: {
      prompt_hash?: string
      cache_hit?: boolean
      character_id?: string | null
      care_profile_id?: string
    }
    card?: {
      type: string
      title?: string
      detail?: string
    }
  }
}

type OverviewRow = {
  label: string
  value: string
}

type CharacterDefinition = {
  id: string
  name: string
  logo: string
}

type ChatMessageListProps = {
  userDisplayName?: string
  messages: ChatMessage[]
  suggestions: string[]
  overviewRows: OverviewRow[]
  debugNow: number
  debugMode: boolean
  pendingSpeechMessageKey: string
  speakingMessageKey: string
  retryingAssistantIndex: number
  assistantCharacter?: CharacterDefinition | null
  onSuggestionSelect: (suggestion: string) => void
  onPlayVoice: (message: ChatMessage, messageKey: string) => void
  onRetrySmart: (assistantIndex: number) => void
  getMessageKey: (message: ChatMessage, index: number) => string
  onToggleCharacter?: () => void
}

function AssistantAvatar({ character, onClick }: { character?: CharacterDefinition | null; onClick?: () => void }) {
  const className = cn(
    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-[var(--line)] bg-[var(--panel-strong)] shadow-sm",
    onClick && "cursor-pointer transition-opacity hover:opacity-80"
  )

  const inner = character?.logo ? (
    <img alt={character.name} className="h-6 w-6 rounded-full object-cover" src={character.logo} />
  ) : (
    <Sparkles className="h-4 w-4 text-[var(--accent)]" />
  )

  if (onClick) {
    return (
      <button className={className} onClick={onClick} type="button" title="Toggle character panel">
        {inner}
      </button>
    )
  }

  return (
    <div className={className}>{inner}</div>
  )
}

export function ChatMessageList({
  userDisplayName,
  messages,
  suggestions,
  overviewRows,
  debugNow,
  debugMode,
  pendingSpeechMessageKey,
  speakingMessageKey,
  retryingAssistantIndex,
  assistantCharacter,
  onSuggestionSelect,
  onPlayVoice,
  onRetrySmart,
  getMessageKey,
  onToggleCharacter,
}: ChatMessageListProps) {
  function formatMessageTime(message: ChatMessage): string {
    const timestamp = message.created_at
      ? Date.parse(message.created_at)
      : message.debug?.startedAtMs
    if (!timestamp || Number.isNaN(timestamp)) {
      return ""
    }
    return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 py-6 sm:px-6 sm:py-8 xl:px-10">
      {messages.length === 0 ? (
        <div className="flex min-h-full flex-1 items-center justify-center py-8">
          <div className="chat-empty-state w-full max-w-4xl">
            <div className="mx-auto max-w-2xl text-center">
              <div className="mx-auto inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-[var(--panel)] px-3 py-1 text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--muted-foreground)]">
                <Sparkles className="h-3.5 w-3.5 text-[var(--accent)]" />
                AI Assistant
              </div>
              <h1 className="mt-6 text-4xl font-semibold tracking-tight text-[var(--foreground)] sm:text-5xl">
                Welcome, {userDisplayName || "there"}
              </h1>
              <p className="mx-auto mt-4 max-w-2xl text-base leading-7 text-[var(--muted-foreground)]">
                Ask a question, start voice capture, or drop in an image, video, or document to work through it together.
              </p>
            </div>
            <div className="mt-10 grid gap-3 sm:grid-cols-2">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  className="chat-suggestion-card text-left"
                  onClick={() => onSuggestionSelect(suggestion)}
                  type="button"
                >
                  <div className="text-sm font-medium text-[var(--foreground)]">{suggestion}</div>
                  <div className="mt-2 text-sm text-[var(--muted-foreground)]">Start here</div>
                </button>
              ))}
            </div>
            <div className="mt-8 flex flex-wrap items-center justify-center gap-3 text-xs uppercase tracking-[0.18em] text-[var(--muted-foreground)]">
              {overviewRows.map((row) => (
                <span key={row.label}>
                  {row.label}: {row.value}
                </span>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 pb-10">
        {messages.map((message, index) => (
          message.role === "assistant" && message.pending && !message.content ? null : (
          <div
            key={`${message.role}-${index}`}
            className={cn(
              "flex w-full items-start",
              message.role === "user" ? "justify-end" : "justify-start"
            )}
          >
            {message.role === "user" ? (
              <div className="group max-w-[85%]">
                <div className="chat-user-bubble">
                  <p className="whitespace-pre-wrap break-words text-lg leading-7">
                    {message.content.trim()}
                  </p>
                </div>
                <div className="mt-1 flex min-h-[32px] items-center justify-end gap-2 px-1">
                  <div className="flex items-center gap-2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
                    <span className="text-[11px] text-[var(--muted-foreground)]">{formatMessageTime(message)}</span>
                    <ChatCopyButton className="h-8 w-8 rounded-xl border border-[var(--line)] bg-transparent text-[var(--muted-foreground)] transition-colors duration-150 hover:bg-[var(--panel)]" content={message.content} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex w-full max-w-[85%] items-start gap-4">
                <div className="flex flex-none pt-1">
                  <AssistantAvatar character={assistantCharacter} onClick={onToggleCharacter} />
                </div>
                <div className="chat-assistant-bubble min-w-0 flex-1">
                  <AssistantMessageCard
                    debugNow={debugNow}
                    message={message as any}
                    messageKey={getMessageKey(message, index)}
                    messageTime={formatMessageTime(message)}
                    onPlayVoice={onPlayVoice}
                    onRetrySmart={() => onRetrySmart(index)}
                    pendingSpeechMessageKey={pendingSpeechMessageKey}
                    retrySmartPending={retryingAssistantIndex === index}
                    showRuntimeDebug={debugMode}
                    speakingMessageKey={speakingMessageKey}
                  />
                </div>
              </div>
            )}
          </div>
          )
        ))}
        {messages.some((message) => message.role === "assistant" && message.pending && !message.content) ? (
          <div className="flex w-full max-w-[85%] items-start gap-4">
            <div className="flex flex-none pt-3">
              <div className="avatar-spinner rounded-full">
                <div className="avatar-spinner-ring" />
                <AssistantAvatar character={assistantCharacter} onClick={onToggleCharacter} />
              </div>
            </div>
            <div className="flex-1">
              <ChatTypingIndicator />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}

type JumpToLatestProps = {
  visible: boolean
  onClick: () => void
}

export function JumpToLatest({ visible, onClick }: JumpToLatestProps) {
  if (!visible) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 -top-12 flex justify-center">
      <Button
        className="pointer-events-auto rounded-full border border-[var(--line)] bg-[var(--panel-strong)]/95 px-4 py-2 text-xs text-[var(--foreground)] shadow-lg hover:bg-[var(--input)]"
        onClick={onClick}
        type="button"
        variant="ghost"
      >
        Jump to latest
      </Button>
    </div>
  )
}
