// Generic recovery helpers for salvaging structured data out of a local LLM's
// not-quite-JSON output (missing/extra commas, unescaped control chars, ``` fences).
// Shared by podcast script generation and narration speaker detection — both ask a
// local model to return a JSON array of {label, text}-shaped objects and both need
// the same fallback ladder when the model doesn't comply exactly.

/** Pull {key1,key2} pairs out of JSON-ish text even when JSON.parse rejects it. */
export function extractJsonPairs(text: string, key1: string, key2: string): { [k: string]: string }[] {
  const out: { [k: string]: string }[] = []
  const k1re = new RegExp(`"${key1}"\\s*:\\s*"([^"]*)"`, 'i')
  const k2re = new RegExp(`"${key2}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i')
  for (const obj of text.match(/\{[^{}]*\}/g) ?? []) {
    const v1 = obj.match(k1re)?.[1]
    const v2raw = obj.match(k2re)?.[1]
    if (v1 == null || v2raw == null) continue
    const v2 = unescapeJson(v2raw).trim()
    if (v2) out.push({ [key1]: v1, [key2]: v2 })
  }
  return out
}

export function unescapeJson(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\[nrt]/g, ' ')
    .replace(/\\(["\\/])/g, '$1')
}
