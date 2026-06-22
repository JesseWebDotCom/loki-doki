// File Converter API client. Conversions run server-side on the genQueue 'convert' lane;
// progress streams over SSE, the finished file downloads from /artifacts/:id.

const opts: RequestInit = { credentials: 'include' }

export type MediaFamily = 'image' | 'audio' | 'video'

export interface Capabilities {
  vipsAvailable: boolean
  families: Record<MediaFamily, { inputs: string[]; outputs: string[] }>
}

export type ConversionState = 'pending' | 'converting' | 'ready' | 'failed' | 'cancelled'

export interface ConversionRow {
  id: string
  inputName: string
  outputName: string
  inputFormat: string
  outputFormat: string
  family: MediaFamily
  engine: string
  state: ConversionState
  failureReason: string | null
  inputBytes: number | null
  outputBytes: number | null
  createdAt: number
}

export async function getCapabilities(): Promise<Capabilities> {
  const r = await fetch('/api/converter/capabilities', opts)
  if (!r.ok) throw new Error('Failed to load capabilities')
  return r.json()
}

export async function getRecent(): Promise<ConversionRow[]> {
  const r = await fetch('/api/converter/recent', opts)
  if (!r.ok) throw new Error('Failed to load history')
  return (await r.json()).conversions
}

export interface StartResult { conversionId: string; jobId: string }

export async function startConversion(file: File, targetFormat: string, quality?: number): Promise<StartResult> {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('targetFormat', targetFormat)
  if (quality != null) fd.append('quality', String(quality))
  const r = await fetch('/api/converter/convert', { ...opts, method: 'POST', body: fd })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? 'Conversion failed to start')
  return body as StartResult
}

export const artifactUrl = (id: string) => `/api/converter/artifacts/${id}`

/**
 * Download a finished conversion via authenticated fetch → blob → object URL. More robust
 * than a plain `<a download href>`: it sends the session cookie, surfaces the real HTTP
 * error (a forced-download anchor that hits a non-2xx just shows the browser's opaque
 * "Site wasn't available"), and works regardless of dev-proxy quirks.
 */
export async function downloadArtifact(id: string, name: string): Promise<void> {
  const r = await fetch(artifactUrl(id), opts)
  if (!r.ok) {
    let msg = `Download failed (HTTP ${r.status})`
    try { const j = await r.json(); if (j?.error) msg = j.error } catch { /* not JSON */ }
    throw new Error(msg)
  }
  const blob = await r.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function cancelConversion(jobId: string): void {
  fetch(`/api/converter/cancel/${jobId}`, { ...opts, method: 'POST' }).catch(() => {})
}

/** Filename → lowercase extension without the dot. */
export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1).toLowerCase() : ''
}

const FAMILY_HUMAN: Record<MediaFamily, string> = { image: 'Image', audio: 'Audio', video: 'Video' }
export function familyLabel(f: MediaFamily): string { return FAMILY_HUMAN[f] }

export function familyOf(ext: string, caps: Capabilities): MediaFamily | null {
  const e = ext.toLowerCase()
  for (const fam of ['image', 'audio', 'video'] as MediaFamily[]) {
    if (caps.families[fam].inputs.includes(e)) return fam
  }
  return null
}

export function humanBytes(n: number | null): string {
  if (n == null) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

const LOSSY = new Set(['jpg', 'jpeg', 'webp', 'avif', 'heic', 'heif', 'mp3', 'aac', 'ogg', 'opus'])
export const isLossy = (ext: string) => LOSSY.has(ext.toLowerCase())
