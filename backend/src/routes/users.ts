import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { join } from 'node:path'
import { mkdir, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { db } from '@/db'
import { users, profilePins, userPreferences, conversations } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { hashPin } from '@/lib/pin'
import { dataDir } from '@/lib/download'
import {
  getProtections, setProtections, getInteractionStyle, setInteractionStyle,
  revokeAdultLoraGrants,
  type UserProtections, type InteractionStyle,
} from '@/lib/protections'
import { getAppSetting } from '@/lib/settings'
import type { AppEnv } from '@/types'

function sniffMime(header: Uint8Array): string {
  if (header[0] === 0xFF && header[1] === 0xD8) return 'image/jpeg'
  if (header[0] === 0x89 && header[1] === 0x50) return 'image/png'
  if (header[0] === 0x52 && header[1] === 0x49) return 'image/webp'
  if (header[0] === 0x47 && header[1] === 0x49) return 'image/gif'
  return 'image/jpeg'
}

const usersRoute = new Hono<AppEnv>()

// List all users — admin only
usersRoute.get('/', requireAdmin, async (c) => {
  const [all, pins] = await Promise.all([
    db.select({
      id: users.id,
      firstName: users.firstName,
      lastName: users.lastName,
      nickname: users.nickname,
      birthdate: users.birthdate,
      role: users.role,
      avatarUrl: users.avatarUrl,
      createdAt: users.createdAt,
    }).from(users),
    db.select({ userId: profilePins.userId }).from(profilePins),
  ])
  const pinSet = new Set(pins.map((p) => p.userId))
  return c.json(all.map((u) => ({ ...u, hasPin: pinSet.has(u.id) })))
})

// Create user — admin only
usersRoute.post('/', requireAdmin, async (c) => {
  const body = (await c.req.json()) as {
    firstName: string
    lastName: string
    nickname?: string
    birthdate: string
    role?: 'admin' | 'user'
  }

  const now = new Date()
  const id = crypto.randomUUID()

  const role = body.role === 'admin' ? 'admin' : 'user'
  await db.insert(users).values({
    id,
    firstName: body.firstName,
    lastName: body.lastName,
    nickname: body.nickname ?? body.firstName,
    birthdate: body.birthdate,
    role,
    createdAt: now,
    updatedAt: now,
  })

  // A new non-admin (e.g. a child) starts locked down: uncensored LLM, adult LoRAs/images,
  // and sensitive topics all blocked. Combined with the per-user content ceiling defaulting
  // to fully-censored for non-admins, a fresh account is safe until the admin opens it up.
  if (role !== 'admin') {
    await setProtections(id, {
      blockProfanity: false,
      blockUncensoredLlm: true,
      blockAdultLoras: true,
      blockAdultImages: true,
      blockSensitiveTopics: true,
    })
  }

  return c.json({ id }, 201)
})

// Update profile — admin or self
usersRoute.patch('/:id', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')

  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = (await c.req.json()) as Partial<{
    firstName: string
    lastName: string
    nickname: string
    birthdate: string
    dicebearStyle: string | null
    dicebearSeed: string | null
    dicebearConfig: string | null  // JSON string
  }>

  const { firstName, lastName, nickname, birthdate, dicebearStyle, dicebearSeed, dicebearConfig } = body
  const patch: Record<string, unknown> = { updatedAt: new Date() }
  if (firstName !== undefined) patch.firstName = firstName
  if (lastName !== undefined) patch.lastName = lastName
  if (nickname !== undefined) patch.nickname = nickname
  if (birthdate !== undefined) patch.birthdate = birthdate
  if (dicebearStyle !== undefined) patch.dicebearStyle = dicebearStyle
  if (dicebearSeed !== undefined) patch.dicebearSeed = dicebearSeed
  if (dicebearConfig !== undefined) patch.dicebearConfig = dicebearConfig

  await db
    .update(users)
    .set(patch)
    .where(eq(users.id, targetId))

  return c.json({ success: true })
})

// Delete user — admin only, cannot self-delete
usersRoute.delete('/:id', requireAdmin, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')

  if (currentUser.id === targetId) return c.json({ error: 'Cannot delete yourself' }, 400)

  await db.delete(users).where(eq(users.id, targetId))
  return c.json({ success: true })
})

// Clear all conversations for a user — admin only
usersRoute.delete('/:id/conversations', requireAdmin, async (c) => {
  const targetId = c.req.param('id')
  await db.delete(conversations).where(eq(conversations.userId, targetId))
  return c.json({ success: true })
})

