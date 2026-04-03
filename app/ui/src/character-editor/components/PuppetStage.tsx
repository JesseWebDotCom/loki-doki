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
    <div className="relative flex h-full flex-col overflow-hidden bg-[var(--app-stage-bg)] group select-none">
      <header className="relative z-20 flex h-14 shrink-0 items-center justify-between border-b border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)]/45 px-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
           <div className={`w-2.5 h-2.5 rounded-full shadow-glow bg-emerald-500 animate-pulse`} />
           <div className="flex flex-col gap-0.5">
              <span className="ce-title leading-none text-[var(--app-text)]">Studio Stage</span>
              <span className="ce-micro text-[var(--app-text-muted)]">Live Monitor v1.4</span>
           </div>
        </div>
        
        {/* Quick View Presets (Adaptive Scaling) */}
        <div className="flex items-center gap-1.5 rounded-xl border border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)]/70 p-1">
           {(['full', 'head'] as ViewPreset[]).map(preset => (
             <Button 
               key={preset}
               variant={viewPreset === preset ? 'secondary' : 'ghost'} 
               size="sm" 
               className={`ce-control h-7 rounded-lg px-3 transition-all
                  ${viewPreset === preset ? 'border-none bg-[var(--app-accent)] text-white shadow-lg' : 'text-[var(--app-text-muted)] hover:text-[var(--app-text)]'}
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
             className="h-9 w-9 rounded-xl border border-[color:var(--app-border)] bg-[var(--app-bg-panel)] text-[var(--app-text-muted)] shadow-inner transition-all hover:text-[var(--app-accent)]"
           >
              <Maximize2 className="w-4 h-4" />
           </Button>
        </div>
      </header>

      {/* Lab Environment: Studio-Specific Scaling */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-0 select-none">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,color-mix(in_srgb,var(--app-accent)_12%,transparent),transparent_45%),radial-gradient(circle_at_bottom,color-mix(in_srgb,var(--app-accent-strong)_10%,transparent),transparent_35%)]" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-1/2 bg-gradient-to-t from-[color:var(--app-accent-soft)] to-transparent" />
          
          <AnimatedCharacter 
             viewPreset={viewPreset}
             stageScale={viewPreset === 'full' ? 0.65 : 1.0} // Shrunk for Studio Lab interface
          />
      </div>

      <footer className="shrink-0 border-t border-[color:var(--app-border)] bg-[color:var(--app-bg-panel)]/70 px-4 py-3 select-none">
         <div className="w-full space-y-3">
            <StageAudioVisualizer />
            <div className="flex items-center justify-between">
              <div className="flex gap-6 items-center">
              <div className="flex items-center gap-2">
                 <div className="ce-label text-[var(--app-text-muted)]">FPS:</div>
                 <div className="text-[10px] font-mono font-bold text-[var(--app-icon-success)] transition-all">{fps.toFixed(1)}</div>
              </div>
              <div className="flex items-center gap-2">
                 <div className="ce-label text-[var(--app-text-muted)]">Jitter:</div>
                 <div className="text-[10px] font-mono font-bold text-[var(--app-icon-primary)] transition-all">{jitter.toFixed(1)}ms</div>
              </div>
              </div>
              <div className="flex items-center gap-3">
               <div className="w-2 h-2 rounded-full bg-emerald-500/20 flex items-center justify-center">
                  <div className="w-1 h-1 rounded-full bg-emerald-500" />
               </div>
               <span className="ce-micro text-[var(--app-text-muted)]">Puppet-Stage Engine</span>
              </div>
            </div>
         </div>
      </footer>
    </div>
  );
};

export default PuppetStage;
