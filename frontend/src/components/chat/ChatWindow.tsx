import React, { useRef, useEffect } from 'react';
import MessageItem from './MessageItem';
import ThinkingIndicator from './ThinkingIndicator';
import type { PipelineState, Message } from '../../pages/ChatPage';

interface ChatWindowProps {
  messages: Message[];
  pipeline?: PipelineState;
}

const ChatWindow: React.FC<ChatWindowProps> = ({ messages, pipeline }) => {
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
          <MessageItem key={idx} {...msg} />
        ))}
        {isThinking && <ThinkingIndicator pipeline={pipeline} />}
      </div>
    </div>
  );
};

export default ChatWindow;
