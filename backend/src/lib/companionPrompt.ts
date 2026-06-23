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

export function buildCompanionPrompt(parts: CompanionPromptParts): string {
  const fragment = REPLY_STYLE_FRAGMENT[parts.replyStyle ?? 'balanced'] ?? ''
  const appearance = describeAppearance(parts.style, parts.avatarConfig)
  return [parts.personalityPrompt?.trim(), appearance, VOICE_RULE, fragment].filter(Boolean).join('\n\n')
}
