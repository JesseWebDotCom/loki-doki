// notifyPod — bridge from the in-app notification system to screen Pod display alerts.
//
// Call this immediately after inserting a user-targeted notification; it fires an
// ephemeral overlay on any screen Pods the user has in the current display view
// (status/activity/sleeping/ambient). Admin-targeted notifications (userId=null)
// are skipped — they appear in the bell badge, not on devices.

import { setUserAlert } from '@/lib/pod/presence'

type NotifType = 'install_complete' | 'download_complete' | 'system' | 'frigate_event' | 'install_request' | 'companion_checkin' | 'watcher_alert' | 'price_alert'

interface Spec {
  emoji: string
  message: string
  color: string
  ttlSec: number
}

function specFor(type: NotifType, payload: Record<string, unknown>): Spec | null {
  switch (type) {
    case 'install_complete':
      return {
        emoji: '✅',
        message: String(payload['toolName'] ?? 'App') + ' installed',
        color: '#16a34a',
        ttlSec: 20,
      }
    case 'download_complete':
      return {
        emoji: '⬇️',
        message: String(payload['label'] ?? 'Download') + ' complete',
        color: '#0284c7',
        ttlSec: 20,
      }
    case 'system': {
      const msg = String(payload['message'] ?? '')
      if (!msg) return null
      return { emoji: '🔔', message: msg, color: '#7c3aed', ttlSec: 25 }
    }
    case 'companion_checkin': {
      const msg = String(payload['message'] ?? '')
      if (!msg) return null
      return { emoji: '💬', message: msg, color: '#6366f1', ttlSec: 25 }
    }
    case 'watcher_alert': {
      const msg = String(payload['message'] ?? '')
      if (!msg) return null
      return { emoji: '👀', message: msg, color: '#d97706', ttlSec: 25 }
    }
    case 'price_alert': {
      const msg = String(payload['message'] ?? '')
      if (!msg) return null
      return { emoji: '🏷️', message: msg, color: '#16a34a', ttlSec: 25 }
    }
    default:
      return null
  }
}

export function notifyPod(userId: string | null | undefined, type: NotifType, payload: Record<string, unknown>): void {
  if (!userId) return
  const spec = specFor(type, payload)
  if (!spec) return
  setUserAlert(userId, { ...spec, source: 'notification' })
}
