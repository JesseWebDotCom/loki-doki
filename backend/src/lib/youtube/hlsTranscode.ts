// 4K/1440p HLS for Apple TV, the only way it can exist: by transcoding.
//
// YouTube publishes h264 only up to 1080p: 1440p and 2160p are VP9 or AV1 exclusively
// (verified against real format tables, see hls.ts). The target box is an Apple TV 4K 1st
// gen (AppleTV6,2, A10X): it hardware-decodes HEVC up to 4K60 but has no VP9 or AV1
// decoder at all, and AVPlayer won't take either in HLS regardless. So the high tiers are
// decode-VP9/AV1 → encode-HEVC → fMP4 HLS, tagged `hvc1` (AVPlayer rejects `hev1`).
//
// Everything at or below 1080p stays on the zero-CPU passthrough tier in hls.ts. This
// module only ever runs for the tiers that cannot be served any other way.
//
// Session model (the Jellyfin-style one, chosen over ffmpeg's own VOD playlist):
//   - The playlist is computed up front from the video's duration and a fixed segment
//     length, so the client gets a complete, seekable VOD timeline immediately. It never
//     waits for the encoder to reach the end.
//   - Segments are produced by an ffmpeg run started at a segment boundary, with
//     `-force_key_frames` on that same grid so segment N always begins on an IDR and
//     `-output_ts_offset` so its timestamps land at the right place on the global timeline.
//   - A seek past what has been encoded restarts ffmpeg at the requested segment. That is
//     the cost of transcoding: seeks are not instant like the passthrough tier, they pay
//     one encoder start (~2-4s) before the first segment lands.
//
// Concurrency is capped hard. The production box drives NVENC on an eGPU with documented
// transient-brownout issues (gpu-power-guard.ps1), so a third concurrent session is
// refused rather than queued.

