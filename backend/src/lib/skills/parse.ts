// Narrow, line-oriented parser for skill markdown files: a YAML-ish frontmatter
// block (no nested maps, anchors, or flow style) followed by a markdown body.
// Ported from v2's skill_frontmatter parser. Returns either a parsed skill or a
// structured error (kind + 1-indexed line) the editor maps to a field highlight.

export type SkillScope = 'family' | 'user'

export interface ParsedSkill {
  name: string
  description: string
  body: string
  model: string | null
  alwaysActive: boolean
  allowedTools: string[]
}

export type ParseErrorKind =
  | 'missing_frontmatter'
  | 'unclosed_fence'
  | 'missing_field'
  | 'invalid_name'
  | 'reserved_name'
  | 'nested_mapping'
  | 'malformed_line'

export interface ParseError {
  kind: ParseErrorKind
  message: string
  line: number | null
}

export type ParseResult = { ok: true; skill: ParsedSkill } | { ok: false; error: ParseError }

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const RESERVED = new Set(['prompt_skill', 'active_prompt_skills', 'skill', 'skills'])
const MAX_DESCRIPTION = 256
const MAX_BODY = 8000

const err = (kind: ParseErrorKind, message: string, line: number | null = null): ParseResult => ({
  ok: false,
  error: { kind, message, line },
})

function parseBool(raw: string): boolean | null {
  const v = raw.trim().toLowerCase()
  if (v === 'true' || v === 'yes') return true
  if (v === 'false' || v === 'no') return false
  return null
}

export function parseSkill(markdown: string): ParseResult {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  if (lines[0]?.trim() !== '---') {
    return err('missing_frontmatter', 'A skill must start with a "---" frontmatter block.', 1)
  }

  // Find the closing fence.
  let close = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim() === '---') { close = i; break }
  }
  if (close === -1) return err('unclosed_fence', 'The frontmatter block is missing its closing "---".', 1)

  const fm = lines.slice(1, close)
  const body = lines.slice(close + 1).join('\n').trim()

  const fields: Record<string, string> = {}
  let allowedTools: string[] | null = null
  let i = 0
  while (i < fm.length) {
    const raw = fm[i]!
    const lineNo = i + 2 // 1-indexed, account for opening fence
    if (raw.trim() === '') { i++; continue }

    // Indented line outside a list context → nested mapping, which we don't support.
    if (/^\s+/.test(raw) && !/^\s*-\s+/.test(raw)) {
      return err('nested_mapping', 'Nested mappings are not allowed in skill frontmatter.', lineNo)
    }

    const m = raw.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!m) return err('malformed_line', `Couldn't parse frontmatter line: "${raw.trim()}".`, lineNo)

    const key = m[1]!.toLowerCase()
    const value = m[2]!.trim()

    if (key === 'allowed-tools' && value === '') {
      // List items follow on subsequent indented "- item" lines.
      const items: string[] = []
      let j = i + 1
      while (j < fm.length && /^\s*-\s+/.test(fm[j]!)) {
        items.push(fm[j]!.replace(/^\s*-\s+/, '').trim())
        j++
      }
      allowedTools = items.filter(Boolean)
      i = j
      continue
    }

    fields[key] = value
    i++
  }

  const name = (fields.name ?? '').trim()
  const description = (fields.description ?? '').trim()
  if (!name) return err('missing_field', 'The "name" field is required.', null)
  if (!description) return err('missing_field', 'The "description" field is required.', null)
  if (!NAME_RE.test(name)) {
    return err('invalid_name', 'Name must be 1–64 chars: lowercase letters, digits, "-" or "_".', null)
  }
  if (RESERVED.has(name)) return err('reserved_name', `"${name}" is a reserved name.`, null)

  let alwaysActive = false
  if (fields.always_active !== undefined) {
    const b = parseBool(fields.always_active)
    if (b === null) return err('malformed_line', 'always_active must be true or false.', null)
    alwaysActive = b
  }

  return {
    ok: true,
    skill: {
      name,
      description: description.slice(0, MAX_DESCRIPTION),
      body: body.slice(0, MAX_BODY),
      model: fields.model?.trim() || null,
      alwaysActive,
      allowedTools: allowedTools ?? [],
    },
  }
}

/** Re-serialize a parsed skill to canonical markdown (used by the authoring API). */
export function serializeSkill(s: ParsedSkill): string {
  const fm: string[] = ['---', `name: ${s.name}`, `description: ${s.description}`]
  if (s.model) fm.push(`model: ${s.model}`)
  if (s.alwaysActive) fm.push('always_active: true')
  if (s.allowedTools.length) {
    fm.push('allowed-tools:')
    for (const t of s.allowedTools) fm.push(`  - ${t}`)
  }
  fm.push('---', '', s.body, '')
  return fm.join('\n')
}
