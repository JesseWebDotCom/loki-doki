// Export a canvas artifact to a downloadable file. md/txt are raw; html renders a
// standalone page; pdf prints that page via the shared Playwright renderer.

import type { ArtifactRow } from '@/lib/artifacts/store'
// render.ts (Playwright + the reader stack) is imported lazily in the pdf branch so
// the artifacts route doesn't statically pull in Chromium bindings.

export interface ExportResult { bytes: Uint8Array; mime: string; filename: string }

function slug(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact'
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// Compact Markdown → HTML for exports (headings, fenced code, lists, blockquotes,
// bold/italic/inline-code/links). Deliberately small — this isn't a full CommonMark
// engine, just enough to make a readable document/PDF without a dependency.
function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
}

function mdToHtml(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inCode = false, listType: 'ul' | 'ol' | null = null, para: string[] = []
  const flushPara = () => { if (para.length) { out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = [] } }
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null } }
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/^```/.test(line)) {
      flushPara(); closeList()
      if (!inCode) { out.push('<pre><code>'); inCode = true } else { out.push('</code></pre>'); inCode = false }
      continue
    }
    if (inCode) { out.push(escapeHtml(raw)); continue }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) { flushPara(); closeList(); out.push(`<h${h[1]!.length}>${inlineMd(h[2]!)}</h${h[1]!.length}>`); continue }
    if (/^\s*>\s?/.test(line)) { flushPara(); closeList(); out.push(`<blockquote>${inlineMd(line.replace(/^\s*>\s?/, ''))}</blockquote>`); continue }
    if (/^\s*([-*+])\s+/.test(line)) { flushPara(); if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul' } out.push(`<li>${inlineMd(line.replace(/^\s*[-*+]\s+/, ''))}</li>`); continue }
    if (/^\s*\d+\.\s+/.test(line)) { flushPara(); if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol' } out.push(`<li>${inlineMd(line.replace(/^\s*\d+\.\s+/, ''))}</li>`); continue }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue }
    if (line.trim() === '') { flushPara(); closeList(); continue }
    para.push(line)
  }
  if (inCode) out.push('</code></pre>')
  flushPara(); closeList()
  return out.join('\n')
}

const PAGE_CSS = `body{font:16px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;max-width:44rem;margin:2rem auto;padding:0 1rem;color:#111}
h1,h2,h3,h4{line-height:1.25;margin:1.4em 0 .5em}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.9em;background:#f4f4f5;padding:.1em .3em;border-radius:4px}
pre{background:#f4f4f5;padding:1em;border-radius:8px;overflow:auto}pre code{background:none;padding:0}blockquote{border-left:3px solid #ccc;margin:1em 0;padding:.2em 1em;color:#555}
a{color:#2563eb}hr{border:none;border-top:1px solid #e5e5e5;margin:2em 0}ul,ol{padding-left:1.4em}`

/** Standalone HTML page for html/pdf export. html artifacts ARE the page; code is
 *  shown as a monospace block; documents render their Markdown. */
export function toHtml(art: ArtifactRow): string {
  if (art.type === 'html') return art.currentContent
  const inner = art.type === 'code'
    ? `<pre><code>${escapeHtml(art.currentContent)}</code></pre>`
    : mdToHtml(art.currentContent)
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(art.title)}</title><style>${PAGE_CSS}</style></head>
<body>${inner}</body></html>`
}

export async function exportArtifact(art: ArtifactRow, format: string): Promise<ExportResult> {
  const base = slug(art.title)
  const enc = new TextEncoder()
  switch (format) {
    case 'md':
    case 'markdown':
      return { bytes: enc.encode(art.currentContent), mime: 'text/markdown; charset=utf-8', filename: `${base}.md` }
    case 'txt':
      return { bytes: enc.encode(art.currentContent), mime: 'text/plain; charset=utf-8', filename: `${base}.txt` }
    case 'html':
      return { bytes: enc.encode(toHtml(art)), mime: 'text/html; charset=utf-8', filename: `${base}.html` }
    case 'pdf': {
      const { renderHtmlToPdf } = await import('@/lib/bookmarks/render')
      const pdf = await renderHtmlToPdf(toHtml(art))
      if (!pdf) throw new Error('PDF export is unavailable (Chromium not installed yet)')
      return { bytes: pdf, mime: 'application/pdf', filename: `${base}.pdf` }
    }
    default:
      throw new Error(`Unsupported export format: ${format}`)
  }
}
