// Single source of truth for the notification taxonomy: which types roll up into which
// user-facing categories, per-type default priority, and the default delivery matrix.
// The frontend renders its settings matrix from GET /api/notify/meta (routes/notifyChannels.ts)
// — there is no shared TS package between backend and frontend, so the API is the contract.

export type NotifType =
  | 'install_request'
  | 'install_complete'
  | 'download_complete'
  | 'system'
  | 'frigate_event'
  | 'companion_checkin'
  | 'watcher_alert'
  | 'price_alert'
  | 'file_drop'
  | 'service_alert'

export type NotifPriority = 'info' | 'normal' | 'urgent'
export type NotifCategory = 'camera' | 'downloads' | 'installs' | 'system' | 'companion' | 'watchers' | 'shopping' | 'drops' | 'monitoring'
export type Channel = 'push' | 'telegram' | 'email'
export type DeliveryMode = 'off' | 'instant' | 'digest'

export const NOTIF_TYPES: readonly NotifType[] = [
  'install_request', 'install_complete', 'download_complete', 'system',
  'frigate_event', 'companion_checkin', 'watcher_alert', 'price_alert', 'file_drop',
  'service_alert',
]

export const CHANNELS: readonly Channel[] = ['push', 'telegram', 'email']

interface CategoryMeta {
  key: NotifCategory
  label: string
  description: string
  types: NotifType[]
}

export const CATEGORY_META: readonly CategoryMeta[] = [
  { key: 'camera', label: 'Security cameras', description: 'Motion and object alerts from your cameras', types: ['frigate_event'] },
  { key: 'watchers', label: 'Page watchers', description: 'Watched web pages that changed — price drops, stock alerts', types: ['watcher_alert'] },
  { key: 'shopping', label: 'Price alerts', description: 'Tracked products dropping below your target or back in stock', types: ['price_alert'] },
  { key: 'downloads', label: 'Downloads', description: 'Background downloads finishing', types: ['download_complete'] },
  { key: 'installs', label: 'App installs', description: 'Install requests and completed installs', types: ['install_request', 'install_complete'] },
  { key: 'companion', label: 'Companion check-ins', description: 'Your companion reaching out about things you shared', types: ['companion_checkin'] },
  { key: 'drops', label: 'Device drops', description: 'Files and links sent between your devices', types: ['file_drop'] },
  { key: 'monitoring', label: 'Service monitoring', description: 'A service or server going down or recovering (Uptime Kuma)', types: ['service_alert'] },
  { key: 'system', label: 'System', description: 'Everything else — maintenance, warnings, admin messages', types: ['system'] },
]

export function categoryOf(type: NotifType): NotifCategory {
  for (const meta of CATEGORY_META) if (meta.types.includes(type)) return meta.key
  return 'system'
}

export function defaultPriorityFor(type: NotifType): NotifPriority {
  switch (type) {
    case 'frigate_event': return 'urgent'
    case 'service_alert': return 'urgent'
    case 'install_request': return 'info'
    default: return 'normal'
  }
}

// Defaults preserve pre-delivery-layer behavior: push was already sent for everything
// (lib/push.ts call sites), telegram/email are new and start off.
export const DEFAULT_MATRIX: Record<NotifCategory, Record<Channel, DeliveryMode>> = {
  camera: { push: 'instant', telegram: 'off', email: 'off' },
  watchers: { push: 'instant', telegram: 'off', email: 'off' },
  shopping: { push: 'instant', telegram: 'off', email: 'off' },
  downloads: { push: 'instant', telegram: 'off', email: 'off' },
  installs: { push: 'instant', telegram: 'off', email: 'off' },
  companion: { push: 'instant', telegram: 'off', email: 'off' },
  drops: { push: 'instant', telegram: 'off', email: 'off' },
  monitoring: { push: 'instant', telegram: 'off', email: 'off' },
  system: { push: 'instant', telegram: 'off', email: 'off' },
}

/** Channel-facing title/body/url when the emitter didn't provide them. Mirrors the
 *  bell-dropdown labels (frontend/src/lib/notifications.ts) and pod overlay specs. */
export function deriveMessage(type: NotifType, payload: Record<string, unknown>): { title: string; body?: string; url?: string } {
  switch (type) {
    case 'install_request':
      return { title: 'App install requested', body: String(payload['toolName'] ?? payload['appName'] ?? 'An app'), url: '/admin/apps' }
    case 'install_complete':
      return { title: `${String(payload['toolName'] ?? 'App')} installed`, url: '/' }
    case 'download_complete':
      return { title: `${String(payload['label'] ?? 'Download')} complete`, url: '/' }
    case 'frigate_event':
      return { title: 'Camera alert', body: String(payload['message'] ?? payload['label'] ?? ''), url: '/cameras' }
    case 'companion_checkin':
      return { title: String(payload['characterName'] ?? 'Companion'), body: String(payload['message'] ?? ''), url: '/chat' }
    case 'watcher_alert': {
      const itemId = payload['itemId']
      return { title: String(payload['message'] ?? 'A watched page changed'), url: itemId ? `/bookmarks/read/${String(itemId)}` : '/bookmarks' }
    }
    case 'price_alert': {
      const productId = payload['productId']
      return { title: String(payload['message'] ?? 'Price alert'), url: productId ? `/shopping/products/${String(productId)}` : '/shopping' }
    }
    case 'file_drop': {
      const from = String(payload['senderLabel'] ?? 'Another device')
      const name = payload['fileName'] ?? (payload['kind'] === 'text' ? 'a message' : 'a file')
      return { title: 'Incoming drop', body: `${from} sent ${String(name)}`, url: '/drop' }
    }
    case 'service_alert': {
      const monitor = String(payload['monitor'] ?? 'A service')
      const down = payload['state'] === 'down'
      return {
        title: down ? `${monitor} is down` : `${monitor} recovered`,
        body: payload['message'] ? String(payload['message']) : undefined,
        url: '/admin/monitoring',
      }
    }
    case 'system':
    default:
      return { title: String(payload['message'] ?? 'Notification'), url: '/' }
  }
}
