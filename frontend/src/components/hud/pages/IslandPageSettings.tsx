import { useEffect, useState } from 'react'
import { Power } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { useCompanionState } from '@/lib/companionState'
import { DISPLAY_MODES } from '@/components/companion/CompanionMenu'
import type { ShellSettings } from '@/types/desktop'

// Settings page of the island panel (gear in the top bar): shell settings
// (applied LIVE via the settings:set-shell IPC; the tray reads the same file)
// plus the island's own display preference. The companion menu itself stays on
// avatar right-click. Size labels come from CompanionMenu's DISPLAY_MODES so
// the two pickers can never drift.

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-white/85">{label}</div>
        {hint && <div className="text-[11px] text-white/40">{hint}</div>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    // design-ok(glass-on-plain-bg): switch track inside the black island surface
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={cn('h-5 w-9 rounded-full p-0.5 transition-colors', on ? 'bg-brand' : 'bg-white/15')}
    >
      <span className={cn('block size-4 rounded-full bg-white transition-transform', on && 'translate-x-4')} />
    </button>
  )
}

export function IslandPageSettings() {
  const { size, setSize } = useCompanionState()
  const [shell, setShell] = useState<ShellSettings | null>(null)
  const [hotkeyDraft, setHotkeyDraft] = useState('')
  const [hotkeyError, setHotkeyError] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.lokiDesktop?.getShellSettings?.().then((s) => {
      if (cancelled || !s) return
      setShell(s)
      setHotkeyDraft(s.hotkey)
    })
    return () => { cancelled = true }
  }, [])

  const patch = async (p: Partial<Pick<ShellSettings, 'hotkey' | 'launchAtLogin' | 'alwaysListening'>>) => {
    const res = await window.lokiDesktop?.setShellSettings?.(p)
    if (res?.ok) {
      const s = await window.lokiDesktop?.getShellSettings?.()
      if (s) setShell(s)
    }
    return res
  }

  const applyHotkey = async () => {
    setHotkeyError('')
    const res = await patch({ hotkey: hotkeyDraft })
    if (res && !res.ok) setHotkeyError(res.error ?? 'Could not register that hotkey.')
  }

  return (
    <div className="flex h-full flex-col gap-0.5 overflow-y-auto">
      <Row label="Island size" hint="How much island stays on screen when idle">
        {/* design-ok(glass-on-plain-bg): segmented control inside the black island surface */}
        <div className="flex rounded-control bg-white/10 p-0.5">
          {DISPLAY_MODES.map((m) => (
            <button
              key={m.size}
              type="button"
              onClick={() => setSize(m.size)}
              className={cn(
                'flex items-center gap-1 rounded-control px-2 py-1 text-[11px] transition-colors',
                size === m.size ? 'bg-brand/25 text-white ring-1 ring-inset ring-brand/40' : 'text-white/55 hover:text-white',
              )}
            >
              <m.icon className="size-3" />
              {m.label}
            </button>
          ))}
        </div>
      </Row>

      {shell ? (
        <>
          <Row label="Always listening" hint="Arm the wake word whenever the app starts">
            <Toggle
              on={shell.alwaysListening}
              label="Always listening"
              onChange={(v) => void patch({ alwaysListening: v })}
            />
          </Row>
          <Row label="Launch at login">
            <Toggle
              on={shell.launchAtLogin}
              label="Launch at login"
              onChange={(v) => void patch({ launchAtLogin: v })}
            />
          </Row>
          <Row label="Hotkey" hint={hotkeyError || 'Electron accelerator, e.g. CommandOrControl+Shift+Space'}>
            <div className="flex items-center gap-1.5">
              {/* design-ok(raw-input-element): accelerator string field on the fixed-black island, ui Input's theme tokens would clash */}
              <input
                value={hotkeyDraft}
                onChange={(e) => setHotkeyDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void applyHotkey() }}
                spellCheck={false}
                className={cn(
                  // design-ok(glass-on-plain-bg): input inside the black island surface
                  'w-56 rounded-control bg-white/10 px-2 py-1 text-xs text-white/85 outline-none ring-1 ring-inset',
                  hotkeyError ? 'ring-destructive' : 'ring-white/15 focus:ring-brand/50',
                )}
              />
              <Button size="sm" variant="outline" className="h-6 rounded-full px-2 text-[11px]" onClick={() => void applyHotkey()}>
                Apply
              </Button>
            </div>
          </Row>
          <Row label="Server" hint={shell.serverHost || 'not configured'}>
            <Button size="sm" variant="outline" className="h-6 rounded-full px-2 text-[11px]" onClick={() => window.lokiDesktop?.openServerSetup?.()}>
              Change server
            </Button>
          </Row>
          <Row label="Quit Loki Doki">
            <Button
              size="sm"
              variant="destructive"
              className="h-6 rounded-full px-2 text-[11px]"
              onClick={() => window.lokiDesktop?.quitApp?.()}
            >
              <Power className="size-3" />
              Quit
            </Button>
          </Row>
        </>
      ) : (
        <p className="pt-2 text-xs text-white/40">Shell settings are available in the desktop app.</p>
      )}
    </div>
  )
}
