// TTS pronunciation lexicon. Admin-managed respellings applied to text just before
// synthesis so the voice says names/words correctly (captions keep the original
// spelling). Custom rules (packId=null) always apply; pack rules apply only when
// their pack is enabled. The lexicon is cached in memory and rebuilt only when
// an admin edits it. Ported from v1 /audio/pronunciation.

import { db } from '@/db'
import { pronunciations, pronunciationPacks } from '@/db/schema'
import { isNull, eq } from 'drizzle-orm'
import { BUILTIN_PRONUNCIATION_PACKS } from './builtinPronunciationPacks'

interface Rule { re: RegExp; replacement: string }

let cache: Rule[] | null = null

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function load(): Promise<Rule[]> {
  if (cache) return cache

  // Custom rules (no pack) always apply.
  const customRows = await db
    .select({ term: pronunciations.term, replacement: pronunciations.replacement })
    .from(pronunciations)
    .where(isNull(pronunciations.packId))

  // Pack rules: only from enabled packs (inner join filters disabled packs out).
  const packRows = await db
    .select({ term: pronunciations.term, replacement: pronunciations.replacement })
    .from(pronunciations)
    .innerJoin(pronunciationPacks, eq(pronunciations.packId, pronunciationPacks.id))
    .where(eq(pronunciationPacks.enabled, true))

  const rows = [...customRows, ...packRows]
  // Longer terms first so multi-word phrases win over their constituent words.
  rows.sort((a, b) => b.term.length - a.term.length)
  cache = rows
    .filter((r) => r.term.trim())
    .map((r) => {
      const term = r.term.trim()
      // All-uppercase terms (acronyms like US, UK, EU) match case-sensitively so
      // they don't fire on lowercase common words ("us", "uk"). Mixed-case and
      // lowercase terms match case-insensitively as before.
      const allCaps = /^[A-Z0-9]+$/.test(term.replace(/[^A-Za-z0-9]/g, ''))
      const flags = allCaps ? 'g' : 'gi'
      return {
        re: new RegExp(`(?<![A-Za-z0-9])${escapeRegex(term)}(?![A-Za-z0-9])`, flags),
        replacement: r.replacement,
      }
    })
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

/** Seed built-in packs on first load. Never overwrites admin's enabled toggle. */
export async function reconcileBuiltinPronunciationPacks(): Promise<void> {
  const now = new Date()
  for (const pack of BUILTIN_PRONUNCIATION_PACKS) {
    // Upsert the pack row — use INSERT OR IGNORE so enabled is never overwritten.
    const existing = await db
      .select({ id: pronunciationPacks.id })
      .from(pronunciationPacks)
      .where(eq(pronunciationPacks.slug, pack.slug))

    let packId: string
    if (existing.length === 0) {
      packId = crypto.randomUUID()
      await db.insert(pronunciationPacks).values({
        id: packId,
        slug: pack.slug,
        name: pack.name,
        appKey: pack.appKey,
        description: pack.description,
        enabled: true,
        builtIn: true,
        createdAt: now,
        updatedAt: now,
      })
    } else {
      packId = existing[0]!.id
      // Keep name/description current without touching enabled.
      await db
        .update(pronunciationPacks)
        .set({ name: pack.name, appKey: pack.appKey, description: pack.description, updatedAt: now })
        .where(eq(pronunciationPacks.id, packId))
    }

    // Insert any missing items (never delete — admin may have removed intentionally).
    const existingTerms = new Set(
      (await db
        .select({ term: pronunciations.term })
        .from(pronunciations)
        .where(eq(pronunciations.packId, packId))
      ).map((r) => r.term.toLowerCase()),
    )

    for (const item of pack.items) {
      if (!existingTerms.has(item.term.toLowerCase())) {
        await db.insert(pronunciations).values({
          id: crypto.randomUUID(),
          packId,
          term: item.term,
          replacement: item.replacement,
          createdAt: now,
          updatedAt: now,
        })
      }
    }
  }

  invalidatePronunciations()
}
