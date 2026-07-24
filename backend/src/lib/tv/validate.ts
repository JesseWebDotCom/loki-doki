// Admin-supplied channel config is untrusted: a signoff window covering all 24 hours
// would spin the scheduler's signoffEnd walk forever (blocking the event loop), zero
// program/rotate lengths would emit unbounded zero-duration rows, and newlines in names
// could inject M3U playlist lines. Everything is clamped here at the write boundary
// (the builders also clamp defensively).

import type { TvChannelConfig, TvSignoff } from './types'

const clampInt = (v: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

export function sanitizeSignoff(s: TvSignoff | undefined): TvSignoff | undefined {
  if (!s) return undefined
  const startHour = clampInt(s.startHour, 0, 23, 21)
  const endHour = clampInt(s.endHour, 0, 23, 7)
  // A window whose start equals its end would cover the whole day: drop it.
  if (startHour === endHour) return undefined
  return { startHour, endHour }
}

export function sanitizeTvChannelName(name: string): string {
  return name.replace(/[\r\n]+/g, ' ').trim().slice(0, 60)
}

export function sanitizeTvChannelConfig(config: TvChannelConfig): TvChannelConfig {
  const signoff = sanitizeSignoff(config.signoff)
  switch (config.kind) {
    case 'media':
      return {
        ...config,
        signoff,
        minDurationSec: config.minDurationSec != null ? clampInt(config.minDurationSec, 0, 24 * 3600, 0) : undefined,
        maxDurationSec: config.maxDurationSec != null ? clampInt(config.maxDurationSec, 0, 24 * 3600, 0) : undefined,
        assumeMinutes: config.assumeMinutes != null ? clampInt(config.assumeMinutes, 1, 600, 30) : undefined,
        queries: config.queries?.slice(0, 8).map((q) => q.replace(/[\r\n]+/g, ' ').slice(0, 100)),
      }
    case 'live':
      return {
        ...config,
        signoff,
        rotateMin: clampInt(config.rotateMin ?? 30, 1, 24 * 60, 30),
        feeds: (config.feeds ?? []).slice(0, 16).map((f) => ({
          ...f,
          key: f.key.slice(0, 60),
          label: sanitizeTvChannelName(f.label || f.key),
        })),
      }
    case 'page':
      return {
        ...config,
        signoff,
        programMin: clampInt(config.programMin ?? 30, 5, 24 * 60, 30),
        programs: config.programs?.slice(0, 24).map((p) => ({
          fromHour: clampInt(p.fromHour, 0, 23, 0),
          title: sanitizeTvChannelName(p.title),
          subtitle: p.subtitle ? sanitizeTvChannelName(p.subtitle) : undefined,
        })),
      }
    case 'audio':
      return {
        ...config,
        signoff,
        stations: config.stations?.slice(0, 24).map((s) => ({
          id: s.id.slice(0, 120),
          name: sanitizeTvChannelName(s.name),
          fromHour: s.fromHour != null ? clampInt(s.fromHour, 0, 23, 0) : undefined,
        })),
      }
    case 'segment':
      return { ...config, signoff, comingSoon: config.comingSoon ? sanitizeTvChannelName(config.comingSoon) : undefined }
  }
}
