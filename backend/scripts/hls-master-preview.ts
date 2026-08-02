// Standalone eyeball check for the transcode-free HLS improvements: resolves a video
// via LIVE InnerTube, prints the avc1/mp4a format pool the pickers see, then the master
// playlist (with the subtitles rendition forced on so its tags are visible), the head of
// the I-frame playlist, and the loudnessDb value. Usage:
//   bun run scripts/hls-master-preview.ts [videoId]
import { getHlsPresentation, hlsMasterPlaylist, hlsIframePlaylist, hlsSubtitlePlaylist } from '../src/lib/youtube/hls'
import { innertubePlayerStreams, innertubeLoudnessDb } from '../src/lib/youtube/innertube'

const id = process.argv[2] ?? 'dQw4w9WgXcQ'

const streams = await innertubePlayerStreams(id)
console.log(`── formats for ${id} ─────────────────────────`)
for (const f of streams?.video ?? []) {
  if (/avc1/i.test(f.mime)) console.log(`  video itag=${f.itag} height=${f.height} fps=${f.fps} bitrate=${f.bitrate}`)
}
for (const f of streams?.audio ?? []) {
  if (/mp4a|audio\/mp4/i.test(f.mime)) console.log(`  audio itag=${f.itag} bitrate=${f.bitrate} mime=${f.mime.split(';')[0]}`)
}
console.log(`  loudnessDb=${await innertubeLoudnessDb(id)}`)

const pres = await getHlsPresentation(id)
if (!pres) {
  console.log('no HLS presentation (no avc1 pair above the progressive ceiling)')
  process.exit(1)
}
console.log('\n── chosen tracks ─────────────────────────────')
const desc = (label: string, t: { itag: number; width: number; height: number; fps: number | null; peakBitrate: number | null; codec: string; segments: unknown[] }) =>
  console.log(`  ${label}: itag=${t.itag} ${t.width}x${t.height} fps=${t.fps} peak=${t.peakBitrate} codec=${t.codec} segments=${t.segments.length}`)
desc('video ', pres.video)
if (pres.video720) desc('video720', pres.video720)
desc('audio ', pres.audio as any)

console.log('\n── master playlist (subtitles forced on) ─────')
console.log(hlsMasterPlaylist(pres, { subtitles: true }))
console.log('── master playlist (no subtitles on disk) ────')
console.log(hlsMasterPlaylist(pres))
console.log('── iframe playlist head ──────────────────────')
console.log(hlsIframePlaylist(pres.video720 ?? pres.video, pres.video720 ? 'video.mp4?v=720' : 'video.mp4').split('\n').slice(0, 14).join('\n'))
console.log('  ...')
console.log('\n── subtitle playlist ─────────────────────────')
console.log(hlsSubtitlePlaylist(pres.video.duration))
process.exit(0)
