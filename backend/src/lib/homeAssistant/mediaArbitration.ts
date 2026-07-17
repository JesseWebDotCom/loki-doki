// Decide whether a media command should drive the app's OWN player (the Doki Dock
// radio engine) instead of a Home Assistant media_player. A bare volume/transport
// verb with no device/room named is meant for whatever is playing locally; naming a
// physical device (tv/speaker) or another device kind (thermostat/lights) is not.
// The caller checks live playback state and does the routing; this is the pure map.

const HA_MEDIA_NOUN_RE = /\b(tv|television|speakers?|stereo|receiver|sound ?bar|sonos|roku|chromecast|cast|home ?pod|echo|display)\b/i
// Words that mean the command is about some OTHER device, never the music player.
const NON_MEDIA_RE = /\b(thermostat|temperature|degrees?|heat|heating|cooling|\ba\/?c\b|air ?con|climate|lights?|lamps?|lighting|fans?|locks?|door|blinds?|shades?|curtains?|garage|cover|brightness|dim)\b/i

export function arbitrateLocalMedia(text: string): { action: string; reply: string } | null {
  const t = text.toLowerCase()
  if (HA_MEDIA_NOUN_RE.test(t) || NON_MEDIA_RE.test(t)) return null
  if (/\bunmute\b/.test(t)) return { action: 'unmute', reply: 'Unmuted.' }
  if (/\bmute\b/.test(t)) return { action: 'mute', reply: 'Muted.' }
  // Volume up/down must reference the volume/sound/music explicitly (or "it"), so a
  // bare "turn it down" only counts as volume when there's a media object to act on.
  if (/\bvolume up\b|\braise the volume\b|\blouder\b|\bturn (it|the volume|the music|the sound|the audio) up\b|\bturn up the (volume|music|sound|audio)\b/.test(t)) return { action: 'volume_up', reply: 'Turned it up.' }
  if (/\bvolume down\b|\blower the volume\b|\bquieter\b|\bsofter\b|\bturn (it|the volume|the music|the sound|the audio) down\b|\bturn down the (volume|music|sound|audio)\b/.test(t)) return { action: 'volume_down', reply: 'Turned it down.' }
  if (/\bunpause\b|\bresume\b|\b(continue|keep) playing\b/.test(t)) return { action: 'play_pause', reply: 'Resumed.' }
  if (/\bpause\b/.test(t)) return { action: 'play_pause', reply: 'Paused.' }
  if (/\b(next|skip)\b/.test(t)) return { action: 'next_track', reply: 'Skipped ahead.' }
  if (/\b(previous|go back)\b/.test(t)) return { action: 'prev_track', reply: 'Went back.' }
  return null
}
