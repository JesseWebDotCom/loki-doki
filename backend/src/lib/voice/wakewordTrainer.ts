// In-app wakeword training pipeline.
//
// 1. Generates synthetic WAV samples of the wake phrase via the Kokoro TTS
//    sidecar (positives + unrelated phrases as negatives).
// 2. Runs backend/scripts/train_wakeword.py to extract openWakeWord embeddings,
//    train a logistic regression, and export a detector ONNX.
// 3. Saves the model to data/voice/wakewords/<id>.onnx.
//
// The emit callback receives structured progress objects; the SSE route streams
// them to the browser.

import { mkdir, writeFile, rm, readdir, stat, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { wakewordDir, wakewordTrainPython, isWakewordTrainInstalled, wakewordRirDir, isWakewordRirInstalled, ensureWakewordNoisePack, wakewordNoiseTrainDir, wakewordNoiseCalibDir, isWakewordNoisePackInstalled } from '@/lib/download'
import { kokoroUrl } from '@/lib/voice/config'
import { listKokoroVoices, type KokoroVoice } from '@/lib/voice/engines/kokoroEngine'
import { ollamaUrl } from '@/llm/ollama'
import { getModel } from '@/lib/models'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TRAIN_SCRIPT = resolve(__dirname, '../../../scripts/train_wakeword.py')
// onnxruntime-web embedding server (run under this same Bun binary) — see the
// --embed-runtime wiring below for why training must use the browser's runtime.
const EMBED_SCRIPT = resolve(__dirname, '../../../scripts/wake_embed_ortweb.mjs')

// How many synthetic samples to generate — more = slower but better accuracy.
// Speaker diversity (timbre/gender/accent) is the single biggest factor for a
// speaker-independent detector, so we spread positives across as many distinct
// voices as we can rather than repeating a few. (openWakeWord's own pipeline
// uses dozens of voices; we use every English voice the local Kokoro exposes.)
// Base clip counts are modest because the Python trainer augments each clip
// (reverb/noise/gain) into many effective samples — voice diversity matters
// more than raw count, so we keep many voices but few speeds.
const N_POSITIVE_PER_VOICE = 6    // speed variations per voice (all SPEED_VARIANTS)
const N_NEGATIVE_PHRASES   = 18   // unrelated phrases per voice
const MAX_POS_VOICES       = 28   // use every available voice for phonetic diversity
// Negative VOLUME is the top lever for a low false-accept rate, so cast a wider
// net than positives — more voices × more phrases. The Python trainer caps the
// final negative:positive ratio (NEG_PER_POS), so over-generating here is safe.
const MAX_NEG_VOICES       = 12

// Slower speeds produce longer audio → more frames per clip → more windows, so we
// weight toward them. Speeds above 1.0 can make short phrases sub-threshold for
// frame count, so the fastest stays at 1.1. (Per-clip pitch/formant jitter in the
// Python trainer adds the timbre variety that extra fast speeds would not.)
const SPEED_VARIANTS = [0.6, 0.7, 0.8, 0.9, 1.0, 1.1]

// Other assistant triggers, generated across the SAME voices as the positives so
// the model learns the WORD difference ("loki" vs "alexa"), not a voice cue. This
// is the targeted signal that pushes "hey alexa" below "hey loki".
const CONTRASTIVE_TRIGGERS = ['Hey Alexa.', 'Hey Google.', 'Hey Siri.', 'Hey Cortana.']

// Order voices to maximize gender + accent diversity: round-robin across
// (gender × accent) buckets so a capped slice is still balanced. Kokoro lists
// all American-female voices first, so a naive slice trained on one timbre.
function pickDiverseVoices(all: KokoroVoice[]): string[] {
  const en = all.filter((v) => !v.language || /^(en|a|b)/i.test(v.language))
  const buckets = new Map<string, string[]>()
  for (const v of en) {
    const key = `${(v.gender ?? '?').toLowerCase()[0]}|${(v.language ?? '?').slice(0, 5)}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(v.id)
  }
  const lists = [...buckets.values()]
  const out: string[] = []
  for (let i = 0; lists.some((l) => l.length); i++) {
    const l = lists[i % lists.length]!
    const id = l.shift()
    if (id) out.push(id)
  }
  return out
}

// Common English phrases that don't overlap with typical wake phrases.
const NEGATIVE_PHRASES = [
  'What time is it?',
  'Turn on the lights.',
  'Play some music please.',
  'Can you set a reminder?',
  'I need to go to the store.',
  'The weather looks nice today.',
  'How are you doing?',
  'Tell me a joke.',
  'What is the capital of France?',
  'I am going to make some coffee.',
  'Thank you very much.',
  'Please send me the report.',
  'Good morning everyone.',
  'Let me check my calendar.',
  'Did you see that movie?',
  'I will be there in five minutes.',
  'Can you open the window?',
  'The meeting starts at three.',
  'We need more milk and eggs.',
  'It was a really long day.',
  'Let me know when you arrive.',
  'I should probably get some sleep.',
  'Check your email.',
  'How does that sound to you?',
  'That is a great idea.',
  // Hard negatives: short utterances and "hey …" openers that share onset
  // sounds with common wake phrases. These force the model to require the full
  // phrase rather than firing on "hey" or an isolated syllable.
  'Hey there.',
  'Hey, how are you?',
  'Okay.',
  'Hello.',
  'Hey you.',
  'Oh, no way.',
  'Go ahead.',
  'Hold on a second.',
  'No thank you.',
  'Yes please.',
  'Hey, what is up?',
  'Come over here.',
  // Volume of the generic "hey <word>" SHAPE — not rhymes of any specific trained
  // phrase (that targeted discrimination is genNearMissPhrases()'s job, kept in its
  // own small bucket below; see that comment for why mixing the two hurts recall).
  // The detector otherwise learns "hey + roughly two syllables" as the trigger
  // rather than the actual phrase, so plain volume of ordinary "hey X" utterances
  // — unrelated to any particular wake word — teaches it the onset alone isn't enough.
  'Hey copy.', 'Hey pocket.', 'Hey lobby.', 'Hey monkey.', 'Hey cookie.', 'Hey pillow.',
  'Hey ticket.', 'Hey blanket.', 'Hey window.', 'Hey mountain.', 'Hey picture.', 'Hey cabinet.',
  'Hey party.', 'Hey plastic.', 'Hey history.', 'Hey mystery.', 'Hey chicken.', 'Hey bottle.',
  'Hey table.', 'Hey rabbit.', 'Hey city.', 'Hey summer.', 'Hey morning.', 'Hey weekend.',
  // Other assistant triggers as negatives. Per openWakeWord guidance these must
  // be CLEARLY different — NOT similar-sounding rhymes (e.g. "hey rocky" for
  // "hey loki"), which measurably hurt accuracy. Robust discrimination comes
  // from many augmented positives + diverse negatives, not from rhyming decoys.
  'Hey Alexa.',
  'Hey Google.',
  'Hey Siri.',
  'OK Google.',
  'Hey Cortana.',
  'Hey computer.',
  'Hey Jarvis.',
  'Hey Bixby.',
]

// Adversarial near-miss negatives. openWakeWord deliberately trains against
// phonetically-overlapping phrases (e.g. "hey jealous" for "hey jarvis") so the
// detector requires the WHOLE phrase, not an approximate match — these are its
// most discriminative negatives. We ask the local LLM for phrase-specific
// near-misses (rhymes / one-sound-off variants of THIS wake phrase) rather than a
// fixed list, because what's confusable depends entirely on the phrase. Kept to a
// modest count so they sharpen the boundary without dominating the negative set
// (which would teach "reject things near the phrase" too aggressively and hurt
// recall). Falls back to deterministic phonetic variants when Ollama is offline —
// it used to return [], silently shipping a model with NO near-miss negatives,
// which fires on rhymes ("hey lucky" for "hey loki").
function staticNearMissPhrases(phrase: string): string[] {
  const words = phrase.trim().toLowerCase().split(/\s+/)
  const name = words[words.length - 1] ?? phrase
  const lead = words.slice(0, -1).join(' ')
  const withLead = (w: string) => (lead ? `${lead} ${w}` : w)
  const out = new Set<string>()

  // Onset-consonant swaps (l→r/n/m/y, k→g/t, etc.) — one sound off at the front.
  const onsetSwaps: Record<string, string[]> = {
    b: ['p', 'd'], p: ['b', 't'], d: ['t', 'b'], t: ['d', 'k'], k: ['g', 't'], g: ['k', 'd'],
    l: ['r', 'n', 'y'], r: ['l', 'w'], m: ['n', 'b'], n: ['m', 'l'], s: ['z', 'sh'],
    j: ['ch', 'g'], f: ['v', 'th'], v: ['f', 'b'], h: ['wh', ''], w: ['r', 'v'],
    a: ['o'], e: ['a'], i: ['e'], o: ['a'], u: ['o'], c: ['k', 's'], q: ['k'], z: ['s'],
    x: ['s'], y: ['l'],
  }
  const first = name[0] ?? ''
  for (const sub of onsetSwaps[first] ?? ['m', 'r']) out.add(withLead(sub + name.slice(1)))

  // Interior vowel shifts — same shape, different nucleus.
  const vowelShift: Record<string, string> = { a: 'o', e: 'a', i: 'u', o: 'ee', u: 'i' }
  for (let i = 1; i < name.length; i++) {
    const ch = name[i]!
    const repl = vowelShift[ch]
    if (repl) { out.add(withLead(name.slice(0, i) + repl + name.slice(i + 1))); break }
  }

  // Suffix mutations — right onset, wrong ending.
  out.add(withLead(name.slice(0, Math.max(2, name.length - 2)) + 'key'))
  out.add(withLead(name.slice(0, Math.max(2, name.length - 2)) + 'la'))
  out.add(withLead(`${name.slice(0, 2)}${name.slice(0, 2)}y`))

  const want = phrase.trim().toLowerCase()
  return [...out].filter((p) => p !== want && p.length > 2).slice(0, 8)
}

async function genNearMissPhrases(phrase: string, signal?: AbortSignal): Promise<string[]> {
  try {
    const model = await getModel()
    const res = await fetch(`${ollamaUrl()}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `You generate adversarial "near-miss" phrases for training a wake-word detector NOT to fire on them.
Given a wake phrase, output short phrases that sound ACOUSTICALLY SIMILAR but are clearly DIFFERENT words — rhymes, one-syllable-off variants, or similar-onset phrases.
Respond ONLY with valid JSON: {"phrases":["...","..."]}
Rules:
- 6 to 8 phrases, each 1-4 words, real English words
- Must NOT be the wake phrase itself or a trivial capitalization/punctuation change
- Examples for "hey jarvis": "hey jealous", "hey harvest", "hey marcus", "hey service"`,
          },
          { role: 'user', content: phrase.trim() },
        ],
        format: 'json',
        stream: false,
        keep_alive: -1,
        // num_ctx matches the chat default — a bare call reloads the chat model's
        // runner at 4096 and back, costing ~2s and the KV cache mid-training.
        options: { temperature: 0.7, num_predict: 160, num_ctx: 8192 },
        think: false,
      }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    })
    if (!res.ok) return staticNearMissPhrases(phrase)
    const data = (await res.json()) as { message?: { content?: string } }
    const parsed = JSON.parse(data.message?.content ?? '{}') as { phrases?: unknown[] }
    const want = phrase.trim().toLowerCase()
    const fromLlm = (parsed.phrases ?? [])
      .filter((p): p is string => typeof p === 'string')
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && p.toLowerCase() !== want)
      .slice(0, 8)
    return fromLlm.length > 0 ? fromLlm : staticNearMissPhrases(phrase)
  } catch {
    return staticNearMissPhrases(phrase)
  }
}