import { spawn, type ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rm, readdir, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { dataDir } from '@/lib/download'
import { ensureFfmpeg, ensureNvencFfmpeg, ffprobeBin, deprioritizeEncode } from '@/lib/ffmpeg'
import { resolveVideoEncoder } from '@/lib/media/encoder'
import { resolveSplitStreamUrls, isValidVideoId, type SplitStreamUrls } from '@/lib/youtube/stream'
import { logger } from '@/lib/logger'

const execFileAsync = promisify(execFile)

/** Tiers that exist only above h264's ceiling, i.e. the ones worth burning an encoder on. */
export const TRANSCODE_HEIGHTS = new Set([1440, 2160])

const SEGMENT_SEC = 4
const ROOT = join(dataDir, 'cache', 'yt-hls')
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/** Hard cap on live encoder sessions. See the eGPU note above. */
const MAX_SESSIONS = 2
/** Kill + delete a session this long after its last segment request. */
const IDLE_MS = 90_000
/** How far ahead of the encoder we'll wait rather than restart it at the seek point. */
const LOOKAHEAD = 12
/** Longest a segment request blocks before giving up on the encoder. */
const SEGMENT_WAIT_MS = 45_000
/** Trailing segments kept on disk per session (~8 min at 4s) before the oldest are pruned. */
const KEEP_SEGMENTS = 120

// ── Plan ───────────────────────────────────────────────────────────────────────

export interface TranscodePlan {
  videoId: string
  /** Actual source height (a "2160" request on a 1440p video plans 1440, never upscales). */
  height: number
  width: number
  duration: number
  segments: number
  /** RFC 6381 codec string for the master playlist. */
  codec: string
  /** vp9 / av1: what the decoder side has to chew through. */
  sourceCodec: string
  urls: SplitStreamUrls
  /** True when the audio track is already AAC-in-MP4 and can be stream-copied. */
  copyAudio: boolean
  expires: number
}

const PLAN_TTL_MS = 3 * 60 * 60 * 1000
const plans = new Map<string, TranscodePlan>()
const planInflight = new Map<string, Promise<TranscodePlan | null>>()
const planKey = (videoId: string, height: number) => `${videoId}:${height}`

/**
 * Build (or reuse) the plan for one high tier. Returns null, meaning "don't advertise a
 * 4K tier at all", when the source has no track above 1080p, when the box has no hardware
 * HEVC encoder (libx265 cannot do 4K in realtime, so offering it would just stall the
 * player), or when the source can't be probed.
 */
export async function getTranscodePlan(videoId: string, height: number): Promise<TranscodePlan | null> {
  if (!isValidVideoId(videoId) || !TRANSCODE_HEIGHTS.has(height)) return null
  const key = planKey(videoId, height)
  const hit = plans.get(key)
  if (hit && hit.expires > Date.now()) return hit
  if (hit) plans.delete(key)
  const pending = planInflight.get(key)
  if (pending) return pending
  const p = buildPlan(videoId, height, key)
  planInflight.set(key, p)
  void p.finally(() => { if (planInflight.get(key) === p) planInflight.delete(key) })
  return p
}

/** HEVC Main profile, main tier, the level the stream actually needs: 4K60 is level 5.1,
 *  anything smaller fits in 5.0. The A10X decodes both. */
const hevcCodecString = (height: number) => `hvc1.1.6.L${height > 1440 ? 153 : 150}.B0`

async function buildPlan(videoId: string, height: number, key: string): Promise<TranscodePlan | null> {
  const encoder = await resolveVideoEncoder()
  if (!encoder.hw) {
    // A realtime libx265 4K encode is worse than the crisp 1080p passthrough, so the tier
    // is withheld entirely and the master playlist falls back to passthrough.
    logger.warn(`[youtube/hls] not offering the ${height}p tier, no hardware HEVC encoder: ${encoder.reason}`)
    return null
  }
  const urls = await resolveSplitStreamUrls(videoId, height)
  if (!urls) return null
  const probed = await probeSource(urls.video)
  if (!probed || probed.height <= 1080) return null   // the passthrough tier already covers this
  const plan: TranscodePlan = {
    videoId,
    height: probed.height,
    width: probed.width,
    duration: probed.duration,
    segments: Math.max(1, Math.ceil(probed.duration / SEGMENT_SEC)),
    codec: hevcCodecString(probed.height),
    sourceCodec: probed.codec,
    urls,
    // googlevideo tags every URL with its own mime; audio/mp4 means AAC, which copies
    // straight into the fMP4 segments instead of costing us a second encoder.
    copyAudio: /audio\/mp4/i.test(decodeURIComponent(new URL(urls.audio).searchParams.get('mime') ?? '')),
    expires: Date.now() + PLAN_TTL_MS,
  }
  plans.set(key, plan)
  return plan
}

/** One ffprobe over the signed URL for geometry + duration. The high tiers are usually
 *  VP9-in-WebM, which carries no MP4 index for hls.ts's byte-range parser to read. */
async function probeSource(url: string): Promise<{ width: number; height: number; duration: number; codec: string } | null> {
  try {
    const { stdout } = await execFileAsync(ffprobeBin(), [
      '-v', 'error', '-user_agent', UA,
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,codec_name:format=duration',
      '-of', 'json', url,
    ], { timeout: 25_000, maxBuffer: 1024 * 1024, windowsHide: true })
    const data = JSON.parse(stdout) as { streams?: { width?: number; height?: number; codec_name?: string }[]; format?: { duration?: string } }
    const s = data.streams?.[0]
    // The container's own duration is the fallback when ffprobe reports none (some WebM
    // streams over HTTP), and googlevideo puts it right in the URL.
    const duration = Number.parseFloat(data.format?.duration ?? '') || Number.parseFloat(new URL(url).searchParams.get('dur') ?? '')
    if (!s?.width || !s?.height || !Number.isFinite(duration) || duration <= 0) return null
    return { width: s.width, height: s.height, duration, codec: s.codec_name ?? 'unknown' }
  } catch (err) {
    logger.warn(`[youtube/hls] source probe failed: ${err}`)
    return null
  }
}

// ── Playlists ──────────────────────────────────────────────────────────────────

/** Rough per-tier bitrate for the master playlist's BANDWIDTH hint. There's one variant,
 *  so this only has to be in the right ballpark for the player's initial buffer sizing.
 *  Sized to the encoder caps in tierQualityArgs (measured 4K average ~19 Mbps, busy
 *  segments into the low 30s). */
const tierBandwidth = (height: number) => (height > 1440 ? 30_000_000 : 16_000_000)

/** Master playlist for a transcoded tier: one HEVC variant with muxed AAC (no rendition
 *  group, unlike the passthrough tier: both tracks come out of the same encoder). */
export function hevcMasterPlaylist(plan: TranscodePlan, query: string): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-STREAM-INF:BANDWIDTH=${tierBandwidth(plan.height)},CODECS="${plan.codec},mp4a.40.2",RESOLUTION=${plan.width}x${plan.height}`,
    `hls/hevc.m3u8${query}`,
    '',
  ].join('\n')
}

/** Media playlist, complete from the first request: durations come from the fixed segment
 *  grid, not from whatever the encoder has produced so far. That is what makes the whole
 *  timeline seekable immediately. */
export function hevcMediaPlaylist(plan: TranscodePlan, query: string): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    `#EXT-X-TARGETDURATION:${SEGMENT_SEC}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    `#EXT-X-MAP:URI="hevc/init.mp4${query}"`,
  ]
  for (let i = 0; i < plan.segments; i++) {
    const dur = Math.min(SEGMENT_SEC, plan.duration - i * SEGMENT_SEC)
    lines.push(`#EXTINF:${dur.toFixed(3)},`)
    lines.push(`hevc/${i}.m4s${query}`)
  }
  lines.push('#EXT-X-ENDLIST', '')
  return lines.join('\n')
}

