import type { Tool, ToolResult } from './index'
import { getFastModel } from '@/lib/models'
import { handleCommand, normalizeConnection } from '@/lib/homeAssistant'

// Smart-home control. We do the NLP ourselves against a cached, live-synced catalog
// of the user's Home Assistant (entities + rooms), resolve commands deterministically
// for speed (LLM fallback only when ambiguous), enforce per-user (domain × area)
// grants, then drive HA's REST service API directly — bypassing HA's rigid built-in
// conversation agent entirely. See @/lib/homeAssistant for the engine.

// base_url + api_token are admin/global-only on purpose. Home Assistant lives on
// the LAN, so we can't SSRF-block private addresses for it; instead we prevent a
// non-admin from repointing the connection at an internal service (Ollama, the
// router admin, etc.) and reading the response back through the entities/command
// endpoints. Only the trusted admin configures where HA actually is.
const BASE_URL_FIELD = {
  key: 'base_url',
  label: 'Home Assistant URL',
  description: 'Base URL of your Home Assistant server, e.g. http://homeassistant.local:8123',
  type: 'string' as const,
  scope: 'global' as const,
  placeholder: 'http://homeassistant.local:8123',
  required: true,
}

const TOKEN_FIELD = {
  key: 'api_token',
  label: 'Long-Lived Access Token',
  description: 'Home Assistant → Profile → Security → Long-lived access tokens.',
  type: 'secret' as const,
  scope: 'global' as const,
  required: true,
}

const LLM_FALLBACK_FIELD = {
  key: 'llm_fallback',
  label: 'AI fallback for tricky phrasing',
  description: 'When the fast matcher can’t resolve a command, use a local LLM to figure it out. Only runs when needed, so simple commands stay instant.',
  type: 'boolean' as const,
  scope: 'both' as const,
  default: true,
}

export const homeAssistantTool: Tool = {
  id: 'homeAssistant',
  name: 'Home Assistant',
  description: 'Control smart-home devices — lights, switches, fans, locks, thermostats (setpoint + mode), media players (transport + volume), scenes, covers/garage — and check their state by natural-language command',
  offline: false,
  dataSources: [],
  passMessage: 'text',
  configSchema: [BASE_URL_FIELD, TOKEN_FIELD, LLM_FALLBACK_FIELD],
  examples: [
    'turn off the living room lights',
    'turn on the kitchen lights',
    'dim the bedroom lights to 30%',
    'set the office lights to 50 percent',
    'turn off all the lights',
    'turn on the porch light',
    'lock the front door',
    'unlock the back door',
    'close the garage door',
    'turn on the fan',
    'set the thermostat to 70',
    'set the thermostat to 72 degrees',
    'turn up the heat',
    'switch the ac to cool mode',
    'pause the living room tv',
    'skip to the next song on the kitchen speaker',
    'set the volume to 30 percent',
    'mute the tv',
    'turn up the volume in the den',
    'open the blinds halfway',
    'activate movie night scene',
    'are the office lights on',
    'is the front door locked',
    "what's on in the living room",
    "what's playing in the living room",
    'what temperature is it inside',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'homeAssistant',
      description: 'Control a smart-home device via Home Assistant, or check a device’s state. Use for any request to turn on/off, dim, set a thermostat temperature or mode, pause/skip/adjust volume on a home TV or speaker, lock/unlock, open/close, activate a scene, or ask whether a device is on/off/locked/open or what it\'s playing.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: {
            type: 'string',
            description: "The user's full home command or question, verbatim — e.g. \"turn off the office lights\" or \"are the office lights on\".",
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const conn = normalizeConnection(config?.['base_url'], config?.['api_token'])
    if (!conn) {
      return { success: false, error: 'Home Assistant isn’t set up yet. Add the server URL and a long-lived access token in Admin → Features → Home Assistant.' }
    }
    const text = String((args as { text?: unknown })?.text ?? config?.['_rawMessage'] ?? '').trim()
    if (!text) return { success: false, error: 'No home-control command was provided.' }

    const llmFallback = config?.['llm_fallback'] !== false
    const model = llmFallback ? await getFastModel() : undefined

    const result = await handleCommand({
      message: text,
      conn,
      userId: String(config?.['_userId'] ?? ''),
      isAdmin: config?.['_isAdmin'] === true,
      conversationId: String(config?.['_conversationId'] ?? '') || undefined,
      model,
      llmFallback,
    })

    // Connection/transport failures surface as offline so the pipeline shows the
    // right "unavailable" message. Every other outcome — success, "device not
    // found", "no permission" — is spoken directly (snappy, no LLM synthesis).
    if (result.offline) return { success: false, offline: true, error: result.reply }
    return { success: true, data: result.data ?? {}, directReply: result.reply, directive: result.directive }
  },
}
