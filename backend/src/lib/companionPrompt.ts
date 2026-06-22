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

// The character's words are spoken aloud, so it must talk like a person on a
// call — not write a story. This kills third-person self-narration and ALL-CAPS
// stage directions. The XML <action> tag is the ONLY allowed action marker — it
// is stripped from spoken audio and drives avatar animation.
const VOICE_RULE =
  'Speak only in the first person, as yourself, as if talking out loud. ' +
  'Never narrate your own actions in third person, write stage directions, or use ALL-CAPS phrases (do not write things like "Sage listens", "she smiles", "CLAPS HANDS", or "tilts her head"). ' +
  'If you want to show a physical gesture or emotion, use an XML action tag: <action>laughs softly</action> or <action>winks</action>. ' +
  'Keep the inner text short (1–4 words), lowercase. Place the tag at the start or end of a sentence — never mid-sentence. Use at most one per response. ' +
  'Do not use *asterisks*, (parentheses), ALL CAPS, or any other format — only <action>...</action>.'

export function buildCompanionPrompt(parts: CompanionPromptParts): string {
  const fragment = REPLY_STYLE_FRAGMENT[parts.replyStyle ?? 'balanced'] ?? ''
  const appearance = describeAppearance(parts.style, parts.avatarConfig)
  return [parts.personalityPrompt?.trim(), appearance, VOICE_RULE, fragment].filter(Boolean).join('\n\n')
}
