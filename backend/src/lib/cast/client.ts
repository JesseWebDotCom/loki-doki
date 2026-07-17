// A single Google Cast session over TLS. Drives the platform receiver (launch the
// Default Media Receiver) and then its media channel (load a URL, play/pause/stop,
// volume). Cast devices present a self-signed cert, so TLS verification is off —
// this is a LAN control channel to a speaker, not a data-integrity boundary.

import { connect } from 'bun'
import { DEFAULT_MEDIA_RECEIVER_APP_ID, encodeMessage, FrameReader, NS, type CastMessage } from './protocol'
import { logger } from '@/lib/logger'

const PLATFORM_SENDER = 'sender-0'
const PLATFORM_RECEIVER = 'receiver-0'

export interface CastMediaInfo {
  url: string
  contentType: string
  title?: string
  subtitle?: string
  artworkUrl?: string
}

export type CastPlayerState = 'idle' | 'buffering' | 'playing' | 'paused'

export interface CastStatus {
  connected: boolean
  playerState: CastPlayerState
  volume: number // 0..1
  media: CastMediaInfo | null
}

export class CastSession {
  private socket: Awaited<ReturnType<typeof connect>> | null = null
  private reader = new FrameReader()
  private requestId = 1
  private pending = new Map<number, (payload: any) => void>()
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private transportId: string | null = null // the launched media receiver's session
  private mediaSessionId: number | null = null
  private connectedToTransport = false

  status: CastStatus = { connected: false, playerState: 'idle', volume: 1, media: null }

  constructor(private host: string, private port: number) {}

  // ── Low-level send ────────────────────────────────────────────────────────
  private sendRaw(msg: CastMessage): void {
    if (!this.socket) return
    this.socket.write(encodeMessage(msg))
  }

  private send(namespace: string, destinationId: string, payload: object): void {
    this.sendRaw({ sourceId: PLATFORM_SENDER, destinationId, namespace, payloadUtf8: JSON.stringify(payload) })
  }

  /** Send a request carrying a requestId and resolve when its reply arrives. */
  private request(namespace: string, destinationId: string, payload: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
    const requestId = ++this.requestId
    const body = { ...payload, requestId }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Cast request timed out'))
      }, timeoutMs)
      this.pending.set(requestId, (reply) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        resolve(reply)
      })
      this.send(namespace, destinationId, body)
    })
  }

  // ── Incoming ───────────────────────────────────────────────────────────────
  private onMessage(msg: CastMessage): void {
    let payload: any
    try { payload = JSON.parse(msg.payloadUtf8) } catch { return }

    // Heartbeat: respond to the receiver's PING so it keeps the connection open.
    if (msg.namespace === NS.heartbeat && payload.type === 'PING') {
      this.send(NS.heartbeat, PLATFORM_RECEIVER, { type: 'PONG' })
      return
    }

    if (typeof payload.requestId === 'number' && this.pending.has(payload.requestId)) {
      this.pending.get(payload.requestId)!(payload)
    }

    if (payload.type === 'RECEIVER_STATUS') this.applyReceiverStatus(payload.status)
    if (payload.type === 'MEDIA_STATUS') this.applyMediaStatus(payload.status)
  }

  private applyReceiverStatus(status: any): void {
    if (typeof status?.volume?.level === 'number') this.status.volume = status.volume.level
    const app = status?.applications?.find((a: any) => a.transportId)
    if (app) this.transportId = app.transportId
  }

  private applyMediaStatus(statusList: any): void {
    const s = Array.isArray(statusList) ? statusList[0] : statusList
    if (!s) return
    if (typeof s.mediaSessionId === 'number') this.mediaSessionId = s.mediaSessionId
    const ps = String(s.playerState ?? '').toLowerCase()
    if (ps === 'playing' || ps === 'paused' || ps === 'buffering' || ps === 'idle') {
      this.status.playerState = ps as CastPlayerState
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      connect({
        hostname: this.host,
        port: this.port,
        tls: { rejectUnauthorized: false },
        socket: {
          open: (sock) => {
            this.socket = sock
            // Virtual connection to the platform receiver, then start heartbeats.
            this.send(NS.connection, PLATFORM_RECEIVER, { type: 'CONNECT' })
            this.heartbeat = setInterval(() => this.send(NS.heartbeat, PLATFORM_RECEIVER, { type: 'PING' }), 5000)
            this.status.connected = true
            resolve()
          },
          data: (_sock, data) => {
            for (const msg of this.reader.push(data instanceof Uint8Array ? data : new Uint8Array(data))) {
              try { this.onMessage(msg) } catch (e) { logger.warn(`[cast] message handler: ${e}`) }
            }
          },
          close: () => { this.status.connected = false },
          error: (_sock, err) => { logger.warn(`[cast] socket error: ${err.message}`); this.status.connected = false },
        },
      }).catch(reject)
    })
  }

  /** Launch the Default Media Receiver and open a virtual connection to it. */
  private async ensureReceiver(): Promise<void> {
    if (this.connectedToTransport && this.transportId) return
    const reply = await this.request(NS.receiver, PLATFORM_RECEIVER, { type: 'LAUNCH', appId: DEFAULT_MEDIA_RECEIVER_APP_ID })
    this.applyReceiverStatus(reply.status)
    if (!this.transportId) throw new Error('Cast device did not start the media receiver.')
    this.send(NS.connection, this.transportId, { type: 'CONNECT' })
    this.connectedToTransport = true
  }

  async loadMedia(media: CastMediaInfo): Promise<void> {
    await this.ensureReceiver()
    const payload = {
      type: 'LOAD',
      autoplay: true,
      currentTime: 0,
      media: {
        contentId: media.url,
        streamType: 'BUFFERED',
        contentType: media.contentType,
        metadata: {
          metadataType: 3, // MusicTrackMediaMetadata
          title: media.title ?? 'Loki Doki',
          artist: media.subtitle ?? '',
          images: media.artworkUrl ? [{ url: media.artworkUrl }] : [],
        },
      },
    }
    const reply = await this.request(NS.media, this.transportId!, payload, 15000)
    this.applyMediaStatus(reply.status)
    this.status.media = media
    this.status.playerState = 'buffering'
  }

  private mediaCommand(type: string): void {
    if (!this.transportId || this.mediaSessionId == null) return
    this.send(NS.media, this.transportId, { type, mediaSessionId: this.mediaSessionId })
  }

  play(): void { this.mediaCommand('PLAY'); this.status.playerState = 'playing' }
  pause(): void { this.mediaCommand('PAUSE'); this.status.playerState = 'paused' }
  stop(): void { this.mediaCommand('STOP'); this.status.playerState = 'idle'; this.status.media = null }

  setVolume(level: number): void {
    const clamped = Math.max(0, Math.min(1, level))
    this.send(NS.receiver, PLATFORM_RECEIVER, { type: 'SET_VOLUME', volume: { level: clamped } })
    this.status.volume = clamped
  }

  close(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
    try { this.socket?.end() } catch { /* */ }
    this.socket = null
    this.status.connected = false
  }
}