// ── Encoder sessions ───────────────────────────────────────────────────────────

interface Session {
  key: string
  dir: string
  plan: TranscodePlan
  proc: ChildProcess | null
  /** Segment index the current ffmpeg run started at. */
  startIndex: number
  lastAccess: number
  stopped: boolean
}

const sessions = new Map<string, Session>()
let reaper: ReturnType<typeof setInterval> | null = null
let rootSweep: Promise<unknown> | null = null

// A backend restart must not leave encoders running for the rest of the video, filling
// the disk with segments nobody will ask for. index.ts's SIGINT/SIGTERM shutdown ends in
// process.exit, so one 'exit' hook covers both that and a plain quit.
process.on('exit', () => {
  for (const s of sessions.values()) { try { s.proc?.kill('SIGKILL') } catch { /* already gone */ } }
})

export type SegmentResult = string | 'capacity' | 'unavailable'

/** Path of one segment file, producing it (and starting/restarting the encoder) if needed. */
export async function getTranscodeSegment(videoId: string, height: number, index: number): Promise<SegmentResult> {
  const plan = await getTranscodePlan(videoId, height)
  if (!plan || index < 0 || index >= plan.segments) return 'unavailable'
  const dir = sessionDir(plan)
  const file = join(dir, `seg${index}.m4s`)

  const existing = sessions.get(planKey(videoId, height))
  if (existing) existing.lastAccess = Date.now()
  if (existsSync(file)) return file

  // Wait only when the running encoder is genuinely about to reach this segment; a seek
  // further out is served faster by restarting ffmpeg there than by encoding the gap.
  const head = existing ? runHead(dir, existing.startIndex) : -1
  const willReach = !!existing && !existing.stopped && index > head && index <= head + LOOKAHEAD
  if (!willReach) {
    const started = await startSession(plan, index)
    if (started !== 'ok') return started
  }
  const ready = await waitForFile(file, planKey(videoId, height))
  if (!ready) return 'unavailable'
  void pruneOldSegments(dir, index)
  return file
}

/** Path of the fMP4 init segment (`#EXT-X-MAP`), starting the encoder if nothing has run
 *  yet. Written identically by every run for a given plan, so it survives seeks. */
export async function getTranscodeInit(videoId: string, height: number): Promise<SegmentResult> {
  const plan = await getTranscodePlan(videoId, height)
  if (!plan) return 'unavailable'
  const dir = sessionDir(plan)
  const file = join(dir, 'init.mp4')
  if (fileSize(file) > 0) return file
  const started = await startSession(plan, 0)
  if (started !== 'ok') return started
  return (await waitForFile(file, planKey(videoId, height), true)) ? file : 'unavailable'
}

const sessionDir = (plan: TranscodePlan) => join(ROOT, `${plan.videoId}-${plan.height}`)

/** How far the CURRENT run has got: the last index in the unbroken chain from where this
 *  ffmpeg started. Deliberately not "highest index on disk": segments left behind by an
 *  earlier run at a different seek point would otherwise make a request that the encoder
 *  will reach in a second look like a far-future seek, restarting ffmpeg on every segment. */
function runHead(dir: string, startIndex: number): number {
  let i = startIndex
  while (existsSync(join(dir, `seg${i}.m4s`))) i++
  return i - 1
}

const fileSize = (path: string): number => { try { return statSync(path).size } catch { return -1 } }

/** Block until ffmpeg has written `file`. Segments are renamed into place by the muxer's
 *  temp_file flag, so any non-empty size means complete, but the fMP4 init file is NOT
 *  written that way, so it has to be seen at the same non-zero size twice before it can be
 *  handed out (a player that gets a truncated init fails the whole stream). */
