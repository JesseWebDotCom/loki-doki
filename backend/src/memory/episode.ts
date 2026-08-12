import { ollamaChat } from '@/llm/ollama'
import { embed } from '@/llm/embed'
import { db } from '@/db'
import { memoryEpisodes } from '@/db/schema'

const SUMMARY_PROMPT = `Summarize this conversation in 2–4 sentences from the assistant's perspective.
Focus on what was discussed, what you learned about the user, and any notable moments.
If the user's emotional tone was notable (excited, stressed, sad, proud), include it in ONE clause — emotional texture is what makes a later "last time you seemed stressed about this" possible.
Be concise and factual. Do not include small talk.`

export async function generateEpisode(
  conversationId: string,
  userId: string,
  characterId: string | null,
  messages: Array<{ role: string; content: string }>,
  model: string,
): Promise<void> {
  if (messages.length < 4) return

  const context = messages.map((m) => `${m.role}: ${m.content}`).join('\n')

  try {
    const response = await ollamaChat(model, [
      { role: 'system', content: SUMMARY_PROMPT },
      { role: 'user', content: context },
    ])

    const summary = response.message.content.trim()
    if (!summary) return

    const embedding = await embed(summary)

    await db.insert(memoryEpisodes).values({
      id: crypto.randomUUID(),
      userId,
      characterId: characterId || null,
      conversationId,
      summary,
      embedding: JSON.stringify(embedding),
      messageCount: messages.length,
      createdAt: new Date(),
    })
  } catch {
    // episode generation is best-effort
  }
}
