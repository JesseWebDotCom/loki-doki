import { Check, Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useTheme, type ThemeMode } from '@/context/ThemeContext'
import { ACCENT_PRESETS, accentSwatch } from '@/lib/themePresets'

const OPTIONS: { id: ThemeMode; label: string; Icon: React.ElementType; note: string }[] = [
  { id: 'light', label: 'Light',  Icon: Sun,     note: 'Always light' },
  { id: 'dark',  label: 'Dark',   Icon: Moon,    note: 'Always dark'  },
  { id: 'auto',  label: 'System', Icon: Monitor, note: 'Follows OS'   },
]

export function SettingsAppearanceTab() {
  const { theme, setTheme, accent, setAccent } = useTheme()

  return (
    <div className="p-4 space-y-6">
      <div>
        <h2 className="text-section mb-1">Theme</h2>
        <p className="text-caption text-muted-foreground mb-3">Choose how the app looks.</p>
        <div className="grid grid-cols-3 gap-3">
          {OPTIONS.map(({ id, label, Icon, note }) => (
            <button
              key={id}
              onClick={() => setTheme(id)}
              className={cn(
                'flex flex-col items-center gap-2.5 rounded-card border p-4 text-sm transition-all',
                theme === id
                  ? 'border-brand bg-brand/10 text-brand'
                  : 'border-border/50 text-muted-foreground hover:border-border hover:bg-muted/30',
              )}
            >
              <Icon className="size-5" />
              <span className="font-medium">{label}</span>
              <span className={cn('text-caption', theme === id ? 'text-brand/80' : 'text-muted-foreground')}>{note}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h2 className="text-section mb-1">Accent</h2>
        <p className="text-caption text-muted-foreground mb-3">The highlight color for buttons and controls.</p>
        <div className="flex flex-wrap gap-3">
          {ACCENT_PRESETS.map((preset) => (
            <button
              key={preset.key}
              onClick={() => setAccent(preset.key)}
              title={preset.label}
              aria-label={preset.label}
              aria-pressed={accent === preset.key}
              className={cn(
                'flex size-10 items-center justify-center rounded-full border-2 transition-all',
                accent === preset.key ? 'border-foreground' : 'border-transparent hover:border-border',
              )}
              // Runtime OKLCH swatch (per-preset hue); exempt from the source design contract.
              style={{ backgroundColor: accentSwatch(preset) }}
            >
              {accent === preset.key && <Check className="size-4 text-white" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
