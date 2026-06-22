import { and, eq, inArray } from 'drizzle-orm'
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from 'obscenity'
import { db } from '@/db'
import { userPreferences, imageLoraUserLoraGrants, imageLoras } from '@/db/schema'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface UserProtections {
  blockProfanity: boolean
  blockUncensoredLlm: boolean
  blockAdultLoras: boolean
  blockAdultImages: boolean
  blockSensitiveTopics: boolean
}

export type Candor = 'gentle' | 'balanced' | 'blunt'

export interface InteractionStyle {
  language: 'simple' | 'conversational' | 'technical'
  depth: 'brief' | 'balanced' | 'thorough'
  // Delivery, not a content permission (so admins don't ceiling it). Carries the
  // "gritty, unflinching, no-sugarcoating" voice. For a character chat this comes
  // from the character config; for plain chat from the user's style.
  candor: Candor
}

const DEFAULT_PROTECTIONS: UserProtections = {
  blockProfanity: false,
  blockUncensoredLlm: false,
  blockAdultLoras: false,
  blockAdultImages: false,
  blockSensitiveTopics: false,
}

const DEFAULT_STYLE: InteractionStyle = {
  language: 'conversational',
  depth: 'balanced',
  candor: 'balanced',
}

// ── Pref helpers ──────────────────────────────────────────────────────────────

async function getPref(userId: string, key: string): Promise<unknown | null> {
  const [row] = await db.select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, key)))
    .limit(1)
  return row ? JSON.parse(row.value) : null
}

async function setPref(userId: string, key: string, value: unknown): Promise<void> {
  const now = new Date()
  await db.insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value: JSON.stringify(value), updatedAt: now },
    })
}

// ── Protections ───────────────────────────────────────────────────────────────

export async function getProtections(userId: string): Promise<UserProtections> {
  const stored = await getPref(userId, 'protections') as Partial<UserProtections> | null
  return { ...DEFAULT_PROTECTIONS, ...stored }
}

export async function setProtections(userId: string, protections: UserProtections): Promise<void> {
  await setPref(userId, 'protections', protections)
}

// ── Adult LoRA grant cascade ──────────────────────────────────────────────────

export async function revokeAdultLoraGrants(userId: string): Promise<void> {
  // Find all adult LoRA IDs
  const adultLoras = await db.select({ id: imageLoras.id })
    .from(imageLoras)
    .where(eq(imageLoras.isAdult, true))
  const adultLoraIds = adultLoras.map(l => l.id)

  // Find all adult category IDs (categories whose name/any LoRA is adult — use LoRA-level only)
  // Simpler: revoke any category grants where ALL loras in category are adult is complex —
  // instead revoke per-LoRA grants only; category grants remain but are filtered server-side.
  if (adultLoraIds.length > 0) {
    await db.delete(imageLoraUserLoraGrants)
      .where(and(
        eq(imageLoraUserLoraGrants.userId, userId),
        inArray(imageLoraUserLoraGrants.loraId, adultLoraIds),
      ))
  }
}

// ── Interaction style ─────────────────────────────────────────────────────────

export async function getInteractionStyle(userId: string): Promise<InteractionStyle> {
  const stored = await getPref(userId, 'interaction_style') as Partial<InteractionStyle> | null
  return { ...DEFAULT_STYLE, ...stored }
}

export async function setInteractionStyle(userId: string, style: Partial<InteractionStyle>): Promise<void> {
  const current = await getInteractionStyle(userId)
  await setPref(userId, 'interaction_style', { ...current, ...style })
}

// ── System prompt fragments ───────────────────────────────────────────────────

const LANGUAGE_FRAGMENT: Record<InteractionStyle['language'], string> = {
  simple: 'Use simple, everyday words and short sentences. Avoid jargon and technical terms. If you must use a technical term, briefly explain it.',
  conversational: '',
  technical: 'You may use technical terminology freely. Assume the user is comfortable with domain-specific language.',
}

const DEPTH_FRAGMENT: Record<InteractionStyle['depth'], string> = {
  brief: 'Keep your default reply short — one to two sentences. If the user wants more detail, they will ask. Lead with the direct answer, then stop.',
  balanced: '',
  thorough: 'Give full, thorough explanations. Walk through your reasoning step by step when it helps.',
}

const CANDOR_FRAGMENT: Record<Candor, string> = {
  gentle: 'Keep a warm, gentle, encouraging tone. Soften hard truths with care.',
  balanced: '',
  blunt: 'Be blunt, direct, and unflinching. Do not sugarcoat, moralize, or add therapeutic softening. Do not refuse legal, good-faith questions just because they are sensitive, taboo, or uncomfortable — engage fully. (The safety rules still apply.)',
}

export function buildInteractionFragment(style: InteractionStyle): string {
  const parts = [
    LANGUAGE_FRAGMENT[style.language],
    DEPTH_FRAGMENT[style.depth],
    CANDOR_FRAGMENT[style.candor ?? 'balanced'],
  ].filter(Boolean)
  return parts.join(' ')
}

export function buildProtectionFragment(p: UserProtections): string {
  const parts: string[] = []
  if (p.blockProfanity) {
    parts.push('Keep your language clean at all times. Never use profanity, slurs, or vulgar language.')
  }
  if (p.blockSensitiveTopics) {
    parts.push('Avoid discussing violence, explicit drug use, graphic content, or other adult themes. Redirect to safer topics if they come up.')
  }
  return parts.join(' ')
}

// ── Profanity filter (obscenity) ──────────────────────────────────────────────

const _matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
})

export function maskProfanity(text: string): string {
  if (!_matcher.hasMatch(text)) return text
  const matches = _matcher.getAllMatches(text)
  if (matches.length === 0) return text

  // Sort by start position descending so replacements don't shift offsets
  matches.sort((a, b) => b.startIndex - a.startIndex)
  let result = text
  for (const m of matches) {
    const len = m.endIndex - m.startIndex + 1
    result = result.slice(0, m.startIndex) + '*'.repeat(len) + result.slice(m.endIndex + 1)
  }
  return result
}

// Word-boundary streaming buffer: holds a partial trailing word across token chunks
// so we never emit a half-word that might be part of a profane word.
export class ProfanityStreamBuffer {
  private _buf = ''

  flush(token: string): string {
    this._buf += token
    // Find last word boundary (space, newline, punctuation)
    const lastBoundary = this._buf.search(/\S+$/)
    if (lastBoundary === -1) {
      // All whitespace — safe to emit
      const out = this._buf
      this._buf = ''
      return maskProfanity(out)
    }
    const safe = this._buf.slice(0, lastBoundary)
    this._buf = this._buf.slice(lastBoundary)
    return maskProfanity(safe)
  }

  drain(): string {
    const out = maskProfanity(this._buf)
    this._buf = ''
    return out
  }
}
