// Dump embedding top-5 scores for prompts — used to pick thresholds empirically.
import { embedForRouter, cosineSimilarity } from '@/llm/embed'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const idx = (JSON.parse(readFileSync(join(process.cwd(), '..', 'data', 'router-index.json'), 'utf8')) as
  { index: Array<{ toolId: string; embeddings: number[][] }> }).index

const prompts = [
  'what is 17 × 23?',
  'how much is a 20% tip on $85?',
  'if I split a $120 bill 3 ways how much do I owe?',
  'define melancholy',
  'how many km is 5 miles?',
  "I'm 6 foot 2, what is that in cm?",
  'how many days until Christmas?',
  'how do I make pasta carbonara?',
  'show me how to make sourdough bread',
  // genuine search queries that must KEEP fast-pathing to search
  'who is Ada Lovelace?',
  'what is the capital of Mongolia?',
  'tell me about the Roman Empire',
  'what happened to Blockbuster?',
]

for (const p of prompts) {
  const e = await embedForRouter(p)
  const scores = idx
    .map(t => ({ id: t.toolId, s: Math.max(...t.embeddings.map(v => cosineSimilarity(e, v))) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
  console.log(`"${p}"\n   ${scores.map(x => `${x.id}=${x.s.toFixed(3)}`).join('  ')}`)
}
process.exit(0)
