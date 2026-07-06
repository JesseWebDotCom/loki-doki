import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '@/lib/download'
import { ollamaChat } from '@/llm/ollama'
import { decodeEntities, stripTags } from '@/lib/htmlText'
import { getModel } from '@/lib/models'
import { assertPublicUrl } from '@/lib/ssrfGuard'

const execAsync = promisify(exec)

const USER_AGENT = 'Mozilla/5.0 (compatible; HomeLookup/1.0)'
const DDG_HTML = 'https://html.duckduckgo.com/html/'

const MANUAL_AGGREGATORS = [
  'manualslib.com', 'manualzz.com', 'manuall.co.uk', 'retrevo.com',
  'manuals.plus', 'manual.tools', 'guidessimo.com',
]

export interface VideoLink {
  title: string
  url: string
  label: string
}

export interface LookupResult {
  manualUrl: string | null
  manualPath: string | null
  manualText: string | null
  supportUrl: string | null
  supportPhone: string | null
  description: string | null
  specs: Record<string, string> | null
  manufacturedDate: string | null
  aiPhotoUrls: string[]
  videoLinks: VideoLink[]
}

function decodeDdgUrl(url: string): string {
  try {
    const full = url.startsWith('//') ? 'https:' + url : url
    if (!full.includes('duckduckgo.com/l/')) return url
    const parsed = new URL(full)
    const uddg = parsed.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : url
  } catch {
    return url
  }
}

