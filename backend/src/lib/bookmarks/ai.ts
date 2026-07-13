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

export type AutoTagMode = 'generate' | 'existing' | 'predefined'

// Auto-tag an article by one of three strategies (Linkwarden's autoTagLink model):
//   generate   — invent fresh topic tags from the content
//   existing   — pick only from the tags the user already uses (candidates)
//   predefined — pick only from an admin/user-supplied allow-list (candidates)
// 'existing'/'predefined' with no candidates degrade to 'generate'.
export async function autoTagArticle(
  title: string,
  text: string,
  opts: { mode: AutoTagMode; candidates?: string[] } = { mode: 'generate' },
): Promise<string[]> {
  const model = await getFastModel()
  const body = text.slice(0, MAX_CHARS)
  const cands = [...new Set((opts.candidates ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean))]
  const constrained = (opts.mode === 'existing' || opts.mode === 'predefined') && cands.length > 0
  const instruction = constrained
    ? `Choose the 1-5 tags from this list that best match the article (return an EMPTY array if none fit; do NOT invent tags): ${cands.join(', ')}.`
    : `Return 3-5 short lowercase topic tags that categorize the article.`
  const out = await structuredCall<{ tags: string[] }>(
    model,
    `Title: ${title}\n\nArticle:\n${body}\n\n${instruction}\nReturn JSON: { "tags": string[] }.`,
    'You tag articles by topic. Tags are short, lowercase, and specific.',
  )
  let tags = Array.isArray(out.tags) ? out.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean) : []
  if (constrained) { const allow = new Set(cands); tags = tags.filter((t) => allow.has(t)) }
  return [...new Set(tags)].slice(0, 5)
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
