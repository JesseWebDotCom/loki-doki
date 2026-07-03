// Shared variant-discrimination guard for cross-retailer product matching (Bing Shopping
// compare + the SearXNG-discovered "find at other stores" suggestions). Title-similarity
// alone lets a genuinely different, cheaper variant slip through as "the same product" — a
// 20,100mAh power bank next to a 26,250mAh one, or a 24" monitor next to a 27" one in the
// same series, share almost every token except the one number that actually matters. When
// the reference title states a value for a spec category, an offer is only kept if it states
// the SAME value — a different value, or no value at all for a spec the reference is
// specific about, is rejected as too risky. False rejects (missing a real match because an
// offer's title omits the size) are the safe failure mode; false accepts corrupt price
// comparisons and history, so we never guess in the offer's favor.

const SPEC_PATTERNS: { key: string; re: RegExp }[] = [
  { key: 'capacity', re: /(\d{2,7})\s*mah\b/ },
  { key: 'screen', re: /(\d{1,3}(?:\.\d)?)\s*(?:"|-?inch(?:es)?\b)/ },
  { key: 'resolution', re: /\b(720p|1080p|1440p|2160p|4k|5k|8k|qhd|uhd|fhd|wqhd)\b/ },
  { key: 'storage', re: /\b(\d{2,5}\s?(?:gb|tb))\b/ },
  { key: 'pack', re: /\b(\d{1,3})\s?-?\s?(?:pack|pk|ct|count)\b/ },
  { key: 'watt', re: /\b(\d{2,4})\s?w\b/ },
]

export function specsOf(title: string): Map<string, string> {
  const t = title.toLowerCase().replace(/,/g, '')
  const specs = new Map<string, string>()
  for (const { key, re } of SPEC_PATTERNS) {
    const m = t.match(re)
    if (m) specs.set(key, m[1]!.replace(/\s+/g, ''))
  }
  return specs
}

/** True unless the candidate title conflicts with (or omits) a spec the reference is specific
 *  about. Titles with no stated specs at all always pass — this only rejects actual conflicts. */
export function sameVariant(refTitle: string, candidateTitle: string): boolean {
  const refSpecs = specsOf(refTitle)
  if (refSpecs.size === 0) return true
  const candSpecs = specsOf(candidateTitle)
  for (const [key, value] of refSpecs) {
    if (candSpecs.get(key) !== value) return false
  }
  return true
}
