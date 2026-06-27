// Normalize an auto-generated title (music station, podcast show, …) so it never
// carries an em/en dash or emoji. These titles are derived from movie names,
// YouTube channel names, etc. — sources that frequently include "—" separators
// and decorative emoji we don't want in our own UI.

// Emoji, pictographs, regional indicators, skin-tone modifiers, variation
// selectors, ZWJ, and keycap combiners.
const EMOJI_RE =
  /[\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{00A9}\u{00AE}\u{2122}\u{2139}\u{2300}-\u{23FF}]/gu

/** Strip emoji and convert every dash variant to a plain " - " hyphen. */
export function cleanAutoTitle(input: string | null | undefined): string {
  let s = (input ?? '')
    .normalize('NFC')
    // Any dash/bar variant (figure, en, em, horizontal bar, minus) → spaced hyphen.
    .replace(/\s*[‒–—―−]\s*/g, ' - ')
    .replace(EMOJI_RE, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  // Drop any separator left dangling at the edges after stripping emoji.
  s = s.replace(/^[\s\-|·•]+/, '').replace(/[\s\-|·•]+$/, '').trim()
  return s
}

/**
 * Clean auto-written prose (descriptions, blurbs). Like cleanAutoTitle but tuned for
 * sentences: em/en dashes become a comma (their usual parenthetical role) rather than a
 * hyphen, and emoji are stripped. Use on anything we generate or that an LLM writes.
 */
export function cleanAutoText(input: string | null | undefined): string {
  return (input ?? '')
    .normalize('NFC')
    .replace(/\s*[‒–—―]\s*/g, ', ')   // em/en/figure dash → comma
    .replace(EMOJI_RE, '')
    .replace(/\s*,\s*,+/g, ', ')       // collapse any doubled commas this produced
    .replace(/\s+([,.;:!?])/g, '$1')   // tidy space-before-punctuation
    .replace(/\s{2,}/g, ' ')
    .trim()
}
