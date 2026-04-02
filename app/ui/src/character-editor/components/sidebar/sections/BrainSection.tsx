import React from 'react';
import { BrainCircuit, Mic, MicOff, ShieldCheck, Activity, Zap, SlidersHorizontal, Thermometer, Brain } from 'lucide-react';
import { Button } from "@/character-editor/components/ui/button";
import { Input } from "@/character-editor/components/ui/input";

interface BrainSectionProps {
  isListening: boolean;
  status: 'idle' | 'requesting' | 'listening' | 'error';
  errorMessage: string | null;
  startListening: () => void;
  stopListening: () => void;
  volume: number;
  sensitivity: number;
  setSensitivity: (v: number) => void;
  viseme: string;
  voiceIsolation: boolean;
  setVoiceIsolation: (v: boolean) => void;
  reflexesEnabled: boolean;
  setReflexesEnabled: (v: boolean) => void;
  bodyState: string;
  sendToBrain: (event: any) => void;
}

export const BrainSection: React.FC<BrainSectionProps> = ({
  isListening, status, errorMessage, startListening, stopListening,
  volume, sensitivity, setSensitivity, viseme, voiceIsolation, setVoiceIsolation,
  reflexesEnabled, setReflexesEnabled, bodyState, sendToBrain
}) => {
  const audioEngineLabel = 
    status === 'listening' ? 'Online' : 
    status === 'requesting' ? 'Requesting Mic' : 
    status === 'error' ? 'Mic Blocked' : 'Mic Ready';

  const audioEngineActionLabel = 
    status === 'listening' ? 'Stop' : 
    status === 'requesting' ? 'Waiting' : 
    status === 'error' ? 'Retry' : 'Enable';

  return (
    <section id="brain" className="space-y-3">
      <h3 className="text-[9px] font-black text-amber-500 uppercase tracking-[0.2em] flex items-center gap-2 px-1">
        <BrainCircuit className="w-2.5 h-2.5" /> Bio-Brain Controller v2.3
      </h3>
      <div className="bg-slate-950/40 p-4 rounded-2xl border border-amber-500/10 shadow-inner space-y-4">
        <div className="relative overflow-hidden rounded-xl bg-slate-900/50 p-3 border border-white/5 transition-all duration-300">
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-bold text-slate-200 uppercase flex items-center gap-1.5">
                {isListening ? <Mic className="w-3 h-3 text-emerald-400" /> : <MicOff className="w-3 h-3 text-slate-500" />}
                Audio Engine
              </span>
              <span className="text-[8px] text-slate-500 font-bold uppercase tracking-tighter shrink-0">Hearing: {audioEngineLabel}</span>
            </div>
            <Button 
              variant={isListening ? "default" : "secondary"}
              size="sm"
              className={`h-7 px-3 text-[9px] font-black uppercase rounded-lg shadow-lg relative z-10
                 ${isListening ? 'bg-emerald-600 hover:bg-emerald-700 text-white border-none' : status === 'error' ? 'bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30' : 'bg-slate-950 hover:bg-slate-800 text-slate-400 border border-white/5'}
              `}
              disabled={status === 'requesting'}
              onClick={isListening ? stopListening : startListening}
            >
              {audioEngineActionLabel}
            </Button>
          </div>
          {errorMessage && (
            <div className="relative mt-3 text-[9px] font-bold leading-relaxed text-rose-300">
              Mic access failed: {errorMessage}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => sendToBrain({ type: 'RESET_IDLE' })} className="h-9 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-500 text-[9px] font-black uppercase rounded-lg border border-emerald-500/20">
            Wake Unit
          </Button>
          <Button onClick={() => sendToBrain({ type: 'FORCE_SICK' })} className={`h-9 text-[9px] font-black uppercase rounded-lg border transition-all ${bodyState === 'sick' ? 'bg-orange-600 text-white border-none' : 'bg-slate-900 hover:bg-slate-800 text-orange-400 border-white/5'}`}>
            <Thermometer className="w-3 h-3 mr-1" /> Sick
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
           <Button onClick={() => sendToBrain({ type: 'FORCE_THINKING' })} className={`h-9 text-[9px] font-black uppercase rounded-lg border transition-all ${bodyState === 'thinking' ? 'bg-sky-600 text-white border-none' : 'bg-slate-900 hover:bg-slate-800 text-sky-400 border-white/5'}`}>
             Think
           </Button>
           <Button onClick={() => sendToBrain({ type: 'FORCE_DOZING' })} className={`h-9 text-[9px] font-black uppercase rounded-lg border transition-all ${bodyState === 'dozing' ? 'bg-violet-600 text-white border-none' : 'bg-slate-900 hover:bg-slate-800 text-violet-400 border-white/5'}`}>
             Dozing
           </Button>
           <Button onClick={() => sendToBrain({ type: 'FORCE_SLEEP' })} className={`h-9 text-[9px] font-black uppercase rounded-lg border transition-all ${bodyState === 'sleep' ? 'bg-indigo-700 text-white border-none' : 'bg-slate-900 hover:bg-slate-800 text-indigo-400 border-white/5'}`}>
             Sleep
           </Button>
        </div>
      </div>
    </section>
  );
};
