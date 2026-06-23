// Character action emote parser.
//
// Primary format (instructed in system prompt):
//   <action>laughs softly</action>   <action>winks</action>
//
// XML tags are what LLMs produce most reliably — they're trained on vast amounts
// of HTML/XML and consistently follow explicit XML tag instructions.
//
// CRITICAL distinction:
//  • <action>…</action> is the INSTRUCTED stage-direction format → DROP tag + inner
//    (we never want to speak/print "raises an eyebrow").
//  • <i> <em> <b> <strong> are HTML EMPHASIS on REAL words the model means to say,
//    e.g. "Oh no, that's <i>terrible to hear</i>" → UNWRAP (keep the words). Dropping
//    their inner text deletes reply content and collapses the reply to a fragment.
//  • *winks* is the asterisk emote fallback → DROP.

/** <action>…</action> (tolerant of attributes / malformed close). Capture group 1 = inner. */
export const ACTION_TAG_RE = /<action\b[^>]*>([^<]{1,200})<\/(?:action\s*>|>)?/gi

/** Matches *action* fallback. No capture — inner text extracted by slicing. */
export const ASTERISK_EMOTE_RE = /\*[^*\n]{1,80}\*/g

function stripTags(s: string): string {
  return s
    // <action>…</action> stage directions → drop tag + inner.
    .replace(ACTION_TAG_RE, ' ')
    // A still-streaming <action> with no close yet → drop it + inner to end.
    .replace(/<action\b[^>]*>[^<]*$/gi, ' ')
    // <i>/<em>/<b> emphasis + any stray/orphan/self-closing tag → UNWRAP (keep words).
    .replace(/<\/?[a-z][^>]*>/gi, '')
    // Bare partial tag at the very end while streaming ("<i", "</").
    .replace(/<\/?[a-z]*$/gi, '')
}

function tidy(s: string): string {
  return s.replace(/[ \t]{2,}/g, ' ').replace(/^ +| +$/gm, '').trim()
}

/** Remove all emote markers (tags + *asterisks*) for TTS. */
export function stripEmotes(text: string): string {
  return tidy(stripTags(text).replace(ASTERISK_EMOTE_RE, ' '))
}

/**
 * Remove stage-direction tags for display, but leave *asterisk* patterns alone so
 * markdown italic rendering works. Use this for chat display; stripEmotes for TTS.
 */
export function stripEmotesForDisplay(text: string): string {
  return tidy(stripTags(text))
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
