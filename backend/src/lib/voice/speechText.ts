// Clean LLM reply text before TTS. Companion characters emit markdown and
// roleplay stage directions (*sigh*, *winks softly*, (laughs), emoji) — the chat
// surface renders them, but the voice must NOT read them aloud. Unlike a plain
// markdown stripper (which unwraps *x* → x and would still speak "sigh"), this
// DROPS single-asterisk/underscore spans and parenthetical asides entirely, while
// keeping the content of **bold** emphasis.

export function stripForSpeech(text: string): string {
  let s = text

  // <action>…</action> stage directions → DROP tag + inner (incl. streaming/unclosed).
  s = s.replace(/<action\b[^>]*>[^<]{0,200}<\/(?:action\s*>|>)?/gi, ' ')
  s = s.replace(/<action\b[^>]*>[^<]*$/gi, ' ')
  // <i>/<em>/<b> emphasis carry real words → UNWRAP (strip markers, keep inner).
  s = s.replace(/<\/?[a-z][^>]*>/gi, ' ')

  // Code: drop fenced blocks, unwrap inline code.
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`([^`\n]+)`/g, '$1')

  // Images/links → keep the visible label only.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // **bold** / __bold__ → keep inner text (emphasis on real words).
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')

  // Single *…* / _…_ spans = roleplay emotes → DROP (**bold** already unwrapped above).
  s = s.replace(/(?<!\w)\*[^*\n]+\*(?!\w)/g, ' ')
  s = s.replace(/(?<!\w)_[^_\n]+_(?!\w)/g, ' ')
  // Short parenthetical / bracketed asides → DROP.
  s = s.replace(/\([^()]{0,40}\)/g, ' ')
  s = s.replace(/\[[^\]\n]{0,60}\]/g, ' ')

  // Stray leftover emphasis markers.
  s = s.replace(/(?<!\w)[*_~]+(?!\w)/g, '')

  // Headings / list bullets / blockquotes.
  s = s.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  s = s.replace(/^[ \t]*([-*+]|\d+\.)[ \t]+/gm, '')
  s = s.replace(/^[ \t]*>[ \t]?/gm, '')

  // Emoji + dingbats + symbol pictographs.
  s = s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')

  // Tidy whitespace + punctuation left dangling by removals.
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/\s+([.,!?;:])/g, '$1')
  // Soft line wraps: a single newline mid-sentence (not after terminal punctuation)
  // is a wrap, not a sentence end — join it so "a news\nsite?" isn't chopped into
  // two utterances. Paragraph breaks (blank lines) and post-terminator newlines stay.
  s = s.replace(/([^\n.!?…])[ \t]*\n[ \t]*(?=\S)/g, '$1 ')
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}