// Encode mono float32 PCM as a 16-bit WAV (16 kHz) — for synthesizing noise/
// silence negatives locally without a TTS round-trip.
function pcmToWav(samples: Float32Array, sampleRate = 16_000): Buffer {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!))
    buf.writeInt16LE((s * 32767) | 0, 44 + i * 2)
  }
  return buf
}

// Noise/silence negatives. Real-world non-speech (room hum, silence, fan) is
// out-of-distribution for a speech-only negative set, so the detector fires on
// it unpredictably. Training on noise teaches "not speech → not the wake word".
async function writeNoiseNegatives(negDir: string): Promise<number> {
  const SR = 16_000
  const DUR = 3 // seconds → enough audio for several detector windows
  const N = SR * DUR
  let count = 0
  const write = async (s: Float32Array, tag: string) => {
    await writeFile(join(negDir, `noise_${tag}.wav`), pcmToWav(s, SR)); count++
  }

  // Real room/mic non-speech is LOW-FREQUENCY weighted (mains hum, fan, mic self-noise)
  // and frequently VERY quiet — quite unlike flat white noise + pure digital silence,
  // which is all the old set had. A detector trained only on speech + white noise sees
  // a quiet real room as out-of-distribution and fires on it (the "1.0 on silence" bug).
  // Cover many noise COLOURS across the quiet levels a device mic actually produces.
  const levels = [0.001, 0.002, 0.003, 0.005, 0.008, 0.013, 0.02, 0.04, 0.07, 0.12, 0.2]
  const colours = ['white', 'pink', 'brown', 'hum'] as const
  for (const amp of levels) {
    for (const colour of colours) {
      const s = new Float32Array(N)
      let p0 = 0, p1 = 0, p2 = 0, brown = 0
      const hum = 45 + Math.random() * 90 // 45–135 Hz mains-ish fundamental
      for (let i = 0; i < N; i++) {
        const w = Math.random() * 2 - 1
        let v: number
        if (colour === 'white') v = w
        else if (colour === 'pink') { // Paul Kellet pink-noise approximation
          p0 = 0.99765 * p0 + w * 0.0990460
          p1 = 0.96300 * p1 + w * 0.2965164
          p2 = 0.57000 * p2 + w * 1.0526913
          v = (p0 + p1 + p2 + w * 0.1848) / 3.5
        } else if (colour === 'brown') { brown = (brown + 0.02 * w) / 1.02; v = brown * 3.5 }
        else v = 0.6 * Math.sin((2 * Math.PI * hum * i) / SR) // mains hum + 2nd harmonic + hiss
               + 0.25 * Math.sin((2 * Math.PI * hum * 2 * i) / SR) + 0.15 * w
        const drift = 0.7 + 0.3 * Math.sin((i / N) * Math.PI) // slow non-stationarity
        s[i] = Math.max(-1, Math.min(1, v * amp * drift))
      }
      await write(s, `${colour}_${Math.round(amp * 1000)}`)
    }
  }
  // Pure digital silence — the single most common real input when the room is quiet.
  for (let k = 0; k < 6; k++) await write(new Float32Array(N), `silence_${k}`)
  return count
}

