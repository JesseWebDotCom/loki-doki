// Admin: family audio controls. Per-profile allowlist mode + entries, blocklist, time
// budget, quiet hours, volume cap, plus the weekly parent digests. Enforcement lives in
// lib/family/audioPolicy.ts; this file is the management surface.

import { Hono } from 'hono'
import { and, desc, eq, gte, like, or, isNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  familyAudioSettings, familyAudioEntries, familyAudioUsage, familyAudioDigests,
  users, musicStations, musicPlaylists, podcastShows,
} from '@/db/schema'
import { requireAdmin } from '@/middleware/auth'
import { invalidateFamilyAudio, normArtistKey, localDayKey, type FamilyEntryKind } from '@/lib/family/audioPolicy'
import { runFamilyAudioDigest, weekStartOf } from '@/lib/family/digest'
import { searchArtists } from '@/lib/music/catalog'
import { searchPodcasts } from '@/lib/podcast/directory'
import type { AppEnv } from '@/types'

export const adminFamilyAudio = new Hono<AppEnv>()
adminFamilyAudio.use('*', requireAdmin)

const ENTRY_KINDS: FamilyEntryKind[] = ['artist', 'playlist', 'station', 'podcastShow']

function serializeSettings(row: typeof familyAudioSettings.$inferSelect | undefined) {
  return {
    allowlistOnly: !!row?.allowlistOnly,
    dailyAudioMinutes: row?.dailyAudioMinutes ?? null,
    quietHoursStart: row?.quietHoursStart ?? null,
    quietHoursEnd: row?.quietHoursEnd ?? null,
    maxVolumePercent: row?.maxVolumePercent ?? null,
  }
}

// ── GET /: every profile with its settings + entry counts ───────────────────────────

adminFamilyAudio.get('/users', async (c) => {
  const [allUsers, allSettings, allEntries] = await Promise.all([
    db.select({ id: users.id, firstName: users.firstName, nickname: users.nickname, role: users.role, avatarUrl: users.avatarUrl })
      .from(users).orderBy(users.firstName),
    db.select().from(familyAudioSettings),
    db.select({ userId: familyAudioEntries.userId, list: familyAudioEntries.list }).from(familyAudioEntries),
  ])
  const settingsByUser = new Map(allSettings.map(s => [s.userId, s]))
  const counts = new Map<string, { allow: number; block: number }>()
  for (const e of allEntries) {
    const cur = counts.get(e.userId) ?? { allow: 0, block: 0 }
    if (e.list === 'allow') cur.allow++
    else cur.block++
    counts.set(e.userId, cur)
  }
  return c.json({
    users: allUsers.map(u => ({
      id: u.id,
      name: u.nickname || u.firstName,
      role: u.role,
      avatarUrl: u.avatarUrl,
      settings: serializeSettings(settingsByUser.get(u.id)),
      allowCount: counts.get(u.id)?.allow ?? 0,
      blockCount: counts.get(u.id)?.block ?? 0,
    })),
  })
})

// ── GET /users/:id: settings + entries + usage snapshot ────────────────────────────

adminFamilyAudio.get('/users/:id', async (c) => {
  const userId = c.req.param('id')
  const weekKey = localDayKey(weekStartOf())
  const [settingsRow, entries, usage] = await Promise.all([
    db.select().from(familyAudioSettings).where(eq(familyAudioSettings.userId, userId)).limit(1),
    db.select().from(familyAudioEntries).where(eq(familyAudioEntries.userId, userId)).orderBy(desc(familyAudioEntries.createdAt)),
    db.select().from(familyAudioUsage).where(and(eq(familyAudioUsage.userId, userId), gte(familyAudioUsage.day, weekKey))),
  ])
  const today = localDayKey()
  let todaySec = 0
  let weekSec = 0
  for (const r of usage) {
    weekSec += r.seconds
    if (r.day === today) todaySec += r.seconds
  }
  return c.json({
    settings: serializeSettings(settingsRow[0]),
    entries: entries.map(e => ({
      id: e.id, list: e.list, kind: e.kind, ref: e.ref, label: e.label,
      addedAt: e.createdAt instanceof Date ? e.createdAt.getTime() : e.createdAt,
    })),
    usage: { todayMinutes: Math.round(todaySec / 60), weekMinutes: Math.round(weekSec / 60) },
  })
})

