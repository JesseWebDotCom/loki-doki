// Download-request pipeline for the Shows/Movies apps. A request row (media_requests)
// tracks one user+title from "requested" through "downloading" to "ready in Plex"; the
// admin-chosen pipeline decides where the request is filed:
//   overseerr — filed on the user's behalf (their linked Plex account maps to an Overseerr
//               user, so Overseerr enforces its own permissions/quotas)
//   direct    — added straight to Radarr/Sonarr; gated by a per-user grant
//               (tool_user_permissions, toolId 'media_requests', admins bypass)

import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/db'
import { mediaRequests, toolUserConfig, toolUserPermissions } from '@/db/schema'
import {
  getIntegrationsConfig, getRequestPipeline, overseerrRequest, overseerrSearch, overseerrStatus,
  overseerrUsers, radarrAddMovie, radarrLookup, sonarrAddSeries, sonarrLookup,
  type RequestPipeline,
} from '@/lib/media/integrations'
import { resolvePlexAccountForUser } from '@/lib/plex/account'

const TOOL_ID = 'media_integrations'
const GRANT_TOOL_ID = 'media_requests'

export type MediaRequestRow = typeof mediaRequests.$inferSelect

export interface RequestInput {
  type: 'movie' | 'show'
  title: string
  year: number | null
  imdb?: string | null
  tvdb?: number | null
  tmdbId?: number | null
  posterUrl?: string | null
  refId: string
  origin: 'app' | 'companion'
}

export type CannotRequestReason = 'unconfigured' | 'grant' | 'link_plex'

/** Is the active pipeline usable at all (services configured)? */
export async function pipelineConfigured(): Promise<{ configured: boolean; pipeline: RequestPipeline }> {
  const [cfg, pipeline] = await Promise.all([getIntegrationsConfig(), getRequestPipeline()])
  const configured = pipeline === 'overseerr'
    ? !!(cfg.overseerr_url && cfg.overseerr_key)
    : !!((cfg.radarr_url && cfg.radarr_key) || (cfg.sonarr_url && cfg.sonarr_key))
  return { configured, pipeline }
}

/** May this user file requests through the active pipeline? */
export async function canUserRequest(
  userId: string,
  isAdmin: boolean,
): Promise<{ ok: boolean; pipeline: RequestPipeline; reason?: CannotRequestReason }> {
  const { configured, pipeline } = await pipelineConfigured()
  if (!configured) return { ok: false, pipeline, reason: 'unconfigured' }
  if (pipeline === 'direct') {
    if (isAdmin) return { ok: true, pipeline }
    const [row] = await db
      .select({ state: toolUserPermissions.state })
      .from(toolUserPermissions)
      .where(and(eq(toolUserPermissions.userId, userId), eq(toolUserPermissions.toolId, GRANT_TOOL_ID)))
      .limit(1)
    return row?.state === 'allow' ? { ok: true, pipeline } : { ok: false, pipeline, reason: 'grant' }
  }
  // Overseerr mode: attribution requires a linked/mapped Plex account.
  const account = await resolvePlexAccountForUser(userId)
  return account ? { ok: true, pipeline } : { ok: false, pipeline, reason: 'link_plex' }
}

/** The Overseerr user id this app user files as. Cached per user in tool_user_config. */
export async function resolveOverseerrUserId(userId: string): Promise<number | null> {
  const cacheWhere = and(
    eq(toolUserConfig.userId, userId), eq(toolUserConfig.toolId, TOOL_ID), eq(toolUserConfig.key, 'overseerr_user_id'),
  )
  const [cached] = await db.select({ value: toolUserConfig.value }).from(toolUserConfig).where(cacheWhere).limit(1)
  if (cached) {
    try {
      const id = Number(JSON.parse(cached.value))
      if (Number.isInteger(id) && id > 0) return id
    } catch { /* fall through to re-resolve */ }
  }
  const account = await resolvePlexAccountForUser(userId)
  if (!account) return null
  const match = (await overseerrUsers()).find((u) => u.plexId != null && String(u.plexId) === account.id)
  if (!match) return null
  if (cached) {
    await db.update(toolUserConfig).set({ value: JSON.stringify(match.id), updatedAt: new Date() }).where(cacheWhere)
  } else {
    await db.insert(toolUserConfig).values({
      id: crypto.randomUUID(), userId, toolId: TOOL_ID, key: 'overseerr_user_id',
      value: JSON.stringify(match.id), updatedAt: new Date(),
    })
  }
  return match.id
}

