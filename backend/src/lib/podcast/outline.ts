// Episode outline generator — the backbone of script generation. Each outline segment
// becomes its own script-generation call with its own word budget, so the outline is what
// enforces both the episode's arc AND its length. Without it, local models frequently open
// on random minutiae from the first bullet rather than establishing the big picture first.

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'

export interface OutlineSegment {
  label: string
  focus: string
  type: 'intro' | 'body' | 'outro'
}

export interface EpisodeOutline {
  hook: string
  segments: OutlineSegment[]
}

const SYSTEM_FOR = (bodyCount: number) =>
  'You design a podcast episode structure. Given source material, produce a compact outline ' +
  'that ensures the episode opens on the big picture and moves through the arc in order.\n\n' +
  'Return ONLY a JSON object:\n' +
  '{"hook":"<one punchy sentence that opens the episode — a surprising fact, a specific claim, or a bold question>","segments":[{"label":"<short name>","focus":"<what this segment covers — 1 sentence>","type":"intro|body|outro"}]}\n\n' +
  'Rules:\n' +
  `- Always exactly 1 intro segment, ${bodyCount} body segments, 1 outro segment\n` +
  '- Body segments follow the content arc in order — do NOT reorder beats\n' +
  '- Each body segment covers a DIFFERENT part of the material — no two focuses may overlap\n' +
  '- Each focus is 1 sentence describing what specifically gets covered\n' +
  '- Hook must be CONCRETE: name the creator, the thing, the moment — never "have you ever wondered" or "today we explore"\n' +
  '- Outro focus is always: land the key takeaway and leave the listener wanting more\n' +
  '- If the content has an "overall premise" and "beats", the intro focus = the premise; body focuses = the beats in order'

/**
 * Generate a compact episode outline from the content summary. `bodyCount` sizes the arc to
 * the episode's length target (each body segment is generated separately with its own word
 * budget). Best-effort — returns null on failure so the caller can use fallbackOutline().
 */
export async function generateEpisodeOutline(contentSummary: string, bodyCount = 4): Promise<EpisodeOutline | null> {
  if (!contentSummary.trim()) return null
  // The outline drives the whole per-segment pipeline, so one flaky small-model reply
  // shouldn't drop the episode to the generic fallback arc — try twice.
  for (let attempt = 0; attempt < 2; attempt++) {
    const outline = await generateOnce(contentSummary, bodyCount)
    if (outline) return outline
  }
  return null
}

async function generateOnce(contentSummary: string, bodyCount: number): Promise<EpisodeOutline | null> {
  try {
    const model = await getFastModel()
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM_FOR(bodyCount) },
      { role: 'user', content: `Source material:\n${contentSummary.slice(0, 4000)}` },
    ], undefined, { temperature: 0.5, num_predict: 700 }, undefined, 30_000)

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

    // The outline drives per-segment generation, so a hook alone isn't enough — require a
    // usable arc (intro/outro get normalized in below if the model mislabeled them).
    if (segs.length < 3) return null
    if (!segs.some(s => s.type === 'intro')) segs[0]!.type = 'intro'
    if (!segs.some(s => s.type === 'outro')) segs[segs.length - 1]!.type = 'outro'
    return { hook, segments: segs }
  } catch {
    return null
  }
}

/**
 * A generic arc for when outline generation fails — segment generation always needs SOME
 * ordered structure to walk. Kept deliberately broad; the source material in each call
 * plus the "already covered" list keeps the parts from repeating each other.
 */
export function fallbackOutline(bodyCount = 3): EpisodeOutline {
  const bodies: OutlineSegment[] = [
    { label: 'The setup', focus: 'Establish what the source material is and why it matters, then cover its opening part.', type: 'body' },
    { label: 'The middle', focus: 'Work through the middle of the material in order — the main developments and details.', type: 'body' },
    { label: 'The payoff', focus: 'Cover how the material wraps up: the outcome, verdict, or final part of the story.', type: 'body' },
    { label: 'Reactions', focus: 'The hosts trade their biggest reactions, surprises, and disagreements about the material.', type: 'body' },
    { label: 'Wider picture', focus: 'Put the material in context: comparisons, implications, and what it says about the bigger topic.', type: 'body' },
  ]
  return {
    hook: '',
    segments: [
      { label: 'Opening', focus: 'Welcome the listener and set up, at a high level, what today\'s material is about.', type: 'intro' },
      ...bodies.slice(0, Math.max(1, Math.min(bodyCount, bodies.length))),
      { label: 'Closing', focus: 'Land the key takeaway and sign off.', type: 'outro' },
    ],
  }
}

// Distinct discussion angles used to lengthen an arc that came back with fewer body
// segments than the episode's length target needs. Generic but non-overlapping — and
// per-segment "already covered" lists keep them from rehashing the walkthrough segments.
const PAD_BODIES: OutlineSegment[] = [
  { label: 'Reactions', focus: 'The hosts trade their biggest reactions, surprises, and disagreements about the material.', type: 'body' },
  { label: 'What worked & what didn\'t', focus: 'The hosts each pick the strongest and weakest part of the material and defend their picks.', type: 'body' },
  { label: 'Wider picture', focus: 'Put the material in context: comparisons, implications, and what it says about the bigger topic.', type: 'body' },
]

/**
 * Ensure the arc has at least `bodyCount` body segments — episode length is enforced by
 * segment COUNT (a local model emits ~240 words per call regardless of the ask), so an
 * outline that came back short would silently shorten the whole episode. Extra discussion
 * segments are inserted before the outro.
 */
export function padOutline(outline: EpisodeOutline, bodyCount: number): EpisodeOutline {
  const bodies = outline.segments.filter(s => s.type === 'body').length
  const deficit = Math.min(bodyCount - bodies, PAD_BODIES.length)
  if (deficit <= 0) return outline
  const outroAt = outline.segments.findIndex(s => s.type === 'outro')
  const at = outroAt >= 0 ? outroAt : outline.segments.length
  const segments = [...outline.segments]
  segments.splice(at, 0, ...PAD_BODIES.slice(0, deficit))
  return { ...outline, segments }
}

/** Format an outline into the episode-arc block shown in the script system prompt. */
export function formatOutlineBlock(outline: EpisodeOutline): string {
  const lines = ['EPISODE ARC — the episode moves through these parts in order:']
  outline.segments.forEach((s, i) => {
    lines.push(`${i + 1}. ${s.label ? `[${s.label}] ` : ''}${s.focus}`)
  })
  return lines.join('\n')
}
