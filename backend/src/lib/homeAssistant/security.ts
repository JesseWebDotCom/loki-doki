import type { CatalogEntity } from './sync'

// Security entities — locks and entry-type covers (garage doors, gates, doors) —
// are permission-gated separately from everything else. A wildcard ('*') grant
// never covers them: controlling physical security requires an explicit grant
// with the pseudo-domain 'security' (see permissions.ts). A plain 'cover' grant
// deliberately doesn't include the garage door either — "blinds access" must not
// silently become "garage access".

export const SECURITY_DOMAIN = 'security'

const SECURITY_COVER_CLASSES = new Set(['garage', 'door', 'gate'])
const ENTRY_COVER_RE = /\b(garage|gate|front|back|side|entry|door)\b/i

export function isSecurityEntity(e: CatalogEntity): boolean {
  if (e.domain === 'lock') return true
  if (e.domain !== 'cover') return false
  // An explicit device_class wins in both directions (blind/shade/curtain → not security).
  if (e.deviceClass) return SECURITY_COVER_CLASSES.has(e.deviceClass)
  return ENTRY_COVER_RE.test(e.name) || ENTRY_COVER_RE.test(e.areaName ?? '')
}
