// Frigate MQTT consumer. Frigate publishes tracked-object and review activity to
// its broker; we subscribe and turn the noteworthy bits (person, delivery brand,
// recognized plate, suspicious review) into stored events + notifications +
// companion announcements via lib/frigate/events. This is the structured-metadata
// source of truth — the GenAI shim only sees an image + prompt and can't tell us
// which camera/zone/plate it was.
//
// Topics:
//   frigate/events                 object lifecycle (new/update/end) incl. sub_label + recognized plate
//   frigate/reviews                review items (0.17+) with severity + genai summary
//   frigate/tracked_object_update  genai description + plate updates (0.16+)

import mqtt, { type MqttClient } from 'mqtt'
import { logger } from '@/lib/logger'
import { getFrigateConfig, type FrigateConfig } from './config'
import { ingestDetection, ingestReview } from './events'

let client: MqttClient | null = null
let connectedTo: string | null = null  // host:port we're currently wired to

// sub_label / recognized_license_plate can arrive as a string or [value, score].
function pickValue(v: unknown): string | null {
  if (typeof v === 'string') return v.trim() || null
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0].trim() || null
  return null
}

interface FrigateAfter {
  id?: string
  camera?: string
  label?: string
  sub_label?: unknown
  recognized_license_plate?: unknown
  current_zones?: unknown
  entered_zones?: unknown
  top_score?: number
  score?: number
  description?: string | null
}

function handleEvent(payload: { type?: string; after?: FrigateAfter }) {
  const a = payload.after
  if (!a?.id || !a.camera || !a.label) return

  const zones = Array.isArray(a.current_zones) ? a.current_zones.filter((z): z is string => typeof z === 'string')
    : Array.isArray(a.entered_zones) ? a.entered_zones.filter((z): z is string => typeof z === 'string')
    : []

  void ingestDetection({
    camera: a.camera,
    eventId: a.id,
    label: a.label,
    subLabel: pickValue(a.sub_label),
    plate: pickValue(a.recognized_license_plate),
    zones,
    score: typeof a.top_score === 'number' ? a.top_score : typeof a.score === 'number' ? a.score : null,
    description: typeof a.description === 'string' ? a.description : null,
  }).catch((e) => logger.warn(`[frigate] ingestDetection failed: ${e}`))
}

interface FrigateReviewAfter {
  id?: string
  camera?: string
  severity?: string
  data?: {
    metadata?: { title?: string; description?: string; classification?: string; scene?: string }
    objects?: string[]
    detections?: string[]
  }
}

function handleReview(payload: { type?: string; after?: FrigateReviewAfter }) {
  const a = payload.after
  if (!a?.id || !a.camera) return
  const meta = a.data?.metadata
  void ingestReview({
    reviewId: a.id,
    camera: a.camera,
    severity: a.severity ?? '',
    title: meta?.title ?? null,
    description: meta?.description ?? null,
    classification: meta?.classification ?? null,
    eventId: a.data?.detections?.[0] ?? null,
  }).catch((e) => logger.warn(`[frigate] ingestReview failed: ${e}`))
}

function wire(cfg: FrigateConfig): MqttClient {
  const url = `mqtt://${cfg.mqttHost}:${cfg.mqttPort}`
  const c = mqtt.connect(url, {
    username: cfg.mqttUsername ?? undefined,
    password: cfg.mqttPassword ?? undefined,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    clientId: `maipai-home-${crypto.randomUUID().slice(0, 8)}`,
  })

  c.on('connect', () => {
    logger.info(`[frigate] MQTT connected to ${url}`)
    c.subscribe(['frigate/events', 'frigate/reviews', 'frigate/tracked_object_update'], (err) => {
      if (err) logger.warn(`[frigate] MQTT subscribe failed: ${err}`)
    })
  })

  c.on('message', (topic, buf) => {
    let payload: unknown
    try { payload = JSON.parse(buf.toString()) } catch { return }
    if (topic === 'frigate/events' || topic === 'frigate/tracked_object_update') {
      handleEvent(payload as { type?: string; after?: FrigateAfter })
    } else if (topic === 'frigate/reviews') {
      handleReview(payload as { type?: string; after?: FrigateReviewAfter })
    }
  })

  c.on('error', (err) => logger.warn(`[frigate] MQTT error: ${err.message}`))
  return c
}

// Start (or restart) the consumer from current config. Safe to call repeatedly —
// it tears down an existing client if the broker target changed.
export async function startFrigateMqtt(): Promise<void> {
  const cfg = await getFrigateConfig().catch(() => null)
  if (!cfg) return

  if (!cfg.enabled || !cfg.mqttHost) {
    if (client) { logger.info('[frigate] MQTT disabled — disconnecting'); stopFrigateMqtt() }
    return
  }

  const target = `${cfg.mqttHost}:${cfg.mqttPort}`
  if (client && connectedTo === target) return  // already wired to the right broker

  stopFrigateMqtt()
  connectedTo = target
  client = wire(cfg)
}

export function stopFrigateMqtt(): void {
  if (client) { try { client.end(true) } catch { /* ignore */ } client = null }
  connectedTo = null
}

export function isFrigateMqttConnected(): boolean {
  return client?.connected ?? false
}
