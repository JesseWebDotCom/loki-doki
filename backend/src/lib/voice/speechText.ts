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

  // Code: drop fenced blocks, unwrap inline code. The second replace also drops an
  // UNTERMINATED trailing fence (an opening ``` with no closing one yet) so a code block
  // that's still streaming, or a chunk that happens to hold only the opening fence, is
  // never voiced. (For fully streamed, sentence-by-sentence delivery the caller must ALSO
  // use createFenceStripper below — a bare interior code line carries no fence of its own
  // and can't be recognised here in isolation.)
  s = s.replace(/```[\s\S]*?```/g, ' ')
  s = s.replace(/```[\s\S]*$/g, ' ')
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

/** Stateful fenced-code-block remover for STREAMING speech. `stripForSpeech` drops only
 *  COMPLETE ```…``` pairs, but a streamed reply is spoken sentence-by-sentence, so the
 *  interior code lines arrive — and would be read aloud — long before the closing fence
 *  exists (and, once delivered, a lone code line carries no fence of its own to strip).
 *  Feed each streamed piece through the returned function IN ORDER: it carries the
 *  open/closed fence state across calls and returns only the text OUTSIDE any code fence
 *  (empty string while inside one). Handles fences that open and close within one piece,
 *  or straddle the boundary between two. Inline `code` is left to stripForSpeech. */
export function createFenceStripper(): (piece: string) => string {
  let inFence = false
  return (piece: string): string => {
    let out = ''
    let i = 0
    for (;;) {
      const idx = piece.indexOf('```', i)
      if (idx === -1) { if (!inFence) out += piece.slice(i); break }
      if (!inFence) out += piece.slice(i, idx)
      inFence = !inFence
      i = idx + 3
    }
    return out
  }
}
