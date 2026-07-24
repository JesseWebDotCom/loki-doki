import { and, eq, gt, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { icloudMailExtracts, icloudMailMessages } from '@/db/schema'
import { logger } from '@/lib/logger'

// Deterministic mail extractors for the Ledger app: carrier delivery notices and
// purchase/subscription receipts, parsed from the headers-level index (sender +
// subject + bounded snippet). Regex-first per the research (HA Mail-and-Packages,
// PackageTrackr): sender/subject prefilters make false positives rare, and there
// is deliberately NO LLM here — extraction stays cheap and predictable.

const LOOKBACK_MS = 30 * 86_400_000

interface MessageRow {
  id: string
  accountId: string
  fromAddress: string | null
  fromName: string | null
  subject: string | null
  snippet: string | null
  receivedAt: Date
}

interface Extract {
  kind: 'delivery' | 'receipt'
  vendor: string
  title: string | null
  trackingNumber: string | null
  status: string | null
  amount: string | null
}

function deliveryStatus(text: string): string {
  const t = text.toLowerCase()
  if (/\bdelivered\b/.test(t)) return 'delivered'
  if (/out for delivery/.test(t)) return 'out_for_delivery'
  return 'shipped'
}

function amountIn(text: string | null): string | null {
  return text?.match(/\$\s?\d{1,6}(?:,\d{3})*(?:\.\d{2})?/)?.[0]?.replace(/\s/, '') ?? null
}

/** Subject tail after "Delivered:" / "Shipped:" / "Arriving …:" style prefixes. */
function subjectTail(subject: string): string {
  return subject.replace(/^[^:]{0,40}:\s*/, '').replace(/["“”]/g, '').trim() || subject
}

function classify(m: MessageRow): Extract | null {
  const from = m.fromAddress ?? ''
  const subject = m.subject ?? ''
  const haystack = `${subject} ${m.snippet ?? ''}`

  // ── Carriers ────────────────────────────────────────────────────────────────
  if (/@(?:[a-z0-9.-]+\.)?usps\.com$/.test(from)) {
    if (!/deliver|arriv|package|item/i.test(subject)) return null
    return {
      kind: 'delivery', vendor: 'USPS', title: subjectTail(subject),
      trackingNumber: haystack.match(/\b(9[2345]\d{18,24})\b/)?.[1] ?? null,
      status: deliveryStatus(subject), amount: null,
    }
  }
  if (/@(?:[a-z0-9.-]+\.)?ups\.com$/.test(from)) {
    if (!/deliver|package|on its way|shipment/i.test(subject)) return null
    return {
      kind: 'delivery', vendor: 'UPS', title: subjectTail(subject),
      trackingNumber: haystack.match(/\b(1Z[A-HJ-NP-Z0-9]{16})\b/i)?.[1]?.toUpperCase() ?? null,
      status: deliveryStatus(subject), amount: null,
    }
  }
  if (/@(?:[a-z0-9.-]+\.)?fedex\.com$/.test(from)) {
    if (!/deliver|shipment|package/i.test(subject)) return null
    return {
      kind: 'delivery', vendor: 'FedEx', title: subjectTail(subject),
      trackingNumber: haystack.match(/\b(\d{12,15}|\d{20,22})\b/)?.[1] ?? null,
      status: deliveryStatus(subject), amount: null,
    }
  }
  if (/@(?:[a-z0-9.-]+\.)?amazon\.com$/.test(from)) {
    if (/^(delivered|shipped|arriving|out for delivery)/i.test(subject) || /your package/i.test(subject)) {
      return {
        kind: 'delivery', vendor: 'Amazon', title: subjectTail(subject),
        trackingNumber: haystack.match(/\b(\d{3}-\d{7}-\d{7})\b/)?.[1] ?? null,
        status: deliveryStatus(subject), amount: null,
      }
    }
    if (/^ordered:|order confirmation/i.test(subject)) {
      return {
        kind: 'receipt', vendor: 'Amazon', title: subjectTail(subject),
        trackingNumber: null, status: null, amount: amountIn(haystack),
      }
    }
    return null
  }

  // ── Apple receipts / subscription notices ───────────────────────────────────
  if (/@(?:[a-z0-9.-]+\.)?apple\.com$/.test(from)) {
    if (/receipt|invoice|subscription/i.test(subject)) {
      return {
        kind: 'receipt', vendor: 'Apple', title: subjectTail(subject),
        trackingNumber: null, status: null, amount: amountIn(haystack),
      }
    }
    return null
  }

  // ── Generic receipts (any sender) ───────────────────────────────────────────
  if (/^(your receipt|receipt for|order confirmation|your order|thanks for your (order|purchase)|payment (received|confirmation))/i.test(subject)) {
    const vendor = (m.fromName?.trim() || from.split('@')[1]?.split('.')[0] || 'Unknown').slice(0, 60)
    return {
      kind: 'receipt', vendor, title: subjectTail(subject),
      trackingNumber: null, status: null, amount: amountIn(haystack),
    }
  }

  return null
}

/** Scan messages in the lookback window that have no extract row yet. */
export async function runExtractors(): Promise<number> {
  const candidates = await db
    .select({
      id: icloudMailMessages.id,
      accountId: icloudMailMessages.accountId,
      fromAddress: icloudMailMessages.fromAddress,
      fromName: icloudMailMessages.fromName,
      subject: icloudMailMessages.subject,
      snippet: icloudMailMessages.snippet,
      receivedAt: icloudMailMessages.receivedAt,
    })
    .from(icloudMailMessages)
    .leftJoin(icloudMailExtracts, eq(icloudMailExtracts.messageRowId, icloudMailMessages.id))
    .where(and(
      isNull(icloudMailExtracts.id),
      gt(icloudMailMessages.receivedAt, new Date(Date.now() - LOOKBACK_MS)),
    ))
    .limit(500)

  let created = 0
  for (const m of candidates) {
    const extract = classify(m)
    if (!extract) continue
    await db.insert(icloudMailExtracts)
      .values({
        id: crypto.randomUUID(), accountId: m.accountId, messageRowId: m.id,
        kind: extract.kind, vendor: extract.vendor, title: extract.title,
        trackingNumber: extract.trackingNumber, status: extract.status,
        amount: extract.amount, eventDate: m.receivedAt, createdAt: new Date(),
      })
      .onConflictDoNothing()
    created++
  }
  if (created) logger.info(`[icloud-mail] extracted ${created} ledger item(s)`)
  return created
}
