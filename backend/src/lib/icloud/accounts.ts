import { connect as tlsConnect } from 'node:tls'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { icloudAccounts, users } from '@/db/schema'
import { encryptSecret, decryptSecret } from '@/lib/secrets'
import { logger } from '@/lib/logger'

// Per-member Apple Account connections (M1 of the iCloud plan). Auth is an
// app-specific password (ASP) — the only mechanism Apple allows third parties on
// CalDAV/IMAP; the main Apple password never works there and is never asked for.
// Two independent probes (CalDAV + IMAP) because the same ASP can be fine for one
// service and rejected by the other, and because Apple revokes ALL ASPs whenever
// the member changes their main Apple password — 'auth_error' is that signal, and
// Admin renders it as a "reconnect" call-to-action rather than a dead integration.
//
// Endpoints are env-overridable so a local fixture server can stand in for Apple
// in tests (ICLOUD_CALDAV_BASE, ICLOUD_IMAP_HOST/PORT/INSECURE).

const CALDAV_BASE = process.env.ICLOUD_CALDAV_BASE ?? 'https://caldav.icloud.com'
const IMAP_HOST = process.env.ICLOUD_IMAP_HOST ?? 'imap.mail.me.com'
const IMAP_PORT = Number(process.env.ICLOUD_IMAP_PORT ?? 993)
const PROBE_TIMEOUT_MS = 8000

export type ICloudProbeStatus = 'ok' | 'auth_error' | 'error' | 'unprobed'

export interface ICloudAccountSummary {
  id: string
  userId: string
  userNickname: string
  appleId: string
  caldavStatus: ICloudProbeStatus
  imapStatus: ICloudProbeStatus
  lastProbeAt: Date | null
  lastError: string | null
  createdAt: Date
}

interface ProbeResult {
  status: Exclude<ICloudProbeStatus, 'unprobed'>
  error?: string
  principalUrl?: string
}

function toSummary(row: typeof icloudAccounts.$inferSelect, nickname: string): ICloudAccountSummary {
  return {
    id: row.id, userId: row.userId, userNickname: nickname, appleId: row.appleId,
    caldavStatus: row.caldavStatus, imapStatus: row.imapStatus,
    lastProbeAt: row.lastProbeAt, lastError: row.lastError, createdAt: row.createdAt,
  }
}

export async function listAccounts(): Promise<ICloudAccountSummary[]> {
  const rows = await db
    .select({ account: icloudAccounts, nickname: users.nickname })
    .from(icloudAccounts)
    .innerJoin(users, eq(icloudAccounts.userId, users.id))
  return rows.map((r) => toSummary(r.account, r.nickname))
}

export async function getAccount(id: string): Promise<ICloudAccountSummary | null> {
  const [r] = await db
    .select({ account: icloudAccounts, nickname: users.nickname })
    .from(icloudAccounts)
    .innerJoin(users, eq(icloudAccounts.userId, users.id))
    .where(eq(icloudAccounts.id, id))
    .limit(1)
  return r ? toSummary(r.account, r.nickname) : null
}

/** Decrypted credentials for internal service use (CalDAV sync, IMAP watcher). */
export async function getAccountCredentials(id: string): Promise<{ appleId: string; password: string; caldavHomeUrl: string | null } | null> {
  const [row] = await db.select().from(icloudAccounts).where(eq(icloudAccounts.id, id)).limit(1)
  if (!row) return null
  return { appleId: row.appleId, password: await decryptSecret(row.passwordEnc), caldavHomeUrl: row.caldavHomeUrl }
}

/** ASPs are formatted xxxx-xxxx-xxxx-xxxx; users paste them with stray spaces. Normalize
 *  whitespace only — no format rejection, so an Apple format change can't lock us out. */
function normalizeAppPassword(raw: string): string {
  return raw.trim().replace(/\s+/g, '')
}

export async function createAccount(userId: string, appleId: string, appPassword: string): Promise<ICloudAccountSummary> {
  const now = new Date()
  const id = crypto.randomUUID()
  await db.insert(icloudAccounts).values({
    id, userId, appleId: appleId.trim().toLowerCase(),
    passwordEnc: await encryptSecret(normalizeAppPassword(appPassword)),
    createdAt: now, updatedAt: now,
  })
  return (await probeAccount(id))!
}

/** Reconnect: swap in a fresh ASP (the recovery path after Apple revokes them). */
export async function updateAccountPassword(id: string, appPassword: string): Promise<ICloudAccountSummary | null> {
  const [row] = await db.select({ id: icloudAccounts.id }).from(icloudAccounts).where(eq(icloudAccounts.id, id)).limit(1)
  if (!row) return null
  await db.update(icloudAccounts)
    .set({ passwordEnc: await encryptSecret(normalizeAppPassword(appPassword)), updatedAt: new Date() })
    .where(eq(icloudAccounts.id, id))
  return probeAccount(id)
}

