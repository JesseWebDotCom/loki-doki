// Frigate event ingestion: the single place that turns a raw detection (from the
// MQTT consumer) or a VLM description (from the shim) into a stored row, an
// admin notification, and — when it clears the announce gate — a companion
// utterance the frontend will speak. Kept separate from the transports so the
// shim and MQTT consumer share identical store/notify/announce behavior.

import { and, desc, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import { frigateEvents } from '@/db/schema'
import { logger } from '@/lib/logger'
import { emitNotification } from '@/lib/notify'
import { getFrigateConfig, normalizePlate, type AnnounceType, type FrigateConfig } from './config'

// Frigate+ delivery-logo attribute labels (plus a few common North-American ones).
// Either a sub_label on a car/truck or a delivery_truck label counts as a delivery.
const DELIVERY_BRANDS: Record<string, string> = {
  amazon: 'Amazon', ups: 'UPS', fedex: 'FedEx', usps: 'USPS', dhl: 'DHL',
  gls: 'GLS', dpd: 'DPD', an_post: 'An Post', purolator: 'Purolator',
  postnl: 'PostNL', nzpost: 'NZ Post', postnord: 'PostNord',
  canada_post: 'Canada Post', royal_mail: 'Royal Mail', ontrac: 'OnTrac',
  lasership: 'LaserShip',
}

// Process-lifetime cooldown tracker: prevent the same camera+type from announcing
// more than once within the configured cooldown window.
const cooldownMap = new Map<string, number>()
function withinCooldown(camera: string, type: string, minutes: number): boolean {
  if (minutes <= 0) return false
  const last = cooldownMap.get(`${camera}:${type}`) ?? 0
  return (Date.now() - last) < minutes * 60_000
}
function markCooldown(camera: string, type: string): void {
  cooldownMap.set(`${camera}:${type}`, Date.now())
}

// Process-lifetime dedup: Frigate republishes new/update/end for one tracked
// object, so without this a single delivery would announce several times. Key is
// `${eventId}:${reason}` so a car that later gains a plate can still announce that.
const handled = new Set<string>()
function once(key: string): boolean {
  if (handled.has(key)) return false
  handled.add(key)
  if (handled.size > 2000) { // bound memory; drop the oldest half
    for (const k of [...handled].slice(0, 1000)) handled.delete(k)
  }
  return true
}

function humanCamera(camera: string | null | undefined): string {
  if (!camera) return 'camera'
  return camera.replace(/[_-]+/g, ' ').trim() || 'camera'
}

function snapshotUrl(cfg: FrigateConfig, eventId: string | null): string | null {
  if (!cfg.baseUrl || !eventId) return null
  return `${cfg.baseUrl}/api/events/${eventId}/snapshot.jpg`
}
function clipUrl(cfg: FrigateConfig, eventId: string | null): string | null {
  if (!cfg.baseUrl || !eventId) return null
  return `${cfg.baseUrl}/api/events/${eventId}/clip.mp4`
}

interface StoreInput {
  source: 'genai' | 'mqtt'
  kind: 'object' | 'plate' | 'review' | 'description'
  camera?: string | null
  eventId?: string | null
  label?: string | null
  subLabel?: string | null
  plate?: string | null
  plateName?: string | null
  zones?: string[] | null
  severity?: string | null
  title?: string | null
  description?: string | null
  score?: number | null
  snapshotUrl?: string | null
  clipUrl?: string | null
  announce?: boolean
  announceText?: string | null
  notify?: boolean
  notifyMessage?: string | null
}

async function store(input: StoreInput): Promise<string> {
  const id = crypto.randomUUID()
  const now = new Date()
  await db.insert(frigateEvents).values({
    id,
    source: input.source,
    kind: input.kind,
    camera: input.camera ?? null,
    eventId: input.eventId ?? null,
    label: input.label ?? null,
    subLabel: input.subLabel ?? null,
    plate: input.plate ?? null,
    plateName: input.plateName ?? null,
    zones: input.zones ? JSON.stringify(input.zones) : null,
    severity: input.severity ?? null,
    title: input.announceText ?? input.title ?? null,
    description: input.description ?? null,
    score: input.score ?? null,
    snapshotUrl: input.snapshotUrl ?? null,
    clipUrl: input.clipUrl ?? null,
    announce: input.announce ?? false,
    spoken: false,
    createdAt: now,
  })

  if (input.notify) {
    // userId null = admin-targeted; emitNotification handles the bell row AND delivery
    // fan-out (push/telegram/email per each admin's routing matrix).
    const message = input.notifyMessage ?? input.announceText ?? `${humanCamera(input.camera)}: ${input.label ?? 'activity detected'}`
    await emitNotification({
      type: 'frigate_event',
      userId: null,
      priority: input.severity === 'alert' ? 'urgent' : 'normal',
      title: 'Camera alert',
      body: message,
      url: '/cameras',
      payload: {
        message: input.notifyMessage ?? input.announceText ?? 'Frigate event',
        kind: input.kind,
        camera: input.camera ?? null,
        eventId: input.eventId ?? null,
        severity: input.severity ?? null,
        label: input.label ?? null,
        subLabel: input.subLabel ?? null,
        plate: input.plate ?? null,
        snapshotUrl: input.snapshotUrl ?? null,
      },
    })
  }
  return id
}

// ── Public: shim description logging (no notify/announce) ──────────────────────
export async function logShimDescription(text: string): Promise<void> {
  if (!text.trim()) return
  await store({ source: 'genai', kind: 'description', description: text.slice(0, 4000) })
    .catch((e) => logger.warn(`[frigate] failed to log shim description: ${e}`))
}

// ── Public: MQTT object detection ─────────────────────────────────────────────
export interface DetectionInput {
  camera: string
  eventId: string
  label: string
  subLabel: string | null
  plate: string | null
  zones: string[]
  score: number | null
  description: string | null
}

export async function ingestDetection(d: DetectionInput): Promise<void> {
  const cfg = await getFrigateConfig()
  if (!cfg.enabled) return

  const cam = humanCamera(d.camera)
  const subKey = (d.subLabel ?? '').toLowerCase().replace(/\s+/g, '_')
  const isDelivery = !!DELIVERY_BRANDS[subKey] || d.label === 'delivery_truck'
  const plateNorm = d.plate ? normalizePlate(d.plate) : null
  const plateName = plateNorm ? cfg.knownPlates[plateNorm] ?? null : null

  const snap = snapshotUrl(cfg, d.eventId)
  const clip = clipUrl(cfg, d.eventId)
  const canAnnounce = cfg.announceEnabled
  const wants = (t: AnnounceType) =>
    canAnnounce && cfg.announce.includes(t) && !withinCooldown(d.camera, t, cfg.cooldownMinutes)

  // Priority: a plate or delivery is more interesting than a bare "person".
  if (plateNorm) {
    if (!once(`${d.eventId}:plate:${plateNorm}`)) return
    const text = plateName
      ? `${plateName} just pulled up at the ${cam}.`
      : `A vehicle with plate ${d.plate} was seen at the ${cam}.`
    const announce = wants('plate')
    if (announce) markCooldown(d.camera, 'plate')
    await store({
      source: 'mqtt', kind: 'plate', camera: d.camera, eventId: d.eventId,
      label: d.label, subLabel: d.subLabel, plate: plateNorm, plateName,
      zones: d.zones, score: d.score, description: d.description,
      snapshotUrl: snap, clipUrl: clip,
      announce, announceText: text,
      notify: true, notifyMessage: text,
    })
    return
  }

  if (isDelivery) {
    if (!once(`${d.eventId}:delivery`)) return
    const brand = DELIVERY_BRANDS[subKey] ?? 'A delivery vehicle'
    const text = `${brand} just arrived at the ${cam}.`
    const announce = wants('delivery')
    if (announce) markCooldown(d.camera, 'delivery')
    await store({
      source: 'mqtt', kind: 'object', camera: d.camera, eventId: d.eventId,
      label: d.label, subLabel: d.subLabel ?? 'delivery', zones: d.zones, score: d.score,
      description: d.description, snapshotUrl: snap, clipUrl: clip,
      announce, announceText: text,
      notify: true, notifyMessage: text,
    })
    return
  }

  if (d.label === 'person') {
    if (!once(`${d.eventId}:person`)) return
    const zoneTxt = d.zones[0] ? ` (${d.zones[0].replace(/[_-]+/g, ' ')})` : ''
    const text = `Someone's at the ${cam}${zoneTxt}.`
    const announce = wants('person')
    if (announce) markCooldown(d.camera, 'person')
    await store({
      source: 'mqtt', kind: 'object', camera: d.camera, eventId: d.eventId,
      label: d.label, zones: d.zones, score: d.score, description: d.description,
      snapshotUrl: snap, clipUrl: clip,
      announce, announceText: text,
      notify: true, notifyMessage: text,
    })
  }
}

// ── Public: MQTT review summary (Frigate 0.17+) ───────────────────────────────
export interface ReviewInput {
  reviewId: string
  camera: string
  severity: string            // frigate: 'alert' | 'detection' | 'significant_motion'
  title: string | null
  description: string | null
  classification: string | null  // genai: 'normal' | 'suspicious' | 'dangerous'
  eventId: string | null
}

export async function ingestReview(r: ReviewInput): Promise<void> {
  const cfg = await getFrigateConfig()
  if (!cfg.enabled) return

  const cls = (r.classification ?? '').toLowerCase()
  const isSuspicious = cls === 'suspicious' || cls === 'dangerous' || r.severity === 'alert'
  if (!isSuspicious) return  // only surface noteworthy reviews
  if (!once(`${r.reviewId}:review`)) return

  const cam = humanCamera(r.camera)
  const headline = r.title?.trim() || r.description?.trim() || 'Unusual activity'
  const text = `Heads up — ${headline.replace(/\.$/, '')} at the ${cam}.`
  const canAnnounce = cfg.announceEnabled && cfg.announce.includes('suspicious') && !withinCooldown(r.camera, 'suspicious', cfg.cooldownMinutes)
  if (canAnnounce) markCooldown(r.camera, 'suspicious')
  await store({
    source: 'mqtt', kind: 'review', camera: r.camera, eventId: r.eventId,
    severity: cls === 'dangerous' ? 'dangerous' : 'suspicious',
    title: r.title, description: r.description,
    snapshotUrl: snapshotUrl(cfg, r.eventId), clipUrl: clipUrl(cfg, r.eventId),
    announce: canAnnounce, announceText: text,
    notify: true, notifyMessage: text,
  })
}

// ── Query helpers (admin history + announce polling) ──────────────────────────
export async function recentEvents(limit = 50, kind?: string) {
  const base = db.select().from(frigateEvents).orderBy(desc(frigateEvents.createdAt)).limit(Math.min(limit, 200))
  if (kind) return base.where(eq(frigateEvents.kind, kind as 'object' | 'plate' | 'review' | 'description'))
  return base
}

export async function pendingAnnouncements() {
  // Only fresh (last 2 min) unspoken announce rows, so a client that just opened
  // doesn't replay a backlog of old detections.
  const cutoff = new Date(Date.now() - 2 * 60 * 1000)
  return db.select({
    id: frigateEvents.id, title: frigateEvents.title, camera: frigateEvents.camera,
    kind: frigateEvents.kind, snapshotUrl: frigateEvents.snapshotUrl,
    label: frigateEvents.label,
  })
    .from(frigateEvents)
    .where(and(eq(frigateEvents.announce, true), eq(frigateEvents.spoken, false), gt(frigateEvents.createdAt, cutoff)))
    .orderBy(desc(frigateEvents.createdAt))
    .limit(5)
}

// Claim an announcement for speaking. Returns true if THIS caller won the claim
// (row was unspoken); false if another client already took it.
export async function claimAnnouncement(id: string): Promise<boolean> {
  const res = await db.update(frigateEvents)
    .set({ spoken: true })
    .where(and(eq(frigateEvents.id, id), eq(frigateEvents.spoken, false)))
    .returning({ id: frigateEvents.id })
  return res.length > 0
}
