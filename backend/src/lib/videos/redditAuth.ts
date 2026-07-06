// Reddit application-only OAuth ("installed client" grant). Reddit blocked all
// anonymous JSON access (www/api/.json and even yt-dlp's extractor now 403 without
// credentials), so the Reddit source requires a free registered app client id:
// reddit.com/prefs/apps → create app (type "installed app") → paste the client id
// into Videos settings. No reddit ACCOUNT login is needed at runtime — the grant
// authenticates the app itself with a stable per-install device id.

import { getAppSetting, setAppSetting } from '@/lib/settings'

export const REDDIT_CLIENT_ID_KEY = 'videos.reddit_client_id'
const DEVICE_ID_KEY = 'videos.reddit_device_id'
const UA = 'web:home-media-hub:v1 (self-hosted household server)'

let cached: { token: string; expiresAt: number; clientId: string } | null = null

export async function getRedditClientId(): Promise<string | null> {
  const v = await getAppSetting(REDDIT_CLIENT_ID_KEY)
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

async function deviceId(): Promise<string> {
  const existing = await getAppSetting(DEVICE_ID_KEY)
  if (typeof existing === 'string' && existing) return existing
  const id = crypto.randomUUID()
  await setAppSetting(DEVICE_ID_KEY, id)
  return id
}

/** App-only bearer token, cached until ~5 min before expiry. Null when no client id. */
export async function getRedditAccessToken(): Promise<string | null> {
  const clientId = await getRedditClientId()
  if (!clientId) return null
  if (cached && cached.clientId === clientId && Date.now() < cached.expiresAt) return cached.token

  const body = new URLSearchParams({
    grant_type: 'https://oauth.reddit.com/grants/installed_client',
    device_id: await deviceId(),
  })
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
    },
    body,
  })
  if (!res.ok) throw new Error(`reddit token request failed (${res.status}) — check the client id`)
  const data = await res.json() as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('reddit token response missing access_token')
  cached = {
    token: data.access_token,
    clientId,
    expiresAt: Date.now() + Math.max(60, (data.expires_in ?? 3600) - 300) * 1000,
  }
  return cached.token
}

export function redditUserAgent(): string {
  return UA
}
