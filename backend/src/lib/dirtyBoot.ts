// Detects whether the current OS boot followed an unclean shutdown (hard power-off).
//
// Windows writes Kernel-Power event 41 to the System log within seconds of the first
// boot after a dirty shutdown. If the most recent 41 event sits right at the current
// boot time, this boot followed a crash. The download queue uses this to hold the
// compute lane (ffmpeg re-encodes, map builds) for a cooldown after a crash-boot:
// resuming a heavy job seconds after boot re-triggered the very power-off that took
// the machine down, producing a machine-level crash loop (three hard power-offs in
// one night on 2026-07-08, each mid plex-cut).

import { spawn } from 'node:child_process'
import { uptime } from 'node:os'

/** How close (ms) the newest Kernel-Power 41 event must be to the current boot time
 *  to count as "this boot followed a crash". The event lands within seconds of boot;
 *  five minutes absorbs clock jitter and slow boots. */
const BOOT_MATCH_WINDOW_MS = 5 * 60_000

/** Milliseconds since epoch when the OS booted. */
export function osBootTimeMs(): number {
  return Date.now() - uptime() * 1000
}

/** True when this OS boot was preceded by an unclean shutdown (win32 only; other
 *  platforms report false). Best-effort: any query failure reports false. */
export async function bootFollowedUncleanShutdown(): Promise<boolean> {
  if (process.platform !== 'win32') return false
  const xml = await new Promise<string>((resolve) => {
    const proc = spawn(
      'wevtutil',
      ['qe', 'System', '/q:*[System[(EventID=41)]]', '/c:1', '/rd:true', '/f:xml'],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    )
    let out = ''
    proc.stdout?.on('data', (d: Buffer) => { out += d.toString() })
    proc.on('close', () => resolve(out))
    proc.on('error', () => resolve(''))
  })
  const stamp = xml.match(/SystemTime='([^']+)'/)?.[1]
  if (!stamp) return false
  const eventTime = Date.parse(stamp)
  if (!Number.isFinite(eventTime)) return false
  return Math.abs(eventTime - osBootTimeMs()) < BOOT_MATCH_WINDOW_MS
}
