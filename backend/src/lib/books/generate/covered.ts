// Running continuity summary — one short LLM call per completed chapter, appended to
// bookProjects.coveredSummaryJson. Derived from the chapter's ACTUAL generated text rather
// than its outline stub, since a chapter can diverge from what its outline summary promised.
// Cheap/auxiliary task — uses the fast model, same rationale as podcast's per-segment work.

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'

const SYSTEM =
  'Summarize the key plot events, character developments, and any new facts established in this ' +
  'book chapter, in 1-2 sentences. This summary is given to the writer drafting the NEXT chapter so ' +
  'they don\'t repeat or contradict anything. Return ONLY the summary — no preamble, no "This chapter".'

export async function summarizeChapterForContinuity(chapterTitle: string, chapterText: string): Promise<string> {
  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Chapter "${chapterTitle}":\n${chapterText.slice(0, 6000)}` },
    ], undefined, { temperature: 0.3, num_predict: 150 }, undefined, 30_000)
    const text = (resp.message?.content ?? '').trim()
    return text ? `${chapterTitle}: ${text}` : `${chapterTitle}: (continuity summary unavailable)`
  } catch {
    return `${chapterTitle}: (continuity summary unavailable)`
  }
}
