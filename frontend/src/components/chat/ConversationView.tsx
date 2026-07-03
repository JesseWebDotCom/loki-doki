import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { Wand2 } from 'lucide-react'
import { useImageGenStatus } from '@/hooks/useImageGenStatus'
import { MessageList } from '@/components/chat/MessageList'
import { useChatContext } from '@/context/ChatContext'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { CompanionComposer } from '@/components/shell/CompanionComposer'
import { useCompanionEngine } from '@/components/shell/CompanionEngineContext'
import { useLoadConversation } from './useLoadConversation'

/** The active conversation pane - message stream for /chat and /chat/:id. */
export function ConversationView() {
  const { id } = useParams<{ id: string }>()
  const { messages, isGenerating, conversationId, conversations, currentProject, pendingAutoPrompt, clearPendingAutoPrompt, submit } = useChatContext()

  // Consume a prompt queued by an external page (e.g. I'm Bored) - runs with fresh
  // context values so there's no stale-closure issue with conversationId.
  useEffect(() => {
    if (!pendingAutoPrompt || id) return
    const text = pendingAutoPrompt
    clearPendingAutoPrompt()
    submit(undefined, text)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAutoPrompt])

  useLoadConversation(id)

  const imageGenState = useImageGenStatus()
  // The chat page owns a real composer; sends route through the shared companion
  // engine so stop-command interception, voice priming, and Stop behave exactly
  // like the sidebar dock's flyout composer.
  const engine = useCompanionEngine()

  const activeConvTitle = conversations.find((c) => c.id === conversationId)?.title ?? null
  const chatContextDesc = conversationId && activeConvTitle
    ? `User is in the Chat app${currentProject ? `, project "${currentProject.name}"` : ''}, reading conversation "${activeConvTitle}". ${messages.length} messages so far.`
    : currentProject
      ? `User is in the Chat app, project "${currentProject.name}", starting a new conversation.`
      : 'User is in the Chat app, starting a new conversation.'
  usePublishUIContext({ label: 'Chat', description: chatContextDesc })

  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {imageGenState === 'warming' && (
        <div className="shrink-0 flex items-center gap-1.5 px-4 py-1.5 bg-warning/10 border-b border-warning/20 text-xs text-warning">
          {/* design-ok(adhoc-pulse): typing-indicator-style activity affordance, not a loading skeleton */}
          <Wand2 className="size-3 animate-pulse shrink-0" />
          <span>Image generation warming up - model loading into memory…</span>
        </div>
      )}
      <MessageList messages={messages} isGenerating={isGenerating} className="flex-1" />

      {/* Static bottom composer, pinned under the message stream */}
      <div className="shrink-0 glass-chrome border-t border-border/50 px-4 pb-3 pt-3">
        <CompanionComposer
          onSend={engine.handleSend}
          onStop={engine.onStop}
          isGenerating={engine.busy}
          isThinking={engine.thinking}
          autoFocus
          focusKey={engine.focusKey}
          placeholder={engine.character ? `Ask ${engine.character.name}…` : 'Message LokiDoki…'}
        />
      </div>
    </div>
  )
}
