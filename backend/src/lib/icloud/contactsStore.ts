import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { icloudAccounts, icloudContacts, users } from '@/db/schema'
import { getAccountCredentials } from '@/lib/icloud/accounts'
import { fetchContactCards, parseVCard } from '@/lib/icloud/carddav'
import { isFeatureEnabled } from '@/lib/featureGate'
import { logger } from '@/lib/logger'

// Contacts sync + birthday queries (Phase 2 slice). Sync is etag-diff like the
// calendar store; the payoff surface is birthdays (Calendar app + briefing) and
// name grounding, not a standalone address-book app.

export async function syncContacts(accountId: string): Promise<{ upserted: number; deleted: number }> {
  const creds = await getAccountCredentials(accountId)
  if (!creds) return { upserted: 0, deleted: 0 }
  const cards = await fetchContactCards(creds)
  const existing = await db
    .select({ id: icloudContacts.id, href: icloudContacts.href, etag: icloudContacts.etag })
    .from(icloudContacts).where(eq(icloudContacts.accountId, accountId))
  const byHref = new Map(existing.map((c) => [c.href, c]))
  const now = new Date()
  let upserted = 0

  for (const card of cards) {
    const prior = byHref.get(card.href)
    if (prior && prior.etag && prior.etag === card.etag) continue
    const parsed = parseVCard(card.vcard)
    const values = {
      etag: card.etag, uid: parsed.uid, fullName: parsed.fullName, org: parsed.org,
      emails: JSON.stringify(parsed.emails), phones: JSON.stringify(parsed.phones),
      birthdayMonth: parsed.birthdayMonth, birthdayDay: parsed.birthdayDay, birthdayYear: parsed.birthdayYear,
      updatedAt: now,
    }
    if (prior) await db.update(icloudContacts).set(values).where(eq(icloudContacts.id, prior.id))
    else await db.insert(icloudContacts).values({ id: crypto.randomUUID(), accountId, href: card.href, createdAt: now, ...values })
    upserted++
  }

  const remoteHrefs = new Set(cards.map((c) => c.href))
  const goneIds = existing.filter((c) => !remoteHrefs.has(c.href)).map((c) => c.id)
  if (goneIds.length) await db.delete(icloudContacts).where(inArray(icloudContacts.id, goneIds))
  if (upserted || goneIds.length) {
    logger.info(`[icloud] contacts synced for ${accountId}: +${upserted}/-${goneIds.length}`)
  }
  return { upserted, deleted: goneIds.length }
}

export interface BirthdayItem {
  contactName: string
  member: string          // whose address book it came from
  date: string            // YYYY-MM-DD of the occurrence in range
  turnsAge: number | null // age they turn, when the vCard carried a year
}

/** Annual birthday occurrences inside [from, to) across every account's contacts. */
export async function birthdaysInRange(from: Date, to: Date): Promise<BirthdayItem[]> {
  if (!(await isFeatureEnabled('icloud-contacts'))) return []
  const rows = await db
    .select({
      fullName: icloudContacts.fullName,
      month: icloudContacts.birthdayMonth,
      day: icloudContacts.birthdayDay,
      year: icloudContacts.birthdayYear,
      member: users.nickname,
    })
    .from(icloudContacts)
    .innerJoin(icloudAccounts, eq(icloudContacts.accountId, icloudAccounts.id))
    .innerJoin(users, eq(icloudAccounts.userId, users.id))
  const out: BirthdayItem[] = []
  for (const r of rows) {
    if (!r.month || !r.day || !r.fullName) continue
    for (let year = from.getFullYear(); year <= to.getFullYear(); year++) {
      const occurrence = new Date(year, r.month - 1, r.day)
      if (occurrence >= from && occurrence < to) {
        out.push({
          contactName: r.fullName,
          member: r.member,
          date: `${year}-${String(r.month).padStart(2, '0')}-${String(r.day).padStart(2, '0')}`,
          turnsAge: r.year ? year - r.year : null,
        })
      }
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
