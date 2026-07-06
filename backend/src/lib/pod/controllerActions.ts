import { randomUUID } from 'node:crypto'
import { logger } from '@/lib/logger'
import { pushToBrowserSession, trackCommandAck, type BrowserCommand } from '@/lib/pod/browserSession'
import { resolveControllerDescriptor } from '@/lib/pod/controllerStudio'
import { getGlobalConnection } from '@/lib/homeAssistant'
import { callService } from '@/lib/homeAssistant/client'

// Executes a controller-mode button press for the new controller-layout
// system. The device only knows which (page, row, col) was tapped; we re-resolve the
// device's effective layout, find that button, and dispatch its action to the user's
// open browser session(s). Parallel to the display side — the layout is the source of
// truth, so the action can't drift from what the device is showing.

/** The action shapes produced by controllerStudio's built-in/custom templates. */
type ControllerAction =
  | { type: 'navigate'; app?: string; view?: string; channelId?: string; videoId?: string; path?: string }
  | { type: 'open_url'; url: string }
  | { type: 'app_action'; action: string; payload?: Record<string, unknown> }
  | { type: 'play_station'; stationId: string }
  | { type: 'page_jump'; pageId: string }
  | { type: 'ha_toggle'; entityId: string }
  | { type: 'none' }
  | Record<string, unknown>

/** Build a frontend route from a structured navigate action (app + optional view/channel/video). */
function navPath(a: { app?: string; view?: string; channelId?: string; videoId?: string; path?: string }): string {
  if (a.path) return a.path
  const app = (a.app ?? '').replace(/^\/+/, '')
  if (!app) return '/'
  if (app === 'youtube' && a.videoId) return `/videos/youtube/watch/${a.videoId}`
  if (a.channelId) return `/${app}/channel/${a.channelId}`
  if (a.view) return `/${app}/${a.view}`
  return `/${app}`
}

/** Map a resolved controller-button action onto a browser-session command. */
function toBrowserCommand(action: ControllerAction): BrowserCommand | null {
  const a = action as { type?: string } & Record<string, unknown>
  switch (a.type) {
    case 'navigate':
      return { type: 'navigate', path: navPath(a as Parameters<typeof navPath>[0]) }
    case 'open_url':
      return typeof a.url === 'string' ? { type: 'open_url', url: a.url } : null
    case 'app_action':
      return typeof a.action === 'string'
        ? { type: 'app_action', action: a.action, payload: a.payload as Record<string, unknown> | undefined }
        : null
    case 'play_station':
      return typeof a.stationId === 'string'
        ? { type: 'app_action', action: 'play_station', payload: { stationId: a.stationId } }
        : null
    case 'page_jump':
      return typeof a.pageId === 'string' ? { type: 'stream_deck_page_jump', pageId: a.pageId } : null
    case 'none':
    default:
      return null
  }
}

/** Called from SatelliteSession when a controller device sends a button_press user-event. */
export async function handleButtonPress(
  deviceId: string,
  pageId: string,
  row: number,
  col: number,
  userId: string,
  // Follow-up: called with whether the action ACTUALLY fired, and WHY not. The device uses
  // it to un-sink a tile and surface "no session" instead of a blank player.
  onResult?: (ok: boolean, reason?: 'no_session' | 'timeout' | 'no_action') => void,
): Promise<void> {
  let payload
  try {
    payload = await resolveControllerDescriptor(deviceId, userId)
  } catch (e) {
    logger.warn(`[controller] resolve failed for button press: ${(e as Error).message}`)
    onResult?.(false, 'no_action')
    return
  }
  const page = payload.pages.find((p) => p.id === pageId) ?? payload.pages[0]
  const button = page?.buttons.find((b) => b.row === row && b.col === col)
  const action = button?.action as ControllerAction | undefined

  // Home Assistant toggle: dispatched directly server-side (a wall-mounted button should
  // work even with no browser tab open) — NOT routed through the browser-session path below.
  if (action && (action as { type?: string }).type === 'ha_toggle') {
    const entityId = (action as { entityId?: string }).entityId
    if (!entityId) { onResult?.(false, 'no_action'); return }
    try {
      const conn = await getGlobalConnection()
      if (!conn) { onResult?.(false, 'no_action'); return }
      const domain = entityId.split('.')[0] || 'homeassistant'
      const result = await callService(conn, domain, 'toggle', { entity_id: entityId })
      onResult?.(result.ok, result.ok ? undefined : 'no_action')
    } catch (e) {
      logger.warn(`[controller] ha_toggle failed for ${entityId}: ${(e as Error).message}`)
      onResult?.(false, 'no_action')
    }
    return
  }

  const cmd = action ? toBrowserCommand(action) : null
  if (!cmd) { onResult?.(false, 'no_action'); return }

  const ackId = randomUUID()
  cmd.ackId = ackId
  const delivered = pushToBrowserSession(userId, cmd)
  logger.info(`[controller] button press page=${pageId} (${row},${col}) → ${cmd.type}${cmd.action ? '/' + cmd.action : ''} delivered=${delivered} user=${userId}`)
  if (!delivered) { onResult?.(false, 'no_session'); return }   // no live tab → nothing to drive
  if (onResult) trackCommandAck(ackId, (ok) => onResult(ok, ok ? undefined : 'timeout'))
}
