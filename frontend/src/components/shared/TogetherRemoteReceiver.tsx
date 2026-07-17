import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useRadio } from '@/context/RadioContext'
import { useLiveRadio } from '@/context/LiveRadioContext'
import { usePodcastPlayback } from '@/context/PodcastPlaybackContext'
import { getActiveSource, dispatchTransport } from '@/lib/mediaCoordinator'
import { registerTogetherHandler } from '@/lib/together/commandBus'
import { djStationById, instantStationDj } from '@/lib/music/catalogApi'
import type { TogetherCommand } from '@/lib/together/api'

// Listening Together: executes remote commands aimed at THIS session (someone
// driving this device from their phone's Devices popover, or a voice request routed
// here by the play_music tool's room target).
//
// Every command is fulfilled through the player contexts' PUBLIC APIs only - no
// audio element or engine internals are touched here. Transport verbs go through
// the media coordinator so they land on whichever engine currently owns audio,
// exactly like a device player bar's transport does.
//
// Mounted once in App.tsx inside the player providers; renders nothing.
export function TogetherRemoteReceiver() {
  const radio = useRadio()
  const live = useLiveRadio()
  const pod = usePodcastPlayback()

  // The contexts return a fresh value every second while media plays; read them via
  // a ref so the registration effect can depend on [] and stay registered.
  const ctxRef = useRef({ radio, live, pod })
  ctxRef.current = { radio, live, pod }

  useEffect(() => registerTogetherHandler(async (cmd: TogetherCommand): Promise<boolean> => {
    const { radio: r, live: l, pod: p } = ctxRef.current
    const from = cmd.fromName ? ` from ${cmd.fromName}` : ''

    switch (cmd.kind) {
      case 'toggle':
      case 'play':
      case 'pause':
        if (!getActiveSource()) return false
        dispatchTransport('toggle')
        return true
      case 'next':
        if (!getActiveSource()) return false
        dispatchTransport('next')
        return true
      case 'seek':
        if (!getActiveSource() || typeof cmd.positionSec !== 'number') return false
        dispatchTransport('seek', cmd.positionSec)
        return true
      case 'stop':
        if (!getActiveSource()) return false
        dispatchTransport('stop')
        return true
      case 'volume': {
        // Volume is per-engine (there is no shared bus), so it targets whichever
        // source is actually playing here.
        if (typeof cmd.volume !== 'number') return false
        const v = Math.max(0, Math.min(1, cmd.volume))
        const source = getActiveSource()
        if (source === 'radio') r.setVolume(v)
        else if (source === 'liveRadio') l.setVolume(v)
        else if (source === 'podcast') p.setVolume(v)
        else return false
        return true
      }
      case 'play_station': {
        if (cmd.stationId) {
          const dj = await djStationById(cmd.stationId).catch(() => null)
          if (!dj) return false
          r.start(dj)
        } else if (cmd.seed) {
          const type = cmd.seedType === 'artist' ? 'artist' : cmd.seedType === 'song' ? 'song' : 'genre'
          r.start(instantStationDj({ type, value: cmd.seed }), { silentIntro: true })
        } else return false
        toast.info(`Now playing here${from}`, { description: cmd.seed ?? 'Station' })
        return true
      }
      case 'play_video': {
        if (!cmd.videoId || !cmd.title) return false
        // A single track handed to this device plays in the music engine (which
        // continues into a matching mix), not the video mini-player: the whole
        // point of a room target is audio in that room.
        r.playTrack({
          videoId: cmd.videoId,
          title: cmd.title,
          author: cmd.artist ?? null,
          thumbnail: cmd.thumbnail ?? '',
        })
        toast.info(`Now playing here${from}`, { description: cmd.title })
        return true
      }
      case 'play_episode': {
        if (!cmd.episodeId || !cmd.title) return false
        p.play({
          episodeId: cmd.episodeId,
          showId: cmd.showId,
          showName: cmd.showName ?? 'Podcast',
          title: cmd.title,
          coverUrl: cmd.coverUrl,
        })
        toast.info(`Now playing here${from}`, { description: cmd.title })
        return true
      }
      case 'queue_episode': {
        if (!cmd.episodeId || !cmd.title) return false
        p.enqueue({
          episodeId: cmd.episodeId,
          showId: cmd.showId,
          showName: cmd.showName ?? 'Podcast',
          title: cmd.title,
          coverUrl: cmd.coverUrl,
        })
        toast.info(`Added to Up Next${from}`, { description: cmd.title })
        return true
      }
      case 'queue_track':
        // The radio engine builds its own queue from the station; there is no public
        // append-to-queue call, so a remote "add this track" is served by the Family
        // Jam shared queue instead (see JamBanner / useJam).
        return false
      default:
        return false
    }
  }), [])

  return null
}
