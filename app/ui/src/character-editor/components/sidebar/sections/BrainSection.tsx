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

  const controlBaseClass = "h-9 rounded-lg border text-[9px] font-black uppercase transition-all";

  return (
    <section id="brain" className="space-y-3">
      <h3 className="flex items-center gap-2 px-1 text-[9px] font-black uppercase text-[var(--app-accent-warm)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
        <BrainCircuit className="w-2.5 h-2.5" /> Bio-Brain Controller v2.3
      </h3>
      <div className="space-y-4 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-4 shadow-[var(--app-shadow-soft)]">
        <div className="relative overflow-hidden rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] p-3 transition-all duration-300">
          <div className="relative flex items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase text-[var(--app-text)]">
                {isListening ? <Mic className="w-3 h-3 text-emerald-400" /> : <MicOff className="w-3 h-3 text-[var(--app-text-muted)]" />}
                Audio Engine
              </span>
              <span className="shrink-0 text-[8px] font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-micro-letter-spacing)" }}>Hearing: {audioEngineLabel}</span>
            </div>
            <Button 
              variant={isListening ? "default" : "secondary"}
              size="sm"
              className={`h-7 px-3 text-[9px] font-black uppercase rounded-lg shadow-lg relative z-10
                 ${isListening ? 'border-none bg-emerald-600 text-white hover:bg-emerald-700' : status === 'error' ? 'border border-rose-500/30 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20' : 'border border-[color:var(--app-border)] bg-[color:var(--app-bg)] text-[var(--app-text-muted)] hover:bg-[color:var(--app-accent-soft)] hover:text-[var(--app-text)]'}
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
          <Button onClick={() => sendToBrain({ type: 'RESET_IDLE' })} className={`${controlBaseClass} border-emerald-500/20 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/18`}>
            Wake Unit
          </Button>
          <Button onClick={() => sendToBrain({ type: 'FORCE_SICK' })} className={`${controlBaseClass} ${bodyState === 'sick' ? 'border-none bg-orange-600 text-white' : 'border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-orange-400 hover:bg-orange-500/12'}`}>
            <Thermometer className="w-3 h-3 mr-1" /> Sick
          </Button>
        </div>
        <div className="grid grid-cols-3 gap-2">
           <Button onClick={() => sendToBrain({ type: 'FORCE_THINKING' })} className={`${controlBaseClass} ${bodyState === 'thinking' ? 'border-none bg-[var(--app-accent)] text-white' : 'border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[var(--app-accent)] hover:bg-[color:var(--app-accent-soft)]'}`}>
             Think
           </Button>
           <Button onClick={() => sendToBrain({ type: 'FORCE_DOZING' })} className={`${controlBaseClass} ${bodyState === 'dozing' ? 'border-none bg-violet-600 text-white' : 'border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-violet-300 hover:bg-violet-500/12'}`}>
             Dozing
           </Button>
           <Button onClick={() => sendToBrain({ type: 'FORCE_SLEEP' })} className={`${controlBaseClass} ${bodyState === 'sleep' ? 'border-none bg-indigo-700 text-white' : 'border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-indigo-300 hover:bg-indigo-500/12'}`}>
             Sleep
           </Button>
        </div>
      </div>
    </section>
  );
};
