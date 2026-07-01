// Disfluency post-processing pass — adds natural spoken-word imperfections to an already-
// generated script. Runs as a SEPARATE pass after all content generation is complete.
//
// Why separate: asking one model to simultaneously "write coherent content" AND "add
// natural imperfections" produces uniform um-spam or nothing at all. Every major open-source
// pipeline (DavranDev, NotebookLlama) independently discovered the dedicated rewrite pass.
//
// For Kokoro TTS: disfluencies must be in the TEXT layer (unlike NotebookLM which bakes
// them into its audio model). Only plain text patterns work — no SSML or markup tokens.
// Kokoro handles "um", "uh", trailing "..." and punctuation-based prosody cues well.

import { getFastModel } from '@/lib/models'
import { ollamaChat } from '@/llm/ollama'
import type { ScriptTurn } from './types'

const BATCH_SIZE = 15

// Preserve this many sign-off turns at the end — closings should sound clean and final.
const SIGN_OFF_PRESERVE = 6

const SYSTEM =
  'You add natural spoken-word imperfections to podcast dialogue. ' +
  'Write as if producing an ASR transcript of a real conversation — include the natural ' +
  'informality, incomplete thoughts, and verbal rhythms of real speech, not clean prose.\n\n' +
  'WHAT TO ADD (each pattern used at most once every 4-5 turns — NOT in every turn):\n' +
  '- Filled pauses mid-thought: "um", "uh" before a complex word or when pivoting to a new idea\n' +
  '- Self-corrections: "I mean", "or — well, more like", "wait no"\n' +
  '- Filler bridges: "so", "like", "you know" to start or connect a thought\n' +
  '- Backchannel agreements as SEPARATE 1-word turns: if one host explains 2+ sentences,\n' +
  '  insert a new turn {"host":"<other>","text":"Right."} or "Yeah." or "Mm." between them\n' +
  '- Trailing-off with "..." when the next speaker naturally interrupts\n\n' +
  'SPEAKER ASYMMETRY (important): Give most backchannels and um/uh hesitations to the\n' +
  'less-expert or newcomer host. The expert or experienced host should use self-corrections\n' +
  '("I mean...", "or rather...") more than filled pauses — experts hesitate on phrasing,\n' +
  'not on knowledge.\n\n' +
  'WHAT NOT TO ADD:\n' +
  '- No more than one "um" or "uh" per turn\n' +
  '- No disfluency on factual claims (numbers, names, titles, dates)\n' +
  '- No "absolutely", "exactly", "definitely", "certainly" — worse than silence\n' +
  '- No "Great question", "That\'s fascinating", or any affirmation of a question\n' +
  '- No [LAUGH], [PAUSE], [INTERRUPT] markers — Kokoro TTS cannot use them\n' +
  '- Do not change factual content or meaning\n' +
  '- If a turn already sounds natural and informal, return it UNCHANGED\n\n' +
  'Return ONLY a JSON array in the same {"host","text"} format. You may insert extra\n' +
  'backchannel turns between existing ones, but do not remove any turns.'

interface HostInfo { id: string; name: string }

async function processBatch(
  batch: ScriptTurn[],
  hostInfos: HostInfo[],
  model: string,
): Promise<ScriptTurn[]> {
  if (!batch.length) return batch
  const formatted = batch.map(t => {
    const name = hostInfos.find(h => h.id === t.host)?.name ?? t.host
    return `${name}: ${t.text}`
  }).join('\n')

  try {
    const resp = await ollamaChat(model, [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Hosts: ${hostInfos.map(h => h.name).join(', ')}\n\nTurns to process:\n${formatted}` },
    ], undefined, { temperature: 0.9, num_predict: 2000 })

    const raw = resp.message?.content ?? ''
    const arr = raw.replace(/```[a-z]*\n?/gi, '').trim().match(/\[[\s\S]*\]/)?.[0]
    if (!arr) return batch

    let parsed: { host?: unknown; text?: unknown }[]
    try { parsed = JSON.parse(arr) } catch { return batch }
    if (!Array.isArray(parsed)) return batch

    // Normalize hosts back to ids
    const nameToId = new Map(hostInfos.map(h => [h.name.toLowerCase(), h.id]))
    const result: ScriptTurn[] = parsed
      .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
      .map(t => {
        const rawHost = String(t.host ?? '').trim()
        const id = nameToId.get(rawHost.toLowerCase())
          ?? hostInfos.find(h => h.id.toLowerCase() === rawHost.toLowerCase())?.id
          ?? batch.find(b => b.host === rawHost)?.host
          ?? rawHost
        return { host: id, text: String(t.text ?? '').trim() }
      })
      .filter(t => t.text)

    // Sanity check: result should have at least as many turns as the input batch
    // (backchannel inserts add turns; we should never lose turns)
    return result.length >= batch.length ? result : batch
  } catch {
    return batch
  }
}

/**
 * Apply a disfluency pass to a fully-generated script. Processes in batches of 15 to
 * stay within local model context limits. Skips the last SIGN_OFF_PRESERVE turns so
 * closings remain clean. Best-effort — any failing batch keeps its original turns.
 */
export async function applyDisfluencyPass(
  turns: ScriptTurn[],
  hostInfos: HostInfo[],
): Promise<ScriptTurn[]> {
  if (turns.length <= SIGN_OFF_PRESERVE || hostInfos.length === 0) return turns

  try {
    const model = await getFastModel()
    const body = turns.slice(0, -SIGN_OFF_PRESERVE)
    const signOff = turns.slice(-SIGN_OFF_PRESERVE)

    const processed: ScriptTurn[] = []
    for (let i = 0; i < body.length; i += BATCH_SIZE) {
      const batch = body.slice(i, i + BATCH_SIZE)
      const result = await processBatch(batch, hostInfos, model)
      processed.push(...result)
    }

    return [...processed, ...signOff]
  } catch {
    return turns
  }
}