// Real household ambient recordings (MS-SNSD: babble/crowd talk, neighbor speech,
// PA announcements, kitchen/living-room/restaurant/office room tone) mixed
// directly into training negatives. Calibrating only the FIRE THRESHOLD against
// real audio without ever training the model on it just trades recall for
// false-accepts (measured: FA fell ~45% but recall collapsed from 83% to 42%) —
// the model itself has to see real ambient noise as negatives, not merely be
// scored against it afterward. Uses the TRAIN split; the held-out CALIB split
// (wakewordNoiseCalibDir, see --calib-dir below) is disjoint so eval never
// scores audio the model trained on. Best-effort: absence just means no real
// negatives this run.
async function writeRealNoiseNegatives(negDir: string): Promise<number> {
  try {
    await ensureWakewordNoisePack()
  } catch {
    return 0
  }
  if (!isWakewordNoisePackInstalled()) return 0
  let count = 0
  const dir = wakewordNoiseTrainDir()
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.wav')) continue
    await copyFile(join(dir, name), join(negDir, `real_${name}`))
    count++
  }
  return count
}

export interface TrainProgress {
  step: 'generating' | 'training' | 'done' | 'error'
  msg: string
  pct?: number
}

/**
 * Remove orphaned `.train_<id>_tmp` working dirs (each holds ~25 MB of synthesized
 * WAVs). trainWakeword() deletes its own on finish/error, but a HARD kill (SIGKILL,
 * run.sh's kill -9, a crash) skips that cleanup and leaves the dir behind. Call this
 * at boot — nothing is training then, so any dir older than `maxAgeMs` is stale.
 * Returns how many were removed.
 */
