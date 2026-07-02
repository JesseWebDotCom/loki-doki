// Memory recall quality eval — seeds known memories for a throwaway user, then
// checks whether each probe question surfaces the target fact in the ACTUAL
// prompt block (recallMemories + formatMemoriesForPrompt). Prints hit rates.
//
// Usage: bun run scripts/eval/memory-eval.ts
import { db } from '@/db'
import { users, memories, entities } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { embed } from '@/llm/embed'
import { recallMemories, formatMemoriesForPrompt } from '@/memory/recall'

const now = new Date()
const testUserId = crypto.randomUUID()

interface Seed {
  text: string
  category?: string
  tier?: 'durable' | 'episodic'
  pinned?: boolean
  importance?: number
  entityName?: string
  ageDays?: number
}

interface Case {
  id: string
  question: string
  /** substring that must appear in the formatted block */
  expect: string
  /** true = must be ABSENT (specificity control) */
  absent?: boolean
}

const SEEDS: Seed[] = [
  { text: 'JT works as a paramedic on the night shift', category: 'identity', tier: 'durable', pinned: true, importance: 9 },
  { text: 'JT dislikes cilantro and refuses to eat it', category: 'preference', tier: 'durable', importance: 6 },
  { text: 'JT is vegetarian', category: 'preference', tier: 'durable', importance: 7 },
  { text: 'JT is training for the Hartford half-marathon in October', category: 'goal', tier: 'durable', importance: 7 },
  { text: 'JT went to a Yankees game last Saturday and loved it', category: 'event', tier: 'episodic', importance: 5, ageDays: 4 },
  { text: "JT's car got an oil change in March", category: 'fact', tier: 'episodic', importance: 3, ageDays: 90 },
  { text: 'Artie is allergic to peanuts', category: 'relationship', tier: 'episodic', importance: 7, entityName: 'Artie' },
  { text: 'Artie loves science-fiction movies', category: 'relationship', tier: 'episodic', importance: 5, entityName: 'Artie' },
]

// Entity-flood seeds: 22 filler facts + 1 target for the same person, to test
// whether the char budget truncates the block before the target fact survives.
const FLOOD_TARGET = 'Marge is severely allergic to shellfish'
const floodSeeds: Seed[] = [
  ...Array.from({ length: 22 }, (_, i) => ({
    text: `Marge ${['plays tennis on Tuesdays', 'drives a blue Subaru Outback', 'grew up in Ohio', 'has two golden retrievers', 'collects vintage postcards', 'works at the town library', 'makes excellent banana bread', 'is learning Italian', 'volunteers at the animal shelter', 'hates horror movies', 'loves gardening in spring', 'sings in the church choir', 'went to Cornell', 'is afraid of heights', 'prefers tea over coffee', 'runs a book club', 'has a lake house in Vermont', 'broke her wrist skiing once', 'is married to Dave', 'has a niece named Sophie', 'plays bridge on Fridays', 'makes her own jam'][i]}`,
    category: 'relationship',
    tier: 'episodic' as const,
    importance: 4,
    entityName: 'Marge',
  })),
  { text: FLOOD_TARGET, category: 'relationship', tier: 'episodic', importance: 8, entityName: 'Marge' },
]

// 40 generic filler memories to simulate an aged install (recall window noise).
const fillerSeeds: Seed[] = Array.from({ length: 40 }, (_, i) => ({
  text: `JT mentioned random daily detail number ${i}: ${['grabbed coffee', 'watched a documentary', 'mowed the lawn', 'fixed a leaky faucet', 'ordered new shoes'][i % 5]} on day ${i}`,
  category: 'fact',
  tier: 'episodic' as const,
  importance: 3,
  ageDays: i,
}))

const CASES: Case[] = [
  { id: 'pinned-identity',    question: 'hi there!', expect: 'paramedic' },
  { id: 'durable-pref-food',  question: 'what should I cook for dinner tonight?', expect: 'cilantro' },
  { id: 'durable-pref-para',  question: 'find me a good steakhouse for Friday', expect: 'vegetarian' },
  { id: 'durable-goal',       question: 'should I go for a run this weekend?', expect: 'half-marathon' },
  { id: 'episodic-relevant',  question: 'tell me about that baseball game I went to', expect: 'Yankees' },
  { id: 'specificity-ctrl',   question: 'what should I cook for dinner tonight?', expect: 'oil change', absent: true },
  { id: 'entity-recall',      question: 'would Artie like this new sci-fi movie?', expect: 'science-fiction' },
  { id: 'entity-detail',      question: "I'm cooking for Artie tomorrow, any concerns?", expect: 'peanuts' },
  { id: 'entity-flood',       question: "can Marge eat at the seafood place with us?", expect: 'shellfish' },
  // Durable-tier specificity controls: the lower durable gate must not spray
  // preferences onto unrelated turns (guards DURABLE_MIN_COSINE from below).
  { id: 'durable-ctrl-movie', question: 'what movie should we watch?', expect: 'vegetarian', absent: true },
  { id: 'durable-ctrl-greet', question: 'hi there!', expect: 'cilantro', absent: true },
]

// ── Seed ─────────────────────────────────────────────────────────────────────
await db.insert(users).values({
  id: testUserId, firstName: 'Eval', lastName: 'User', nickname: 'EvalUser',
  birthdate: '1990-01-01', role: 'user', createdAt: now, updatedAt: now,
})

const entityIds = new Map<string, string>()
async function ensureEntity(name: string): Promise<string> {
  const existing = entityIds.get(name)
  if (existing) return existing
  const id = crypto.randomUUID()
  await db.insert(entities).values({
    id, userId: testUserId, characterId: null, name, kind: 'person',
    aliases: '[]', createdAt: now, updatedAt: now,
  })
  entityIds.set(name, id)
  return id
}

async function seed(s: Seed): Promise<void> {
  const embedding = JSON.stringify(await embed(s.text))
  const created = new Date(now.getTime() - (s.ageDays ?? 0) * 86_400_000)
  await db.insert(memories).values({
    id: crypto.randomUUID(),
    userId: testUserId,
    characterId: null,
    entityId: s.entityName ? await ensureEntity(s.entityName) : null,
    text: s.text,
    category: s.category ?? 'fact',
    tier: s.tier ?? 'episodic',
    status: 'active',
    embedding,
    importance: s.importance ?? 5,
    pinned: s.pinned ?? false,
    createdAt: created,
    updatedAt: created,
  })
}

try {
  console.log('Seeding memories…')
  for (const s of [...SEEDS, ...floodSeeds, ...fillerSeeds]) await seed(s)

  console.log(`Running ${CASES.length} recall probes…\n`)
  let pass = 0
  for (const c of CASES) {
    const embedding = await embed(c.question)
    const recalled = await recallMemories(c.question, testUserId, null, embedding)
    const block = await formatMemoriesForPrompt(recalled, testUserId, null, embedding) ?? ''
    const inRecall = recalled.some(m => m.text.includes(c.expect))
    const inBlock = block.includes(c.expect)
    const ok = c.absent ? !inBlock : inBlock
    if (ok) pass++
    const stage = c.absent
      ? (inBlock ? 'leaked-into-block' : 'correctly-absent')
      : inBlock ? 'in-block' : inRecall ? 'RECALLED-BUT-TRUNCATED' : 'NOT-RECALLED'
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.id.padEnd(18)} "${c.question}" → ${stage}  (recalled=${recalled.length}, block=${block.length}ch)`)
  }
  console.log(`\n${pass}/${CASES.length} passed`)
} finally {
  await db.delete(users).where(eq(users.id, testUserId)) // cascades memories+entities
}
process.exit(0)
