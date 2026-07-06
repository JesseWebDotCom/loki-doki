// Linked YouTube account — OAuth via the InnerTube TV-client device flow (the "go to
// google.com/device and enter this code" login a smart TV uses). This is the only OAuth
// surface Google still allows unofficial InnerTube clients, and it needs zero provisioning:
// the client identity is YouTube TV's own, scraped from its app bundle. Credentials never
// touch us — Google runs the approval on their site and hands us tokens.
//
// Lifecycle: startAccountLink() requests a device+user code and polls the token endpoint in
// the background until the user approves (or the code expires); tokens land in yt_accounts.
// getValidAccessToken() transparently refreshes; a refresh rejected with invalid_grant
// (revoked access / password change) flips the row to 'expired' and notifies the user to
// re-link. Authenticated calls made with these tokens MUST use the TV client context —
// see tvClient.ts.

import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { ytAccounts, ytSubscriptions, ytCollections } from '@/db/schema'
import { getAppSetting, setAppSetting } from '@/lib/settings'
import { emitNotification } from '@/lib/notify'
import { logger } from '@/lib/logger'

const YT_BASE = 'https://www.youtube.com'
const CODE_URL = `${YT_BASE}/o/oauth2/device/code`
const TOKEN_URL = `${YT_BASE}/o/oauth2/token`
const REVOKE_URL = `${YT_BASE}/o/oauth2/revoke`
// The Cobalt UA makes youtube.com/tv serve the real TV app shell (a desktop UA gets a
// "not supported on this browser" interstitial with no app bundle to scrape).
const TV_UA = 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version'
const DEVICE_GRANT = 'http://oauth.net/grant_type/device/1.0'
const SCOPE = 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content'

const IDENTITY_KEY = 'youtube.tv_client_identity'

export interface TvClientIdentity { clientId: string; clientSecret: string }

// ── TV client identity ─────────────────────────────────────────────────────────
// YouTube TV's OAuth client_id/client_secret ship in its public app bundle (every TV
// ships them; they are not user secrets). They rotate rarely — cache the scrape and
// re-scrape only when asked to force (e.g. after an auth error during device-code).

let identityPromise: Promise<TvClientIdentity> | null = null

export async function getTvClientIdentity(force = false): Promise<TvClientIdentity> {
  if (!force) {
    const cached = await getAppSetting(IDENTITY_KEY) as TvClientIdentity | null
    if (cached?.clientId && cached?.clientSecret) return cached
  }
  // Coalesce concurrent scrapes.
  identityPromise ??= scrapeTvClientIdentity().finally(() => { identityPromise = null })
  const identity = await identityPromise
  await setAppSetting(IDENTITY_KEY, identity)
  return identity
}

async function scrapeTvClientIdentity(): Promise<TvClientIdentity> {
  const page = await fetch(`${YT_BASE}/tv`, {
    headers: { 'User-Agent': TV_UA, Referer: `${YT_BASE}/tv`, 'Accept-Language': 'en-US' },
    signal: AbortSignal.timeout(15000),
  })
  if (!page.ok) throw new Error(`youtube.com/tv → ${page.status}`)
  const html = await page.text()

  const scriptSrc = /<script\s+id="base-js"\s+src="([^"]+)"[^>]*><\/script>/.exec(html)?.[1]
  if (!scriptSrc) throw new Error('TV app bundle URL not found in /tv page')
  const scriptUrl = new URL(scriptSrc, YT_BASE).toString()

  const script = await fetch(scriptUrl, {
    headers: { 'User-Agent': TV_UA },
    signal: AbortSignal.timeout(20000),
  })
  if (!script.ok) throw new Error(`TV app bundle → ${script.status}`)
  const js = await script.text()

  const identity = /clientId:"(?<client_id>[^"]+)",[^"]*?:"(?<client_secret>[^"]+)"/.exec(js)
  const clientId = identity?.groups?.client_id
  const clientSecret = identity?.groups?.client_secret
  if (!clientId || !clientSecret) throw new Error('client identity not found in TV app bundle')
  logger.info({ clientId }, '[yt-account] scraped TV client identity')
  return { clientId, clientSecret }
}

// ── Device-code link flow ──────────────────────────────────────────────────────
// In-memory per-user flow state: the flow is short-lived (Google's codes expire in
// ~15 min) and inherently interactive, so it doesn't belong in the DB. A server restart
// mid-flow just means the user clicks "Sign in" again.

