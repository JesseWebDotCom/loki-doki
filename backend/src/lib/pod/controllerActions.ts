import { logger } from '@/lib/logger'
import { pushToBrowserSession, type BrowserCommand } from '@/lib/pod/browserSession'
import { resolveControllerDescriptor } from '@/lib/pod/controllerStudio'

// Executes a controller (Stream-Deck-mode) button press for the new controller-layout
// system. The device only knows which (page, row, col) was tapped; we re-resolve the
// device's effective layout, find that button, and dispatch its action to the user's
// open browser session(s). Parallel to the display side — the layout is the source of
// truth, so the action can't drift from what the device is showing.

/** The action shapes produced by controllerStudio's built-in/custom templates. */
type ControllerAction =
  | { type: 'navigate'; app?: string; view?: string; channelId?: string; path?: string }
  | { type: 'open_url'; url: string }
  | { type: 'app_action'; action: string; payload?: Record<string, unknown> }
  | { type: 'play_station'; stationId: string }
  | { type: 'page_jump'; pageId: string }
  | { type: 'none' }
  | Record<string, unknown>

/** Build a frontend route from a structured navigate action (app + optional view/channel). */
function navPath(a: { app?: string; view?: string; channelId?: string; path?: string }): string {
  if (a.path) return a.path
  const app = (a.app ?? '').replace(/^\/+/, '')
  if (!app) return '/'
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
): Promise<void> {
  let payload
  try {
    payload = await resolveControllerDescriptor(deviceId, userId)
  } catch (e) {
    logger.warn(`[controller] resolve failed for button press: ${(e as Error).message}`)
    return
  }
  const page = payload.pages.find((p) => p.id === pageId) ?? payload.pages[0]
  const button = page?.buttons.find((b) => b.row === row && b.col === col)
  if (!button) return

  const cmd = toBrowserCommand(button.action as ControllerAction)
  logger.info(`[controller] button press page=${pageId} (${row},${col}) → ${cmd?.type ?? 'no-op'} user=${userId}`)
  if (cmd) pushToBrowserSession(userId, cmd)
}