async function ddgSearch(query: string): Promise<Array<{ title: string; url: string; snippet: string }>> {
  try {
    const params = new URLSearchParams({ q: query, kl: 'us-en' })
    const res = await fetch(`${DDG_HTML}?${params}`, {
      method: 'GET',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return []
    const html = await res.text()

    const results: Array<{ title: string; url: string; snippet: string }> = []
    const resultRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    const snippetRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi

    let m: RegExpExecArray | null
    const urls: string[] = []
    const titles: string[] = []
    while ((m = resultRe.exec(html)) !== null) {
      urls.push(decodeDdgUrl(m[1] ?? ''))
      titles.push(stripTags(m[2] ?? ''))
    }
    const snippets: string[] = []
    while ((m = snippetRe.exec(html)) !== null) {
      snippets.push(stripTags(m[1] ?? ''))
    }
    for (let i = 0; i < urls.length; i++) {
      results.push({ url: urls[i] ?? '', title: titles[i] ?? '', snippet: snippets[i] ?? '' })
    }
    return results.slice(0, 8)
  } catch {
    return []
  }
}

function labelVideoTitle(title: string, fallback: string): string {
  const t = title.toLowerCase()
  if (t.includes('repair') || t.includes('fix') || t.includes('disassemble') || t.includes('teardown')) return 'Repair & Teardown'
  if (t.includes('setup') || t.includes('set up') || t.includes('install') || t.includes('getting started')) return 'Setup & Installation'
  if (t.includes('tutorial') || t.includes('how to') || t.includes('tips') || t.includes('guide')) return 'Tips & Usage'
  if (t.includes('unbox') || t.includes('unpack')) return 'Unboxing'
  if (t.includes('review')) return 'Review'
  if (t.includes('overview') || t.includes('introduction') || t.includes('intro')) return 'Overview'
  if (t.includes('driver') || t.includes('support') || t.includes('troubleshoot')) return 'Support'
  return fallback
}

async function searchVideos(name: string): Promise<VideoLink[]> {
  const seen = new Set<string>()
  const results: VideoLink[] = []

  const queries = [
    { q: `${name} youtube overview review`, fallback: 'Overview' },
    { q: `${name} youtube setup how to use tips`, fallback: 'Tips & Usage' },
    { q: `${name} youtube repair fix teardown`, fallback: 'Repair & Support' },
  ]

  await Promise.all(queries.map(async ({ q, fallback }) => {
    try {
      const hits = await ddgSearch(q)
      for (const hit of hits) {
        const u = hit.url
        if (!u.includes('youtube.com/watch') && !u.includes('youtu.be/')) continue
        if (seen.has(u)) continue
        seen.add(u)
        results.push({ title: hit.title || fallback, url: u, label: labelVideoTitle(hit.title, fallback) })
        break // one video per query category
      }
    } catch { /* best-effort */ }
  }))

  return results
}

interface SearchGuidance {
  manualQuery: string
  supportQuery: string
  manufacturerDomain: string | null
}

async function getSearchGuidance(brand: string, model: string, name: string): Promise<SearchGuidance> {
  const fallback: SearchGuidance = {
    manualQuery: `${name} user manual filetype:pdf`,
    supportQuery: `${name} official support`,
    manufacturerDomain: null,
  }

  try {
    const llm = await getModel()
    const response = await ollamaChat(llm, [
      { role: 'system', content: 'You are a product research assistant. Respond ONLY with valid JSON. No markdown.' },
      { role: 'user', content: `I need to look up support info for: ${name} (brand: ${brand}, model: ${model})

Respond with JSON:
{
  "manualQuery": "best web search query to find the official PDF user manual or spec sheet",
  "supportQuery": "best web search query to find the manufacturer support or product page",
  "manufacturerDomain": "the manufacturer support domain e.g. 'support.lenovo.com' or null if unsure"
}` },
    ], undefined, { temperature: 0.1 })

    const text = response.message.content.trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return fallback
    const parsed = JSON.parse(match[0]) as Partial<SearchGuidance>
    return {
      manualQuery: parsed.manualQuery || fallback.manualQuery,
      supportQuery: parsed.supportQuery || fallback.supportQuery,
      manufacturerDomain: parsed.manufacturerDomain ?? null,
    }
  } catch {
    return fallback
  }
}

interface DeviceInfo {
  description: string | null
  specs: Record<string, string> | null
  manufacturedDate: string | null
}

async function generateDeviceInfo(brand: string, model: string, name: string, category: string): Promise<DeviceInfo> {
  const fallback: DeviceInfo = { description: null, specs: null, manufacturedDate: null }
  try {
    const llm = await getModel()
    const response = await ollamaChat(llm, [
      { role: 'system', content: 'You are a product researcher. Respond ONLY with valid JSON. No markdown, no code blocks.' },
      { role: 'user', content: `Provide information for: ${name} (brand: ${brand}, model: ${model}, category: ${category})

Respond with JSON only:
{
  "description": "one or two sentence product description",
  "manufacturedDate": "year first released e.g. '2021', or null if unknown",
  "specs": {
    "key": "value"
  }
}

For electronics/computers: include CPU, RAM, storage, GPU, display, OS, ports.
For appliances: include capacity, power consumption, dimensions, notable features.
For vehicles: include engine, fuel type, transmission, seating.
Include 8-15 specs relevant to this product type. Use concise values like "32 GB" not "32 gigabytes".` },
    ], undefined, { temperature: 0.2 })

    const text = response.message.content.trim()
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return fallback
    const parsed = JSON.parse(match[0]) as Partial<DeviceInfo>
    return {
      description: typeof parsed.description === 'string' ? parsed.description : null,
      specs: parsed.specs && typeof parsed.specs === 'object' ? parsed.specs as Record<string, string> : null,
      manufacturedDate: typeof parsed.manufacturedDate === 'string' ? parsed.manufacturedDate : null,
    }
  } catch {
    return fallback
  }
}

function extractPhone(text: string): string | null {
  const m = text.match(/(?:\+1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/)
  return m ? m[0].trim() : null
}

function extractProductImages(html: string, max = 3): string[] {
  const results: string[] = []
  const seen = new Set<string>()

  const add = (raw: string) => {
    if (results.length >= max) return
    const url = (raw.startsWith('//') ? 'https:' + raw : raw).split('?')[0]
    if (seen.has(url) || url.length < 15 || url.startsWith('data:')) return
    const lower = url.toLowerCase()
    if (lower.includes('logo') || lower.includes('favicon') || lower.includes('og-default') ||
        lower.includes('icon') || lower.includes('avatar') || lower.includes('sprite')) return
    seen.add(url)
    results.push(url)
  }

  // Priority 1: og/twitter meta tags (most authoritative)
  const metaPatterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ]
  for (const re of metaPatterns) {
    const m = html.match(re)
    if (m?.[1]) add(decodeEntities(m[1]))
  }

  // Priority 2: img tags matching product CDN patterns
  if (results.length < max) {
    const imgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi
    let m: RegExpExecArray | null
    while ((m = imgRe.exec(html)) !== null && results.length < max) {
      const src = decodeEntities(m[1] ?? '')
      if (!src) continue
      const lower = src.toLowerCase()
      if (
        (lower.includes('/product') || lower.includes('/hero') || lower.includes('/pdp') ||
         lower.includes('/gallery') || lower.includes('/device') || lower.includes('/image')) &&
        (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.png') || lower.endsWith('.webp'))
      ) {
        const full = src.startsWith('//') ? 'https:' + src : src.startsWith('http') ? src : null
        if (full) add(full)
      }
    }
  }

  return results
}

// Keep single-result helper for backward compat in fetchPageData
function extractOgImage(html: string): string | null {
  return extractProductImages(html, 1)[0] ?? null
}

async function tryFetchManualPdf(url: string, deviceId: string): Promise<{ path: string; text: string | null } | null> {
  try {
    await assertPublicUrl(url) // SSRF: url is user/search-derived
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return null
    const ct = res.headers.get('content-type') ?? ''
    if (!ct.includes('pdf')) return null

    const buf = await res.arrayBuffer()
    const dir = join(dataDir, 'home', 'devices', deviceId)
    await mkdir(dir, { recursive: true })
    const path = join(dir, 'manual.pdf')
    await writeFile(path, Buffer.from(buf))

    let text: string | null = null
    try {
      const { stdout } = await execAsync(`pdftotext "${path}" -`, { timeout: 15_000, windowsHide: true })
      text = stdout.slice(0, 40_000).trim() || null
    } catch { /* pdftotext not available */ }

    return { path, text }
  } catch {
    return null
  }
}

const SUB_PAGE_PATTERNS = [/\/manuals(\/.*)?$/, /\/downloads(\/.*)?$/, /\/guides(\/.*)?$/, /\/videos(\/.*)?$/]

function productPageUrl(url: string): string | null {
  for (const re of SUB_PAGE_PATTERNS) {
    if (re.test(url)) {
      return url.replace(re, '')
    }
  }
  return null
}

async function fetchPageData(url: string): Promise<{ phone: string | null; imageUrls: string[] }> {
  try {
    await assertPublicUrl(url) // SSRF: url is user/search-derived
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return { phone: null, imageUrls: [] }
    const html = await res.text()
    const text = stripTags(html)
    return { phone: extractPhone(text), imageUrls: extractProductImages(html, 3) }
  } catch {
    return { phone: null, imageUrls: [] }
  }
}

async function searchProductImages(name: string, manufacturerDomain: string | null): Promise<string[]> {
  try {
    // Search for the product page on the manufacturer's site, not the support page
    const query = manufacturerDomain
      ? `${name} site:${manufacturerDomain}`
      : `${name} official product page`
    const results = await ddgSearch(query)

    // Prefer manufacturer domain pages
    const ordered = manufacturerDomain
      ? [...results].sort((a, b) =>
          (b.url.toLowerCase().includes(manufacturerDomain.toLowerCase()) ? 1 : 0) -
          (a.url.toLowerCase().includes(manufacturerDomain.toLowerCase()) ? 1 : 0))
      : results

    // Try pages until we find one with product images
    for (const r of ordered.slice(0, 4)) {
      const { imageUrls } = await fetchPageData(r.url)
      if (imageUrls.length > 0) return imageUrls
    }
  } catch { /* best-effort */ }
  return []
}

async function fetchSupportPage(url: string): Promise<{ phone: string | null; imageUrls: string[] }> {
  const primary = await fetchPageData(url)

  // Also try the parent product page for sub-pages (manuals, downloads) — may have more images
  const parentUrl = productPageUrl(url)
  if (parentUrl) {
    const parent = await fetchPageData(parentUrl)
    const merged = [...new Set([...primary.imageUrls, ...parent.imageUrls])].slice(0, 3)
    return { phone: primary.phone ?? parent.phone, imageUrls: merged }
  }

  return primary
}

export async function lookupDevice(
  brand: string,
  model: string,
  name: string,
  deviceId: string,
  category = 'other',
): Promise<LookupResult> {
  const result: LookupResult = {
    manualUrl: null,
    manualPath: null,
    manualText: null,
    supportUrl: null,
    supportPhone: null,
    description: null,
    specs: null,
    manufacturedDate: null,
    aiPhotoUrls: [],
    videoLinks: [],
  }

  const displayName = name || `${brand} ${model}`

  // Run search guidance + device info + video search in parallel
  const [guidance, deviceInfo, videos] = await Promise.all([
    getSearchGuidance(brand, model, displayName),
    generateDeviceInfo(brand, model, displayName, category),
    searchVideos(displayName),
  ])

  result.videoLinks = videos

  result.description = deviceInfo.description
  result.specs = deviceInfo.specs
  result.manufacturedDate = deviceInfo.manufacturedDate

  // ── Manual PDF ────────────────────────────────────────────────────────────────

  const manualResultSets = await Promise.all([
    ddgSearch(guidance.manualQuery),
    guidance.manualQuery !== `${displayName} user manual filetype:pdf`
      ? ddgSearch(`${displayName} user manual filetype:pdf`)
      : Promise.resolve([]),
  ])
  const allManualResults = manualResultSets.flat()

  // Separate direct PDF URLs from aggregator pages
  const directPdfCandidates = allManualResults.filter(r => {
    const u = r.url.toLowerCase()
    if (u.endsWith('.pdf') || u.includes('.pdf?')) return true
    if (guidance.manufacturerDomain && u.includes(guidance.manufacturerDomain.toLowerCase())) {
      return u.includes('manual') || u.includes('spec') || u.includes('guide') || u.includes('download')
    }
    return false
  })

  const aggregatorResult = allManualResults.find(r => {
    const u = r.url.toLowerCase()
    return MANUAL_AGGREGATORS.some(a => u.includes(a)) &&
      (u.includes('manual') || r.title.toLowerCase().includes('manual') || r.title.toLowerCase().includes('user guide'))
  })

  // Try each direct PDF candidate until one downloads
  for (const candidate of directPdfCandidates) {
    result.manualUrl = candidate.url
    const fetched = await tryFetchManualPdf(candidate.url, deviceId)
    if (fetched) {
      result.manualPath = fetched.path
      result.manualText = fetched.text
      break
    }
  }

  // If no direct PDF worked, use the best aggregator page as a link
  if (!result.manualPath && aggregatorResult) {
    result.manualUrl = aggregatorResult.url
  }

  // ── Support page ──────────────────────────────────────────────────────────────

  const supportResults = await ddgSearch(guidance.supportQuery)

  const ranked = [...supportResults].sort((a, b) => {
    const domain = guidance.manufacturerDomain?.toLowerCase()
    if (!domain) return 0
    const aMatch = a.url.toLowerCase().includes(domain)
    const bMatch = b.url.toLowerCase().includes(domain)
    if (aMatch && !bMatch) return -1
    if (!aMatch && bMatch) return 1
    return 0
  })

  const supportResult = ranked.find(r => {
    const u = r.url.toLowerCase()
    return u.includes('support') || u.includes('help') || u.includes('service') ||
      (guidance.manufacturerDomain && u.includes(guidance.manufacturerDomain.toLowerCase())) ||
      u.includes(brand.toLowerCase())
  })

  // Run support page fetch + dedicated product image search in parallel
  const [supportPage, productImageUrls] = await Promise.all([
    supportResult ? fetchSupportPage(supportResult.url) : Promise.resolve({ phone: null, imageUrls: [] }),
    searchProductImages(displayName, guidance.manufacturerDomain ?? null),
  ])

  if (supportResult) {
    result.supportUrl = supportResult.url
    result.supportPhone = supportPage.phone
  }

  // Merge: product page images first (higher quality), then support page images, dedupe
  const allImageUrls = [...new Set([...productImageUrls, ...supportPage.imageUrls])]
  if (allImageUrls.length > 0) {
    result.aiPhotoUrls = allImageUrls.slice(0, 3)
  }

  return result
}
