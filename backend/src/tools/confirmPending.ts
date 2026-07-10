import type { Tool } from './index'
import {
  getPendingForConversation,
  isAffirmative,
  isNegative,
  resolveAction,
} from '../lib/companionActions'

// Pseudo-tool that resolves a staged companion action (lib/companionActions)
// when the user answers a pending confirmation. Never routed semantically
// (examples is empty, so it has no embeddings); companionTurn force-routes to
// it when the message looks like a yes/no AND a pending action exists for this
// conversation. Returns directReply, so the resolution takes the snappy path
// with no LLM synthesis.

export const confirmPendingTool: Tool = {
  id: 'confirm_pending',
  name: 'Confirm Pending Action',
  description: 'Resolves a staged action awaiting user confirmation.',
  examples: [],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'confirm_pending',
      description: 'Resolve a pending confirmation with the user reply.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The user reply' },
        },
        required: ['text'],
      },
    },
  },
  offline: true,
  core: true,
  passMessage: 'text',
  dataSources: [],
  async execute(args, config) {
    const userId = String(config?.['_userId'] ?? '')
    const conversationId = String(config?.['_conversationId'] ?? '')
    const text = String((args as { text?: string })?.text ?? config?.['_rawMessage'] ?? '')

    const pending = getPendingForConversation(userId, conversationId)
    if (!pending) {
      return { success: true, directReply: "There's nothing waiting on a confirmation right now." }
    }
    if (isNegative(text)) {
      const res = await resolveAction(pending.id, false)
      return { success: true, data: { confirmed: false, toolId: pending.toolId }, directReply: res?.reply ?? 'Okay, cancelled.' }
    }
    if (isAffirmative(text)) {
      const res = await resolveAction(pending.id, true)
      if (!res) return { success: true, directReply: 'That confirmation already expired. Ask me again.' }
      return { success: res.ok, data: { confirmed: true, toolId: pending.toolId }, directReply: res.reply }
    }
    // Ambiguous reply while something is pending: restate the offer.
    return {
      success: true,
      directReply: `Just to be clear, should I ${pending.summary}? Yes or no.`,
    }
  },
}