async function waitForFile(file: string, key: string, stable = false): Promise<boolean> {
  const deadline = Date.now() + SEGMENT_WAIT_MS
  let lastSize = -1
  while (Date.now() < deadline) {
    const size = fileSize(file)
    if (size > 0 && (!stable || size === lastSize)) return true
    lastSize = size
    const s = sessions.get(key)
    if (!s || s.stopped) return fileSize(file) > 0    // encoder died, one last look
    await new Promise(r => setTimeout(r, 150))
  }
  return false
}

/**
 * A path in the shape ffmpeg's HLS muxer needs for its output arguments.
 *
 * `-hls_fmp4_init_filename` is a bare filename, and hlsenc.c resolves it against the
 * playlist's directory by doing `strrchr(m3u8_name, '/')` — forward slash only, on every
 * platform. A Windows path is all backslashes, so that search finds nothing and the muxer
 * falls back to writing the init segment to the process CWD. Segments are unaffected
 * (`-hls_segment_filename` is passed through whole), which is exactly what production
 * showed: 4K segments served fine while `#EXT-X-MAP` 404'd forever.
 *
 * Handing ffmpeg '/'-separated paths makes that search succeed everywhere. Splitting on
 * `sep` is a literal no-op on POSIX (where a backslash is a legal filename character and
 * must be left alone) and rewrites `C:\…\ff.m3u8` to `C:/…/ff.m3u8` on Windows, which
 * ffmpeg accepts anywhere it accepts a path.
 */
const ffPath = (p: string) => p.split(sep).join('/')

/**
 * Streaming quality args per hardware encoder, replacing resolveVideoEncoder()'s own args:
 * those are tuned for offline file re-encodes where size matters. This tier streams over the
 * home LAN where bandwidth is nearly free, and the VP9/AV1 source at these heights typically
 * runs 15-20 Mbps, so quality gets the generous end: constant-quality VBR with a rate ceiling
 * comfortably ABOVE the source bitrate so the encode is never starved below what it decodes.
 * Returns null for codecs without a tier-specific set (the caller then uses the encoder's own
 * args). libx265 never reaches here: buildPlan withholds the tier for non-hardware encoders.
 */
function tierQualityArgs(codec: string, height: number): string[] | null {
  const is4k = height > 1440
  switch (codec) {
    case 'hevc_nvenc':
      // p5+hq is still a few times realtime for 4K HEVC on the production RTX 3070, cq 20
      // is visually transparent for streamed content, and spatial AQ claws back detail in
      // the flat regions NVENC otherwise smears at high resolution.
      return [
        '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', '20', '-b:v', '0',
        '-maxrate', is4k ? '40M' : '24M', '-bufsize', is4k ? '80M' : '48M',
        '-spatial-aq', '1', '-tag:v', 'hvc1',
      ]
    case 'hevc_videotoolbox':
      // VideoToolbox has no cq/maxrate pair worth using; -q:v 65 lands 4K well above the
      // source's perceptual quality on Apple Silicon.
      return ['-q:v', '65', '-tag:v', 'hvc1']
    default:
      return null
  }
}