/** Insert a request row, or revive/return the existing one for this user+title. */
async function upsertRequestRow(
  userId: string,
  input: RequestInput,
  filed: { pipeline: 'overseerr' | 'radarr' | 'sonarr'; externalId: string | null; tmdbId: number | null; tvdbId: number | null; posterUrl: string | null },
): Promise<MediaRequestRow> {
  const now = new Date()
  const where = and(
    eq(mediaRequests.userId, userId), eq(mediaRequests.mediaType, input.type), eq(mediaRequests.refId, input.refId),
  )
  const [existing] = await db.select().from(mediaRequests).where(where).limit(1)
  if (existing) {
    // Re-request after a failure (or a stale row): reset to requested with fresh ids.
    const [updated] = await db.update(mediaRequests).set({
      status: existing.status === 'ready' ? existing.status : 'requested',
      pipeline: filed.pipeline, externalId: filed.externalId ?? existing.externalId,
      tmdbId: filed.tmdbId ?? existing.tmdbId, tvdbId: filed.tvdbId ?? existing.tvdbId,
      posterUrl: filed.posterUrl ?? existing.posterUrl, error: null, updatedAt: now,
    }).where(eq(mediaRequests.id, existing.id)).returning()
    return updated!
  }
  const [inserted] = await db.insert(mediaRequests).values({
    id: crypto.randomUUID(), userId, mediaType: input.type, refId: input.refId,
    title: input.title, year: input.year, posterUrl: filed.posterUrl ?? input.posterUrl ?? null,
    tmdbId: filed.tmdbId, tvdbId: filed.tvdbId ?? input.tvdb ?? null, imdbId: input.imdb ?? null,
    pipeline: filed.pipeline, externalId: filed.externalId, origin: input.origin,
    status: 'requested', createdAt: now, updatedAt: now,
  }).returning()
  return inserted!
}

/** File a request through the active pipeline. Throws with a user-safe message on failure;
 *  callers are expected to have checked canUserRequest first. */
export async function fileRequest(userId: string, input: RequestInput): Promise<MediaRequestRow> {
  const pipeline = await getRequestPipeline()

  if (pipeline === 'overseerr') {
    const overseerrUserId = await resolveOverseerrUserId(userId)
    if (!overseerrUserId) throw new Error('No matching Overseerr user for your linked Plex account')
    let tmdbId = input.tmdbId ?? null
    let posterUrl = input.posterUrl ?? null
    if (!tmdbId) {
      const candidate = await overseerrSearch(input.title, input.year, input.type)
      tmdbId = candidate?.tmdbId ?? null
      posterUrl = posterUrl ?? candidate?.posterUrl ?? null
    }
    if (!tmdbId) throw new Error(`Could not find "${input.title}" on Overseerr`)
    const requestId = await overseerrRequest(tmdbId, input.type, overseerrUserId)
    if (!requestId) throw new Error('Overseerr rejected the request')
    return upsertRequestRow(userId, input, {
      pipeline: 'overseerr', externalId: String(requestId), tmdbId, tvdbId: input.tvdb ?? null, posterUrl,
    })
  }

  // Direct pipeline: movies → Radarr, shows → Sonarr.
  if (input.type === 'movie') {
    const found = await radarrLookup({ imdb: input.imdb, title: input.title, year: input.year })
    if (!found?.tmdbId) throw new Error(`Could not find "${input.title}" on Radarr`)
    const libraryId = found.libraryId ?? await radarrAddMovie(found.tmdbId)
    if (!libraryId) throw new Error('Radarr could not add the movie')
    return upsertRequestRow(userId, input, {
      pipeline: 'radarr', externalId: String(libraryId), tmdbId: found.tmdbId, tvdbId: null,
      posterUrl: input.posterUrl ?? found.posterUrl,
    })
  }
  const found = await sonarrLookup({ tvdb: input.tvdb, title: input.title, year: input.year })
  if (!found?.tvdbId) throw new Error(`Could not find "${input.title}" on Sonarr`)
  const libraryId = found.libraryId ?? await sonarrAddSeries(found.tvdbId)
  if (!libraryId) throw new Error('Sonarr could not add the series')
  return upsertRequestRow(userId, input, {
    pipeline: 'sonarr', externalId: String(libraryId), tmdbId: null, tvdbId: found.tvdbId,
    posterUrl: input.posterUrl ?? found.posterUrl,
  })
}

