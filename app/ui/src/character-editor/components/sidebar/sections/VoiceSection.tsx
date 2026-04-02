import React from 'react';
import { Mic, Activity } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";
import { Input } from "@/character-editor/components/ui/input";

interface VoiceSectionProps {
  speak: (text: string) => void;
  isSpeaking: boolean;
  viseme: string;
  stop: () => void;
  status: string;
  testSpeech: () => void;
}

export const VoiceSection: React.FC<VoiceSectionProps> = ({
  speak, isSpeaking, viseme, stop, status, testSpeech
}) => {
  const [testText, setTestText] = React.useState("Hello, I am Loki Doki. How can I help you today?");

  return (
    <section id="voice" className="space-y-3">
      <h3 className="text-[9px] font-black text-sky-500 uppercase tracking-[0.2em] flex items-center gap-2 px-1">
        <Mic className="w-2.5 h-2.5" /> Neural Voice Unit (Piper)
      </h3>
      <div className="bg-slate-950/40 p-4 rounded-2xl border border-sky-500/10 shadow-inner space-y-4">
        <div className="flex items-center justify-between gap-4 p-1 bg-slate-900/50 rounded-xl px-2.5 py-1.5 border border-white/5">
          <div className="flex flex-col gap-0.5">
            <span className="text-[9px] font-black text-slate-200 uppercase flex items-center gap-1.5">
              <Activity className={`w-3.5 h-3.5 ${status === 'connected' ? 'text-sky-400' : 'text-rose-500'}`} />
              Backend Status
            </span>
            <span className="text-[8px] text-slate-500 font-bold uppercase tracking-tighter shrink-0">{status.toUpperCase()}</span>
          </div>
          <div className={`w-2.5 h-2.5 rounded-full ${status === 'connected' ? 'bg-sky-500' : 'bg-rose-500'} animate-pulse`} />
        </div>
        <div className="space-y-2">
          <label className="text-[8px] font-black text-slate-500 uppercase px-1">TTS Test String</label>
          <Input 
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            className="bg-slate-900 border-white/5 text-[11px] text-slate-200 rounded-xl p-3 h-auto outline-hidden"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button 
            onClick={() => speak(testText)}
            disabled={status !== 'connected' || isSpeaking}
            className="h-10 bg-sky-600 hover:bg-sky-500 text-white text-[10px] font-black uppercase rounded-xl border-none shadow-lg"
          >
            {isSpeaking ? 'Speaking...' : 'Speak Text'}
          </Button>
          <Button onClick={stop} variant="secondary" className="h-10 text-[10px] uppercase rounded-xl">Stop</Button>
        </div>
      </div>
    </section>
  );
};
