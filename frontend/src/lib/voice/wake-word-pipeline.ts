// Browser-side wake-word inference scaffold. Ported verbatim from v2.
//
// 16 kHz Float32 PCM processed in 1280-sample (80 ms) frames through three ONNX
// sessions: mel → embedding → detector → scalar score in [0,1]. The continuous
// loop (wake-word-loop.ts) drives this stage-by-stage; this module exposes the
// pipeline loader + seeding constants it shares.

import { SHARED_MEL_PATH, SHARED_EMBEDDING_PATH, getWakeWordModel } from "./wake-word-models"
import { getOrLoadSession, type WakeWordInferenceSession } from "./wake-word-runtime"

export const WAKE_WORD_FRAME_SAMPLES = 1280
export const WAKE_WORD_SAMPLE_RATE = 16_000
export const MEL_FEATURE_DIM = 32
export const MEL_BUFFER_SEED_FRAMES = 76
export const EMBEDDING_DIM = 96
// Rolling raw-audio window (~2.2 s). Each 80 ms chunk, the mel spectrogram is
// recomputed over this WHOLE window and the trailing 76 mel frames become one
// embedding — openWakeWord's feature convention. Computing mel per isolated
// 1280-sample chunk (the old approach) yields features only ~0.71 cosine-similar
// to openWakeWord, destroying phonetic detail so detectors fire on any speech.
// MUST equal BUF in backend/scripts/train_wakeword.py so train and run match.
export const RAW_AUDIO_BUFFER_SAMPLES = 35_200
export const EMBEDDING_BUFFER_SECONDS = 4
export const EMBEDDING_BUFFER_FRAMES = Math.round(
  (EMBEDDING_BUFFER_SECONDS * WAKE_WORD_SAMPLE_RATE) / WAKE_WORD_FRAME_SAMPLES,
)
export const DETECTOR_INPUT_FRAMES = 16
export const WARMUP_ZERO_FRAMES = 5

export interface WakeWordPipelineState {
  readonly mel: WakeWordInferenceSession
  readonly embedding: WakeWordInferenceSession
  readonly detector: WakeWordInferenceSession
  readonly modelId: string
}

export async function loadPipeline(modelId: string): Promise<WakeWordPipelineState> {
  const entry = getWakeWordModel(modelId)
  const [mel, embedding, detector] = await Promise.all([
    getOrLoadSession(SHARED_MEL_PATH),
    getOrLoadSession(SHARED_EMBEDDING_PATH),
    getOrLoadSession(entry.assetPath),
  ])
  return { mel, embedding, detector, modelId }
}

export function seedEmbeddingBuffer(seed: number): Float32Array {
  const buf = new Float32Array(EMBEDDING_BUFFER_FRAMES * EMBEDDING_DIM)
  let state = seed >>> 0
  for (let i = 0; i < buf.length; i++) {
    state = (state * 1664525 + 1013904223) >>> 0
    buf[i] = (state / 0xffffffff - 0.5) * 0.02
  }
  return buf
}
