import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, ArrowUpRight, Clock, Download, Film, Globe, Music2, Play, Scissors, Sparkles, X,
} from 'lucide-react'

import { PageShell } from '@/components/shared/PageShell'
import { PageContainer } from '@/components/shared/PageContainer'
import { PageHeader } from '@/components/shared/PageHeader'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { EmptyAppState } from '@/components/shared/EmptyAppState'
import { DownloadProgress, type DownloadStatus } from '@/components/shared/DownloadProgress'
import { ClipPlayer } from '@/components/clipper/ClipPlayer'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import { usePublishUIContext } from '@/context/UIContextProvider'
import { cn } from '@/lib/cn'
import { proxyImg } from '@/lib/img'
import { toast } from '@/lib/toast'
import { fmtTime } from '@/lib/podcast/format'
import {
  checkDirectPlay, clipFileUrl, clipStreamUrl, listClips, resolveClipUrl, saveClip,
  type Clip, type ClipKind, type ClipPreview,
} from '@/lib/clipper/api'
import { getClipSuggestions, resolveVideoUrl, type ResolveResult, type VideoSource } from '@/lib/videos/api'

/** Deep-link targets inside the hub for provider-claimed URLs. */
const SOURCE_PATHS: Record<VideoSource, { watch: (id: string) => string; creator: (id: string) => string }> = {
  youtube: { watch: (id) => `/videos/youtube/watch/${encodeURIComponent(id)}`, creator: (id) => `/videos/youtube/channel/${encodeURIComponent(id)}` },
  reddit: { watch: (id) => `/videos/reddit/watch/${encodeURIComponent(id)}`, creator: (id) => `/videos/reddit/r/${encodeURIComponent(id)}` },
  tiktok: { watch: (id) => `/videos/tiktok/watch/${encodeURIComponent(id)}`, creator: (id) => `/videos/tiktok/creator/${encodeURIComponent(id)}` },
  vimeo: { watch: (id) => `/videos/vimeo/watch/${encodeURIComponent(id)}`, creator: (id) => `/videos/vimeo/channel/${encodeURIComponent(id)}` },
  link: { watch: (id) => `/videos/link/watch/${encodeURIComponent(id)}`, creator: (id) => `/videos/link/watch/${encodeURIComponent(id)}` },
}

type ProviderHit = Extract<ResolveResult, { kind: 'provider' }>

/** AI-suggested clippable moments for a resolved video: each row opens the watch page at
 *  that second, where the clip can be trimmed. Mirrors YouTube's 2026 creator feature. */
function ClipSuggestions({ source, videoId }: { source: VideoSource; videoId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['clip-suggestions', source, videoId],
    queryFn: () => getClipSuggestions(source, videoId),
    staleTime: 60 * 60_000,
  })
  const suggestions = data?.suggestions ?? []

  if (isLoading) {
    return (
      <Card className="mt-4 flex items-center gap-2 p-4 text-sm text-muted-foreground">
        <Spinner className="size-4" /> Reading the transcript for clippable moments…
      </Card>
    )
  }
  if (suggestions.length === 0) {
    return (
      <Card className="mt-4 p-4 text-sm text-muted-foreground">
        No clip suggestions for this one (it may have no captions to read).
      </Card>
    )
  }
  return (
    <Card className="mt-4 p-4">
      <p className="mb-3 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        <Sparkles className="size-3.5" /> Moments worth clipping
      </p>
      <div className="space-y-1.5">
        {suggestions.map((s, i) => (
          <Link key={i} to={`${SOURCE_PATHS[source].watch(videoId)}?t=${s.startSec}`}
            className="flex items-start gap-3 rounded-control p-2 transition-colors hover:bg-accent">
            <span className="shrink-0 rounded bg-foreground/10 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-brand">
              {fmtTime(s.startSec)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{s.title}</span>
              <span className="block truncate text-xs text-muted-foreground">{s.why}</span>
            </span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{s.endSec - s.startSec}s</span>
          </Link>
        ))}
      </div>
    </Card>
  )
}

const CLIPS_QUERY_KEY = ['clipper-clips']

