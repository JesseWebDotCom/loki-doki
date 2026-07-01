// Episode outline generator — runs BEFORE script generation to give the LLM a firm
// arc structure to follow. Without this, local models frequently open on random minutiae
// from the first bullet rather than establishing the big picture first.

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'

export interface EpisodeOutline {
  hook: string
  segments: { label: string; focus: string; type: 'intro' | 'body' | 'outro' }[]
}

const SYSTEM =
  'You design a podcast episode structure. Given source material, produce a compact outline ' +
  'that ensures the episode opens on the big picture and moves through the arc in order.\n\n' +
  'Return ONLY a JSON object:\n' +
  '{"hook":"<one punchy sentence that opens the episode — a surprising fact, a specific claim, or a bold question>","segments":[{"label":"<short name>","focus":"<what this segment covers — 1 sentence>","type":"intro|body|outro"}]}\n\n' +
  'Rules:\n' +
  '- Always exactly 1 intro segment, 3-5 body segments, 1 outro segment\n' +
  '- Body segments follow the content arc in order — do NOT reorder beats\n' +
  '- Each focus is 1 sentence describing what specifically gets covered\n' +
  '- Hook must be CONCRETE: name the creator, the thing, the moment — never "have you ever wondered" or "today we explore"\n' +
  '- Outro focus is always: land the key takeaway and leave the listener wanting more\n' +
  '- If the content has an "overall premise" and "beats", the intro focus = the premise; body focuses = the beats in order'

/**
 * Generate a compact episode outline from the content summary. Best-effort — returns null
 * on failure so the caller can proceed without it (the outline only improves structure, it's
 * not required for generation).
 */
export async function generateEpisodeOutline(contentSummary: string): Promise<EpisodeOutline | null> {
  if (!contentSummary.trim()) return null
  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Source material:\n${contentSummary.slice(0, 4000)}` },
    ], undefined, { temperature: 0.5, num_predict: 600 }, undefined, 30_000)

    const raw = resp.message?.content ?? ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return null

    const parsed = JSON.parse(match[0]) as { hook?: unknown; segments?: unknown }
    const hook = typeof parsed.hook === 'string' ? parsed.hook.trim() : ''
    const segs = Array.isArray(parsed.segments)
      ? parsed.segments
          .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
          .map(s => ({
            label: typeof s.label === 'string' ? s.label.trim() : '',
            focus: typeof s.focus === 'string' ? s.focus.trim() : '',
            type: (['intro', 'body', 'outro'] as const).includes(s.type as 'intro') ? s.type as 'intro' | 'body' | 'outro' : 'body',
          }))
          .filter(s => s.focus)
      : []

    if (!hook && !segs.length) return null
    return { hook, segments: segs }
  } catch {
    return null
  }
}

/** Format an outline into the block injected into the script system prompt. */
export function formatOutlineBlock(outline: EpisodeOutline): string {
  const lines = ['EPISODE OUTLINE — follow this arc strictly:']
  if (outline.hook) lines.push(`Open with this hook: ${outline.hook}`)
  outline.segments.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.label ? `[${s.label}] ` : ''}${s.focus}`)
  })
  return lines.join('\n')
}