// Serve avatar — no auth required (profile pics are not sensitive)
usersRoute.get('/:id/avatar', async (c) => {
  const targetId = c.req.param('id')
  const avatarPath = join(dataDir, 'avatars', targetId)
  if (!existsSync(avatarPath)) return c.notFound()
  const buf = await Bun.file(avatarPath).arrayBuffer()
  return new Response(buf, {
    headers: {
      'Content-Type': sniffMime(new Uint8Array(buf.slice(0, 4))),
      'Cache-Control': 'no-cache',
    },
  })
})

// Upload / replace avatar — admin or self
usersRoute.put('/:id/avatar', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')
  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  const form = await c.req.formData()
  const file = form.get('file') as File | null
  if (!file || !file.type.startsWith('image/')) return c.json({ error: 'Image file required' }, 400)
  if (file.size > 5 * 1024 * 1024) return c.json({ error: 'File too large (max 5 MB)' }, 400)

  const avatarsDir = join(dataDir, 'avatars')
  await mkdir(avatarsDir, { recursive: true })
  await Bun.write(join(avatarsDir, targetId), await file.arrayBuffer())

  const avatarUrl = `/api/users/${targetId}/avatar`
  await db.update(users).set({ avatarUrl, dicebearStyle: null, dicebearSeed: null, dicebearConfig: null, updatedAt: new Date() }).where(eq(users.id, targetId))
  return c.json({ avatarUrl })
})

// Remove avatar — admin or self
usersRoute.delete('/:id/avatar', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')
  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }
  try { await unlink(join(dataDir, 'avatars', targetId)) } catch { /* file may not exist */ }
  await db.update(users).set({ avatarUrl: null, updatedAt: new Date() }).where(eq(users.id, targetId))
  return c.json({ success: true })
})

// Set PIN — admin or self
usersRoute.put('/:id/pin', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')

  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const { pin } = (await c.req.json()) as { pin: string }
  if (!/^\d{4,6}$/.test(pin)) return c.json({ error: 'PIN must be 4–6 digits' }, 400)

  const now = new Date()
  const pinHash = await hashPin(pin)

  await db
    .insert(profilePins)
    .values({ id: crypto.randomUUID(), userId: targetId, pinHash, failedAttempts: 0, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: profilePins.userId,
      set: { pinHash, failedAttempts: 0, lockedUntil: null, updatedAt: now },
    })

  return c.json({ success: true })
})

// Remove PIN — admin or self
usersRoute.delete('/:id/pin', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')

  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  await db.delete(profilePins).where(eq(profilePins.userId, targetId))
  return c.json({ success: true })
})

// Get preferences — admin or self
usersRoute.get('/:id/preferences', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')

  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const prefs = await db.select().from(userPreferences).where(eq(userPreferences.userId, targetId))
  return c.json(Object.fromEntries(prefs.map((p) => [p.key, JSON.parse(p.value)])))
})

// Preference keys that gate content/safety — only an admin may set these (for anyone).
// Otherwise a non-admin (e.g. a child) could PATCH their own prefs to disable parental
// controls: `protections` (set via the admin-only PUT /:id/protections), `uncensored_images`
// (removes the image safety prefix), `safe_mode` (legacy content-ceiling bypass).
const ADMIN_ONLY_PREF_KEYS = new Set(['protections', 'uncensored_images', 'safe_mode', 'content_ceiling'])

// Set preferences — admin or self
usersRoute.patch('/:id/preferences', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')

  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const body = (await c.req.json()) as Record<string, unknown>
  if (currentUser.role !== 'admin' && Object.keys(body).some(k => ADMIN_ONLY_PREF_KEYS.has(k))) {
    return c.json({ error: 'That setting can only be changed by an administrator.' }, 403)
  }
  const now = new Date()

  for (const [key, value] of Object.entries(body)) {
    const serialized = JSON.stringify(value)
    if (serialized.length > 64_000) {
      return c.json({ error: `Preference '${key}' is too large.` }, 400)
    }
    await db
      .insert(userPreferences)
      .values({ id: crypto.randomUUID(), userId: targetId, key, value: serialized, updatedAt: now })
      .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: { value: serialized, updatedAt: now },
      })
  }

  return c.json({ success: true })
})

