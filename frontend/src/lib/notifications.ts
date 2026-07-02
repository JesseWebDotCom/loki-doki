import { Bell, Camera, CheckCircle2, Download, Eye, HardDrive, MessageCircleHeart } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { AppNotification } from '@/hooks/useNotifications'

export type NotifType = AppNotification['type']

// Icon per raw notification type (used in the bell dropdown + the history list).
export function notifIcon(type: NotifType): LucideIcon {
  switch (type) {
    case 'install_request':   return Download
    case 'install_complete':  return CheckCircle2
    case 'download_complete': return HardDrive
    case 'frigate_event':     return Camera
    case 'companion_checkin': return MessageCircleHeart
    case 'watcher_alert':     return Eye
    default:                  return Bell
  }
}

// Human-readable one-liner from a notification's JSON payload.
export function notifLabel(n: AppNotification): string {
  try {
    const p = JSON.parse(n.payload) as Record<string, string>
    switch (n.type) {
      case 'install_request':
        return `${p.requestedByName ?? 'Someone'} requested ${p.toolName ?? 'a tool'}`
      case 'install_complete':
        return `${p.toolName ?? 'Tool'} was installed`
      case 'download_complete':
        return `${p.name ?? 'File'} download complete`
      case 'companion_checkin':
        return p.characterName ? `${p.characterName}: ${p.message ?? 'checked in'}` : (p.message ?? 'Your companion checked in')
      case 'watcher_alert':
        return p.message ?? 'A watched page changed'
      default:
        return p.message ?? 'System notification'
    }
  } catch {
    return 'Notification'
  }
}

// Relative time. Accepts epoch ms numbers; tolerates ISO strings / bad values so a
// malformed timestamp degrades to "just now" instead of "NaNd ago".
export function timeAgo(ts: number): string {
  const ms = typeof ts === 'number' ? ts : Date.parse(ts as unknown as string)
  if (!Number.isFinite(ms)) return 'just now'
  const diff = Math.floor((Date.now() - ms) / 1000)
  if (diff < 0) return 'just now'
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

// User-facing delivery categories shown in Settings → Notifications. Each maps to one
// or more raw types; muting a category mutes all its types. Stored as a flat array of
// muted type strings in the `notifications.muted` user preference.
export interface NotifCategory {
  key: string
  label: string
  description: string
  types: NotifType[]
  Icon: LucideIcon
}

// Keep in sync with backend/src/lib/notify/categories.ts (CATEGORY_META) — the backend
// copy drives delivery routing; this one drives display. Same keys, same type mapping.
export const NOTIF_CATEGORIES: NotifCategory[] = [
  { key: 'camera',    label: 'Security camera events', description: 'Motion and people detected by your cameras', types: ['frigate_event'],                       Icon: Camera       },
  { key: 'watchers',  label: 'Page watchers',          description: 'Watched web pages that changed — price drops, stock alerts', types: ['watcher_alert'],       Icon: Eye          },
  { key: 'downloads', label: 'Downloads finished',     description: 'Maps, models, and other downloads completing', types: ['download_complete'],                  Icon: HardDrive    },
  { key: 'installs',  label: 'App install updates',    description: 'Install requests and completed installs',      types: ['install_request', 'install_complete'], Icon: CheckCircle2 },
  { key: 'system',    label: 'System messages',        description: 'Maintenance notices and general messages',     types: ['system'],                             Icon: Bell         },
  { key: 'companion', label: 'Companion check-ins',    description: 'Your companion occasionally asks about things you shared — at most once a day', types: ['companion_checkin'], Icon: MessageCircleHeart },
]

// Delivery matrix types (Settings → Notifications "What to send where").
export type DeliveryChannel = 'push' | 'telegram' | 'email'
export type DeliveryMode = 'off' | 'instant' | 'digest'
export type DeliveryMatrix = Partial<Record<string, Partial<Record<DeliveryChannel, DeliveryMode>>>>

export interface ChannelStatus {
  push: { subscriptions: number }
  telegram: { linked: boolean; label: string | null } | null
  telegramAvailable: boolean
  email: { address: string; verified: boolean } | null
  emailAvailable: boolean
}
