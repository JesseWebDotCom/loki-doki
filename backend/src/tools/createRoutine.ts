// Companion tool — author a routine conversationally, with a staged confirm.
// "Every weekday at 7am give me a morning briefing", "when the driveway camera
// sees a person after 10pm, announce it and send me a notification".
//
// The raw request goes through a structured one-shot extraction (same pattern as
// homeAssistant/llmResolve), the draft is validated by lib/routines/types, and the
// human-readable summary is staged behind the standard confirm_action flow. The
// routine is only saved when the user approves; execution is deterministic from
// then on (see lib/routines/engine.ts).

import type { Tool, ToolResult } from './index'
import { db } from '@/db'
import { routines } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { stageWithDirective } from '@/lib/companionActions'
import { describeAction, describeTrigger, validateActions, validateTrigger } from '@/lib/routines/types'

interface Draft {
  name?: string
  trigger?: Record<string, unknown>
  actions?: Array<Record<string, unknown>>
}

const EXTRACT_SYSTEM = `You turn a plain-language automation request into a routine draft. Respond with JSON only.

Trigger shapes (pick exactly one):
{"type":"time","time":"HH:MM","days":[0-6]} - days optional (0=Sunday); "weekdays" = [1,2,3,4,5]; "school nights" = [0,1,2,3,4]
{"type":"ha-state","entityId":"domain.name","to":"state"} - a smart-home device change; only if the user names a device AND a state
{"type":"frigate","camera":"name","label":"person","startHour":22,"endHour":6} - a camera sighting; all fields optional; hour window only when the user gives one
{"type":"service","monitor":"name","event":"down"} - a monitored service going down or up; monitor optional
{"type":"webhook"} - only when the user explicitly asks for a webhook/URL trigger

Action shapes (one or more, in order):
{"type":"notify","title":"...","body":"..."} - send a notification
{"type":"announce","text":"..."} - speak out loud on their devices
{"type":"ha-action","action":"turn_on|turn_off|toggle|set_brightness|lock|close|open","entityIds":["domain.name"],"brightnessPct":50} - only if the user names concrete devices
{"type":"ask-companion","prompt":"...","deliver":"notify"|"announce"} - for anything needing fresh thinking at run time (briefings, summaries, look-ups); write the prompt as an instruction to an assistant

Rules:
- "dim" means set_brightness with a low brightnessPct like 20.
- Times are 24-hour.
- If the request needs live information at run time (weather, news, "what's on my calendar"), use ask-companion, not notify.
- name: a short title for the routine (max 6 words).`

async function extractDraft(message: string): Promise<Draft | null> {
  const format = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      trigger: { type: 'object' },
      actions: { type: 'array', items: { type: 'object' } },
    },
    required: ['name', 'trigger', 'actions'],
  }
  const model = await getModel()
  const res = await ollamaChat(
    model,
    [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: `Request: "${message}"` }],
    undefined,
    { temperature: 0.1 },
    format,
    30_000,
  )
  try {
    return JSON.parse(res.message.content ?? '{}') as Draft
  } catch {
    return null
  }
}

export const createRoutineTool: Tool = {
  id: 'create_routine',
  name: 'Create Routine',
  description: 'Create an automation routine from a plain-language request: run something at a set time, when a camera sees something, when a device changes, or when a service goes down. Always asks for confirmation before saving.',
  offline: true,
  passMessage: 'request',
  dataSources: [],
  examples: [
    'every weekday at 7am give me a morning briefing',
    'create a routine that turns off the porch light at midnight',
    'when the driveway camera sees a person after 10pm, announce it',
    'remind everyone about trash night every Tuesday at 8pm',
    'when the server goes down send me a notification',
    'make an automation for bedtime',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'create_routine',
      description: 'Create a trigger/action automation routine from the user\'s plain-language request.',
      parameters: {
        type: 'object',
        required: ['request'],
        properties: {
          request: { type: 'string', description: 'The full automation request in the user\'s own words.' },
        },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const userId = String(config?.['_userId'] ?? '')
    const conversationId = String(config?.['_conversationId'] ?? '')
    if (!userId) return { success: false, error: 'Not signed in.' }
    const request = String((args as { request?: string })?.request ?? config?.['_rawMessage'] ?? '').trim()
    if (!request) return { success: false, error: 'Tell me what the routine should do.' }

    const draft = await extractDraft(request)
    if (!draft) return { success: false, error: 'I could not work out a routine from that. Try describing when it should run and what it should do.' }

    const trigger = validateTrigger(draft.trigger)
    if (!trigger.ok) return { success: false, error: `That routine needs a clearer trigger: ${trigger.error}` }
    const actions = validateActions(draft.actions)
    if (!actions.ok) return { success: false, error: `That routine needs a clearer action: ${actions.error}` }
    const name = (draft.name ?? 'New routine').trim().slice(0, 120)

    const existing = await db.select({ id: routines.id }).from(routines).where(eq(routines.userId, userId))
    if (existing.length >= 50) return { success: false, error: 'You already have 50 routines; delete one first.' }

    const summaryLines = [describeTrigger(trigger.trigger), ...actions.actions.map((a) => `- ${describeAction(a)}`)]
    const { directive } = stageWithDirective({
      userId,
      conversationId,
      toolId: 'create_routine',
      summary: `Save the routine "${name}"?`,
      approveLabel: 'Save routine',
      declineLabel: 'Cancel',
      card: { title: name, subtitle: summaryLines.join('\n') },
      execute: async () => {
        const now = new Date()
        await db.insert(routines).values({
          id: crypto.randomUUID(),
          userId,
          name,
          enabled: true,
          trigger: JSON.stringify(trigger.trigger),
          actions: JSON.stringify(actions.actions),
          createdVia: 'companion',
          createdAt: now,
          updatedAt: now,
        })
        return `Saved! "${name}" is on: ${describeTrigger(trigger.trigger)}. You can see and edit it in the Routines app.`
      },
    })

    return {
      success: true,
      directReply: `Here's the routine I put together: ${describeTrigger(trigger.trigger)}, then ${actions.actions.map(describeAction).join(', then ')}. Want me to save it?`,
      directive,
    }
  },
}
