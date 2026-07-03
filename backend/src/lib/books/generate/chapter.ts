// Per-chapter prose generation — the book-authoring analog of podcast/script.ts's
// per-segment loop. Each chapter is its own call with its own padded word budget, a
// running "covered" continuity summary, and a tail of the previous chapter's ending for
// a seamless join. A chapter that comes back short is retried once, keeping the longer
// attempt; generation NEVER aborts the whole book because one chapter came back weak —
// callers (generate.ts) mark that chapter failed and move on.

import { getBookModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import type { StoryBible, ChapterOutlineEntry } from './storyBible'

// Local 8B-class models reliably under-deliver on requested length even per-call — the
// same behavior podcast/script.ts observed — so budgets are padded past the true target.
const CHAPTER_NUM_CTX = 8192
const CHAPTER_TIMEOUT_MS = 5 * 60_000
const ACCEPT_FLOOR = 0.45 // below this fraction of the padded budget, a result is "genuinely broken", not just short

function countWords(text: string): number {
  return text.trim().match(/\S+/g)?.length ?? 0
}

export interface GenerateChapterOpts {
  bible: StoryBible
  outline: ChapterOutlineEntry[]
  chapterIdx: number
  coveredSummary: string[]
  tailText: string
  // Reshape mode: the original chapter's text (grounding) + the user's rewrite instruction.
  originalText?: string
  reshapeInstruction?: string
  contentPrompt?: string
}

export interface GeneratedChapter {
  title: string
  text: string
  wordCount: number
}

export async function generateChapter(opts: GenerateChapterOpts): Promise<GeneratedChapter> {
  const { bible, outline, chapterIdx, coveredSummary, tailText, originalText, reshapeInstruction, contentPrompt } = opts
  const chapter = outline[chapterIdx]
  if (!chapter) throw new Error(`No outline entry for chapter ${chapterIdx}`)

  const budget = Math.round(chapter.targetWords * 1.25)
  const model = await getBookModel()
  const systemPrompt = buildSystemPrompt(bible, contentPrompt)
  const userPrompt = buildChapterPrompt({ outline, chapterIdx, budget, coveredSummary, tailText, originalText, reshapeInstruction })
  const genOpts = {
    temperature: 0.85,
    num_ctx: CHAPTER_NUM_CTX,
    num_predict: Math.max(1000, Math.min(4000, 400 + budget * 4)),
  }

  let best = ''
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await ollamaChat(model, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ], undefined, genOpts, undefined, CHAPTER_TIMEOUT_MS)
      const got = cleanProse(resp.message?.content ?? '')
      if (countWords(got) > countWords(best)) best = got
      if (countWords(best) >= budget * ACCEPT_FLOOR) break
      console.log(`[books] chapter ${chapterIdx + 1} "${chapter.title}" short (${countWords(best)}/${budget} words) — retrying`)
    } catch (err) {
      lastErr = err
      console.log(`[books] chapter ${chapterIdx + 1} "${chapter.title}" failed (${err})${attempt === 0 ? ' — retrying' : ''}`)
    }
  }
  if (!best) throw new Error(`Chapter ${chapterIdx + 1} generation produced no usable text${lastErr ? `: ${lastErr}` : ''}`)

  console.log(`[books] chapter ${chapterIdx + 1}/${outline.length} "${chapter.title}": ${countWords(best)}/${budget} words`)
  return { title: chapter.title, text: best, wordCount: countWords(best) }
}

function buildSystemPrompt(bible: StoryBible, contentPrompt?: string): string {
  const charLines = bible.characters.map(c => `- ${c.name} (${c.role}): ${c.traits}`).join('\n')
  const core = `You are a novelist writing ONE CHAPTER of a book at a time; other chapters are written separately and stitched together into the finished book.

STORY BIBLE:
Premise: ${bible.premise}
${bible.genre ? `Genre: ${bible.genre}\n` : ''}${bible.tone ? `Tone: ${bible.tone}\n` : ''}POV: ${bible.pov}
${bible.setting ? `Setting: ${bible.setting}\n` : ''}
Characters:
${charLines}
${bible.themes.length ? `Themes: ${bible.themes.join(', ')}\n` : ''}
Write vivid, well-paced prose consistent with the story bible above. Stay in the established POV and voice throughout. Do not break the fourth wall, add author's notes, chapter headings, or write anything except the chapter's narrative prose.

OUTPUT FORMAT: Return ONLY the chapter's prose text — no title heading, no JSON, no markdown formatting, no "Chapter N" label.`
  return contentPrompt ? `${contentPrompt}\n\n${core}` : core
}

function buildChapterPrompt(opts: {
  outline: ChapterOutlineEntry[]
  chapterIdx: number
  budget: number
  coveredSummary: string[]
  tailText: string
  originalText?: string
  reshapeInstruction?: string
}): string {
  const { outline, chapterIdx, budget, coveredSummary, tailText, originalText, reshapeInstruction } = opts
  const chapter = outline[chapterIdx]!
  const total = outline.length
  const parts: string[] = []

  parts.push(`YOUR ASSIGNMENT — write ONLY chapter ${chapterIdx + 1} of ${total}, titled "${chapter.title}".`)
  parts.push(`This chapter covers: ${chapter.summary}`)
  parts.push(`Write about ${budget} words of prose for this chapter — develop the scene fully rather than rushing through it.`)

  if (coveredSummary.length) {
    parts.push(`\nAlready happened earlier in the book — do NOT repeat, re-explain, or contradict any of it:\n${coveredSummary.map(c => `- ${c}`).join('\n')}`)
  }

  if (tailText) {
    parts.push(`\nThe previous chapter ends with:\n${tailText}\nContinue the story naturally from here — no "previously on", no re-introducing characters or setting already established.`)
  }

  if (reshapeInstruction) {
    parts.push(`\nREWRITE INSTRUCTION from the reader: ${reshapeInstruction}`)
    if (originalText) {
      parts.push(`\nThe ORIGINAL version of this chapter (rewrite it to satisfy the instruction above, keeping everything else about the scene/characters/setting the same unless the instruction requires a change):\n${originalText.slice(0, 6000)}`)
    }
  }

  if (chapterIdx === 0) {
    parts.push(`\nThis is the OPENING chapter — establish the premise, setting, and protagonist so a reader with zero context is grounded immediately.`)
  } else if (chapterIdx === total - 1) {
    parts.push(`\nThis is the FINAL chapter — resolve the story's central conflict. Do not leave it open for a "part 2" unless the story bible's premise explicitly calls for one.`)
  } else {
    parts.push(`\nDo NOT wrap up or resolve the story here — later chapters continue the arc.`)
  }

  return parts.join('\n')
}

/** Strip code fences and any stray "Chapter N" / markdown heading the model added despite instructions. */
function cleanProse(raw: string): string {
  return raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^\s*#{1,6}\s+.*$/gm, '')
    .replace(/^\s*chapter\s+\d+\s*[:.]?\s*.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
