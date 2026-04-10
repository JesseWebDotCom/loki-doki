import React, { useRef, useEffect } from 'react';
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
  userName?: string;
  onRetry?: (messageIndex: number) => void;
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
  userName,
  onRetry,
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

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, pipeline?.phase]);

  const isThinking = pipeline && pipeline.phase !== 'idle';

  return (
    <div
      ref={scrollRef}
      className="flex-1 overflow-y-auto p-12 space-y-4 scroll-smooth scrollbar-hide bg-background"
    >
      <div className="max-w-4xl mx-auto">
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
                userName={userName}
                onRetry={onRetry ? () => onRetry(idx) : undefined}
              />
            </React.Fragment>
          );
        })}
        {isThinking && (
          <ThinkingIndicator
            pipeline={pipeline}
            avatar={renderAvatar(characterState ?? 'thinking')}
            assistantName={assistantName}
          />
        )}
        {isThinking && pipeline?.streamingResponse && (
          <MessageItem
            role="assistant"
            content={pipeline.streamingResponse}
            timestamp=""
            sources={[]}
            avatar={renderAvatar(characterState ?? 'thinking')}
            assistantName={assistantName}
            userName={userName}
          />
        )}
      </div>
    </div>
  );
};

export default ChatWindow;