export async function listMyRequests(userId: string): Promise<MediaRequestRow[]> {
  return db.select().from(mediaRequests)
    .where(eq(mediaRequests.userId, userId))
    .orderBy(desc(mediaRequests.updatedAt))
    .limit(50)
}

export interface RequestStatusPayload {
  configured: boolean
  pipeline: RequestPipeline
  canRequest: boolean
  reason?: CannotRequestReason
  /** Merged view: the caller's own request row wins; else pipeline probe (Overseerr only). */
  status: 'none' | 'pending' | 'processing' | 'partial' | 'available' | 'requested' | 'downloading' | 'ready' | 'failed'
  progress: number | null
  requestable: boolean
  tmdbId: number | null
  deepLink: string | null
}

/** Status for one title as seen by one user: their request row if they have one, else the
 *  pipeline's own availability (Overseerr search / arr library presence). */
export async function requestStatusFor(
  userId: string,
  isAdmin: boolean,
  q: { type: 'movie' | 'show'; title: string; year: number | null; imdb?: string | null; tvdb?: number | null; refId: string },
): Promise<RequestStatusPayload> {
  const permission = await canUserRequest(userId, isAdmin)
  const base: RequestStatusPayload = {
    configured: permission.reason !== 'unconfigured',
    pipeline: permission.pipeline,
    canRequest: permission.ok,
    reason: permission.reason,
    status: 'none', progress: null, requestable: false, tmdbId: null, deepLink: null,
  }
  if (!base.configured) return base

  const [own] = await db.select().from(mediaRequests).where(and(
    eq(mediaRequests.userId, userId), eq(mediaRequests.mediaType, q.type), eq(mediaRequests.refId, q.refId),
  )).limit(1)
  if (own) {
    return {
      ...base,
      status: own.status, progress: own.progress ?? null, requestable: own.status === 'failed' && permission.ok,
      tmdbId: own.tmdbId, deepLink: own.plexDeepLink,
    }
  }

  if (permission.pipeline === 'overseerr') {
    const probe = await overseerrStatus(q.title, q.year, q.type)
    return {
      ...base,
      status: probe.status, requestable: probe.requestable && permission.ok, tmdbId: probe.tmdbId,
    }
  }

  // Direct mode probe: is the title already in the arr library / downloaded?
  const found = q.type === 'movie'
    ? await radarrLookup({ imdb: q.imdb, title: q.title, year: q.year })
    : await sonarrLookup({ tvdb: q.tvdb, title: q.title, year: q.year })
  if (found?.libraryId) {
    return { ...base, status: found.hasFile ? 'available' : 'processing', tmdbId: found.tmdbId }
  }
  return { ...base, requestable: permission.ok && !!found, tmdbId: found?.tmdbId ?? null }
}

// ── Direct-mode per-user grants (admin managed) ──────────────────────────────────────

export async function listRequestGrants(): Promise<Record<string, boolean>> {
  const rows = await db.select().from(toolUserPermissions).where(eq(toolUserPermissions.toolId, GRANT_TOOL_ID))
  return Object.fromEntries(rows.map((r) => [r.userId, r.state === 'allow']))
}

export async function setRequestGrant(userId: string, allowed: boolean): Promise<void> {
  const now = new Date()
  const where = and(eq(toolUserPermissions.userId, userId), eq(toolUserPermissions.toolId, GRANT_TOOL_ID))
  const [existing] = await db.select({ id: toolUserPermissions.id }).from(toolUserPermissions).where(where).limit(1)
  if (existing) {
    await db.update(toolUserPermissions).set({ state: allowed ? 'allow' : 'deny', updatedAt: now }).where(where)
  } else {
    await db.insert(toolUserPermissions).values({
      id: crypto.randomUUID(), userId, toolId: GRANT_TOOL_ID, state: allowed ? 'allow' : 'deny', updatedAt: now,
    })
  }
}
