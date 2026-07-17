// Quick Connect: sign a TV in with a short code instead of typing a password on a remote.
// Jellyfin's Quick Connect and every streaming app's "enter this code" flow; the same
// pattern we already use to link a YouTube account, pointed at our own login.
//
// Flow: the TV asks for a code and polls; a signed-in phone/desktop approves that code;
// the TV's next poll returns a session cookie for the approving user.
//
// In-memory on purpose (like drop presence and watch-together): a pending login is
// worthless after a restart, and codes expire in minutes anyway.

import { randomInt } from 'node:crypto'
import { logger } from '@/lib/logger'

export interface QuickConnectRequest {
  code: string
  /** Set once someone approves; the TV's poll then mints a session for them. */
  approvedUserId: string | null
  /** Human label for the approval prompt ("Living room TV"). */
  label: string
  createdAt: number
  expiresAt: number
  /** True once a session has been minted, so a code can never be redeemed twice. */
  consumed: boolean
}

const requests = new Map<string, QuickConnectRequest>()
const TTL_MS = 5 * 60_000

// No 0/O/1/I: these get read aloud across a room off a TV screen.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function newCode(): string {
  let code = ''
  for (let i = 0; i < 6; i++) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}

function sweep(): void {
  const now = Date.now()
  for (const [code, r] of requests) if (r.expiresAt < now) requests.delete(code)
}

/** Start a login: the caller shows this code and polls until it's approved. */
export function createQuickConnect(label: string): QuickConnectRequest {
  sweep()
  let code = newCode()
  while (requests.has(code)) code = newCode()
  const now = Date.now()
  const req: QuickConnectRequest = {
    code,
    approvedUserId: null,
    label: label.trim().slice(0, 60) || 'A device',
    createdAt: now,
    expiresAt: now + TTL_MS,
    consumed: false,
  }
  requests.set(code, req)
  logger.info(`[quick-connect] code ${code} issued for "${req.label}"`)
  return req
}

export function getQuickConnect(code: string): QuickConnectRequest | null {
  sweep()
  return requests.get(code.trim().toUpperCase()) ?? null
}

/** Approve a code as `userId`. Returns false for unknown/expired/already-approved codes. */
export function approveQuickConnect(code: string, userId: string): boolean {
  const req = getQuickConnect(code)
  if (!req || req.approvedUserId || req.consumed) return false
  req.approvedUserId = userId
  logger.info(`[quick-connect] code ${req.code} approved for user ${userId}`)
  return true
}

/** The waiting device claims its approval, exactly once. */
export function consumeQuickConnect(code: string): string | null {
  const req = getQuickConnect(code)
  if (!req || !req.approvedUserId || req.consumed) return null
  req.consumed = true
  // Keep the row briefly so a duplicate poll gets a clean "already used" rather than a
  // confusing "unknown code"; the sweep reaps it.
  return req.approvedUserId
}

/** Pending logins awaiting approval, for the approver's UI. */
export function listPendingQuickConnects(): Array<{ code: string; label: string; createdAt: number }> {
  sweep()
  return Array.from(requests.values())
    .filter((r) => !r.approvedUserId && !r.consumed)
    .map((r) => ({ code: r.code, label: r.label, createdAt: r.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt)
}
