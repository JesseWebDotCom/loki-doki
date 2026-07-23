import { Hono } from 'hono'
import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { userPreferences, appSettings, users } from '@/db/schema'
import { requireAuth, requireAdmin } from '@/middleware/auth'
import { buildStarterLayout } from '@/lib/home/starterLayout'
import type { AppEnv } from '@/types'

const homeLayout = new Hono<AppEnv>()

const PREF_KEY = 'home.layout'
const DEFAULT_SETTING_KEY = 'home.layout.default'
const LOCK_KEY = 'home.layout.locked'

export interface HomeWidget {
  toolId: string
  colSpan: 1 | 2
}

export interface HomeRow {
  id: string
  cols: HomeWidget[]
}

export type TickerSource = 'sports' | 'youtube' | 'news' | 'podcast' | 'calendar'

export interface TickerConfig {
  enabled: boolean
  sources: TickerSource[]
}

export interface HomeLayoutHeader {
  weather: boolean
  jokes: boolean
  ticker: TickerConfig
  locked: boolean
}

export interface HomeLayout {
  header: HomeLayoutHeader
  canvas: HomeRow[]
}

// A fresh install should never land on a blank home. These widgets all return
// content with zero configuration (world news + historical events), so a brand
// new user sees a populated screen they can then customise or rearrange.
const ALL_TICKER_SOURCES: TickerSource[] = ['calendar', 'sports', 'youtube', 'news']

const DEFAULT_LAYOUT: HomeLayout = {
  header: { weather: true, jokes: true, ticker: { enabled: true, sources: ALL_TICKER_SOURCES }, locked: false },
  canvas: [
    { id: 'default-news', cols: [{ toolId: 'news', colSpan: 2 }] },
    { id: 'default-on-this-day', cols: [{ toolId: 'on-this-day', colSpan: 2 }] },
  ],
}

async function getSystemDefaultLayout(): Promise<HomeLayout> {
  const [row] = await db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, DEFAULT_SETTING_KEY))
    .limit(1)
  if (!row) return DEFAULT_LAYOUT
  try { return JSON.parse(row.value) as HomeLayout } catch { return DEFAULT_LAYOUT }
}

/** True when an admin has explicitly set a system default layout (which must be respected
 *  over the auto-generated starter). */
async function hasAdminDefault(): Promise<boolean> {
  const [row] = await db
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, DEFAULT_SETTING_KEY))
    .limit(1)
  return !!row
}

async function getUserLayout(userId: string): Promise<HomeLayout | null> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, PREF_KEY)))
    .limit(1)
  if (!row) return null
  try { return JSON.parse(row.value) as HomeLayout } catch { return null }
}

async function isLayoutLocked(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: userPreferences.value })
    .from(userPreferences)
    .where(and(eq(userPreferences.userId, userId), eq(userPreferences.key, LOCK_KEY)))
    .limit(1)
  if (!row) return false
  try { return JSON.parse(row.value) === true } catch { return false }
}

// ── GET /api/home-layout ───────────────────────────────────────────────────────

homeLayout.get('/', requireAuth, async (c) => {
  const user = c.get('user')
  const [layout, locked, systemDefault] = await Promise.all([
    getUserLayout(user.id),
    isLayoutLocked(user.id),
    getSystemDefaultLayout(),
  ])

  // Migrate legacy home.highlights into header if no layout set yet
  if (!layout) {
    const [highlightsRow] = await db
      .select({ value: userPreferences.value })
      .from(userPreferences)
      .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, 'home.highlights')))
      .limit(1)

    if (highlightsRow) {
      try {
        const h = JSON.parse(highlightsRow.value) as { sports?: boolean; jokes?: boolean }
        const legacySports = (h as { sports?: boolean }).sports
        const migratedLayout: HomeLayout = {
          ...systemDefault,
          header: {
            ...systemDefault.header,
            ticker: {
              enabled: legacySports !== false,
              sources: legacySports !== false ? ALL_TICKER_SOURCES : [],
            },
            jokes: h.jokes ?? systemDefault.header.jokes,
            locked,
          },
        }
        return c.json({ layout: migratedLayout, locked })
      } catch { /* fall through */ }
    }

    // No saved layout and no legacy prefs: seed an inline starter inferred from the
    // installed apps (#11), unless an admin set a custom system default (respect that
    // fully). Returned inline, NOT persisted, so it stays "auto" until the user edits.
    if (!(await hasAdminDefault())) {
      const starter = await buildStarterLayout(systemDefault)
      return c.json({ layout: { ...starter, header: { ...starter.header, locked } }, locked })
    }
  }

  return c.json({
    layout: { ...(layout ?? systemDefault), header: { ...(layout ?? systemDefault).header, locked } },
    locked,
  })
})