async function startSession(plan: TranscodePlan, index: number): Promise<'ok' | 'capacity'> {
  const key = planKey(plan.videoId, plan.height)
  const existing = sessions.get(key)
  // A restart of a session we already own never counts against the cap; a brand-new one does.
  if (!existing && sessions.size >= MAX_SESSIONS) {
    logger.warn(`[youtube/hls] transcode capacity reached (${sessions.size}/${MAX_SESSIONS}), refusing ${plan.videoId}@${plan.height}p`)
    return 'capacity'
  }
  if (existing) stopProcess(existing)

  // Sessions never outlive the process, so anything already in the root is from a crash.
  // Shared promise, not a boolean: two requests racing at boot must not have one of them
  // create its session directory while the other is still deleting the tree.
  rootSweep ??= rm(ROOT, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
  await rootSweep
  const dir = sessionDir(plan)
  await mkdir(dir, { recursive: true })

  const encoder = await resolveVideoEncoder()
  const bin = encoder.codec === 'hevc_nvenc' ? await ensureNvencFfmpeg() : await ensureFfmpeg()
  const quality = tierQualityArgs(encoder.codec, plan.height) ?? encoder.args
  const startSec = index * SEGMENT_SEC
  const inputFlags = [
    '-user_agent', UA,
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2',
  ]
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    // Hardware decode when the build has one (NVDEC for VP9/AV1 on the production box,
    // VideoToolbox on a Mac); silently software otherwise, which is why it's `auto`.
    '-hwaccel', 'auto',
    ...inputFlags, '-ss', String(startSec), '-i', plan.urls.video,
    ...inputFlags, '-ss', String(startSec), '-i', plan.urls.audio,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', encoder.codec, ...quality,
    // Pin Main/8-bit so the CODECS string we advertised is the truth even for a 10-bit
    // (HDR) source, and keyframe exactly on the segment grid so every segment starts on
    // an IDR and lines up with the playlist the client already has.
    '-profile:v', 'main', '-pix_fmt', 'yuv420p',
    '-force_key_frames', `expr:gte(t,${startSec}+n_forced*${SEGMENT_SEC})`,
    ...(plan.copyAudio ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '160k']),
    // Keep the source timestamps so this run's segments sit at their real place on the
    // timeline. Both are needed: without -copyts the seek rebases to zero, and without
    // -avoid_negative_ts disabled the MP4 muxer helpfully rebases it right back (measured:
    // a run started at segment 100 emitted segments stamped 0-4s, which would make the
    // player render a seek to 400s as the start of the video).
    '-copyts', '-avoid_negative_ts', 'disabled',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_SEC),
    '-hls_segment_type', 'fmp4',
    // Bare filename by necessity: the muxer concatenates this onto the playlist's own
    // directory, so an absolute path here would come out doubled. ffPath + cwd below are
    // what make "the playlist's directory" resolve to `dir` on every platform.
    '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', ffPath(join(dir, 'seg%d.m4s')),
    // temp_file is load-bearing: without it a segment file exists while still being
    // written, and the player would happily fetch a truncated one.
    '-hls_flags', 'temp_file+independent_segments',
    '-start_number', String(index),
    '-hls_list_size', '0',
    ffPath(join(dir, 'ff.m3u8')),
  ]

  const session: Session = { key, dir, plan, proc: null, startIndex: index, lastAccess: Date.now(), stopped: false }
  sessions.set(key, session)
  // cwd is the second half of pinning the init segment: any path the muxer still treats as
  // relative (init.mp4 above, and its own temp files) then lands in the session directory
  // instead of wherever the backend happens to have been started from.
  const proc = spawn(bin, args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
  session.proc = proc
  deprioritizeEncode(proc.pid)
  let err = ''
  proc.stderr?.on('data', (d) => { err = (err + String(d)).slice(-2048) })
  proc.on('error', (e) => {
    session.stopped = true
    logger.warn(`[youtube/hls] transcode spawn failed for ${plan.videoId}@${plan.height}p: ${e}`)
  })
  proc.on('close', (code) => {
    session.stopped = true
    if (code) logger.warn(`[youtube/hls] transcode exited ${code} for ${plan.videoId}@${plan.height}p from segment ${index}: ${err.slice(-400)}`)
  })
  // The one line that answers "why is 4K slow/soft": encoder, its exact quality args, and
  // the capability-probe trail that picked it.
  logger.info(`[youtube/hls] transcode ${plan.videoId} ${plan.sourceCodec} ${plan.width}x${plan.height} → ${encoder.codec} [${quality.join(' ')}] from segment ${index} (${encoder.reason})`)
  startReaper()
  return 'ok'
}

function stopProcess(s: Session): void {
  s.stopped = true
  try { s.proc?.kill('SIGKILL') } catch { /* already gone */ }
  s.proc = null
}

/** Keep only a trailing window of segments so a long watch can't fill the disk (4K HEVC
 *  runs ~8MB per 4s segment). Anything pruned is simply re-encoded if the user seeks back. */
async function pruneOldSegments(dir: string, current: number): Promise<void> {
  try {
    const names = await readdir(dir)
    for (const name of names) {
      const m = /^seg(\d+)\.m4s$/.exec(name)
      if (m && Number(m[1]) < current - KEEP_SEGMENTS) await unlink(join(dir, name)).catch(() => {})
    }
  } catch { /* dir went away with the session */ }
}

function startReaper(): void {
  if (reaper) return
  reaper = setInterval(() => {
    const now = Date.now()
    for (const [key, s] of sessions) {
      if (now - s.lastAccess < IDLE_MS) continue
      sessions.delete(key)
      stopProcess(s)
      // maxRetries: the encoder's cwd is this directory, and Windows keeps it locked for a
      // moment after the kill.
      void rm(s.dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => {})
      logger.info(`[youtube/hls] reaped idle transcode session ${key}`)
    }
    if (!sessions.size && reaper) { clearInterval(reaper); reaper = null }
  }, 15_000)
  reaper.unref?.()
}

/** Live session count, surfaced so the client can be told "the encoders are busy". */
export const transcodeSessionCount = () => sessions.size