export interface LinkFlow {
  status: 'pending' | 'success' | 'error'
  userCode: string
  verificationUrl: string
  expiresAt: number     // Unix ms
  error?: string
}

interface ActiveFlow extends LinkFlow {
  timer?: ReturnType<typeof setTimeout>
}

const flows = new Map<string, ActiveFlow>()

export function getLinkFlow(userId: string): LinkFlow | null {
  const f = flows.get(userId)
  if (!f) return null
  const { timer: _timer, ...rest } = f
  return rest
}

export async function startAccountLink(userId: string): Promise<LinkFlow> {
  cancelLinkFlow(userId)
  const identity = await getTvClientIdentity()

  const res = await fetch(CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': TV_UA },
    body: JSON.stringify({
      client_id: identity.clientId,
      scope: SCOPE,
      device_id: crypto.randomUUID(),
      device_model: 'ytlr::',
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`device code request → ${res.status}`)
  const data = await res.json() as {
    device_code: string; user_code: string; verification_url: string
    interval: number; expires_in: number; error_code?: string
  }
  if (data.error_code) throw new Error(`device code request → ${data.error_code}`)

  const flow: ActiveFlow = {
    status: 'pending',
    userCode: data.user_code,
    verificationUrl: data.verification_url,
    expiresAt: Date.now() + data.expires_in * 1000,
  }
  flows.set(userId, flow)
  scheduleTokenPoll(userId, flow, identity, data.device_code, Math.max(data.interval, 3))
  return getLinkFlow(userId)!
}

export function cancelLinkFlow(userId: string): void {
  const existing = flows.get(userId)
  if (existing?.timer) clearTimeout(existing.timer)
  flows.delete(userId)
}

function scheduleTokenPoll(userId: string, flow: ActiveFlow, identity: TvClientIdentity, deviceCode: string, intervalSec: number): void {
  flow.timer = setTimeout(async () => {
    // The flow may have been cancelled/replaced while we slept.
    if (flows.get(userId) !== flow || flow.status !== 'pending') return
    if (Date.now() > flow.expiresAt) {
      flow.status = 'error'
      flow.error = 'The code expired before it was entered. Start again to get a new one.'
      return
    }
    try {
      const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': TV_UA },
        body: JSON.stringify({
          client_id: identity.clientId,
          client_secret: identity.clientSecret,
          code: deviceCode,
          grant_type: DEVICE_GRANT,
        }),
        signal: AbortSignal.timeout(15000),
      })
      const data = await res.json() as Record<string, any>

      if (data.error) {
        switch (data.error) {
          case 'authorization_pending':
            scheduleTokenPoll(userId, flow, identity, deviceCode, intervalSec)
            return
          case 'slow_down':
            scheduleTokenPoll(userId, flow, identity, deviceCode, intervalSec + 5)
            return
          case 'expired_token':
            flow.status = 'error'
            flow.error = 'The code expired before it was entered. Start again to get a new one.'
            return
          case 'access_denied':
            flow.status = 'error'
            flow.error = 'Sign-in was declined on the Google approval page.'
            return
          default:
            flow.status = 'error'
            flow.error = `Google returned an unexpected error (${data.error}).`
            return
        }
      }

      await saveLinkedAccount(userId, identity, data as {
        access_token: string; refresh_token: string; expires_in: number
      })
      flow.status = 'success'
    } catch (err) {
      // Transient network failure — keep polling until the code itself expires.
      logger.warn({ err: String(err) }, '[yt-account] token poll failed, retrying')
      scheduleTokenPoll(userId, flow, identity, deviceCode, intervalSec)
    }
  }, intervalSec * 1000)
  // Don't hold the process open for a login poll.
  flow.timer.unref?.()
}

