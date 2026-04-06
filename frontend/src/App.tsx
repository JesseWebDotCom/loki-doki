import React, { useState, useRef, useEffect } from 'react';
import { Send, Cpu, Ghost, Layers, Timer, Zap } from 'lucide-react';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

const App: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'LokiDoki Core initialized. System ready for agentic orchestration.', timestamp: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  const [phase, setPhase] = useState<'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis'>('idle');
  
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const handleSend = () => {
    if (!input.trim()) return;
    
    // Add user message
    const userMsg: Message = { role: 'user', content: input, timestamp: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    
    // Mock Agentic Flow
    simulateAgenticFlow();
  };

  const simulateAgenticFlow = async () => {
    const phases: Array<'augmentation' | 'decomposition' | 'routing' | 'synthesis'> = ['augmentation', 'decomposition', 'routing', 'synthesis'];
    
    for (const p of phases) {
      setPhase(p);
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    
    // Add assistant response
    const assistantMsg: Message = { 
      role: 'assistant', 
      content: 'I have processed your request through the agentic pipeline. Phase 1 synthesis complete.', 
      timestamp: new Date().toLocaleTimeString() 
    };
    setMessages(prev => [...prev, assistantMsg]);
    setPhase('idle');
  };

  return (
    <div className="flex h-screen w-screen bg-[#0c0d0e] text-gray-200 overflow-hidden font-sans">
      {/* Sidebar - Visual Execution Timeline */}
      <aside className="w-80 border-r border-gray-800/50 bg-[#090a0b] flex flex-col p-6">
        <div className="flex items-center gap-3 mb-8">
          <Ghost className="text-blue-500 w-6 h-6" />
          <h2 className="text-lg font-bold tracking-tight text-white">Live Execution</h2>
        </div>

        <div className="flex-1 space-y-6">
          <PhaseItem label="Augmentation" active={phase === 'augmentation'} done={['decomposition', 'routing', 'synthesis'].includes(phase)} />
          <PhaseItem label="Decomposition" active={phase === 'decomposition'} done={['routing', 'synthesis'].includes(phase)} />
          <PhaseItem label="Skill Routing" active={phase === 'routing'} done={['synthesis'].includes(phase)} />
          <PhaseItem label="Synthesis" active={phase === 'synthesis'} done={false} />
        </div>

        <div className="mt-auto pt-6 border-t border-gray-800/30">
          <div className="flex items-center justify-between text-[10px] uppercase tracking-widest text-gray-500 mb-4 font-bold">
            <span>Hardware Metrics</span>
            <span className="text-blue-500">Resident</span>
          </div>
          <MetricItem icon={<Cpu size={14}/>} label="Gemma 2B" value="4.2GB" />
          <MetricItem icon={<Layers size={14}/>} label="KV Cache" value="128MB" />
          <MetricItem icon={<Timer size={14}/>} label="Latency" value="420ms" />
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col relative bg-[#0c0d0e]">
        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-8 space-y-8 scroll-smooth">
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-2xl px-6 py-4 rounded-2xl ${
                msg.role === 'user' 
                  ? 'bg-blue-600/10 border border-blue-500/20 text-gray-200' 
                  : 'bg-[#131416] border border-gray-800 text-gray-300'
              }`}>
                <div className="text-[10px] uppercase tracking-widest text-gray-500 mb-1 font-bold">
                  {msg.role} • {msg.timestamp}
                </div>
                <div className="leading-relaxed">{msg.content}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Input Area */}
        <div className="p-8 border-t border-gray-800/30 bg-[#0c0d0e]/80 backdrop-blur-md">
          <div className="max-w-3xl mx-auto relative group">
            <input 
              type="text" 
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Interact with the LokiDoki agentic pipeline..."
              className="w-full bg-[#131416] border border-gray-800 rounded-2xl py-4 pl-6 pr-14 focus:outline-none focus:border-blue-500/50 transition-all placeholder-gray-600 shadow-2xl"
            />
            <button 
              onClick={handleSend}
              className="absolute right-3 top-3 p-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl transition-all shadow-lg shadow-blue-900/20"
            >
              <Send size={18} />
            </button>
          </div>
          <div className="text-center mt-4 text-[9px] text-gray-600 uppercase tracking-[0.3em] font-medium font-sans">
            Phase 1 Chat Interface • Autonomous Intelligence
          </div>
        </div>
      </main>
    </div>
  );
};

const PhaseItem: React.FC<{ label: string; active: boolean; done: boolean }> = ({ label, active, done }) => (
  <div className={`flex items-center gap-4 transition-all duration-500 ${active ? 'opacity-100' : 'opacity-40'}`}>
    <div className={`w-2 h-2 rounded-full ${done ? 'bg-green-500' : active ? 'bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)] animate-pulse' : 'bg-gray-700'}`} />
    <span className={`text-sm font-medium ${active ? 'text-white translate-x-1 transition-transform' : 'text-gray-400'}`}>{label}</span>
    {active && <Zap size={14} className="text-yellow-500 animate-bounce ml-auto" />}
  </div>
);

const MetricItem: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="flex items-center justify-between py-2 border-b border-gray-800/30 last:border-0">
    <div className="flex items-center gap-2 text-gray-500 text-xs">
      {icon} <span>{label}</span>
    </div>
    <span className="text-xs font-mono text-gray-300">{value}</span>
  </div>
);

export default App;
