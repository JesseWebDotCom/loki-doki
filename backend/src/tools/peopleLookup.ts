import type { Tool, ToolResult } from './index'
import {
  lookupPeopleByAddress,
  lookupPeopleByName,
  lookupPeopleByPhone,
  type PersonRecord,
} from '@/lib/peopleLookup'
import { parseUsAddress } from '@/lib/addressParse'
import { isFeatureEnabled } from '@/lib/featureGate'
import { logger } from '@/lib/logger'

// Companion tool: reverse people lookup via ThatsThem. One tool, three modes auto-detected
// from the query — a phone number → who it belongs to; a street address → who lives there;
// a person's name → their listing. Free directory data for personal reference only.

function digitsOnly(s: string): string {
  return s.replace(/\D/g, '')
}

/** Decide which lookup the query is asking for. */
function classify(query: string): { mode: 'phone' | 'address' | 'name'; q: string } | null {
  const q = query.trim()
  const digits = digitsOnly(q)
  // A 10/11-digit number (allowing common punctuation) → phone.
  if (digits.length >= 10 && digits.length <= 11 && /^[\d\s().+-]+$/.test(q)) {
    return { mode: 'phone', q }
  }
  // Starts with a house number and looks like an address → address.
  if (/^\d+\s+\S+/.test(q) && /,/.test(q)) return { mode: 'address', q }
  // Two-plus word name → name.
  if (/^[A-Za-z][A-Za-z'.-]*(\s+[A-Za-z][A-Za-z'.-]*)+$/.test(q)) return { mode: 'name', q }
  return null
}

export const peopleLookupTool: Tool = {
  id: 'people_lookup',
  name: 'People Lookup',
  description:
    'Reverse lookup of people — find who a phone number belongs to, who lives at an address, or look someone up by name (returns names, phone numbers, and known associates)',
  offline: false,
  dataSources: [
    { name: 'ThatsThem', domain: 'thatsthem.com', purpose: 'Free reverse phone/address/name directory', type: 'web' },
  ],
  passMessage: 'query',
  examples: [
    'who is calling me from this phone number',
    'whose number is this',
    'who lives at this address',
    'look up the residents of a house',
    'find a person by name and state',
    'reverse phone lookup',
    'find the phone number for someone',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'people_lookup',
      description:
        'Reverse-look-up people by phone number, street address, or full name. Returns names, phones, and associates.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: {
            type: 'string',
            description:
              'A phone number ("203-555-0100"), a full street address ("150 Stiles St, Milford, CT"), or a person\'s name ("John Smith").',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    // Respect the People & Property Lookup capability gate: when the admin disables it, the
    // companion can no longer reverse-look-up people either (the HTTP route is gated too).
    if (!(await isFeatureEnabled('people_lookup'))) {
      return { success: false, error: 'People lookup is disabled by the administrator.' }
    }
    const { query } = args as { query?: string }
    if (!query?.trim()) return { success: false, error: 'A phone number, address, or name is required' }

    const classified = classify(query)
    if (classified) logger.info(`[lookup] companion people_lookup mode=${classified.mode}`)
    if (!classified) {
      return { success: false, error: 'Could not tell whether that is a phone number, address, or name' }
    }

    try {
      let results: PersonRecord[] = []
      if (classified.mode === 'phone') {
        results = await lookupPeopleByPhone(classified.q)
      } else if (classified.mode === 'address') {
        const parsed = parseUsAddress(classified.q)
        if (!parsed) return { success: false, error: 'Could not parse that address' }
        // Street line must include the house number (see lookupPeopleByAddress contract).
        results = await lookupPeopleByAddress(
          `${parsed.house} ${parsed.street}`,
          parsed.city,
          parsed.state,
          parsed.zip,
        )
      } else {
        const words = classified.q.trim().split(/\s+/)
        const first = words[0]!
        const last = words[words.length - 1]!
        results = await lookupPeopleByName(first, last)
      }

      return {
        success: true,
        data: { mode: classified.mode, query: classified.q, count: results.length, people: results },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
