// HLS presentation for native players (Apple TV / AVPlayer) that need a real seekable
// timeline. The existing high-tier path remuxes the DASH pair through ffmpeg into a
// fragmented MP4 pipe, which plays but has no byte-seek and no duration, so AVPlayer's
// scrubber is dead. This builds a VOD HLS presentation instead, and does it WITHOUT
// ffmpeg, because YouTube's adaptive tracks are already exactly what HLS wants:
//
//   ftyp | moov | sidx | moof+mdat | moof+mdat | ...
//
// The `sidx` box is a complete index of every subsegment (byte size + duration, each one
// SAP type 1, i.e. starting on a keyframe). So we fetch ~64KB of each track's head, parse
// the index once, and emit media playlists whose segments are `#EXT-X-BYTERANGE` slices of
// the very same file, with `ftyp+moov` as the `#EXT-X-MAP` init segment. Segments are then
// served by plain Range passthrough (the byte proxy we already have): no transcode, no
// per-segment subprocess, no temp files, no session lifecycle, and seeking is instant
// because the player just asks for the byte range it wants.
//
// Video and audio stay separate files, so the master playlist pairs a video variant with
// an `#EXT-X-MEDIA:TYPE=AUDIO` rendition group. That is standard HLS and AVPlayer handles
// the two independent segment timelines fine.
//
// CODEC REALITY: YouTube publishes h264 (avc1) only up to 1080p; 1440p and 2160p are VP9
// and AV1 only, and the HEVC tracks are exclusive to the iOS/tvOS InnerTube clients we can
// no longer talk to (they need an attestation token). AVPlayer decodes neither VP9 nor AV1
// in HLS, so this module pins the video track to avc1 and tops out at 1080p. The tiers
// above it can only be served by re-encoding to HEVC, which is hlsTranscode.ts. This
// file stays the zero-CPU path everything else uses (including as the fallback whenever a
// transcode tier isn't available).

import { logger } from '@/lib/logger'
import { resolveSplitStreamUrls, invalidateSplitStreamUrls, isValidVideoId, type StreamKind } from '@/lib/youtube/stream'

/** h264 stops here on YouTube, so every HLS presentation is capped at 1080p. */
export const HLS_MAX_HEIGHT = 1080

/** Variant discriminator carried on the low rung's playlist/segment URIs
 *  (`video.m3u8?v=720`). No query = the original 1080p behavior. */
export type HlsVideoVariant = '720'

// googlevideo is picky about the UA matching the client that resolved the URL.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// The head fetch has to cover ftyp+moov+sidx. 64KB covers a couple of hours of video
// (12 bytes per subsegment); anything longer is re-fetched once at the exact size.
const HEAD_BYTES = 64 * 1024
const MAX_HEAD_BYTES = 4 * 1024 * 1024

export interface HlsSegment { offset: number; size: number; duration: number }

export interface HlsTrack {
  /** Current signed googlevideo URL. Re-resolved in place when it expires. */
  url: string
  itag: number
  /** Byte length of ftyp+moov, i.e. the playlist's #EXT-X-MAP range. */
  initSize: number
  segments: HlsSegment[]
  duration: number
  bytes: number
  /** Sample-entry fourcc: always avc1 (video) or mp4a (audio); anything else is rejected
   *  at parse time, since only those two can be served without transcoding. */
  fourcc: string
  /** RFC 6381 codec string for the master playlist's CODECS attribute. */
  codec: string
  width: number
  height: number
  channels: number
  /** Frames per second from the InnerTube format (null when resolved via yt-dlp). */
  fps: number | null
  /** The format's declared peak bitrate in bits/s (null when unknown). */
  peakBitrate: number | null
}

export interface HlsPresentation {
  /** Primary rung: best avc1 above the 720p progressive ceiling (up to 1080p). */
  video: HlsTrack
  /** Secondary rung: best avc1 at or under 720p. Null when the resolver found no
   *  distinct lower track; the master then lists the single 1080p variant as before. */
  video720: HlsTrack | null
  audio: HlsTrack
  expires: number
}

// ── MP4 box parsing ────────────────────────────────────────────────────────────
// Just enough of ISO-BMFF to read the segment index and the codec/geometry needed for
// the playlist. Everything here reads from the head bytes only; mdat is never touched.

interface Box { type: string; start: number; body: number; end: number }

