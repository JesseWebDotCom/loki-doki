export interface Source {
  url: string
  title: string
  /** Human-readable publication date ("today", "Aug 9") when the backend knows it.
   *  Shown on the source row: visible dates measurably raise answer trust. */
  date?: string
}

// Replaces [1], [2], ... markers in LLM prose with backtick-wrapped CITE:N markers.
// The MarkdownRenderer's `code` component intercepts "CITE:N" and renders a CitationChip.
// Using backticks (inline code) avoids rehype-raw and works reliably with react-markdown v10.
export function transformCitations(text: string, sources: Source[]): string {
  if (!sources.length) return text
  return text.replace(/\[(\d+)\]/g, (match, n) => {
    const idx = parseInt(n, 10)
    if (idx < 1 || idx > sources.length) return match
    return `\`CITE:${idx}\``
  })
}
