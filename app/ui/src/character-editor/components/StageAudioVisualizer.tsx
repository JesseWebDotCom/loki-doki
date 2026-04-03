import { useMemo } from 'react';

import { useAudio } from '@/character-editor/context/AudioContext';

const BAR_COUNT = 18;

export default function StageAudioVisualizer() {
  const { frequencyData, isListening, isSpeaking, volume, peakVolume } = useAudio();

  const bars = useMemo(() => {
    if (frequencyData && frequencyData.length > 0) {
      const bucketSize = Math.max(1, Math.floor(frequencyData.length / BAR_COUNT));
      return Array.from({ length: BAR_COUNT }, (_, index) => {
        const start = index * bucketSize;
        const slice = frequencyData.slice(start, start + bucketSize);
        const average = slice.length
          ? slice.reduce((sum, value) => sum + value, 0) / slice.length
          : 0;
        return Math.max(0.08, average / 255);
      });
    }

    const baseline = isListening ? Math.max(volume, peakVolume * 0.75, 0.1) : 0.08;
    return Array.from({ length: BAR_COUNT }, (_, index) => {
      const wave = 0.14 + Math.abs(Math.sin((index / BAR_COUNT) * Math.PI * 1.8)) * 0.4;
      return Math.max(0.08, Math.min(1, baseline * wave * 2.2));
    });
  }, [frequencyData, isListening, peakVolume, volume]);

  return (
    <div className="rounded-2xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)] px-3 py-2">
      <div className="mb-2 flex items-center justify-between">
        <div className="text-[8px] font-black uppercase text-[var(--app-text-muted)]" style={{ letterSpacing: "var(--app-micro-letter-spacing)" }}>Audio Visualizer</div>
        <div className={`text-[8px] font-black uppercase ${isSpeaking ? 'text-emerald-400' : isListening ? 'text-[var(--app-accent)]' : 'text-[var(--app-text-muted)]'}`} style={{ letterSpacing: "var(--app-label-letter-spacing)" }}>
          {isSpeaking ? 'Speech Active' : isListening ? 'Mic Monitoring' : 'Idle'}
        </div>
      </div>
      <div className="flex h-12 items-end gap-1">
        {bars.map((bar, index) => (
          <div
            key={index}
            className="flex-1 rounded-full transition-all duration-100"
            style={{
              height: `${Math.max(10, bar * 100)}%`,
              background: isSpeaking
                ? 'linear-gradient(180deg, rgba(16,185,129,0.95) 0%, rgba(14,165,233,0.85) 100%)'
                : isListening
                  ? 'linear-gradient(180deg, rgba(56,189,248,0.95) 0%, rgba(59,130,246,0.8) 100%)'
                  : 'linear-gradient(180deg, color-mix(in srgb, var(--app-text-muted) 75%, transparent) 0%, color-mix(in srgb, var(--app-bg-panel-strong) 92%, black 8%) 100%)',
            }}
          />
        ))}
      </div>
    </div>
  );
}
