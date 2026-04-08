/**
 * Global TTS controller — one VoiceStreamer + a few subscribable bits of
 * UI state (current speaking key, mute preference). React hooks at the
 * bottom let components read/write without prop-drilling.
 *
 * Mute is a user preference persisted to localStorage. When muted,
 * `speak()` is a no-op so auto-play from incoming assistant messages
 * stays silenced until the user un-mutes.
 */
import { useEffect, useState } from 'react';
import { VoiceStreamer } from './VoiceStreamer';

const MUTE_KEY = 'lokidoki.tts.muted';

type Listener = () => void;
type VisemeListener = (viseme: string) => void;

class TTSController {
  private currentViseme: string = 'closed';
  private visemeListeners = new Set<VisemeListener>();
  private streamer = new VoiceStreamer(
    (v: string) => {
      this.currentViseme = v;
      this.visemeListeners.forEach((fn) => fn(v));
    },
    () => {
      // Audio playback (not just the network read) is fully done.
      // Settle the mouth on closed AND release the speakingKey here —
      // not in speak()'s finally, which fires the moment the network
      // read loop completes. The AudioContext keeps playing scheduled
      // chunks long after that, so clearing speakingKey on network-done
      // would freeze every avatar's mouth and the stop-button mid-line.
      this.currentViseme = 'closed';
      this.visemeListeners.forEach((fn) => fn('closed'));
      if (this.speakingKey || this.pendingKey) {
        this.speakingKey = null;
        this.pendingKey = null;
        this.emit();
      }
    },
  );
  private speakingKey: string | null = null;
  private pendingKey: string | null = null;
  private abort: AbortController | null = null;
  private muted: boolean = (() => {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
  })();
  private listeners = new Set<Listener>();

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    // Push current state immediately so a late subscriber doesn't sit
    // on stale defaults until the next emit. Mirrors subscribeViseme.
    fn();
    return () => this.listeners.delete(fn);
  }
  subscribeViseme(fn: VisemeListener) {
    this.visemeListeners.add(fn);
    // Push the current value immediately so late subscribers don't
    // sit on a stale 'closed' until the next phoneme tick.
    fn(this.currentViseme);
    return () => this.visemeListeners.delete(fn);
  }
  private emit() { this.listeners.forEach((l) => l()); }

  isMuted() { return this.muted; }
  setMuted(value: boolean) {
    this.muted = value;
    try { localStorage.setItem(MUTE_KEY, value ? '1' : '0'); } catch {}
    if (value) this.stop();
    this.emit();
  }
  toggleMute() { this.setMuted(!this.muted); }

  speakingMessageKey() { return this.speakingKey; }
  pendingMessageKey() { return this.pendingKey; }

  async speak(messageKey: string, text: string) {
    if (this.muted || !text.trim()) return;
    this.stop();
    this.pendingKey = messageKey;
    this.emit();

    this.abort = new AbortController();
    try {
      await this.streamer.stream(text, {
        signal: this.abort.signal,
        onPlaybackStart: () => {
          this.pendingKey = null;
          this.speakingKey = messageKey;
          this.emit();
        },
      });
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error('[tts] stream failed', err);
      }
      // Only clear keys on actual failure/abort. Successful network
      // completion leaves speakingKey set until the streamer's onEnd
      // callback fires (audio playback fully drained).
      if (this.speakingKey === messageKey || this.pendingKey === messageKey) {
        this.speakingKey = null;
        this.pendingKey = null;
        this.emit();
      }
    }
  }

  stop() {
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    this.streamer.stop();
    if (this.speakingKey || this.pendingKey) {
      this.speakingKey = null;
      this.pendingKey = null;
      this.emit();
    }
  }
}

export const ttsController = new TTSController();

export function useTTSState() {
  const [, force] = useState(0);
  useEffect(() => {
    const unsub = ttsController.subscribe(() => force((n) => n + 1));
    return () => { unsub(); };
  }, []);
  return {
    muted: ttsController.isMuted(),
    speakingKey: ttsController.speakingMessageKey(),
    pendingKey: ttsController.pendingMessageKey(),
    setMuted: (v: boolean) => ttsController.setMuted(v),
    toggleMute: () => ttsController.toggleMute(),
    speak: (key: string, text: string) => ttsController.speak(key, text),
    stop: () => ttsController.stop(),
    subscribeViseme: (fn: (v: string) => void) =>
      ttsController.subscribeViseme(fn),
  };
}
