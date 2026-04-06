import React, { useState, useCallback } from 'react';
import { Send } from 'lucide-react';
import Sidebar from '../components/sidebar/Sidebar';
import ChatWindow from '../components/chat/ChatWindow';
import { sendChatMessage } from '../lib/api';
import type { PipelineEvent, DecompositionData, SynthesisData, SourceInfo } from '../lib/api';

export interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  sources?: SourceInfo[];
  pipeline?: PipelineState;
}

export interface PipelineState {
  phase: 'idle' | 'augmentation' | 'decomposition' | 'routing' | 'synthesis' | 'completed';
  decomposition: DecompositionData | null;
  synthesis: SynthesisData | null;
  totalLatencyMs: number;
}

const INITIAL_PIPELINE: PipelineState = {
  phase: 'idle',
  decomposition: null,
  synthesis: null,
  totalLatencyMs: 0,
};

const ChatPage: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'LokiDoki Core initialized. System ready for agentic orchestration.', timestamp: new Date().toLocaleTimeString() }
  ]);
  const [input, setInput] = useState('');
  const [pipeline, setPipeline] = useState<PipelineState>(INITIAL_PIPELINE);
  const [isProcessing, setIsProcessing] = useState(false);

  const handleEvent = useCallback((event: PipelineEvent) => {
    setPipeline(prev => {
      const next = { ...prev, phase: event.phase as PipelineState['phase'] };

      if (event.phase === 'decomposition' && event.status === 'done') {
        next.decomposition = event.data as DecompositionData;
      }
      if (event.phase === 'synthesis' && event.status === 'done') {
        next.synthesis = event.data as SynthesisData;
        const decompMs = next.decomposition?.latency_ms ?? 0;
        const synthMs = (event.data as SynthesisData).latency_ms ?? 0;
        next.totalLatencyMs = decompMs + synthMs;
      }

      return next;
    });
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;

    const userMsg: Message = { role: 'user', content: input, timestamp: new Date().toLocaleTimeString() };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setIsProcessing(true);
    setPipeline({ ...INITIAL_PIPELINE, phase: 'augmentation' });

    try {
      await sendChatMessage(input, handleEvent);

      setPipeline(prev => {
        if (prev.synthesis?.response) {
          const completedPipeline: PipelineState = { ...prev, phase: 'completed' as PipelineState['phase'] };
          setMessages(msgs => [...msgs, {
            role: 'assistant',
            content: prev.synthesis!.response,
            timestamp: new Date().toLocaleTimeString(),
            sources: prev.synthesis!.sources ?? [],
            pipeline: completedPipeline,
          }]);
        }
        return { ...prev, phase: 'idle' };
      });
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `Pipeline error: ${err instanceof Error ? err.message : 'Unknown error'}. Is Ollama running?`,
        timestamp: new Date().toLocaleTimeString(),
      }]);
      setPipeline({ ...INITIAL_PIPELINE });
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase={pipeline.phase} pipeline={pipeline} />

      <main className="flex-1 flex flex-col relative bg-background shadow-inner">
        <ChatWindow messages={messages} pipeline={pipeline} />

        <div className="p-10 bg-background/50 backdrop-blur-xl border-t border-border/20">
          <div className="max-w-4xl mx-auto relative group">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              placeholder="Interact with the LokiDoki agentic pipeline..."
              disabled={isProcessing}
              className="w-full bg-card/50 border border-border/50 rounded-2xl py-5 pl-8 pr-16 focus:outline-none focus:border-primary/50 focus:ring-4 focus:ring-primary/5 transition-all placeholder-gray-700 shadow-m4 text-lg font-medium disabled:opacity-50"
            />
            <button
              onClick={handleSend}
              disabled={isProcessing}
              className="absolute right-4 top-4 p-3 bg-primary hover:bg-primary/90 text-white rounded-xl transition-all shadow-m2 shadow-primary/20 active:scale-95 disabled:opacity-50"
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
