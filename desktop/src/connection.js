// Picking which of the hub's addresses to use.
//
// The server keeps an ordered address book (LAN IP, local DNS name, tailnet name,
// public hostname). We cache it in settings.json and, at every cold start, try the
// entries in priority order until one answers. The cache is the whole point: on a
// morning where DNS is down or the internet is out, the shell still has the LAN IP
// on disk from yesterday and connects without the user touching anything.
//
// Probing is staggered rather than strictly serial. Walking a five-entry list one at
// a time with a 2s timeout means a ten second stare at nothing when the first few are
// dead. Instead we start the first probe, and every 250ms start the next one too, and
// take the first address that answers correctly. Same priority order, a fraction of
// the wall clock.

const { net } = require('electron')

const PROBE_TIMEOUT_MS = 2500
const STAGGER_MS = 250
const OVERALL_TIMEOUT_MS = 6000

/** Turn whatever the user typed into a comparable origin. */
function normalizeUrl(raw) {
  let value = String(raw ?? '').trim()
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/**
 * Ask one address "are you our hub?". Resolves with the hub identity or null.
 * A 200 alone is not enough: on a strange network something else can be sitting on
 * 192.168.1.50:3000, and a captive portal will happily 200 anything. Only a matching
 * instance id counts, so we never send a credential to a machine that is not ours.
 */
async function probe(url, expectedInstanceId) {
  try {
    const res = await net.fetch(new URL('/api/hub/ping', url).toString(), {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const body = await res.json()
    if (!body?.instanceId) return null
    if (expectedInstanceId && body.instanceId !== expectedInstanceId) return null
    return { url, instanceId: body.instanceId, name: body.name ?? 'MaiPai Home' }
  } catch {
    return null
  }
}

/**
 * Race the candidate list in priority order with a staggered start. Returns the first
 * address that proves it is our hub, or null when none of them do.
 *
 * `candidates` is [{ url, kind, name }, ...] already in the order to try.
 */
async function pickEndpoint(candidates, expectedInstanceId) {
  const urls = [...new Set(candidates.map((c) => normalizeUrl(c.url)).filter(Boolean))]
  if (!urls.length) return null

  return new Promise((resolve) => {
    let settled = false
    let pending = urls.length
    const timers = []

    const finish = (result) => {
      if (settled) return
      settled = true
      timers.forEach(clearTimeout)
      resolve(result)
    }

    const overall = setTimeout(() => finish(null), OVERALL_TIMEOUT_MS)
    timers.push(overall)

    urls.forEach((url, i) => {
      const t = setTimeout(() => {
        if (settled) return
        void probe(url, expectedInstanceId).then((hit) => {
          if (hit) return finish(hit)
          pending -= 1
          // Every candidate has now failed; no point waiting out the overall timeout.
          if (pending <= 0) finish(null)
        })
      }, i * STAGGER_MS)
      timers.push(t)
    })
  })
}

/**
 * Pull the current address book from the connected hub and fold it into what we have
 * cached. The server's copy wins for anything it lists (names, order, additions and
 * removals all propagate), and we keep the address we are actually connected through
 * even if the server does not list it, because it demonstrably works.
 */
async function fetchEndpoints(activeUrl) {
  try {
    const res = await net.fetch(new URL('/api/hub/endpoints', activeUrl).toString(), {
      signal: AbortSignal.timeout(5000),
      cache: 'no-store',
    })
    if (!res.ok) return null
    const body = await res.json()
    if (!Array.isArray(body?.endpoints)) return null
    return {
      instanceId: body.instanceId ?? null,
      name: body.name ?? null,
      endpoints: body.endpoints
        .map((e) => ({
          name: String(e.name ?? 'Hub'),
          url: normalizeUrl(e.url),
          kind: e.kind === 'overlay' || e.kind === 'public' ? e.kind : 'lan',
          priority: Number.isFinite(e.priority) ? e.priority : 100,
        }))
        .filter((e) => e.url),
    }
  } catch {
    return null
  }
}

/**
 * The order to try, given the cached book and the address that worked last time.
 * Last-known-good goes first: it costs one probe to confirm the common case (nothing
 * changed since yesterday) instead of re-running the whole race every launch.
 */
function candidateOrder(endpoints, lastGoodUrl) {
  const sorted = [...endpoints].sort((a, b) => a.priority - b.priority)
  if (!lastGoodUrl) return sorted
  const idx = sorted.findIndex((e) => e.url === lastGoodUrl)
  if (idx < 0) return [{ name: 'Last used', url: lastGoodUrl, kind: 'lan', priority: -1 }, ...sorted]
  return [sorted[idx], ...sorted.slice(0, idx), ...sorted.slice(idx + 1)]
}

module.exports = { normalizeUrl, probe, pickEndpoint, fetchEndpoints, candidateOrder }
