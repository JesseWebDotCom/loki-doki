import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { createAvatar } from '@dicebear/core';
import * as collections from '@dicebear/collection';
import { useCharacter } from '../context/CharacterContext';
import { useAudio } from '../context/AudioContext';
import { useVoice } from '../context/VoiceContext';
import { Heart } from 'lucide-react';
import { resolveExpression } from '../utils/ExpressionResolver';
import type { CanonicalViseme, CanonicalEmotion, CanonicalEyeState } from '../utils/ExpressionResolver';
import KyleSouthPark from './characters/KyleSouthPark';

const avatarSvgCache = new Map<string, string>();
const MAX_AVATAR_CACHE_SIZE = 48;

/**
 * AnimatedCharacter — The SVG Puppeteer Renderer (Phase 3.3)
 * Standardized rig that bridges Canonical States to Style-Specific DiceBear assets.
 */
const AnimatedCharacter: React.FC<{ viewPreset?: 'full' | 'head' | 'fullscreen'; stageScale?: number }> = memo(({ viewPreset = 'full', stageScale = 1.0 }) => {
  const { options, brain, sendToBrain } = useCharacter();
  const { isSpeaking: isMicSpeaking, viseme: audioViseme, isListening } = useAudio();
  const { isSpeaking: isVoiceSpeaking, registerVisemeListener } = useVoice();
  
  const [pulseViseme, setPulseViseme] = useState<CanonicalViseme>('closed');
  const [isBlinking, setIsBlinking] = useState(false);
  const [isSnoring, setIsSnoring] = useState(false);
  const [idleTilt, setIdleTilt] = useState(0);
  const [dozeState, setDozeState] = useState<{ stage: 'none' | 'blinking' | 'settling' | 'tilting' | 'sleeping' | 'waking', rotation: number, eyeState: CanonicalEyeState }>({
    stage: 'none',
    rotation: 0,
    eyeState: 'default'
  });

  const bodyState =
    typeof brain.value === 'string'
      ? brain.value
      : 'body' in brain.value
        ? String(brain.value.body)
        : 'active';
  const isHappy = brain.matches({ body: 'happy' });
  const isSick = brain.matches({ body: 'sick' });
  const isThinking = brain.matches({ body: 'thinking' });
  const isBored = brain.matches({ body: 'bored' });
  const isTalking = brain.matches({ mouth: 'talking' });

  useEffect(() => {
    const cleanup = registerVisemeListener((v) => {
      setPulseViseme(v as CanonicalViseme);
    });
    return cleanup;
  }, [registerVisemeListener]);

  let currentEmotion: CanonicalEmotion = 'neutral';
  if (isHappy) currentEmotion = 'happy';
  if (isSick) currentEmotion = 'disgusted';
  if (isThinking) currentEmotion = 'neutral';
  if (isBored) currentEmotion = 'sad';
  if (bodyState === 'startled') currentEmotion = 'surprised';
  if (bodyState === 'sleep') currentEmotion = 'neutral';

  // 1. Calculate current behavior state
  const [idleEyeState, setIdleEyeState] = useState<CanonicalEyeState>('default');

  // 1. Calculate current behavior state
  const currentEyeState: CanonicalEyeState = (() => {
    // If the doze machine is active, it takes control
    if (dozeState.stage !== 'none') {
      if (dozeState.stage === 'blinking') {
        return isBlinking ? 'closed' : 'default';
      }
      return dozeState.eyeState;
    }
    
    // Only force closed eyes for pure static sleep state
    if (bodyState === 'sleep') return 'closed';
    
    // Behavioral overrides for common states
    if (isBlinking) return 'closed';
    if (isThinking) return 'looking_left';
    if (isSick) return 'sleepy';
    if (bodyState === 'startled') return 'wide';
    if (isBored) return 'eyeroll';
    return idleEyeState;
  })();

  // Randomized Idle Eye Shifts (Saccades)
  useEffect(() => {
    if (bodyState !== 'active' && bodyState !== 'neutral') {
       setIdleEyeState('default');
       return;
    }
    
    const interval = setInterval(() => {
      const chance = Math.random();
      if (chance < 0.1) {
         setIdleEyeState('looking_left');
      } else if (chance < 0.2) {
         setIdleEyeState('looking_right');
      } else if (chance < 0.25) {
         setIdleEyeState('eyeroll');
      } else {
         setIdleEyeState('default');
      }
    }, 3000 + Math.random() * 3000);
    
    return () => clearInterval(interval);
  }, [bodyState]);

  let behavioralRotation = options.headRotation || 0;
  behavioralRotation += idleTilt;

  if (dozeState.stage !== 'none' && dozeState.stage !== 'blinking') {
    // Once we hit settling/tilting/sleeping, use the dozed rotation
    behavioralRotation += dozeState.rotation;
  } else {
    // If blinking or neutral, use baseline behavioral tips
    if (isThinking) behavioralRotation += 8;
    if (isSick) behavioralRotation -= 4;
  }

  // 2. Select visual overrides
  // We check for style-specific overrides (kyle_tuning) or global generic overrides (options.eyes/mouth)
  const rawEyeOverride = (options.eyes?.[0] && options.eyes[0] !== 'seed' && options.eyes[0] !== 'auto') 
    ? options.eyes[0] 
    : options.kyle_tuning?.eyeStateOverride;

  const eyeState = (rawEyeOverride && rawEyeOverride !== 'seed' && rawEyeOverride !== 'auto')
    ? rawEyeOverride as CanonicalEyeState 
    : currentEyeState;

  const rawMouthOverride = (options.mouth?.[0] && options.mouth[0] !== 'seed' && options.mouth[0] !== 'auto')
    ? options.mouth[0]
    : options.kyle_tuning?.visemeOverride;

  const visemeSource = (rawMouthOverride && rawMouthOverride !== 'seed' && rawMouthOverride !== 'auto')
    ? rawMouthOverride as CanonicalViseme
    : (bodyState === 'sleep' || dozeState.stage === 'sleeping' || dozeState.stage === 'tilting' ? (isSnoring ? 'o' : 'closed') : (isSick ? 'sick' : (isVoiceSpeaking ? pulseViseme : (isMicSpeaking ? audioViseme as CanonicalViseme : 'closed'))));

  // 3. Smooth Rotation Rigging (LERP)
  const [displayedRotation, setDisplayedRotation] = useState(behavioralRotation);
  
  useEffect(() => {
    let frameId: number;
    const animate = () => {
      setDisplayedRotation(prev => {
        const diff = behavioralRotation - prev;
        // Use a slow lerp factor (0.04) for a lazy weight-shift feel during dozing
        // But snap faster (0.1) if the delta is large (e.g. waking up)
        const factor = Math.abs(diff) > 10 ? 0.08 : 0.04;
        
        if (Math.abs(diff) < 0.1) return behavioralRotation;
        return prev + diff * factor;
      });
      frameId = requestAnimationFrame(animate);
    };
    frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [behavioralRotation]);

  const faceProps = useMemo(
    () => resolveExpression(options.style, currentEmotion, visemeSource, eyeState),
    [options.style, currentEmotion, visemeSource, eyeState]
  );

  const [svgContent, setSvgContent] = useState('');
  useEffect(() => {
    const selectedCollection = (
      (collections as unknown as Record<string, Parameters<typeof createAvatar>[0]>)[options.style] ||
      collections.avataaars
    );
    
    const buildOptions: Record<string, unknown> = {
      seed: options.seed,
      flip: options.flip,
      rotate: options.rotate,
      radius: options.radius,
      scale: 100,
      backgroundColor: ["transparent"],
      backgroundType: [],
      ...faceProps,
    };

    // Only pass overrides if they aren't 'seed'
    if (options.top && options.top[0] !== 'seed') buildOptions.top = options.top;
    if (options.accessories && options.accessories[0] !== 'seed') buildOptions.accessories = options.accessories;
    if (options.eyes && options.eyes[0] !== 'seed') buildOptions.eyes = options.eyes;
    if (options.mouth && options.mouth[0] !== 'seed') buildOptions.mouth = options.mouth;
    if (options.clothing && options.clothing[0] !== 'seed') buildOptions.clothing = options.clothing;
    if (options.clothingGraphic && options.clothingGraphic[0] !== 'seed') buildOptions.clothingGraphic = options.clothingGraphic;
    if (options.facialHair && options.facialHair[0] !== 'seed') buildOptions.facialHair = options.facialHair;
    if (options.hairColor && options.hairColor[0] !== 'seed') buildOptions.hairColor = options.hairColor;
    if (options.skinColor && options.skinColor[0] !== 'seed') buildOptions.skinColor = options.skinColor;
    if (options.clothesColor && options.clothesColor[0] !== 'seed') buildOptions.clothesColor = options.clothesColor;
    if (options.accessoriesColor && options.accessoriesColor[0] !== 'seed') buildOptions.accessoriesColor = options.accessoriesColor;
    if (options.eyebrows && options.eyebrows[0] !== 'seed') buildOptions.eyebrows = options.eyebrows;

    try {
      const cacheKey = JSON.stringify({ style: options.style, buildOptions });
      const cachedSvg = avatarSvgCache.get(cacheKey);
      if (cachedSvg) {
        setSvgContent(cachedSvg);
        return;
      }

      const avatar = createAvatar(selectedCollection, buildOptions);
      let svg = avatar.toString();
      
      svg = svg.replace(/<svg(.*?)\bviewBox="([^"]+)"(.*?)>(.*?)<\/svg>/s, (_, before, vb, after, content) => {
         // Universal Rigging Engine (Phase 3.29 - Dual-Track Anatomical Rig)
         let bodyContent = '';
         let headContent = content;

         const headStartIdx = content.search(/<(g|path|circle|ellipse|rect|use) [^>]*id\s*=\s*["'][^"']*(head|ear|skin|face|top|hair|eyes|eyebrow|beard|mouth|nose|cap|hat|mask|neck)[^"']*/i);
         
         if (headStartIdx >= 0 && options.style !== 'avataaars') {
            bodyContent = content.substring(0, headStartIdx);
            headContent = content.substring(headStartIdx);
         } else {
            let cleanedCore = content.trim()
               .replace(/<g [^>]*mask="url\(#viewboxMask\)"[^>]*>/i, '')
               .replace(/<g [^>]*transform="translate\(8\)"[^>]*>/i, '')
               .replace(/<\/g>\s*<\/g>\s*$/i, '');
               
            // Aggressively strip background shape if it's at the very start of the core content
            cleanedCore = cleanedCore.replace(/^(<rect|<circle|<path)[^>]*fill="[^"]*"[^>]*\/>/i, '');
            // Some versions use separate opening/closing tags
            cleanedCore = cleanedCore.replace(/^(<rect|<circle|<path)[^>]*fill="[^"]*"[^>]*><\/\1>/i, '');

            if (options.style === 'avataaars') {
               // AVATAAARS SPLIT: Identify where the facial features/head parts begin inside the cleaned core
               const headSearchIdx = cleanedCore.search(/<(g|path|circle|ellipse|rect|use) [^>]*id\s*=\s*["'][^"']*(head|ear|skin|face|top|hair|eyes|eyebrow|beard|mouth|nose|cap|hat|mask|neck)[^"']*/i);
               if (headSearchIdx >= 0) {
                  bodyContent = cleanedCore.substring(0, headSearchIdx);
                  headContent = cleanedCore.substring(headSearchIdx);
               } else {
                  headContent = cleanedCore;
               }
               // Standard Avataaars assembly
               return `<svg${before}viewBox="${vb}"${after} width="100%" height="100%" id="ld-character-svg"><g id="ld-body">${bodyContent}</g><g id="ld-head">${headContent}</g></svg>`;
            } else {
               const parts = cleanedCore.split('</g>');
               if (parts.length > 2) {
                  bodyContent = parts[0] + '</g>';
                  headContent = parts.slice(1).join('</g>');
               }
            }
         }
         
         return `<svg${before}viewBox="${vb}"${after} width="100%" height="100%" id="ld-character-svg"><g id="ld-body">${bodyContent}</g><g id="ld-head">${headContent}</g></svg>`;
      });
      
      if (avatarSvgCache.size >= MAX_AVATAR_CACHE_SIZE) {
        const firstKey = avatarSvgCache.keys().next().value;
        if (firstKey) avatarSvgCache.delete(firstKey);
      }
      avatarSvgCache.set(cacheKey, svg);
      setSvgContent(svg);
    } catch (err) {
      console.error('Avatar Render Error:', err);
    }
  }, [options, faceProps]);

  const [popHeart, setPopHeart] = useState(false);
  const heartTimeoutRef = useRef<number | null>(null);
  const handleTouch = () => {
     if (heartTimeoutRef.current !== null) {
       window.clearTimeout(heartTimeoutRef.current);
     }
     setPopHeart(true);
     sendToBrain({ type: 'PET' });
     heartTimeoutRef.current = window.setTimeout(() => {
       setPopHeart(false);
       heartTimeoutRef.current = null;
     }, 900);
  };

  // 7. Activity Watchdog (Wake Unit)
  // Break out of sleep/doze states if activity (speaking, listening, etc) is detected
  useEffect(() => {
    const activity = isVoiceSpeaking || (isListening && isMicSpeaking);
    if (activity && (bodyState === 'sleep' || bodyState === 'dozing')) {
      sendToBrain({ type: 'RESET_IDLE' });
    }
  }, [isVoiceSpeaking, isMicSpeaking, isListening, bodyState, sendToBrain]);

  useEffect(() => {
    const currentlyTalking = isVoiceSpeaking || (isListening && isMicSpeaking);
    if (currentlyTalking && !isTalking) {
      sendToBrain({ type: 'SPEAK_START' });
    } else if (!currentlyTalking && isTalking) {
      sendToBrain({ type: 'SPEAK_END' });
    }
  }, [isMicSpeaking, isVoiceSpeaking, isTalking, isListening, sendToBrain]);

  // Idle Tilt & Blink Cycle
  useEffect(() => {
    const blinkInterval = setInterval(() => {
       if (bodyState !== 'sleep' && bodyState !== 'dozing' && !isHappy && !isSick && !isThinking) {
          setIsBlinking(true);
          setTimeout(() => setIsBlinking(false), 150 + Math.random() * 150);
       }
    }, 3000 + Math.random() * 3000);

    const tiltInterval = setInterval(() => {
       if (bodyState === 'active' || bodyState === 'neutral') {
          setIdleTilt((Math.random() - 0.5) * 6); // Slightly more noticeable 
       } else if (bodyState !== 'dozing' && bodyState !== 'sleep') {
          // Fade out tilt when in other behavioral states (like sick, which has its own tilt)
          setIdleTilt(0); 
       }
    }, 5000);

    const snoreInterval = setInterval(() => {
       if (bodyState === 'sleep' || dozeState.stage === 'sleeping') setIsSnoring(prev => !prev);
    }, 2000);

    return () => {
       clearInterval(blinkInterval);
       clearInterval(tiltInterval);
       clearInterval(snoreInterval);
    };
  }, [bodyState, isHappy, isSick, isThinking, dozeState.stage]);

  const [dozeRoundCount, setDozeRoundCount] = useState(0);
  const [targetDozeRounds, setTargetDozeRounds] = useState(1);

  // Dozing & Sleeping State Machine
  useEffect(() => {
    const timeouts: number[] = [];
    const intervals: number[] = [];
    const trackTimeout = (callback: () => void, delay: number) => {
      const id = window.setTimeout(callback, delay);
      timeouts.push(id);
      return id;
    };
    const trackInterval = (callback: () => void, delay: number) => {
      const id = window.setInterval(callback, delay);
      intervals.push(id);
      return id;
    };

    // If we're not in a doze state, reset the round counters
    if (bodyState !== 'dozing') {
       if (bodyState !== 'sleep') {
          setDozeRoundCount(0);
       }
    }

    // Sequence Reset
    if (bodyState !== 'dozing' && bodyState !== 'sleep') {
      if (dozeState.stage !== 'none') {
         setDozeState({ stage: 'none', rotation: 0, eyeState: 'default' });
      }
      return;
    }

    // Initialize/Randomize rounds when we enter dozing
    if (bodyState === 'dozing' && dozeRoundCount === 0 && dozeState.stage === 'none') {
       setTargetDozeRounds(1 + Math.floor(Math.random() * 3));
    }

    // Initialize sequence
    if (dozeState.stage === 'none') {
      if (bodyState === 'sleep') {
        // QUICK SLEEP INITIATION: Close eyes immediately, tilt after delay
        setDozeState({ stage: 'settling', rotation: 0, eyeState: 'closed' });
        
        trackTimeout(() => {
          const finalTiltDir = Math.random() > 0.5 ? 1 : -1;
          const finalTiltAmount = (12 + Math.random() * 10) * finalTiltDir;
          setDozeState({ stage: 'tilting', rotation: finalTiltAmount, eyeState: 'closed' });
          
          trackTimeout(() => {
            setDozeState({ stage: 'sleeping', rotation: finalTiltAmount, eyeState: 'closed' });
          }, 2000);
        }, 800);
        return;
      }

      // DOZING ROUTINE: Random blinking/drifting first
      const waitTime = 1000 + Math.random() * 4000;
      trackTimeout(() => {
        setDozeState({ stage: 'blinking', rotation: 0, eyeState: 'default' });
        let blinkCount = 0;
        const maxBlinks = 3 + Math.floor(Math.random() * 5);
        const blinker = trackInterval(() => {
          setIsBlinking(prev => !prev);
          blinkCount++;
          if (blinkCount >= maxBlinks * 2) {
            clearInterval(blinker);
            setIsBlinking(false);
            
            // PHASE 2: SETTLING (CLOSE EYES FIRST)
            setDozeState({ stage: 'settling', rotation: 0, eyeState: 'closed' });
            
            // PHASE 3: TILT AFTER DELAY (Let eyes close first!)
            trackTimeout(() => {
              const tiltDir = Math.random() > 0.5 ? 1 : -1;
              const tiltAmount = (12 + Math.random() * 10) * tiltDir;
              setDozeState({ stage: 'tilting', rotation: tiltAmount, eyeState: 'closed' });
              
              if (bodyState === 'dozing') {
                // Dozers drift, then snap awake with a blink
                trackTimeout(() => {
                  // Phase 4: Snap back with wide eyes first (Start the tilt back)
                  setDozeState({ stage: 'waking', rotation: 0, eyeState: 'wide' });
                  
                  // Small rapid blink during the snap
                  let wakeBlink = 0;
                  const wakeBlinker = trackInterval(() => {
                    setIsBlinking(prev => !prev);
                    wakeBlink++;
                    if (wakeBlink >= 4) {
                      clearInterval(wakeBlinker);
                       setIsBlinking(false);
                    }
                  }, 150);

                  trackTimeout(() => {
                    const nextRound = dozeRoundCount + 1;
                    if (nextRound >= targetDozeRounds) {
                      // Final drift into Deep Sleep
                      sendToBrain({ type: 'FORCE_SLEEP' });
                      
                      // Choose a definitive rotation for the sleep session
                      const finalTiltDir = Math.random() > 0.5 ? 1 : -1;
                      const finalTiltAmount = (12 + Math.random() * 10) * finalTiltDir;
                      
                      setDozeState({ stage: 'sleeping', rotation: finalTiltAmount, eyeState: 'closed' });
                      setDozeRoundCount(0); // Reset for next time we doze
                    } else {
                      setDozeRoundCount(nextRound);
                      setDozeState({ stage: 'none', rotation: 0, eyeState: 'default' });
                    }
                  }, 1500 + Math.random() * 1000);
                }, 4000 + Math.random() * 5000);
              } else {
                // Steady Sleep
                setDozeState({ stage: 'sleeping', rotation: tiltAmount, eyeState: 'closed' });
              }
            }, 1500 + Math.random() * 1500); // 1.5 - 3s delay before tilting
          }
        }, 120 + Math.random() * 150);
      }, waitTime);
    }
    return () => {
      intervals.forEach((id) => window.clearInterval(id));
      timeouts.forEach((id) => window.clearTimeout(id));
    };
  }, [bodyState, dozeRoundCount, dozeState.stage, sendToBrain, targetDozeRounds]);

  useEffect(() => {
    return () => {
      if (heartTimeoutRef.current !== null) {
        window.clearTimeout(heartTimeoutRef.current);
      }
    };
  }, []);

  const globalScale = (options.scale / 100) * stageScale;

  return (
    <div 
      onClick={handleTouch}
      className={`relative w-full h-full flex items-center justify-center transition-all duration-700 cursor-pointer group
        ${bodyState === 'sleep' ? 'opacity-40 grayscale-[0.8]' : 'opacity-100'}
        ${isSick ? 'saturate-[1.8] brightness-[1.1] hue-rotate-[-60deg]' : ''}
      `}
    >
      <div 
        className={`relative flex items-center justify-center transition-all duration-500 origin-center
           ${isSick ? 'drop-shadow-[0_0_30px_rgba(34,197,94,0.4)]' : ''}
        `}
        style={{ transform: `scale(${globalScale})` }}
      >
        <div 
          className={`flex items-center justify-center transition-all duration-[1000ms] overflow-hidden relative
             ${viewPreset === 'head' ? 'w-[200px] h-[200px] rounded-full border-[6px] border-slate-700/50 shadow-xl' : 'h-full w-full min-w-[320px] min-h-[320px] p-10'}
          `}
        >
          <div 
             className={`w-full h-full flex items-center justify-center relative
                ${(bodyState !== 'sleep' && bodyState !== 'dozing' && bodyState !== 'startled') ? 'animate-breathing' : ''}
                ${viewPreset === 'head' ? 'transform scale-[1.35] translate-y-3' : 'transform scale-[0.85]'}
                ${bodyState === 'startled' ? 'behavior-startled' : ''}
             `}
             style={{ '--ld-head-rotate': `${displayedRotation}deg` } as React.CSSProperties}
          >
            {options.style === 'kyle_southpark' ? (
              <KyleSouthPark 
                viseme={visemeSource} 
                emotion={currentEmotion} 
                eyeState={eyeState}
                tuning={options.kyle_tuning}
                className="w-full h-full"
              />
            ) : (
              <div 
                className="w-full h-full flex items-center justify-center relative"
                dangerouslySetInnerHTML={{ __html: svgContent }} 
              />
            )}
          </div>
        </div>

        {(bodyState === 'sleep' || dozeState.stage === 'tilting' || dozeState.stage === 'sleeping') && (
           <div className={`absolute transition-all duration-1000 font-black text-sky-400 drop-shadow-[0_0_12px_rgba(56,189,248,0.6)]
             ${isSnoring ? 'scale-[2.4] translate-y-[-25%] opacity-100' : 'scale-[1.0] translate-y-0 opacity-20'}
             ${viewPreset === 'head' ? 'right-[-10%] top-[-10%] text-4xl' : 'right-[15%] top-[10%] text-7xl'}
           `}>
              Zzz
           </div>
        )}

        {popHeart && (
           <div className={`absolute flex items-center justify-center pointer-events-none w-full h-full`}>
              <Heart className={`text-pink-500 fill-pink-500 animate-ping opacity-80 ${viewPreset === 'head' ? 'w-32 h-32' : 'w-64 h-64'}`} />
           </div>
        )}

        <div className={`absolute flex justify-center pointer-events-none transition-all duration-500 w-full
           ${viewPreset === 'head' ? 'top-[-50%]' : 'top-[5%]'}
        `}>
           {bodyState === 'startled' && <div className="text-amber-500 font-black text-7xl drop-shadow-[0_0_20px_rgba(245,158,11,0.6)] animate-ping">❗</div>}
           {isHappy && <div className="text-pink-500 font-black text-7xl drop-shadow-[0_0_20px_rgba(236,72,153,0.6)] animate-bounce">❤️</div>}
           {isSick && <div className="text-green-500 font-black text-7xl drop-shadow-[0_0_25px_rgba(34,197,94,0.8)] animate-pulse">🤢</div>}
           {isThinking && <div className="text-sky-500 font-black text-6xl drop-shadow-[0_0_20px_rgba(14,165,233,0.6)] animate-bounce">💭</div>}
           {isBored && <div className="text-slate-400 font-black text-6xl drop-shadow-[0_0_20px_rgba(100,116,139,0.5)] animate-pulse">🙄</div>}
        </div>
      </div>
    </div>
  );
});

export default AnimatedCharacter;
