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
  return (await setting('voice.server_url')) ?? process.env.VOICE_SERVER_URL ?? 'http://localhost:8091'
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
