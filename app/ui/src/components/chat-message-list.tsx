import { useEffect, useState } from "react"
import { LoaderCircle, Sparkles, MessageSquare } from "lucide-react"

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
  chatTitle?: string
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
  chatTitle,
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
    <div className="mx-auto flex min-h-full w-full max-w-[1100px] flex-col px-4 pt-16 pb-6 sm:px-8 sm:pt-24 sm:pb-8">
      {messages.length === 0 ? (
        <div className="flex min-h-[60vh] flex-col items-center justify-center py-10 animate-in fade-in slide-in-from-bottom-8 duration-1000">
          <div className="w-full max-w-2xl text-center">
            <div className="mb-10 flex justify-center">
              <div className="relative">
                <div className="absolute inset-0 blur-3xl opacity-10 bg-white rounded-full" />
                <div className="relative flex h-16 w-16 items-center justify-center rounded-2xl border border-white/5 bg-[#161616]/40 backdrop-blur-sm shadow-2xl">
                  <img src="/lokidoki-logo.svg" alt="LokiDoki" className="h-9 w-9" />
                </div>
              </div>
            </div>
            
            <h1 className="text-4xl font-bold tracking-tight text-[#ececec] sm:text-6xl mb-6">
              How can I help you?
            </h1>
            <p className="text-[#8e8e8e] text-lg mb-16 max-w-lg mx-auto opacity-70">
              Start a new conversation or ask about anything on your mind.
            </p>
            
            <div className="grid gap-4 sm:grid-cols-2 text-left">
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  className="group relative flex flex-col items-start gap-1 rounded-[22px] border border-white/5 bg-[#161616]/30 p-5 transition-all hover:bg-[#1a1a1a]/50 hover:border-white/10 hover:scale-[1.02] active:scale-[0.98]"
                  onClick={() => onSuggestionSelect(suggestion)}
                  type="button"
                >
                  <div className="text-[15px] font-semibold text-[#ececec] mb-1 group-hover:text-white transition-colors">{suggestion}</div>
                  <div className="text-[12px] text-[#8e8e8e] opacity-60">Explain in simple terms</div>
                  <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Sparkles className="h-3.5 w-3.5 text-white" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto flex w-full max-w-[900px] flex-col gap-10 pb-32">
        {messages.length > 0 && (
          <div className="mb-12 flex items-center gap-3 pt-10 pb-6 animate-in fade-in slide-in-from-bottom-4 duration-1000">
             <div className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md border border-white/5 bg-[#161616]/50 shadow-sm">
                <MessageSquare className="h-3.5 w-3.5 text-[#8e8e8e]" />
             </div>
             <h1 className="text-4xl font-bold tracking-tight text-[#ececec]">
                {chatTitle || "Untitled Session"}
             </h1>
          </div>
        )}
        {messages.map((message, index) => (
          message.role === "assistant" && message.pending && !message.content ? null : (
            <div
              key={`${message.role}-${index}`}
              className="flex w-full items-start animate-in fade-in slide-in-from-bottom-4 duration-500"
            >
              {message.role === "user" ? (
                <div className="group flex w-full flex-col items-end px-1">
                  <div className="max-w-[85%]">
                    <p className="whitespace-pre-wrap break-words text-[18px] leading-[1.7] text-[#ececec] text-right">
                      {message.content.trim()}
                    </p>
                  </div>
                  <div className="mt-2 flex min-h-[24px] items-center gap-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                    <ChatCopyButton className="h-6 w-6 text-[#8e8e8e]/50 hover:text-[#ececec] p-1 scale-90" content={message.content} />
                  </div>
                </div>
              ) : (
                <div className="flex w-full items-start">
                  <div className="min-w-0 flex-1">
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
          <div className="flex w-full items-start gap-4 animate-in fade-in duration-300">
            <div className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-md border border-[#1a1a1a] bg-[#0d0d0d]">
               <img src="/lokidoki-logo.svg" alt="LokiDoki" className="h-[18px] w-[18px] opacity-80" />
            </div>
            <div className="flex-1 pt-1">
              <span className="text-[13px] font-medium text-[#8e8e8e] animate-pulse">Thinking...</span>
              <div className="mt-2 w-full">
                <ChatTypingIndicator />
              </div>
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
