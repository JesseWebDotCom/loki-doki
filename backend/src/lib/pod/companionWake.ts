// Companion wake words for physical devices.
//
// A device should answer to its companion's name (e.g. "Hey Loki"), not the app
// default "Hey Jarvis". Companions ship a `wakeWordPhrase` but no trained detector,
// so the first time a device bound to a companion connects we auto-train an
// openWakeWord model from that phrase (Kokoro-synthesized samples → logistic
// regression → ONNX), attach it to the character, and from then on every device
// with that companion uses it. Training runs in the background and is deduped per
// character; until it finishes the device falls back to the app default.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { characters, wakeWordCatalog } from '@/db/schema'
import { trainWakeword } from '@/lib/voice/wakewordTrainer'
import { isWakewordTrainInstalled } from '@/lib/download'
import { logger } from '@/lib/logger'

// Characters with a training run in flight — never start a second for the same one.
const training = new Set<string>()

/**
 * Resolve the trained wake-word model id for a character. Returns the id if one
 * already exists; otherwise kicks off a background training run from the
 * character's phrase and returns null (the caller uses the app default until the
 * model is ready, which it picks up on the next connect).
 */
export async function ensureCompanionWakeword(characterId: string): Promise<string | null> {
  const [ch] = await db.select().from(characters).where(eq(characters.id, characterId)).limit(1)
  if (!ch) return null
  if (ch.wakeWordModelId) return ch.wakeWordModelId // already trained — use it

  const phrase = ch.wakeWordPhrase?.trim()
  if (!phrase) return null // nothing to train from
  if (!isWakewordTrainInstalled()) {
    logger.warn(`[pod] wake: training tools not installed — "${ch.name}" falls back to the app default`)
    return null
  }
  if (training.has(characterId)) return null // already in flight

  training.add(characterId)
  void trainInBackground(characterId, ch.name, phrase)
  return null
}

async function trainInBackground(characterId: string, name: string, phrase: string): Promise<void> {
  const slug = phrase.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const id = `trained_${slug}_${Date.now().toString(36)}`
  let lastStep = ''
  try {
    logger.info(`[pod] auto-training wake word "${phrase}" for companion "${name}"…`)
    const { threshold } = await trainWakeword(
      phrase,
      id,
      (p) => { if (p.step !== lastStep) { lastStep = p.step; logger.info(`[pod] wake-train "${phrase}": ${p.step}`) } },
      undefined,
      null, // train across the full diverse voice set (speaker-independent)
    )
    const now = new Date()
    await db.insert(wakeWordCatalog).values({
      id, label: phrase, kind: 'trained', assetPath: `${id}.onnx`,
      defaultThreshold: threshold ?? 0.6, characterId, enabled: true, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({ target: wakeWordCatalog.id, set: { assetPath: `${id}.onnx`, updatedAt: now } })
    // Attach to the character so every device with this companion uses it. Keep the
    // phrase (the in-app companion still Whisper-matches it); the model just takes
    // precedence for devices.
    await db.update(characters).set({ wakeWordModelId: id, updatedAt: now }).where(eq(characters.id, characterId))
    logger.info(`[pod] ✅ auto-trained wake word for "${name}" → say "${phrase}" (model ${id})`)
  } catch (e) {
    logger.warn(`[pod] wake auto-train failed for "${name}": ${(e as Error).message}`)
  } finally {
    training.delete(characterId)
  }
}
