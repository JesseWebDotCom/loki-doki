import { useEffect, useState } from 'react'

// Status of the Doki Dock desktop app relative to this server, used by the
// profile menu + the "Get the desktop app" dialog. Only meaningful when the page
// runs inside the desktop shell (window.lokiDesktop present).

export interface DesktopAppStatus {
  /** Running inside the Doki Dock desktop shell. */
  installed: boolean
  /** Version of the running shell, if it reports one (older shells don't). */
  installedVersion: string | null
  /** Newest version this server can provide (its desktop/ source). */
  latestVersion: string | null
  /** latestVersion is strictly newer than the running shell (both must be known). */
  updateAvailable: boolean
}

/** Numeric semver-ish compare: >0 if a>b, <0 if a<b, 0 if equal or either unknown. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

const NOT_INSTALLED: DesktopAppStatus = {
  installed: false,
  installedVersion: null,
  latestVersion: null,
  updateAvailable: false,
}

/** In a plain browser this stays `installed: false` and performs no fetch; only
 *  inside the desktop shell does it read the running version and ask the server
 *  for the latest available one. */
export function useDesktopAppStatus(): DesktopAppStatus {
  // Seed `installed` synchronously so the menu label is right on first paint;
  // the version details fill in after the async checks below.
  const [status, setStatus] = useState<DesktopAppStatus>(() => ({
    ...NOT_INSTALLED,
    installed: typeof window !== 'undefined' && !!window.lokiDesktop,
  }))

  useEffect(() => {
    const shell = typeof window !== 'undefined' ? window.lokiDesktop : undefined
    if (!shell) return
    let cancelled = false
    void (async () => {
      const installedVersion = shell.getAppVersion
        ? await shell.getAppVersion().catch(() => null)
        : null
      let latestVersion: string | null = null
      try {
        const r = await fetch('/api/desktop/release', { credentials: 'include' })
        if (r.ok) latestVersion = ((await r.json()) as { version: string | null }).version ?? null
      } catch {
        /* offline or route unavailable: leave the latest version unknown */
      }
      if (cancelled) return
      setStatus({
        installed: true,
        installedVersion,
        latestVersion,
        updateAvailable: compareSemver(latestVersion, installedVersion) > 0,
      })
    })()
    return () => { cancelled = true }
  }, [])

  return status
}
