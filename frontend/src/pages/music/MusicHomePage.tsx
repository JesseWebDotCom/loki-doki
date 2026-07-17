import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Radio, Download, Play, Plus, Sparkles } from 'lucide-react'
import { artUrlForRef } from '@/lib/music/trackRef'
import { PageHeader } from '@/components/shared/PageHeader'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { StationCard } from '@/components/music/StationCard'
import { StationEditorDialog } from '@/components/music/StationEditorDialog'
import { Button } from '@/components/ui/button'
import { StationArt } from '@/components/music/StationArt'
import { BlendedHeroBackdrop } from '@/components/shared/BlendedHeroBackdrop'
import { useSongArt } from '@/components/music/SongArt'
import { SongTile } from '@/components/music/SongTile'
import { useRadio } from '@/context/RadioContext'
import { useMusicModeOptional } from '@/components/music/MusicLayout'
import { useOfflineStations, useOfflineSongs } from '@/lib/music/useOffline'
import { listStations, getStation, getHistory, getRails, stationToDj, type Station, type Rail } from '@/lib/music/catalogApi'
import { getMixes, playSomething, type MixForYou } from '@/lib/music/intelApi'
import { Spinner } from '@/components/ui/spinner'
import { DismissableCard } from '@/components/shared/DismissableCard'
import { PitchBanner } from '@/components/shared/PitchBanner'
import { useSuggestionDismiss } from '@/hooks/useSuggestionDismiss'
import { getAppByPath } from '@/lib/appCategories'
import { FamilyAudioBlockedCard } from '@/components/shared/FamilyAudioBlockedCard'
import { JamBanner } from '@/components/music/JamBanner'

// (SongTile moved to components/music/SongTile - shared with Browse.)

// The page's focal point: a full-width billboard for the day's featured station.
// A real album cover from the station's queue anchors the right edge and DISSOLVES into
// the station's accent color (mask fade + tint) - the Apple-Music editorial pattern -
// with the banner art as the fallback when no cover resolves yet. Rotates daily.
function StationBillboard({ stations }: { stations: Station[] }) {
  const radio = useRadio()
  const navigate = useNavigate()
  const day = Math.floor(Date.now() / 86_400_000)
  const station = stations.length ? stations[day % stations.length]! : null
  const dj = station ? stationToDj(station) : null

  // The station's stamped cover song - the SAME art its card shows (one source of truth),
  // and zero extra requests: it rides along on the stations list we already have.
  const coverArt = useSongArt(station?.coverTrack?.videoId, station?.coverTrack?.title, station?.coverTrack?.artist)

  // "Play Something": one tap, the server picks something appropriate (recent favorites,
  // one of your mixes, or a time-of-day station) and playback starts immediately.
  const [picking, setPicking] = useState(false)
  const playAnything = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (picking) return
    setPicking(true)
    try {
      const { choice } = await playSomething()
      if (choice.kind === 'tracks' && choice.tracks.length) {
        radio.playPlaylist(
          choice.tracks.map(t => ({ videoId: t.videoId, title: t.title, author: t.artist || null, thumbnail: '' })),
          0, { name: choice.name },
        )
        toast.success(`${choice.name}: ${choice.reason}`)
      } else if (choice.kind === 'station') {
        const st = stations.find(s => s.id === choice.stationId)
          ?? (await getStation(choice.stationId)).station
        radio.start(stationToDj(st))
        toast.success(`${st.name}: ${choice.reason}`)
      }
      navigate('/music/now-playing')
    } catch {
      // Built-in fallback: the featured station always exists.
      if (station) { radio.start(stationToDj(station)); navigate('/music/now-playing') }
      else toast.error('Could not pick something to play')
    } finally { setPicking(false) }
  }

  if (!station || !dj) return null
  const play = (e: React.MouseEvent) => { e.stopPropagation(); radio.start(stationToDj(station)); navigate('/music/now-playing') }

  return (
    <button onClick={() => navigate(`/music/station/${station.id}`)}
      className="group relative mb-8 block w-full overflow-hidden rounded-sheet text-left shadow-xl">
      <div className="relative aspect-[21/8] w-full overflow-hidden sm:aspect-auto sm:h-64 lg:h-72 xl:h-80">
        <BlendedHeroBackdrop art={coverArt} color={dj.color} colorDark={dj.colorDark}
          fallback={<StationArt station={station} />} />
      </div>
      <div className="absolute inset-y-0 left-0 flex max-w-xl flex-col justify-center gap-2 p-6 sm:p-9">
        <span className="text-[11px] font-semibold uppercase tracking-widest text-white/60">Station of the day</span>
        <span className="text-2xl font-extrabold tracking-tight text-white sm:text-4xl">{station.name}</span>
        {station.description && !station.description.startsWith('source:') && (
          <span className="line-clamp-2 max-w-md text-sm text-white/70">{station.description}</span>
        )}
        <span className="mt-2 flex flex-wrap items-center gap-2">
          <span onClick={play} role="button" aria-label={`Play ${station.name}`}
            className="inline-flex w-fit items-center gap-2 rounded-full bg-white px-5 py-2.5 text-sm font-semibold text-black shadow-lg transition hover:scale-105 active:scale-95">
            <Play className="size-4 fill-current" /> Play
          </span>
          <span onClick={playAnything} role="button" aria-label="Play something"
            title="One tap, something you'll like starts playing"
            className="inline-flex w-fit items-center gap-2 rounded-full bg-white/20 px-5 py-2.5 text-sm font-semibold text-white shadow-lg transition hover:scale-105 hover:bg-white/30 active:scale-95">
            {picking ? <Spinner size="sm" /> : <Sparkles className="size-4" />} Play something
          </span>
        </span>
      </div>
    </button>
  )
}

