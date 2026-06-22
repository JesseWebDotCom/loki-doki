// Clean LLM reply text before TTS. Companion characters emit markdown and
// roleplay stage directions (*sigh*, *winks softly*, (laughs), emoji) — the chat
// surface renders them, but the voice must NOT read them aloud. Unlike a plain
// markdown stripper (which unwraps *x* → x and would still speak "sigh"), this
// DROPS single-asterisk/underscore spans and parenthetical asides entirely, while
// keeping the content of **bold** emphasis.

export function stripForSpeech(text: string): string {
  let s = text

  // Code: drop fenced blocks, unwrap inline code.
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/`([^`\n]+)`/g, '$1')

  // Images/links → keep the visible label only.
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')

  // **bold** / __bold__ → keep inner text (emphasis on real words).
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')

  // Single *…* / _…_ spans = roleplay actions/emotes (*sigh*, *winks*) → DROP.
  s = s.replace(/(?<!\w)\*[^*\n]+\*(?!\w)/g, ' ')
  s = s.replace(/(?<!\w)_[^_\n]+_(?!\w)/g, ' ')

  // Short parenthetical asides/emotes ((sigh), (laughs softly)) → DROP.
  s = s.replace(/\([^()]{0,40}\)/g, ' ')

  // Bracketed stage directions + unfilled template placeholders
  // ([laughs], [insert time here], [name]) → DROP. (Markdown links were already
  // converted to their label text above, so this won't strip those.)
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
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}
