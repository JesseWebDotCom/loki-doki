// Demo household seeder for documentation screenshots.
//
// Creates the four fictional Parker profiles (see seed-demo-data.ts) with realistic
// per-user content, then mints a session for each and writes the raw tokens to
// frontend/scripts/.demo-sessions.json (gitignored) for docs-screenshot.mjs.
//
// Idempotent by construction: every run tears the demo users down (cascade delete on
// the fixed UUIDs) and reinserts from scratch, so drift never accumulates. Safe to run
// while the dev server is up (WAL + busy_timeout serialize the writers).
//
// Usage:
//   bun run seed:demo              # full reseed + mint sessions
//   bun run seed:demo:reset        # teardown only (removes the demo users entirely)
//   bun run scripts/seed-demo.ts --sessions-only   # re-mint sessions, keep content
import { writeFileSync, existsSync } from 'node:fs'
import { notInArray } from 'drizzle-orm'
import { join } from 'node:path'
import { inArray, like, eq } from 'drizzle-orm'
import { db } from '@/db'
import {
  users, profilePins, sessions, userPreferences, toolUserPermissions, characters,
  conversations, messages, memories, notifications,
  ytSubscriptions, ytWatchState, ytCollections, mediaWatchlist,
  musicStations, musicPlaylists, musicPlaylistTracks, musicFavorites, musicHistory, musicRadioStations,
  bookmarks, bookmarkCollections, books, bookLibrary, bookProgress, feeds,
} from '@/db/schema'
import { hashPin } from '@/lib/pin'
import { generateSessionToken, hashSessionToken, sessionExpiresAt } from '@/lib/session'
import { seedContentProfiles, setUserProfileSlug } from '@/lib/contentPolicy'
import { ensureDefaultCompanions } from '@/lib/defaultCompanions'
import { DEMO_PERSONAS, DEMO_USER_IDS, DEMO_LOCATION, type DemoPersona } from './seed-demo-data'

const SESSIONS_PATH = join(import.meta.dir, '../../frontend/scripts/.demo-sessions.json')
const DENYLIST_PATH = join(import.meta.dir, '../../.demo-denylist.txt')

const resetOnly = process.argv.includes('--reset')
const sessionsOnly = process.argv.includes('--sessions-only')

const demoIds = Object.values(DEMO_USER_IDS)

async function teardown(): Promise<void> {
  // Everything user-scoped cascades off users (PRAGMA foreign_keys is ON in @/db).
  await db.delete(users).where(inArray(users.id, demoIds))
  // Shared-catalog rows have no user FK; they're keyed by our demo- id prefix instead.
  await db.delete(books).where(like(books.id, 'demo-book-%'))
}

async function setPref(userId: string, key: string, value: unknown): Promise<void> {
  const now = new Date()
  await db.insert(userPreferences)
    .values({ id: crypto.randomUUID(), userId, key, value: JSON.stringify(value), updatedAt: now })
    .onConflictDoUpdate({
      target: [userPreferences.userId, userPreferences.key],
      set: { value: JSON.stringify(value), updatedAt: now },
    })
}

async function seedUsers(): Promise<void> {
  const now = new Date()
  for (const p of DEMO_PERSONAS) {
    await db.insert(users).values({
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      nickname: p.nickname,
      birthdate: p.birthdate,
      role: p.role,
      dicebearStyle: 'avataaars',
      dicebearSeed: p.avatarSeed,
      createdAt: now,
      updatedAt: now,
    })
    if (p.pin) {
      await db.insert(profilePins).values({
        id: `demo-pin-${p.key}`,
        userId: p.id,
        pinHash: await hashPin(p.pin),
        createdAt: now,
        updatedAt: now,
      })
    }
  }
}

async function assignCompanion(p: DemoPersona): Promise<string | null> {
  const [char] = await db.select({ id: characters.id }).from(characters)
    .where(eq(characters.name, p.companionName)).limit(1)
  if (!char) return null
  await setPref(p.id, 'companion.active_character_id', char.id)
  return char.id
}

