// Voice subsystem configuration. Resolution order mirrors `lib/models.ts`:
// app_settings (DB) → env → hardcoded default.
//
// TTS (Kokoro) and STT (Whisper) are served by ONE local Bun voice-server
// sidecar (`backend/scripts/voice-server.ts`), so both default to the same base.

import { getAppSetting } from '@/lib/settings'

async function setting(key: string): Promise<string | null> {
  const v = await getAppSetting(key)
  return typeof v === 'string' && v ? v : null
}

/** The Bun voice-server (Kokoro TTS + Whisper STT). */
export async function voiceServerUrl(): Promise<string> {
  return (await setting('voice.server_url')) ?? process.env.VOICE_SERVER_URL ?? 'http://localhost:8092'
}

/** Kokoro TTS endpoint base (same server as STT by default). */
export async function kokoroUrl(): Promise<string> {
  return (await setting('voice.tts_url')) ?? process.env.KOKORO_URL ?? (await voiceServerUrl())
}

/** Whisper STT endpoint base (same server as TTS by default). */
export async function whisperUrl(): Promise<string> {
  return (await setting('voice.whisper_url')) ?? process.env.WHISPER_URL ?? (await voiceServerUrl())
}

/** App-wide fallback voice (qualified `engine:voice_id`) when no character voice resolves. */
export async function appDefaultVoice(): Promise<string> {
  return (await setting('voice.app_default_voice')) ?? process.env.VOICE_APP_DEFAULT ?? 'kokoro:af_heart'
}

/** App-wide fallback wakeword model id. */
export async function appDefaultWakeword(): Promise<string> {
  return (await setting('voice.app_default_wakeword')) ?? 'hey_jarvis'
}

/** Trailing-silence endpoint timeout (seconds) for STT utterance finalization.
 *  The single biggest tunable in the voice latency budget: production local
 *  assistants run ~0.25s (aggressive) to ~1.25s (relaxed), Home Assistant Assist
 *  defaults 0.7s. Exposed as a runtime setting (DB `voice.endpoint_silence_ms` →
 *  env `VOICE_ENDPOINT_SILENCE_MS` → 700) so prod can dial it in on its own
 *  acoustics without a rebuild. Phase 1.1 overlaps the STT decode with this wait,
 *  so time cut here is close to a 1:1 latency cut. Clamped to a sane [0.3, 2.0]s.
 *  See docs/internal/voice-latency.md. (Semantic turn detection, i.e. Smart Turn
 *  v3, is the way to push below ~0.5s safely; that is prod-hardware-gated, so until
 *  it lands this fixed timeout stays the conservative floor.) */
export async function endpointSilenceS(): Promise<number> {
  const raw = (await setting('voice.endpoint_silence_ms')) ?? process.env.VOICE_ENDPOINT_SILENCE_MS
  const ms = raw ? Number(raw) : NaN
  const s = Number.isFinite(ms) ? ms / 1000 : 0.7
  return Math.min(2.0, Math.max(0.3, s))
}
