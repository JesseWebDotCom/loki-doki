/**
 * ExpressionResolver.ts — The Canonical-to-DiceBear Bridge
 * Standardizes emotions and visemes across all collections.
 */

export type CanonicalViseme = 'closed' | 'open' | 'o' | 'wide' | 'neutral' | 'sick';
export type CanonicalEmotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'surprised' | 'scared' | 'disgusted';
export type CanonicalEyeState = 'default' | 'closed' | 'squint' | 'wide' | 'wink' | 'cry' | 'angry' | 'sleepy' | 'eyeroll' | 'looking_left' | 'looking_right';

export interface DiceBearFaceProps {
  mouth?: string[];
  eyes?: string[];
  eyebrows?: string[];
}

interface StyleMap {
  mouths: Record<string, string>;
  eyes: Record<string, string>;
  eyebrows: Record<string, string>;
  emotions: Record<string, { mouth: string; eyes: string; eyebrows?: string }>;
}

const STYLE_MAPPINGS: Record<string, StyleMap> = {
  avataaars: {
    mouths: { closed: 'default', open: 'screamOpen', o: 'disbelief', wide: 'smile', neutral: 'default', sick: 'vomit' },
    eyes: { default: 'default', closed: 'closed', squint: 'squint', wide: 'surprised', wink: 'wink', cry: 'cry', angry: 'default', eyeroll: 'eyeRoll', looking_left: 'side', looking_right: 'side' },
    eyebrows: { default: 'default', raised: 'raisedExcited', angry: 'angry', sad: 'sadConcerned', upDown: 'upDown' },
    emotions: {
      neutral: { mouth: 'default', eyes: 'default', eyebrows: 'default' },
      happy: { mouth: 'smile', eyes: 'happy', eyebrows: 'raisedExcited' },
      sad: { mouth: 'sad', eyes: 'cry', eyebrows: 'sadConcerned' },
      angry: { mouth: 'serious', eyes: 'default', eyebrows: 'angry' },
      surprised: { mouth: 'screamOpen', eyes: 'surprised', eyebrows: 'raisedExcited' },
      scared: { mouth: 'disbelief', eyes: 'surprised', eyebrows: 'sadConcerned' },
      disgusted: { mouth: 'grimace', eyes: 'side', eyebrows: 'upDown' },
    }
  },
  bottts: {
    mouths: { closed: 'closed01', open: 'open01', o: 'round01', wide: 'smile01', neutral: 'default', sick: 'closed02' },
    eyes: { default: 'default', closed: 'closed', squint: 'low', wide: 'open', wink: 'wink', cry: 'default', angry: 'default', eyeroll: 'low', looking_left: 'default', looking_right: 'default' },
    eyebrows: {},
    emotions: {
      neutral: { mouth: 'default', eyes: 'default' },
      happy: { mouth: 'smile01', eyes: 'open' },
      sad: { mouth: 'closed01', eyes: 'low' },
      angry: { mouth: 'closed01', eyes: 'low' },
      surprised: { mouth: 'open01', eyes: 'open' },
      scared: { mouth: 'round01', eyes: 'open' },
      disgusted: { mouth: 'closed02', eyes: 'low' },
    }
  },
  personas: {
    mouths: { closed: 'frown', open: 'surprise', o: 'pacifier', wide: 'smile', neutral: 'neutral', sick: 'frown' },
    eyes: { default: 'open', closed: 'sleep', squint: 'open', wide: 'open', wink: 'wink', cry: 'open', angry: 'open', eyeroll: 'sleep', looking_left: 'open', looking_right: 'open' },
    eyebrows: {},
    emotions: {
      neutral: { mouth: 'neutral', eyes: 'open' },
      happy: { mouth: 'smile', eyes: 'happy' },
      sad: { mouth: 'frown', eyes: 'sleep' },
      angry: { mouth: 'frown', eyes: 'open' },
      surprised: { mouth: 'surprise', eyes: 'open' },
      scared: { mouth: 'surprise', eyes: 'open' },
      disgusted: { mouth: 'smirk', eyes: 'open' },
    }
  },
  micah: {
    mouths: { closed: 'smirk', open: 'surprised', o: 'pucker', wide: 'smile', neutral: 'smile' },
    eyes: { default: 'eyes', closed: 'eyes', squint: 'smiling', wide: 'round', wink: 'eyes', cry: 'eyes', angry: 'eyes' },
    eyebrows: {},
    emotions: {
      neutral: { mouth: 'smile', eyes: 'eyes' },
      happy: { mouth: 'laughing', eyes: 'smiling' },
      sad: { mouth: 'sad', eyes: 'eyes' },
      angry: { mouth: 'frown', eyes: 'eyes' },
      surprised: { mouth: 'surprised', eyes: 'round' },
      scared: { mouth: 'nervous', eyes: 'round' },
      disgusted: { mouth: 'smirk', eyes: 'eyes' },
    }
  },
  bigSmile: {
    mouths: { closed: 'awkwardSmile', open: 'openedSmile', o: 'gapSmile', wide: 'teethSmile', neutral: 'unimpressed', sick: 'awkwardSmile' },
    eyes: { default: 'normal', closed: 'sleepy', squint: 'confused', wide: 'starstruck', wink: 'winking', cry: 'sad', angry: 'angry', eyeroll: 'normal', looking_left: 'normal', looking_right: 'normal' },
    eyebrows: {},
    emotions: {
      neutral: { mouth: 'unimpressed', eyes: 'normal' },
      happy: { mouth: 'teethSmile', eyes: 'cheery' },
      sad: { mouth: 'openSad', eyes: 'sad' },
      angry: { mouth: 'unimpressed', eyes: 'angry' },
      surprised: { mouth: 'openedSmile', eyes: 'starstruck' },
      scared: { mouth: 'openedSmile', eyes: 'confused' },
      disgusted: { mouth: 'unimpressed', eyes: 'confused' },
    }
  },
  pixelArt: {
    mouths: { closed: 'sad01', open: 'happy13', o: 'happy09', wide: 'happy01', neutral: 'happy01' },
    eyes: { default: 'variant01', closed: 'variant12', squint: 'variant05', wide: 'variant01', wink: 'variant11', cry: 'variant05', angry: 'variant05' },
    eyebrows: {},
    emotions: {
      neutral: { mouth: 'happy01', eyes: 'variant01' },
      happy: { mouth: 'happy13', eyes: 'variant01' },
      sad: { mouth: 'sad10', eyes: 'variant05' },
      angry: { mouth: 'sad01', eyes: 'variant05' },
      surprised: { mouth: 'happy09', eyes: 'variant01' },
      scared: { mouth: 'happy09', eyes: 'variant01' },
      disgusted: { mouth: 'sad01', eyes: 'variant05' },
    }
  },
  adventurer: {
    mouths: { closed: 'variant01', open: 'variant11', o: 'variant09', wide: 'variant04', neutral: 'variant01' },
    eyes: { default: 'variant01', closed: 'variant10', squint: 'variant15', wide: 'variant01', wink: 'variant05', cry: 'variant16', angry: 'variant15' },
    eyebrows: {},
    emotions: {
      neutral: { mouth: 'variant01', eyes: 'variant01' },
      happy: { mouth: 'variant10', eyes: 'variant01' },
      sad: { mouth: 'variant03', eyes: 'variant16' },
      angry: { mouth: 'variant01', eyes: 'variant15' },
      surprised: { mouth: 'variant11', eyes: 'variant01' },
      scared: { mouth: 'variant11', eyes: 'variant01' },
      disgusted: { mouth: 'variant01', eyes: 'variant15' },
    }
  }
};