async function seedContentFor(p: DemoPersona): Promise<void> {
  const now = new Date()
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000)

  // Prefs: content ceiling, generic location, protections mirroring POST /api/users.
  await setUserProfileSlug(p.id, p.profileSlug)
  await setPref(p.id, 'user.location', DEMO_LOCATION)
  if (p.role !== 'admin') {
    await setPref(p.id, 'protections', {
      blockUncensoredLlm: true, blockAdultLoras: true, blockAdultImages: true, blockSensitiveTopics: true,
    })
  }
  if (p.homeLayout) await setPref(p.id, 'home.layout', p.homeLayout)
  if (p.lockedHomeLayout) await setPref(p.id, 'home.layout.locked', true)

  for (const toolId of p.toolDenials) {
    await db.insert(toolUserPermissions).values({
      id: `demo-perm-${p.key}-${toolId}`, userId: p.id, toolId, state: 'deny', updatedAt: now,
    })
  }

  for (const [i, ch] of p.ytSubscriptions.entries()) {
    await db.insert(ytSubscriptions).values({
      id: `demo-sub-${p.key}-${i}`, userId: p.id, kind: 'channel',
      externalId: ch.externalId, title: ch.title, handle: ch.handle,
      addedAt: hoursAgo(24 * (i + 2)),
    })
  }

  for (const [i, v] of p.watchLater.entries()) {
    await db.insert(ytCollections).values({
      id: `demo-wl-${p.key}-${i}`, userId: p.id, collection: 'watch-later',
      videoId: v.videoId, title: v.title, author: v.author, durationSec: v.durationSec,
      thumbnailUrl: `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
      addedAt: hoursAgo(12 * (i + 1)),
    })
  }

  for (const [i, w] of p.watchProgress.entries()) {
    await db.insert(ytWatchState).values({
      id: `demo-ws-${p.key}-${i}`, userId: p.id, videoId: w.videoId,
      positionSec: w.positionSec, completed: w.completed ?? false, origin: 'youtube',
      updatedAt: hoursAgo(i + 1),
    })
  }

  for (const [i, item] of p.watchlist.entries()) {
    await db.insert(mediaWatchlist).values({
      id: `demo-watch-${p.key}-${i}`, userId: p.id, mediaType: item.mediaType,
      refId: item.refId, title: item.title, subtitle: item.subtitle, status: item.status,
      addedAt: hoursAgo(24 * (i + 1)), updatedAt: hoursAgo(24 * (i + 1)),
    })
  }

  if (p.musicStation) {
    await db.insert(musicStations).values({
      id: `demo-station-${p.key}`, userId: p.id, name: p.musicStation.name,
      description: p.musicStation.description, aiPrompt: p.musicStation.aiPrompt,
      seedType: p.musicStation.seedType, seedValue: p.musicStation.seedValue,
      createdAt: now, updatedAt: now,
    })
  }

  if (p.musicPlaylist) {
    const playlistId = `demo-playlist-${p.key}`
    await db.insert(musicPlaylists).values({
      id: playlistId, userId: p.id, name: p.musicPlaylist.name,
      description: p.musicPlaylist.description, createdAt: now, updatedAt: now,
    })
    for (const [i, t] of p.musicPlaylist.tracks.entries()) {
      await db.insert(musicPlaylistTracks).values({
        id: `demo-pt-${p.key}-${i}`, playlistId, videoId: t.videoId,
        title: t.title, artist: t.artist, durationSec: t.durationSec, position: i,
        addedAt: hoursAgo(48),
      })
    }
  }

  for (const [i, t] of p.musicFavorites.entries()) {
    await db.insert(musicFavorites).values({
      id: `demo-fav-${p.key}-${i}`, userId: p.id, kind: 'song',
      refId: t.videoId, title: t.title, artist: t.artist, addedAt: hoursAgo(24 * (i + 1)),
    })
  }

  for (const [i, h] of p.musicHistory.entries()) {
    await db.insert(musicHistory).values({
      id: `demo-hist-${p.key}-${i}`, userId: p.id, videoId: h.track.videoId,
      title: h.track.title, artist: h.track.artist,
      positionSec: h.positionSec, durationSec: h.track.durationSec,
      playedAt: hoursAgo(2 * (i + 1)),
    })
  }

  for (const [i, r] of p.radioStations.entries()) {
    await db.insert(musicRadioStations).values({
      id: `demo-radio-${p.key}-${i}`, userId: p.id, source: 'manual',
      name: r.name, streamUrl: r.streamUrl, tags: r.tags, country: r.country,
      createdAt: hoursAgo(72),
    })
  }

  for (const b of p.books) {
    await db.insert(books).values({
      id: b.id, title: b.title, author: b.author, isbn: b.isbn,
      publishedYear: b.publishedYear, sourceType: 'manual', sourceRef: b.id,
      coverUrl: b.isbn ? `https://covers.openlibrary.org/b/isbn/${b.isbn}-L.jpg` : null,
      addedByUserId: p.id, createdAt: now, updatedAt: now,
    }).onConflictDoNothing()
    await db.insert(bookLibrary).values({
      id: `demo-lib-${p.key}-${b.id}`, userId: p.id, bookId: b.id, status: 'saved', addedAt: hoursAgo(96),
    })
    if (b.progress) {
      await db.insert(bookProgress).values({
        id: `demo-prog-${p.key}-${b.id}`, userId: p.id, bookId: b.id,
        mode: 'reading', percent: b.progress, updatedAt: hoursAgo(10),
      })
    }
  }

  let collectionId: string | null = null
  if (p.bookmarkCollection) {
    collectionId = `demo-coll-${p.key}`
    await db.insert(bookmarkCollections).values({
      id: collectionId, ownerId: p.id, name: p.bookmarkCollection.name, createdAt: now,
    })
  }
  for (const [i, bm] of p.bookmarks.entries()) {
    await db.insert(bookmarks).values({
      id: `demo-bm-${p.key}-${i}`, ownerId: p.id, source: 'bookmark', type: 'live',
      url: bm.url, title: bm.title, siteName: bm.siteName, category: bm.category,
      collectionId: bm.collection && collectionId ? collectionId : null,
      createdAt: hoursAgo(24 * (i + 3)), updatedAt: hoursAgo(24 * (i + 3)),
    })
  }

  for (const [i, f] of p.personalFeeds.entries()) {
    await db.insert(feeds).values({
      id: `demo-feed-${p.key}-${i}`, userId: p.id, kind: 'rss',
      url: f.url, title: f.title, siteUrl: f.siteUrl, addedAt: hoursAgo(120),
    })
  }

  const characterId = await assignCompanion(p)
  if (p.chat) {
    const convId = `demo-conv-${p.key}`
    await db.insert(conversations).values({
      id: convId, userId: p.id, characterId, title: p.chat.title, createdAt: hoursAgo(20),
    })
    for (const [i, turn] of p.chat.turns.entries()) {
      await db.insert(messages).values({
        id: `demo-msg-${p.key}-${i}`, conversationId: convId,
        role: turn.role, content: turn.content,
        createdAt: new Date(Date.now() - 20 * 3600_000 + i * 60_000),
      })
    }
  }

  if (p.memory) {
    await db.insert(memories).values({
      id: `demo-mem-${p.key}`, userId: p.id, characterId: null,
      text: p.memory.text, category: p.memory.category, tier: p.memory.tier,
      importance: 6, createdAt: hoursAgo(20), updatedAt: hoursAgo(20),
    })
  }

  for (const [i, n] of p.notifications.entries()) {
    await db.insert(notifications).values({
      id: `demo-notif-${p.key}-${i}`, userId: p.id, type: 'system',
      payload: JSON.stringify({ message: n.message }), priority: n.priority,
      createdAt: hoursAgo(i + 1),
    })
  }
}