// Get protections + interaction style for a user — admin only
usersRoute.get('/:id/protections', requireAdmin, async (c) => {
  const targetId = c.req.param('id')
  const [protections, interactionStyle] = await Promise.all([
    getProtections(targetId),
    getInteractionStyle(targetId),
  ])
  return c.json({ protections, interactionStyle })
})

// Update protections (and optionally interaction style) for a user — admin only
usersRoute.put('/:id/protections', requireAdmin, async (c) => {
  const targetId = c.req.param('id')
  const body = (await c.req.json()) as {
    protections?: Partial<UserProtections>
    interactionStyle?: Partial<InteractionStyle>
  }

  if (body.protections !== undefined) {
    const current = await getProtections(targetId)
    const next: UserProtections = { ...current, ...body.protections }

    // Cascade: if blockAdultLoras is being turned on, revoke existing grants
    if (next.blockAdultLoras && !current.blockAdultLoras) {
      await revokeAdultLoraGrants(targetId)
    }

    await setProtections(targetId, next)
  }

  if (body.interactionStyle !== undefined) {
    await setInteractionStyle(targetId, body.interactionStyle)
  }

  return c.json({ success: true })
})

// Reverse-geocode lat/lng → city/country/timezone, store as user.location
// Called from the frontend after browser geolocation; doing this server-side
// avoids CORS issues with Nominatim and Open Meteo.
usersRoute.post('/:id/detect-location', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')

  if (currentUser.role !== 'admin' && currentUser.id !== targetId) {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const { lat, lng } = (await c.req.json()) as { lat: number; lng: number }
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return c.json({ error: 'lat and lng required' }, 400)
  }

  try {
    const [geoRes, tzRes] = await Promise.all([
      fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`,
        {
          headers: { 'User-Agent': 'loki-doki-app/1.0', 'Accept-Language': 'en' },
          signal: AbortSignal.timeout(8000),
        },
      ),
      fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m&timezone=auto`,
        { signal: AbortSignal.timeout(5000) },
      ),
    ])

    if (!geoRes.ok) return c.json({ error: 'Reverse geocoding failed' }, 502)

    const geo = (await geoRes.json()) as {
      address?: {
        city?: string; town?: string; village?: string; county?: string
        state?: string; country?: string; country_code?: string; state_district?: string
      }
    }

    const tzData = await tzRes.json() as { timezone?: string }

    const addr = geo.address ?? {}
    const city = addr.city ?? addr.town ?? addr.village ?? addr.county ?? 'Unknown'
    const country = addr.country ?? ''
    const countryCode = (addr.country_code ?? '').toUpperCase()
    const state = addr.state ?? ''
    const timezone = tzData.timezone ?? 'UTC'

    // For US addresses use "City, State" (e.g. "Milford, Connecticut") so the Patch
    // slug derivation can find the state — "Milford, United States" produces no slug.
    const displayName = countryCode === 'US' && state
      ? `${city}, ${state}`
      : country ? `${city}, ${country}` : city

    const location = {
      city,
      country,
      countryCode,
      lat,
      lng,
      timezone,
      displayName,
    }

    const now = new Date()
    await db
      .insert(userPreferences)
      .values({ id: crypto.randomUUID(), userId: targetId, key: 'user.location', value: JSON.stringify(location), updatedAt: now })
      .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: { value: JSON.stringify(location), updatedAt: now },
      })

    return c.json(location)
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return c.json({ error: 'Geocoding request timed out' }, 504)
    }
    return c.json({ error: String(err) }, 500)
  }
})

// Resolved connectivity status — effective mode + whether admin is forcing it
usersRoute.get('/:id/connectivity', requireAuth, async (c) => {
  const currentUser = c.get('user')
  const targetId = c.req.param('id')
  if (currentUser.id !== targetId && currentUser.role !== 'admin') {
    return c.json({ error: 'Forbidden' }, 403)
  }

  const [globalModeRaw, prefRow] = await Promise.all([
    getAppSetting('connectivity.global_mode'),
    db.select({ value: userPreferences.value })
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, targetId), eq(userPreferences.key, 'connectivity.mode')))
      .limit(1)
      .then(r => r[0] ?? null),
  ])

  const forcedByAdmin = globalModeRaw === 'offline'
  const userMode = prefRow ? (JSON.parse(prefRow.value) as 'online' | 'offline') : 'online'
  const effectiveMode: 'online' | 'offline' = forcedByAdmin ? 'offline' : userMode

  return c.json({ effectiveMode, forcedByAdmin, userMode })
})

export { usersRoute as users }
