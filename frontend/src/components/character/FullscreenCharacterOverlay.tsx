import React, { useEffect, useRef } from 'react';
import { Minimize2, Send } from 'lucide-react';
import RiggedDicebearAvatar from './RiggedDicebearAvatar';
import type { CharacterRow } from '../../lib/api';
import type { HeadTiltState } from './useHeadTilt';
import { useTTSState } from '../../utils/tts';

interface Props {
  character: CharacterRow;
  state: HeadTiltState;
  onExit: () => void;
  // Input props
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  isProcessing: boolean;
  placeholder?: string;
}

/**
 * FullscreenCharacterOverlay — A blackout overlay that requests browser
 * fullscreen and renders the character large and centered.
 */
const FullscreenCharacterOverlay: React.FC<Props> = ({ 
  character, 
  state, 
  onExit,
  input,
  setInput,
  onSend,
  isProcessing,
  placeholder
}) => {
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tts = useTTSState();

  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;

    const enterFullscreen = async () => {
      try {
        if (!document.fullscreenElement) {
          await el.requestFullscreen();
        }
      } catch (err) {
        console.error('[FullscreenCharacter] Failed to enter fullscreen:', err);
      }
    };

    enterFullscreen();

    const handleFsChange = () => {
      // Small delay to let the browser stabilize its document.fullscreenElement state
      // after the change event fires. Some browsers/situations can briefly report
      // null on valid transitions.
      setTimeout(() => {
        if (!document.fullscreenElement) {
          onExit();
        }
      }, 100);
    };

    const handleFsError = (err: Event) => {
      console.error('[FullscreenCharacter] Fullscreen error:', err);
      // If we failed to enter actual browser fullscreen, we STAY in the 
      // React overlay mode anyway (it's fixed inset-0) so the user can 
      // still use it. We don't onExit() here.
    };

    document.addEventListener('fullscreenchange', handleFsChange);
    document.addEventListener('fullscreenerror', handleFsError);
    
    return () => {
      document.removeEventListener('fullscreenchange', handleFsChange);
      document.removeEventListener('fullscreenerror', handleFsError);
      if (document.fullscreenElement === el) {
        document.exitFullscreen().catch(() => {});
      }
    };
  }, [onExit]);

  // Maintain focus on input
  useEffect(() => {
    if (!isProcessing) {
      inputRef.current?.focus();
    }
  }, [isProcessing]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onExit();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExit]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] flex flex-col items-center justify-center bg-background text-foreground"
      style={{ cursor: 'default' }}
    >
      {/* Exit Button - Top Right */}
      <button
        onClick={onExit}
        className="absolute right-8 top-8 flex h-12 w-12 items-center justify-center rounded-full bg-card/40 text-muted-foreground transition-all hover:bg-card/60 hover:text-primary active:scale-95 backdrop-blur-md border border-border/20 shadow-m2"
        title="Exit Fullscreen (Esc)"
      >
        <Minimize2 size={24} />
      </button>

      {/* Large Character */}
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-in fade-in zoom-in duration-500 w-[min(80vh,80vw)] h-[min(80vh,80vw)] max-w-[800px] max-h-[800px]">
          <RiggedDicebearAvatar
            style={character.avatar_style}
            seed={character.avatar_seed}
            baseOptions={character.avatar_config as Record<string, unknown>}
            tiltState={state}
          />
        </div>
      </div>

      {/* Subtitles & Input area */}
      <div className="w-full max-w-3xl px-6 pb-12 pt-4 flex flex-col items-center gap-8">
        {/* "Movie" Subtitles */}
        <div 
          className={`px-6 py-3 rounded-2xl bg-black/60 backdrop-blur-sm border border-white/10 transition-all duration-300 min-h-[3.5rem] flex items-center justify-center text-center ${
            tts.spokenText ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4'
          }`}
        >
          <p className="text-xl sm:text-2xl font-medium text-white tracking-wide drop-shadow-sm max-w-2xl leading-relaxed">
            {tts.spokenText}
          </p>
        </div>

        {/* Console Input Bar */}
        <div className="relative w-full max-w-2xl group">
          <input
            ref={inputRef}
            autoFocus
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSend()}
            placeholder={placeholder || `Chat with ${character.name}…`}
            disabled={isProcessing}
            className="w-full rounded-[1.45rem] border border-border/20 bg-card/40 backdrop-blur-md py-4 pl-6 pr-16 text-lg font-medium shadow-m4 transition-all placeholder:text-muted-foreground/45 focus:border-primary/50 focus:outline-none focus:ring-4 focus:ring-primary/5 disabled:opacity-50"
          />
          <button
            onClick={onSend}
            disabled={isProcessing || !input.trim()}
            className="absolute right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 cursor-pointer items-center justify-center rounded-xl bg-primary text-white shadow-m2 shadow-primary/20 transition-all hover:bg-primary/90 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send size={20} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default FullscreenCharacterOverlay;
