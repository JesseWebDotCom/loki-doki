/**
 * Global TTS controller — one VoiceStreamer + a few subscribable bits of
 * UI state (current speaking key, mute preference). React hooks at the
 * bottom let components read/write without prop-drilling.
 *
 * Mute is a user preference persisted to localStorage. When muted,
 * `speak()` is a no-op so auto-play from incoming assistant messages
 * stays silenced until the user un-mutes.
 *
 * Chunk 16 — voice parity:
 *   * ``speak()`` resolves the spoken form exactly once per ``messageKey``
 *     (design §20.4 snapshot semantics — later block patches update the
 *     visual only, never retroactively edit the utterance in flight).
 *   * ``bargeIn()`` cancels the current utterance within 50 ms of the
 *     trigger. Triggers include user input focus / keypress / wake
 *     word / a ``block_failed`` event on the summary block. We do NOT
 *     wait for the sentence to finish.
 *   * ``speakStatus()`` is a throttled helper for the ``status`` block:
 *     at most ONE utterance per phase and ONLY after the turn has
 *     already been running >3 s. Keeps the avatar from narrating every
 *     phase transition on fast turns.
 */
import { useEffect, useState } from 'react';
import { VoiceStreamer } from './VoiceStreamer';
import {
  createSentenceChunker,
  type SentenceChunker,
  type Utterance,
} from './sentenceChunker';
import type { Block, ResponseEnvelope } from '../lib/response-types';

const MUTE_KEY = 'lokidoki.tts.muted';

// Chunk 15 deferral #4 (folded into chunk 16). The status block is
// allowed to speak at most once per phase, and only after the turn
// has been running long enough that the silence is awkward. These
// thresholds match the design-doc §22 ("a short burst of status is
// fine; constant narration is not") and the planner's throttle note.
export const STATUS_THROTTLE_DELAY_MS = 3_000;

interface StreamingTurnOptions {
  enabled?: boolean;
}

interface StreamingUtterance {
  id: string;
  index: number;
  text: string;
  spokenText: string;
  startChar: number;
  endChar: number;
  startOffset: number;
  abortController: AbortController;
}

interface StreamingTurnState {
  messageKey: string;
  enabled: boolean;
  turnCancelled: boolean;
  chunker: SentenceChunker;
  utterances: StreamingUtterance[];
  nextCharStart: number;
  visualCursorChars: number;
  processingPromise: Promise<void> | null;
  finalizationPromise: Promise<boolean> | null;
  finalText: string;
  streamingFailed: boolean;
  streamingAudioActive: boolean;
  spokenNormalized: string;
}

function normalizeStreamingText(text: string): string {
  return stripMarkdownForSpeech(text).replace(/\s+/g, ' ').trim();
}

/**
 * Strip markdown so Piper doesn't literally pronounce "asterisk" around
 * **bold** spans, read backticks, or spell out link syntax. Operates on
 * the raw assistant text right before it's handed to the streamer.
 */
