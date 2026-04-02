import React, { useEffect, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import AnimatedCharacter from './AnimatedCharacter';
import StageAudioVisualizer from './StageAudioVisualizer';
import { Button } from "@/character-editor/components/ui/button";

type ViewPreset = 'full' | 'head';

const PuppetStage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [viewPreset, setViewPreset] = useState<ViewPreset>('full');
  const [fps, setFps] = useState(0);
  const [jitter, setJitter] = useState(0);

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

  const openFullscreen = () => {
    const returnTo = `${location.pathname}${location.search}`;
    navigate(`/fullscreen?return_to=${encodeURIComponent(returnTo)}`);
  };

  return (
    <div className="flex flex-col h-full bg-slate-950/40 relative group overflow-hidden select-none">
      <header className="h-14 border-b border-slate-800 flex items-center justify-between px-4 shrink-0 bg-slate-950/20 backdrop-blur-sm relative z-20">
        <div className="flex items-center gap-3">
           <div className={`w-2.5 h-2.5 rounded-full shadow-glow bg-emerald-500 animate-pulse`} />
           <div className="flex flex-col gap-0.5">
              <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] leading-none">Studio Stage</span>
              <span className="text-[8px] font-bold text-slate-600 uppercase tracking-tighter">Live Monitor v1.4</span>
           </div>
        </div>
        
        {/* Quick View Presets (Adaptive Scaling) */}
        <div className="flex items-center gap-1.5 bg-slate-900/60 p-1 rounded-xl border border-slate-700/50">
           {(['full', 'head'] as ViewPreset[]).map(preset => (
             <Button 
               key={preset}
               variant={viewPreset === preset ? 'secondary' : 'ghost'} 
               size="sm" 
               className={`h-7 px-3 text-[9px] font-black uppercase tracking-widest rounded-lg transition-all
                  ${viewPreset === preset ? 'bg-sky-500 text-white border-none shadow-lg' : 'text-slate-400 hover:text-slate-200'}
               `}
               onClick={() => setViewPreset(preset)}
             >
                {preset}
             </Button>
           ))}
        </div>

        <div className="flex items-center gap-2">
           <Button 
             variant="ghost" 
             size="icon" 
             onClick={openFullscreen}
             className="h-9 w-9 bg-slate-900 hover:bg-slate-800 text-slate-500 hover:text-sky-400 transition-all border border-white/5 rounded-xl shadow-inner"
           >
              <Maximize2 className="w-4 h-4" />
           </Button>
        </div>
      </header>

      {/* Lab Environment: Studio-Specific Scaling */}
      <div className="flex-1 overflow-hidden relative bg-gradient-radial from-slate-900 via-slate-950 to-black select-none flex items-center justify-center p-0">
          <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.08),transparent_45%),radial-gradient(circle_at_bottom,rgba(14,165,233,0.08),transparent_35%)] pointer-events-none" />
          <div className="absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-sky-500/[0.05] to-transparent pointer-events-none" />
          
          <AnimatedCharacter 
             viewPreset={viewPreset}
             stageScale={viewPreset === 'full' ? 0.65 : 1.0} // Shrunk for Studio Lab interface
          />
      </div>

      <footer className="border-t border-slate-800 px-4 py-3 shrink-0 bg-slate-950/60 select-none">
         <div className="w-full space-y-3">
            <StageAudioVisualizer />
            <div className="flex items-center justify-between">
              <div className="flex gap-6 items-center">
              <div className="flex items-center gap-2">
                 <div className="text-[9px] font-black text-slate-600 uppercase tracking-widest">FPS:</div>
                 <div className="text-[10px] font-mono font-bold text-emerald-500 transition-all">{fps.toFixed(1)}</div>
              </div>
              <div className="flex items-center gap-2">
                 <div className="text-[9px] font-black text-slate-600 uppercase tracking-widest">Jitter:</div>
                 <div className="text-[10px] font-mono font-bold text-sky-400 transition-all">{jitter.toFixed(1)}ms</div>
              </div>
              </div>
              <div className="flex items-center gap-3">
               <div className="w-2 h-2 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <div className="w-1 h-1 rounded-full bg-emerald-500" />
               </div>
               <span className="text-[9px] font-black text-slate-600 tracking-[0.3em] uppercase">Puppet-Stage Engine</span>
              </div>
            </div>
         </div>
      </footer>
    </div>
  );
};

export default PuppetStage;
