import type { Tool, ToolResult } from './index'
import { lookupProperty } from '@/lib/propertyLookup'
import { parseUsAddress } from '@/lib/addressParse'
import { isFeatureEnabled } from '@/lib/featureGate'

// Companion tool: assessor property facts for a street address (public record via VGSI).
// Coverage is mainly New England municipalities on Vision Government Solutions; outside
// that, or when a parcel isn't found, it returns no data and the companion says so.

export const propertyLookupTool: Tool = {
  id: 'property_lookup',
  name: 'Property Lookup',
  description:
    'Look up public assessor records for a home by street address — appraised value, beds/baths, square footage, year built, lot size, last sale, and owner of record',
  offline: false,
  dataSources: [
    { name: 'Vision Government Solutions', domain: 'gis.vgsi.com', purpose: 'Public property assessor records', type: 'web' },
  ],
  passMessage: null,
  examples: [
    "what's that house worth",
    'look up the property value for an address',
    'how many bedrooms and bathrooms does this house have',
    'when did this property last sell and for how much',
    'who owns the house at this address',
    'square footage, lot size, and year built for a property',
    'pull the assessor record for a street address',
  ],
  toolDefinition: {
    type: 'function',
    function: {
      name: 'property_lookup',
      description:
        'Look up public assessor property details for a US street address (value, specs, sale history, owner).',
      parameters: {
        type: 'object',
        required: ['address'],
        properties: {
          address: {
            type: 'string',
            description: 'Full street address, e.g. "150 Stiles St, Milford, CT"',
          },
        },
      },
    },
  },

  async execute(args: unknown): Promise<ToolResult> {
    if (!(await isFeatureEnabled('people_lookup'))) {
      return { success: false, error: 'Property lookup is disabled by the administrator.' }
    }
    const { address } = args as { address?: string }
    if (!address?.trim()) return { success: false, error: 'An address is required' }

    const parsed = parseUsAddress(address)
    if (!parsed) {
      return { success: false, error: 'Could not parse a street address (need house number, street, city, and state)' }
    }

    try {
      const result = await lookupProperty(parsed)
      if (!result) {
        return {
          success: true,
          data: {
            found: false,
            address,
            note: 'No public assessor record found — the town may not publish to VGSI, or the parcel was not located.',
          },
        }
      }
      return { success: true, data: { found: true, address, property: result } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}
