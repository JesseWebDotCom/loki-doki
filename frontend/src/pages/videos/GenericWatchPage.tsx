import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Check, Download, MessageSquare } from 'lucide-react'
import { PageContainer } from '@/components/shared/PageContainer'
import { SectionHeader } from '@/components/shared/SectionHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/lib/toast'
import {
  getSourceItem, getSourceComments, listSaves, saveVideo, putWatchState, savedFileUrl,
  type HubPlayback, type HubVideoItem, type VideoSource,
} from '@/lib/videos/api'
import { HUB_PATHS } from '@/components/videos/HubVideoCard'
import { useYoutubeModeOptional } from '@/components/videos/VideosLayout'

/** Attach the playback source to a <video>: native src for files/progressive, hls.js
 *  for manifests (Safari also gets hls.js; its native HLS can't send our auth cookies
 *  cross-origin, but same-origin proxy URLs are fine either way; prefer the consistent path). */
function usePlaybackAttach(videoRef: React.RefObject<HTMLVideoElement | null>, playback: HubPlayback | null, localUrl: string | null) {
  useEffect(() => {
    const video = videoRef.current
    if (!video || !playback) return

    if (localUrl) {
      video.src = localUrl
      return
    }
    if (playback.mode === 'hls') {
      let hls: import('hls.js').default | null = null
      let cancelled = false
      // Safari can play HLS natively from a same-origin URL; everything else uses hls.js.
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playback.manifestUrl
      } else {
        void import('hls.js').then(({ default: Hls }) => {
          if (cancelled || !Hls.isSupported()) return
          hls = new Hls({ maxBufferLength: 30 })
          hls.loadSource(playback.manifestUrl)
          hls.attachMedia(video)
        })
      }
      return () => { cancelled = true; hls?.destroy() }
    }
    if (playback.mode === 'stream') {
      video.src = playback.streamUrl
      return
    }
  }, [videoRef, playback, localUrl])
}