export async function cleanupStaleTrainingTmp(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  let removed = 0
  try {
    const dir = wakewordDir()
    const now = Date.now()
    for (const name of await readdir(dir)) {
      if (!name.startsWith('.train_') || !name.endsWith('_tmp')) continue
      const p = join(dir, name)
      try {
        const st = await stat(p)
        if (now - st.mtimeMs < maxAgeMs) continue // recent → may be an active training; leave it
        await rm(p, { recursive: true, force: true })
        removed++
      } catch { /* ignore a single entry */ }
    }
  } catch { /* dir missing — nothing to do */ }
  return removed
}

export async function trainWakeword(
  phrase: string,
  outputId: string,
  emit: (p: TrainProgress) => void,
  signal?: AbortSignal,
  trainingVoice?: string | null,
): Promise<{ onnxPath: string; threshold?: number; accuracy?: number }> {
  const tmpDir = join(wakewordDir(), `.train_${outputId}_tmp`)
  const posDir = join(tmpDir, 'positives')
  const negDir = join(tmpDir, 'negatives')
  const outOnnx = join(wakewordDir(), `${outputId}.onnx`)

  await mkdir(posDir, { recursive: true })
  await mkdir(negDir, { recursive: true })

  try {
    // ── Step 1: generate synthetic WAVs ──────────────────────────────────────
    emit({ step: 'generating', msg: 'Fetching voice list…' })
    const allVoices = await listKokoroVoices()

    // Default to the full diverse voice set (speaker-independent). Speaker
    // diversity — many timbres/genders/accents — is what teaches the model the
    // PHRASE rather than one TTS speaker's fingerprint, so it generalizes to the
    // user's real voice. Training on a single voice overfits to that one timbre
    // and barely fires on a real human (the "recognition is barely there" bug).
    // A specific trainingVoice is honored only as an explicit advanced override;
    // 'auto'/absent (not a real voice id) falls through to the diverse set.
    const balanced = pickDiverseVoices(allVoices)
    const available = new Set(allVoices.map((v) => v.id))
    const singleVoice = trainingVoice && available.has(trainingVoice) ? trainingVoice : null
    const voices = singleVoice ? [singleVoice] : balanced.slice(0, MAX_POS_VOICES)
    if (voices.length === 0) voices.push('am_santa')
    const negVoices = (balanced.length ? balanced : voices).slice(0, MAX_NEG_VOICES)

    const base = await kokoroUrl()

    const totalPos = voices.length * N_POSITIVE_PER_VOICE
    const totalNeg = negVoices.length * N_NEGATIVE_PHRASES
    const totalContrast = voices.length * CONTRASTIVE_TRIGGERS.length
    const genTotal = totalPos + totalNeg + totalContrast
    let generated = 0

    const synthesize = async (text: string, voice: string, speed: number, dest: string) => {
      if (signal?.aborted) throw new Error('aborted')
      const res = await fetch(`${base}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, speed }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      })
      if (!res.ok) throw new Error(`synthesize failed: ${res.status}`)
      const wav = await res.arrayBuffer()
      await writeFile(dest, Buffer.from(wav))
    }

    emit({ step: 'generating', msg: `Generating ${totalPos} positive + ${totalNeg} negative samples…`, pct: 0 })

    // Positive samples: a SINGLE utterance of the phrase, per voice × speed.
    // The trainer pads each clip with silence and labels only the detector
    // window where the COMPLETE phrase ends, so one clean utterance is exactly
    // what's wanted. (The old 4× repetition labeled every speech window positive,
    // which taught "any speech → wake" and collapsed the detector.)
    const posText = phrase
    for (const voice of voices) {
      for (let si = 0; si < N_POSITIVE_PER_VOICE; si++) {
        const speed = SPEED_VARIANTS[si % SPEED_VARIANTS.length]!
        const fname = `pos_${voice}_${String(si).padStart(2, '0')}.wav`
        await synthesize(posText, voice, speed, join(posDir, fname))
        generated++
        emit({ step: 'generating', msg: `Generated ${generated}/${genTotal} samples`, pct: Math.round(50 * generated / genTotal) })
      }
    }

    // Negative samples: shuffled phrase list per voice
    const negPhrases = [...NEGATIVE_PHRASES].sort(() => 0.5 - Math.sin(generated))
    let ni = 0
    for (const voice of negVoices) {
      for (let pi = 0; pi < N_NEGATIVE_PHRASES; pi++) {
        const text = negPhrases[(ni++) % negPhrases.length]!
        const fname = `neg_${voice}_${String(pi).padStart(2, '0')}.wav`
        await synthesize(text, voice, 1.0, join(negDir, fname))
        generated++
        emit({ step: 'generating', msg: `Generated ${generated}/${genTotal} samples`, pct: Math.round(50 * generated / genTotal) })
      }
    }

    // Contrastive trigger negatives: "hey alexa/google/siri/cortana" in the SAME
    // voices as the positives, so the model learns the word, not the speaker.
    for (const voice of voices) {
      for (let ti = 0; ti < CONTRASTIVE_TRIGGERS.length; ti++) {
        const text = CONTRASTIVE_TRIGGERS[ti]!
        const fname = `contrast_${voice}_${String(ti).padStart(2, '0')}.wav`
        await synthesize(text, voice, 1.0, join(negDir, fname))
        generated++
        emit({ step: 'generating', msg: `Generated ${generated}/${genTotal} samples`, pct: Math.round(50 * generated / genTotal) })
      }
    }

    // Adversarial near-miss negatives (phrase-specific, LLM-generated). Synthesized
    // across a subset of the positive voices so the model learns the WORD boundary,
    // not a voice cue — same rationale as the contrastive triggers above. Skipped
    // silently if the LLM is offline.
    const nearMiss = await genNearMissPhrases(phrase, signal)
    if (nearMiss.length) {
      // Full voice set, same rationale as CONTRASTIVE_TRIGGERS above — a near-miss
      // heard in only a handful of voices lets the model partly key on timbre
      // instead of the phonetic difference; every positive voice closes that gap.
      emit({ step: 'generating', msg: `Adding ${nearMiss.length} near-miss negatives ("${nearMiss.slice(0, 3).join('", "')}"…)…` })
      let nmi = 0
      for (const voice of voices) {
        for (let mi = 0; mi < nearMiss.length; mi++) {
          await synthesize(nearMiss[mi]!, voice, 1.0, join(negDir, `nearmiss_${voice}_${String(mi).padStart(2, '0')}.wav`))
          nmi++
        }
      }
      emit({ step: 'generating', msg: `Added ${nmi} near-miss negatives`, pct: 50 })
    }

    // Noise + silence negatives so the detector doesn't fire on ambient sound.
    const noiseCount = await writeNoiseNegatives(negDir)
    emit({ step: 'generating', msg: `Added ${noiseCount} noise/silence negatives`, pct: 50 })

    const realNoiseCount = await writeRealNoiseNegatives(negDir)
    if (realNoiseCount) emit({ step: 'generating', msg: `Added ${realNoiseCount} real-room negatives (MS-SNSD)`, pct: 50 })

    // ── Step 2: run Python training script ───────────────────────────────────
    emit({ step: 'training', msg: 'Training ONNX detector…', pct: 50 })

    const melPath = join(wakewordDir(), 'melspectrogram.onnx')
    const embPath = join(wakewordDir(), 'embedding_model.onnx')

    if (!existsSync(melPath) || !existsSync(embPath)) {
      throw new Error('Wakeword core models not installed. Install "Wake Word" from Admin → Features first.')
    }

    if (!isWakewordTrainInstalled()) {
      throw new Error('Wake Word Training not installed. Install "Wake Word Training" from Admin → Features first.')
    }

    // The browser runs the wake-word pipeline through onnxruntime-web (WASM),
    // whose embedding-model Conv kernels compute measurably differently (~25 per
    // dim) from native onnxruntime. A detector trained on NATIVE embeddings is fed
    // out-of-distribution features at runtime and never fires (the long-standing
    // "trains fine but the tester never matches" bug). So training extracts its
    // embeddings through the SAME runtime — wake_embed_ortweb.mjs, run under this
    // same Bun binary — making train and inference features bit-for-bit identical.
    // The openWakeWord negative-feature bank lives in native-embedding space, so
    // it is intentionally NOT used (it would crush the ort-web positives);
    // discrimination comes from the diverse synthesized negatives, which share the
    // ort-web feature space.
    const python = wakewordTrainPython()
    // Real room-impulse-response pack (bundled with the Wake Word Training install).
    // Passed only when present on disk — the trainer falls back to procedural reverb
    // otherwise, and nothing is ever fetched from the network at train time.
    const rirArgs = isWakewordRirInstalled() ? ['--rir-dir', wakewordRirDir()] : []
    // Threshold calibration against the HELD-OUT real-audio split (disjoint from the
    // real negatives mixed into training above) — never the same files the model saw.
    const calibArgs = isWakewordNoisePackInstalled() ? ['--calib-dir', wakewordNoiseCalibDir()] : []
    let calibratedThreshold: number | undefined
    let valAccuracy: number | undefined
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(python, [
        TRAIN_SCRIPT,
        '--mel',           melPath,
        '--embed',         embPath,
        '--positives',     posDir,
        '--negatives',     negDir,
        '--output',        outOnnx,
        '--embed-runtime', 'ortweb',
        '--node-bin',      process.execPath, // run the embed server under this Bun
        '--embed-script',  EMBED_SCRIPT,
        ...rirArgs,
        ...calibArgs,
      ])

      signal?.addEventListener('abort', () => proc.kill())

      let lineBuffer = ''
      proc.stdout.on('data', (chunk: Buffer) => {
        lineBuffer += chunk.toString()
        const lines = lineBuffer.split('\n')
        lineBuffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const parsed = JSON.parse(trimmed) as { msg?: string; done?: boolean; error?: boolean; threshold?: number; accuracy?: number }
            const pct = parsed.done ? 99 : 50 + Math.min(48, (parsed.msg?.length ?? 0))
            emit({ step: 'training', msg: parsed.msg ?? trimmed, pct })
            if (typeof parsed.threshold === 'number') calibratedThreshold = parsed.threshold
            if (typeof parsed.accuracy === 'number') valAccuracy = parsed.accuracy
            if (parsed.done) resolve()
          } catch {
            emit({ step: 'training', msg: trimmed, pct: 75 })
          }
        }
      })

      proc.stderr.on('data', (chunk: Buffer) => {
        const txt = chunk.toString().trim()
        if (!txt) return
        console.error('[wakeword-trainer]', txt)
        // Forward to SSE so the user sees Python tracebacks in the UI
        for (const line of txt.split('\n').filter(Boolean)) {
          emit({ step: 'training', msg: line.slice(0, 200), pct: 60 })
        }
      })

      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Training script exited with code ${code}`))
      })

      proc.on('error', reject)
    })

    return { onnxPath: outOnnx, threshold: calibratedThreshold, accuracy: valAccuracy }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => null)
  }
}

