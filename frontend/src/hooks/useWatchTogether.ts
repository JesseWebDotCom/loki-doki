import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

// Watch Together (SyncPlay) client. A watch page hands this hook an imperative view of
// its player (play/pause/seek/isPlaying/position) and gets back session controls. While
// joined, remote state events drive the player, and a 1s poll detects LOCAL actions
// (any control path: bar, keyboard, click-toggle) and rebroadcasts them, so no player
// event handler ever needs wiring. Echo control: right after applying a remote event the
// poll is suppressed briefly, so an applied seek is not re-reported as a local one.

export interface WtPlayerControls {
  play: () => void
  pause: () => void
  seek: (sec: number) => void
  isPlaying: () => boolean
  position: () => number
}

export interface WtMemberInfo {
  id: string
  userId: string
  name: string
}

interface WtMediaRef {
  source: string
  videoId: string
  title: string
  thumbnailUrl?: string | null
}

type WtEvent =
  | { type: 'hello'; memberId: string; media: WtMediaRef; playing: boolean; positionSec: number; at: number; members: WtMemberInfo[] }
  | { type: 'members'; members: WtMemberInfo[] }
  | { type: 'state'; playing: boolean; positionSec: number; at: number; by: string }
  | { type: 'media'; media: WtMediaRef; by: string }
  | { type: 'ended' }

/** Drift beyond this (seconds) counts as a seek, local or remote. */
const DRIFT_SEC = 2.5
/** How long after applying a remote event the local poll stays quiet. */
const ECHO_MS = 1500
const POLL_MS = 1000

export function useWatchTogether(opts: {
  media: WtMediaRef
  controls: React.RefObject<WtPlayerControls | null>
  /** Session id from the ?wt= deep link: auto-joins once on mount. */
  autoJoinId?: string | null
}) {
  const { media, controls } = opts
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [members, setMembers] = useState<WtMemberInfo[]>([])

  const esRef = useRef<EventSource | null>(null)
  const memberIdRef = useRef<string | null>(null)
  const suppressUntil = useRef(0)
  const last = useRef<{ playing: boolean; pos: number; at: number } | null>(null)
  const mediaRef = useRef(media)
  mediaRef.current = media

  const leave = useCallback(() => {
    esRef.current?.close()
    esRef.current = null
    memberIdRef.current = null
    last.current = null
    setSessionId(null)
    setMembers([])
  }, [])

  const applyRemote = useCallback((evt: Extract<WtEvent, { type: 'hello' | 'state' }>) => {
    const c = controls.current
    if (!c) return
    suppressUntil.current = Date.now() + ECHO_MS
    const expected = evt.positionSec + (evt.playing ? (Date.now() - evt.at) / 1000 : 0)
    if (Math.abs(c.position() - expected) > DRIFT_SEC * 0.7) c.seek(expected)
    if (evt.playing && !c.isPlaying()) c.play()
    else if (!evt.playing && c.isPlaying()) c.pause()
    last.current = { playing: evt.playing, pos: expected, at: Date.now() }
  }, [controls])

  const join = useCallback((id: string) => {
    if (esRef.current) leave()
    const es = new EventSource(`/api/watch-together/sessions/${encodeURIComponent(id)}/stream`, { withCredentials: true })
    esRef.current = es
    setSessionId(id)
    es.addEventListener('wt', (e: MessageEvent) => {
      let evt: WtEvent
      try { evt = JSON.parse(e.data as string) as WtEvent } catch { return }
      switch (evt.type) {
        case 'hello': {
          memberIdRef.current = evt.memberId
          setMembers(evt.members)
          const m = mediaRef.current
          if (evt.media.source !== m.source || evt.media.videoId !== m.videoId) {
            // The room is on a different video: follow it. The next page auto-joins via ?wt.
            es.close(); esRef.current = null
            window.location.assign(`/videos/${evt.media.source}/watch/${encodeURIComponent(evt.media.videoId)}?wt=${id}`)
            return
          }
          applyRemote(evt)
          break
        }
        case 'members':
          setMembers(evt.members)
          break
        case 'state':
          applyRemote(evt)
          break
        case 'media':
          es.close(); esRef.current = null
          window.location.assign(`/videos/${evt.media.source}/watch/${encodeURIComponent(evt.media.videoId)}?wt=${id}`)
          break
        case 'ended':
          toast.info('Watch together ended')
          leave()
          break
      }
    })
    es.onerror = () => { /* EventSource auto-reconnects; a dead session answers with ended */ }
  }, [applyRemote, leave])

  // Start a session for the current video and invite the household.
  const start = useCallback(async () => {
    try {
      const r = await fetch('/api/watch-together/sessions', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ media: mediaRef.current }),
      })
      if (!r.ok) throw new Error('could not start')
      const { session } = await r.json() as { session: { id: string } }
      join(session.id)
      const inv = await fetch(`/api/watch-together/sessions/${session.id}/invite`, { method: 'POST', credentials: 'include' })
        .then((x) => x.json() as Promise<{ notified: number }>).catch(() => ({ notified: 0 }))
      toast.success(inv.notified > 0
        ? `Watching together: invited ${inv.notified} ${inv.notified === 1 ? 'person' : 'people'}`
        : 'Watching together: nobody else is online right now')
    } catch {
      toast.error('Could not start watch together')
    }
  }, [join])

  const invite = useCallback(async () => {
    if (!sessionId) return
    const inv = await fetch(`/api/watch-together/sessions/${sessionId}/invite`, { method: 'POST', credentials: 'include' })
      .then((x) => x.json() as Promise<{ notified: number }>).catch(() => ({ notified: 0 }))
    toast.success(inv.notified > 0 ? `Invited ${inv.notified} ${inv.notified === 1 ? 'person' : 'people'}` : 'Nobody else is online right now')
  }, [sessionId])

  const end = useCallback(async () => {
    if (!sessionId) return
    await fetch(`/api/watch-together/sessions/${sessionId}/end`, { method: 'POST', credentials: 'include' }).catch(() => {})
    leave()
  }, [sessionId, leave])

  // Auto-join from a ?wt= deep link, once.
  const autoJoined = useRef(false)
  useEffect(() => {
    if (!opts.autoJoinId || autoJoined.current) return
    autoJoined.current = true
    join(opts.autoJoinId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.autoJoinId])

  // Local-action detector: 1s poll comparing the player against its predicted state.
  useEffect(() => {
    if (!sessionId) return
    const iv = setInterval(() => {
      const c = controls.current
      const memberId = memberIdRef.current
      if (!c || !memberId) return
      const now = Date.now()
      const playing = c.isPlaying()
      const pos = c.position()
      const prev = last.current
      last.current = { playing, pos, at: now }
      if (!prev || now < suppressUntil.current) return
      const predicted = prev.pos + (prev.playing ? (now - prev.at) / 1000 : 0)
      const changed = playing !== prev.playing || Math.abs(pos - predicted) > DRIFT_SEC
      if (!changed) return
      void fetch(`/api/watch-together/sessions/${sessionId}/state`, {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, playing, positionSec: pos }),
      }).catch(() => {})
    }, POLL_MS)
    return () => clearInterval(iv)
  }, [sessionId, controls])

  // Leaving the page leaves the session (the server holds a short reconnect grace).
  useEffect(() => () => { esRef.current?.close() }, [])

  return { sessionId, members, memberCount: members.length, start, join, invite, leave, end }
}
