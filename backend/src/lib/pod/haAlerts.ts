// HA → Pod alert bridge.
//
// Subscribes to live Home Assistant state changes (via sync.ts) and fires ephemeral
// alert overlays on screen Pods when interesting entities change state: doorbells ring,
// motion sensors trigger, locks change state, and smoke/CO detectors fire.
//
// The HA sync module doesn't know about users — it's keyed by HA instance URL.
// We maintain a baseUrl → userId[] map populated lazily on first call and refreshed
// every 5 minutes so newly linked users pick up without a restart.

import { db } from '@/db'
import { toolUserConfig } from '@/db/schema'
import { and, eq } from 'drizzle-orm'
import { onHAStateChange } from '@/lib/homeAssistant/sync'
import { setUserAlert } from '@/lib/pod/presence'
import { podsForUser } from '@/lib/pod/registry'
import { logger } from '@/lib/logger'

// baseUrl (lowercase) → userId[]
const urlToUsers = new Map<string, string[]>()
let lastRefreshMs = 0
const REFRESH_INTERVAL_MS = 5 * 60_000

async function refreshUserMap(): Promise<void> {
  if (Date.now() - lastRefreshMs < REFRESH_INTERVAL_MS) return
  lastRefreshMs = Date.now()
  const rows = await db
    .select({ userId: toolUserConfig.userId, value: toolUserConfig.value })
    .from(toolUserConfig)
    .where(and(eq(toolUserConfig.toolId, 'home_assistant'), eq(toolUserConfig.key, 'base_url')))
  urlToUsers.clear()
  for (const row of rows) {
    const url = String(JSON.parse(row.value) ?? '').toLowerCase().replace(/\/+$/, '')
    if (!url) continue
    const list = urlToUsers.get(url) ?? []
    list.push(row.userId)
    urlToUsers.set(url, list)
  }
}

function usersForBaseUrl(baseUrl: string): string[] {
  return urlToUsers.get(baseUrl.toLowerCase().replace(/\/+$/, '')) ?? []
}

// ── Entity classification ─────────────────────────────────────────────────────────

interface AlertSpec {
  emoji: string
  message: (friendlyName: string, state: string) => string
  color: string
  ttlSec: number
  sound?: string
  // Only fire when state transitions into one of these values
  onStates?: string[]
}

function classify(entityId: string, newState: string, oldState: string | undefined): AlertSpec | null {
  const domain = entityId.split('.')[0] ?? ''
  const rawName = (entityId.split('.')[1] ?? entityId).replace(/_/g, ' ')
  // Capitalize first letter for display
  const name = rawName.charAt(0).toUpperCase() + rawName.slice(1)

  // Only fire on transitions (not on initial population which passes oldState=undefined at boot)
  if (oldState === undefined) return null
  // Don't fire if state didn't actually change (shouldn't happen given the guard in sync.ts, but be safe)
  if (newState === oldState) return null

  // Doorbell / button pressed
  if (domain === 'binary_sensor' && newState === 'on' && /doorbell|ring|chime/i.test(entityId)) {
    return { emoji: '🔔', message: () => `${name} — someone's at the door`, color: '#d97706', ttlSec: 20, sound: 'builtin:wake_chime' }
  }

  // Motion / occupancy (only fire on activation, not on clear)
  if (domain === 'binary_sensor' && newState === 'on' && /motion|occupancy|presence/i.test(entityId)) {
    return { emoji: '🚶', message: () => `Motion: ${name}`, color: '#0284c7', ttlSec: 15 }
  }

  // Lock state change
  if (domain === 'lock' && (newState === 'locked' || newState === 'unlocked')) {
    const locked = newState === 'locked'
    return {
      emoji: locked ? '🔒' : '🔓',
      message: () => `${name} ${locked ? 'locked' : 'unlocked'}`,
      color: locked ? '#16a34a' : '#dc2626',
      ttlSec: 10,
    }
  }

  // Smoke / CO / gas detectors (only fire when detected)
  if (domain === 'binary_sensor' && newState === 'on' && /smoke|carbon_monoxide|co_alarm|gas/i.test(entityId)) {
    return {
      emoji: '🚨',
      message: () => `ALERT: ${name} detected`,
      color: '#dc2626',
      ttlSec: 60,
      sound: 'builtin:wake_chime',
    }
  }

  // Water leak (only fire when detected)
  if (domain === 'binary_sensor' && newState === 'on' && /leak|flood|moisture/i.test(entityId)) {
    return { emoji: '💧', message: () => `Water detected: ${name}`, color: '#0369a1', ttlSec: 60, sound: 'builtin:wake_chime' }
  }

  return null
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────────

export function startHAAlerts(): void {
  void refreshUserMap()

  onHAStateChange((baseUrl, entityId, newState, oldState) => {
    const spec = classify(entityId, newState, oldState)
    if (!spec) return

    // Refresh user map lazily; don't await — fire with whatever we have.
    void refreshUserMap()
    const userIds = usersForBaseUrl(baseUrl)
    if (userIds.length === 0) return

    const rawName = (entityId.split('.')[1] ?? entityId).replace(/_/g, ' ')
    const name = rawName.charAt(0).toUpperCase() + rawName.slice(1)
    const message = spec.message(name, newState)

    for (const userId of userIds) {
      setUserAlert(userId, { emoji: spec.emoji, message, color: spec.color, source: 'ha', ttlSec: spec.ttlSec })
      if (spec.sound) {
        for (const pod of podsForUser(userId)) { try { pod.playSound(spec.sound) } catch { /* offline */ } }
      }
      logger.info(`[ha-alerts] ${entityId} → "${newState}" → alert for user ${userId}: ${message}`)
    }
  })

  logger.info('[ha-alerts] watching HA entity changes for doorbell/motion/lock/smoke/leak events')
}