async function saveLinkedAccount(userId: string, identity: TvClientIdentity, tokens: { access_token: string; refresh_token: string; expires_in: number }): Promise<void> {
  const now = new Date()
  await db.delete(ytAccounts).where(eq(ytAccounts.userId, userId))
  await db.insert(ytAccounts).values({
    id: crypto.randomUUID(),
    userId,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
    clientId: identity.clientId,
    clientSecret: identity.clientSecret,
    connectedAt: now,
  })
  logger.info({ userId }, '[yt-account] account linked')

  // Fill in the display identity + run the first pull in the background — the link flow
  // itself is done and the UI should flip to "connected" immediately.
  void (async () => {
    try {
      const { fetchAccountInfo } = await import('@/lib/youtube/tvClient')
      const info = await fetchAccountInfo(tokens.access_token)
      if (info) {
        await db.update(ytAccounts).set({
          channelTitle: info.title,
          channelHandle: info.handle,
          channelAvatarUrl: info.avatarUrl,
        }).where(eq(ytAccounts.userId, userId))
      }
    } catch (err) {
      logger.warn({ err: String(err) }, '[yt-account] account info fetch failed')
    }
    try {
      const { syncAccount } = await import('@/lib/youtube/accountSync')
      await syncAccount(userId)
    } catch (err) {
      logger.warn({ err: String(err) }, '[yt-account] initial sync failed')
    }
  })()
}

// ── Token lifecycle ────────────────────────────────────────────────────────────

export type YtAccount = typeof ytAccounts.$inferSelect

export async function getAccountRow(userId: string): Promise<YtAccount | null> {
  const [row] = await db.select().from(ytAccounts).where(eq(ytAccounts.userId, userId)).limit(1)
  return row ?? null
}

/** A refresh is due 60s before nominal expiry so an in-flight call can't straddle it. */
const EXPIRY_SLACK_MS = 60_000

/**
 * Access token for authenticated TV-client calls, refreshing when needed. Returns null when
 * no account is linked or the account is expired (caller should treat as "not linked").
 * Pass force after a mid-call 401 — Google occasionally invalidates tokens early.
 */
export async function getValidAccessToken(userId: string, force = false): Promise<string | null> {
  const account = await getAccountRow(userId)
  if (!account || account.status !== 'active') return null
  if (!force && account.expiresAt.getTime() - EXPIRY_SLACK_MS > Date.now()) return account.accessToken

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': TV_UA },
      body: JSON.stringify({
        client_id: account.clientId,
        client_secret: account.clientSecret,
        refresh_token: account.refreshToken,
        grant_type: 'refresh_token',
      }),
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json() as Record<string, any>
    if (data.error === 'invalid_grant') {
      await markAccountExpired(userId)
      return null
    }
    if (!res.ok || data.error || !data.access_token) {
      throw new Error(`token refresh → ${data.error ?? res.status}`)
    }
    await db.update(ytAccounts).set({
      accessToken: data.access_token,
      expiresAt: new Date(Date.now() + (data.expires_in ?? 3600) * 1000),
    }).where(eq(ytAccounts.userId, userId))
    return data.access_token as string
  } catch (err) {
    logger.warn({ userId, err: String(err) }, '[yt-account] token refresh failed')
    throw err
  }
}

async function markAccountExpired(userId: string): Promise<void> {
  await db.update(ytAccounts).set({ status: 'expired' }).where(eq(ytAccounts.userId, userId))
  logger.warn({ userId }, '[yt-account] refresh token rejected — account marked expired')
  await emitNotification({
    type: 'system',
    userId,
    title: 'YouTube account disconnected',
    body: 'Google stopped accepting the saved sign-in (this happens after a password change or revoking access). Reconnect to keep your subscriptions and Watch Later in sync.',
    url: '/youtube/settings/account',
    dedupeKey: `yt-account-expired:${userId}`,
  })
}

/**
 * Unlink: best-effort token revoke at Google, drop the row, and convert every mirrored
 * row to 'local' so the library the user sees doesn't vanish — it just stops syncing.
 */
export async function unlinkAccount(userId: string): Promise<void> {
  cancelLinkFlow(userId)
  const account = await getAccountRow(userId)
  if (!account) return
  try {
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(account.accessToken)}`, {
      method: 'POST',
      headers: { 'User-Agent': TV_UA },
      signal: AbortSignal.timeout(10000),
    })
  } catch { /* revoke is courtesy — the row deletion is what matters to us */ }
  await db.delete(ytAccounts).where(eq(ytAccounts.userId, userId))
  await db.update(ytSubscriptions).set({ source: 'local' })
    .where(eq(ytSubscriptions.userId, userId))
  await db.update(ytCollections).set({ source: 'local' })
    .where(eq(ytCollections.userId, userId))
  logger.info({ userId }, '[yt-account] account unlinked')
}