/**
 * resolveExpression — The unified rig engine.
 * 1. Resolves emotion to baseline mouth/eyes.
 * 2. Overrides with specific viseme or eyeState if provided.
 * 3. Fallbacks to neutral if mapping is missing.
 */
export function resolveExpression(
  style: string,
  emotion: CanonicalEmotion = 'neutral',
  viseme?: CanonicalViseme,
  eyeState?: CanonicalEyeState
): DiceBearFaceProps {
  const map = STYLE_MAPPINGS[style] || STYLE_MAPPINGS['avataaars']; // Default to avataaars if style unknown
  
  // Baseline emotion
  const baseline = map.emotions[emotion] || map.emotions['neutral'];
  let resolvedMouth = baseline.mouth;
  let resolvedEyes = baseline.eyes;
  let resolvedEyebrows = baseline.eyebrows;

  // Blending: Specific overrides
  if (viseme) {
    resolvedMouth = map.mouths[viseme] || map.mouths['neutral'] || resolvedMouth;
  }
  
  if (eyeState) {
    resolvedEyes = map.eyes[eyeState] || map.eyes['default'] || resolvedEyes;
    // Map eyeState to eyebrows if not already set by emotion
    if (!resolvedEyebrows && map.eyebrows[eyeState]) {
      resolvedEyebrows = map.eyebrows[eyeState];
    }
  }

  return {
    mouth: resolvedMouth ? [resolvedMouth] : undefined,
    eyes: resolvedEyes ? [resolvedEyes] : undefined,
    eyebrows: resolvedEyebrows ? [resolvedEyebrows] : undefined,
  };
}
