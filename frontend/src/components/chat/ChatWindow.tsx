import React, { useRef, useEffect, useState, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import MessageItem from './MessageItem';
import ThinkingIndicator from './ThinkingIndicator';
import CharacterFrame, { type CharacterMode } from '../character/CharacterFrame';
import type { HeadTiltState } from '../character/useHeadTilt';
import type { CharacterRow } from '../../lib/api';
import type { PipelineState, Message } from '../../pages/ChatPage';

interface ChatWindowProps {
  messages: Message[];
  pipeline?: PipelineState;
  activeChar?: CharacterRow | null;
  characterState?: HeadTiltState;
  characterMode?: CharacterMode;
  onCharacterModeChange?: (m: CharacterMode) => void;
  onCharacterShock?: () => void;
  activeAssistantKey?: string | null;
  assistantName?: string;
  onRetry?: (messageIndex: number) => void;
  onOpenSources?: (messageIndex: number) => void;
}

const ChatWindow: React.FC<ChatWindowProps> = ({
  messages,
  pipeline,
  activeChar,
  characterState,
  characterMode,
  onCharacterModeChange,
  onCharacterShock,
  activeAssistantKey,
  assistantName,
  onRetry,
  onOpenSources,
}) => {
  // Per-message mini avatars only render in mini mode. Docked mode
  // shows the big right-column avatar instead, and rendering both at
  // once wastes a lot of DiceBear cycles.
  const renderAvatar = (state: HeadTiltState) =>
    activeChar && characterMode === 'mini' && onCharacterModeChange && onCharacterShock ? (
      <div className="shrink-0">
        <CharacterFrame
          character={activeChar}
          size={60}
          state={state}
          mode={characterMode}
          onModeChange={onCharacterModeChange}
          onShock={onCharacterShock}
        />
      </div>
    ) : null;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  const handleScroll = useCallback(() => {
    if (scrollRef.current) {
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      // Show button if we are more than 300px away from the bottom
      const isScrolledUp = scrollHeight - scrollTop - clientHeight > 300;
      setShowScrollButton(isScrolledUp);
    }
  }, []);

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      // Auto-scroll to bottom on new messages or pipeline phase change
      // UNLESS the user is manually scrolled up.
      const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
      const isAtBottom = scrollHeight - scrollTop - clientHeight < 150;

      if (isAtBottom || (pipeline?.phase !== 'idle' && pipeline?.phase !== 'completed')) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }
    // Update button visibility whenever the list changes
    handleScroll();
  }, [messages, pipeline?.phase, handleScroll]);

  const isThinking = pipeline && pipeline.phase !== 'idle';

  return (
    <div className="flex-1 min-h-0 relative flex flex-col group/chat">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-[var(--app-shell-gutter)] pt-10 pb-4 scroll-smooth scrollbar-hide bg-background sm:pt-12"
      >
        <div
          className="mx-auto space-y-6"
          style={{ maxWidth: 'var(--app-content-max)' }}
        >
          {messages.map((msg, idx) => {
            const myKey = `msg-${idx}`;
            // Mini mode renders ONE avatar in the whole chat, attached
            // to whichever assistant message is currently active (the
            // one being TTS-played, or the latest if nothing is playing).
            // Every other message gets no avatar at all so the column
            // doesn't fill up with sleeping faces.
            const isActive = msg.role === 'assistant' && myKey === activeAssistantKey;
            return (
              <React.Fragment key={idx}>
                <MessageItem
                  {...msg}
                  messageKey={myKey}
                  avatar={isActive ? renderAvatar(characterState ?? 'idle') : undefined}
                  assistantName={assistantName}
                  onRetry={onRetry ? () => onRetry(idx) : undefined}
                  onOpenSources={onOpenSources ? () => onOpenSources(idx) : undefined}
                />
              </React.Fragment>
            );
          })}
          {isThinking && (
            <ThinkingIndicator
              pipeline={pipeline}
              avatar={renderAvatar(characterState ?? 'thinking')}
            />
          )}
          {isThinking && pipeline?.streamingResponse && (
            <MessageItem
              role="assistant"
              content={pipeline.streamingResponse}
              timestamp={new Date().toISOString()}
              sources={[]}
              avatar={renderAvatar(characterState ?? 'thinking')}
              assistantName={assistantName}
            />
          )}
        </div>
      </div>

      {/* Floating Scroll to Bottom Button */}
      <div
        className={`absolute bottom-10 left-1/2 -translate-x-1/2 transition-all duration-500 ease-out pointer-events-none ${
          showScrollButton ? 'opacity-100 translate-y-0 scale-100' : 'opacity-0 translate-y-8 scale-50'
        }`}
      >
        <button
          onClick={scrollToBottom}
          className="pointer-events-auto flex h-14 w-14 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-primary/95 text-primary-foreground shadow-m4 ring-4 ring-primary/10 transition-all backdrop-blur-md hover:bg-primary hover:shadow-m4 active:scale-90"
          title="Scroll to bottom"
        >
          <ArrowDown size={26} className={showScrollButton ? 'animate-bounce-subtle' : ''}/>
        </button>
      </div>
    </div>
  );
};

export default ChatWindow;
