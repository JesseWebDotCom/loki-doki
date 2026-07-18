// Companion tool — save a reusable "method" (a step-by-step procedure) from a
// plain-language request, staged behind a confirm. "Remember how we do movie night:
// dim the lights, start the projector, put phones on Do Not Disturb." Later, when a
// similar request comes in, lib/methods/recall surfaces the steps into the prompt so
// the companion follows the known-good procedure (see lib/methods/recall.ts).
//
// Mirrors createRoutine: structured one-shot extraction → confirm → persist. Household
// scope (visible to everyone) is opt-in via the request wording; default is personal.

import type { Tool, ToolResult } from './index'
import { ollamaChat } from '@/llm/ollama'
import { getModel } from '@/lib/models'
import { stageWithDirective } from '@/lib/companionActions'
import { createMethod, countMethods } from '@/lib/methods/recall'

interface Draft {
  name?: string
  description?: string
  steps?: string
  household?: boolean
}

const EXTRACT_SYSTEM = `You turn a "teach me a procedure" request into a saved method. Respond with JSON only.
Fields:
- name: a short title for the procedure (max 6 words), e.g. "Movie night" or "Reset the router".
- description: one short sentence describing when this method applies (used to match future requests).
- steps: the procedure itself as clear ordered steps (a numbered or dashed list in a single string). Preserve the user's specifics.
- household: true only if the user says this is for everyone / the household / the family; otherwise false.
Keep steps faithful to what the user said; do not invent steps they did not mention.`

async function extractDraft(message: string): Promise<Draft | null> {
  const format = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      steps: { type: 'string' },
      household: { type: 'boolean' },
    },
    required: ['name', 'steps'],
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

export const saveMethodTool: Tool = {
  id: 'save_method',
  name: 'Save Method',
  description: 'Save a reusable step-by-step method or procedure the user wants remembered ("remember how we do X", "save these steps"), so the companion can follow it next time a similar task comes up. Always asks for confirmation before saving.',
  offline: true,
  passMessage: 'request',
  dataSources: [],
  examples: [
    'remember how we do movie night: dim the lights, start the projector, phones on do not disturb',
    'save these steps for resetting the router',
    'teach yourself how I like the bedtime routine done',
    'remember this procedure for onboarding a new babysitter',
    'save a method for how we run taco tuesday',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'save_method',
      description: "Save a reusable step-by-step procedure from the user's plain-language request.",
      parameters: {
        type: 'object',
        required: ['request'],
        properties: {
          request: { type: 'string', description: 'The full request in the user\'s own words, including the steps.' },
        },
      },
    },
  },
  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const userId = String(config?.['_userId'] ?? '')
    const conversationId = String(config?.['_conversationId'] ?? '')
    const isAdmin = config?.['_isAdmin'] === true
    if (!userId) return { success: false, error: 'Not signed in.' }
    const request = String((args as { request?: string })?.request ?? config?.['_rawMessage'] ?? '').trim()
    if (!request) return { success: false, error: 'Tell me the procedure you want me to remember.' }

    const draft = await extractDraft(request)
    if (!draft?.name?.trim() || !draft?.steps?.trim()) {
      return { success: false, error: 'I could not work out a clear procedure from that. Try naming it and listing the steps.' }
    }

    if ((await countMethods(userId)) >= 100) {
      return { success: false, error: 'You already have 100 saved methods; delete one first.' }
    }

    const name = draft.name.trim().slice(0, 120)
    const description = (draft.description ?? '').trim()
    const steps = draft.steps.trim()
    // Household scope requires admin (it becomes visible to everyone).
    const household = draft.household === true && isAdmin
    const scopeLabel = household ? 'the whole household' : 'you'

    const { directive } = stageWithDirective({
      userId,
      conversationId,
      toolId: 'save_method',
      summary: `Save the method "${name}"?`,
      approveLabel: 'Save method',
      declineLabel: 'Cancel',
      card: { title: name, subtitle: `${description ? description + '\n\n' : ''}${steps}`.slice(0, 400) },
      execute: async () => {
        await createMethod({ userId: household ? null : userId, name, description, steps })
        return `Saved! I'll follow "${name}" next time it's relevant.`
      },
    })

    return {
      success: true,
      directReply: `Here's the method I'll save for ${scopeLabel}: "${name}"${description ? ` (${description})` : ''}. Want me to save it?`,
      directive,
    }
  },
}