// ── PUT /users/:id/settings ──────────────────────────────────────────────────────────

const HM_RE = /^\d{1,2}:\d{2}$/

adminFamilyAudio.put('/users/:id/settings', async (c) => {
  const userId = c.req.param('id')
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  if (!target) return c.json({ error: 'User not found' }, 404)

  const body = await c.req.json().catch(() => ({})) as {
    allowlistOnly?: boolean
    dailyAudioMinutes?: number | null
    quietHoursStart?: string | null
    quietHoursEnd?: string | null
    maxVolumePercent?: number | null
  }
  const clampInt = (v: unknown, min: number, max: number): number | null => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : null
  }
  const hm = (v: unknown): string | null => (typeof v === 'string' && HM_RE.test(v.trim()) ? v.trim() : null)

  const now = new Date()
  const values = {
    allowlistOnly: body.allowlistOnly === true,
    dailyAudioMinutes: body.dailyAudioMinutes == null ? null : clampInt(body.dailyAudioMinutes, 5, 24 * 60),
    quietHoursStart: body.quietHoursStart == null ? null : hm(body.quietHoursStart),
    quietHoursEnd: body.quietHoursEnd == null ? null : hm(body.quietHoursEnd),
    maxVolumePercent: body.maxVolumePercent == null ? null : clampInt(body.maxVolumePercent, 5, 100),
    updatedAt: now,
  }
  // Quiet hours only make sense as a pair.
  if (!values.quietHoursStart || !values.quietHoursEnd) {
    values.quietHoursStart = null
    values.quietHoursEnd = null
  }

  await db.insert(familyAudioSettings)
    .values({ id: crypto.randomUUID(), userId, createdAt: now, ...values })
    .onConflictDoUpdate({ target: familyAudioSettings.userId, set: values })
  invalidateFamilyAudio(userId)
  return c.json({ ok: true, settings: values })
})

// ── Entries ──────────────────────────────────────────────────────────────────────────

adminFamilyAudio.post('/users/:id/entries', async (c) => {
  const userId = c.req.param('id')
  const admin = c.get('user')
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1)
  if (!target) return c.json({ error: 'User not found' }, 404)

  const body = await c.req.json().catch(() => ({})) as {
    list?: string; kind?: string; ref?: string; altRef?: string | null; label?: string
  }
  const list = body.list === 'block' ? 'block' : body.list === 'allow' ? 'allow' : null
  const kind = ENTRY_KINDS.includes(body.kind as FamilyEntryKind) ? body.kind as FamilyEntryKind : null
  const label = body.label?.trim()
  if (!list || !kind || !label) return c.json({ error: 'list, kind, and label are required' }, 400)

  let ref = body.ref?.trim() || ''
  let altRef = body.altRef?.trim() || null
  if (kind === 'artist') {
    // Artists match by normalized name; a provided ref (MBID) rides along as altRef.
    altRef = ref && !altRef ? ref : altRef
    ref = normArtistKey(label)
  } else if (kind === 'podcastShow' && ref) {
    // Canonicalize a feed URL to the local show row when it already exists, so the
    // entry matches both the household library and playback ids.
    if (/^https?:\/\//i.test(ref)) {
      const [show] = await db.select({ id: podcastShows.id }).from(podcastShows)
        .where(eq(podcastShows.feedUrl, ref)).limit(1)
      if (show) { altRef = altRef ?? ref; ref = show.id }
    }
  }
  if (!ref) return c.json({ error: 'Could not resolve a reference for this item' }, 400)

  const id = crypto.randomUUID()
  await db.insert(familyAudioEntries)
    .values({ id, userId, list, kind, ref, altRef, label, addedBy: admin.id, createdAt: new Date() })
    .onConflictDoUpdate({
      target: [familyAudioEntries.userId, familyAudioEntries.list, familyAudioEntries.kind, familyAudioEntries.ref],
      set: { label, altRef, addedBy: admin.id },
    })
  invalidateFamilyAudio(userId)
  return c.json({ ok: true, entry: { id, list, kind, ref, label } })
})

