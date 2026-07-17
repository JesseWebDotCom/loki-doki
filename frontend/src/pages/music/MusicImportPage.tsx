// Playlist import: paste a track list or drop a CSV/JSON export, resolve every entry
// against the catalog, review what matched, then save it as a playlist. Counts are
// reported honestly: an ambiguous match is called ambiguous, not silently accepted.

import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, FileUp, HelpCircle, Search, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Spinner } from '@/components/ui/spinner'
import { Badge } from '@/components/ui/badge'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { SongArt } from '@/components/music/SongArt'
import { parseTrackList } from '@/lib/music/importParse'
import {
  createImportedPlaylist, resolveImportEntries,
  type ImportEntry, type ResolvedImportEntry,
} from '@/lib/music/portabilityApi'
import { catalogSearch } from '@/lib/music/catalogApi'

const PLACEHOLDER = `Daft Punk - Around the World
Fleetwood Mac - Dreams
Nina Simone - Feeling Good`

type Row = { entry: ImportEntry; resolved: ResolvedImportEntry }

/** Manual fixer for an ambiguous or unmatched row: search the catalog and pick. */
function FixRow({ row, onPick, onClose }: {
  row: Row
  onPick: (track: { videoId: string; title: string; artist: string; durationSec: number | null }) => void
  onClose: () => void
}) {
  const [q, setQ] = useState(`${row.entry.artist} ${row.entry.title}`.trim())
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Array<{ videoId: string; title: string; artist: string; durationSec: number | null }>>([])

  async function run() {
    const term = q.trim()
    if (!term) return
    setSearching(true)
    try {
      const { songs } = await catalogSearch(term, 'songs')
      // The catalog returns identities; resolve happens when the pick is saved, so show
      // the identity and carry its mbid through as the videoId placeholder is not known
      // yet. Instead we re-resolve the exact identity via the import resolver.
      const picked = await resolveImportEntries(
        songs.slice(0, 8).map(s => ({ title: s.title, artist: s.artistName, durationSec: s.durationSec })),
      )
      setResults(picked.filter(p => p.track).map(p => p.track!))
    } catch {
      toast.error('Could not search the catalog.')
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="mt-2 rounded-card border border-border/60 bg-background/60 p-3">
      <div className="flex items-center gap-2">
        <Input value={q} onChange={e => setQ(e.target.value)} placeholder="Search for the right song"
          onKeyDown={e => { if (e.key === 'Enter') void run() }} className="flex-1" />
        <Button size="sm" onClick={() => void run()} disabled={searching} className="gap-1.5">
          {searching ? <Spinner className="text-current" /> : <Search className="size-3.5" />} Search
        </Button>
        <Button variant="ghost" size="icon-sm" onClick={onClose} title="Close" aria-label="Close">
          <X className="size-4" />
        </Button>
      </div>
      {results.length > 0 && (
        <div className="mt-2 grid gap-1">
          {results.map(r => (
            <button key={r.videoId} onClick={() => onPick(r)}
              className="flex items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs transition hover:bg-foreground/8">
              <SongArt trackRef={r.videoId} title={r.title} artist={r.artist} className="size-8" rounded="rounded-control" />
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{r.title}</span>
                <span className="text-muted-foreground"> {r.artist}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {!searching && results.length === 0 && (
        <p className="mt-2 text-xs text-muted-foreground">Search to pick the right song for this line.</p>
      )}
    </div>
  )
}

export function MusicImportPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement | null>(null)

  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [resolving, setResolving] = useState(false)
  const [creating, setCreating] = useState(false)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [fixing, setFixing] = useState<number | null>(null)
  const [dropping, setDropping] = useState(false)

  const counts = useMemo(() => ({
    matched: rows?.filter(r => r.resolved.status === 'matched').length ?? 0,
    ambiguous: rows?.filter(r => r.resolved.status === 'ambiguous').length ?? 0,
    unmatched: rows?.filter(r => r.resolved.status === 'unmatched').length ?? 0,
  }), [rows])

  async function handleResolve(source = text, filename?: string) {
    const parsed = parseTrackList(source, filename)
    if (!parsed.entries.length) {
      toast.error('No tracks found. Paste one song per line as "Artist - Title", or upload a CSV or JSON export.')
      return
    }
    setResolving(true)
    setFixing(null)
    try {
      const results = await resolveImportEntries(parsed.entries)
      setRows(parsed.entries.map((entry, i) => ({
        entry,
        resolved: results[i] ?? { index: i, status: 'unmatched', track: null, score: null, source: null },
      })))
      if (!name.trim()) setName(filename?.replace(/\.[^.]+$/, '') || 'Imported playlist')
      const found = results.filter(r => r.track).length
      toast.success(`Checked ${parsed.entries.length} ${parsed.entries.length === 1 ? 'track' : 'tracks'}, found ${found}.`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not resolve the track list.')
    } finally {
      setResolving(false)
    }
  }

  async function handleFile(file: File) {
    const content = await file.text()
    setText(content.slice(0, 200_000))
    await handleResolve(content, file.name)
  }

  async function handleCreate() {
    const playable = (rows ?? []).filter(r => r.resolved.track)
    if (!playable.length) { toast.error('Nothing resolved to add.'); return }
    setCreating(true)
    try {
      const playlist = await createImportedPlaylist(name.trim() || 'Imported playlist', playable.map(r => ({
        videoId: r.resolved.track!.videoId,
        title: r.resolved.track!.title,
        artist: r.resolved.track!.artist,
        durationSec: r.resolved.track!.durationSec,
      })))
      await qc.invalidateQueries({ queryKey: ['music-playlists'] })
      toast.success(`Created "${playlist.name}" with ${playlist.trackCount} ${playlist.trackCount === 1 ? 'track' : 'tracks'}.`)
      navigate(`/music/playlist/${playlist.id}`)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create the playlist.')
    } finally {
      setCreating(false)
    }
  }

  function applyPick(index: number, track: { videoId: string; title: string; artist: string; durationSec: number | null }) {
    setRows(cur => (cur ?? []).map((r, i) => (
      i === index ? { ...r, resolved: { ...r.resolved, status: 'matched', track, source: 'youtube' } } : r
    )))
    setFixing(null)
  }

  function dropRow(index: number) {
    setRows(cur => (cur ?? []).filter((_, i) => i !== index))
  }

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Import" subtitle="Bring a playlist over from another service." />

      {!rows && (
        <Card
          className={cn('p-4 transition-colors', dropping && 'border-brand/60 bg-brand/5')}
          onDragOver={e => { e.preventDefault(); setDropping(true) }}
          onDragLeave={() => setDropping(false)}
          onDrop={e => {
            e.preventDefault()
            setDropping(false)
            const f = e.dataTransfer.files?.[0]
            if (f) void handleFile(f)
          }}
        >
          <p className="text-sm font-semibold">Paste your tracks</p>
          <p className="mt-1 text-xs text-muted-foreground">
            One song per line as "Artist - Title". You can also drop or upload a CSV export (Exportify and friends) or
            a JSON track list.
          </p>
          <Textarea
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={PLACEHOLDER}
            rows={10}
            className="mt-3 font-mono"
          />
          {/* design-ok(raw-input-element): visually hidden native file picker; the styled Button below triggers it */}
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.json,.txt,text/csv,application/json,text/plain"
            className="sr-only"
            onChange={e => { const f = e.target.files?.[0]; if (f) void handleFile(f) }}
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Button onClick={() => void handleResolve()} disabled={resolving || !text.trim()} className="gap-2">
              {resolving ? <Spinner className="text-current" /> : <Check className="size-4" />}
              {resolving ? 'Matching…' : 'Match tracks'}
            </Button>
            <Button variant="outline" className="gap-2" disabled={resolving} onClick={() => fileRef.current?.click()}>
              <Upload className="size-4" /> Upload a file
            </Button>
          </div>
        </Card>
      )}

      {rows && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge variant="default" className="gap-1"><Check className="size-3" /> {counts.matched} matched</Badge>
            {counts.ambiguous > 0 && (
              <Badge variant="info" className="gap-1"><HelpCircle className="size-3" /> {counts.ambiguous} need a look</Badge>
            )}
            {counts.unmatched > 0 && (
              <Badge variant="secondary" className="gap-1"><AlertCircle className="size-3" /> {counts.unmatched} not found</Badge>
            )}
          </div>

          {counts.ambiguous > 0 && (
            <p className="mb-4 text-xs text-muted-foreground">
              A track marked "need a look" resolved to something, but not confidently. Check it, or fix it by searching.
            </p>
          )}

          <SectionHeader title="Review" />
          <div className="mt-3 grid gap-1">
            {rows.map((row, i) => {
              const { status, track, source } = row.resolved
              return (
                <div key={i} className="rounded-card px-2 py-2 transition hover:bg-white/[0.04]">
                  <div className="flex items-center gap-3">
                    {track ? (
                      <SongArt trackRef={track.videoId} title={track.title} artist={track.artist} className="size-10 shrink-0" rounded="rounded-control" />
                    ) : (
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-foreground/8 text-muted-foreground">
                        <AlertCircle className="size-4" />
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {track ? track.title : row.entry.title}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {track ? track.artist : row.entry.artist || 'Unknown artist'}
                        {track && (row.entry.title !== track.title || row.entry.artist !== track.artist) && (
                          <span className="text-muted-foreground/60"> (from "{row.entry.artist} - {row.entry.title}")</span>
                        )}
                      </p>
                    </div>

                    {status === 'matched' && source && source !== 'youtube' && (
                      <Badge variant="outline" className="shrink-0">your library</Badge>
                    )}
                    {status === 'ambiguous' && <Badge variant="info" className="shrink-0">need a look</Badge>}
                    {status === 'unmatched' && <Badge variant="secondary" className="shrink-0">not found</Badge>}

                    {status !== 'matched' && (
                      <Button variant="ghost" size="sm" className="shrink-0 gap-1.5" onClick={() => setFixing(cur => cur === i ? null : i)}>
                        <Search className="size-3.5" /> Fix
                      </Button>
                    )}
                    <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => dropRow(i)}
                      title="Remove this line" aria-label="Remove this line">
                      <X className="size-4" />
                    </Button>
                  </div>

                  {fixing === i && (
                    <FixRow row={row} onPick={t => applyPick(i, t)} onClose={() => setFixing(null)} />
                  )}
                </div>
              )
            })}
          </div>

          <Card className="mt-6 p-4">
            <p className="text-sm font-semibold">Save as a playlist</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {counts.matched + counts.ambiguous > 0
                ? `${counts.matched + counts.ambiguous} of ${rows.length} tracks will be added.${counts.unmatched > 0 ? ` ${counts.unmatched} could not be found and will be left out.` : ''}`
                : 'Nothing resolved, so there is nothing to save yet.'}
            </p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input value={name} onChange={e => setName(e.target.value)} placeholder="Playlist name" className="sm:flex-1" />
              <Button onClick={() => void handleCreate()} disabled={creating || counts.matched + counts.ambiguous === 0} className="gap-2">
                {creating ? <Spinner className="text-current" /> : <FileUp className="size-4" />}
                {creating ? 'Creating…' : 'Create playlist'}
              </Button>
              <Button variant="outline" onClick={() => { setRows(null); setFixing(null) }}>
                Start over
              </Button>
            </div>
          </Card>
        </>
      )}
    </PageContainer>
  )
}
