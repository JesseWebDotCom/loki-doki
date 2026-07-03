import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Upload, Check, Music, ListMusic } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
  generateStingerVariants, renderStingerOutro, fileToStingerWav,
  type StingerVariant, type StingerSelection,
} from '@/lib/podcast/stinger'
import { TrackVariantGrid } from '@/components/shared/TrackVariantGrid'
import { listTracks, trackAudioUrl, fetchTrackBlob, type MusicTrack } from '@/lib/music/api'

type Tab = 'generated' | 'library' | 'upload'

/**
 * Stinger chooser - the audio sibling of CoverPicker. Offers auto-generated
 * musical styles (rendered offline), a track from the Music app library, or an
 * uploaded clip, and reports the chosen intro+outro pair (24 kHz mono WAV) for the
 * editor to PUT. Like the cover, one is always selected: the first style is
 * auto-picked as soon as previews render.
 */
export function StingerPicker({ onChange, autoSelect = true }: {
  onChange: (sel: StingerSelection | null) => void
  /** Pre-pick the first style (so a new show always has one). Off when editing an
   *  existing show, so just opening the dialog doesn't clobber its saved stinger. */
  autoSelect?: boolean
}) {
  const [tab, setTab] = useState<Tab>('generated')
  const [offset, setOffset] = useState(0)
  const [variants, setVariants] = useState<StingerVariant[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const [selected, setSelected] = useState<string | number | null>(null)
  const [picking, setPicking] = useState<string | number | null>(null)
  const [uploadName, setUploadName] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Music-library tab state.
  const [tracks, setTracks] = useState<MusicTrack[]>([])
  const [libLoading, setLibLoading] = useState(false)
  const [libError, setLibError] = useState(false)

  // Render a style's matching outro, then report the intro+outro pair upward.
  const choose = useCallback(async (v: StingerVariant) => {
    setSelected(v.key); setUploadName(null); setPicking(v.key)
    try {
      const outroBlob = await renderStingerOutro(v)
      onChange({ introBlob: v.introBlob, outroBlob, previewUrl: v.previewUrl })
    } catch { /* leave prior selection in place */ }
    finally { setPicking(null) }
  }, [onChange])

  const regenerate = useCallback(async (off: number) => {
    setLoading(true); setError(false); setSelected(null)
    try {
      const vs = await generateStingerVariants(off)
      setVariants(vs)
      if (autoSelect && vs[0]) void choose(vs[0])   // always-selected default (create only)
    } catch { setVariants([]); setError(true) }
    finally { setLoading(false) }
  }, [choose, autoSelect])

  // Generate once when the Generated tab first becomes active.
  useEffect(() => {
    if (tab !== 'generated' || variants.length || loading) return
    void regenerate(offset)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Load library tracks the first time the Library tab opens.
  useEffect(() => {
    if (tab !== 'library' || tracks.length || libLoading) return
    setLibLoading(true); setLibError(false)
    listTracks().then(setTracks).catch(() => setLibError(true)).finally(() => setLibLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  // Pick a library track - used as both intro and outro (like an uploaded clip).
  const chooseTrack = useCallback(async (t: MusicTrack) => {
    setSelected(t.id); setUploadName(null); setPicking(t.id)
    try {
      const blob = await fetchTrackBlob(t.id)
      onChange({ introBlob: blob, outroBlob: blob, previewUrl: trackAudioUrl(t.id) })
    } catch { /* keep prior selection */ }
    finally { setPicking(null) }
  }, [onChange])

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    setSelected(null); setPicking('upload')
    try {
      const wav = await fileToStingerWav(file)
      const previewUrl = URL.createObjectURL(wav)
      setUploadName(file.name)
      onChange({ introBlob: wav, outroBlob: wav, previewUrl })
    } catch { setUploadName(null) }
    finally { setPicking(null) }
  }

  return (
    <div className="space-y-3">
      <div className="flex gap-4 border-b border-border/40">
        {([['generated', 'Generated', Music], ['library', 'From Library', ListMusic], ['upload', 'Upload', Upload]] as const).map(([id, label, Icon]) => (
          <button key={id} type="button" onClick={() => setTab(id)}
            className={cn('-mb-px flex items-center gap-1.5 border-b-2 pb-2 text-sm font-semibold transition-colors',
              tab === id ? 'border-brand text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}>
            <Icon className="size-3.5" /> {label}
          </button>
        ))}
      </div>

      {tab === 'generated' && (
        <>
          <TrackVariantGrid<StingerVariant>
            variants={variants} loading={loading} selectedKey={selected} pickingKey={picking}
            onSelect={(v) => void choose(v)} columns={2}
            error={error ? 'Couldn’t prepare the music engine. Make sure the SoundFont finished downloading, then Regenerate.' : null}
          />
          <Button type="button" variant="outline" disabled={loading}
            onClick={() => { const n = offset + 1; setOffset(n); void regenerate(n) }}
            className="w-full text-muted-foreground">
            {loading ? <Spinner className="text-current" /> : <RefreshCw className="size-4" />} Regenerate
          </Button>
        </>
      )}

      {tab === 'library' && (
        tracks.length || libLoading || libError ? (
          <TrackVariantGrid<MusicTrack & { key: string; previewUrl: string }>
            variants={tracks.map((t) => ({ ...t, key: t.id, label: t.title, previewUrl: trackAudioUrl(t.id) }))}
            loading={libLoading} selectedKey={selected} pickingKey={picking}
            onSelect={(t) => void chooseTrack(t)} columns={1}
            error={libError ? 'Couldn’t load your music library.' : null}
            sublabel={(t) => [t.kind !== 'track' ? t.kind : null, t.styleId, t.bpm ? `${t.bpm} BPM` : null].filter(Boolean).join(' · ')}
          />
        ) : (
          <p className="rounded-control border border-border/60 px-3 py-4 text-center text-xs text-muted-foreground">
            No saved tracks yet. Create some in the Music app, then pick one here.
          </p>
        )
      )}

      {tab === 'upload' && (
        <div className="space-y-3">
          {uploadName ? (
            <div className="flex items-center gap-2 rounded-card border border-brand bg-brand/5 px-3 py-3 text-sm">
              <Music className="size-4 text-brand" /> <span className="flex-1 truncate">{uploadName}</span>
              {picking === 'upload' ? <Spinner /> : <Check className="size-4 text-brand" />}
            </div>
          ) : (
            <button type="button" onClick={() => fileRef.current?.click()}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-border/60 py-8 text-muted-foreground hover:bg-muted/40">
              {picking === 'upload' ? <Spinner size="lg" /> : <Upload className="size-6" />}
              <span className="text-sm">Click to upload an audio clip (mp3/wav, ≤6s used)</span>
            </button>
          )}
          {uploadName && <button type="button" onClick={() => fileRef.current?.click()} className="w-full text-center text-xs text-brand hover:underline">Choose a different clip</button>}
          <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={onFile} />
        </div>
      )}
    </div>
  )
}
