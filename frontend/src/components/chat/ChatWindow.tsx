import React, { useRef, useEffect } from 'react';
import MessageItem from './MessageItem';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

interface ChatWindowProps {
  messages: Message[];
}

const ChatWindow: React.FC<ChatWindowProps> = ({ messages }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div 
      ref={scrollRef} 
      className="flex-1 overflow-y-auto p-12 space-y-4 scroll-smooth scrollbar-hide bg-background"
    >
      <div className="max-w-4xl mx-auto">
        {messages.map((msg, idx) => (
          <MessageItem key={idx} {...msg} />
        ))}
      </div>
    </div>
  );
};

export default ChatWindow;
