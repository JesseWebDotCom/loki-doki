// TTS pronunciation lexicon. Admin-managed respellings applied to text just before
// synthesis so the voice says names/words correctly (captions keep the original
// spelling). The lexicon is small and global, so it's cached in memory and rebuilt
// only when an admin edits it. Ported from v1 /audio/pronunciation.

import { db } from '@/db'
import { pronunciations } from '@/db/schema'

interface Rule { re: RegExp; replacement: string }

let cache: Rule[] | null = null

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function load(): Promise<Rule[]> {
  if (cache) return cache
  const rows = await db.select({ term: pronunciations.term, replacement: pronunciations.replacement }).from(pronunciations)
  // Longer terms first so multi-word phrases win over their constituent words.
  rows.sort((a, b) => b.term.length - a.term.length)
  cache = rows
    .filter((r) => r.term.trim())
    .map((r) => ({
      // Whole-word, case-insensitive. Boundaries are alphanumerics so "Reade" isn't
      // matched inside "Reader" but "Dr." or hyphenated terms still work.
      re: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(r.term.trim())}(?![A-Za-z0-9])`, 'gi'),
      replacement: r.replacement,
    }))
  return cache
}

export function invalidatePronunciations(): void {
  cache = null
}

/** Apply the lexicon to a sentence (audio text only). Returns input unchanged if empty. */
export async function applyPronunciations(text: string): Promise<string> {
  if (!text) return text
  const rules = await load()
  if (rules.length === 0) return text
  let out = text
  for (const rule of rules) out = out.replace(rule.re, rule.replacement)
  return out
}
