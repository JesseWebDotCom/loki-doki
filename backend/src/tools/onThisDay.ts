import type { Tool, ToolResult } from './index'
import { onThisDay } from '@/lib/briefing/sources/onThisDay'

export const onThisDayTool: Tool = {
  id: 'onthisday',
  name: 'On This Day',
  description: "Notable historical events from this day in history (defaults to today's date)",
  offline: false,
  dataSources: [
    { name: 'Wikimedia', domain: 'wikimedia.org', purpose: 'Historical events, births, and deaths for any date', type: 'api' },
  ],
  examples: [
    'what happened on this day in history',
    'notable historical events for today’s date',
    'which celebrities were born today',
    'famous birthdays today',
    'on this day events, births, and anniversaries',
    'what happened on a specific month and day in history',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'onthisday',
      description: 'Get notable historical events for a calendar date (defaults to today)',
      parameters: {
        type: 'object',
        required: [],
        properties: {
          month: { type: 'number', description: 'Month 1–12. Omit for today.' },
          day: { type: 'number', description: 'Day of month 1–31. Omit for today.' },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    const { month, day } = (args ?? {}) as { month?: number; day?: number }
    try {
      // Pull notable events AND notable birthdays in parallel (deaths covered by the
      // separate notable-deaths/news path). Either feed alone is enough to answer.
      const [events, births] = await Promise.all([
        onThisDay({ month, day, limit: 5, feed: 'selected' }).catch(() => []),
        onThisDay({ month, day, limit: 4, feed: 'births' }).catch(() => []),
      ])
      if (!events.length && !births.length) {
        return { success: true, data: { events: [], births: [], answer_payload: { gist: 'No notable events found for that date.' } } }
      }
      const highlights = [
        ...events.slice(1).map((i) => i.title),
        ...births.map((b) => `Born today: ${b.title}`),
      ]
      const gist = events.length
        ? `On this day in history: ${events[0]!.title}`
        : `Born on this day: ${births[0]!.title}`
      return {
        success: true,
        data: {
          events,
          births,
          answer_payload: { gist, highlights: highlights.slice(0, 8), sources: [], depth_available: false },
        },
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        return { success: false, offline: true, error: 'Network unavailable' }
      }
      return { success: false, error: String(err) }
    }
  },
}