// ── PUT /api/home-layout ───────────────────────────────────────────────────────

homeLayout.put('/', requireAuth, async (c) => {
  const user = c.get('user')
  const locked = await isLayoutLocked(user.id)
  if (locked) return c.json({ error: 'Layout is locked by admin' }, 403)

  const body = await c.req.json() as HomeLayout
  const now = new Date()
  const value = JSON.stringify(body)
  if (value.length > 64_000) return c.json({ error: 'Layout is too large.' }, 400)

  await db
    .insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId: user.id, key: PREF_KEY, value, updatedAt: now })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value, updatedAt: now },
    })

  return c.json({ ok: true })
})

// ── DELETE /api/home-layout ──────────────────────────────────────────────────
// Reset the user's home back to the auto-generated starter: drop their saved layout so
// GET falls through to buildStarterLayout again (stays "auto" until they edit once more).

homeLayout.delete('/', requireAuth, async (c) => {
  const user = c.get('user')
  const locked = await isLayoutLocked(user.id)
  if (locked) return c.json({ error: 'Layout is locked by admin' }, 403)
  await db
    .delete(userPreferences)
    .where(and(eq(userPreferences.userId, user.id), eq(userPreferences.key, PREF_KEY)))
  return c.json({ ok: true })
})

// ── GET /api/home-layout/default (admin) ─────────────────────────────────────

homeLayout.get('/default', requireAdmin, async (c) => {
  const layout = await getSystemDefaultLayout()
  return c.json({ layout })
})

// ── PUT /api/home-layout/default (admin) ─────────────────────────────────────

homeLayout.put('/default', requireAdmin, async (c) => {
  const body = await c.req.json() as HomeLayout
  const now = new Date()
  const value = JSON.stringify(body)
  await db
    .insert(appSettings)
    .values({ id: crypto.randomUUID(), key: DEFAULT_SETTING_KEY, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
  return c.json({ ok: true })
})

// ── GET /api/home-layout/users/:userId (admin) ────────────────────────────────

homeLayout.get('/users/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  const [layout, locked] = await Promise.all([getUserLayout(userId), isLayoutLocked(userId)])
  return c.json({ layout, locked })
})

// ── PUT /api/home-layout/users/:userId (admin) ────────────────────────────────

homeLayout.put('/users/:userId', requireAdmin, async (c) => {
  const userId = c.req.param('userId')
  // Validate the target exists first — userPreferences.userId has an FK to users, so a
  // bogus id would otherwise surface as a 500 constraint error instead of a clean 404.
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId))
  if (!target) return c.json({ error: 'User not found' }, 404)
  const body = await c.req.json() as { layout?: HomeLayout; locked?: boolean }
  const now = new Date()

  if (body.layout !== undefined) {
    const value = JSON.stringify(body.layout)
    if (value.length > 64_000) return c.json({ error: 'Layout is too large.' }, 400)
    await db
      .insert(userPreferences)
      .values({ id: crypto.randomUUID(), userId, key: PREF_KEY, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: { value, updatedAt: now },
      })
  }

  if (body.locked !== undefined) {
    const value = JSON.stringify(body.locked)
    await db
      .insert(userPreferences)
      .values({ id: crypto.randomUUID(), userId, key: LOCK_KEY, value, updatedAt: now })
      .onConflictDoUpdate({
        target: [userPreferences.userId, userPreferences.key],
        set: { value, updatedAt: now },
      })
  }

  return c.json({ ok: true })
})

export { homeLayout }
