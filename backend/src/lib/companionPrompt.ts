// Builds the companion portion of the chat system prompt from a companion's
// persona + reply-style. Shared by the live chat route and the studio tester so
// both flavor responses identically.

import { describeAppearance } from '@/lib/appearance'

export interface CompanionPromptParts {
  personalityPrompt: string
  replyStyle?: 'brief' | 'balanced' | 'detailed' | 'auto' | null
  /** Avatar style + raw avatarConfig JSON — used to make the character appearance-aware. */
  style?: string | null
  avatarConfig?: string | null
  /** Raw JSON string[] of example lines in the character's voice (few-shot). */
  personaExamples?: string | null
  /** Longer narrative background. Authored per character since v2 but never
   *  injected until 2026-08 — deep questions ("where did you grow up?") had
   *  nothing to draw on and the model invented a new past every time. */
  backstory?: string | null
}

const REPLY_STYLE_FRAGMENT: Record<string, string> = {
  brief: 'Keep your replies to one or two short sentences.',
  balanced: '',
  detailed: 'Give longer, more explanatory replies when it helps.',
  auto: 'Default to short replies. When the question is complex or technical, or the user asks for more, expand naturally and give as much detail as needed.',
}

// The character's words are spoken aloud, so it must talk like a person on a call
// — not write a story. We deliberately keep this SHORT and impose no structured
// output: a rigid "only use <action>…</action>" rule was destabilizing the small
// fast companion model — it would emit a stage-direction tag and then stall the
// reply mid-sentence ("<action>raises an eyebrow</action>What's"). Letting it just
// talk produces complete, coherent replies. (Prosody/mood now derive from sentence
// content + punctuation, not from emote tags, so nothing depends on <action>.)
const VOICE_RULE =
  'You are speaking out loud, like a person on a phone call. Talk only in the first person, as yourself. ' +
  'Do not narrate your own actions or write stage directions, and do not use XML/HTML tags, asterisks, parentheses, or ALL-CAPS — just say what you would naturally say.'

// Few-shot voice samples — the single biggest lever for small-model voice
// fidelity. Rendered as reference lines, with an explicit no-verbatim rule so the
// model doesn't parrot them back.
function exampleLinesBlock(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null
  try {
    const lines = (JSON.parse(rawJson) as unknown[])
      .filter((l): l is string => typeof l === 'string' && l.trim().length > 0)
      .slice(0, 4)
    if (lines.length === 0) return null
    return 'How you sound — real lines in your voice (match this style and energy; never repeat these verbatim):\n' +
      lines.map((l) => `- "${l.trim()}"`).join('\n')
  } catch {
    return null
  }
}

// Backstory is background truth, not recitation material — capped so an
// enthusiastically-authored life story can't crowd the prompt.
const BACKSTORY_MAX_CHARS = 700

function backstoryBlock(backstory: string | null | undefined): string | null {
  const b = backstory?.trim()
  if (!b) return null
  return 'Your background (draw on this when your past, tastes, or life comes up — keep it consistent, never recite it unprompted):\n' +
    (b.length <= BACKSTORY_MAX_CHARS ? b : b.slice(0, BACKSTORY_MAX_CHARS - 1).trimEnd() + '…')
}

export function buildCompanionPrompt(parts: CompanionPromptParts): string {
  const fragment = REPLY_STYLE_FRAGMENT[parts.replyStyle ?? 'balanced'] ?? ''
  const appearance = describeAppearance(parts.style, parts.avatarConfig)
  const examples = exampleLinesBlock(parts.personaExamples)
  const backstory = backstoryBlock(parts.backstory)
  return [parts.personalityPrompt?.trim(), backstory, examples, appearance, VOICE_RULE, fragment].filter(Boolean).join('\n\n')
}
