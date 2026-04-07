/**
 * Per-style DiceBear schema accessors.
 *
 * Every collection ships ``lib/schema.js`` with the full JSON-schema
 * metadata for that style (every property's type, enum values,
 * defaults, min/max). We import the three styles we ship and
 * normalize them into a uniform shape so the schema-driven option
 * editor never has to know which style is active.
 *
 * Why we don't just pass the raw schema:
 *   - The @dicebear/collection re-export does NOT include schemas;
 *     we have to import them from the per-style packages directly.
 *   - JSON-schema is verbose. The editor only needs `key`, `type`,
 *     `enum`, `min/max`, `default` — so we flatten once here and let
 *     the renderer stay dumb.
 */
import { schema as avataaarsSchema } from "@dicebear/avataaars";
import { schema as botttsSchema } from "@dicebear/bottts";
import { schema as toonHeadSchema } from "@dicebear/toon-head";
import type { AvatarStyle } from "./Avatar";

export type FieldKind =
  | "boolean"
  | "integer"
  | "color-array" // array<string> matching color pattern
  | "enum-array" // array<string> with enum
  | "string-array"
  | "unknown";

export interface SchemaField {
  key: string;
  kind: FieldKind;
  enumValues?: string[];
  min?: number;
  max?: number;
  default?: unknown;
}

const RAW_SCHEMAS: Record<AvatarStyle, { properties: Record<string, unknown> }> = {
  avataaars: avataaarsSchema as { properties: Record<string, unknown> },
  bottts: botttsSchema as { properties: Record<string, unknown> },
  "toon-head": toonHeadSchema as { properties: Record<string, unknown> },
};

// "Common" options exist on every style (DiceBear core). We surface
// them in their own group at the top of the editor so they're
// always in the same place when switching styles.
export const COMMON_KEYS = new Set([
  "flip",
  "rotate",
  "scale",
  "radius",
  "backgroundColor",
  "backgroundType",
  "backgroundRotation",
  "translateX",
  "translateY",
  "randomizeIds",
  "size",
  "clip",
  "seed",
]);

// Keys we never want to surface in the editor (handled by Playground
// chrome itself: ``seed`` has its own input + Lucky button; ``size``
// is set by the preview container).
const HIDDEN_KEYS = new Set(["seed", "size", "base", "clip"]);

function classify(prop: Record<string, unknown>): SchemaField["kind"] {
  const t = prop.type as string;
  if (t === "boolean") return "boolean";
  if (t === "integer" || t === "number") return "integer";
  if (t === "array") {
    const items = prop.items as Record<string, unknown> | undefined;
    if (!items) return "string-array";
    if (typeof items.pattern === "string") return "color-array";
    if (Array.isArray(items.enum)) return "enum-array";
    return "string-array";
  }
  return "unknown";
}

function flatten(
  raw: { properties: Record<string, unknown> },
): SchemaField[] {
  const out: SchemaField[] = [];
  for (const [key, val] of Object.entries(raw.properties)) {
    if (HIDDEN_KEYS.has(key)) continue;
    const prop = val as Record<string, unknown>;
    const kind = classify(prop);
    const items = prop.items as Record<string, unknown> | undefined;
    out.push({
      key,
      kind,
      enumValues: items && Array.isArray(items.enum)
        ? (items.enum as string[])
        : undefined,
      min: typeof prop.minimum === "number" ? (prop.minimum as number) : undefined,
      max: typeof prop.maximum === "number" ? (prop.maximum as number) : undefined,
      default: prop.default,
    });
  }
  return out;
}

const FLAT_CACHE: Partial<Record<AvatarStyle, SchemaField[]>> = {};

export function getStyleFields(style: AvatarStyle): SchemaField[] {
  if (!FLAT_CACHE[style]) {
    FLAT_CACHE[style] = flatten(RAW_SCHEMAS[style]);
  }
  return FLAT_CACHE[style]!;
}

export function getValidKeys(style: AvatarStyle): Set<string> {
  return new Set(getStyleFields(style).map((f) => f.key));
}

/**
 * Strip ``options`` to only keys present in the target style's
 * schema. Critical when switching styles in the playground —
 * leftover ``avataaars``-only options like ``top`` would otherwise
 * crash ``toon-head``'s renderer.
 */
export function filterOptionsForStyle(
  style: AvatarStyle,
  options: Record<string, unknown>,
): Record<string, unknown> {
  const valid = getValidKeys(style);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (valid.has(k)) out[k] = v;
  }
  return out;
}
