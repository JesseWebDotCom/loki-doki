// Music Studio home: upload a song, see your studio projects, open one into the mixer.
// Also surfaces the one-time runtime install (Demucs + Essentia) for admins.
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { SlidersHorizontal, Upload, Music4, Waves, Mic, Trash2, Search } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { ConfirmDialog } from '@/components/shared/ConfirmDialog'
import { useAuth } from '@/context/AuthContext'
import { toast } from '@/lib/toast'
import {
  listStudioTracks, uploadStudioTrack, deleteStudioTrack, createStudioFromCatalog,
  type StudioTrack,
} from '@/lib/music/studioApi'
import { StudioSongPicker } from '@/components/music/studio/StudioSongPicker'
import { StudioCover } from '@/components/music/studio/StudioCover'
import type { CatalogSong } from '@/lib/music/catalogApi'

function StatusPill({ track }: { track: StudioTrack }) {
  if (track.sourceStatus === 'fetching')
    return <span className="text-xs text-brand">Fetching audio…</span>
  if (track.sourceStatus === 'failed')
    return <span className="text-xs text-destructive">Couldn't fetch audio</span>
  if (track.stemStatus === 'separating' || track.stemStatus === 'pending')
    return <span className="text-xs text-brand">Separating…</span>
  if (track.stemStatus === 'ready')
    return <span className="text-xs text-muted-foreground">{track.stems.length} stems</span>
  if (track.analysisStatus === 'analyzing' || track.analysisStatus === 'pending')
    return <span className="text-xs text-muted-foreground">Analysing…</span>
  return <span className="text-xs text-muted-foreground">Ready to separate</span>
}

export function MusicStudioPage() {
  const qc = useQueryClient()
  const { user } = useAuth()
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['studio-tracks'],
    queryFn: listStudioTracks,
    // Poll while any track is still fetching/analysing/separating so the list updates live.
    refetchInterval: (q) => (q.state.data?.tracks ?? []).some((t) =>
      t.sourceStatus === 'fetching' || t.analysisStatus === 'analyzing' || t.analysisStatus === 'pending'
      || t.stemStatus === 'separating' || t.stemStatus === 'pending') ? 3000 : false,
  })
  const tracks = data?.tracks ?? []
  const installed = data?.installed ?? true

  async function onPickSong(song: CatalogSong) {
    setPickerOpen(false)
    try {
      await createStudioFromCatalog({ mbid: song.mbid, albumMbid: song.albumMbid, albumTitle: song.albumTitle, title: song.title, artist: song.artistName, durationSec: song.durationSec })
      await qc.invalidateQueries({ queryKey: ['studio-tracks'] })
      toast.success('Adding to Studio')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not add song')
    }
  }

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setUploading(true)
    try {
      await uploadStudioTrack(file, { title: file.name.replace(/\.[^.]+$/, '') })
      await qc.invalidateQueries({ queryKey: ['studio-tracks'] })
      toast.success('Track added')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function onDelete(id: string) {
    try { await deleteStudioTrack(id); await qc.invalidateQueries({ queryKey: ['studio-tracks'] }); toast.success('Removed') }
    catch { toast.error('Could not remove') }
  }

  return (
    <PageContainer width="wide">
      <PageHeader
        plain
        title="Studio"
        subtitle="Split any song into stems and practise with a metronome, chords, and key changer."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setPickerOpen(true)}>
              <Search className="size-4" /> Find a song
            </Button>
            <Button onClick={() => fileRef.current?.click()} disabled={uploading}>
              {uploading ? <Spinner /> : <Upload className="size-4" />} Upload song
            </Button>
          </div>
        }
      />
      <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={onPick} />

      {!installed && (
        <Card variant="dashed" className="mb-6">
          <CardContent className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="text-sm text-muted-foreground">
              The Music Studio engine (AI stem separation + analysis) is not installed yet.
            </p>
            <p className="text-xs text-muted-foreground">
              {user?.role === 'admin'
                ? 'Enable Music Studio in Admin → Features (or the setup wizard) to install it.'
                : 'Ask an admin to enable Music Studio in Admin → Features.'}
            </p>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="flex h-48 items-center justify-center"><Spinner /></div>
      ) : tracks.length === 0 ? (
        <EmptyAppState
          icon={SlidersHorizontal}
          title="No tracks yet"
          tagline="Find a song from your Music app or upload one, then split it into vocals, drums, bass, and more."
          features={[
            { icon: Waves, title: 'AI stem separation', desc: 'Isolate or mute any instrument.' },
            { icon: Mic, title: 'Vocals & backing', desc: 'Karaoke or minus-one in one click.' },
            { icon: Music4, title: 'Practice tools', desc: 'Metronome, chords, key & speed.' },
          ]}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => setPickerOpen(true)}><Search className="size-4" /> Find a song</Button>
              <Button onClick={() => fileRef.current?.click()}><Upload className="size-4" /> Upload song</Button>
            </div>
          }
        />
      ) : (
        <div className="grid gap-3">
          {tracks.map((t) => (
            <Card key={t.id} variant="interactive" className="group">
              <CardContent className="flex items-center gap-3 py-3">
                <Link to={`/music/studio/${t.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                  <StudioCover src={t.coverUrl} artist={t.artist} album={t.title} className="size-11" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{t.title}</p>
                    <div className="flex items-center gap-2">
                      {t.artist && <span className="truncate text-xs text-muted-foreground">{t.artist}</span>}
                      <StatusPill track={t} />
                    </div>
                  </div>
                  {t.bpm != null && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{Math.round(t.bpm)} BPM</span>}
                  {t.keyLabel && <span className="shrink-0 text-xs text-muted-foreground">{t.keyLabel}</span>}
                </Link>
                <Button variant="ghost" size="icon-sm" aria-label="Remove track"
                  className="opacity-0 transition-opacity group-hover:opacity-100"
                  onClick={() => setDeleteId(t.id)}>
                  <Trash2 className="size-4" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <StudioSongPicker open={pickerOpen} onOpenChange={setPickerOpen} onPick={onPickSong} />

      <ConfirmDialog
        open={deleteId != null} onOpenChange={(o) => { if (!o) setDeleteId(null) }}
        destructive title="Remove this track?" description="This deletes the source and any separated stems."
        confirmLabel="Remove"
        onConfirm={() => { if (deleteId) void onDelete(deleteId); setDeleteId(null) }}
      />
    </PageContainer>
  )
}
