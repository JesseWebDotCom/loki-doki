// Story bible + chapter outline generation — the planning stage of AI book authoring.
// Mirrors podcast/outline.ts's shape (retry-twice, JSON-object extraction, best-effort
// null on failure) but for a book: a story bible (characters/setting/tone) and a chapter
// outline replace the podcast's episode arc. Both are structural-planning calls, so they
// use the fast/router model rather than the book-writing model reserved for prose (chapter.ts).

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'

export interface StoryBibleCharacter {
  name: string
  role: string
  traits: string
}

export interface StoryBible {
  premise: string
  genre: string
  tone: string
  pov: string
  setting: string
  characters: StoryBibleCharacter[]
  themes: string[]
}

export interface ChapterOutlineEntry {
  idx: number
  title: string
  summary: string
  targetWords: number
}

export interface BookBrief {
  premise: string
  genre?: string
  tone?: string
  pov?: string
  chapterCount: number
  wordsPerChapter: number
}

// Reused for continue/reshape grounding — see styleProfile.ts (Phase 2).
export interface StyleProfileContext {
  voice: string
  tone: string
  pov: string
  characters: { name: string; role: string; traits: string }[]
  setting: string
  plotSummary: string
}

const BIBLE_SYSTEM =
  'You design story bibles for novels. Given a brief (and, if provided, an existing book\'s ' +
  'extracted style profile to stay consistent with), produce a compact story bible.\n\n' +
  'Return ONLY a JSON object:\n' +
  '{"premise":"<1-2 sentence premise>","genre":"<genre>","tone":"<tone/mood in a few words>",' +
  '"pov":"<point of view, e.g. \'first person, protagonist\' or \'third person limited\'>",' +
  '"setting":"<where/when this takes place>",' +
  '"characters":[{"name":"<name>","role":"<protagonist|antagonist|supporting>","traits":"<personality, motivation, voice — 1-2 sentences>"}],' +
  '"themes":["<theme>", ...]}\n\n' +
  'Rules:\n' +
  '- 2 to 6 characters, always including a clear protagonist\n' +
  '- Traits describe how a character THINKS and SPEAKS, not just physical description\n' +
  '- If a style profile is given, characters/setting/tone must stay consistent with it unless the brief explicitly asks for a change'

export async function generateStoryBible(brief: BookBrief, styleProfile?: StyleProfileContext | null, contentPrompt?: string): Promise<StoryBible | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const bible = await generateBibleOnce(brief, styleProfile, contentPrompt)
    if (bible) return bible
  }
  return null
}

async function generateBibleOnce(brief: BookBrief, styleProfile: StyleProfileContext | null | undefined, contentPrompt: string | undefined): Promise<StoryBible | null> {
  try {
    const model = await getFastModel()
    const userParts = [`Brief:\n${brief.premise}`]
    if (brief.genre) userParts.push(`Genre: ${brief.genre}`)
    if (brief.tone) userParts.push(`Tone: ${brief.tone}`)
    if (brief.pov) userParts.push(`POV: ${brief.pov}`)
    if (styleProfile) {
      userParts.push(`\nExisting book's style profile (stay consistent with this):\n${JSON.stringify(styleProfile).slice(0, 3000)}`)
    }
    const resp = await ollamaChat(model, [
      { role: 'system', content: contentPrompt ? `${contentPrompt}\n\n${BIBLE_SYSTEM}` : BIBLE_SYSTEM },
      { role: 'user', content: userParts.join('\n') },
    ], undefined, { temperature: 0.7, num_predict: 900 }, undefined, 45_000)

    const raw = resp.message?.content ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as Record<string, unknown>

    const premise = typeof parsed.premise === 'string' ? parsed.premise.trim() : ''
    if (!premise) return null
    const characters = Array.isArray(parsed.characters)
      ? parsed.characters
          .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
          .map(c => ({
            name: typeof c.name === 'string' ? c.name.trim() : '',
            role: typeof c.role === 'string' ? c.role.trim() : 'supporting',
            traits: typeof c.traits === 'string' ? c.traits.trim() : '',
          }))
          .filter(c => c.name)
      : []
    if (!characters.length) return null

    return {
      premise,
      genre: typeof parsed.genre === 'string' ? parsed.genre.trim() : (brief.genre ?? ''),
      tone: typeof parsed.tone === 'string' ? parsed.tone.trim() : (brief.tone ?? ''),
      pov: typeof parsed.pov === 'string' ? parsed.pov.trim() : (brief.pov ?? 'third person limited'),
      setting: typeof parsed.setting === 'string' ? parsed.setting.trim() : '',
      characters,
      themes: Array.isArray(parsed.themes) ? parsed.themes.filter((t): t is string => typeof t === 'string') : [],
    }
  } catch {
    return null
  }
}

const OUTLINE_SYSTEM =
  'You design chapter outlines for novels. Given a story bible, produce a chapter-by-chapter outline ' +
  'that moves through a complete arc (setup, rising action, climax, resolution).\n\n' +
  'Return ONLY a JSON object:\n' +
  '{"chapters":[{"title":"<short chapter title>","summary":"<what happens in this chapter — 1-2 sentences, specific events not vague mood>"}]}\n\n' +
  'Rules:\n' +
  '- Chapters follow the story in order — do NOT reorder or skip ahead\n' +
  '- Each chapter covers DIFFERENT plot ground — no two summaries may overlap\n' +
  '- The last chapter must resolve the story\'s central conflict'

export async function generateOutline(bible: StoryBible, chapterCount: number, wordsPerChapter: number): Promise<ChapterOutlineEntry[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const outline = await generateOutlineOnce(bible, chapterCount, wordsPerChapter)
    if (outline) return outline
  }
  return null
}

async function generateOutlineOnce(bible: StoryBible, chapterCount: number, wordsPerChapter: number): Promise<ChapterOutlineEntry[] | null> {
  try {
    const model = await getFastModel()
    const bibleBlock = [
      `Premise: ${bible.premise}`,
      bible.genre ? `Genre: ${bible.genre}` : '',
      bible.tone ? `Tone: ${bible.tone}` : '',
      bible.setting ? `Setting: ${bible.setting}` : '',
      `Characters: ${bible.characters.map(c => `${c.name} (${c.role}) — ${c.traits}`).join('; ')}`,
      bible.themes.length ? `Themes: ${bible.themes.join(', ')}` : '',
    ].filter(Boolean).join('\n')

    const resp = await ollamaChat(model, [
      { role: 'system', content: `${OUTLINE_SYSTEM}\n\nProduce EXACTLY ${chapterCount} chapters.` },
      { role: 'user', content: bibleBlock },
    ], undefined, { temperature: 0.6, num_predict: Math.min(2500, 200 + chapterCount * 120) }, undefined, 60_000)

    const raw = resp.message?.content ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null
    const parsed = JSON.parse(match[0]) as { chapters?: unknown }
    const chapters = Array.isArray(parsed.chapters)
      ? parsed.chapters
          .filter((c): c is Record<string, unknown> => !!c && typeof c === 'object')
          .map((c, idx) => ({
            idx,
            title: typeof c.title === 'string' ? c.title.trim() : `Chapter ${idx + 1}`,
            summary: typeof c.summary === 'string' ? c.summary.trim() : '',
            targetWords: wordsPerChapter,
          }))
          .filter(c => c.summary)
      : []
    if (chapters.length < 2) return null
    return chapters
  } catch {
    return null
  }
}
