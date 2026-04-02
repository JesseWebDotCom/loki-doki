/**
 * VoiceDetector Utility
 * High-precision, spectral-based Voice Activity Detection (VAD)
 * Extracts vocal features from FFT frequency data.
 */

export interface VoiceFeatures {
  nasalPower: number;    // 150 - 450 Hz (M, B, N)
  vowelPower: number;    // 450 - 1100 Hz (O, Ah)
  clarityPower: number;  // 1100 - 3000 Hz (Ee, Wide)
  sibilantPower: number; // 3000 - 8000 Hz (S, P, F, X)
  centroid: number;      // Spectral centroid (avg frequency weighted by magnitude)
  isVocalDetected: boolean;
  score: Record<string, number>;
}

export interface VoiceDetectorOptions {
  sampleRate: number;
  fftSize: number;
  sensitivity: number;
  isSpeaking: boolean; // Current state for hysteresis
}

export function detectVoice(
  dataArray: Uint8Array, 
  options: VoiceDetectorOptions
): VoiceFeatures {
  const { sampleRate, fftSize, sensitivity, isSpeaking } = options;
  const clampedSensitivity = Math.max(0, Math.min(1, sensitivity));
  const binWidth = sampleRate / fftSize;
  
  let totalMagnitude = 0;
  let weightedSum = 0;
  
  let nasalPower = 0;
  let vowelPower = 0;
  let clarityPower = 0;
  let sibilantPower = 0;

  // 1. Spectral Integration
  for (let i = 1; i < dataArray.length; i++) {
    const mag = dataArray[i];
    const freq = i * binWidth;
    
    totalMagnitude += mag;
    weightedSum += freq * mag;

    if (freq < 450) nasalPower += mag;
    else if (freq < 1100) vowelPower += mag;
    else if (freq < 3000) clarityPower += mag;
    else if (freq < 8000) sibilantPower += mag;
  }

  const centroid = totalMagnitude > 0 ? weightedSum / totalMagnitude : 0;
  const normalizedAvg = (totalMagnitude / dataArray.length) / 255;

  // 2. Adaptive Vocal Gate (VAD)
  // Higher sensitivity should lower the gate, not raise it.
  const sensitivityBias = 1 - clampedSensitivity;
  const vocalThreshold = (isSpeaking ? 0.022 : 0.038) + (sensitivityBias * 0.03);
  const magnitudeFloor = (isSpeaking ? 80 : 110) + (sensitivityBias * 70);
  const isVocalDetected = normalizedAvg > vocalThreshold && totalMagnitude > magnitudeFloor;

  // 3. Phonetic Scoring
  const clarificationFloor = 1.0;
  const score = {
    m: (nasalPower * 1.6) / (vowelPower + clarificationFloor),
    o: (vowelPower * 1.4) / (clarityPower + clarificationFloor),
    wide: ((clarityPower * 1.5) + (sibilantPower * 1.8)) / (vowelPower + clarificationFloor),
    p: (sibilantPower * 2.5) / (vowelPower + clarificationFloor),
    b: (nasalPower * 2.5) / (vowelPower + clarificationFloor),
    open: (vowelPower * 1.2) / (nasalPower + clarificationFloor)
  };

  return {
    nasalPower,
    vowelPower,
    clarityPower,
    sibilantPower,
    centroid,
    isVocalDetected,
    score
  };
}
