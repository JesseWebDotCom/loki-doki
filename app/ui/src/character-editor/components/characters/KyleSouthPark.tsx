import React from 'react';
import type { CanonicalViseme, CanonicalEmotion, CanonicalEyeState } from '../../utils/ExpressionResolver';

/**
 * KyleSouthPark — Hand-rigged construction paper character.
 * Renders the provided signature SVG with dynamic lip-sync and expression overlays.
 */
interface KyleSouthParkProps {
  viseme?: CanonicalViseme;
  emotion?: CanonicalEmotion;
  eyeState?: CanonicalEyeState;
  className?: string;
  tuning?: {
    eyeXOffset?: number;
    eyeYOffset?: number;
    eyeSpacing?: number;
    eyeSize?: number;
    eyeRoundness?: number;
    eyeRotate?: number;
    eyelidRotate?: number;
    browXOffset?: number;
    browYOffset?: number;
    browSpacing?: number;
    browThickness?: number;
    browWidth?: number;
    browRotate?: number;
    pupilSize?: number;
    pupilXOffset?: number;
    pupilYOffset?: number;
    mouthXOffset?: number;
    mouthYOffset?: number;
    mouthThickness?: number;
    mouthLength?: number;
    mouthCurve?: number;
    mouthRotate?: number;
    mouthOpenShape?: 'oval' | 'triangle';
    mouthTeeth?: number;
    mouthTongue?: number;
  }
}

