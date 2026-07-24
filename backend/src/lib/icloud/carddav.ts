import { DAVClient } from 'tsdav'
import { CalDavAuthError } from '@/lib/icloud/caldav'

// CardDAV contacts over the same ASP road as CalDAV (Phase 2 slice). Like
// caldav.ts, this is the only module touching tsdav's carddav side. The vCard
// parser below is deliberately minimal: names, org, emails, phones, birthday.

const CARDDAV_BASE = process.env.ICLOUD_CARDDAV_BASE ?? 'https://contacts.icloud.com'

export interface RemoteContactCard {
  href: string
  etag: string | null
  vcard: string
}

export interface ParsedContact {
  uid: string | null
  fullName: string | null
  org: string | null
  emails: string[]
  phones: string[]
  birthdayMonth: number | null
  birthdayDay: number | null
  birthdayYear: number | null
}

function isAuthError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /\b401\b|\b403\b|unauthorized|forbidden/i.test(msg)
}

export async function fetchContactCards(creds: { appleId: string; password: string }): Promise<RemoteContactCard[]> {
  const client = new DAVClient({
    serverUrl: CARDDAV_BASE,
    credentials: { username: creds.appleId, password: creds.password },
    authMethod: 'Basic',
    defaultAccountType: 'carddav',
  })
  try {
    await client.login()
    const books = await client.fetchAddressBooks()
    const cards: RemoteContactCard[] = []
    for (const book of books) {
      const vcards = await client.fetchVCards({ addressBook: book })
      for (const v of vcards) {
        if (typeof v.data !== 'string' || !v.data.includes('BEGIN:VCARD')) continue
        cards.push({ href: v.url, etag: v.etag ? String(v.etag) : null, vcard: v.data })
      }
    }
    return cards
  } catch (e) {
    if (isAuthError(e)) throw new CalDavAuthError('Apple rejected the app-specific password (CardDAV)')
    throw e
  }
}

/** Unfold RFC 6350 line continuations and split into "NAME;params:value" lines. */
function vcardLines(vcard: string): { name: string; value: string }[] {
  const unfolded = vcard.replace(/\r?\n[ \t]/g, '')
  return unfolded.split(/\r?\n/).flatMap((line) => {
    const idx = line.indexOf(':')
    if (idx < 1) return []
    const rawName = line.slice(0, idx)
    // Drop item groupings (item1.EMAIL) and params (TEL;TYPE=CELL).
    const name = rawName.replace(/^item\d+\./i, '').split(';')[0]!.toUpperCase()
    return [{ name, value: line.slice(idx + 1).trim() }]
  })
}

function parseBirthday(value: string): { month: number | null; day: number | null; year: number | null } {
  // Formats seen in the wild: 1985-04-12, 19850412, --0412, --04-12 (year withheld).
  const v = value.replace(/^VALUE=date:/i, '').trim()
  const noYear = v.match(/^--(\d{2})-?(\d{2})$/)
  if (noYear) return { month: Number(noYear[1]), day: Number(noYear[2]), year: null }
  const full = v.match(/^(\d{4})-?(\d{2})-?(\d{2})/)
  if (full) return { month: Number(full[2]), day: Number(full[3]), year: Number(full[1]) }
  return { month: null, day: null, year: null }
}

export function parseVCard(vcard: string): ParsedContact {
  const out: ParsedContact = {
    uid: null, fullName: null, org: null, emails: [], phones: [],
    birthdayMonth: null, birthdayDay: null, birthdayYear: null,
  }
  for (const { name, value } of vcardLines(vcard)) {
    if (!value) continue
    switch (name) {
      case 'UID': out.uid ??= value.slice(0, 200); break
      case 'FN': out.fullName ??= value.replace(/\\,/g, ',').slice(0, 200); break
      case 'ORG': out.org ??= value.split(';')[0]!.replace(/\\,/g, ',').slice(0, 200) || null; break
      case 'EMAIL': if (out.emails.length < 5) out.emails.push(value.toLowerCase().slice(0, 320)); break
      case 'TEL': if (out.phones.length < 5) out.phones.push(value.slice(0, 40)); break
      case 'BDAY': {
        const b = parseBirthday(value)
        if (b.month && b.day) {
          out.birthdayMonth = b.month
          out.birthdayDay = b.day
          out.birthdayYear = b.year
        }
        break
      }
    }
  }
  return out
}
