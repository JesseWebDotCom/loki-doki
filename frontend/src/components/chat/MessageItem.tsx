import React from 'react';

interface MessageProps {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

const MessageItem: React.FC<MessageProps> = ({ role, content, timestamp }) => {
  const isUser = role === 'user';
  
  return (
    <div className={`flex w-full mb-8 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[80%] rounded-2xl px-6 py-4 border transition-all duration-300 shadow-m3 ${
        isUser 
          ? 'bg-primary/10 border-primary/20 text-foreground' 
          : 'bg-card border-border/40 text-foreground'
      }`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-[10px] font-bold uppercase tracking-widest ${isUser ? 'text-primary' : 'text-muted-foreground'}`}>
            {role}
          </span>
          <span className="text-[10px] text-muted-foreground/50 font-mono italic">{timestamp}</span>
        </div>
        <div className={`text-[15px] leading-relaxed whitespace-pre-wrap font-medium tracking-tight`}>
          {content}
        </div>
      </div>
    </div>
  );
};

export default MessageItem;
