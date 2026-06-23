// Typed wrappers around /api/lookup/* (property + people lookup). Mirrors the backend
// shapes in lib/propertyLookup.ts and lib/peopleLookup.ts.

const opts: RequestInit = { credentials: 'include' }

export interface PropertyDetails {
  address: string | null
  owner: string | null
  coOwner: string | null
  yearBuilt: number | null
  livingAreaSqft: number | null
  style: string | null
  stories: string | null
  bedrooms: number | null
  bathrooms: number | null
  halfBaths: number | null
  lotAcres: number | null
  appraisedValue: string | null
  landValue: string | null
  lastSalePrice: string | null
  lastSaleDate: string | null
  zoning: string | null
  useDescription: string | null
  heatFuel: string | null
  heatType: string | null
  acType: string | null
  exteriorWall: string | null
  features: string[]
  sourceUrl: string | null
}

export interface PersonAddress {
  street: string
  city: string
  state: string
  zip: string
  lat: number | null
  lng: number | null
}

export interface PersonRecord {
  name: string
  givenName: string | null
  familyName: string | null
  middleName: string | null
  phones: string[]
  emails: string[]
  addresses: PersonAddress[]
  associates: string[]
  profileUrl: string | null
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v)
  return sp.toString()
}

export async function lookupProperty(p: {
  house: string
  street: string
  city: string
  state: string
}): Promise<PropertyDetails | null> {
  const res = await fetch(`/api/lookup/property?${qs(p)}`, opts)
  if (!res.ok) return null
  const data = (await res.json()) as { result: PropertyDetails | null }
  return data.result
}

// NOTE: `street` must be the full street line INCLUDING the house number
// ("74 Welchs Point Rd"). A street-only value resolves to a generic page on the source.
export async function lookupPeopleByAddress(p: {
  street: string
  city: string
  state: string
  zip?: string
}): Promise<PersonRecord[]> {
  const res = await fetch(`/api/lookup/people/address?${qs(p)}`, opts)
  if (!res.ok) return []
  const data = (await res.json()) as { results: PersonRecord[] }
  return data.results ?? []
}

export async function lookupPeopleByName(p: {
  first: string
  last: string
  state?: string
}): Promise<PersonRecord[]> {
  const res = await fetch(`/api/lookup/people/name?${qs(p)}`, opts)
  if (!res.ok) return []
  const data = (await res.json()) as { results: PersonRecord[] }
  return data.results ?? []
}

export async function lookupPeopleByPhone(phone: string): Promise<PersonRecord[]> {
  const res = await fetch(`/api/lookup/people/phone?${qs({ phone })}`, opts)
  if (!res.ok) return []
  const data = (await res.json()) as { results: PersonRecord[] }
  return data.results ?? []
}
