// Property + people lookup API. Thin HTTP layer over lib/propertyLookup + lib/peopleLookup;
// all scraping, parsing, and caching live there. Consumed by the Maps residential panel,
// the Reverse Lookup app, and the property/people companion tools.

import { Hono } from 'hono'
import { requireAuth } from '@/middleware/auth'
import type { AppEnv } from '@/types'
import { lookupProperty } from '@/lib/propertyLookup'
import {
  lookupPeopleByAddress,
  lookupPeopleByName,
  lookupPeopleByPhone,
} from '@/lib/peopleLookup'

const lookup = new Hono<AppEnv>()

// GET /api/lookup/property?house=&street=&city=&state=
lookup.get('/property', requireAuth, async (c) => {
  const house = c.req.query('house')?.trim() ?? ''
  const street = c.req.query('street')?.trim() ?? ''
  const city = c.req.query('city')?.trim() ?? ''
  const state = c.req.query('state')?.trim() ?? ''
  if (!house || !street || !city || !state) {
    return c.json({ error: 'house, street, city and state are required' }, 400)
  }
  try {
    const result = await lookupProperty({ house, street, city, state })
    return c.json({ result })
  } catch (err) {
    console.warn('[lookup] property failed:', err instanceof Error ? err.message : err)
    return c.json({ result: null })
  }
})

// GET /api/lookup/people/address?street=&city=&state=&zip=
lookup.get('/people/address', requireAuth, async (c) => {
  const street = c.req.query('street')?.trim() ?? ''
  const city = c.req.query('city')?.trim() ?? ''
  const state = c.req.query('state')?.trim() ?? ''
  const zip = c.req.query('zip')?.trim() || undefined
  if (!street || !city || !state) {
    return c.json({ error: 'street, city and state are required' }, 400)
  }
  try {
    const results = await lookupPeopleByAddress(street, city, state, zip)
    return c.json({ results })
  } catch (err) {
    console.warn('[lookup] people/address failed:', err instanceof Error ? err.message : err)
    return c.json({ results: [] })
  }
})

// GET /api/lookup/people/name?first=&last=&state=
lookup.get('/people/name', requireAuth, async (c) => {
  const first = c.req.query('first')?.trim() ?? ''
  const last = c.req.query('last')?.trim() ?? ''
  const state = c.req.query('state')?.trim() || undefined
  if (!first || !last) return c.json({ error: 'first and last are required' }, 400)
  try {
    const results = await lookupPeopleByName(first, last, state)
    return c.json({ results })
  } catch (err) {
    console.warn('[lookup] people/name failed:', err instanceof Error ? err.message : err)
    return c.json({ results: [] })
  }
})

// GET /api/lookup/people/phone?phone=
lookup.get('/people/phone', requireAuth, async (c) => {
  const phone = c.req.query('phone')?.trim() ?? ''
  if (!phone) return c.json({ error: 'phone is required' }, 400)
  try {
    const results = await lookupPeopleByPhone(phone)
    return c.json({ results })
  } catch (err) {
    console.warn('[lookup] people/phone failed:', err instanceof Error ? err.message : err)
    return c.json({ results: [] })
  }
})

export { lookup }
