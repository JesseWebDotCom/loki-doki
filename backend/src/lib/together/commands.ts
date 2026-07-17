// Listening Together: the remote-command envelope routed to ONE chosen session over
// the existing browser-session SSE stream. Mirrored on the frontend in
// frontend/src/lib/together/api.ts (TogetherCommand) - keep the shapes in sync.

import { randomUUID } from 'node:crypto'
import { pushToDeviceSession, trackCommandAck } from '@/lib/pod/browserSession'

export type TogetherCommandKind =
  | 'toggle' | 'play' | 'pause' | 'next' | 'seek' | 'volume' | 'stop'
  | 'play_station' | 'play_video' | 'play_episode'
  | 'queue_track' | 'queue_episode'

export interface TogetherCommand {
  kind: TogetherCommandKind
  positionSec?: number          // seek
  volume?: number               // 0..1
  // play_station: either a saved station id or a seed (mirrors the play_media directive)
  stationId?: string
  seedType?: 'artist' | 'song' | 'genre'
  seed?: string
  // play_video / queue_track
  videoId?: string
  title?: string
  artist?: string | null
  thumbnail?: string
  // play_episode / queue_episode
  episodeId?: string
  showId?: string
  showName?: string
  coverUrl?: string
  /** Who sent it - the target shows this in its toast ("from Maya"). */
  fromName?: string
}

const KINDS: TogetherCommandKind[] = [
  'toggle', 'play', 'pause', 'next', 'seek', 'volume', 'stop',
  'play_station', 'play_video', 'play_episode', 'queue_track', 'queue_episode',
]

export function isTogetherCommandKind(k: unknown): k is TogetherCommandKind {
  return typeof k === 'string' && (KINDS as string[]).includes(k)
}

/** Deliver a command to the session behind `deviceId` and await its handled-ack.
 *  Resolves false when the session is gone or never acks (fire-and-verify, same
 *  contract as the controller tiles). */
export function sendTogetherCommand(deviceId: string, command: TogetherCommand, timeoutMs = 3000): Promise<boolean> {
  const ackId = randomUUID()
  return new Promise<boolean>((resolve) => {
    trackCommandAck(ackId, resolve, timeoutMs)
    const delivered = pushToDeviceSession(deviceId, {
      type: 'together',
      ackId,
      payload: command as unknown as Record<string, unknown>,
    })
    if (!delivered) resolve(false)
  })
}
