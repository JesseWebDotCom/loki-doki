// Shared multi-voice audio-assembly primitives, extracted out of render.ts once
// the Books app's EPUB→audiobook conversion became a second caller (per the
// original plan's note: "duplicate now, share once there's a third caller" — the
// Books app IS that third caller relative to podcast/audio.ts, so this is the
// shared home instead of a second duplication).

import { spawn } from 'node:child_process'
import { voiceServerLocalUrl } from '@/lib/voiceServer'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { segmentSentences } from '@/lib/voice/sentenceSegmenter'
import { stripForSpeech } from '@/lib/voice/speechText'

export const SAMPLE_RATE = 24000
const BITS_PER_SAMPLE = 16
const NUM_CHANNELS = 1
const BYTES_PER_SAMPLE = BITS_PER_SAMPLE / 8
const MIN_SPEED = 0.8
export const BETWEEN_TURN_SILENCE_SEC = 0.25

export function bareVoiceId(qualified: string): string {
  return qualified.includes(':') ? qualified.split(':')[1]! : qualified
}

export function buildSilencePcm(durationSec: number): Buffer {
  const numSamples = Math.floor(durationSec * SAMPLE_RATE)
  return Buffer.alloc(numSamples * BYTES_PER_SAMPLE, 0)
}

/** Extract 16-bit mono PCM from a WAV, converting from the voice server's 32-bit
 *  float output when needed. Mirrors podcast/audio.ts::extractPcmFromWav. */
export function extractPcmFromWav(wavBuffer: Buffer): Buffer {
  let offset = 12
  let audioFormat = 1
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
    offset += 8 + chunkSize + (chunkSize % 2)
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
  return Buffer.alloc(0)
}

export function buildWavBuffer(pcm: Buffer): Buffer {
  const dataSize = pcm.length
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
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
    const res = await fetch(`${voiceServerLocalUrl()}/synthesize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, speed }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    return Buffer.from(await res.arrayBuffer())
  } catch {
    return null
  }
}

export async function wavToMp3(wavPath: string, mp3Path: string, title: string): Promise<void> {
  const ffmpeg = await ensureFfmpeg()
  const args = ['-y', '-i', wavPath, '-metadata', `title=${title}`, '-codec:a', 'libmp3lame', '-q:a', '2', mp3Path]
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(ffmpeg, args, { stdio: 'ignore', windowsHide: true })
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')) }, 5 * 60_000)
    proc.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)) })
    proc.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

export interface RenderTurn { voice: string; speed: number; text: string }

/** Synthesize a sequence of (voice, text) turns into one PCM buffer, with a short
 *  silence between turns. Used for both narration-session export and per-chapter
 *  audiobook rendering. */
export async function synthesizeTurnsToPcm(
  turns: RenderTurn[],
  onProgress?: (index: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ pcm: Buffer; durationSec: number; spoken: number }> {
  const pcmChunks: Buffer[] = []
  let totalSamples = 0
  let spoken = 0
  const SILENCE = buildSilencePcm(BETWEEN_TURN_SILENCE_SEC)

  for (let i = 0; i < turns.length; i++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const turn = turns[i]!
    onProgress?.(i, turns.length)

    for (const sentence of segmentSentences(stripForSpeech(turn.text))) {
      if (!sentence.trim()) continue
      const wavBuf = await synthesizeSentence(sentence, turn.voice, Math.max(MIN_SPEED, turn.speed))
      if (!wavBuf) continue
      const pcm = extractPcmFromWav(wavBuf)
      if (pcm.length === 0) continue
      pcmChunks.push(pcm)
      totalSamples += pcm.length / BYTES_PER_SAMPLE
      spoken++
    }
    if (i < turns.length - 1) {
      pcmChunks.push(SILENCE)
      totalSamples += SILENCE.length / BYTES_PER_SAMPLE
    }
  }

  return { pcm: Buffer.concat(pcmChunks), durationSec: totalSamples / SAMPLE_RATE, spoken }
}
