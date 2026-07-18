// Trigger-token hygiene for LoRA prompts.
//
// Two jobs:
// 1. sanitizeTriggerTokens: CivitAI "trainedWords" frequently contain literal
//    A1111 syntax like "<lora:Name:0.8>" or comma-joined tag dumps. We apply
//    LoRAs as ComfyUI LoraLoader nodes, so that text is pure noise in the
//    prompt. Strip it, split joined lists into individual tags, and dedupe.
// 2. planLoraTokens: when two or more CHARACTER LoRAs are active at once, their
//    trigger lists each say "solo"/"1boy", which tells the model to draw ONE
//    subject and makes the stronger LoRA win both bodies. The plan removes the
//    conflicting tags, emits aggregate count tags ("2boys"), and hands back
//    per-character token lists so the caller can confine each identity to its
//    own region of the frame.

const LORA_TAG_RE   = /<\s*lora\s*:[^>]*(>|$)/gi
const ANGLE_JUNK_RE = /<[^>]*(>|$)/g

const SUBJECT_TAGS = ['1boy', '1girl', '1other'] as const
const SOLO_TAGS    = new Set(['solo', 'solo focus'])

function dedupe(tokens: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tokens) {
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }
  return out
}

export function sanitizeTriggerTokens(tokens: unknown): string[] {
  if (!Array.isArray(tokens)) return []
  const out: string[] = []
  for (const raw of tokens) {
    if (typeof raw !== 'string') continue
    // A single "token" from CivitAI can itself be a comma-joined tag list.
    for (const piece of raw.split(',')) {
      const cleaned = piece.replace(LORA_TAG_RE, '').replace(ANGLE_JUNK_RE, '').trim()
      if (cleaned) out.push(cleaned)
    }
  }
  return dedupe(out)
}

// A token list that carries subject-count or solo tags is a character LoRA:
// it was trained on solo images of one subject and will fight other character
// LoRAs for the whole frame.
export function isCharacterTokenList(tokens: string[]): boolean {
  const lower = new Set(tokens.map(t => t.toLowerCase()))
  return SUBJECT_TAGS.some(t => lower.has(t)) || [...SOLO_TAGS].some(t => lower.has(t))
}

export interface LoraTokenPlan {
  // True when 2+ character LoRAs are active and the caller should try to
  // region-separate them (and at minimum must not send "solo" twice).
  multiCharacter: boolean
  // Tokens for the global prompt when ALL LoRAs are applied globally
  // (single character, or regional prompting unavailable). Harmonized:
  // solo removed and subject counts aggregated when multiCharacter.
  globalTokens: string[]
  // Tokens for the global prompt when the character LoRAs are applied
  // per-region instead: aggregate count tags + non-character LoRA tokens only.
  baseTokens: string[]
  // One entry per detected character LoRA: its index into the input list and
  // the tokens for its region-scoped prompt (identity kept, solo dropped).
  characters: Array<{ index: number; regionTokens: string[] }>
}

function aggregateCountTags(characterLists: string[][]): string[] {
  const counts = { '1boy': 0, '1girl': 0, '1other': 0 }
  for (const list of characterLists) {
    const lower = new Set(list.map(t => t.toLowerCase()))
    for (const tag of SUBJECT_TAGS) if (lower.has(tag)) counts[tag]++
  }
  const tags: string[] = []
  const plural: Record<typeof SUBJECT_TAGS[number], [string, string]> = {
    '1boy':   ['2boys',   'multiple boys'],
    '1girl':  ['2girls',  'multiple girls'],
    '1other': ['2others', 'multiple others'],
  }
  for (const tag of SUBJECT_TAGS) {
    const n = counts[tag]
    if (n === 1) tags.push(tag)
    else if (n === 2) tags.push(plural[tag][0])
    else if (n > 2) tags.push(plural[tag][1])
  }
  return tags
}

export function planLoraTokens(tokenLists: string[][]): LoraTokenPlan {
  const sanitized = tokenLists.map(sanitizeTriggerTokens)
  const characterIdx = sanitized
    .map((list, i) => (isCharacterTokenList(list) ? i : -1))
    .filter(i => i >= 0)

  if (characterIdx.length < 2) {
    const flat = dedupe(sanitized.flat())
    return { multiCharacter: false, globalTokens: flat, baseTokens: flat, characters: [] }
  }

  const charSet = new Set(characterIdx)
  const characterLists = characterIdx.map(i => sanitized[i])
  const aggregates = aggregateCountTags(characterLists)
  const otherTokens = dedupe(sanitized.filter((_, i) => !charSet.has(i)).flat())

  const isSubjectOrSolo = (t: string) => {
    const k = t.toLowerCase()
    return SOLO_TAGS.has(k) || (SUBJECT_TAGS as readonly string[]).includes(k)
  }

  return {
    multiCharacter: true,
    // Global fallback: every identity token still ships, but the conflicting
    // solo/1boy tags are replaced by one set of aggregate count tags.
    globalTokens: dedupe([
      ...aggregates,
      ...characterLists.flat().filter(t => !isSubjectOrSolo(t)),
      ...otherTokens,
    ]),
    baseTokens: dedupe([...aggregates, ...otherTokens]),
    characters: characterIdx.map(index => ({
      index,
      // Keep "1boy" inside a region (each region holds exactly one subject),
      // drop only the whole-image "solo" claim.
      regionTokens: sanitized[index].filter(t => !SOLO_TAGS.has(t.toLowerCase())),
    })),
  }
}
