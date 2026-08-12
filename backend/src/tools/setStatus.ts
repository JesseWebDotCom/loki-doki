// Companion tool — set/clear the user's Pod display status.
// "Set me as busy", "I'm focusing for 30 minutes", "Set status to DND", "Clear my status"

import type { Tool, ToolResult } from './index'
import { setUserStatus, clearUserStatus, type StatusState } from '@/lib/pod/presence'
import { podsForUser } from '@/lib/pod/registry'

interface SetStatusArgs {
  action: 'set' | 'clear'
  state?: string
  label?: string
  durationMin?: number
}

const VALID_STATES: StatusState[] = ['available', 'busy', 'dnd', 'on_call', 'in_meeting', 'focusing', 'brb', 'away', 'custom']

export const setStatusTool: Tool = {
  id: 'set_status',
  name: 'Status',
  description: 'Set or clear your display status on screen Pods (Busy, Available, DND, Focusing, etc.)',
  offline: true,
  core: true,
  dataSources: [],
  // Examples are explicit STATUS COMMANDS only. Bare first-person activity
  // statements ("I am in a meeting until 3pm") used to live here and pulled
  // casual life-sharing into this tool — "grabbing dinner with my coworker
  // darnell" set a Pod status instead of getting a conversational reply.
  examples: [
    'set me as busy',
    'set status to do not disturb',
    'set my status to focusing for 45 minutes',
    'mark me as on a call',
    'set me to BRB',
    'clear my status',
    'set me as available now',
    'set busy for 1 hour',
    'show my status as in a meeting until 3pm',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'set_status',
      description: 'Set or clear the user\'s Pod display status.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['set', 'clear'],
            description: '"set" to apply a status, "clear" to remove it and go back to the ambient display.',
          },
          state: {
            type: 'string',
            enum: VALID_STATES,
            description: 'The status to set. Required when action=set.',
          },
          label: {
            type: 'string',
            description: 'Custom label override (e.g. "In a meeting until 3pm"). Optional.',
          },
          durationMin: {
            type: 'number',
            description: 'How many minutes to hold this status before auto-clearing. Optional.',
          },
        },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const userId = String(config?.['_userId'] ?? '')
    if (!userId) return { success: false, error: 'Not signed in.' }

    const a = (args ?? {}) as SetStatusArgs

    if (a.action === 'clear') {
      await clearUserStatus(userId)
      for (const pod of podsForUser(userId)) { try { pod.playSound('status_clear') } catch { /* offline */ } }
      return { success: true, directReply: 'Status cleared. Your display is back to normal.' }
    }

    // action === 'set'
    const state = (a.state ?? 'available') as StatusState
    if (!VALID_STATES.includes(state)) {
      return { success: false, error: `Unknown status state: ${state}` }
    }

    const status = await setUserStatus(userId, {
      state,
      label: a.label,
      durationMin: a.durationMin,
      source: 'companion',
    })
    for (const pod of podsForUser(userId)) { try { pod.playSound('status_set') } catch { /* offline */ } }

    let reply = `Status set to ${status.label}`
    if (a.durationMin) {
      const h = Math.floor(a.durationMin / 60)
      const m = a.durationMin % 60
      const dur = h > 0 ? `${h}h${m > 0 ? ` ${m}m` : ''}` : `${m}m`
      reply += ` for ${dur}`
    }
    reply += '. Your screen Pods will show the status.'

    return { success: true, data: { status }, directReply: reply }
  },
}