function StationGrid({ stations }: { stations: Station[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {stations.map(s => <StationCard key={s.id} station={s} />)}
    </div>
  )
}

/** Offline home: station-first, only what's downloaded - no prebuilt catalog. */
function OfflineHome() {
  const radio = useRadio()
  const { data: stationData } = useOfflineStations()
  const { data: offlineData } = useOfflineSongs()
  const { data: hist } = useQuery({ queryKey: ['music-history'], queryFn: () => getHistory(20) })
  const stations = stationData?.stations ?? []
  const readyIds = new Set((offlineData?.offline ?? []).filter(t => t.status === 'ready').map(t => t.videoId))
  const recent = (hist?.history ?? []).filter(h => readyIds.has(h.videoId)).slice(0, 12)

  return (
    <PageContainer width="wide" className="pb-10">
      <PageHeader plain title="Listen offline"
        subtitle="Your downloaded stations and songs, no internet needed." />

      {recent.length > 0 && (
        <section className="mt-2">
          <SectionHeader title="Continue listening" />
          <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
            {recent.map(h => (
              <button key={h.id} onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })}
                className="flex w-40 shrink-0 flex-col gap-2 rounded-card border border-border/60 bg-card p-2.5 text-left transition hover:border-brand/40">
                <div className="relative flex aspect-square items-center justify-center overflow-hidden rounded-control bg-gradient-to-br from-brand/30 to-brand/10">
                  <Radio className="absolute size-7 text-brand/60" />
                  <img src={artUrlForRef(h.videoId) ?? undefined} alt="" className="relative size-full object-cover" loading="lazy"
                    onError={e => { e.currentTarget.style.visibility = 'hidden' }} />
                </div>
                <div><p className="truncate text-xs font-semibold">{h.title}</p>{h.artist && <p className="truncate text-[11px] text-muted-foreground">{h.artist}</p>}</div>
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <SectionHeader title="Your offline stations" to="/music/stations" />
        {stations.length > 0 ? <StationGrid stations={stations} /> : (
          <div className="mt-6 flex flex-col items-center gap-2 text-center text-sm text-muted-foreground">
            <Download className="size-8 opacity-40" />
            <p>No offline stations yet. Open a station and hit <span className="font-medium text-foreground">Save offline</span> to play it without internet.</p>
          </div>
        )}
      </section>
    </PageContainer>
  )
}

// A personalized shelf: horizontal song tiles + a Play-all that queues the whole rail
// (no DJ interruption for a personal mix - playPlaylist handles that). The interest
// engine's Suggested rail (tracks carry a `ref`) additionally gets a "Not interested" X
// per tile: optimistic hide + Undo toast, excluded server-side from then on.
function MadeForYouRail({ rail }: { rail: Rail }) {
  const radio = useRadio()
  const { hidden, dismiss } = useSuggestionDismiss('music')
  const tracks = rail.tracks.filter(t => !t.ref || !hidden.has(t.ref))
  const playAll = () => radio.playPlaylist(
    tracks.map(t => ({ videoId: t.videoId, title: t.title, author: t.artist || null, thumbnail: '' })),
    0, { name: rail.title },
  )
  if (!tracks.length) return null
  return (
    <section className="mt-6">
      <SectionHeader title={rail.title} count={tracks.length}
        action={
          <Button variant="secondary" size="sm" onClick={playAll}>
            <Play className="size-4 fill-current" /> Play
          </Button>
        } />
      <p className="-mt-1 mb-2 text-xs text-muted-foreground">{rail.subtitle}</p>
      <div className="flex gap-4 overflow-x-auto pb-3 pt-1 no-scrollbar">
        {tracks.slice(0, 16).map(t => {
          const tile = (
            <SongTile trackRef={t.videoId} title={t.title} artist={t.artist} size="w-40"
              onClick={() => radio.playTrack({ videoId: t.videoId, title: t.title, author: t.artist })} />
          )
          return t.ref ? (
            <DismissableCard key={t.videoId} onDismiss={() => dismiss({ ref: t.ref!, creatorName: t.artist, title: t.title })}>
              {tile}
            </DismissableCard>
          ) : (
            <div key={t.videoId}>{tile}</div>
          )
        })}
      </div>
    </section>
  )
}

// A "Mixes For You" card: first-track album art with the mix name overlaid, playable in
// one tap. Dismissable like every suggestion card (ref `mix:<key>` rides the same
// interest-dismiss machinery, so "Not interested" sticks server-side).
function MixCard({ mix, onPlay }: { mix: MixForYou; onPlay: () => void }) {
  const lead = mix.tracks[0]
  return (
    <button onClick={onPlay} className="group w-40 shrink-0 text-left">
      <div className="relative overflow-hidden rounded-card shadow-md transition duration-200 group-hover:scale-[1.03] group-hover:shadow-xl">
        {lead ? (
          <SongTileArt trackRef={lead.videoId} title={lead.title} artist={lead.artist} />
        ) : (
          <div className="aspect-square w-full bg-gradient-to-br from-brand/40 to-brand/10" />
        )}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-black/85 via-black/35 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-2.5">
          <p className="truncate text-[13px] font-semibold text-white">{mix.name}</p>
          <p className="truncate text-[11px] text-white/60">{mix.subtitle ?? `${mix.tracks.length} songs`}</p>
        </div>
      </div>
    </button>
  )
}

// Thin art wrapper so MixCard can reuse the SongArt fallback chain without SongTile's text.
function SongTileArt({ trackRef, title, artist }: { trackRef: string; title: string; artist: string | null }) {
  const art = useSongArt(trackRef, title, artist)
  return art
    ? <img src={art} alt="" className="aspect-square w-full object-cover" loading="lazy" />
    : <div className="flex aspect-square w-full items-center justify-center bg-gradient-to-br from-brand/40 to-brand/10"><Radio className="size-8 text-white/50" /></div>
}

function MixesForYouRail() {
  const radio = useRadio()
  const { hidden, dismiss } = useSuggestionDismiss('music')
  const { data } = useQuery({ queryKey: ['music-mixes'], queryFn: getMixes, staleTime: 30 * 60 * 1000 })
  const mixes = (data?.mixes ?? []).filter(m => !hidden.has(m.ref))
  if (!mixes.length) return null
  const play = (m: MixForYou) => {
    radio.playPlaylist(
      m.tracks.map(t => ({ videoId: t.videoId, title: t.title, author: t.artist || null, thumbnail: '' })),
      0, { name: m.name },
    )
  }
  return (
    <section className="mt-6">
      <SectionHeader title="Mixes for you" count={mixes.length} />
      <p className="-mt-1 mb-2 text-xs text-muted-foreground">Your recent listening, clustered by sound and refreshed daily</p>
      <div className="flex gap-4 overflow-x-auto pb-3 pt-1 no-scrollbar">
        {mixes.map(m => (
          <DismissableCard key={m.key} onDismiss={() => dismiss({ ref: m.ref, title: m.name })}>
            <MixCard mix={m} onPlay={() => play(m)} />
          </DismissableCard>
        ))}
      </div>
    </section>
  )
}

export function MusicHomePage() {
  const radio = useRadio()
  const [editorOpen, setEditorOpen] = useState(false)
  const offline = useMusicModeOptional() === 'offline'
  const { data: buckets } = useQuery({ queryKey: ['music-stations'], queryFn: listStations, enabled: !offline })
  const { data: hist } = useQuery({ queryKey: ['music-history'], queryFn: () => getHistory(12), enabled: !offline })
  const { data: railsData } = useQuery({ queryKey: ['music-rails'], queryFn: getRails, enabled: !offline, staleTime: 30 * 60 * 1000 })

  const recent = hist?.history ?? []
  const rails = railsData?.rails ?? []

  if (offline) return <OfflineHome />

  return (
    <PageContainer width="wide" className="pb-10 pt-6">
      {/* Family audio: friendly full-state card when the profile's audio gate is closed. */}
      <FamilyAudioBlockedCard className="mb-6" />

      {/* Family Jam: start one, or join the household's live shared queue. */}
      <div className="mb-6 empty:mb-0">
        <JamBanner />
      </div>

      {/* No page title: the rail states where we are and the billboard is the focal point. */}
      <StationBillboard stations={buckets?.builtin ?? []} />

      {/* Pitch station-building right under the hero (same placement as Podcasts); the X hides it for good. */}
      <div className="mb-6">
        <PitchBanner
          prefKey="music.createStationBannerDismissed"
          icon={Radio}
          gradient={getAppByPath('/music')?.gradient}
          title="Make your own station"
          description="Describe a vibe, an era, or a mix of artists and your companion builds an endless AI radio station around it, complete with a DJ that learns your taste."
          action={
            <Button variant="secondary" onClick={() => setEditorOpen(true)}>
              <Plus className="mr-1.5 size-4" />
              New station
            </Button>
          }
        />
      </div>

      {recent.length > 0 && (
        <section className="mt-2">
          <SectionHeader title="Continue listening" />
          <div className="flex gap-4 overflow-x-auto pb-3 pt-1 no-scrollbar">
            {recent.map(h => (
              <SongTile key={h.id} trackRef={h.videoId} title={h.title} artist={h.artist}
                onClick={() => radio.playTrack({ videoId: h.videoId, title: h.title, author: h.artist })} />
            ))}
          </div>
        </section>
      )}

      <MixesForYouRail />

      {rails.map(rail => <MadeForYouRail key={rail.key} rail={rail} />)}

      <section className="mt-6">
        <SectionHeader title="Featured stations" to="/music/stations" />
        <StationGrid stations={(buckets?.builtin ?? []).slice(0, 8)} />
      </section>

      {(buckets?.shared.length ?? 0) > 0 && (
        <section className="mt-8">
          <SectionHeader title="Shared by your family" to="/music/stations" />
          <StationGrid stations={buckets!.shared} />
        </section>
      )}

      {(buckets?.mine.length ?? 0) > 0 && (
        <section className="mt-8 mb-4">
          <SectionHeader title="Your stations" to="/music/stations" />
          <StationGrid stations={buckets!.mine} />
        </section>
      )}

      <StationEditorDialog open={editorOpen} onOpenChange={setEditorOpen} station={null} />
    </PageContainer>
  )
}