const KyleSouthPark: React.FC<KyleSouthParkProps> = ({ 
  viseme = 'closed', 
  emotion = 'neutral',
  eyeState = 'default',
  className = "",
  tuning = {}
}) => {
  // 1. Mouth Resolve (South Park Style: Simple black shapes)
  const renderMouth = () => {
    const mouthX = 459 + (tuning.mouthXOffset || 0);
    const mouthY = 750 + (tuning.mouthYOffset || 0); 
    const thickness = tuning.mouthThickness || 4;
    const len = tuning.mouthLength || 40;
    const curve = tuning.mouthCurve || 15;
    const rot = tuning.mouthRotate || 0;
    const isTriangle = tuning.mouthOpenShape === 'triangle';
    const tongueAmount = tuning.mouthTongue || 0;

    const content = () => {
      switch(viseme) {
        case 'open':
          if (isTriangle) {
            return (
               <g>
                 <path d={`M ${mouthX-len} ${mouthY-len*0.3} L ${mouthX+len} ${mouthY-len*0.3} Q ${mouthX} ${mouthY+len*1.2} ${mouthX-len} ${mouthY-len*0.3}`} fill="black" />
                 {/* Teeth */}
                 {(tuning.mouthTeeth || 0) > 0 && (
                    <rect x={mouthX - len*0.8} y={mouthY - len*0.3} width={len*1.6} height={tuning.mouthTeeth} fill="white" />
                 )}
                 {/* Tongue */}
                 {tongueAmount > 0 && (
                    <path d={`M ${mouthX - len*0.6} ${mouthY + len*0.8} Q ${mouthX} ${mouthY + len*0.8 - tongueAmount} ${mouthX + len*0.6} ${mouthY + len*0.8}`} fill="#ff7f7f" />
                 )}
               </g>
            );
          }
          return (
             <g>
               <ellipse cx={mouthX} cy={mouthY} rx={len + 5} ry={len * 0.8} fill="black" />
                {/* Teeth */}
                {(tuning.mouthTeeth || 0) > 0 && (
                   <rect x={mouthX - len*0.7} y={mouthY - len*0.5} width={len*1.4} height={tuning.mouthTeeth} rx="2" fill="white" />
                )}
                {/* Tongue */}
                {tongueAmount > 0 && (
                   <ellipse cx={mouthX} cy={mouthY + len*0.5} rx={len*0.5} ry={tongueAmount} fill="#ff7f7f" />
                )}
             </g>
          );
        case 'o':
          return (
             <g>
                <circle cx={mouthX} cy={mouthY} r={len * 0.7} fill="black" />
                {tongueAmount > 0 && (
                   <circle cx={mouthX} cy={mouthY + len*0.3} r={tongueAmount} fill="#ff7f7f" />
                )}
             </g>
          );
        case 'wide':
          return <path d={`M ${mouthX-len} ${mouthY} Q ${mouthX} ${mouthY + curve + 5} ${mouthX+len} ${mouthY}`} stroke="black" strokeWidth={thickness + 2} fill="none" strokeLinecap="round" />;
        case 'sick':
          return <path d={`M ${mouthX-len} ${mouthY+curve} Q ${mouthX} ${mouthY - curve*0.5} ${mouthX+len} ${mouthY+curve}`} stroke="black" strokeWidth={thickness} fill="none" strokeLinecap="round" />;
        case 'closed':
        default:
          if (emotion === 'happy') {
             return <path d={`M ${mouthX-len} ${mouthY-5} Q ${mouthX} ${mouthY + curve} ${mouthX+len} ${mouthY-5}`} stroke="black" strokeWidth={thickness} fill="none" strokeLinecap="round" />;
          }
          if (emotion === 'sad') {
             return <path d={`M ${mouthX-len} ${mouthY+10} Q ${mouthX} ${mouthY - curve} ${mouthX+len} ${mouthY+10}`} stroke="black" strokeWidth={thickness} fill="none" strokeLinecap="round" />;
          }
          if (emotion === 'disgusted') {
             return <path d={`M ${mouthX-len} ${mouthY+curve} Q ${mouthX} ${mouthY - curve*0.5} ${mouthX+len} ${mouthY+curve}`} stroke="black" strokeWidth={thickness} fill="none" strokeLinecap="round" />;
          }
          return <path d={`M ${mouthX-len} ${mouthY} Q ${mouthX} ${mouthY + curve} ${mouthX+len} ${mouthY}`} stroke="black" strokeWidth={thickness} fill="none" strokeLinecap="round" />;
      }
    };

    return (
      <g transform={`rotate(${rot}, ${mouthX}, ${mouthY})`}>
        {content()}
      </g>
    );
  };

  // 2. Eyes Resolve (Larger, Angled-In South Park Style)
  const renderEyes = () => {
    // Current "best" defaults: left 315, right 603, y 460, w 132, h 162
    const baseLX = 315;
    const baseRX = 603;
    const baseY = 460;
    
    // Position Shift
    const shiftX = (tuning.eyeXOffset || 0);
    const shiftY = (tuning.eyeYOffset || 0);
    const spacing = (tuning.eyeSpacing || 0);

    const leftEyeX = baseLX + shiftX - (spacing / 2);
    const rightEyeX = baseRX + shiftX + (spacing / 2);
    const eyeY = baseY + shiftY;
    
    // eyeSize is base height, eyeRoundness is aspect ratio (W/H)
    const eyeHeight = (tuning.eyeSize || 162); 
    const eyeWidth = eyeHeight * (tuning.eyeRoundness || 0.81); 
    const eyeRotate = tuning.eyeRotate !== undefined ? tuning.eyeRotate : 18;

    const isClosed = eyeState === 'closed' || emotion === 'sad';
    const isSleepy = eyeState === 'sleepy';

    if (isClosed) {
      const closedWidth = eyeWidth * 0.6; // Scale with overall eye size
      const eyelidRot = tuning.eyelidRotate !== undefined ? tuning.eyelidRotate : 15;
      return (
        <g stroke="black" strokeWidth="12" fill="none" strokeLinecap="round">
           <path 
             d={`M ${leftEyeX - closedWidth} ${eyeY} Q ${leftEyeX} ${eyeY - 15} ${leftEyeX + closedWidth} ${eyeY}`} 
             transform={`rotate(${-eyelidRot}, ${leftEyeX}, ${eyeY})`}
           />
           <path 
             d={`M ${rightEyeX - closedWidth} ${eyeY} Q ${rightEyeX} ${eyeY - 15} ${rightEyeX + closedWidth} ${eyeY}`} 
             transform={`rotate(${eyelidRot}, ${rightEyeX}, ${eyeY})`}
           />
        </g>
      );
    }

    // Pupil Logic with States
    let pupilX = tuning.pupilXOffset || 0;
    let pupilY = tuning.pupilYOffset || 0;

    if (eyeState === 'eyeroll') { pupilY = -eyeHeight * 0.45; }
    if (eyeState === 'looking_left') { pupilX = -eyeWidth * 0.4; }
    if (eyeState === 'looking_right') { pupilX = eyeWidth * 0.4; }
    if (eyeState === 'squint') { pupilY = eyeHeight * 0.1; }

    return (
      <g>
        {/* Whites */}
        <ellipse 
          cx={leftEyeX} cy={isSleepy ? eyeY + (eyeHeight*0.2) : eyeY} 
          rx={eyeWidth} ry={isSleepy ? eyeHeight * 0.4 : eyeHeight} 
          fill="#fafafa" stroke="none" 
          transform={`rotate(${eyeRotate}, ${leftEyeX}, ${eyeY})`}
        />
        <ellipse 
          cx={rightEyeX} cy={isSleepy ? eyeY + (eyeHeight*0.2) : eyeY} 
          rx={eyeWidth} ry={isSleepy ? eyeHeight * 0.4 : eyeHeight} 
          fill="#fafafa" stroke="none" 
          transform={`rotate(${-eyeRotate}, ${rightEyeX}, ${eyeY})`}
        />
        {/* Pupils */}
        <circle 
          cx={leftEyeX + 35 + pupilX} 
          cy={eyeY - 15 + pupilY} 
          r={tuning.pupilSize || 7} 
          fill="#111111" 
        />
        <circle 
          cx={rightEyeX - 35 - pupilX} 
          cy={eyeY - 15 + pupilY} 
          r={tuning.pupilSize || 7} 
          fill="#111111" 
        />
      </g>
    );
  };
;

  // 3. Brows Resolve (South Park Style: Simple black strokes)
  const renderBrows = () => {
    // Current "best" eye defaults for baseline
    const baseLX = 315;
    const baseRX = 603;
    const eyeY = 460 + (tuning.eyeYOffset || 0);
    const eyeShiftX = (tuning.eyeXOffset || 0);
    const eyeSpacing = (tuning.eyeSpacing || 0);

    const leftEyeX = baseLX + eyeShiftX - (eyeSpacing / 2);
    const rightEyeX = baseRX + eyeShiftX + (eyeSpacing / 2);

    // Brow-specific tuning
    const shiftX = (tuning.browXOffset || 0);
    const shiftY = (tuning.browYOffset || 0);
    const spacing = (tuning.browSpacing || 0);
    const thickness = (tuning.browThickness || 6);
    const width = (tuning.browWidth || 60) / 2;
    const rotation = (tuning.browRotate !== undefined ? tuning.browRotate : 0);

    const baseBY = eyeY - 80; // Height above the eyes
    const browY = baseBY + shiftY;
    
    // Emotion-based offsets
    let emotionY = 0;
    let emotionTilt = 0;
    if (emotion === 'angry') { emotionY = 30; emotionTilt = 20; }
    if (emotion === 'sad') { emotionY = -10; emotionTilt = -25; }

    const leftBrowX = leftEyeX + shiftX - (spacing / 2);
    const rightBrowX = rightEyeX + shiftX + (spacing / 2);

    return (
      <g stroke="black" strokeWidth={thickness} fill="none" strokeLinecap="round">
        {/* Left Brow */}
        <path 
          d={`M ${leftBrowX - width} ${browY + emotionY} L ${leftBrowX + width} ${browY + emotionY}`}
          transform={`rotate(${rotation + emotionTilt}, ${leftBrowX}, ${browY + emotionY})`}
        />
        {/* Right Brow */}
        <path 
          d={`M ${rightBrowX - width} ${browY + emotionY} L ${rightBrowX + width} ${browY + emotionY}`}
          transform={`rotate(${-rotation - emotionTilt}, ${rightBrowX}, ${browY + emotionY})`}
        />
      </g>
    );
  };

  return (
    <svg 
      xmlns="http://www.w3.org/2000/svg" 
      width="918" 
      height="1142" 
      viewBox="0 0 918 1142"
      className={className}
    >
      <path fill="#239938" d="m771.1 322-.6 25.5-3 .2c-1.6 0-8.6-1.2-15.5-2.7a1401 1401 0 0 0-186-26.4c-57-4.4-136.3-5.4-186.5-2.2a1405 1405 0 0 0-177 21.1c-7 1.4-16.2 3-35.9 6.5a52 52 0 0 1-11.9 1.3q-1-.7-.4-37.3c.3-20.1.4-37.6 0-38.8-.5-2-1.2-2.2-6.7-2.2-9.8 0-18.8 3.5-34.1 13.1-8 5.1-8.5 5.3-8.5 2.5 0-2 1.6-3.4 8-7.6a80 80 0 0 1 29.8-12.6l9.8-2c1.3-.3 1.9-14.8 3.2-74.6.6-29.3 1-34 2.3-35.4 1.6-1.5 15-1.6 166-1.5 134.5.2 167.4.4 180.9 1.6 13.2 1.2 40.5 1.5 135.5 1.6 65.5 0 122 .4 125.5.8l6.5.6.2 43 .2 56.2.1 13.2 5.8 1.7a92 92 0 0 1 26 12c4.5 3 9.4 5.4 10.7 5.4q2.4.1 2.5 1.4l.6 4.5q.6 3-.5 3.1a62 62 0 0 1-10.9-7q-18.1-13-29.6-13H772l-.1 11.3zM452 811.4q-3.4.9-5.5 1.2c-2.9.4-5.9 0-14.6-1l-.4-.1c-23-2.9-46.6-9.5-75.5-21.1a413 413 0 0 1-42-19c-46.6-23.3-83.1-49.6-100.9-72.9-11.7-15.3-11-16.6 2.6-5a387 387 0 0 0 174 84A380 380 0 0 0 515 780a384 384 0 0 0 109.5-35.6c28.1-14 56.5-32.8 80-52.7 4.2-3.6 8.3-6.6 9-6.6 2.7 0 3.3 11.9 1 19.6l-1.5 5.2c0 .4-13.4 14.4-19.7 20.4a293 293 0 0 1-39.5 29.8 473 473 0 0 1-69.3 33.5 356 356 0 0 1-49.5 15 249 249 0 0 1-35 4.5 71 71 0 0 1-27-6c0-.6-1.1-1.5-2.5-2.2-2.1-1-3.2-.7-7.4 2a48 48 0 0 1-11.1 4.6M200.5 972c-.3.6-3.8 1-7.8 1-5.4-.1-6.6-.4-5-1 3-1.2 18-1.6 19-.5.5.4-.6.5-2.4.2-1.8-.4-3.5-.2-3.8.3"/>
      <path fill="#3c524d" d="M629 1138.4c-4 .8-27.5.8-28.2 0-.3-.3-8.2-.7-17.4-.9-9.3-.2-32.4-1-51.4-1.7a2403 2403 0 0 0-110-.8c-104.8.7-195.2.4-216.1-.7-15.5-.8-18.2-1.2-22.5-3.4q-8.8-4.3-2.8-8.8c3.4-2.7 7.9-4 18.4-5.1l11.8-1.6 3.2-.6v-43.5c0-40.9.1-43.4 1.8-42.9A1543 1543 0 0 0 362 1052c15.9 2 46.6 4 73.6 4.6l28.1.7.7-89c.3-48.8.9-105.1 1.2-125 .6-35.3.6-36.3-1.2-36.3-1.1 0-2.8.6-4 1.4-1 .7-4.3 2-7.7 2.8a58 58 0 0 0 10.4-4.4c4.2-2.7 5.3-3 7.4-2q2.3 1.2 2.5 2.2.2.9 1.8 1c1 0 2.3.5 2.8 1a16 16 0 0 0 5.4 1.8l-6.6-1.5-2-.5-.7 68.9-1.4 124.2-.6 55.4 22.9-.6c62.3-1.8 133-11 191.4-24.7 24-5.6 27-6.2 27-5.2 0 .4-1.9 1.4-4.2 2.2l-4.2 1.5.3 43c.1 23.7.6 43.3 1 43.7.3.3 5.8 1.1 12.1 1.7 21.4 2 25.6 3 29.7 6.7 4.5 4 4 4.5-5.1 6.8-11 2.7-28.5 3.6-70.7 3.9-23 .1-41.3.5-40.7.8s-.5 1-2.2 1.3M403 941.7V969H298l.5-120.5 11-.6c6-.4 28.9-1 50.7-1.4l39.7-.8.5 2.4c1 4 2.6 64.3 2.6 93.6M586.4 963a1658 1658 0 0 0-56.1.4c-1-.4-1.3-13.5-1.3-60.5V843l2.3-.4c2.7-.6 64.4-2 85.2-2l15-.1.6 19.5c.4 10.7 1 38.3 1.4 61.3l.8 41.7ZM478.2 720.7l-10.8 8.4c-1.1.9-22.4-11.3-38.4-22a680 680 0 0 1-59.2-45.7 32 32 0 0 1-6.8-14.8c0-2.3.3-2.3 14.8-3 72.8-3.1 182.2-1 186.9 3.8 1.6 1.6-17.7 23-31 34.4a205 205 0 0 1-33.9 24.3 253 253 0 0 0-21.6 14.6M304 911.5v51.7l46.8-.7 46.7-.9c.4-2-1.7-90.2-2.3-95.1l-.7-7-14 17.5-20.9 26.3c-3.7 4.8-7.2 8.4-7.8 8.1-1.3-.9-7.7-7.9-27.7-30.4a440 440 0 0 0-19.2-20.8c-.5-.2-.9 19.6-.9 51.3m231.8 45c.4.4 9.7.5 20.7.1 11-.3 31.4-.6 45.3-.6H627v-25.7c0-14.2-.3-37-.7-50.6-.6-23.4-.7-24.6-2.4-23.2-1 1-10.6 12.4-21.5 25.6A532 532 0 0 1 582 906c-.4 0-7.6-7.7-16-17.2l-22.6-24.6-7-7.5-.7 25.8c-1 34.5-.9 73 0 74m32-75.7c7.3 7.8 13.8 14.2 14.2 14.2.5 0 8.4-9 17.7-20.1 19-22.9 22.8-27.7 22.2-28.4-.3-.2-16.7.2-36.4 1l-40.2 1.5c-2.5 0-4.3.5-4.3 1.1 0 1.5 10 13 26.7 30.6m-232.1 4.5c8.5 9.2 15.8 16.7 16.2 16.7s1.9-1.2 3.2-2.7a1983 1983 0 0 0 33.9-42.6l1.5-2-39.5.7c-21.7.4-39.6.9-39.9 1.1-.7.7 7.9 10.8 24.5 28.8M470 677c1.6 1 23.4 1.2 30.3.3 4.2-.6 4.9-1 6.3-4.3 1.7-4 8.3-23.1 8.3-24.1 0-.4-8.7-1.2-19.2-1.8s-20.5-1.5-22-1.8c-3.4-.8-3.7.3-4.5 16.8-.5 11.5-.4 14.1.8 14.9m-45.1-3c2 .4 11.2.7 20.6.8l17.1.1.7-4.6c.3-2.6.6-9 .6-14.5 0-8.4-.2-9.8-1.8-10.3-1-.3-8.5-.1-16.7.4l-17.3 1q-5 .1-6.4 21.5l-.3 5Zm87 1.7c0 1.9 12.9.5 19.9-2 6.6-2.5 11-6.5 19-16.7 4.1-5.5 5.6-8 4.6-8.5-.7-.2-8.2-.8-16.7-1.2l-15.4-.7-4.6 9.4a57 57 0 0 0-6.8 19.7M401.7 673h1.4c6.6.7 9.3 1 10.7-.3 1-1 1.3-2.7 1.9-5.8l2.6-12.2 1.4-5.8h-20c-15.2 0-19.8.3-19.8 1.3 0 2.8 8.7 18.3 11.3 20.1q2.6 2 10.5 2.7M209 971l-2.2.4c-.6-.6-4.9-.7-9.3-.6l4.7-.5c7.7-1.3 15.3-10.7 16.5-20.4 2.1-18-17-32.5-33.2-25.1a31 31 0 0 0-14.5 17.3c-1.3 6.5-1.3 6.9 1 13s6.5 11 12 13.8c2.5 1.4 7 2 11.8 2a35 35 0 0 0-8 1q-.9.3-.7.5c-4.2-.5-6.5-2.2-10.3-6-6.3-6-7.3-8.8-7.3-19.7 0-9.3.1-9.7 3.1-13.5 3.9-4.8 17.4-14.4 19.4-13.8 6.6 1.9 6.7 1.9 7.3-2.2 3.2-22.7 10.6-55.5 14.2-63.3 1.6-3.5 1.6-3.4 1 5.5-.2 5-2.3 19.8-4.5 33s-4 25.1-4 26.5q-.1 2.5 5.6 8c7.2 7 9.3 11.6 9.4 20.2 0 5.9-.5 7.6-4.2 14.7s-4.7 8.3-7.8 9.1m315.6-517c-5.5 2.5-6.4 2.4-11.9-1-6.6-4.2-7.8-9.5-4.2-18.3 1.2-3 6.9-5.8 11.8-5.8 10.3 0 16.1 12.2 10 20.9-.8 1.3-3.4 3.2-5.7 4.2m-117-1.7c-4.3 2-6.3 2-10.6-.1a13 13 0 0 1-7.7-13q.8-8.3 7.5-11c16-6.7 26.5 16.6 10.8 24m292.8 475.4c.5 5.1.2 5.9-2 4.4-2.4-1.6-3.6-6-7-25a1267 1267 0 0 0-6.3-33.7c-3.5-17-4.9-28-3.3-27.1 1.8 1 9.7 26.9 12.5 40.6a453 453 0 0 1 6 40.8M502.7 1142c3.8-.1 7.4-.5 8.1-1.2q1.3-1.5 2 0c.7 1 4.3 1.2 16.3.8l19.4-.5 186.8.5 178.2.4zm193.2-154c-2 1.3-2 1.3-5.9-3.2-8-9.3-9-11.6-9-20.6 0-6.2.5-9.2 2-12a30 30 0 0 1 13-12.2c4.4-2.2 4.4-2.1-3.2 5.1-6.1 6-7.9 8.3-8.8 11.9q-3.9 15 9.6 27c2.9 2.5 3.4 3.4 2.3 4m-380.3 154h-203c88.1 0 112.9-.3 114.5-1.2q2.4-1.5 2.6 0c.3.6 39.3 1 85.9 1.2m95.1 0c34.6-.2 60.3-.5 60.3-1q.1-.9 1.5-1 1.4.1 1.5 1c0 .5 2 1 4.5 1s4.5-.5 4.5-1c0-1.4 2.8-1.2 3.3.3q.3 1.5 2.8-.2 2.3-1.4 2.7-.2c.2.6 3.1 1 6.6 1.1zM200.5 972c.3-.5 2-.7 3.8-.3h.5zm515.4-279.8c-.2-4-1-7.2-2.4-7.2 1.5 0 2.3 3 2.4 7.2M505.7 812.7l13.8-1.6-3 .4q-6 .9-10.8 1.2m199.8-94.8"/>
      <path fill="#55c225" d="M818.7 291.5v-.6c-.4-1.7-.7-3.8-.7-4.5q-.1-1.3-2.5-1.4c-1.3 0-6.2-2.4-10.7-5.4a92 92 0 0 0-26-12l-5.8-1.7v-13.2l-.3-56.2-.2-43-6.5-.6c-3.6-.4-60-.7-125.5-.8-95 0-122.3-.4-135.5-1.6-13.5-1.2-46.4-1.4-180.9-1.6-151-.1-164.5 0-166 1.5-1.4 1.4-1.7 6.1-2.3 35.4-1.3 59.8-2 74.3-3.2 74.6l-9.8 2A80 80 0 0 0 113 275c-6.4 4.2-8 5.7-8 7.6 0 2.8.5 2.6 8.5-2.5 15.3-9.6 24.3-13.1 34-13.1 5.6 0 6.3.2 6.8 2.2.4 1.2.3 18.7 0 38.8q-.6 36.6.4 37.3c.6.4 6-.2 11.9-1.3l19.8-3.5c-5.9 1.2-6 1.7-6.2 4A410 410 0 0 1 138.6 495a403 403 0 0 1-26.2 46.3c-3.5 5.4-6.3 10-6.3 10.4 0 1.3-11.8 16-18.7 23.4-16.5 17.5-37.8 29.3-50 27.6-15-2-25.5-15.6-30.3-39.1a194 194 0 0 1 1.6-73c3.2-17.8 3.7-20.3 5.6-28A620 620 0 0 1 28.4 415c17.1-47 45.2-96.3 69.3-122l6.1-6.6.7-98c.3-53.8 1-103 1.5-109.4 1.9-22.7 6.6-33.8 20.4-47.6a64 64 0 0 1 28-18c5.4-1.5 26.7-1.6 305-1.1 263 .4 299.7.6 304.3 2A85 85 0 0 1 805.2 43a87 87 0 0 1 13 27.5l2.3 8-.2 100c-.2 55-.6 103.7-1 108.2ZM771.1 322l.8-36.7.1-11.3h5.6q11.6 0 29.6 13a62 62 0 0 0 10.9 7l.4-.2-.1 1.2 5.9 5.7c17.6 17.3 43 59 59.5 97.8a425 425 0 0 1 26 84.5 231 231 0 0 1 5.6 59.5c0 22.1-.2 27-1.8 32.5-4.6 16.6-10.9 26.6-19.5 31.3-9.5 5.2-19.3 4.5-31.9-2.3-20.4-11-38.2-30-58.4-62.5a434 434 0 0 1-63.3-190.7c-.4-4.2-.7-7.7-1-8.6L752 345c6.9 1.5 13.9 2.8 15.5 2.7l3-.2ZM696 988c1-.6.6-1.5-2.3-4q-13.5-12-9.6-27c.9-3.6 2.7-6 8.8-11.9 6.1-5.8 7.4-7 5.3-6.1a102 102 0 0 0 13.9-9.5c21-17 44.4-20.7 66.5-10.5a129 129 0 0 1 21.5 14.1 90 90 0 0 1 13.4 26.5 64 64 0 0 1 0 27.8c-2.7 10.4-7 18-14.8 26.3a57 57 0 0 1-25.6 16.9 65 65 0 0 1-28 2.4c-2.5-.5-9.2-2.4-15-4l-11.1-3.3c-1.1-.3-13-14.8-17.1-21a100 100 0 0 1-6.8-12c-1-2-2.2-4.3-3.4-6 2.4 2.6 2.7 2.4 4.3 1.4M209 971c3.1-.9 4.1-2 7.8-9l-.7 1.5a94 94 0 0 0-6.2 15.4 58 58 0 0 1-15.8 28.5c-4.3 4.5-8.1 9-8.5 10q-.7 2-1.7.9t-5.6.8a64 64 0 0 1-72-14.6 51 51 0 0 1-11-15l-3.8-8v-13c0-12.5.2-13.4 3.5-21.9 3-7.8 4.5-9.9 12.3-18.1A70 70 0 0 1 134 909c6.4-2.8 9-3.3 18-3.7 9.9-.5 11-.3 18.4 2.6a93 93 0 0 1 14 7 51 51 0 0 0 10.4 5.4l-2.8-.8c-2-.6-15.5 9-19.4 13.8-3 3.8-3.1 4.2-3.1 13.5 0 11 1 13.7 7.3 19.8 3.8 3.7 6.1 5.4 10.3 6q.3.3 5.6.3a128 128 0 0 0 12.1-1.2q2.4.4 2-.2zm-6.8-.6-4.7.5h-1.7c-4.9.2-9.3-.5-11.9-1.9a26 26 0 0 1-11.9-13.7c-2.3-6.2-2.3-6.6-1-13 1.3-6 8.5-14.7 14.4-17.4 16.2-7.4 35.4 7.1 33.3 25.1-1.2 9.7-8.8 19-16.5 20.4m312.2-654.7a1598 1598 0 0 0-134.9.7 1481 1481 0 0 1 135-.7m215.4 24.6-6.5-1.2zm-37.2 601.6a30 30 0 0 0-8.8 8.8q2.8-5 8.8-8.8M681 963.2v1c0 4.8.3 7.7 1.7 10.7-1.5-2.8-1.7-4.7-1.7-10.8zm-482.2-43.4.5-2.5z"/>
      <path fill="#fa6111" d="m452 811.4.7-.2c3.4-.9 6.7-2 7.8-2.8a8 8 0 0 1 3.9-1.4c1.8 0 1.8 1 1.2 36.3-.3 19.9-.9 76.2-1.2 125l-.7 89-28-.7a894 894 0 0 1-95.7-7.1 1543 1543 0 0 1-124.2-21.1c-1.7-.5-1.8 2-1.8 43v-43.2l-2.7-.5c-1.6-.2-7.9-1.5-14.1-2.7-10.3-2.1-11.4-2.5-12.8-5.1l-1-2 .4.4q1.1 1.1 1.8-.9c.4-1 4.2-5.5 8.5-10a58 58 0 0 0 15.8-28.5 94 94 0 0 1 8.4-20A21 21 0 0 0 221 947q0-4.8-1.2-8.6a29 29 0 0 0-8.2-11.4q-5.7-5.5-5.6-8c0-1.4 1.8-13.3 4-26.5s4.3-28 4.6-33c.5-8.9.5-9-1.1-5.5a268 268 0 0 0-11.3 45.8v.1a417 417 0 0 0-3.5 20c-.4 1-1.4 1-4 .4a51 51 0 0 1-10.2-5.3 93 93 0 0 0-14.1-7.1c-7.5-3-8.5-3-18.4-2.6-9 .4-11.6.9-18 3.7a70 70 0 0 0-26.7 19.5 46 46 0 0 0-10.9 14.8c2-5.7 3.1-11 4.6-21.3 10.3-73.6 36.5-136 90.2-215l13.3-19.4.6-.7q1 2.6 8 11.6c17.8 23.3 54.3 49.6 100.9 72.8a413 413 0 0 0 42 19 349 349 0 0 0 46.6 15.7q14.9 3.7 28.9 5.5h.4c8.7 1.1 11.7 1.5 14.6 1.1 1.6-.2 3-.6 5.5-1.2m98.8-6.9a243 243 0 0 0 33.7-11l13-5.1c12.9-5 43-20.2 56.3-28.4a293 293 0 0 0 39.5-29.8l12.2-12.3 7.5-8.1.2-.8 5.7 9.2 9.3 14.8a690 690 0 0 1 29.7 52.7A396 396 0 0 1 800 924c1 7.5 2 10.4 5.5 17.5-2-3.9-4.1-7-5.5-8.4a122 122 0 0 0-21.5-14c-22-10.3-45.5-6.6-66.5 10.4a97 97 0 0 1-14 9.5l-2 1q-1.8.9-3.4 2a24 24 0 0 0-9.7 10.2 23 23 0 0 0-1.9 11v1c0 6 .2 8 1.7 10.7a48 48 0 0 0 9 11.8 49 49 0 0 1 3.3 6c1.5 3.3 4.6 8.7 6.8 12 4.2 6.2 16 20.7 17 21l5.2 1.5c-5.7-1.3-8.1-.8-13 1h-.1q2-1 2.1-1.4c0-1-3-.4-27 5.2-58.4 13.8-129 22.9-191.4 24.7l-23 .6.7-55.4 1.4-124.2.6-68.9 2.1.5 6.6 1.5a93 93 0 0 0 17 2.2l5.7-.3q4.7-.3 10.9-1.2l2.9-.4a249 249 0 0 0 31.3-6.5M403 941.8c0-29.4-1.7-89.8-2.6-93.7l-.5-2.4-39.7.8c-21.8.4-44.6 1-50.7 1.4l-11 .6L298 969h105ZM586.4 963h47.9l-.8-41.7c-.4-23-1-50.6-1.4-61.3l-.6-19.5h-15a2392 2392 0 0 0-85.2 2l-2.3.5v60c0 46.9.3 60 1.3 60.4a1658 1658 0 0 1 56.1-.4M304 911.5c0-31.7.4-51.5 1-51.3.4.1 9 9.5 19 20.8 20 22.5 26.5 29.5 27.8 30.4.6.3 4-3.4 7.8-8.1l20.9-26.3 14-17.5.7 7c.6 4.9 2.7 93.1 2.3 95.1l-46.7.9-46.8.7Zm231.8 45c-1-1-1-39.5-.1-74l.6-25.8 7.1 7.5c4 4 14 15.2 22.5 24.6s15.7 17.2 16 17.2 9.6-10.8 20.5-24a947 947 0 0 1 21.5-25.5c1.7-1.4 1.8-.2 2.4 23.2.4 13.7.7 36.4.7 50.5V956h-25.2c-14 0-34.3.3-45.3.6-11 .4-20.3.3-20.7-.1m32-75.7C550.8 863 541 851.6 541 850c0-.6 1.8-1.1 4.3-1.1l40.2-1.5c19.7-.8 36.1-1.2 36.4-1 .6.7-3.1 5.5-22.2 28.4-9.3 11-17.2 20.1-17.7 20.1s-6.9-6.4-14.3-14.2m-232.1 4.5c-16.7-18-25.2-28-24.6-28.8.3-.2 18.2-.7 40-1.1l39.4-.7-1.5 2c-3 4.1-31.4 39.9-33.9 42.5-1.3 1.6-2.8 2.8-3.2 2.8s-7.7-7.5-16.2-16.7m364.7 42.5a453 453 0 0 0-6-40.8c-2.9-13.7-10.8-39.5-12.6-40.6-1.6-1-.2 10.2 3.3 27.1a1267 1267 0 0 1 6.4 33.7c3.3 19 4.5 23.4 6.9 25 2.2 1.5 2.5.7 2-4.5M230.2 705.4q-7.5-5.7-14.5-11.8-6-5.2-8.7-7c1.7.9 5 3.7 12.7 10.3q5.1 4.3 10.5 8.5m474.4 325.1.3 43zM92.5 954c-1 3.4-1 6.6-1 14.5v13-13c0-8 0-11.1 1-14.6m718.5-1.2"/>
      <path fill="#f9d9b3" d="M514.4 315.7c18.2.7 35.8 1.6 51.6 2.9A1588 1588 0 0 1 723.3 339l6.5 1.2 9.8 2c.2.8.5 4.3.9 8.4A434 434 0 0 0 814.6 558c-6-8.1-6.8-8.9-7.5-8.9-.5 0-1.9 2.4-3.1 5.3a472 472 0 0 1-37 67.7 342 342 0 0 1-39.2 47.6l-13.8 14 .6 2.2q-.5-.8-1.1-.8c-.7 0-4.8 3-9 6.5a411 411 0 0 1-80 52.8A384 384 0 0 1 515 779.9a380 380 0 0 1-125.2-2.3 389 389 0 0 1-159.6-72.2l-10.5-8.5c-7.8-6.6-11-9.4-12.7-10.3q-2.7-1.6-2 .3l-.5.7-13.3 19.4-3.1 4.5 16.3-23.9c.6-1-2.7-4.8-11.6-13.7a459 459 0 0 1-43.5-51.9 504 504 0 0 1-37.6-68.7c-1-2.4-2-4.3-2.6-4.3-.3 0-2.3 2.2-4.7 5.3q1.5-2.2 1.6-2.7c0-.4 2.8-5 6.3-10.4a404 404 0 0 0 26.2-46.3 410 410 0 0 0 41.8-150.3c.1-2.4.2-2.9 6.1-4l16.1-3 1.3-.3q32.8-6 64-10.3c30.5-4 64-7.3 99-9.8a1516 1516 0 0 1 147.6-1.5"/>
      {renderEyes()}
      {renderBrows()}
      {renderMouth()}
    </svg>
  );
};

export default KyleSouthPark;
