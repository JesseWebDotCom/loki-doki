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
      <h3 className="flex items-center gap-2 px-1 text-[9px] font-black uppercase text-[var(--app-accent)]" style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
        <Mic className="w-2.5 h-2.5" /> Neural Voice Unit (Piper)
      </h3>
      <div className="space-y-4 rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] p-4 shadow-[var(--app-shadow-soft)]">
        <div className="flex items-center justify-between gap-4 rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] px-2.5 py-1.5">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 text-[9px] font-black uppercase text-[var(--app-text)]">
              <Activity className={`w-3.5 h-3.5 ${status === 'connected' ? 'text-[var(--app-accent)]' : 'text-rose-500'}`} />
              Backend Status
            </span>
            <span className="shrink-0 text-[8px] font-bold uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-micro-letter-spacing)" }}>{status.toUpperCase()}</span>
          </div>
          <div className={`h-2.5 w-2.5 rounded-full ${status === 'connected' ? 'bg-[var(--app-accent)]' : 'bg-rose-500'} animate-pulse`} />
        </div>
        <div className="space-y-2">
          <label className="px-1 text-[8px] font-black uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-micro-letter-spacing)" }}>TTS Test String</label>
          <Input 
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            className="h-auto rounded-xl border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] p-3 text-[11px] text-[var(--app-text)] outline-hidden"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button 
            onClick={() => speak(testText)}
            disabled={status !== 'connected' || isSpeaking}
            className="h-10 rounded-xl border-none bg-[var(--app-accent)] text-[10px] font-black uppercase !text-white shadow-lg hover:bg-[var(--app-accent-strong)] disabled:bg-[color:var(--app-bg-panel-strong)] disabled:!text-[var(--app-text-muted)] disabled:opacity-100"
          >
            {isSpeaking ? 'Speaking...' : 'Speak Text'}
          </Button>
          <Button onClick={stop} variant="secondary" className="h-10 rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel-strong)] text-[10px] uppercase !text-[var(--app-text)] hover:bg-[color:var(--app-accent-soft)]">Stop</Button>
        </div>
      </div>
    </section>
  );
};