adminFamilyAudio.delete('/users/:id/entries/:entryId', async (c) => {
  const userId = c.req.param('id')
  await db.delete(familyAudioEntries)
    .where(and(eq(familyAudioEntries.userId, userId), eq(familyAudioEntries.id, c.req.param('entryId'))))
  invalidateFamilyAudio(userId)
  return c.json({ ok: true })
})

// ── GET /options?kind=&q=: unified add-entry search across the four kinds ──────────

adminFamilyAudio.get('/options', async (c) => {
  const kind = c.req.query('kind') as FamilyEntryKind | undefined
  const q = c.req.query('q')?.trim() ?? ''
  if (!kind || !ENTRY_KINDS.includes(kind)) return c.json({ error: 'kind required' }, 400)

  type Option = { ref: string; altRef?: string | null; label: string; sublabel?: string | null }
  let options: Option[] = []

  if (kind === 'artist') {
    if (q) {
      const artists = await searchArtists(q, 12).catch(() => [])
      options = artists.map(a => ({ ref: a.name, altRef: a.mbid, label: a.name, sublabel: a.disambiguation }))
    }
  } else if (kind === 'station') {
    const rows = await db.select({ id: musicStations.id, name: musicStations.name, isBuiltin: musicStations.isBuiltin, visibility: musicStations.visibility, userId: musicStations.userId })
      .from(musicStations)
      .where(q ? like(musicStations.name, `%${q}%`) : or(isNull(musicStations.userId), eq(musicStations.visibility, 'shared'), eq(musicStations.isBuiltin, true)))
      .orderBy(desc(musicStations.isBuiltin), musicStations.name)
      .limit(30)
    options = rows.map(s => ({
      ref: s.id, label: s.name,
      sublabel: s.isBuiltin ? 'Built-in station' : s.visibility === 'shared' ? 'Shared station' : 'Personal station',
    }))
  } else if (kind === 'playlist') {
    const rows = await db.select({ id: musicPlaylists.id, name: musicPlaylists.name, visibility: musicPlaylists.visibility })
      .from(musicPlaylists)
      .where(q ? like(musicPlaylists.name, `%${q}%`) : undefined)
      .orderBy(musicPlaylists.name)
      .limit(30)
    options = rows.map(p => ({
      ref: p.id, label: p.name,
      sublabel: p.visibility === 'shared' ? 'Shared playlist' : 'Personal playlist',
    }))
  } else {
    // Podcast shows: household library first (exact ids), then the public directory.
    const local = await db.select({ id: podcastShows.id, name: podcastShows.name, author: podcastShows.author, feedUrl: podcastShows.feedUrl })
      .from(podcastShows)
      .where(q ? like(podcastShows.name, `%${q}%`) : undefined)
      .limit(12)
    options = local.map(s => ({ ref: s.id, altRef: s.feedUrl, label: s.name, sublabel: s.author ?? 'In the household library' }))
    if (q) {
      const dir = await searchPodcasts(q, 12).catch(() => [])
      const seen = new Set(options.map(o => o.altRef ?? o.ref))
      for (const r of dir) {
        const ref = r.feedUrl ?? (r.itunesId != null ? `itunes:${r.itunesId}` : null)
        if (!ref || seen.has(ref)) continue
        options.push({
          ref,
          altRef: r.itunesId != null && r.feedUrl ? `itunes:${r.itunesId}` : null,
          label: r.title,
          sublabel: r.author ?? 'Podcast directory',
        })
      }
    }
  }
  return c.json({ options })
})

// ── Digests ──────────────────────────────────────────────────────────────────────────

adminFamilyAudio.get('/digests', async (c) => {
  const rows = await db.select().from(familyAudioDigests).orderBy(desc(familyAudioDigests.weekStart)).limit(12)
  return c.json({
    digests: rows.map(r => {
      let payload: unknown = {}
      try { payload = JSON.parse(r.payload) } catch { /* keep empty */ }
      return { id: r.id, weekStart: r.weekStart, summary: r.summary, payload }
    }),
  })
})

// Build (or rebuild) the digest for the current week so parents can peek mid-week.
adminFamilyAudio.post('/digests/run', async (c) => {
  const payload = await runFamilyAudioDigest(weekStartOf())
  return c.json({ ok: true, payload })
})