export async function deleteAccount(id: string): Promise<void> {
  await db.delete(icloudAccounts).where(eq(icloudAccounts.id, id))
}

/** Run both live probes and persist the outcome. Returns the refreshed summary. */
export async function probeAccount(id: string): Promise<ICloudAccountSummary | null> {
  const creds = await getAccountCredentials(id)
  if (!creds) return null
  const [caldav, imap] = await Promise.all([
    probeCalDav(creds.appleId, creds.password),
    probeImap(creds.appleId, creds.password),
  ])
  const lastError = caldav.status !== 'ok' ? (caldav.error ?? null) : imap.status !== 'ok' ? (imap.error ?? null) : null
  await db.update(icloudAccounts)
    .set({
      caldavStatus: caldav.status,
      imapStatus: imap.status,
      caldavHomeUrl: caldav.principalUrl ?? undefined,   // keep the old cache on failure
      lastProbeAt: new Date(),
      lastError,
      updatedAt: new Date(),
    })
    .where(eq(icloudAccounts.id, id))
  return getAccount(id)
}

// ── CalDAV probe ──────────────────────────────────────────────────────────────
// PROPFIND for current-user-principal, following redirects manually because fetch's
// auto-follow demotes PROPFIND to GET on 301/302. 207 with a principal href = the ASP
// works AND we cache the per-account partition URL for M2's sync engine.

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>'

async function probeCalDav(appleId: string, password: string): Promise<ProbeResult> {
  const auth = 'Basic ' + Buffer.from(`${appleId}:${password}`).toString('base64')
  let url = `${CALDAV_BASE}/.well-known/caldav`
  try {
    for (let hop = 0; hop < 4; hop++) {
      const res = await fetch(url, {
        method: 'PROPFIND',
        redirect: 'manual',
        headers: { Authorization: auth, Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
        body: PROPFIND_BODY,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        if (!loc) return { status: 'error', error: `CalDAV redirect (HTTP ${res.status}) without Location` }
        url = new URL(loc, url).toString()
        continue
      }
      if (res.status === 401 || res.status === 403) {
        return { status: 'auth_error', error: 'Apple rejected the app-specific password (CalDAV)' }
      }
      if (res.status === 207 || res.ok) {
        const text = await res.text()
        const m = text.match(/current-user-principal[\s\S]*?href[^>]*>([^<]+)</i)
        return { status: 'ok', principalUrl: m?.[1] ? new URL(m[1], url).toString() : undefined }
      }
      return { status: 'error', error: `CalDAV HTTP ${res.status}` }
    }
    return { status: 'error', error: 'CalDAV: too many redirects' }
  } catch (e) {
    logger.warn(`[icloud] CalDAV probe failed for ${appleId}: ${e instanceof Error ? e.message : e}`)
    return { status: 'error', error: 'CalDAV unreachable' }
  }
}

// ── IMAP probe ────────────────────────────────────────────────────────────────
// Minimal raw-TLS LOGIN round-trip (imapflow arrives in M4; a probe doesn't need it).
// "a1 NO" from iCloud = bad/revoked ASP; anything transport-level = 'error'.

function imapQuote(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => '\\' + c)}"`
}

function probeImap(appleId: string, password: string): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false
    let stage: 'greeting' | 'login' = 'greeting'
    let buf = ''
    const socket = tlsConnect({
      host: IMAP_HOST, port: IMAP_PORT, servername: IMAP_HOST,
      rejectUnauthorized: process.env.ICLOUD_IMAP_INSECURE !== '1',
    })
    const finish = (r: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { socket.end() } catch { /* already closed */ }
      resolve(r)
    }
    const timer = setTimeout(() => finish({ status: 'error', error: 'IMAP timeout' }), PROBE_TIMEOUT_MS + 2000)
    socket.on('error', (e) => finish({ status: 'error', error: `IMAP: ${e.message}` }))
    socket.on('close', () => finish({ status: 'error', error: 'IMAP connection closed' }))
    socket.on('data', (d: Buffer) => {
      buf += d.toString('utf8')
      if (stage === 'greeting') {
        if (buf.includes('* OK')) {
          stage = 'login'
          buf = ''
          socket.write(`a1 LOGIN ${imapQuote(appleId)} ${imapQuote(password)}\r\n`)
        } else if (buf.includes('* BYE')) {
          finish({ status: 'error', error: 'IMAP refused the connection' })
        }
      } else {
        if (/^a1 OK/m.test(buf)) {
          socket.write('a2 LOGOUT\r\n')
          finish({ status: 'ok' })
        } else if (/^a1 (NO|BAD)/m.test(buf)) {
          finish({ status: 'auth_error', error: 'Apple rejected the app-specific password (IMAP)' })
        }
      }
    })
  })
}
