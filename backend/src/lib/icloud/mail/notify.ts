import { and, desc, eq, gt, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { icloudAccounts, icloudMailMessages, icloudMailVerdicts, users } from '@/db/schema'
import { isFeatureEnabled } from '@/lib/featureGate'

// Notify-bucket reads implementing the mail-visibility model (Jesse, 2026-07-23):
// mail is private per member; parents/admins ADDITIONALLY see kids' (non-admin
// members') flagged items as SUBJECTS ONLY — no snippets, no full index; nothing
// rides an always-shared surface. Every consumer (ticker, companion line,
// briefing-adjacent) goes through here so the rule lives in exactly one place.

const NOTIFY_WINDOW_MS = 48 * 3600_000

export interface NotifyItem {
  id: string
  subject: string | null
  fromName: string | null
  snippet: string | null      // null for kids' items (subjects only)
  bucket: 'notify' | 'respond'
  receivedAt: Date
  member: string              // nickname; the viewer's own items included
  own: boolean
}

/** Latest verdict per message, filtered to notify/respond, inside the window. */
async function flaggedForAccounts(accountIds: string[]): Promise<Map<string, { bucket: 'notify' | 'respond' }>> {
  if (!accountIds.length) return new Map()
  const rows = await db
    .select({
      messageId: icloudMailVerdicts.messageId,
      bucket: icloudMailVerdicts.bucket,
      createdAt: icloudMailVerdicts.createdAt,
    })
    .from(icloudMailVerdicts)
    .where(inArray(icloudMailVerdicts.accountId, accountIds))
    .orderBy(desc(icloudMailVerdicts.createdAt))
  const latest = new Map<string, { bucket: 'ignore' | 'notify' | 'respond' }>()
  for (const r of rows) if (!latest.has(r.messageId)) latest.set(r.messageId, { bucket: r.bucket })
  const flagged = new Map<string, { bucket: 'notify' | 'respond' }>()
  for (const [id, v] of latest) if (v.bucket !== 'ignore') flagged.set(id, { bucket: v.bucket })
  return flagged
}

/** Flagged items visible to `viewer`: own (full) + kids' (subjects only) if admin. */
export async function notifyItemsFor(viewer: { id: string; role: string }): Promise<NotifyItem[]> {
  if (!(await isFeatureEnabled('icloud-mail'))) return []
  const accounts = await db
    .select({ id: icloudAccounts.id, userId: icloudAccounts.userId, nickname: users.nickname, role: users.role })
    .from(icloudAccounts)
    .innerJoin(users, eq(icloudAccounts.userId, users.id))
  const visible = accounts.filter((a) =>
    a.userId === viewer.id || (viewer.role === 'admin' && a.role !== 'admin'))
  if (!visible.length) return []

  const flagged = await flaggedForAccounts(visible.map((a) => a.id))
  if (!flagged.size) return []
  const byAccount = new Map(visible.map((a) => [a.id, a]))

  const messages = await db
    .select({
      id: icloudMailMessages.id,
      accountId: icloudMailMessages.accountId,
      subject: icloudMailMessages.subject,
      fromName: icloudMailMessages.fromName,
      snippet: icloudMailMessages.snippet,
      receivedAt: icloudMailMessages.receivedAt,
    })
    .from(icloudMailMessages)
    .where(and(
      inArray(icloudMailMessages.accountId, visible.map((a) => a.id)),
      gt(icloudMailMessages.receivedAt, new Date(Date.now() - NOTIFY_WINDOW_MS)),
    ))
    .orderBy(desc(icloudMailMessages.receivedAt))
    .limit(200)

  const items: NotifyItem[] = []
  for (const m of messages) {
    const verdict = flagged.get(m.id)
    if (!verdict) continue
    const account = byAccount.get(m.accountId)!
    const own = account.userId === viewer.id
    items.push({
      id: m.id,
      subject: m.subject,
      fromName: m.fromName,
      snippet: own ? m.snippet : null,   // kids' items: subjects only, never snippets
      bucket: verdict.bucket,
      receivedAt: m.receivedAt,
      member: account.nickname,
      own,
    })
  }
  return items.slice(0, 30)
}

// ── Companion grounding line ──────────────────────────────────────────────────
// Per-user cached one-liner for the late volatile zone of companion turns:
// synchronous read, background refresh, same shape as the calendar block but
// per-viewer because visibility differs per member.

const LINE_TTL_MS = 5 * 60_000
const lineCache = new Map<string, { line: string; at: number }>()
const inflight = new Set<string>()

async function buildMailLine(viewer: { id: string; role: string }): Promise<string> {
  const items = await notifyItemsFor(viewer)
  if (!items.length) return ''
  const top = items.slice(0, 4).map((i) => {
    const who = i.own ? '' : ` (${i.member})`
    return `"${(i.subject ?? 'No subject').slice(0, 60)}" from ${i.fromName ?? 'unknown'}${who}`
  })
  return `[Flagged mail — last 48h]\n${top.join('; ')}\nMention only if asked about email or something here is clearly relevant.`
}

export function getMailNotifyLine(viewer: { id: string; role: string }): string {
  const cached = lineCache.get(viewer.id)
  if (!cached || Date.now() - cached.at > LINE_TTL_MS) {
    if (!inflight.has(viewer.id)) {
      inflight.add(viewer.id)
      void buildMailLine(viewer)
        .then((line) => lineCache.set(viewer.id, { line, at: Date.now() }))
        .catch(() => lineCache.set(viewer.id, { line: '', at: Date.now() }))
        .finally(() => inflight.delete(viewer.id))
    }
  }
  return cached?.line ?? ''
}
