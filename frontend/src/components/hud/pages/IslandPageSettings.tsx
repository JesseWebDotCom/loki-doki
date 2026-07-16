import { useEffect, useState } from 'react'
import { FolderOpen, Power, X } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Button } from '@/components/ui/button'
import { useCompanionState } from '@/lib/companionState'
import { useNearbyEventsPref } from '@/components/hud/useTodayItems'
import { DISPLAY_MODES } from '@/components/companion/CompanionMenu'
import { timeAgo } from '@/lib/notifications'
import type { FsAccessEntry, ResourceMonitorSettings, ShellSettings } from '@/types/desktop'

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

// Small numeric threshold field for the monitoring section.
function NumField({ value, onCommit, suffix, label }: { value: number; onCommit: (v: number) => void; suffix: string; label: string }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const n = Number(draft)
    if (Number.isFinite(n) && n !== value) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <label className="flex items-center gap-1 text-[11px] text-white/55">
      {/* design-ok(raw-input-element): tiny numeric field on the fixed-black island, ui Input's theme tokens would clash */}
      <input
        value={draft}
        aria-label={label}
        inputMode="numeric"
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
        // design-ok(glass-on-plain-bg): input inside the black island surface
        className="w-11 rounded-control bg-white/10 px-1.5 py-0.5 text-right text-xs tabular-nums text-white/85 outline-none ring-1 ring-inset ring-white/15 focus:ring-brand/50"
      />
      {suffix}
    </label>
  )
}

export function IslandPageSettings() {
  const { size, setSize } = useCompanionState()
  const nearbyEvents = useNearbyEventsPref()
  const [shell, setShell] = useState<ShellSettings | null>(null)
  const [hotkeyDraft, setHotkeyDraft] = useState('')
  const [hotkeyError, setHotkeyError] = useState('')
  const [recent, setRecent] = useState<FsAccessEntry[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.lokiDesktop?.getShellSettings?.().then((s) => {
      if (cancelled || !s) return
      setShell(s)
      setHotkeyDraft(s.hotkey)
    })
    return () => { cancelled = true }
  }, [])

  const patch = async (p: Partial<Pick<ShellSettings, 'hotkey' | 'launchAtLogin' | 'alwaysListening' | 'fileAccessEnabled'>> & { resourceMonitor?: Partial<ResourceMonitorSettings> }) => {
    const res = await window.lokiDesktop?.setShellSettings?.(p)
    if (res?.ok) {
      const s = await window.lokiDesktop?.getShellSettings?.()
      if (s) setShell(s)
    }
    return res
  }

  const rm = shell?.resourceMonitor
  const patchMonitor = (p: Partial<ResourceMonitorSettings>) => void patch({ resourceMonitor: p })

  const refreshRoots = async () => {
    const s = await window.lokiDesktop?.getShellSettings?.()
    if (s) setShell(s)
  }
  const addFolder = async () => {
    await window.lokiDesktop?.fsPickFolder?.()
    await refreshRoots()
  }
  const removeRoot = async (root: string) => {
    await window.lokiDesktop?.fsRemoveRoot?.(root)
    await refreshRoots()
  }
  const toggleRecent = async () => {
    if (recent) { setRecent(null); return }
    const list = await window.lokiDesktop?.fsRecentAccesses?.()
    setRecent(list ?? [])
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

      <Row label="Nearby events" hint="Community listings from your town on the Home and Calendar pages">
        <Toggle
          on={nearbyEvents.show}
          label="Nearby events"
          onChange={(v) => nearbyEvents.setShow(v)}
        />
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
          <div className="pt-2 text-[11px] uppercase tracking-wide text-white/40">Machine monitoring</div>
          <Row label="Monitor this computer" hint="Watch CPU, memory, disk, and battery for problems">
            <Toggle
              on={rm?.enabled !== false}
              label="Monitor this computer"
              onChange={(v) => patchMonitor({ enabled: v })}
            />
          </Row>
          {rm?.enabled !== false && (
            <>
              <Row label="Companion announces aloud" hint="Speak alerts through the companion, not just the bell">
                <Toggle
                  on={rm?.announce === true}
                  label="Companion announces aloud"
                  onChange={(v) => patchMonitor({ announce: v })}
                />
              </Row>
              <Row label="Processor alert" hint="Sustained load before alerting">
                <div className="flex items-center gap-2">
                  <NumField value={rm?.cpuPct ?? 90} onCommit={(v) => patchMonitor({ cpuPct: v })} suffix="%" label="CPU percent threshold" />
                  <NumField value={rm?.cpuSustainMin ?? 5} onCommit={(v) => patchMonitor({ cpuSustainMin: v })} suffix="min" label="CPU sustain minutes" />
                </div>
              </Row>
              <Row label="Memory alert" hint="Percent in use">
                <NumField value={rm?.memPct ?? 90} onCommit={(v) => patchMonitor({ memPct: v })} suffix="%" label="Memory percent threshold" />
              </Row>
              <Row label="Disk alert" hint="Percent free remaining">
                <NumField value={rm?.diskFreePct ?? 10} onCommit={(v) => patchMonitor({ diskFreePct: v })} suffix="%" label="Disk free percent threshold" />
              </Row>
              <Row label="Battery alert" hint="Percent, while not charging">
                <NumField value={rm?.batteryPct ?? 15} onCommit={(v) => patchMonitor({ batteryPct: v })} suffix="%" label="Battery percent threshold" />
              </Row>
            </>
          )}

          <div className="pt-2 text-[11px] uppercase tracking-wide text-white/40">Local file access</div>
          <Row label="Let the companion read files" hint="Read-only, and only inside folders you allow below">
            <Toggle
              on={shell.fileAccessEnabled === true}
              label="Let the companion read files"
              onChange={(v) => void patch({ fileAccessEnabled: v })}
            />
          </Row>
          {shell.fileAccessEnabled === true && (
            <div className="space-y-1 pb-1">
              {(shell.fileAccessRoots ?? []).map((root) => (
                <div key={root} className="flex items-center gap-1.5">
                  <FolderOpen className="size-3 shrink-0 text-white/40" />
                  <span className="min-w-0 flex-1 truncate text-xs text-white/70" title={root}>{root}</span>
                  <button
                    type="button"
                    aria-label={`Stop allowing ${root}`}
                    title="Stop allowing this folder"
                    onClick={() => void removeRoot(root)}
                    className="text-white/35 hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
              {(shell.fileAccessRoots ?? []).length === 0 && (
                <p className="text-[11px] text-white/40">No folders allowed yet - nothing can be read.</p>
              )}
              <div className="flex items-center gap-2 pt-0.5">
                <Button size="sm" variant="outline" className="h-6 rounded-full px-2 text-[11px]" onClick={() => void addFolder()}>
                  Add folder…
                </Button>
                <button type="button" onClick={() => void toggleRecent()} className="text-[11px] text-white/40 hover:text-white/70">
                  {recent ? 'Hide recent reads' : 'Recent reads'}
                </button>
              </div>
              {recent && (
                <div className="space-y-0.5 pt-0.5">
                  {recent.length === 0 && <p className="text-[11px] text-white/40">Nothing has been read yet.</p>}
                  {recent.slice(0, 8).map((r, i) => (
                    <div key={i} className="flex items-center gap-1.5 text-[11px]">
                      <span className={cn('shrink-0', r.ok ? 'text-white/45' : 'text-destructive/80')}>{r.action}</span>
                      <span className="min-w-0 flex-1 truncate text-white/60" title={r.path}>{r.path}</span>
                      <span className="shrink-0 text-white/30">{timeAgo(r.at)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

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
