// Complements the import-and-follow-along flow three ways:
//   • GProTab.net results are actual downloadable Guitar Pro FILES - one click imports them
//     server-side straight into the synced alphaTab viewer (search → import → follow along).
//   • Ultimate Guitar / Songsterr results are view-online links (their files are paywalled or
//     not offered, and scraping them is against their ToS) - found via this app's own
//     multi-engine webSearch() with site:-scoped queries, opened on the original site.
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Search, ExternalLink, Download } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/cn'
import { toast } from '@/lib/toast'
import { searchTabsOnline, importTabFromUrl, type TabSearchResponse, type TabSearchResult, type TabFileResult } from '@/lib/music/studioApi'

// design-ok(raw-palette-semantic): third-party site identity badges (UG orange / Songsterr blue)
const SITES = [
  { key: 'ultimateGuitar' as const, label: 'Ultimate Guitar', badgeClass: 'bg-orange-500/15 text-orange-500' },
  { key: 'songsterr' as const, label: 'Songsterr', badgeClass: 'bg-sky-500/15 text-sky-500' },
]

function ResultRow({ result }: { result: TabSearchResult }) {
  return (
    <a href={result.url} target="_blank" rel="noreferrer noopener"
      className="group flex items-start gap-2 rounded-control px-2 py-1.5 text-left transition hover:bg-accent/40">
      <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground group-hover:text-foreground" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{result.title}</p>
        {result.snippet && <p className="line-clamp-1 text-xs text-muted-foreground">{result.snippet}</p>}
      </div>
    </a>
  )
}

function FileRow({ result, busy, onImport }: { result: TabFileResult; busy: boolean; onImport: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-control px-2 py-1.5 transition hover:bg-accent/40">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{result.title}</p>
        <p className="truncate text-xs text-muted-foreground">{result.artist}</p>
      </div>
      <a href={result.url} target="_blank" rel="noreferrer noopener" aria-label="View on GProTab"
        className="shrink-0 rounded-full p-1.5 text-muted-foreground transition hover:bg-accent hover:text-foreground">
        <ExternalLink className="size-3.5" />
      </a>
      <Button size="sm" variant="outline" disabled={busy} onClick={onImport} className="shrink-0">
        {busy ? <Spinner className="text-current" /> : <Download className="size-3.5" />} Import
      </Button>
    </div>
  )
}

export function TabWebSearch({ trackId, artist, title }: { trackId: string; artist: string | null; title: string }) {
  const qc = useQueryClient()
  const seed = `${artist ?? ''} ${title}`.trim()
  const [q, setQ] = useState(seed)
  const [results, setResults] = useState<TabSearchResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [searchedFor, setSearchedFor] = useState<string | null>(null)
  const [importingUrl, setImportingUrl] = useState<string | null>(null)

  async function runSearch(query: string) {
    if (!query.trim()) return
    setLoading(true)
    try { setResults(await searchTabsOnline(trackId, query)); setSearchedFor(query) }
    catch { toast.error('Search failed') }
    finally { setLoading(false) }
  }

  useEffect(() => { if (seed) void runSearch(seed) }, [seed]) // eslint-disable-line react-hooks/exhaustive-deps

  async function onImport(file: TabFileResult) {
    setImportingUrl(file.url)
    try {
      await importTabFromUrl(trackId, file.url, `${file.artist} - ${file.title}`)
      toast.success('Tab imported - it will follow along with playback')
      await qc.invalidateQueries({ queryKey: ['studio-tabs', trackId] })
    } catch (err) { toast.error(err instanceof Error ? err.message : 'Could not import that tab') }
    finally { setImportingUrl(null) }
  }

  const empty = results && results.ultimateGuitar.length === 0 && results.songsterr.length === 0 && results.gprotab.length === 0

  return (
    <Card>
      <CardHeader className="space-y-0.5 p-3 pb-1">
        <CardTitle className="text-sm text-muted-foreground">Find this tab online</CardTitle>
        <p className="text-xs text-muted-foreground/70">GProTab results import straight into the synced player; Ultimate Guitar and Songsterr open on their site.</p>
      </CardHeader>
      <CardContent className="space-y-3 p-3 pt-1">
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void runSearch(q) }}>
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Song title, artist…" className="flex-1" />
          <Button type="submit" variant="outline" disabled={loading || !q.trim()} className="text-muted-foreground hover:text-foreground">
            {loading ? <Spinner className="text-current" /> : <Search className="size-4" />}
          </Button>
        </form>

        {loading && !results ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : results ? (
          empty ? (
            <p className="py-2 text-center text-sm text-muted-foreground">No matches for "{searchedFor}" on GProTab, Ultimate Guitar, or Songsterr.</p>
          ) : (
            <div className="space-y-4">
              {results.gprotab.length > 0 && (
                <div>
                  {/* design-ok(raw-palette-semantic): third-party site identity badge (GProTab green) */}
                  <span className="inline-flex items-center rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-semibold text-emerald-500">GProTab · importable files</span>
                  <div className="mt-1.5 space-y-0.5">
                    {results.gprotab.map((r) => (
                      <FileRow key={r.url} result={r} busy={importingUrl === r.url} onImport={() => void onImport(r)} />
                    ))}
                  </div>
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                {SITES.map((site) => {
                  const rows = results[site.key]
                  if (rows.length === 0) return null
                  return (
                    <div key={site.key}>
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold', site.badgeClass)}>{site.label}</span>
                      <div className="mt-1.5 space-y-0.5">
                        {rows.map((r) => <ResultRow key={r.url} result={r} />)}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  )
}
