// Standalone ZIM content server — replacement for kiwix-serve.
// Spawned by the main backend as a child process.
// Serves ZIM files at http://127.0.0.1:8090/:bookName/path

import { Archive, Searcher, Query } from '@openzim/libzim'

const PORT = parseInt(process.env.ZIM_SERVER_PORT ?? '8090', 10)
const BIND = process.env.ZIM_SERVER_HOST ?? '127.0.0.1'

// Map bookName → { archive, path }
const books = new Map<string, { archive: Archive; path: string }>()

// Lazy per-book cache of "top-level" entries (no '/' in path) sorted by title —
// the closest thing to "one row per book/work" a ZIM's title index offers.
// Many Books-category ZIMs (Wikibooks, Wikisource) store one entry per SECTION of
// a book under a shared prefix, so filtering to depth-0 paths turns "118k pages"
// into "14k book-like titles" instead of a wall of sub-chapter noise. Building
// this requires a full iterByTitle() scan (~150ms for a 400k-entry ZIM) so it's
// built once per book and reused, not recomputed per request.
const browseCache = new Map<string, { title: string; path: string }[]>()

function topLevelEntries(archive: Archive, bookName: string): { title: string; path: string }[] {
  const cached = browseCache.get(bookName)
  if (cached) return cached
  const out: { title: string; path: string }[] = []
  for (const e of archive.iterByTitle()) {
    if (!e.path.includes('/')) out.push({ title: e.title, path: e.path })
  }
  browseCache.set(bookName, out)
  return out
}

// Load all ZIM paths passed as CLI args
for (const p of process.argv.slice(2)) {
  if (!p.endsWith('.zim')) continue
  try {
    const archive = new Archive(p)
    const name = archive.getMetadata('Name')
    books.set(name, { archive, path: p })
    console.error(`[zim-server] Loaded: ${name} (${p})`)
  } catch (err) {
    console.error(`[zim-server] Failed to load ${p}: ${err}`)
  }
}

Bun.serve({
  port: PORT,
  hostname: BIND,

  async fetch(req) {
    const url  = new URL(req.url)
    const path = url.pathname

    // Health / catalog compatibility endpoint
    if (path === '/health' || path === '/catalog/v2/entries') {
      return json({ status: 'ok', books: Array.from(books.keys()) })
    }

    // One-shot metadata: GET /api/name?path=<zimPath>
    if (path === '/api/name') {
      const zimPath = url.searchParams.get('path')
      if (!zimPath) return new Response('Missing path', { status: 400 })

      // Check already-loaded books first
      for (const [name, { path: p }] of books) {
        if (p === zimPath) return json({ name })
      }

      // Open on demand for the name lookup
      try {
        const archive = new Archive(zimPath)
        return json({ name: archive.getMetadata('Name') })
      } catch (err) {
        return json({ error: String(err) }, 500)
      }
    }

    // Route: /:bookName[/articlePath][?query]
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return new Response('ZIM server running', { status: 200 })

    const bookName   = parts[0]
    const book       = books.get(bookName)
    if (!book) return new Response(`Unknown book: ${bookName}`, { status: 404 })

    const { archive } = book
    const articlePath = parts.slice(1).join('/')

    // Root → redirect to main entry
    if (!articlePath) {
      if (!archive.hasMainEntry()) return new Response('No main entry', { status: 404 })
      const main = archive.mainEntry
      const target = main.isRedirect ? main.redirectEntry.path : main.path
      return redirect(`/${bookName}/${target}`)
    }

    // Search: /:bookName/search?pattern=<q>[&format=json][&count=<n>]
    if (articlePath === 'search') {
      const pattern = url.searchParams.get('pattern') ?? ''
      const count   = Math.min(parseInt(url.searchParams.get('count') ?? '25', 10), 25)
      const format  = url.searchParams.get('format')
      if (format === 'json') return serveSearchJson(archive, bookName, pattern, count)
      return serveSearch(archive, bookName, pattern)
    }

    // Browse: /:bookName/browse?start=<n>&count=<n>&q=<title filter>&format=json
    // Alphabetical listing of top-level entries, unlike /search which full-text
    // searches article bodies. This is what lets a Books-category ZIM be browsed
    // as a proper title list instead of only reachable via full-text search.
    if (articlePath === 'browse') {
      const start = Math.max(0, parseInt(url.searchParams.get('start') ?? '0', 10) || 0)
      const count = Math.min(100, Math.max(1, parseInt(url.searchParams.get('count') ?? '30', 10) || 30))
      const q     = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const all   = topLevelEntries(archive, bookName)
      const filtered = q ? all.filter((e) => e.title.toLowerCase().includes(q)) : all
      return json({ results: filtered.slice(start, start + count), total: filtered.length })
    }

    // Random article — manually follow redirect chain instead of getItem(true)
    // which throws for certain entries when the redirect target can't be resolved.
    if (articlePath === 'random') {
      try {
        let entry = archive.randomEntry
        let hops  = 0
        while (entry.isRedirect && hops < 10) {
          entry = entry.redirectEntry
          hops++
        }
        return redirect(`/${bookName}/${entry.path}`)
      } catch {
        return new Response('No random entry', { status: 404 })
      }
    }

    // General article / asset lookup.
    // Fallback: old-format ZIMs store entries under the 'A/' namespace, so links
    // emitted without that prefix (e.g. /bookName/files/foo.pdf) need a retry.
    let resolvedPath = articlePath
    if (!archive.hasEntryByPath(articlePath)) {
      const namespacedPath = `A/${articlePath}`
      if (archive.hasEntryByPath(namespacedPath)) {
        resolvedPath = namespacedPath
      } else {
        return new Response('Not found', { status: 404 })
      }
    }

    const entry = archive.getEntryByPath(resolvedPath)

    // Redirect entries
    if (entry.isRedirect) {
      try {
        const target = entry.redirectEntry
        return redirect(`/${bookName}/${target.path}`)
      } catch {
        return new Response('Redirect target missing', { status: 404 })
      }
    }

    // Serve item content
    let item
    try {
      item = entry.getItem(false)
    } catch {
      return new Response('Item unavailable', { status: 404 })
    }

    const mimeType = item.mimetype || 'application/octet-stream'
    const data     = item.data.data  // Node Buffer (Uint8Array)

    return new Response(data, {
      status: 200,
      headers: {
        'content-type':   mimeType,
        'content-length': String(data.length),
        'cache-control':  'public, max-age=86400',
      },
    })
  },
})

