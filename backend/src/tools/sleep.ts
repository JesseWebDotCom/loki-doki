// Companion tool — enter or exit sleep mode on Pod displays.
// "Go to sleep", "Put the displays to sleep", "Good night", "Wake up the displays"

import type { Tool, ToolResult } from './index'
import { setUserSleep } from '@/lib/pod/presence'
import { podsForUser } from '@/lib/pod/registry'

interface SleepArgs {
  action: 'sleep' | 'wake'
  ambientSound?: 'rain' | 'white_noise' | 'ocean' | 'fan' | null
  dimBrightness?: number
}

export const sleepTool: Tool = {
  id: 'sleep',
  name: 'Sleep',
  description: 'Put Pod displays to sleep (dim/blank + optional ambient sound) or wake them up.',
  offline: true,
  core: true,
  dataSources: [],
  examples: [
    'go to sleep',
    'good night',
    'put the displays to sleep',
    'sleep with rain sounds',
    'sleep with white noise',
    'turn off the screens',
    'wake up',
    'wake the displays',
    'good morning',
    'turn on the displays',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'sleep',
      description: 'Enter or exit sleep mode on Pod displays.',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['sleep', 'wake'],
            description: '"sleep" to dim displays and optionally play ambient sound; "wake" to return to normal.',
          },
          ambientSound: {
            type: 'string',
            enum: ['rain', 'white_noise', 'ocean', 'fan'],
            description: 'Optional ambient sound to play through the Pod speaker while sleeping.',
          },
          dimBrightness: {
            type: 'number',
            description: 'Screen brightness while sleeping (0=off, 0.05=dim clock, 1=full). Default 0.05.',
          },
        },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const userId = String(config?.['_userId'] ?? '')
    if (!userId) return { success: false, error: 'Not signed in.' }

    const a = (args ?? {}) as SleepArgs
    const isSleep = a.action !== 'wake'

    await setUserSleep(userId, {
      active: isSleep,
      dimBrightness: a.dimBrightness,
      ambientSound: a.ambientSound ?? null,
      source: 'companion',
    })

    const chime = isSleep ? 'sleep_enter' : 'wake_chime'
    for (const pod of podsForUser(userId)) { try { pod.playSound(chime) } catch { /* offline */ } }

    if (!isSleep) {
      return { success: true, directReply: 'Good morning! Displays are waking up.' }
    }

    let reply = 'Good night. Displays are going to sleep'
    if (a.ambientSound) {
      const names = { rain: 'rain sounds', white_noise: 'white noise', ocean: 'ocean sounds', fan: 'fan sound' }
      reply += ` with ${names[a.ambientSound] ?? a.ambientSound}`
    }
    reply += '.'

    return { success: true, directReply: reply }
  },
}
