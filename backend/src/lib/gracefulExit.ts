// Deliberate self-exit support (admin restart / self-update). The sidecar
// stopper lives in index.ts, which routes can't import without a cycle, so
// index.ts registers it here and exit paths call stopSidecarsForExit().
// The launcher's supervise loop (run.ps1 / run.sh) restarts the backend on
// exit, but it does NOT re-run the launcher's port sweep — a detached sidecar
// left running would hold its port and fail the next boot's spawn.

let stopSidecarsFn: (() => Promise<void>) | null = null

export function registerSidecarStopper(fn: () => Promise<void>): void {
  stopSidecarsFn = fn
}

/** Stop all spawned sidecars before a deliberate process.exit. Never throws. */
export async function stopSidecarsForExit(): Promise<void> {
  try {
    await stopSidecarsFn?.()
  } catch {
    /* best-effort — a stuck sidecar must not block the restart */
  }
}