console.error(`[zim-server] Listening on http://${BIND}:${PORT} (${books.size} books)`)

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function redirect(location: string) {
  return new Response(null, { status: 301, headers: { location } })
}

function serveSearchJson(archive: Archive, _bookName: string, pattern: string, count: number): Response {
  const hits: { path: string; title: string; snippet: string }[] = []
  if (pattern && archive.hasFulltextIndex()) {
    try {
      const searcher = new Searcher(archive)
      const search   = searcher.search(new Query(pattern))
      const max      = Math.min(search.estimatedMatches, count)
      const results  = search.getResults(0, max)
      for (const r of results) hits.push({ path: r.path, title: r.title, snippet: r.snippet })
    } catch { /* no results */ }
  }
  return json({ results: hits })
}

function serveSearch(archive: Archive, bookName: string, pattern: string): Response {
  if (!pattern) return new Response(searchHtml(bookName, '', []), htmlHeaders())

  let hits: { path: string; title: string; snippet: string }[] = []

  if (archive.hasFulltextIndex()) {
    try {
      const searcher = new Searcher(archive)
      const search   = searcher.search(new Query(pattern))
      const max      = Math.min(search.estimatedMatches, 25)
      const results  = search.getResults(0, max)
      for (const r of results) {
        hits.push({ path: r.path, title: r.title, snippet: r.snippet })
      }
    } catch { /* no results */ }
  }

  return new Response(searchHtml(bookName, pattern, hits), htmlHeaders())
}

function htmlHeaders(): ResponseInit {
  return { headers: { 'content-type': 'text/html; charset=utf-8' } }
}

function searchHtml(
  bookName: string,
  query: string,
  results: { path: string; title: string; snippet: string }[],
): string {
  const items = results.length === 0
    ? `<p class="empty">No results found${query ? ` for "${esc(query)}"` : ''}.</p>`
    : results.map((r) => `
        <div class="result">
          <a href="/${bookName}/${r.path}">${esc(r.title)}</a>
          ${r.snippet ? `<p>${r.snippet}</p>` : ''}
        </div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="light dark">
<title>Search: ${esc(query)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{--bg:#ffffff;--fg:#09090b;--fg2:#71717a;--border:#e4e4e7;--link:#2563eb;--hover:#f4f4f5}
  @media(prefers-color-scheme:dark){:root{--bg:#09090b;--fg:#fafafa;--fg2:#a1a1aa;--border:#27272a;--link:#60a5fa;--hover:#18181b}}
  body{background:var(--bg);color:var(--fg);font-family:system-ui,-apple-system,sans-serif;font-size:14px;padding:1rem 1.25rem}
  h1{font-size:.8rem;font-weight:500;color:var(--fg2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:.75rem}
  .result{padding:.6rem .75rem;border-radius:.375rem;margin:.25rem 0}
  .result:hover{background:var(--hover)}
  .result a{color:var(--link);text-decoration:none;font-size:.9rem;font-weight:500;display:block}
  .result p{margin:.2rem 0 0;font-size:.78rem;color:var(--fg2);line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
  .empty{color:var(--fg2);font-style:italic;padding:.5rem 0}
</style>
</head>
<body>
<h1>Results for "${esc(query)}"</h1>
${items}
</body>
</html>`
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
