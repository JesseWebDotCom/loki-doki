import React, { useRef, useEffect } from 'react';
import MessageItem from './MessageItem';
import ThinkingIndicator from './ThinkingIndicator';
import RiggedDicebearAvatar from '../character/RiggedDicebearAvatar';
import type { HeadTiltState } from '../character/useHeadTilt';
import type { CharacterRow } from '../../lib/api';
import type { PipelineState, Message } from '../../pages/ChatPage';

interface ChatWindowProps {
  messages: Message[];
  pipeline?: PipelineState;
  activeChar?: CharacterRow | null;
  characterState?: HeadTiltState;
}

const ChatWindow: React.FC<ChatWindowProps> = ({ messages, pipeline, activeChar, characterState }) => {
  const renderAvatar = (state: HeadTiltState) =>
    activeChar ? (
      <div className="shrink-0 w-16 h-16 rounded-2xl bg-card/60 border border-border/30 shadow-m2 flex items-center justify-center overflow-hidden">
        <RiggedDicebearAvatar
          style={activeChar.avatar_style}
          seed={activeChar.avatar_seed}
          baseOptions={activeChar.avatar_config as Record<string, unknown>}
          size={60}
          tiltState={state}
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
        {messages.map((msg, idx) => (
          <React.Fragment key={idx}>
            {msg.pipeline && <ThinkingIndicator pipeline={msg.pipeline} />}
            <MessageItem
              {...msg}
              messageKey={`msg-${idx}`}
              avatar={msg.role === 'assistant' ? renderAvatar(characterState ?? 'idle') : undefined}
            />
          </React.Fragment>
        ))}
        {isThinking && <ThinkingIndicator pipeline={pipeline} />}
        {isThinking && pipeline?.streamingResponse && (
          <MessageItem
            role="assistant"
            content={pipeline.streamingResponse}
            timestamp=""
            sources={[]}
            avatar={renderAvatar(characterState ?? 'thinking')}
          />
        )}
      </div>
    </div>
  );
};

export default ChatWindow;