function* boxes(dv: DataView, start: number, end: number): Generator<Box> {
  let off = start
  while (off + 8 <= end) {
    let size = dv.getUint32(off)
    let body = off + 8
    if (size === 1) {                                  // 64-bit largesize
      if (off + 16 > end) return
      size = Number(dv.getBigUint64(off + 8))
      body = off + 16
    }
    if (size < 8) return                               // size 0 = "to EOF"; nothing to iterate
    const type = String.fromCharCode(dv.getUint8(off + 4), dv.getUint8(off + 5), dv.getUint8(off + 6), dv.getUint8(off + 7))
    yield { type, start: off, body, end: off + size }
    off += size
  }
}

/** Depth-first search for the first box of `type` inside a container. */
function findBox(dv: DataView, start: number, end: number, path: string[]): Box | null {
  const [head, ...rest] = path
  for (const b of boxes(dv, start, end)) {
    if (b.type !== head) continue
    if (!rest.length) return b
    // Container boxes we descend through are all plain (no leading version/flags).
    const inner = findBox(dv, b.body, Math.min(b.end, dv.byteLength), rest)
    if (inner) return inner
  }
  return null
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/** `avc1.PPCCLL` from the avcC config record. AVPlayer rejects a variant whose CODECS
 *  attribute does not match what the segments actually contain. */
function avcCodec(dv: DataView, entry: Box): string | null {
  // VisualSampleEntry: 8-byte box header + 78 bytes of fixed fields before its child boxes.
  const cfg = findBox(dv, entry.start + 86, entry.end, ['avcC'])
  if (!cfg) return null
  return `avc1.${hex2(dv.getUint8(cfg.body + 1))}${hex2(dv.getUint8(cfg.body + 2))}${hex2(dv.getUint8(cfg.body + 3))}`
}

/** `mp4a.40.2` (AAC-LC) / `mp4a.40.5` (HE-AAC) from the esds descriptor chain. */
function aacCodec(dv: DataView, entry: Box): string | null {
  // AudioSampleEntry: 8-byte box header + 28 bytes of fixed fields before its child boxes.
  const esds = findBox(dv, entry.start + 36, entry.end, ['esds'])
  if (!esds) return null
  // Walk the MPEG-4 descriptors (tag, then a 1–4 byte length with continuation bits) to
  // DecoderConfigDescriptor (0x04) and the DecoderSpecificInfo (0x05) nested in it.
  let off = esds.body + 4
  let objectType = 0x40
  while (off + 2 < esds.end) {
    const tag = dv.getUint8(off++)
    let len = 0
    for (let i = 0; i < 4; i++) { const b = dv.getUint8(off++); len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break }
    if (tag === 0x03) { off += 3; continue }                       // ES_Descriptor: skip its header, descend
    if (tag === 0x04) { objectType = dv.getUint8(off); off += 13; continue }  // descend into the nested DSI
    if (tag === 0x05) {
      const aot = dv.getUint8(off) >> 3                            // 5-bit AudioObjectType
      return `mp4a.${objectType.toString(16)}.${aot || 2}`
    }
    off += len
  }
  return `mp4a.${objectType.toString(16)}.2`
}

type ParsedTrack = Omit<HlsTrack, 'url' | 'itag' | 'fps' | 'peakBitrate'>

/** Parse a track head into an index. Returns a byte count when the head fetch was too
 *  short to hold the whole sidx (long videos), so the caller can re-fetch exactly. */
function parseTrackHead(buf: Uint8Array, kind: StreamKind): ParsedTrack | { need: number } | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let moovEnd = 0
  let sidx: Box | null = null
  for (const b of boxes(dv, 0, buf.byteLength)) {
    if (b.type === 'moov') moovEnd = b.end
    if (b.type === 'sidx') { sidx = b; break }
  }
  if (!moovEnd || !sidx) return null                    // not a DASH-style fragmented MP4
  if (sidx.end > buf.byteLength) return { need: sidx.end }

  // stsd sample entry: codec fourcc plus the geometry the master playlist advertises.
  const stsd = findBox(dv, 0, moovEnd, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
  if (!stsd) return null
  const entry = [...boxes(dv, stsd.body + 8, stsd.end)][0]
  if (!entry) return null
  let codec: string | null = null
  let width = 0, height = 0, channels = 0
  if (kind === 'video') {
    if (entry.type !== 'avc1') return null               // vp09 / av01: AVPlayer can't decode these in HLS
    codec = avcCodec(dv, entry)
    width = dv.getUint16(entry.start + 32)
    height = dv.getUint16(entry.start + 34)
  } else {
    if (entry.type !== 'mp4a') return null               // opus/webm audio can't go in an MP4 segment
    codec = aacCodec(dv, entry)
    channels = dv.getUint16(entry.start + 24)
  }
  if (!codec) return null
  const fourcc = entry.type

  // sidx: one reference per subsegment, each starting on a keyframe (SAP type 1), so the
  // byte ranges map 1:1 onto HLS media segments.
  const version = dv.getUint8(sidx.body)
  let p = sidx.body + 8                                  // version+flags, reference_ID
  const timescale = dv.getUint32(p); p += 4
  // earliest_presentation_time + first_offset: 32-bit in version 0, 64-bit in version 1.
  const firstOffset = version === 0 ? dv.getUint32(p + 4) : Number(dv.getBigUint64(p + 8))
  p += version === 0 ? 8 : 16
  const count = dv.getUint16(p + 2); p += 4              // reserved(2) + reference_count(2)
  if (!timescale || !count) return null

  const segments: HlsSegment[] = []
  let offset = sidx.end + firstOffset
  let duration = 0
  let bytes = 0
  for (let i = 0; i < count; i++, p += 12) {
    const ref = dv.getUint32(p)
    if (ref >>> 31) return null                          // top bit set = nested sidx; not worth supporting
    const size = ref & 0x7fffffff
    const dur = dv.getUint32(p + 4) / timescale
    segments.push({ offset, size, duration: dur })
    offset += size; bytes += size; duration += dur
  }
  return { initSize: moovEnd, segments, duration, bytes, fourcc, codec, width, height, channels }
}

async function fetchHead(url: string, end: number): Promise<Uint8Array | null> {
  const res = await fetch(url, {
    headers: { Range: `bytes=0-${end - 1}`, 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok && res.status !== 206) return null
  return new Uint8Array(await res.arrayBuffer())
}

/** googlevideo URLs carry their own itag/clen, used to prove a re-resolved URL still
 *  points at the exact same file, otherwise every cached byte offset is meaningless. */
function urlParam(url: string, key: string): string | null {
  try { return new URL(url).searchParams.get(key) } catch { return null }
}

// Classic avc1 DASH itag table: the only h264 video-only itags YouTube has ever
// published. Fills FRAME-RATE when the URL came from the yt-dlp fallback, whose -g
// output carries no format metadata (the itag rides on the URL itself).
const AVC1_ITAG_FPS: Record<number, number> = { 133: 30, 134: 30, 135: 30, 136: 30, 137: 30, 160: 30, 298: 60, 299: 60, 304: 60, 305: 60 }

async function indexTrack(url: string, kind: StreamKind, meta?: { fps?: number | null; bitrate?: number | null }): Promise<HlsTrack | null> {
  let head = await fetchHead(url, HEAD_BYTES)
  if (!head) return null
  let parsed = parseTrackHead(head, kind)
  if (parsed && 'need' in parsed) {
    if (parsed.need > MAX_HEAD_BYTES) return null
    head = await fetchHead(url, parsed.need)
    parsed = head ? parseTrackHead(head, kind) : null
  }
  if (!parsed || 'need' in parsed) return null
  const itag = Number(urlParam(url, 'itag')) || 0
  return {
    url,
    itag,
    fps: meta?.fps ?? (kind === 'video' ? AVC1_ITAG_FPS[itag] ?? null : null),
    peakBitrate: meta?.bitrate ?? null,
    ...parsed,
  }
}

// ── Presentation cache ─────────────────────────────────────────────────────────
// The parsed index is stable for the life of the video, but it is keyed to the signed URL
// only in the sense that the URL must keep pointing at the same itag. Hold it for a few
// hours (matching the stream URL cache) and rebuild after that.

const TTL_MS = 3 * 60 * 60 * 1000
const cache = new Map<string, HlsPresentation>()
const inflight = new Map<string, Promise<HlsPresentation | null>>()
// Un-indexable videos (no avc1 pair above the progressive ceiling) fail the SAME way on
// every play — without a negative cache each play re-pays InnerTube + possibly yt-dlp
// just to rediscover it. Short TTL, since a fresh resolve can change the answer.
// (Pattern: previewMisses in lib/youtube/stream.ts.)
const MISS_TTL_MS = 5 * 60 * 1000
const misses = new Map<string, number>()

/** Build (or reuse) the avc1+AAC HLS index for a video. Null when the video has no h264
 *  DASH track above the progressive ceiling, or its tracks aren't indexable. The caller
 *  then tells the client to fall back to the plain progressive stream, which is already
 *  Range-seekable. */
export async function getHlsPresentation(videoId: string): Promise<HlsPresentation | null> {
  if (!isValidVideoId(videoId)) return null
  const hit = cache.get(videoId)
  if (hit && hit.expires > Date.now()) return hit
  if (hit) cache.delete(videoId)
  const missUntil = misses.get(videoId)
  if (missUntil !== undefined) {
    if (missUntil > Date.now()) return null
    misses.delete(videoId)
  }
  const pending = inflight.get(videoId)
  if (pending) return pending
  const p = buildPresentation(videoId)
  inflight.set(videoId, p)
  void p.finally(() => { if (inflight.get(videoId) === p) inflight.delete(videoId) })
  return p
}

async function buildPresentation(videoId: string): Promise<HlsPresentation | null> {
  const urls = await resolveSplitStreamUrls(videoId, HLS_MAX_HEIGHT, 'avc1')
  if (!urls) {
    misses.set(videoId, Date.now() + MISS_TTL_MS)
    return null
  }
  // Secondary (<=720p) rung: skip when the resolver found no DISTINCT lower track (the
  // yt-dlp fallback's low selector re-prints the primary itag when none exists). A
  // missing low rung just means the master lists a single variant, the old behavior.
  const lowUrl = urls.lowVideo && (Number(urlParam(urls.lowVideo, 'itag')) || 0) !== (Number(urlParam(urls.video, 'itag')) || 0)
    ? urls.lowVideo
    : null
  const [video, audio, video720] = await Promise.all([
    indexTrack(urls.video, 'video', { fps: urls.videoFps, bitrate: urls.videoBitrate }).catch(() => null),
    indexTrack(urls.audio, 'audio', { bitrate: urls.audioBitrate }).catch(() => null),
    lowUrl ? indexTrack(lowUrl, 'video', { fps: urls.lowVideoFps, bitrate: urls.lowVideoBitrate }).catch(() => null) : Promise.resolve(null),
  ])
  if (!video || !audio) {
    logger.warn(`[youtube/hls] no indexable avc1+aac pair for ${videoId} (video=${!!video} audio=${!!audio})`)
    misses.set(videoId, Date.now() + MISS_TTL_MS)
    return null
  }
  const pres: HlsPresentation = { video, video720, audio, expires: Date.now() + TTL_MS }
  if (cache.size > 100) for (const [k, v] of cache) if (v.expires <= Date.now()) cache.delete(k)
  cache.set(videoId, pres)
  return pres
}

export function invalidateHlsPresentation(videoId: string): void {
  cache.delete(videoId)
  misses.delete(videoId)
  invalidateSplitStreamUrls(videoId, HLS_MAX_HEIGHT, 'avc1')
}

/** Re-resolve one track's signed URL after an upstream 403 (the signature rotated mid-
 *  play). The byte index survives only if the fresh URL is the same itag and length,
 *  otherwise the whole presentation is dropped and the client re-fetches the playlist. */
export async function refreshHlsTrackUrl(videoId: string, kind: StreamKind, variant?: HlsVideoVariant): Promise<string | null> {
  const pres = cache.get(videoId)
  if (!pres) return null
  const use720 = kind === 'video' && variant === '720' && !!pres.video720
  const track = kind === 'audio' ? pres.audio : use720 ? pres.video720! : pres.video
  invalidateSplitStreamUrls(videoId, HLS_MAX_HEIGHT, 'avc1')
  const urls = await resolveSplitStreamUrls(videoId, HLS_MAX_HEIGHT, 'avc1')
  const fresh = urls ? (kind === 'audio' ? urls.audio : use720 ? (urls.lowVideo ?? null) : urls.video) : null
  if (!fresh || Number(urlParam(fresh, 'itag')) !== track.itag) {
    cache.delete(videoId)
    return null
  }
  track.url = fresh
  return fresh
}

// ── Playlist rendering ─────────────────────────────────────────────────────────

// Measured average bits/s over the whole track (exact: total bytes / total duration).
const bandwidth = (t: HlsTrack) => Math.round((t.bytes * 8) / Math.max(1, t.duration))
// Peak bits/s for the BANDWIDTH attribute: the format's declared peak when known,
// floored at the measured average so BANDWIDTH >= AVERAGE-BANDWIDTH always holds.
const peakBandwidth = (t: HlsTrack) => Math.max(t.peakBitrate ?? 0, bandwidth(t))
// FRAME-RATE is a decimal-float attribute; trim integer rates to bare integers.
const frameRateAttr = (fps: number | null) =>
  fps ? `,FRAME-RATE=${Number.isInteger(fps) ? fps : fps.toFixed(3)}` : ''

export interface HlsMasterOptions {
  /** Advertise a WebVTT subtitle rendition (only when a transcript already exists on disk). */
  subtitles?: boolean
}

/**
 * Master playlist: the avc1 variant ladder (720p rung first when present, then 1080p)
 * plus the AAC track as an audio rendition group, an I-frame playlist for native
 * trick-play scrubbing, and optionally a subtitles rendition group. URIs are relative
 * to `/api/youtube/stream/:videoId/`, so the player keeps hitting our origin (and sends
 * the same session cookie) without us knowing the external hostname.
 */
export function hlsMasterPlaylist(pres: HlsPresentation, opts: HlsMasterOptions = {}): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Audio",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="${pres.audio.channels || 2}",URI="hls/audio.m3u8"`,
  ]
  if (opts.subtitles) {
    lines.push('#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",LANGUAGE="en",DEFAULT=NO,AUTOSELECT=YES,FORCED=NO,URI="hls/subs.m3u8"')
  }
  const subsAttr = opts.subtitles ? ',SUBTITLES="subs"' : ''
  const variant = (t: HlsTrack, uri: string) => {
    const bw = peakBandwidth(t) + peakBandwidth(pres.audio)
    const avg = bandwidth(t) + bandwidth(pres.audio)
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},AVERAGE-BANDWIDTH=${avg},CODECS="${t.codec},${pres.audio.codec}",RESOLUTION=${t.width}x${t.height}${frameRateAttr(t.fps)},AUDIO="aac"${subsAttr}`)
    lines.push(uri)
  }
  if (pres.video720) variant(pres.video720, 'hls/video.m3u8?v=720')
  variant(pres.video, 'hls/video.m3u8')
  // Trick play: every sidx subsegment starts on a keyframe (SAP type 1), so the lightest
  // variant's segment starts double as an I-frame index.
  const ift = pres.video720 ?? pres.video
  lines.push(`#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=${peakBandwidth(ift)},CODECS="${ift.codec}",RESOLUTION=${ift.width}x${ift.height},URI="hls/iframe.m3u8"`)
  lines.push('')
  return lines.join('\n')
}

/**
 * Media playlist for one track: every segment is a byte range of the single upstream file,
 * which our Range proxy serves. VOD + EXT-X-ENDLIST is what gives AVPlayer a fully
 * seekable timeline (the whole point of this endpoint).
 */
export function hlsMediaPlaylist(track: HlsTrack, segmentUri: string): string {
  const target = Math.ceil(Math.max(...track.segments.map(s => s.duration)))
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="${segmentUri}",BYTERANGE="${track.initSize}@0"`,
  ]
  for (const s of track.segments) {
    lines.push(`#EXTINF:${s.duration.toFixed(3)},`)
    lines.push(`#EXT-X-BYTERANGE:${s.size}@${s.offset}`)
    lines.push(segmentUri)
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

/**
 * I-frame playlist for native trick-play scrubbing. Every sidx subsegment is SAP type 1,
 * i.e. it STARTS on a keyframe, so each segment's whole moof+mdat byte range is a valid
 * I-frame entry: it contains the leading keyframe plus everything needed to decode it.
 * (Sub-segment moof parsing could shrink the ranges to just the first sample, but the
 * player stops reading once it has decoded the I-frame, so segment ranges work fine.)
 */
export function hlsIframePlaylist(track: HlsTrack, segmentUri: string): string {
  const target = Math.ceil(Math.max(...track.segments.map(s => s.duration)))
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-I-FRAMES-ONLY',
    `#EXT-X-TARGETDURATION:${target}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="${segmentUri}",BYTERANGE="${track.initSize}@0"`,
  ]
  for (const s of track.segments) {
    lines.push(`#EXTINF:${s.duration.toFixed(3)},`)
    lines.push(`#EXT-X-BYTERANGE:${s.size}@${s.offset}`)
    lines.push(segmentUri)
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

/**
 * Single-segment WebVTT playlist covering the full duration. The VTT already carries
 * absolute cue times from 0, so one segment keeps it perfectly aligned with the media
 * timeline with no splitting or timestamp-map work.
 */
export function hlsSubtitlePlaylist(durationSec: number): string {
  const dur = Math.max(1, durationSec)
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    `#EXT-X-TARGETDURATION:${Math.ceil(dur)}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXTINF:${dur.toFixed(3)},`,
    'subs.vtt',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n')
}
