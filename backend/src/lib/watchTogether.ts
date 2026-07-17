// Watch Together (SyncPlay): in-memory household co-watching sessions. One session is
// one video plus a set of member SSE streams; a play/pause/seek from any member
// rebroadcasts to the rest, and changing the video moves the whole room. Sessions are
// ephemeral by design (no DB), matching drop/presence.ts: after a server restart the
// household simply starts a new one.

import { randomUUID } from 'node:crypto'
import { logger } from '@/lib/logger'

export interface WtMedia {
  /** 'youtube' or a hub VideoSource (tiktok/vimeo/reddit/link). */
  source: string
  videoId: string
  title: string
  thumbnailUrl?: string | null
}

export interface WtMemberInfo {
  id: string
  userId: string
  name: string
}

export type WtEvent =
  | { type: 'hello'; memberId: string; media: WtMedia; playing: boolean; positionSec: number; at: number; members: WtMemberInfo[] }
  | { type: 'members'; members: WtMemberInfo[] }
  | { type: 'state'; playing: boolean; positionSec: number; at: number; by: string }
  | { type: 'media'; media: WtMedia; by: string }
  | { type: 'ended' }

interface WtMember extends WtMemberInfo {
  send: (evt: WtEvent) => void
}

interface WtSession {
  id: string
  hostUserId: string
  hostName: string
  media: WtMedia
  playing: boolean
  positionSec: number
  /** Date.now() when positionSec was sampled; clients extrapolate while playing. */
  stateAt: number
  members: Map<string, WtMember>
  createdAt: number
  /** Pending GC timer: armed while the session has no members (fresh or abandoned). */
  gcTimer: ReturnType<typeof setTimeout> | null
}

export interface WtSessionInfo {
  id: string
  hostName: string
  media: WtMedia
  playing: boolean
  memberCount: number
  memberNames: string[]
  createdAt: number
}

const sessions = new Map<string, WtSession>()

// A fresh session that nobody ever joined dies quickly; an emptied one gets a short
// grace so an SSE reconnect (or the host navigating between videos) doesn't kill it.
const UNJOINED_TTL_MS = 2 * 60_000
const EMPTY_GRACE_MS = 30_000

function armGc(session: WtSession, ms: number): void {
  if (session.gcTimer) clearTimeout(session.gcTimer)
  session.gcTimer = setTimeout(() => {
    if (session.members.size === 0) {
      sessions.delete(session.id)
      logger.info(`[watch-together] session ${session.id} reaped (empty)`)
    }
  }, ms)
}

function toInfo(s: WtSession): WtSessionInfo {
  return {
    id: s.id, hostName: s.hostName, media: s.media, playing: s.playing,
    memberCount: s.members.size,
    memberNames: Array.from(s.members.values()).map((m) => m.name),
    createdAt: s.createdAt,
  }
}

function broadcast(s: WtSession, evt: WtEvent, exceptMemberId?: string): void {
  for (const m of s.members.values()) {
    if (m.id === exceptMemberId) continue
    try { m.send(evt) } catch { /* dead stream; its stream loop unregisters */ }
  }
}

export function createSession(hostUserId: string, hostName: string, media: WtMedia): WtSessionInfo {
  const s: WtSession = {
    id: randomUUID().slice(0, 8),
    hostUserId, hostName, media,
    playing: false, positionSec: 0, stateAt: Date.now(),
    members: new Map(), createdAt: Date.now(), gcTimer: null,
  }
  sessions.set(s.id, s)
  armGc(s, UNJOINED_TTL_MS)
  logger.info(`[watch-together] session ${s.id} created by ${hostName} for ${media.source}:${media.videoId}`)
  return toInfo(s)
}

export function listSessions(): WtSessionInfo[] {
  return Array.from(sessions.values()).map(toInfo)
}

export function getSession(id: string): WtSessionInfo | null {
  const s = sessions.get(id)
  return s ? toInfo(s) : null
}

/** Join a session's live stream. Returns the member id + a state snapshot for the hello
 *  event, and an idempotent leave function. Null if the session no longer exists. */
export function joinSession(
  id: string,
  member: { userId: string; name: string; send: (evt: WtEvent) => void },
): { memberId: string; hello: WtEvent; leave: () => void } | null {
  const s = sessions.get(id)
  if (!s) return null
  const m: WtMember = { id: randomUUID().slice(0, 8), userId: member.userId, name: member.name, send: member.send }
  s.members.set(m.id, m)
  if (s.gcTimer) { clearTimeout(s.gcTimer); s.gcTimer = null }
  broadcast(s, { type: 'members', members: Array.from(s.members.values()).map(({ id: mid, userId, name }) => ({ id: mid, userId, name })) }, m.id)
  const hello: WtEvent = {
    type: 'hello', memberId: m.id, media: s.media,
    playing: s.playing, positionSec: s.positionSec, at: s.stateAt,
    members: Array.from(s.members.values()).map(({ id: mid, userId, name }) => ({ id: mid, userId, name })),
  }
  return {
    memberId: m.id,
    hello,
    leave: () => {
      if (!s.members.delete(m.id)) return
      broadcast(s, { type: 'members', members: Array.from(s.members.values()).map(({ id: mid, userId, name }) => ({ id: mid, userId, name })) })
      if (s.members.size === 0) armGc(s, EMPTY_GRACE_MS)
    },
  }
}

/** A member's play/pause/seek. Updates the authoritative state and fans out to the rest. */
export function setState(id: string, fromMemberId: string, playing: boolean, positionSec: number): boolean {
  const s = sessions.get(id)
  if (!s || !s.members.has(fromMemberId)) return false
  s.playing = playing
  s.positionSec = Math.max(0, positionSec)
  s.stateAt = Date.now()
  broadcast(s, { type: 'state', playing: s.playing, positionSec: s.positionSec, at: s.stateAt, by: fromMemberId }, fromMemberId)
  return true
}

/** A member moved the room to a different video (e.g. playlist next). */
export function setMedia(id: string, fromMemberId: string, media: WtMedia): boolean {
  const s = sessions.get(id)
  if (!s || !s.members.has(fromMemberId)) return false
  s.media = media
  s.playing = false
  s.positionSec = 0
  s.stateAt = Date.now()
  broadcast(s, { type: 'media', media, by: fromMemberId }, fromMemberId)
  return true
}

/** End the session for everyone (host action). */
export function endSession(id: string): boolean {
  const s = sessions.get(id)
  if (!s) return false
  broadcast(s, { type: 'ended' })
  if (s.gcTimer) clearTimeout(s.gcTimer)
  sessions.delete(id)
  logger.info(`[watch-together] session ${id} ended`)
  return true
}
