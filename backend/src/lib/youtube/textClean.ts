// Text-cleaning helpers for YouTube-sourced text (video/channel descriptions) shared by the
// in-app display and the Plex export — moved here from plex/export/ since this is a general
// YouTube concern, not Plex-specific.

// Matches http(s):// and bare www. links — the two forms that actually render as tappable
// in a client (Plex, or a naive in-app renderer). Deliberately doesn't try to also strip bare
// domains (e.g. "cash.app") without a scheme/www — those don't auto-linkify in practice, and
// a broader match risks mangling normal prose that happens to mention a product name.
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi

/**
 * Strip URLs from a video/channel description. Confirmed live (2026-07): a raw sponsor URL
 * in a YouTube description ("Download Cash App Today: https://...") came through as a
 * tappable link in a Plex client and triggered Cash App's install/deep-link flow — a real
 * safety concern for a household system other people (including kids) browse, not a
 * cosmetic one. This is the safety-net layer, applied regardless of whether the fuller
 * "Smart Description" LLM cleanup (summarize.ts) has run yet.
 */
export function stripUrls(text: string): string {
  return text.replace(URL_RE, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
}
