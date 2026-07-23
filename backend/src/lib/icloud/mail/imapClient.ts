import { ImapFlow, type FetchMessageObject } from 'imapflow'
import { logger } from '@/lib/logger'

// Thin imapflow wrapper (iCloud plan M4) — the ONLY module that touches imapflow,
// mirroring caldav.ts's isolation of tsdav. iCloud folder-name quirks live here
// ('Sent Messages', 'Deleted Messages'). Endpoints are env-overridable so a local
// fixture server can stand in for Apple (ICLOUD_IMAP_HOST/PORT/SECURE).

const IMAP_HOST = process.env.ICLOUD_IMAP_HOST ?? 'imap.mail.me.com'
const IMAP_PORT = Number(process.env.ICLOUD_IMAP_PORT ?? 993)
const IMAP_SECURE = process.env.ICLOUD_IMAP_SECURE !== '0'

export const MAIL_FOLDERS = {
  inbox: 'INBOX',
  sent: 'Sent Messages',      // iCloud's nonstandard name (not 'Sent')
  junk: 'Junk',
  trash: 'Deleted Messages',  // iCloud's nonstandard name (not 'Trash')
} as const

export class ImapAuthError extends Error {}

export interface MailCreds {
  appleId: string
  password: string
}

export interface FetchedMessage {
  uid: number
  messageId: string | null
  fromAddress: string | null
  fromName: string | null
  subject: string | null
  receivedAt: Date
  seen: boolean
  answered: boolean
  listUnsubscribe: string | null
  authResults: string | null
  hasAttachments: boolean
  snippet: string | null
}

function isAuthFailure(e: unknown): boolean {
  const err = e as { authenticationFailed?: boolean; response?: string; message?: string }
  return err?.authenticationFailed === true || /authenticat|LOGIN failed/i.test(err?.response ?? err?.message ?? '')
}

export function createImapClient(creds: MailCreds): ImapFlow {
  return new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: IMAP_SECURE,
    auth: { user: creds.appleId, pass: creds.password },
    logger: false,
    // One quick retry is the watcher's job; the client itself should fail fast.
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  })
}

/** Connect + run + always logout. Auth failures surface as ImapAuthError. */
export async function withImap<T>(creds: MailCreds, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createImapClient(creds)
  try {
    await client.connect()
  } catch (e) {
    client.close()   // a failed connect still leaves live socket handles behind
    if (isAuthFailure(e)) throw new ImapAuthError('Apple rejected the app-specific password (IMAP)')
    throw e
  }
  try {
    return await fn(client)
  } finally {
    await client.logout().catch(() => client.close())
  }
}

interface BodyPart {
  part?: string
  type?: string
  disposition?: string
  size?: number
  childNodes?: BodyPart[]
}

function walkParts(node: BodyPart | undefined, out: BodyPart[] = []): BodyPart[] {
  if (!node) return out
  out.push(node)
  for (const child of node.childNodes ?? []) walkParts(child, out)
  return out
}

function findTextPart(structure: BodyPart | undefined): BodyPart | null {
  const parts = walkParts(structure)
  return parts.find((p) => p.type === 'text/plain' && p.disposition !== 'attachment')
    ?? parts.find((p) => p.type === 'text/html' && p.disposition !== 'attachment')
    ?? null
}

function detectAttachments(structure: BodyPart | undefined): boolean {
  return walkParts(structure).some((p) => p.disposition === 'attachment')
}

function headerValue(raw: Buffer | undefined, name: string): string | null {
  if (!raw) return null
  // Simple unfolded-header scan over the requested-headers blob.
  const text = raw.toString('utf8').replace(/\r\n[ \t]+/g, ' ')
  const m = text.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'))
  return m?.[1]?.trim().slice(0, 2000) ?? null
}

/** Bounded plain-text snippet from the message's first text part. Best-effort:
 *  any failure (odd MIME, oversized part, fixture without part support) → null. */
async function fetchSnippet(client: ImapFlow, uid: number, structure: BodyPart | undefined): Promise<string | null> {
  try {
    const part = findTextPart(structure)
    if (!part?.part || (part.size ?? 0) > 200_000) return null
    const { content } = await client.download(String(uid), part.part, { uid: true, maxBytes: 4096 })
    if (!content) return null
    const chunks: Buffer[] = []
    for await (const chunk of content) chunks.push(chunk as Buffer)
    let text = Buffer.concat(chunks).toString('utf8')
    if (part.type === 'text/html') text = text.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
    text = text.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
    return text ? text.slice(0, 300) : null
  } catch {
    return null
  }
}

