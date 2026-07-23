import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { icloudSenderStats, userPreferences } from '@/db/schema'

// Deterministic triage band (iCloud plan M5): the cheap checks that resolve most
// mail without touching the LLM — VIPs, sender history from icloud_sender_stats,
// list headers, and the Authentication-Results the ingest layer stored. Returns
// null for the genuinely uncertain band, which queues for the local-LLM judge.

export type TriageBucket = 'ignore' | 'notify' | 'respond'

export interface HeuristicInput {
  fromAddress: string | null
  listUnsubscribe: string | null
  authResults: string | null
}

export interface HeuristicVerdict {
  bucket: TriageBucket
  confidence: number
  reason: string
}

export const VIP_PREF_KEY = 'icloud-mail.vip'

/** The account owner's VIP sender list (stored as a user preference). */
export async function loadVipList(ownerUserId: string): Promise<string[]> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, ownerUserId), eq(userPreferences.key, VIP_PREF_KEY)))
    .limit(1)
  try {
    const parsed = JSON.parse(row?.value ?? '[]')
    return Array.isArray(parsed) ? parsed.map((v) => String(v).toLowerCase()) : []
  } catch {
    return []
  }
}

export async function loadSenderStats(accountId: string, address: string) {
  const [row] = await db.select().from(icloudSenderStats)
    .where(and(eq(icloudSenderStats.accountId, accountId), eq(icloudSenderStats.senderAddress, address)))
    .limit(1)
  return row ?? null
}

function authFailed(authResults: string | null): boolean {
  if (!authResults) return false
  const a = authResults.toLowerCase()
  return a.includes('dmarc=fail') || (a.includes('spf=fail') && a.includes('dkim=fail'))
}

/** Confident verdict or null (→ LLM band). */
export async function heuristicVerdict(
  accountId: string,
  ownerUserId: string,
  msg: HeuristicInput,
): Promise<HeuristicVerdict | null> {
  const addr = msg.fromAddress?.toLowerCase() ?? null
  if (!addr) return { bucket: 'ignore', confidence: 0.7, reason: 'No sender address' }

  const vips = await loadVipList(ownerUserId)
  if (vips.includes(addr) || vips.some((v) => v.startsWith('@') && addr.endsWith(v))) {
    return { bucket: 'notify', confidence: 0.95, reason: 'VIP sender' }
  }

  if (authFailed(msg.authResults)) {
    return { bucket: 'ignore', confidence: 0.85, reason: 'Failed sender authentication (SPF/DKIM/DMARC)' }
  }

  const stats = await loadSenderStats(accountId, addr)
  const replied = stats?.repliedCount ?? 0
  const seen = stats?.seenCount ?? 0
  const isList = !!msg.listUnsubscribe

  if (replied > 0 && !isList) {
    return { bucket: 'respond', confidence: 0.9, reason: `Personal correspondent (replied ${replied}x before)` }
  }
  if (replied > 0 && isList) {
    return { bucket: 'notify', confidence: 0.75, reason: 'Bulk mail from a sender you have written to' }
  }
  if (isList && seen >= 3) {
    return { bucket: 'ignore', confidence: 0.8, reason: `Recurring bulk sender (${seen} messages, never replied)` }
  }

  // First-time senders and fresh lists are the honest uncertainty band.
  return null
}
