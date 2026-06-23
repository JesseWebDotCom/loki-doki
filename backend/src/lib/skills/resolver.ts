// Resolver: join the on-disk registry against per-user enable overrides to decide
// which skills are active, and render the system-prompt block from their bodies.
//
// Default (no override row): user-scope skills and any always_active skill are ON;
// family-scope skills are OFF until enabled. In v3 there is no dispatch enum — an
// enabled skill is simply injected every turn (capped in total length).

import { eq, and } from 'drizzle-orm'
import { db } from '@/db'
import { skillEnabled } from '@/db/schema'
import { allSkillsForUser, type LoadedSkill } from './registry'

export type EnableSource = 'default' | 'user_toggle' | 'admin_assign'

export interface SkillState {
  name: string
  description: string
  scope: 'family' | 'user'
  enabled: boolean
  source: EnableSource
  alwaysActive: boolean
}

const MAX_BLOCK_CHARS = 6000

function defaultEnabled(s: LoadedSkill): boolean {
  return s.scope === 'user' || s.alwaysActive
}

async function overridesFor(userId: string): Promise<Map<string, { enabled: boolean; source: string }>> {
  const rows = await db
    .select({ name: skillEnabled.skillName, enabled: skillEnabled.enabled, source: skillEnabled.source })
    .from(skillEnabled)
    .where(eq(skillEnabled.userId, userId))
  return new Map(rows.map((r) => [r.name, { enabled: r.enabled, source: r.source }]))
}

export async function skillStates(userId: string): Promise<SkillState[]> {
  const skills = allSkillsForUser(userId)
  const overrides = await overridesFor(userId)
  return skills.map((s) => {
    const ov = overrides.get(s.name)
    return {
      name: s.name,
      description: s.description,
      scope: s.scope,
      enabled: ov ? ov.enabled : defaultEnabled(s),
      source: (ov?.source as EnableSource) ?? 'default',
      alwaysActive: s.alwaysActive,
    }
  })
}

export async function setSkillEnabled(
  userId: string,
  name: string,
  enabled: boolean,
  source: 'user_toggle' | 'admin_assign',
): Promise<void> {
  const now = new Date()
  await db
    .insert(skillEnabled)
    .values({ userId, skillName: name, enabled, source, updatedAt: now })
    .onConflictDoUpdate({
      target: [skillEnabled.userId, skillEnabled.skillName],
      set: { enabled, source, updatedAt: now },
    })
}

/** The `## Active prompt skills` system-prompt block, or null when nothing is active. */
export async function activeSkillsBlock(userId: string): Promise<string | null> {
  const skills = allSkillsForUser(userId)
  if (skills.length === 0) return null
  const overrides = await overridesFor(userId)

  const active = skills.filter((s) => {
    const ov = overrides.get(s.name)
    return ov ? ov.enabled : defaultEnabled(s)
  })
  if (active.length === 0) return null

  const parts: string[] = []
  let len = 0
  for (const s of active) {
    const block = `### ${s.name}\n${s.body}`
    if (len + block.length > MAX_BLOCK_CHARS && parts.length > 0) break
    parts.push(block)
    len += block.length
  }

  return (
    '## Active prompt skills\n' +
    'The following skills are active for this turn. Each block shapes or replaces your ' +
    'default reply behavior. Apply them all; on conflicts, the later block wins.\n\n' +
    parts.join('\n\n')
  )
}
