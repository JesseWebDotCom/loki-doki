// Bring a video file from the blob store into the Plex-visible tree. Hardlink when the
// blob and the destination share a volume (free, zero extra disk); fall back to a real
// copy on EXDEV (cross-device — e.g. blob store local, Plex tree on a network share),
// mirroring the exact fallback content/store.ts already uses for the same reason.
//
// Also fall back on ENOTSUP/EPERM: confirmed live against a real SMB-mounted share
// (macOS smbfs) — hardlinks aren't cross-device there (blob and destination were on the
// SAME mounted volume), they're simply unsupported by the SMB protocol itself, which
// throws ENOTSUP rather than EXDEV. Silently failed placement with no fallback until
// this was caught: shows got their poster/NFO but zero episodes ever landed.

import { link, cp, unlink, mkdir, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'
import { ensureFfmpeg } from '@/lib/ffmpeg'
import { logger } from '@/lib/logger'

const COPY_FALLBACK_CODES = new Set(['EXDEV', 'ENOTSUP', 'EPERM'])

export async function placeFile(sourceAbsPath: string, destAbsPath: string): Promise<void> {
  await mkdir(dirname(destAbsPath), { recursive: true })
  try { await unlink(destAbsPath) } catch { /* fine if nothing was there yet */ }
  try {
    await link(sourceAbsPath, destAbsPath)
  } catch (err) {
    if (COPY_FALLBACK_CODES.has((err as NodeJS.ErrnoException)?.code ?? '')) {
      await cp(sourceAbsPath, destAbsPath)
    } else {
      throw err
    }
  }
}

function tailStderr(buf: string, lines = 8): string {
  return buf.trim().split('\n').slice(-lines).join(' | ')
}

/**
 * Place a video AND embed title/plot as real MP4 metadata atoms via an ffmpeg stream-copy
 * remux (no re-encode — just a container rewrite, comparable cost to placeFile's plain copy).
 *
 * Confirmed live (2026-07) this is actually necessary: Plex's modern "Plex TV Series" agent
 * (tv.plex.agents.series) does NOT read our sidecar .nfo files at all, even with "Prefer
 * local metadata" + "Use local assets" both on and after a real Refresh Metadata — it shows
 * a bare "Episode 1" regardless. That toggle turns out to mean "prefer tags embedded IN the
 * file" (ID3/MP4 atoms), not "read Kodi NFO sidecars" — verified by manually embedding a
 * title via ffmpeg and confirming ffprobe then reports it. The legacy "Personal Media Shows"
 * agent (tv.plex.agents.none) DOES read NFO directly, but requires a manual, easy-to-miss
 * "Agent sources" reorder in Plex's server-wide Settings with no API to configure it — this
 * embed-at-placement approach works with zero extra Plex-side configuration.
 *
 * Falls back to a plain placeFile() (still correct, just without the embedded title/plot —
 * Plex would show a bare "Episode N" for that file) if ffmpeg fails, rather than blocking
 * placement entirely on a remux error.
 */
export async function placeVideoWithMetadata(
  sourceAbsPath: string, destAbsPath: string, meta: { title: string; plot: string; audioLang?: string | null },
): Promise<void> {
  await mkdir(dirname(destAbsPath), { recursive: true })
  try { await unlink(destAbsPath) } catch { /* fine if nothing was there yet */ }

  try {
    const bin = await ensureFfmpeg()
    const args = [
      '-y', '-i', sourceAbsPath,
      '-c', 'copy', '-movflags', 'use_metadata_tags',
      '-metadata', `title=${meta.title}`,
      '-metadata', `description=${meta.plot}`,
      // yt-dlp output carries no language atom on the audio track, so Plex lists the
      // stream as "Unknown". Tag it (ISO 639-2, caller-resolved) during the same remux.
      ...(meta.audioLang ? ['-metadata:s:a:0', `language=${meta.audioLang}`] : []),
      destAbsPath,
    ]
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
      let err = ''
      child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 64_000) err = err.slice(-32_000) })
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`ffmpeg metadata remux exited ${code}: ${tailStderr(err)}`))
      })
    })
    const s = await stat(destAbsPath).catch(() => null)
    if (!s || s.size === 0) throw new Error('ffmpeg metadata remux produced no output')
  } catch (err) {
    logger.warn(`[plex-export] metadata embed failed for ${destAbsPath}, placing without embedded title/plot: ${err}`)
    await placeFile(sourceAbsPath, destAbsPath)
  }
}
