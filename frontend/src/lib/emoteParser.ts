// Character action emote parser.
//
// Primary format (instructed in system prompt):
//   <action>laughs softly</action>   <action>winks</action>
//
// XML tags are what LLMs produce most reliably — they're trained on vast amounts
// of HTML/XML and consistently follow explicit XML tag instructions.
//
// Fallback (catches models that ignore the instruction or older responses):
//   *laughs softly*   *winks*

/** Matches <action>...</action>, <action>...</>, or <action>...</ (malformed close — model writes `</` then continues sentence). Capture group 1 = inner action text. */
export const ACTION_TAG_RE = /<action>([^<]{1,120})<\/(?:action\s*>|>)?/gi

/** Matches *action* fallback. No capture — inner text extracted by slicing. */
export const ASTERISK_EMOTE_RE = /\*[^*\n]{1,80}\*/g

/** Remove all emote markers, collapsing leftover whitespace. */
export function stripEmotes(text: string): string {
  return text
    .replace(ACTION_TAG_RE, ' ')
    .replace(ASTERISK_EMOTE_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/gm, '')
    .trim()
}

/**
 * Remove only XML-style <action> emote tags for display — leaves *asterisk* patterns alone
 * so markdown italic rendering works. Use this for chat display; use stripEmotes for TTS.
 */
export function stripEmotesForDisplay(text: string): string {
  return text
    .replace(ACTION_TAG_RE, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/gm, '')
    .trim()
}

/** Extract the action text from all <action> tags in order of appearance. */
export function extractEmoteActions(text: string): string[] {
  const actions: string[] = []
  ACTION_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ACTION_TAG_RE.exec(text)) !== null) {
    actions.push(m[1]!.trim())
  }
  return actions
}
