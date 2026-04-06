import React, { useState } from 'react';
import { Send } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWindow from '../components/chat/ChatWindow';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

const ChatPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'LokiDoki Core initialized. System ready for agentic orchestration.', timestamp: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis'>('idle');

  const handleSend = () => {
    if (!input.trim()) return;
    
    const userMsg: Message = { role: 'user', content: input, timestamp: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    
    simulateAgenticFlow();
  };

  const simulateAgenticFlow = async () => {
    const phases: Array<'augmentation' | 'decomposition' | 'routing' | 'synthesis'> = [
      'augmentation', 'decomposition', 'routing', 'synthesis'
    ];
    
    for (const p of phases) {
      setPhase(p);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    const assistantMsg: Message = { 
      role: 'assistant', 
      content: 'I have processed your request through the agentic pipeline. Phase 1 synthesis complete.', 
      timestamp: new Date().toLocaleTimeString() 
    };
    setMessages(prev => [...prev, assistantMsg]);
    setPhase('idle');
  };

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase={phase} />

      <main className="flex-1 flex flex-col relative bg-background shadow-inner">
        <ChatWindow messages={messages} />

        <div className="p-10 bg-background/50 backdrop-blur-xl border-t border-border/20">
          <div className="max-w-4xl mx-auto relative group">
            <input 
              type="text" 
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Interact with the LokiDoki agentic pipeline..."
              className="w-full bg-card/50 border border-border/50 rounded-2xl py-5 pl-8 pr-16 focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all placeholder-gray-700 shadow-m4 text-lg font-medium"
            />
            <button 
              onClick={handleSend}
              className="absolute right-4 top-4 p-3 bg-primary hover:bg-primary/90 text-white rounded-xl transition-all shadow-m2 shadow-primary/20 active:scale-95"
            >
              <Send size={20} />
            </button>
          </div>
          
          <div className="text-center mt-6 flex items-center justify-center gap-4">
            <span className="h-[1px] w-12 bg-border/50" />
            <div className="text-[10px] text-muted-foreground uppercase tracking-[0.4em] font-bold font-sans">
              Onyx Material Orchestration 
            </div>
            <span className="h-[1px] w-12 bg-border/50" />
          </div>
        </div>
      </main>
    </div>
  );
};

export default ChatPage;