function normalize(msg: FetchMessageObject): Omit<FetchedMessage, 'snippet'> {
  const from = msg.envelope?.from?.[0]
  const flags = msg.flags ?? new Set<string>()
  return {
    uid: msg.uid,
    messageId: msg.envelope?.messageId?.slice(0, 500) ?? null,
    fromAddress: from?.address?.toLowerCase().slice(0, 320) ?? null,
    fromName: from?.name?.slice(0, 200) ?? null,
    subject: msg.envelope?.subject?.slice(0, 500) ?? null,
    receivedAt: msg.internalDate ?? msg.envelope?.date ?? new Date(),
    seen: flags.has('\\Seen'),
    answered: flags.has('\\Answered'),
    listUnsubscribe: headerValue(msg.headers, 'list-unsubscribe'),
    authResults: headerValue(msg.headers, 'authentication-results'),
    hasAttachments: detectAttachments(msg.bodyStructure as BodyPart | undefined),
  }
}

export interface NewMessagesResult {
  uidValidity: number
  highestUid: number
  messages: FetchedMessage[]
}

/** Fetch messages with uid > sinceUid from a folder (headers + bounded snippet). */
export async function fetchNewMessages(
  client: ImapFlow,
  folder: string,
  sinceUid: number,
  opts: { withSnippets?: boolean; cap?: number } = {},
): Promise<NewMessagesResult> {
  const cap = opts.cap ?? 200
  const lock = await client.getMailboxLock(folder)
  try {
    const mailbox = typeof client.mailbox === 'object' ? client.mailbox : null
    const uidValidity = Number(mailbox?.uidValidity ?? 0)
    const collected: { message: FetchedMessage; structure: BodyPart | undefined }[] = []
    let highestUid = sinceUid
    for await (const msg of client.fetch(
      { uid: `${sinceUid + 1}:*` },
      { uid: true, envelope: true, flags: true, bodyStructure: true, internalDate: true, headers: ['list-unsubscribe', 'authentication-results'] },
    )) {
      if (msg.uid <= sinceUid) continue   // servers echo the last message on n:* ranges
      collected.push({ message: { ...normalize(msg), snippet: null }, structure: msg.bodyStructure as BodyPart | undefined })
      highestUid = Math.max(highestUid, msg.uid)
    }
    // Newest first when capped — the tail of a huge first sync is old mail.
    collected.sort((a, b) => b.message.uid - a.message.uid)
    const kept = collected.slice(0, cap)
    if (opts.withSnippets !== false) {
      for (const { message, structure } of kept) {
        message.snippet = await fetchSnippet(client, message.uid, structure)
      }
    }
    return { uidValidity, highestUid, messages: kept.map((k) => k.message) }
  } finally {
    lock.release()
  }
}

/** Recipient addresses from Sent Messages (for the replied-to backfill). */
export async function fetchSentRecipients(
  client: ImapFlow,
  sinceUid: number,
  cap = 500,
): Promise<{ uidValidity: number; highestUid: number; recipients: string[] }> {
  const lock = await client.getMailboxLock(MAIL_FOLDERS.sent)
  try {
    const mailbox = typeof client.mailbox === 'object' ? client.mailbox : null
    const uidValidity = Number(mailbox?.uidValidity ?? 0)
    const recipients: string[] = []
    let highestUid = sinceUid
    let count = 0
    for await (const msg of client.fetch({ uid: `${sinceUid + 1}:*` }, { uid: true, envelope: true })) {
      if (msg.uid <= sinceUid || count++ > cap) continue
      highestUid = Math.max(highestUid, msg.uid)
      for (const rcpt of [...(msg.envelope?.to ?? []), ...(msg.envelope?.cc ?? [])]) {
        if (rcpt.address) recipients.push(rcpt.address.toLowerCase())
      }
    }
    return { uidValidity, highestUid, recipients }
  } finally {
    lock.release()
  }
}

export function logImapError(context: string, e: unknown): void {
  logger.warn(`[icloud-mail] ${context}: ${e instanceof Error ? e.message : e}`)
}