export function GenericWatchPage() {
  const { source: sourceParam, id = '' } = useParams<{ source: string; id: string }>()
  const source = (sourceParam ?? '') as VideoSource
  const qc = useQueryClient()
  const videoRef = useRef<HTMLVideoElement>(null)
  const [showComments, setShowComments] = useState(false)

  const { data, isLoading, error } = useQuery({
    queryKey: ['videos-item', source, id],
    queryFn: () => getSourceItem(source, id),
    enabled: !!source && !!id,
  })
  const item: HubVideoItem | undefined = data?.item

  const { data: savesData } = useQuery({ queryKey: ['videos-saves', source], queryFn: () => listSaves(source) })
  const save = savesData?.saves.find((s) => s.videoId === id && s.kind === 'video')
  const localUrl = save?.status === 'ready' ? savedFileUrl(source, id, 'video') : null
  const mode = useYoutubeModeOptional()
  const onlineOnly = mode === 'offline' && !localUrl

  usePlaybackAttach(videoRef, data?.playback ?? null, localUrl)

  // Resume position + periodic watch-state sync (10s cadence + unmount flush).
  const lastSent = useRef(0)
  useEffect(() => {
    const video = videoRef.current
    if (!video || !item) return
    const onTime = () => {
      const now = Date.now()
      if (now - lastSent.current < 10_000) return
      lastSent.current = now
      const completed = video.duration > 0 && video.currentTime / video.duration > 0.9
      void putWatchState(source, id, Math.floor(video.currentTime), completed).catch(() => {})
    }
    video.addEventListener('timeupdate', onTime)
    return () => {
      video.removeEventListener('timeupdate', onTime)
      if (video.currentTime > 5) {
        const completed = video.duration > 0 && video.currentTime / video.duration > 0.9
        void putWatchState(source, id, Math.floor(video.currentTime), completed).catch(() => {})
      }
    }
  }, [source, id, item])

  const saveMutation = useMutation({
    mutationFn: () => saveVideo(source, id, 'video'),
    onSuccess: () => {
      toast.success('Saving for offline')
      void qc.invalidateQueries({ queryKey: ['videos-saves', source] })
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not save'),
  })

  const { data: commentsData, isLoading: commentsLoading } = useQuery({
    queryKey: ['videos-comments', source, id],
    queryFn: () => getSourceComments(source, id),
    enabled: showComments,
  })

  const creatorPath = useMemo(() => {
    if (!item?.creator?.id || !(source in HUB_PATHS)) return null
    return HUB_PATHS[source].creator(item.creator.id)
  }, [item, source])

  if (isLoading) {
    return <PageContainer width="wide" className="flex justify-center py-24"><Spinner /></PageContainer>
  }
  if (error || !item) {
    return (
      <PageContainer width="wide" className="py-12">
        <Card variant="flat" className="p-6 text-sm text-muted-foreground">
          {error instanceof Error ? error.message : 'This video is not available.'}
        </Card>
      </PageContainer>
    )
  }

  const saveState = save?.status
  if (onlineOnly) {
    return (
      <PageContainer width="wide" className="py-12">
        <Card variant="flat" className="p-6 text-sm text-muted-foreground">
          This video is not saved offline. Switch to Online to stream it, or save it offline while online.
        </Card>
      </PageContainer>
    )
  }
  return (
    <PageContainer width="wide" className="py-6">
      <div className={item.vertical ? 'mx-auto max-w-md' : ''}>
        <video
          ref={videoRef}
          controls
          autoPlay
          playsInline
          poster={item.thumbnailUrl ?? undefined}
          className={`w-full rounded-card bg-black ${item.vertical ? 'aspect-[9/16]' : 'aspect-video'}`}
        />
      </div>

      <div className="mt-4 flex flex-col gap-3">
        <p className="text-lg font-semibold leading-snug">{item.title}</p>
        <div className="flex flex-wrap items-center gap-3">
          {creatorPath && item.creator && (
            <Link to={creatorPath} className="text-sm font-medium text-foreground hover:underline">
              {item.creator.name}
            </Link>
          )}
          {item.viewsText && <span className="text-xs text-muted-foreground">{item.viewsText}</span>}
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant={saveState === 'ready' ? 'secondary' : 'outline'}
              className="gap-1.5"
              disabled={saveMutation.isPending || saveState === 'pending' || saveState === 'downloading'}
              onClick={() => saveMutation.mutate()}
            >
              {saveState === 'ready' ? <Check className="size-4" />
                : saveState === 'pending' || saveState === 'downloading' ? <Spinner size="sm" />
                : <Download className="size-4" />}
              {saveState === 'ready' ? 'Saved' : saveState === 'pending' || saveState === 'downloading' ? 'Saving…' : 'Save offline'}
            </Button>
            <Button asChild size="sm" variant="ghost" className="gap-1.5">
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                <ArrowUpRight className="size-4" /> Open on {source === 'reddit' ? 'Reddit' : source}
              </a>
            </Button>
          </div>
        </div>
        {item.description && <p className="max-w-3xl whitespace-pre-wrap text-sm text-muted-foreground">{item.description}</p>}
      </div>

      <div className="mt-8">
        {!showComments ? (
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setShowComments(true)}>
            <MessageSquare className="size-4" /> Show comments
          </Button>
        ) : (
          <section>
            <SectionHeader title="Comments" className="mb-4" />
            {commentsLoading ? <Spinner size="sm" /> : (
              <div className="max-w-3xl space-y-4">
                {(commentsData?.comments ?? []).map((cm, i) => (
                  <div key={i} className="text-sm">
                    <p className="font-medium text-foreground">{cm.author}
                      {cm.likes && <span className="ml-2 text-xs font-normal text-muted-foreground">{cm.likes} points</span>}
                    </p>
                    <p className="mt-0.5 whitespace-pre-wrap text-foreground/90">{cm.text}</p>
                  </div>
                ))}
                {(commentsData?.comments ?? []).length === 0 && (
                  <p className="text-sm text-muted-foreground">No comments.</p>
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </PageContainer>
  )
}
