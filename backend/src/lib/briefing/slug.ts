// Derive a Patch town slug from a location displayName.
//   "Milford, CT"          → "connecticut/milford"
//   "Milford, Connecticut" → "connecticut/milford"
//   "New Haven, CT"        → "connecticut/new-haven"
// Patch has no official API, so an admin override (briefing.patch_slug) always wins,
// and a wrong derivation simply 404s → callers fall back to web search.

const STATE_ABBR_TO_NAME: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california',
  co: 'colorado', ct: 'connecticut', de: 'delaware', fl: 'florida', ga: 'georgia',
  hi: 'hawaii', id: 'idaho', il: 'illinois', in: 'indiana', ia: 'iowa',
  ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri',
  mt: 'montana', ne: 'nebraska', nv: 'nevada', nh: 'new-hampshire', nj: 'new-jersey',
  nm: 'new-mexico', ny: 'new-york', nc: 'north-carolina', nd: 'north-dakota', oh: 'ohio',
  ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania', ri: 'rhode-island', sc: 'south-carolina',
  sd: 'south-dakota', tn: 'tennessee', tx: 'texas', ut: 'utah', vt: 'vermont',
  va: 'virginia', wa: 'washington', wv: 'west-virginia', wi: 'wisconsin', wy: 'wyoming',
  dc: 'district-of-columbia',
}

const STATE_NAMES = new Set(Object.values(STATE_ABBR_TO_NAME))

function slugifyPart(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '') // drop punctuation (St. → st)
    .trim()
    .replace(/\s+/g, '-')
}

/**
 * Returns a Patch slug like "connecticut/milford", or null if the state can't be
 * resolved from the displayName (caller should rely on the admin override / web search).
 */
export function deriveSlug(displayName: string | null | undefined): string | null {
  if (!displayName) return null
  const parts = displayName.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null // need at least "Town, State"

  const town = slugifyPart(parts[0]!)
  if (!town) return null

  // The state is usually the last comma-part; tolerate a trailing country ("Milford, CT, USA").
  let state: string | null = null
  for (let i = parts.length - 1; i >= 1 && !state; i--) {
    const raw = parts[i]!.toLowerCase().trim()
    if (raw.length === 2 && STATE_ABBR_TO_NAME[raw]) state = STATE_ABBR_TO_NAME[raw]!
    else {
      const asName = slugifyPart(raw)
      if (STATE_NAMES.has(asName)) state = asName
    }
  }
  if (!state) return null
  return `${state}/${town}`
}

// Daily Voice's hyperlocal network only covers these five states.
const DAILY_VOICE_STATES = new Set(['ct', 'ny', 'nj', 'pa', 'ma'])

const STATE_NAME_TO_ABBR: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBR_TO_NAME).map(([abbr, name]) => [name, abbr]),
)

/**
 * Returns a Daily Voice slug like "ct/milford", or null if the state isn't one Daily Voice
 * covers (CT/NY/NJ/PA/MA) or can't be resolved from the displayName.
 */
export function deriveDailyVoiceSlug(displayName: string | null | undefined): string | null {
  if (!displayName) return null
  const parts = displayName.split(',').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2) return null

  const town = slugifyPart(parts[0]!)
  if (!town) return null

  let abbr: string | null = null
  for (let i = parts.length - 1; i >= 1 && !abbr; i--) {
    const raw = parts[i]!.toLowerCase().trim()
    if (raw.length === 2 && DAILY_VOICE_STATES.has(raw)) abbr = raw
    else {
      const asAbbr = STATE_NAME_TO_ABBR[slugifyPart(raw)]
      if (asAbbr && DAILY_VOICE_STATES.has(asAbbr)) abbr = asAbbr
    }
  }
  if (!abbr) return null
  return `${abbr}/${town}`
}
