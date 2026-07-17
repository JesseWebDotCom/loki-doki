// Announcement ducking: a tiny event bus between companion TTS playback and the
// media engines. When speech starts on THIS device, every registered media source
// ducks (about 80 percent quieter); when speech ends it restores over ~half a
// second. Engines register a duckable on mount and duck through their own audio
// graph gain (or element volume fallback) - this module never touches audio nodes.
//
// Wired at the TTS singleton's real playback start/end (lib/voice/voice-playback.ts
// notify()), so every speech surface (companion replies, HUD, narration, article
// read-aloud) ducks media the same way. Cross-device ducking (announce to another
// session) is deliberately v1-out: same-device only.

export interface Duckable {
  /** Drop output to ~20 percent, quickly (~150ms). */
  duck: () => void
  /** Ramp output back to normal over ~500ms. */
  restore: () => void
}

const duckables = new Map<string, Duckable>()
let speechActive = false

export function registerDuckable(id: string, d: Duckable): () => void {
  duckables.set(id, d)
  // A source mounting mid-speech starts ducked so it does not blast over the voice.
  if (speechActive) { try { d.duck() } catch { /* engine not ready */ } }
  return () => {
    if (duckables.get(id) === d) duckables.delete(id)
  }
}

/** Called by the TTS playback singleton on real audio start/end. Idempotent. */
export function setSpeechActive(on: boolean): void {
  if (speechActive === on) return
  speechActive = on
  for (const d of duckables.values()) {
    try { on ? d.duck() : d.restore() } catch { /* one engine failing must not block the rest */ }
  }
}

export function isSpeechActive(): boolean {
  return speechActive
}
