import type { HAAction } from './resolve'

// Single source of truth for action → HA service-call mapping, shared by the
// NL engine (index.ts) and the direct /entity route. Keep VALID_ACTIONS and
// ACTIONS_BY_DOMAIN in sync with the HAAction union in resolve.ts.

export interface ServiceCall { domain: string; service: string; data: Record<string, unknown> }

export const VALID_ACTIONS = new Set<HAAction>([
  'turn_on', 'turn_off', 'toggle', 'lock', 'unlock', 'open', 'close',
  'set_brightness', 'set_color_temp', 'set_color', 'activate_scene',
  'set_temperature', 'set_hvac_mode',
  'set_percentage',
  'media_play', 'media_pause', 'media_next', 'media_previous',
  'set_volume', 'volume_up', 'volume_down', 'mute', 'unmute',
  'set_position', 'stop',
])

// Which actions make sense per entity domain — used to validate direct /entity
// calls and to hint the frontend at each device's capabilities.
export const ACTIONS_BY_DOMAIN: Record<string, HAAction[]> = {
  light: ['turn_on', 'turn_off', 'toggle', 'set_brightness', 'set_color_temp', 'set_color'],
  switch: ['turn_on', 'turn_off', 'toggle'],
  input_boolean: ['turn_on', 'turn_off', 'toggle'],
  fan: ['turn_on', 'turn_off', 'toggle', 'set_percentage'],
  lock: ['lock', 'unlock'],
  cover: ['open', 'close', 'set_position', 'stop'],
  climate: ['turn_on', 'turn_off', 'set_temperature', 'set_hvac_mode'],
  media_player: ['turn_on', 'turn_off', 'media_play', 'media_pause', 'media_next', 'media_previous', 'set_volume', 'volume_up', 'volume_down', 'mute', 'unmute'],
  scene: ['activate_scene'],
  script: ['turn_on'],
}

export interface ActionOpts {
  brightnessPct?: number
  value?: number      // set_temperature: °F · set_volume/set_position/set_percentage: 0–100
  hvacMode?: string
  kelvin?: number     // set_color_temp
  colorName?: string  // set_color
}

export function serviceCallsFor(action: HAAction, ids: string[], opts: ActionOpts = {}): ServiceCall[] {
  switch (action) {
    // homeassistant.* routes to each entity's own domain — handles mixed targets.
    case 'turn_on':  return [{ domain: 'homeassistant', service: 'turn_on',  data: { entity_id: ids } }]
    case 'turn_off': return [{ domain: 'homeassistant', service: 'turn_off', data: { entity_id: ids } }]
    case 'toggle':   return [{ domain: 'homeassistant', service: 'toggle',   data: { entity_id: ids } }]
    case 'lock':     return [{ domain: 'lock',  service: 'lock',         data: { entity_id: ids } }]
    case 'unlock':   return [{ domain: 'lock',  service: 'unlock',       data: { entity_id: ids } }]
    case 'open':     return [{ domain: 'cover', service: 'open_cover',   data: { entity_id: ids } }]
    case 'close':    return [{ domain: 'cover', service: 'close_cover',  data: { entity_id: ids } }]
    case 'set_position': return [{ domain: 'cover', service: 'set_cover_position', data: { entity_id: ids, position: clampPct(opts.value ?? 50) } }]
    case 'stop':         return [{ domain: 'cover', service: 'stop_cover', data: { entity_id: ids } }]
    case 'activate_scene': return [{ domain: 'scene', service: 'turn_on', data: { entity_id: ids } }]
    case 'set_brightness':
      return [{ domain: 'light', service: 'turn_on', data: { entity_id: ids, brightness_pct: clampPct(opts.brightnessPct ?? 50) } }]
    case 'set_color_temp':
      return [{ domain: 'light', service: 'turn_on', data: { entity_id: ids, color_temp_kelvin: opts.kelvin ?? 3000 } }]
    case 'set_color':
      return [{ domain: 'light', service: 'turn_on', data: { entity_id: ids, color_name: (opts.colorName ?? 'white').replace(/\s+/g, '') } }]
    case 'set_percentage':
      return [{ domain: 'fan', service: 'set_percentage', data: { entity_id: ids, percentage: clampPct(opts.value ?? 50) } }]
    case 'set_temperature':
      return [{ domain: 'climate', service: 'set_temperature', data: { entity_id: ids, temperature: opts.value ?? 70 } }]
    case 'set_hvac_mode':
      return [{ domain: 'climate', service: 'set_hvac_mode', data: { entity_id: ids, hvac_mode: opts.hvacMode ?? 'auto' } }]
    case 'media_play':     return [{ domain: 'media_player', service: 'media_play',           data: { entity_id: ids } }]
    case 'media_pause':    return [{ domain: 'media_player', service: 'media_pause',          data: { entity_id: ids } }]
    case 'media_next':     return [{ domain: 'media_player', service: 'media_next_track',     data: { entity_id: ids } }]
    case 'media_previous': return [{ domain: 'media_player', service: 'media_previous_track', data: { entity_id: ids } }]
    case 'set_volume':
      return [{ domain: 'media_player', service: 'volume_set', data: { entity_id: ids, volume_level: clampPct(opts.value ?? 50) / 100 } }]
    case 'volume_up':   return [{ domain: 'media_player', service: 'volume_up',   data: { entity_id: ids } }]
    case 'volume_down': return [{ domain: 'media_player', service: 'volume_down', data: { entity_id: ids } }]
    case 'mute':   return [{ domain: 'media_player', service: 'volume_mute', data: { entity_id: ids, is_volume_muted: true } }]
    case 'unmute': return [{ domain: 'media_player', service: 'volume_mute', data: { entity_id: ids, is_volume_muted: false } }]
    default: return []
  }
}

// The domain an action's service call actually targets — used to filter mixed
// target lists (e.g. climate actions must only hit climate entities). null =
// any domain (the homeassistant.* services route per-entity).
export function actionTargetDomain(action: HAAction): string | null {
  switch (action) {
    case 'lock': case 'unlock': return 'lock'
    case 'open': case 'close': case 'set_position': case 'stop': return 'cover'
    case 'set_brightness': case 'set_color_temp': case 'set_color': return 'light'
    case 'set_percentage': return 'fan'
    case 'set_temperature': case 'set_hvac_mode': return 'climate'
    case 'media_play': case 'media_pause': case 'media_next': case 'media_previous':
    case 'set_volume': case 'volume_up': case 'volume_down': case 'mute': case 'unmute':
      return 'media_player'
    case 'activate_scene': return 'scene'
    default: return null
  }
}

export function clampPct(n: number): number {
  return Math.min(100, Math.max(0, Math.round(n)))
}
