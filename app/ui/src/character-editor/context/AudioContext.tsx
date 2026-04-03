import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { detectVoice } from '../utils/VoiceDetector';

interface AudioContextType {
  isListening: boolean;
  status: 'idle' | 'requesting' | 'listening' | 'error';
  errorMessage: string | null;
  permissionState: 'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported';
  lastAction: string | null;
  frequencyData: Uint8Array<ArrayBuffer> | null;
  volume: number; // Avg volume (0-1)
  peakVolume: number; // Max peak in the current frame (0-1)
  viseme: string; // Current mouth shape
  isSpeaking: boolean; // Threshold-based speaking state
  startListening: () => Promise<void>;
  stopListening: () => void;
  sensitivity: number;
  setSensitivity: (v: number) => void;
  voiceIsolation: boolean;
  setVoiceIsolation: (v: boolean) => void;
  reflexesEnabled: boolean;
  setReflexesEnabled: (v: boolean) => void;
}

export const AudioContext = createContext<AudioContextType | undefined>(undefined);
const AUDIO_ENGINE_AUTOSTART_KEY = "loki_audio_engine_autostart";

/**
 * AudioProvider — The Biological Audio Engine (Phase 2.3)
 * High-sensitivity microphone analysis with peak detection and FFT.
 */
export const AudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isListening, setIsListening] = useState(false);
  const [status, setStatus] = useState<'idle' | 'requesting' | 'listening' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [permissionState, setPermissionState] = useState<'unknown' | 'prompt' | 'granted' | 'denied' | 'unsupported'>('unknown');
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [autoStartEnabled, setAutoStartEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(AUDIO_ENGINE_AUTOSTART_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [frequencyData, setFrequencyData] = useState<Uint8Array<ArrayBuffer> | null>(null);
  const [volume, setVolume] = useState(0);
  const [peakVolume, setPeakVolume] = useState(0);
  const [viseme, setViseme] = useState('closed');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [sensitivity, setSensitivity] = useState(0.5);
  const [voiceIsolation, setVoiceIsolation] = useState(false);
  const [reflexesEnabled, setReflexesEnabled] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyzerRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dataArrayRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const restartTimeoutRef = useRef<number | null>(null);
  const requestTimeoutRef = useRef<number | null>(null);
  const volumeRef = useRef<number>(0);
  const centroidBaselineRef = useRef<number>(1200);
  const lastVisemeRef = useRef('closed');
  const lastSwitchTimeRef = useRef(0);
  const isSpeakingRef = useRef(false);
  const sensitivityRef = useRef(sensitivity);
  const voiceIsolationRef = useRef(voiceIsolation);
  const isListeningRef = useRef(false);
  const unmountedRef = useRef(false);
  const updateAudioDataRef = useRef<() => void>(() => undefined);
  const attemptedPermissionAutostartRef = useRef(false);

  useEffect(() => {
    sensitivityRef.current = sensitivity;
  }, [sensitivity]);

  useEffect(() => {
    voiceIsolationRef.current = voiceIsolation;
  }, [voiceIsolation]);

  useEffect(() => {
    isSpeakingRef.current = isSpeaking;
  }, [isSpeaking]);

  useEffect(() => {
    try {
      localStorage.setItem(AUDIO_ENGINE_AUTOSTART_KEY, autoStartEnabled ? "true" : "false");
    } catch {
      // Ignore storage failures in restricted environments.
    }
  }, [autoStartEnabled]);

  useEffect(() => {
    const queryPermission = async () => {
      try {
        if (!navigator.permissions?.query) {
          setPermissionState('unsupported');
          return;
        }

        const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
        setPermissionState(
          result.state === 'granted' || result.state === 'prompt' || result.state === 'denied'
            ? result.state
            : 'unknown'
        );

        result.onchange = () => {
          const nextState = result.state;
          setPermissionState(
            nextState === 'granted' || nextState === 'prompt' || nextState === 'denied'
              ? nextState
              : 'unknown'
          );
        };
      } catch {
        setPermissionState('unsupported');
      }
    };

    void queryPermission();
  }, []);

  const updateAudioData = useCallback(() => {
    const analyzer = analyzerRef.current;
    const dataArray = dataArrayRef.current;
    const audioContext = audioContextRef.current;

    if (!analyzer || !dataArray || !audioContext || !isListeningRef.current) {
      return;
    }

    analyzer.getByteFrequencyData(dataArray);

    let sum = 0;
    let max = 0;

    for (let i = 0; i < dataArray.length; i++) {
      const val = dataArray[i];
      sum += val;
      if (val > max) max = val;
    }

    const avg = sum / dataArray.length;
    const normalizedAvg = avg / 255;

    setVolume(normalizedAvg);
    setPeakVolume(max / 255);

    const voice = detectVoice(dataArray, {
      sampleRate: audioContext.sampleRate,
      fftSize: analyzer.fftSize,
      sensitivity: sensitivityRef.current,
      isSpeaking: isSpeakingRef.current,
    });

    const centroid = voice.centroid;
    const flux = Math.max(0, normalizedAvg - volumeRef.current);
    volumeRef.current = normalizedAvg;
    const isBurst = flux > 0.07;

    if (normalizedAvg > 0.1) {
      centroidBaselineRef.current = centroidBaselineRef.current * 0.95 + centroid * 0.05;
    }
    const baseline = centroidBaselineRef.current || 1200;

    const isVocalDetected = voice.isVocalDetected;

    if (isSpeakingRef.current && !isVocalDetected) {
      setIsSpeaking(false);
      setViseme('closed');
      isSpeakingRef.current = false;
      lastVisemeRef.current = 'closed';
    } else if (isSpeakingRef.current !== isVocalDetected) {
      setIsSpeaking(isVocalDetected);
      isSpeakingRef.current = isVocalDetected;
    }

    if (isVocalDetected) {
      const scores = { ...voice.score };
      const distFromBaseline = Math.abs(centroid - baseline) / baseline;
      if (centroid < baseline * 0.6) scores.m *= 2.0;
      if (centroid < baseline * 0.85) scores.o *= 1.8;
      if (centroid > baseline * 1.3) scores.wide *= 1.8;
      if (centroid > baseline * 2.2) scores.p *= 2.5;
      if (distFromBaseline < 0.2) scores.open *= 1.5;

      if (!isBurst) {
        scores.p = 0;
        scores.b = 0;
      }

      let nextViseme: AudioContextType['viseme'] = 'open';
      let maxScore = 0;
      const candidates = ['m', 'b', 'p', 'o', 'wide', 'open'] as const;
      for (const c of candidates) {
        if (scores[c] > maxScore) {
          maxScore = scores[c];
          nextViseme = c;
        }
      }

      const now = audioContext.currentTime * 1000;
      const isQuick = nextViseme === 'b' || nextViseme === 'p' || nextViseme === 'm';
      const switchThreshold = isQuick ? 20 : 60;

      if (nextViseme !== lastVisemeRef.current && now - lastSwitchTimeRef.current > switchThreshold) {
        setViseme(nextViseme);
        lastVisemeRef.current = nextViseme;
        lastSwitchTimeRef.current = now;
      }
    } else {
      setViseme('closed');
      lastVisemeRef.current = 'closed';
    }

    animationFrameRef.current = requestAnimationFrame(updateAudioDataRef.current);
  }, []);

  useEffect(() => {
    updateAudioDataRef.current = updateAudioData;
  }, [updateAudioData]);

  const stopListeningInternal = useCallback((disableAutoStart: boolean) => {
    isListeningRef.current = false;
    attemptedPermissionAutostartRef.current = false;
    if (disableAutoStart) {
      setAutoStartEnabled(false);
    }

    if (restartTimeoutRef.current !== null) {
      window.clearTimeout(restartTimeoutRef.current);
      restartTimeoutRef.current = null;
    }
    if (requestTimeoutRef.current !== null) {
      window.clearTimeout(requestTimeoutRef.current);
      requestTimeoutRef.current = null;
    }
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    sourceRef.current?.disconnect();
    sourceRef.current = null;
    analyzerRef.current = null;
    dataArrayRef.current = null;
    setFrequencyData(null);
    void audioContextRef.current?.close().catch(() => {});
    audioContextRef.current = null;

    setIsListening(false);
    setStatus('idle');
    setLastAction('Microphone analyzer stopped.');
    setVolume(0);
    setPeakVolume(0);
    setIsSpeaking(false);
    setViseme('closed');
    volumeRef.current = 0;
    isSpeakingRef.current = false;
    lastVisemeRef.current = 'closed';
  }, []);

  const stopListening = useCallback(() => {
    stopListeningInternal(true);
  }, [stopListeningInternal]);

  const startListening = useCallback(async () => {
    if (isListeningRef.current || unmountedRef.current) return;

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      setErrorMessage('This browser does not expose mediaDevices.getUserMedia.');
      setPermissionState('unsupported');
      setLastAction('Microphone request failed before starting.');
      return;
      }

      setStatus('requesting');
      setErrorMessage(null);
      setLastAction('Requested microphone access from the browser.');
      if (requestTimeoutRef.current !== null) {
        window.clearTimeout(requestTimeoutRef.current);
      }
      requestTimeoutRef.current = window.setTimeout(() => {
        if (!isListeningRef.current && !unmountedRef.current) {
          setStatus('error');
          setErrorMessage('The browser did not resolve the microphone request.');
          setLastAction('Microphone request timed out before a stream was returned.');
        }
      }, 8000);
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: voiceIsolationRef.current,
          autoGainControl: true
        } 
      });

      if (unmountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      
      if (requestTimeoutRef.current !== null) {
        window.clearTimeout(requestTimeoutRef.current);
        requestTimeoutRef.current = null;
      }
      streamRef.current = stream;
      audioContextRef.current = new window.AudioContext({ latencyHint: 'interactive' });
      analyzerRef.current = audioContextRef.current.createAnalyser();
      analyzerRef.current.fftSize = 256;
      analyzerRef.current.smoothingTimeConstant = 0.1;
      
      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      sourceRef.current.connect(analyzerRef.current);
      
      const bufferLength = analyzerRef.current.frequencyBinCount;
      dataArrayRef.current = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;
      setFrequencyData(dataArrayRef.current);
      isListeningRef.current = true;
      setIsListening(true);
      setStatus('listening');
      setPermissionState('granted');
      setAutoStartEnabled(true);
      setLastAction('Microphone analyzer is running.');
      attemptedPermissionAutostartRef.current = true;
      animationFrameRef.current = requestAnimationFrame(updateAudioData);
    } catch (err) {
      if (requestTimeoutRef.current !== null) {
        window.clearTimeout(requestTimeoutRef.current);
        requestTimeoutRef.current = null;
      }
      console.error('Microphone access denied:', err);
      setStatus('error');
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setPermissionState('denied');
      }
      setLastAction('Microphone request failed.');
      setErrorMessage(
        err instanceof Error ? err.message : 'Unable to access microphone.'
      );
    }
  }, [updateAudioData]);

  useEffect(() => {
    if (permissionState !== 'granted') {
      attemptedPermissionAutostartRef.current = false;
      return;
    }

    if (status !== 'idle' || isListeningRef.current || attemptedPermissionAutostartRef.current) {
      return;
    }

    attemptedPermissionAutostartRef.current = true;
    setLastAction('Permission already granted. Starting microphone analyzer automatically.');
    void startListening();
  }, [permissionState, startListening, status]);

  useEffect(() => {
    if (
      autoStartEnabled &&
      permissionState === 'granted' &&
      status === 'idle' &&
      !isListeningRef.current
    ) {
      setLastAction('Auto-start is enabled. Restarting microphone analyzer.');
      void startListening();
    }
  }, [autoStartEnabled, permissionState, startListening, status]);

  const handleVoiceIsolationChange = useCallback((nextValue: boolean) => {
    voiceIsolationRef.current = nextValue;
    setVoiceIsolation(nextValue);

    if (isListeningRef.current) {
      if (restartTimeoutRef.current !== null) {
        window.clearTimeout(restartTimeoutRef.current);
      }
      restartTimeoutRef.current = window.setTimeout(() => {
        stopListening();
        void startListening();
      }, 0);
    }
  }, [startListening, stopListening]);

  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      stopListeningInternal(false);
    };
  }, [stopListeningInternal]);

  return (
    <AudioContext.Provider value={{ 
      isListening, 
      status,
      errorMessage,
      permissionState,
      lastAction,
      frequencyData, 
      volume, 
      peakVolume,
      viseme,
      isSpeaking,
      startListening, 
      stopListening,
      sensitivity,
      setSensitivity,
      voiceIsolation,
      setVoiceIsolation: handleVoiceIsolationChange,
      reflexesEnabled,
      setReflexesEnabled
    }}>
      {children}
    </AudioContext.Provider>
  );
};

export const useAudio = () => {
  const context = useContext(AudioContext);
  if (!context) throw new Error('useAudio must be used within an AudioProvider');
  return context;
};
