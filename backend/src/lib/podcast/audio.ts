// TTS → WAV assembly → ffmpeg MP3 conversion for podcast episodes.

import { spawn } from 'node:child_process'
import { mkdir, writeFile, unlink, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { voiceServerLocalUrl } from '@/lib/voiceServer'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { segmentSentences } from '@/lib/voice/sentenceSegmenter'
import { stripForSpeech } from '@/lib/voice/speechText'
import type { ScriptTurn, EpisodeChapter } from './types'

const DEFAULT_VOICE = 'af_heart'
// Floor on speaking rate — Kokoro at 1.0 sounds slow/announcer-like; real conversation
// sits a touch faster. Every podcast voice is sped up to at least this.
const MIN_SPEED = 1.2
// Tight gap between turns so the back-and-forth feels conversational, not walkie-talkie.
const BETWEEN_TURN_SILENCE_SEC = 0.18
const STINGER_GAP_SEC = 0.3        // breath between the music sting and speech
const STINGER_FADE_SEC = 0.35      // edge fade so clips never click
const SAMPLE_RATE = 24000
const BITS_PER_SAMPLE = 16
const NUM_CHANNELS = 1
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8

function buildSilencePcm(durationSec: number): Buffer {
  const numSamples = Math.floor(durationSec * SAMPLE_RATE)
  return Buffer.alloc(numSamples * BYTES_PER_SAMPLE, 0)
}

/**
 * Extract a WAV's audio as 16-bit mono PCM, regardless of source format.
 * The voice server (kokoro-js) emits 24 kHz mono *IEEE float (32-bit)* WAVs, but the
 * episode is assembled as 16-bit PCM — so we must convert, or the audio is noise at the
 * wrong speed. Handles float32 and passes through int16.
 */
function extractPcmFromWav(wavBuffer: Buffer): Buffer {
  let offset = 12
  let audioFormat = 1   // 1 = PCM int, 3 = IEEE float
  let bitsPerSample = 16
  let dataStart = -1
  let dataSize = 0
  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4)
    const chunkSize = wavBuffer.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ') {
      audioFormat = wavBuffer.readUInt16LE(offset + 8)
      bitsPerSample = wavBuffer.readUInt16LE(offset + 8 + 14)
    } else if (chunkId === 'data') {
      dataStart = offset + 8
      dataSize = chunkSize
      break
    }
    offset += 8 + chunkSize + (chunkSize % 2) // chunks are word-aligned
  }
  if (dataStart < 0) return Buffer.alloc(0)
  const data = wavBuffer.subarray(dataStart, dataStart + dataSize)

  if (audioFormat === 1 && bitsPerSample === 16) return Buffer.from(data)

  if (audioFormat === 3 && bitsPerSample === 32) {
    const n = Math.floor(data.length / 4)
    const out = Buffer.alloc(n * 2)
    for (let i = 0; i < n; i++) {
      const s = Math.max(-1, Math.min(1, data.readFloatLE(i * 4)))
      out.writeInt16LE(Math.round(s * 32767), i * 2)
    }
    return out
  }

  // Unknown/unsupported format — drop rather than emit noise.
  return Buffer.alloc(0)
}

/** Linear fade-in/out over 16-bit mono PCM (returns a faded copy). Keeps stinger
 *  edges from clicking when butted up against silence/speech. */
function applyFade(pcm: Buffer, fadeInSec: number, fadeOutSec: number): Buffer {
  const out = Buffer.from(pcm)
  const total = Math.floor(out.length / BYTES_PER_SAMPLE)
  if (total === 0) return out
  const fin = Math.min(Math.floor(fadeInSec * SAMPLE_RATE), Math.floor(total / 2))
  const fout = Math.min(Math.floor(fadeOutSec * SAMPLE_RATE), Math.floor(total / 2))
  for (let i = 0; i < fin; i++) {
    out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * (i / fin)), i * 2)
  }
  for (let i = 0; i < fout; i++) {
    const idx = total - 1 - i
    out.writeInt16LE(Math.round(out.readInt16LE(idx * 2) * (i / fout)), idx * 2)
  }
  return out
}

/** Read a stored stinger WAV → faded 16-bit mono PCM (empty buffer on any problem). */
async function loadStingerPcm(absPath: string): Promise<Buffer> {
  const wav = await readFile(absPath)
  const pcm = extractPcmFromWav(wav)
  if (pcm.length === 0) return Buffer.alloc(0)
  return applyFade(pcm, STINGER_FADE_SEC, STINGER_FADE_SEC)
}

function buildWavBuffer(pcm: Buffer): Buffer {
  const dataSize = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)                                             // PCM
  header.writeUInt16LE(NUM_CHANNELS, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * NUM_CHANNELS * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(NUM_CHANNELS * BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(BITS_PER_SAMPLE, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcm])
}

