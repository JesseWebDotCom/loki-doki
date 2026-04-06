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
      <div className={`max-w-[80%] rounded-2xl px-6 py-4 shadow-xl border transition-all duration-300 ${
        isUser 
          ? 'bg-electric/10 border-electric/20 text-gray-200' 
          : 'bg-[#131416] border-gray-800 text-gray-300'
      }`}>
        <div className="flex items-center gap-2 mb-2">
          <span className={`text-[10px] font-bold uppercase tracking-widest ${isUser ? 'text-electric' : 'text-gray-500'}`}>
            {role}
          </span>
          <span className="text-[10px] text-gray-600 font-mono italic">{timestamp}</span>
        </div>
        <div className="text-[15px] leading-relaxed whitespace-pre-wrap font-medium tracking-tight">
          {content}
        </div>
      </div>
    </div>
  );
};

export default MessageItem;
