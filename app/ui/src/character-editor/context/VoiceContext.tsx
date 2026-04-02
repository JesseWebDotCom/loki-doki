import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { VoiceStreamer } from '@/utils/VoiceStreamer';

import { getAccessToken } from '../config';
import type { CanonicalViseme } from '../utils/ExpressionResolver';

interface VoiceContextType {
  speak: (text: string, voice?: string) => void;
  isSpeaking: boolean;
  viseme: string;
  stop: () => void;
  status: 'connected' | 'disconnected' | 'connecting';
  registerVisemeListener: (callback: (v: string) => void) => () => void;
  testSpeech: () => void;
}

const VoiceContext = createContext<VoiceContextType | undefined>(undefined);

export const VoiceProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [viseme, setViseme] = useState('closed');
  const [status, setStatus] = useState<'connected' | 'disconnected' | 'connecting'>('connected');

  const audioContextRef = useRef<AudioContext | null>(null);
  const voiceStreamerRef = useRef<VoiceStreamer | null>(null);
  const listenersRef = useRef<Set<(v: string) => void>>(new Set());
  const testTimeoutsRef = useRef<number[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);

  const emitViseme = useCallback((nextViseme: string) => {
    setViseme(nextViseme);
    listenersRef.current.forEach((cb) => cb(nextViseme));
  }, []);

  const ensureAudioContext = useCallback(() => {
    if (!audioContextRef.current) {
      audioContextRef.current = new window.AudioContext();
      voiceStreamerRef.current?.setAudioContext(audioContextRef.current);
    }

    return audioContextRef.current;
  }, []);

  const clearTestTimeouts = useCallback(() => {
    testTimeoutsRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    testTimeoutsRef.current = [];
  }, []);

  const registerVisemeListener = useCallback((callback: (v: string) => void) => {
    listenersRef.current.add(callback);
    return () => listenersRef.current.delete(callback);
  }, []);

  useEffect(() => {
    if (!voiceStreamerRef.current) {
      voiceStreamerRef.current = new VoiceStreamer(
        emitViseme,
        () => {
          setIsSpeaking(false);
          setStatus('connected');
        }
      );
    }
  }, [emitViseme]);

  useEffect(() => {
    return () => {
      clearTestTimeouts();
      abortControllerRef.current?.abort();
      voiceStreamerRef.current?.stop();
      void audioContextRef.current?.close().catch(() => {});
      audioContextRef.current = null;
    };
  }, [clearTestTimeouts]);

  const speak = useCallback((text: string, voice?: string) => {
    const streamer = voiceStreamerRef.current;
    const token = getAccessToken();
    if (!streamer || !token || !text.trim()) {
      setStatus(token ? 'connected' : 'disconnected');
      return;
    }

    clearTestTimeouts();
    ensureAudioContext();
    abortControllerRef.current?.abort();
    streamer.flush();

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setStatus('connecting');
    setIsSpeaking(true);

    void streamer
      .stream(text, {
        token,
        voiceId: voice,
        signal: controller.signal,
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          setStatus('connected');
          return;
        }
        console.error('Voice stream failed:', error);
        setStatus('disconnected');
        setIsSpeaking(false);
        emitViseme('closed');
      });
  }, [clearTestTimeouts, emitViseme, ensureAudioContext]);

  const stop = useCallback(() => {
    clearTestTimeouts();
    abortControllerRef.current?.abort();
    voiceStreamerRef.current?.stop();
    setIsSpeaking(false);
    emitViseme('closed');
    setStatus('connected');
  }, [clearTestTimeouts, emitViseme]);

  const testSpeech = useCallback(() => {
    clearTestTimeouts();
    ensureAudioContext();
    const testPhonemes: CanonicalViseme[] = ['open', 'wide', 'o', 'closed'];
    setIsSpeaking(true);

    testPhonemes.forEach((nextViseme, i) => {
      const timeoutId = window.setTimeout(() => {
        emitViseme(nextViseme);
        if (i === testPhonemes.length - 1) {
          setIsSpeaking(false);
        }
      }, i * 200);
      testTimeoutsRef.current.push(timeoutId);
    });
  }, [clearTestTimeouts, emitViseme, ensureAudioContext]);

  return (
    <VoiceContext.Provider value={{ speak, isSpeaking, viseme, stop, status, registerVisemeListener, testSpeech }}>
      {children}
    </VoiceContext.Provider>
  );
};

export const useVoice = () => {
  const context = useContext(VoiceContext);
  if (!context) throw new Error('useVoice must be used within a VoiceProvider');
  return context;
};
