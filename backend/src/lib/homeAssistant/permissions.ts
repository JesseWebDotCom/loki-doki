import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { haUserGrants } from '@/db/schema'
import type { CatalogEntity } from './sync'

// Per-user control grants. Each grant is a (domain, area) scope; '*' is a wildcard.
// A user with no grants controls nothing (admins bypass entirely). State queries are
// gated the same way — you can only ask about devices you're allowed to see.

export interface Grant { domain: string; areaId: string }

export async function getGrants(userId: string): Promise<Grant[]> {
  const rows = await db.select({ domain: haUserGrants.domain, areaId: haUserGrants.areaId })
    .from(haUserGrants)
    .where(eq(haUserGrants.userId, userId))
  return rows
}

export async function setGrants(userId: string, grants: Grant[]): Promise<void> {
  await db.delete(haUserGrants).where(eq(haUserGrants.userId, userId))
  if (grants.length === 0) return
  const now = new Date()
  // De-dupe (domain, area) pairs to satisfy the unique constraint.
  const seen = new Set<string>()
  const rows = grants
    .filter(g => { const k = `${g.domain}|${g.areaId}`; if (seen.has(k)) return false; seen.add(k); return true })
    .map(g => ({ id: crypto.randomUUID(), userId, domain: g.domain.trim() || '*', areaId: g.areaId.trim() || '*', createdAt: now }))
  await db.insert(haUserGrants).values(rows)
}

function grantCovers(grant: Grant, entity: CatalogEntity): boolean {
  const domainOk = grant.domain === '*' || grant.domain === entity.domain
  const areaOk = grant.areaId === '*' || grant.areaId === (entity.areaId ?? '')
  return domainOk && areaOk
}

export interface PermissionFilter {
  allowed: CatalogEntity[]
  denied: CatalogEntity[]
}

// Admins bypass (all allowed). Everyone else is filtered to entities covered by a grant.
export function filterByGrants(entities: CatalogEntity[], grants: Grant[], isAdmin: boolean): PermissionFilter {
  if (isAdmin) return { allowed: entities, denied: [] }
  const allowed: CatalogEntity[] = []
  const denied: CatalogEntity[] = []
  for (const e of entities) {
    if (grants.some(g => grantCovers(g, e))) allowed.push(e)
    else denied.push(e)
  }
  return { allowed, denied }
}
