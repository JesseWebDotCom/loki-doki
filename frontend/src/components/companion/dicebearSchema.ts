import * as collection from "@dicebear/collection";
import type { CharacterStyle } from "./styles";

// Adapted from maipai-home-v2 styleSchemas.ts — sources per-style schemas from
// @dicebear/collection (v3 bundles all styles in one package). Used to strip
// cross-style option keys so DiceBear doesn't choke when a saved avatarConfig
// carries keys from a different style.

interface DicebearStyleSchema { properties?: Record<string, unknown> }

const RAW_SCHEMAS: Record<CharacterStyle, DicebearStyleSchema> = {
  avataaars: (collection as Record<string, { schema?: DicebearStyleSchema }>)['avataaars']?.schema ?? {},
  bottts: (collection as Record<string, { schema?: DicebearStyleSchema }>)['bottts']?.schema ?? {},
  "toon-head": (collection as Record<string, { schema?: DicebearStyleSchema }>)['toonHead']?.schema ?? {},
}

const cache: Partial<Record<CharacterStyle, Set<string>>> = {}

export function getValidKeys(style: CharacterStyle): Set<string> {
  if (!cache[style]) {
    cache[style] = new Set(Object.keys(RAW_SCHEMAS[style].properties ?? {}))
  }
  return cache[style]!
}

export function filterOptionsForStyle(
  style: CharacterStyle,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const valid = getValidKeys(style)
  if (valid.size === 0) return options
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(options)) {
    if (valid.has(key)) out[key] = value
  }
  return out
}