async function mintSessions(): Promise<void> {
  const personas: Record<string, { userId: string; nickname: string; token: string }> = {}
  for (const p of DEMO_PERSONAS) {
    const token = generateSessionToken()
    await db.delete(sessions).where(eq(sessions.id, `demo-session-${p.key}`))
    await db.insert(sessions).values({
      id: `demo-session-${p.key}`, userId: p.id,
      tokenHash: hashSessionToken(token), expiresAt: sessionExpiresAt(), createdAt: new Date(),
    })
    personas[p.key] = { userId: p.id, nickname: p.nickname, token }
  }
  writeFileSync(SESSIONS_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    baseUrl: 'http://localhost:5173',
    personas,
  }, null, 2) + '\n')
  console.log(`sessions written → ${SESSIONS_PATH}`)
}

// First-run convenience: derive a starter denylist from the REAL (non-demo) users
// already in this install — their names, nicknames, and stored location — so the
// screenshot script's leak check works out of the box. The file is gitignored; the
// owner should extend it by hand (email, street, school names, …).
async function bootstrapDenylist(): Promise<void> {
  const real = await db
    .select({ firstName: users.firstName, lastName: users.lastName, nickname: users.nickname })
    .from(users)
    .where(notInArray(users.id, demoIds))
  const terms = new Set<string>()
  for (const u of real) {
    for (const t of [u.firstName, u.lastName, u.nickname]) {
      const v = t?.trim().toLowerCase()
      if (v && v.length >= 3) terms.add(v)
    }
  }
  const locPrefs = await db
    .select({ userId: userPreferences.userId, value: userPreferences.value })
    .from(userPreferences)
    .where(eq(userPreferences.key, 'user.location'))
  for (const row of locPrefs) {
    if (demoIds.includes(row.userId)) continue
    try {
      const loc = JSON.parse(row.value) as { displayName?: string }
      // Add the full display name and the city (first component). Deliberately NOT the
      // bare trailing state/country: live rails (trending videos, news, sports) mention
      // state names constantly ("Connecticut Sun LIVE"), which would fail every run on
      // content that has nothing to do with the owner. A bare state also barely
      // identifies anyone — the city term is what actually guards the location.
      const parts = loc.displayName?.split(',') ?? []
      for (const part of [loc.displayName, ...parts.slice(0, Math.max(1, parts.length - 1))]) {
        const v = part?.trim().toLowerCase()
        if (v && v.length >= 3) terms.add(v)
      }
    } catch { /* unparseable pref — skip */ }
  }
  if (terms.size === 0) {
    console.warn('\nWARNING: no real users found to derive a denylist from; .demo-denylist.txt')
    console.warn('was NOT created. Create it by hand before taking documentation screenshots.')
    return
  }
  const header = [
    '# Personal-term denylist for documentation screenshots (gitignored — never commit).',
    '# One case-insensitive term per line. The screenshot run FAILS if any term appears',
    '# on a captured page. Auto-generated from this install\'s real profiles by',
    '# backend/scripts/seed-demo.ts — extend it by hand (email, street, school, …).',
    '',
  ]
  writeFileSync(DENYLIST_PATH, header.join('\n') + [...terms].sort().join('\n') + '\n')
  console.log(`denylist bootstrapped with ${terms.size} term(s) → ${DENYLIST_PATH}`)
}

async function main(): Promise<number> {
  if (resetOnly) {
    await teardown()
    console.log('demo users removed')
    return 0
  }

  if (sessionsOnly) {
    const existing = await db.select({ id: users.id }).from(users).where(inArray(users.id, demoIds))
    if (existing.length !== DEMO_PERSONAS.length) {
      console.error('demo users missing — run a full `bun run seed:demo` first')
      return 1
    }
    await mintSessions()
    return 0
  }

  await teardown()
  await seedUsers()
  await seedContentProfiles()
  await ensureDefaultCompanions(DEMO_USER_IDS.sam)
  for (const p of DEMO_PERSONAS) {
    await seedContentFor(p)
    console.log(`seeded ${p.nickname} (${p.profileSlug})`)
  }
  await mintSessions()

  if (!existsSync(DENYLIST_PATH)) await bootstrapDenylist()
  console.log('\ndemo household ready — 4 users seeded (ephemeral: run `bun run seed:demo:reset` to remove)')
  return 0
}

const code = await main()
// Transitively-imported pino opens its pretty-transport fd async; an instant
// process.exit() makes its exit-flush throw "sonic boom is not ready yet".
setTimeout(() => process.exit(code), 50)
