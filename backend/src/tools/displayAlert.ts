// Companion tool — flash an ephemeral alert on the user's screen Pods.
// "Flash my display: meeting in 5 minutes", "Alert my screen: pizza is ready 🍕"

import type { Tool, ToolResult } from './index'
import { setUserAlert } from '@/lib/pod/presence'
import { podsForUser } from '@/lib/pod/registry'

interface AlertArgs {
  message: string
  emoji?: string
  color?: string
  ttlSec?: number
}

export const displayAlertTool: Tool = {
  id: 'display_alert',
  name: 'Display Alert',
  description: 'Flash an alert message on screen Pods (Tab5 / display devices). Shows a full-screen overlay with emoji and text for up to 60 seconds.',
  offline: true,
  dataSources: [],
  examples: [
    'flash my display: meeting in 5 minutes',
    'alert my screen: pizza is ready',
    'notify my display: package delivered',
    'show on my display: time to take medication',
    'alert the screens: dinner is ready',
    'flash: don\'t forget the laundry',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'display_alert',
      description: 'Show an ephemeral alert overlay on the user\'s screen Pod displays.',
      parameters: {
        type: 'object',
        required: ['message'],
        properties: {
          message: {
            type: 'string',
            description: 'The alert message to display.',
          },
          emoji: {
            type: 'string',
            description: 'Emoji icon shown large above the message. Inferred from context if omitted.',
          },
          color: {
            type: 'string',
            description: 'Background color as a hex string (e.g. "#ef4444"). Default: amber.',
          },
          ttlSec: {
            type: 'number',
            description: 'How many seconds to show the alert (5–60). Default: 30.',
          },
        },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const userId = String(config?.['_userId'] ?? '')
    if (!userId) return { success: false, error: 'Not signed in.' }

    const a = (args ?? {}) as AlertArgs
    if (!a.message) return { success: false, error: 'message is required' }

    const ttlSec = Math.min(60, Math.max(5, a.ttlSec ?? 30))
    const alert = setUserAlert(userId, {
      emoji: a.emoji ?? '🔔',
      message: a.message,
      color: a.color ?? '#d97706',
      source: 'companion',
      ttlSec,
    })

    // Play an audio cue on connected hardware Pods.
    for (const pod of podsForUser(userId)) { try { pod.playSound('builtin:wake_chime') } catch { /* offline */ } }

    const durText = ttlSec < 60 ? `${ttlSec} seconds` : '1 minute'
    return {
      success: true,
      data: { alert },
      directReply: `Alert shown on your displays for ${durText}: "${a.message}"`,
    }
  },
}
