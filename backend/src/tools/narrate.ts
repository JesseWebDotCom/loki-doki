import type { Tool, ToolResult, StartNarrationDirective } from './index'
import { eq, desc } from 'drizzle-orm'
import { db } from '@/db'
import { chatDocuments } from '@/db/schema'
import { buildSessionFromText } from '@/lib/narration/session'

export const narrateTool: Tool = {
  id: 'narrate_text',
  name: 'Cast Voices',
  description: 'Read a passage aloud, detecting dialogue and giving each character a distinct TTS voice (Script Mode)',
  offline: true,
  dataSources: [],

  examples: [
    'read this aloud with different voices for each character',
    'do the voices for this story',
    'narrate this document',
    'read the document I attached with character voices',
    'turn this into an audiobook with different voices',
    'act this out with different voices',
    'read this story out loud, one voice per character',
    'can you read this dialogue with different voices',
  ],

  toolDefinition: {
    type: 'function',
    function: {
      name: 'narrate_text',
      description: 'Read a passage of text aloud with a distinct TTS voice per detected character/speaker, and a separate narrator voice for the rest. Use when the user asks to hear something read aloud "with voices", "in character", "like an audiobook", or to "act out"/"do the voices" for a story, script, or document.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The passage to narrate, ONLY if the user pasted or typed it directly into their message. Leave empty if they mean a document already attached to the conversation (e.g. "read the document I uploaded").',
          },
        },
      },
    },
  },

  async execute(args: unknown, config?: Record<string, unknown>): Promise<ToolResult> {
    const { text: providedText } = args as { text?: string }
    const convId = config?.['_conversationId'] as string | undefined
    const userId = config?.['_userId'] as string | undefined
    if (!userId) return { success: false, error: 'User context missing' }

    let text = providedText?.trim() ?? ''
    let sourceType: 'paste' | 'chat_document' = 'paste'
    let sourceRef: string | undefined

    if (!text && convId) {
      const [doc] = await db
        .select({ id: chatDocuments.id, text: chatDocuments.text })
        .from(chatDocuments)
        .where(eq(chatDocuments.conversationId, convId))
        .orderBy(desc(chatDocuments.createdAt))
        .limit(1)
      if (doc) {
        text = doc.text
        sourceType = 'chat_document'
        sourceRef = doc.id
      }
    }

    if (!text) {
      return {
        success: false,
        error: 'No text to narrate. Ask the user to paste the passage, or attach a document to the conversation (the paperclip in the composer), then ask again.',
      }
    }

    const session = await buildSessionFromText({ userId, text, sourceType, sourceRef })
    if (session.status !== 'ready' || !session.turns.length) {
      return { success: false, error: session.error ?? 'Could not prepare this text for narration.' }
    }

    const voiceBySpeaker = new Map(session.speakers.map((s) => [s.id, s.voiceId]))
    const turns = session.turns.map((t) => ({ voiceId: voiceBySpeaker.get(t.speakerId) ?? null, text: t.text }))
    const castCount = session.speakers.filter((s) => !s.isNarrator).length

    const directive: StartNarrationDirective = { action: 'start_narration', sessionId: session.id, turns }

    return {
      success: true,
      data: { sessionId: session.id, speakerCount: session.speakers.length, detectionMethod: session.detectionMethod },
      directive,
      synthesisHint: castCount > 0
        ? `[Now narrating]: You just started reading the text aloud with ${castCount} distinct character voice${castCount === 1 ? '' : 's'} plus a narrator voice — it's already playing. React briefly, in character, that you're reading it now. Do NOT read or repeat the text yourself in your reply — it's already being spoken aloud.`
        : `[Now narrating]: You just started reading the text aloud — it's already playing. React briefly, in character. Do NOT read or repeat the text yourself in your reply — it's already being spoken aloud.`,
    }
  },
}
