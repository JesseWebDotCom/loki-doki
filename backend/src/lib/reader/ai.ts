// AI reading helpers over a saved article's extracted text: TL;DR + auto-tags, and
// ask-the-article Q&A. Best-effort — callers handle the "no model / LLM down" case.

import { ollamaChat } from '@/llm/ollama'
import { structuredCall } from '@/llm/structured'
import { getModel, getFastModel } from '@/lib/models'

const MAX_CHARS = 6000 // keep the prompt within a small context window

export async function summarizeArticle(title: string, text: string): Promise<{ summary: string; tags: string[] }> {
  const model = await getFastModel()
  const body = text.slice(0, MAX_CHARS)
  const out = await structuredCall<{ summary: string; tags: string[] }>(
    model,
    `Title: ${title}\n\nArticle:\n${body}\n\nReturn JSON: { "summary": a 2-3 sentence TL;DR, "tags": 3-5 short lowercase topic tags as a string array }.`,
    'You summarize articles concisely and tag them by topic.',
  )
  return { summary: String(out.summary ?? '').trim(), tags: Array.isArray(out.tags) ? out.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 5) : [] }
}

export async function askArticle(title: string, text: string, question: string): Promise<string> {
  const model = await getModel()
  const body = text.slice(0, MAX_CHARS)
  const res = await ollamaChat(model, [
    { role: 'system', content: 'You answer questions strictly using the provided article. If the answer is not in the article, say so. Be concise.' },
    { role: 'user', content: `Article "${title}":\n\n${body}\n\nQuestion: ${question}` },
  ], undefined, { temperature: 0.2 })
  return res.message.content.trim()
}