function stripMarkdownForSpeech(text: string): string {
  return text
    // fenced + inline code → keep contents, drop the fences
    .replace(/```[a-zA-Z0-9_-]*\n?([\s\S]*?)```/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    // images ![alt](url) → alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // links [text](url) → text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // bold/italic **x**, __x__, *x*, _x_
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(?=\S)([^*_]+?)(?<=\S)\1/g, '$2')
    // strikethrough ~~x~~
    .replace(/~~(.*?)~~/g, '$1')
    // headings / blockquotes / list bullets at line start
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    // citation markers like [src:3]
    .replace(/\[src:\d+\]/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First summary block on the envelope, if any. */
function summaryBlock(envelope: ResponseEnvelope | undefined): Block | undefined {
  if (!envelope) return undefined;
  return envelope.blocks.find((b) => b.type === 'summary');
}

/**
 * Mirror of :func:`lokidoki.orchestrator.response.spoken.resolve_spoken_text`.
 * Prefers ``envelope.spoken_text``, falls back to the summary block
 * content trimmed at a sentence boundary, returns ``""`` when neither
 * is available. NEVER reads source / media / follow-up items aloud.
 *
 * Called exactly once per turn when the envelope transitions to a
 * state where TTS can snapshot (design §20.4). Subsequent block
 * patches update the visual only.
 */
export function resolveSpokenText(
  envelope: ResponseEnvelope | undefined,
): string {
  const explicit = envelope?.spoken_text?.trim();
  if (explicit) return explicit;

  const summary = summaryBlock(envelope);
  if (!summary) return '';
  // Only speak from a landed block — matches backend §20.4: partial
  // is permitted because the first patch on a fast turn is often a
  // complete sentence, which is what the planner hopes for.
  if (summary.state !== 'ready' && summary.state !== 'partial') return '';
  const cleaned = stripMarkdownForSpeech(summary.content ?? '');
  if (!cleaned) return '';
  if (cleaned.length <= 200) return cleaned;

  const window = cleaned.slice(0, 200);
  const terminators = '.!?';
  let cut = -1;
  for (let i = window.length - 1; i >= 0; i--) {
    if (terminators.includes(window[i])) {
      cut = i + 1;
      break;
    }
  }
  if (cut <= 0) {
    const space = window.lastIndexOf(' ');
    cut = space > 0 ? space : window.length;
  }
  return window.slice(0, cut).trimEnd();
}

type Listener = () => void;
type VisemeListener = (viseme: string) => void;

class TTSController {
  private currentViseme: string = 'closed';
  private currentSpokenText: string = '';
  private visemeListeners = new Set<VisemeListener>();
  private streamer = new VoiceStreamer(
    (v: string) => {
      if (v === this.currentViseme) return;
      this.currentViseme = v;
      this.visemeListeners.forEach((fn) => fn(v));
    },
    () => {
      // Audio playback (not just the network read) is fully done.
      this.currentViseme = 'closed';
      this.currentSpokenText = '';
      this.visemeListeners.forEach((fn) => fn('closed'));
      if (this.speakingKey || this.pendingKey) {
        this.speakingKey = null;
        this.pendingKey = null;
        this.emit();
      }
    },
    (text: string) => {
      if (text === this.currentSpokenText) return;
      this.currentSpokenText = text;
      this.emit();
    },
  );
  private speakingKey: string | null = null;
  private pendingKey: string | null = null;
  private abort: AbortController | null = null;
  private muted: boolean = (() => {
    try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
  })();
  private listeners = new Set<Listener>();
  private currentTurnMessageKey: string | null = null;
  private streamingTurns = new Map<string, StreamingTurnState>();
  private pendingStreamRequests = new Map<string, AbortController>();

  /**
   * Chunk 16 snapshot semantics. A ``messageKey`` is speak-eligible
   * exactly once per turn — the first ``speak()`` resolves the
   * utterance and all subsequent calls for the same key are no-ops.
   * This implements design §20.4: block patches arriving AFTER the
   * summary first lands DO NOT retroactively edit what is being
   * spoken.
   */
  private spokenForKey = new Set<string>();

  /**
   * Status-phrase throttle state (chunk 15 deferral #4 folded in).
   * Keys are turn-scoped so the ≤1-per-phase contract resets when
   * the caller flips to a new turn via ``resetStatusThrottle``.
   */
  private statusThrottle = {
    turnStartedAt: 0,
    spokenPhases: new Set<string>(),
  };

  subscribe(fn: Listener) {
    this.listeners.add(fn);
    fn();
    return () => this.listeners.delete(fn);
  }
  subscribeViseme(fn: VisemeListener) {
    this.visemeListeners.add(fn);
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
  spokenText() { return this.currentSpokenText; }
  isStreamingEnabled(messageKey?: string | null) {
    if (!messageKey) return false;
    return this.streamingTurns.get(messageKey)?.enabled ?? false;
  }

  resetTurnFlags(messageKey: string) {
    this.currentTurnMessageKey = messageKey;
    const existing = this.streamingTurns.get(messageKey);
    if (existing) {
      existing.turnCancelled = false;
      existing.streamingAudioActive = false;
      existing.visualCursorChars = 0;
    }
    this.resetStatusThrottle();
  }

  beginStreamingTurn(
    messageKey: string,
    options: StreamingTurnOptions = {},
  ) {
    this.currentTurnMessageKey = messageKey;
    this.streamingTurns.set(messageKey, {
      messageKey,
      enabled: options.enabled !== false,
      turnCancelled: false,
      chunker: createSentenceChunker(),
      utterances: [],
      nextCharStart: 0,
      visualCursorChars: 0,
      processingPromise: null,
      finalizationPromise: null,
      finalText: '',
      streamingFailed: false,
      streamingAudioActive: false,
      spokenNormalized: '',
    });
  }

  pushStreamingDelta(messageKey: string, delta: string) {
    const turn = this.streamingTurns.get(messageKey);
    if (!turn || !turn.enabled || turn.turnCancelled || !delta.trim()) {
      return;
    }
    const utterances = turn.chunker.push(delta);
    this.enqueueStreamingUtterances(turn, utterances);
  }

  endStreamingTurn(messageKey: string, finalText: string) {
    const turn = this.streamingTurns.get(messageKey);
    if (!turn || !turn.enabled || turn.turnCancelled) {
      return;
    }
    turn.finalText = finalText;
    const trailing = turn.chunker.flush();
    this.enqueueStreamingUtterances(turn, trailing);
  }

  updateVisualCursor(messageKey: string, visualCursorChars: number) {
    const turn = this.streamingTurns.get(messageKey);
    if (!turn || turn.turnCancelled) {
      return;
    }
    turn.visualCursorChars = Math.max(0, visualCursorChars);
  }

  /**
   * Barge-in — cancel the current utterance immediately. Must fire
   * within 50 ms of the trigger (chunk 16 §20.4); we do not wait for
   * the sentence to finish. Idempotent on an already-idle controller.
   *
   * Triggers: user input focus, key press, voice wake word, or a
   * ``block_failed`` event on the summary block.
   */
  bargeIn() {
    if (
      !this.speakingKey &&
      !this.pendingKey &&
      !this.abort &&
      this.pendingStreamRequests.size === 0 &&
      this.streamingTurns.size === 0
    ) return;

    this.pendingStreamRequests.forEach((controller) => controller.abort());
    this.pendingStreamRequests.clear();
    this.streamingTurns.forEach((turn) => {
      turn.turnCancelled = true;
      turn.streamingAudioActive = false;
      turn.utterances = [];
      turn.visualCursorChars = 0;
    });
    this.stop();
  }

  /**
   * Clear the once-per-turn guard so a later retry / replay can
   * re-speak the same key (tests, "play again" button). Not called
   * by the auto-play path.
   */
  clearSpokenForKey(messageKey: string) {
    this.spokenForKey.delete(messageKey);
  }

  /** Reset the status-throttle clock for a new turn. */
  resetStatusThrottle() {
    this.statusThrottle.turnStartedAt = Date.now();
    this.statusThrottle.spokenPhases.clear();
  }

  /**
   * Speak a status-phrase for the current turn, gated by:
   *   * >= ``STATUS_THROTTLE_DELAY_MS`` since ``resetStatusThrottle``;
   *   * at most one utterance per ``phaseKey`` per turn.
   * Returns ``true`` when the phrase was queued, ``false`` otherwise.
   */
  async speakStatus(phaseKey: string, phrase: string): Promise<boolean> {
    if (this.muted || !phrase.trim()) return false;
    if (!this.statusThrottle.turnStartedAt) return false;
    if (this.statusThrottle.spokenPhases.has(phaseKey)) return false;
    const currentTurn = this.currentTurnMessageKey
      ? this.streamingTurns.get(this.currentTurnMessageKey)
      : undefined;
    if (currentTurn?.streamingAudioActive) {
      console.debug('[tts] suppressing status audio while streaming voice is active');
      return false;
    }
    const elapsed = Date.now() - this.statusThrottle.turnStartedAt;
    if (elapsed < STATUS_THROTTLE_DELAY_MS) return false;
    this.statusThrottle.spokenPhases.add(phaseKey);
    await this.speakNow(`status:${phaseKey}`, phrase, { skipSnapshotGuard: true });
    return true;
  }

  /**
   * Snapshot-gated speak for an assistant turn. The ``messageKey``
   * uniquely identifies the turn; the first call per key resolves
   * the utterance, later calls are no-ops (design §20.4).
   */
  async speak(messageKey: string, text: string) {
    if (this.spokenForKey.has(messageKey)) return;
    this.spokenForKey.add(messageKey);
    try {
      const streamingTurn = this.streamingTurns.get(messageKey);
      if (streamingTurn && streamingTurn.enabled && !streamingTurn.turnCancelled) {
        const finalized = await this.finalizeStreamingTurn(messageKey, text);
        if (!finalized) {
          this.spokenForKey.delete(messageKey);
        }
        return;
      }
      const spoke = await this.speakNow(messageKey, text);
      if (!spoke) {
        this.spokenForKey.delete(messageKey);
      }
    } catch (error) {
      this.spokenForKey.delete(messageKey);
      throw error;
    }
  }

  /**
   * Force a speak without the snapshot guard. Used by internal
   * helpers (status-throttle replay, explicit user "play" buttons
   * that have already called ``clearSpokenForKey``).
   */
  private async speakNow(
    messageKey: string,
    text: string,
    opts: { skipSnapshotGuard?: boolean } = {},
  ): Promise<boolean> {
    void opts;
    const spoken = stripMarkdownForSpeech(text);
    if (this.muted || !spoken.trim()) return false;
    this.stop();
    this.pendingKey = messageKey;
    this.currentSpokenText = '';
    this.emit();

    this.abort = new AbortController();
    try {
      await this.streamer.stream(spoken, {
        signal: this.abort.signal,
        onPlaybackStart: () => {
          this.pendingKey = null;
          this.speakingKey = messageKey;
          this.emit();
        },
      });
      return true;
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error('[tts] stream failed', err);
      }
      if (this.speakingKey === messageKey || this.pendingKey === messageKey) {
        this.speakingKey = null;
        this.pendingKey = null;
        this.currentSpokenText = '';
        this.emit();
      }
      return false;
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
      this.currentSpokenText = '';
      this.emit();
    }
  }

  private enqueueStreamingUtterances(
    turn: StreamingTurnState,
    utterances: Utterance[],
  ) {
    if (utterances.length === 0) {
      return;
    }
    for (const utterance of utterances) {
      const normalized = normalizeStreamingText(utterance.spokenText);
      if (!normalized) {
        continue;
      }
      const startChar = turn.nextCharStart;
      const endChar = startChar + normalized.length;
      turn.utterances.push({
        id: `${turn.messageKey}-utt-${utterance.index}`,
        index: utterance.index,
        text: utterance.text,
        spokenText: utterance.spokenText,
        startChar,
        endChar,
        startOffset: turn.utterances.length,
        abortController: new AbortController(),
      });
      turn.nextCharStart = endChar + 1;
      turn.streamingAudioActive = true;
    }
    if (!turn.processingPromise) {
      turn.processingPromise = this.processStreamingQueue(turn.messageKey).finally(() => {
        const latest = this.streamingTurns.get(turn.messageKey);
        if (latest) {
          latest.processingPromise = null;
        }
      });
    }
  }

  private async processStreamingQueue(messageKey: string) {
    const turn = this.streamingTurns.get(messageKey);
    if (!turn || turn.turnCancelled || this.muted) {
      return;
    }

    while (turn.utterances.length > 0) {
      const utterance = turn.utterances[0];
      const gateChar = Math.max(0, utterance.startChar - 1);
      await this.waitForVisualCursor(turn, gateChar);
      if (turn.turnCancelled) {
        return;
      }

      const controller = utterance.abortController;
      this.pendingStreamRequests.set(utterance.id, controller);
      this.abort = controller;
      this.pendingKey = messageKey;
      this.emit();

      try {
        await this.streamer.stream(utterance.spokenText, {
          signal: controller.signal,
          utteranceId: utterance.id,
          onPlaybackStart: () => {
            this.pendingKey = null;
            this.speakingKey = messageKey;
            this.emit();
          },
        });
        const normalized = normalizeStreamingText(utterance.spokenText);
        turn.spokenNormalized = turn.spokenNormalized
          ? `${turn.spokenNormalized} ${normalized}`.trim()
          : normalized;
      } catch (err) {
        if ((err as DOMException)?.name !== 'AbortError') {
          console.error('[tts] streaming utterance failed', err);
          turn.streamingFailed = true;
        }
        return;
      } finally {
        this.pendingStreamRequests.delete(utterance.id);
        if (this.abort === controller) {
          this.abort = null;
        }
        turn.utterances.shift();
      }
    }
  }

  /**
   * Speak the trailing text owed at turn-end without calling stop().
   * VoiceStreamer.stream() schedules new chunks at ``nextChunkStartTime``,
   * so this PCM queues seamlessly after the still-draining streamed
   * utterances rather than cutting them off.
   */
  private async chainStreamingTail(
    messageKey: string,
    remaining: string,
  ): Promise<boolean> {
    const spoken = stripMarkdownForSpeech(remaining);
    if (this.muted || !spoken.trim()) return false;
    const controller = new AbortController();
    const requestId = `${messageKey}-final`;
    this.pendingStreamRequests.set(requestId, controller);
    this.abort = controller;
    try {
      await this.streamer.stream(spoken, {
        signal: controller.signal,
        onPlaybackStart: () => {
          this.pendingKey = null;
          this.speakingKey = messageKey;
          this.emit();
        },
      });
      return true;
    } catch (err) {
      if ((err as DOMException)?.name !== 'AbortError') {
        console.error('[tts] finalization tail failed', err);
      }
      return false;
    } finally {
      this.pendingStreamRequests.delete(requestId);
      if (this.abort === controller) this.abort = null;
    }
  }

  private async waitForVisualCursor(turn: StreamingTurnState, minimumChars: number) {
    if (minimumChars <= 0) {
      return;
    }
    while (!turn.turnCancelled && turn.visualCursorChars < minimumChars) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }

  private async finalizeStreamingTurn(messageKey: string, text: string): Promise<boolean> {
    const turn = this.streamingTurns.get(messageKey);
    if (!turn) {
      return this.speakNow(messageKey, text);
    }
    if (turn.finalizationPromise) {
      return turn.finalizationPromise;
    }

    turn.finalizationPromise = (async () => {
      await turn.processingPromise;
      if (turn.turnCancelled) {
        this.streamingTurns.delete(messageKey);
        return false;
      }

      const finalNormalized = normalizeStreamingText(turn.finalText || text);
      const spokenNormalized = turn.spokenNormalized.trim();
      let remaining = '';
      if (finalNormalized && finalNormalized.startsWith(spokenNormalized)) {
        // Clean prefix match (covers the empty-spokenNormalized case
        // since every string startsWith ""). The tail is genuinely
        // unspoken text we still owe the user.
        remaining = finalNormalized.slice(spokenNormalized.length).trim();
      }
      // If the streamed transcript and the final spoken text diverge
      // (e.g., the LLM emitted a different ``<spoken_text>`` island
      // than the visible deltas, or normalization differs), trust what
      // we already spoke. Replaying from scratch would call stop() and
      // cut the audio that is still draining from the AudioContext.

      this.streamingTurns.delete(messageKey);
      if (!remaining) {
        return spokenNormalized.length > 0;
      }
      return this.chainStreamingTail(messageKey, remaining);
    })();

    return turn.finalizationPromise;
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
    spokenText: ttsController.spokenText(),
    setMuted: (v: boolean) => ttsController.setMuted(v),
    toggleMute: () => ttsController.toggleMute(),
    speak: (key: string, text: string) => ttsController.speak(key, text),
    stop: () => ttsController.stop(),
    bargeIn: () => ttsController.bargeIn(),
    clearSpokenForKey: (key: string) => ttsController.clearSpokenForKey(key),
    resetStatusThrottle: () => ttsController.resetStatusThrottle(),
    beginStreamingTurn: (key: string, options?: StreamingTurnOptions) =>
      ttsController.beginStreamingTurn(key, options),
    pushStreamingDelta: (key: string, delta: string) =>
      ttsController.pushStreamingDelta(key, delta),
    endStreamingTurn: (key: string, text: string) =>
      ttsController.endStreamingTurn(key, text),
    resetTurnFlags: (key: string) => ttsController.resetTurnFlags(key),
    speakStatus: (phase: string, phrase: string) =>
      ttsController.speakStatus(phase, phrase),
    subscribeViseme: (fn: (v: string) => void) =>
      ttsController.subscribeViseme(fn),
  };
}
