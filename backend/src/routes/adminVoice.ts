import { Hono } from 'hono'
import { requireAdmin } from '@/middleware/auth'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { voiceConfig } from '@/lib/voice'
import { kokoroEngine, listKokoroVoices } from '@/lib/voice/engines/kokoroEngine'
import { whisperHealth } from '@/lib/whisper'
import type { AppEnv } from '@/types'

const adminVoice = new Hono<AppEnv>()

// Bundled Kokoro voices (for the per-character + app-default voice pickers).
adminVoice.get('/voices', requireAdmin, async (c) => {
  return c.json({ voices: await listKokoroVoices() })
})

// ── App-level voice defaults + sidecar status ────────────────────────────────
const SETTING_KEYS = [
  'voice.app_default_voice',
  'voice.app_default_wakeword',
  'voice.server_url',
  'voice.tts_url',
  'voice.whisper_url',
] as const

adminVoice.get('/settings', requireAdmin, async (c) => {
  const entries = await Promise.all(SETTING_KEYS.map(async (k) => [k, await getAppSetting(k)] as const))
  const [kokoro, whisper] = await Promise.all([kokoroEngine.health(), whisperHealth()])
  return c.json({
    settings: Object.fromEntries(entries),
    resolved: {
      appDefaultVoice: await voiceConfig.appDefaultVoice(),
      appDefaultWakeword: await voiceConfig.appDefaultWakeword(),
    },
    health: { kokoro, whisper },
  })
})

adminVoice.put('/settings', requireAdmin, async (c) => {
  const body = (await c.req.json()) as Record<string, unknown>
  for (const key of SETTING_KEYS) {
    if (key in body) await setAppSetting(key, body[key])
  }
  return c.json({ ok: true })
})

export { adminVoice }