function looksLikeUrl(value: string): boolean {
  try {
    const u = new URL(value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Maps a clip row's persisted status onto DownloadProgress's status vocabulary. */
function toDownloadStatus(status: Clip['status']): DownloadStatus {
  switch (status) {
    case 'pending': return 'pending'
    case 'downloading': return 'downloading'
    case 'ready': return 'completed'
    case 'failed': return 'error'
  }
}

export function ClipperPage() {
  const qc = useQueryClient()

  usePublishUIContext({
    label: 'Clipper',
    description: 'User is pasting video links (TikTok, Instagram, X, Reddit, Vimeo, etc.) to watch or save offline.',
  })

  const [url, setUrl] = useState('')
  const [urlError, setUrlError] = useState<string | null>(null)
  const [resolving, setResolving] = useState(false)
  const [resolveError, setResolveError] = useState<string | null>(null)
  const [providerHit, setProviderHit] = useState<ProviderHit | null>(null)
  // AI clippable-moment suggestions for a resolved provider video (opt in per resolve, so
  // pasting a link never spends a model pass you didn't ask for).
  const [suggestFor, setSuggestFor] = useState<{ source: VideoSource; videoId: string } | null>(null)
  const [preview, setPreview] = useState<ClipPreview | null>(null)
  const [resolvedUrl, setResolvedUrl] = useState<string | null>(null)
  const [canPlay, setCanPlay] = useState<boolean | null>(null)
  const [checkingPlay, setCheckingPlay] = useState(false)
  const [playerActive, setPlayerActive] = useState(false)
  const [savingClipId, setSavingClipId] = useState<string | null>(null)
  const [savingKind, setSavingKind] = useState<ClipKind | null>(null)
  const [playingClipId, setPlayingClipId] = useState<string | null>(null)

  const clipsQuery = useQuery({
    queryKey: CLIPS_QUERY_KEY,
    queryFn: listClips,
    // Poll while any save is in flight, same pattern as podcast episode downloads.
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === 'pending' || c.status === 'downloading') ? 3000 : false),
  })
  const clips = clipsQuery.data ?? []
  const savingClip = savingClipId ? clips.find((c) => c.id === savingClipId) ?? null : null

  const saveMutation = useMutation({
    mutationFn: saveClip,
    onSuccess: ({ id }, input) => {
      setSavingClipId(id)
      setSavingKind(input.kind)
      void qc.invalidateQueries({ queryKey: CLIPS_QUERY_KEY })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save that clip'),
  })

  async function handleResolve(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = url.trim()
    if (!looksLikeUrl(trimmed)) {
      setUrlError("That doesn't look like a valid URL.")
      return
    }
    setUrlError(null)
    setResolveError(null)
    setResolving(true)
    setProviderHit(null)
    setPreview(null)
    setResolvedUrl(null)
    setCanPlay(null)
    setPlayerActive(false)
    try {
      // Provider-aware resolve: URLs a hub source claims (YouTube video/channel, and
      // Reddit/TikTok/Vimeo as they land) get a rich card with an in-app Open link;
      // everything else falls through to the classic yt-dlp clip preview.
      const result = await resolveVideoUrl(trimmed)
      if (result.kind === 'provider') {
        setProviderHit(result)
        setResolvedUrl(trimmed)
      } else {
        setPreview({
          title: result.title,
          thumbnailUrl: result.thumbnailUrl,
          durationSeconds: result.durationSeconds,
          extractor: result.extractor,
          formats: result.formats,
        })
        setResolvedUrl(trimmed)
        setCheckingPlay(true)
        checkDirectPlay(trimmed)
          .then(setCanPlay)
          .finally(() => setCheckingPlay(false))
      }
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : 'Could not resolve that link')
    } finally {
      setResolving(false)
    }
  }

  /** "Clip anyway": treat a provider-claimed URL as a plain clip (classic flow). */
  async function handleClipAnyway() {
    if (!resolvedUrl) return
    setResolving(true)
    setProviderHit(null)
    try {
      const meta = await resolveClipUrl(resolvedUrl)
      setPreview(meta)
      setCheckingPlay(true)
      checkDirectPlay(resolvedUrl)
        .then(setCanPlay)
        .finally(() => setCheckingPlay(false))
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : 'Could not resolve that link')
    } finally {
      setResolving(false)
    }
  }

  function handleSave(kind: ClipKind) {
    if (!preview || !resolvedUrl) return
    saveMutation.mutate({
      url: resolvedUrl,
      kind,
      title: preview.title,
      thumbnailUrl: preview.thumbnailUrl,
      durationSeconds: preview.durationSeconds,
      extractor: preview.extractor,
    })
  }

  function dismissSaveProgress() {
    setSavingClipId(null)
    setSavingKind(null)
  }

  const playingClip = playingClipId ? clips.find((c) => c.id === playingClipId) ?? null : null

  return (
    <PageShell>
      <PageContainer width="wide" className="pb-12">
        <PageHeader subtitle="Paste a link from TikTok, Instagram, X, Reddit, Vimeo, or any other supported site, then watch it now or save it offline." />

        {/* Paste-URL form */}
        <form onSubmit={(e) => void handleResolve(e)} className="flex flex-col gap-2 sm:flex-row">
          <div className="flex-1">
            <Input
              value={url}
              onChange={(e) => { setUrl(e.target.value); if (urlError) setUrlError(null) }}
              placeholder="Paste a video URL…"
              className="h-11 px-4 text-sm"
              inputMode="url"
              autoComplete="off"
            />
            {urlError && <p className="mt-1.5 text-xs text-destructive">{urlError}</p>}
          </div>
          <Button type="submit" size="lg" disabled={resolving || !url.trim()} className="gap-1.5 sm:h-11">
            {resolving ? <Spinner size="sm" className="text-primary-foreground" /> : <Scissors className="size-4" />}
            {resolving ? 'Resolving…' : 'Clip it'}
          </Button>
        </form>

        {/* Resolve error */}
        {resolveError && (
          <Card variant="flat" className="mt-4 flex items-start gap-2.5 p-4">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="text-sm text-foreground/90">{resolveError}</p>
          </Card>
        )}

        {/* Provider hit: the URL belongs to a hub source, so offer the rich in-app view. */}
        {providerHit && (
          <Card className="mt-4 overflow-hidden">
            <div className="flex flex-col gap-4 p-4 sm:flex-row">
              <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-control bg-muted sm:w-64">
                {(providerHit.match === 'video' ? providerHit.item.thumbnailUrl : providerHit.creator.avatarUrl) ? (
                  <img
                    src={proxyImg((providerHit.match === 'video' ? providerHit.item.thumbnailUrl : providerHit.creator.avatarUrl)!)}
                    alt="" className="size-full object-cover"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center">
                    <Film className="size-8 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="truncate text-base font-semibold">
                  {providerHit.match === 'video' ? (providerHit.item.title || 'Untitled video') : providerHit.creator.name}
                </p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1 capitalize"><Globe className="size-3" /> {providerHit.source}</span>
                  {providerHit.match === 'video' && providerHit.item.creator?.name && <span>{providerHit.item.creator.name}</span>}
                  {providerHit.match === 'video' && providerHit.item.durationSec != null && (
                    <span className="flex items-center gap-1"><Clock className="size-3" /> {fmtTime(providerHit.item.durationSec)}</span>
                  )}
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-2">
                  <Button asChild size="sm" className="gap-1.5">
                    <Link to={providerHit.match === 'video'
                      ? SOURCE_PATHS[providerHit.source].watch(providerHit.item.id)
                      : SOURCE_PATHS[providerHit.source].creator(providerHit.creator.id)}>
                      <ArrowUpRight className="size-4" />
                      {providerHit.match === 'video' ? 'Open to watch or save' : 'Open channel'}
                    </Link>
                  </Button>
                  {providerHit.match === 'video' && (
                    <Button size="sm" variant="outline" className="gap-1.5" disabled={resolving} onClick={() => void handleClipAnyway()}>
                      <Scissors className="size-4" /> Clip anyway
                    </Button>
                  )}
                  {providerHit.match === 'video' && (
                    <Button size="sm" variant="ghost" className="gap-1.5 text-muted-foreground hover:text-foreground"
                      onClick={() => setSuggestFor(providerHit.match === 'video' ? { source: providerHit.source, videoId: providerHit.item.id } : null)}>
                      <Sparkles className="size-4" /> Suggest moments
                    </Button>
                  )}
                </div>
              </div>
            </div>
          </Card>
        )}

        {suggestFor && <ClipSuggestions source={suggestFor.source} videoId={suggestFor.videoId} />}

        {/* Preview card */}
        {preview && resolvedUrl && (
          <Card className="mt-4 overflow-hidden">
            <div className="flex flex-col gap-4 p-4 sm:flex-row">
              <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-control bg-muted sm:w-64">
                {preview.thumbnailUrl ? (
                  <img src={proxyImg(preview.thumbnailUrl)} alt="" className="size-full object-cover" />
                ) : (
                  <div className="flex size-full items-center justify-center">
                    <Film className="size-8 text-muted-foreground" />
                  </div>
                )}
              </div>
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <p className="truncate text-base font-semibold">{preview.title || 'Untitled clip'}</p>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  {preview.extractor && (
                    <span className="flex items-center gap-1"><Globe className="size-3" /> {preview.extractor}</span>
                  )}
                  {preview.durationSeconds != null && (
                    <span className="flex items-center gap-1"><Clock className="size-3" /> {fmtTime(preview.durationSeconds)}</span>
                  )}
                </div>

                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {playerActive ? null : canPlay === false ? (
                    <p className="text-xs text-muted-foreground">Direct play isn't available for this link, save it to watch.</p>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={checkingPlay}
                      onClick={() => setPlayerActive(true)}
                      className="gap-1.5"
                    >
                      {checkingPlay ? <Spinner size="sm" /> : <Play className="size-3.5" />}
                      Play
                    </Button>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => handleSave('video')}
                    disabled={saveMutation.isPending}
                    className="gap-1.5"
                  >
                    <Download className="size-3.5" />
                    Save video
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => handleSave('audio')}
                    disabled={saveMutation.isPending}
                    className="gap-1.5"
                  >
                    <Music2 className="size-3.5" />
                    Save audio only
                  </Button>
                </div>

                {playerActive && (
                  <ClipPlayer kind="video" src={clipStreamUrl(resolvedUrl)} title={preview.title} className="mt-2" autoPlay />
                )}
              </div>
            </div>

            {savingClip && (
              <div className="border-t border-border p-4">
                <DownloadProgress
                  label={savingClip.title || 'Clip'}
                  description={savingKind === 'audio' ? 'Saving audio' : 'Saving video'}
                  status={toDownloadStatus(savingClip.status)}
                  error={savingClip.error ?? undefined}
                  onCancel={savingClip.status === 'ready' || savingClip.status === 'failed' ? dismissSaveProgress : undefined}
                  onRetry={savingClip.status === 'failed' ? () => handleSave(savingKind ?? 'video') : undefined}
                />
              </div>
            )}
          </Card>
        )}

        {/* Saved clips */}
        <SectionHeader title="Saved clips" count={clips.length} className="mt-10 mb-4" />

        {clipsQuery.isLoading ? (
          <div className="flex justify-center py-12"><Spinner /></div>
        ) : clips.length === 0 ? (
          <EmptyAppState
            icon={Scissors}
            // design-ok(hex-in-tsx): registry identity fallback data, matches appCategories's clipper gradient
            gradient="linear-gradient(135deg,#0c4a6e,#0ea5e9)"
            title="Clip anything"
            tagline="Paste a link above from almost any site, watch it instantly or save a personal offline copy."
            features={[
              { icon: Globe, title: 'Any site', desc: 'TikTok, Instagram, X, Reddit, Vimeo, and more.' },
              { icon: Play, title: 'Watch instantly', desc: "Direct play when the source supports it, no download needed." },
              { icon: Download, title: 'Save offline', desc: 'Keep a private copy as video or audio-only.' },
            ]}
          />
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {clips.map((clip) => (
              <ClipCard key={clip.id} clip={clip} onPlay={() => setPlayingClipId(clip.id)} />
            ))}
          </div>
        )}

        {playingClip && (
          <div className="mt-6">
            <div className="mb-2 flex items-center justify-between">
              <p className="truncate text-sm font-semibold">{playingClip.title || 'Clip'}</p>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => setPlayingClipId(null)} aria-label="Close player">
                <X className="size-4" />
              </Button>
            </div>
            <ClipPlayer
              kind={playingClip.kind}
              src={clipFileUrl(playingClip.id)}
              poster={playingClip.thumbnailUrl}
              title={playingClip.title}
              autoPlay
            />
          </div>
        )}
      </PageContainer>
    </PageShell>
  )
}

function ClipCard({ clip, onPlay }: { clip: Clip; onPlay: () => void }) {
  const ready = clip.status === 'ready'
  return (
    <Card
      variant={ready ? 'interactive' : 'surface'}
      className="flex flex-col"
      onClick={ready ? onPlay : undefined}
    >
      <div className="relative aspect-video w-full overflow-hidden bg-muted">
        {clip.thumbnailUrl ? (
          <img src={proxyImg(clip.thumbnailUrl)} alt="" className="size-full object-cover" />
        ) : (
          <div className="flex size-full items-center justify-center">
            {clip.kind === 'audio' ? <Music2 className="size-6 text-muted-foreground" /> : <Film className="size-6 text-muted-foreground" />}
          </div>
        )}
        {ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all hover:bg-black/30 hover:opacity-100">
            <Play className="size-8 fill-white text-white" />
          </div>
        )}
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40">
            {clip.status === 'failed' ? (
              <AlertCircle className="size-6 text-destructive" />
            ) : (
              <Spinner size="lg" className="text-white" />
            )}
          </div>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1 p-3">
        <p className="line-clamp-2 text-xs font-semibold leading-snug">{clip.title || 'Untitled clip'}</p>
        <div className={cn('flex items-center gap-1.5 text-[11px] text-muted-foreground', !clip.extractor && !clip.durationSeconds && 'invisible')}>
          {clip.extractor && <span className="truncate">{clip.extractor}</span>}
          {clip.durationSeconds != null && <span>· {fmtTime(clip.durationSeconds)}</span>}
        </div>
        {clip.status === 'failed' && <p className="mt-0.5 truncate text-[11px] text-destructive">{clip.error ?? 'Save failed'}</p>}
        {(clip.status === 'pending' || clip.status === 'downloading') && (
          <p className="mt-0.5 text-[11px] text-brand">Saving…</p>
        )}
      </div>
    </Card>
  )
}