async function synthesizeSentence(text: string, voice: string, speed: number): Promise<Buffer | null> {
  try {
    const base = voiceServerLocalUrl()
    const res = await fetch(`${base}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } catch {
    return null
  }
}

async function wavToMp3(
  wavPath: string,
  mp3Path: string,
  metadata: { title: string; artist: string; album?: string },
  coverAbsPath?: string,
): Promise<void> {
  const args = ['-y', '-i', wavPath]

  if (coverAbsPath) {
    args.push('-i', coverAbsPath)
    args.push('-map', '0:a', '-map', '1:v')
    args.push('-metadata:s:v', 'comment=Cover (front)')
    args.push('-disposition:v', 'attached_pic')
  }

  args.push(
    '-metadata', `title=${metadata.title}`,
    '-metadata', `artist=${metadata.artist}`,
    ...(metadata.album ? ['-metadata', `album=${metadata.album}`] : []),
    '-codec:a', 'libmp3lame', '-q:a', '2',
    '-id3v2_version', '3',
    mp3Path,
  )

  // Resolve ffmpeg (PATH → managed copy → auto-download a static build) before encoding.
  const ffmpeg = await ensureFfmpeg()

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: 'ignore' })
    // A wedged ffmpeg (e.g. a corrupt cover image) would otherwise hang the job forever and
    // hold the queue's single local slot — bound it and SIGKILL on timeout.
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')) }, 5 * 60_000)
    proc.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)) })
    proc.on('error', err => { clearTimeout(timer); reject(err) })
  })
}

export interface AudioBuildResult {
  mp3AbsPath: string
  durationSec: number
  chapters: EpisodeChapter[]
}

/** Voices keyed by character id (look up before calling). */
export interface HostVoiceMap {
  [characterId: string]: { voice: string; speed: number }
}

export async function buildEpisodeAudio(
  turns: ScriptTurn[],
  hostVoices: HostVoiceMap,
  outDir: string,
  episodeId: string,
  metadata: { title: string; showName: string },
  coverAbsPath?: string,
  stinger?: { introAbsPath?: string; outroAbsPath?: string },
  onProgress?: (note: string) => void,
  signal?: AbortSignal,
): Promise<AudioBuildResult> {
  await mkdir(outDir, { recursive: true })

  const pcmChunks: Buffer[] = []
  const chapters: EpisodeChapter[] = []
  let totalSamples = 0
  let spokenSentences = 0   // actual synthesized speech (excludes silence padding)

  const SILENCE = buildSilencePcm(BETWEEN_TURN_SILENCE_SEC)
  const STINGER_GAP = buildSilencePcm(STINGER_GAP_SEC)

  // Intro music sting → plays before the first spoken line. Best-effort: a missing or
  // unreadable clip must never fail the episode.
  if (stinger?.introAbsPath) {
    try {
      const intro = await loadStingerPcm(stinger.introAbsPath)
      if (intro.length) {
        pcmChunks.push(intro, STINGER_GAP)
        totalSamples += (intro.length + STINGER_GAP.length) / BYTES_PER_SAMPLE
      }
    } catch { /* stinger optional */ }
  }

  // Group turns into chapters (one per unique segment label/turn-block)
  let lastHost = ''

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i]!
    const cfg = hostVoices[turn.host] ?? { voice: DEFAULT_VOICE, speed: 1.0 }
    const voice = cfg.voice
    const speed = Math.max(MIN_SPEED, cfg.speed)

    if (turn.host !== lastHost) {
      const startSec = Math.round((totalSamples / SAMPLE_RATE) * 10) / 10
      chapters.push({ title: `Part ${chapters.length + 1}`, startSec })
      lastHost = turn.host
    }

    onProgress?.(`Synthesizing turn ${i + 1}/${turns.length}…`)

    const sentences = segmentSentences(stripForSpeech(turn.text))
    for (const sentence of sentences) {
      // Stop promptly when the job is cancelled instead of synthesizing the whole script.
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
      if (!sentence.trim()) continue
      const wavBuf = await synthesizeSentence(sentence, voice, speed)
      if (!wavBuf) continue
      const pcm = extractPcmFromWav(wavBuf)
      if (pcm.length === 0) continue
      pcmChunks.push(pcm)
      totalSamples += pcm.length / BYTES_PER_SAMPLE
      spokenSentences++
    }

    // Silence between turns
    if (i < turns.length - 1) {
      pcmChunks.push(SILENCE)
      totalSamples += SILENCE.length / BYTES_PER_SAMPLE
    }
  }

  // Silence-only output (every sentence failed to synthesize) must NOT be saved as a
  // "ready" episode — surface it as a failure so the user sees why instead of a silent file.
  if (spokenSentences === 0) {
    throw new Error('Voice synthesis produced no speech — the TTS voice server failed to synthesize (check that the voice model is installed and loads).')
  }

  // Outro music sting → plays after the last spoken line (only on a real episode,
  // i.e. after the speech guard above). Best-effort like the intro.
  if (stinger?.outroAbsPath) {
    try {
      const outro = await loadStingerPcm(stinger.outroAbsPath)
      if (outro.length) {
        pcmChunks.push(STINGER_GAP, outro)
        totalSamples += (STINGER_GAP.length + outro.length) / BYTES_PER_SAMPLE
      }
    } catch { /* stinger optional */ }
  }

  const durationSec = Math.round(totalSamples / SAMPLE_RATE)
  const combinedPcm = Buffer.concat(pcmChunks)
  const wavBuf = buildWavBuffer(combinedPcm)

  onProgress?.('Converting to MP3…')
  const wavPath = join(outDir, `${episodeId}.wav`)
  const mp3Path = join(outDir, `${episodeId}.mp3`)

  await writeFile(wavPath, wavBuf)
  try {
    await wavToMp3(wavPath, mp3Path, { title: metadata.title, artist: metadata.showName }, coverAbsPath)
  } finally {
    // Always drop the temp WAV — including when ffmpeg conversion throws, or a full
    // uncompressed episode WAV leaks into the user's podcasts dir on every failed retry.
    await unlink(wavPath).catch(() => {})
  }

  return { mp3AbsPath: mp3Path, durationSec, chapters }
}
