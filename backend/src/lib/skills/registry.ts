// On-disk skill registry. Skills are single markdown files:
//   family scope: {dataDir}/skills/<name>.md          (admin-curated, shared, default off)
//   user scope:   {dataDir}/users/<userId>/skills/<name>.md  (personal, default on)
// A user-scope skill shadows a family-scope skill of the same name. Cached per
// directory by mtime so edits are picked up without a restart.

import { join, resolve, dirname } from 'node:path'
import {
  existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, renameSync, unlinkSync,
} from 'node:fs'
import { dataDir } from '@/lib/download'
import { toolRegistry } from '@/tools'
import { parseSkill, type ParsedSkill, type SkillScope } from './parse'

export interface LoadedSkill extends ParsedSkill {
  scope: SkillScope
  sourcePath: string
}

const familyDir = () => join(dataDir, 'skills')
const userDir = (userId: string) => join(dataDir, 'users', userId, 'skills')

// Names that collide with a registered tool id are rejected (the envelope would be ambiguous).
const reservedToolIds = () => new Set(toolRegistry.map((t) => t.id))

interface DirCache { mtime: number; skills: LoadedSkill[] }
const cache = new Map<string, DirCache>()

function scanDir(dir: string, scope: SkillScope): LoadedSkill[] {
  if (!existsSync(dir)) return []
  let dirMtime: number
  try { dirMtime = statSync(dir).mtimeMs } catch { return [] }

  const cached = cache.get(dir)
  // Recompute when the directory mtime changes OR any tracked file is newer.
  if (cached && cached.mtime === dirMtime) {
    const stale = cached.skills.some((s) => {
      try { return statSync(s.sourcePath).mtimeMs > dirMtime } catch { return true }
    })
    if (!stale) return cached.skills
  }

  const reserved = reservedToolIds()
  const seen = new Set<string>()
  const out: LoadedSkill[] = []
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return [] }

  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md') || entry.startsWith('.')) continue
    const path = join(dir, entry)
    let text: string
    try { text = readFileSync(path, 'utf8') } catch { continue }
    const res = parseSkill(text)
    if (!res.ok) continue
    const { skill } = res
    if (reserved.has(skill.name)) continue        // collides with a tool
    if (seen.has(skill.name)) continue            // duplicate within scope — first wins
    seen.add(skill.name)
    out.push({ ...skill, scope, sourcePath: path })
  }

  cache.set(dir, { mtime: dirMtime, skills: out })
  return out
}

export function familySkills(): LoadedSkill[] {
  return scanDir(familyDir(), 'family')
}

export function userSkills(userId: string): LoadedSkill[] {
  return scanDir(userDir(userId), 'user')
}

/** All skills visible to a user — user scope shadows family by name. */
export function allSkillsForUser(userId: string): LoadedSkill[] {
  const byName = new Map<string, LoadedSkill>()
  for (const s of familySkills()) byName.set(s.name, s)
  for (const s of userSkills(userId)) byName.set(s.name, s)   // shadow
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function getSkill(userId: string, name: string): LoadedSkill | null {
  return allSkillsForUser(userId).find((s) => s.name === name) ?? null
}

// ── Authoring (user scope only) ─────────────────────────────────────────────────

function safeUserPath(userId: string, name: string): string | null {
  const dir = userDir(userId)
  const path = resolve(dir, `${name}.md`)
  // Reject traversal: the resolved file must sit directly under the user's skills dir.
  if (dirname(path) !== resolve(dir)) return null
  return path
}

export function readUserSkillFile(userId: string, name: string): string | null {
  const path = safeUserPath(userId, name)
  if (!path || !existsSync(path)) return null
  try { return readFileSync(path, 'utf8') } catch { return null }
}

export type WriteResult = { ok: true } | { ok: false; error: 'invalid_path' | 'exists' | 'not_found' }

export function writeUserSkillFile(userId: string, name: string, markdown: string, mode: 'create' | 'update'): WriteResult {
  const path = safeUserPath(userId, name)
  if (!path) return { ok: false, error: 'invalid_path' }
  const exists = existsSync(path)
  if (mode === 'create' && exists) return { ok: false, error: 'exists' }
  if (mode === 'update' && !exists) return { ok: false, error: 'not_found' }
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, markdown, 'utf8')
  renameSync(tmp, path)   // atomic replace
  invalidate(userId)
  return { ok: true }
}

export function deleteUserSkillFile(userId: string, name: string): WriteResult {
  const path = safeUserPath(userId, name)
  if (!path) return { ok: false, error: 'invalid_path' }
  if (!existsSync(path)) return { ok: false, error: 'not_found' }
  unlinkSync(path)
  invalidate(userId)
  return { ok: true }
}

export function invalidate(userId?: string): void {
  if (userId) cache.delete(userDir(userId))
  else cache.clear()
}
