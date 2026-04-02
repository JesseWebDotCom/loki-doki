import React, { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Minimize2, Settings2 } from 'lucide-react';
import AnimatedCharacter from './AnimatedCharacter';
import { Button } from "@/character-editor/components/ui/button";

/**
 * FullscreenKiosk — The Kiosk Presentation View (Phase 2.3)
 * High-impact, zero-latency character interaction.
 * RESTORED: Massive 1.6x Presentation Scaling.
 */
const FullscreenKiosk: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [subtitle] = useState("Loki-Doki Kiosk Mode Active. Listening for command...");
  const [fps, setFps] = useState(0);
  const [jitter, setJitter] = useState(0);
  
  const closeKiosk = useCallback(() => {
    const params = new URLSearchParams(location.search);
    const returnTo = params.get('return_to') || '/editor?embedded=1';
    navigate(returnTo);
  }, [location.search, navigate]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeKiosk();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeKiosk]);

  useEffect(() => {
    let frameId = 0;
    let previousTime = performance.now();
    let frameCount = 0;
    let accumulatedFrameTime = 0;

    const measure = (now: number) => {
      const delta = now - previousTime;
      previousTime = now;
      frameCount += 1;
      accumulatedFrameTime += delta;

      if (accumulatedFrameTime >= 1000) {
        const currentFps = (frameCount * 1000) / accumulatedFrameTime;
        setFps(currentFps);
        setJitter(Math.abs(delta - 16.67));
        frameCount = 0;
        accumulatedFrameTime = 0;
      }

      frameId = requestAnimationFrame(measure);
    };

    frameId = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frameId);
  }, []);

  return (
    <div className="fixed inset-0 h-screen w-screen bg-black overflow-hidden select-none">
      {/* 1. Kiosk Viewport (EXTREME SCALE RESTORED) */}
      <div className="absolute inset-0 flex items-center justify-center p-0 transition-all duration-1000">
         <AnimatedCharacter 
            viewPreset="full"
            stageScale={2.2} // Massive immersive presence (RESTORED/ENLARGED)
         />
      </div>

      {/* 2. Top Controls (Fades in on hover) */}
      <header className="absolute top-0 inset-x-0 h-24 flex items-center justify-between px-12 z-50 bg-gradient-to-b from-black/80 to-transparent opacity-0 hover:opacity-100 transition-opacity duration-500">
        <div className="flex items-center gap-6">
           <div className="w-3.5 h-3.5 rounded-full bg-emerald-500 animate-pulse shadow-glow shadow-emerald-500/50" />
           <div className="flex flex-col gap-1">
              <span className="text-white font-black tracking-[0.3em] text-[10px] uppercase">Kiosk Node v2.3</span>
              <span className="text-[10px] text-slate-400 font-bold tracking-tighter uppercase flex items-center gap-2">
                 <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                 Loki-Network: Connected
              </span>
           </div>
        </div>
        <div className="flex items-center gap-5">
           <Button variant="ghost" className="h-12 w-12 text-white/30 hover:text-white transition-all bg-white/5 rounded-2xl border border-white/5">
              <Settings2 className="w-6 h-6" />
           </Button>
           <Button 
             variant="ghost" 
             onClick={closeKiosk}
             className="h-14 w-14 bg-white/5 hover:bg-red-500 text-white rounded-[1.8rem] border border-white/10 backdrop-blur-xl shadow-2xl transition-all"
           >
              <Minimize2 className="w-7 h-7" />
           </Button>
        </div>
      </header>

      {/* 3. Subtitle Overlay */}
      <footer className="absolute bottom-20 inset-x-0 px-24 flex flex-col items-center justify-center gap-8 z-50">
        <div className="max-w-5xl text-center">
           <div className="bg-black/60 backdrop-blur-[30px] border border-white/10 px-14 py-7 rounded-[3rem] shadow-[0_30px_60px_rgba(0,0,0,0.8)]">
              <p className="text-3xl md:text-4xl font-extrabold tracking-tight text-white leading-relaxed animate-in fade-in slide-in-from-bottom-4 duration-1000">
                "{subtitle}"
              </p>
           </div>
        </div>

        {/* Status Line */}
        <div className="flex items-center gap-6 text-white/20 uppercase text-[10px] font-black tracking-[0.4em] drop-shadow-sm px-6 py-2 bg-white/5 rounded-full border border-white/5">
           <span>Engine: V8</span>
           <span className="w-1.5 h-1.5 rounded-full bg-white/10" />
           <span>Jitter: {jitter.toFixed(1)}ms</span>
           <span className="w-1.5 h-1.5 rounded-full bg-white/10" />
           <span>FPS: {fps.toFixed(1)}</span>
           <span className="w-1.5 h-1.5 rounded-full bg-white/10" />
           <span>FFT: 256B</span>
        </div>
      </footer>
    </div>
  );
};

export default FullscreenKiosk;
