// Shared contract for the reusable SmartSearch autosuggest input. Each surface (YouTube,
// Music, ...) owns a small `suggest` function next to its existing API client that hits
// that surface's own backend endpoint — the core component never imports anything
// backend-specific, so it stays usable anywhere a search box wants suggestions.

export interface Suggestion {
  id: string
  /** Display text AND the string substituted into the query when this suggestion is picked. */
  label: string
  sublabel?: string
}

export type SuggestSource = (query: string, signal: AbortSignal) => Promise<Suggestion[]>
