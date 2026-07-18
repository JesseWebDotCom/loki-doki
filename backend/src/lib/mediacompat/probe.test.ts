import { describe, expect, test } from 'bun:test'
import { decideCompat, type CompatProbe } from './probe'
import { buildConvertArgs } from './transcode'

const probe = (over: Partial<CompatProbe>): CompatProbe => ({
  containerFormat: 'mov,mp4,m4a,3gp,3g2,mj2',
  videoCodec: 'h264',
  audioCodec: 'aac',
  durationSec: 60,
  width: 1920,
  height: 1080,
  hasVideo: true,
  hasAudio: true,
  ...over,
})

describe('decideCompat', () => {
  test('h264/aac in mp4 is compatible', () => {
    expect(decideCompat(probe({}))).toEqual({ kind: 'video', compatible: true, reasons: [] })
  })

  test('hevc in mp4 needs transcode', () => {
    const v = decideCompat(probe({ videoCodec: 'hevc' }))
    expect(v.compatible).toBe(false)
    expect(v.kind).toBe('video')
  })

  test('h264 in mkv needs transcode (container)', () => {
    const v = decideCompat(probe({ containerFormat: 'matroska,webm' }))
    expect(v.compatible).toBe(false)
  })

  test('h264 + ac3 audio needs transcode (audio codec)', () => {
    const v = decideCompat(probe({ audioCodec: 'ac3' }))
    expect(v.compatible).toBe(false)
    expect(v.reasons.join(' ')).toContain('ac3')
  })

  test('silent h264 mp4 is compatible', () => {
    expect(decideCompat(probe({ audioCodec: null, hasAudio: false })).compatible).toBe(true)
  })

  test('mp3 file is compatible audio', () => {
    const v = decideCompat(probe({ containerFormat: 'mp3', videoCodec: null, hasVideo: false, audioCodec: 'mp3' }))
    expect(v).toEqual({ kind: 'audio', compatible: true, reasons: [] })
  })

  test('flac and wav are compatible audio', () => {
    expect(decideCompat(probe({ containerFormat: 'flac', hasVideo: false, videoCodec: null, audioCodec: 'flac' })).compatible).toBe(true)
    expect(decideCompat(probe({ containerFormat: 'wav', hasVideo: false, videoCodec: null, audioCodec: 'pcm_s16le' })).compatible).toBe(true)
  })

  test('opus/vorbis/alac need transcode', () => {
    expect(decideCompat(probe({ containerFormat: 'ogg', hasVideo: false, videoCodec: null, audioCodec: 'opus' })).compatible).toBe(false)
    expect(decideCompat(probe({ containerFormat: 'ogg', hasVideo: false, videoCodec: null, audioCodec: 'vorbis' })).compatible).toBe(false)
    expect(decideCompat(probe({ hasVideo: false, videoCodec: null, audioCodec: 'alac' })).compatible).toBe(false)
  })

  test('audio file with embedded cover art stays kind=audio', () => {
    // probeCompat filters art streams out before this point; hasVideo=false models that.
    const v = decideCompat(probe({ containerFormat: 'flac', hasVideo: false, videoCodec: null, audioCodec: 'flac' }))
    expect(v.kind).toBe('audio')
  })
})

describe('buildConvertArgs', () => {
  test('h264-in-mkv remuxes video (copy) and keeps aac', () => {
    const args = buildConvertArgs(probe({ containerFormat: 'matroska,webm' }), 'video', 23)
    expect(args.join(' ')).toContain('-c:v copy')
    expect(args.join(' ')).toContain('-c:a copy')
  })

  test('hevc re-encodes with libx264 at the given CRF', () => {
    const args = buildConvertArgs(probe({ videoCodec: 'hevc' }), 'video', 20)
    const s = args.join(' ')
    expect(s).toContain('-c:v libx264')
    expect(s).toContain('-crf 20')
    expect(s).toContain('yuv420p')
  })

  test('ac3 audio is re-encoded even when video copies', () => {
    const s = buildConvertArgs(probe({ audioCodec: 'ac3' }), 'video', 23).join(' ')
    expect(s).toContain('-c:v copy')
    expect(s).toContain('-c:a aac')
  })

  test('audio variant drops video and encodes aac', () => {
    const s = buildConvertArgs(probe({ audioCodec: 'opus' }), 'audio', 23).join(' ')
    expect(s).toContain('-vn')
    expect(s).toContain('-c:a aac')
    expect(s).not.toContain('-c:v')
  })

  test('audio variant copies an already-aac track', () => {
    const s = buildConvertArgs(probe({}), 'audio', 23).join(' ')
    expect(s).toContain('-c:a copy')
  })

  test('silent video maps no audio stream', () => {
    const args = buildConvertArgs(probe({ hasAudio: false, audioCodec: null, videoCodec: 'mpeg4' }), 'video', 23)
    expect(args.join(' ')).not.toContain('-c:a')
    expect(args.join(' ')).not.toContain('0:a:0')
  })
})
