import { Monitor, Moon, Sun } from 'lucide-react'
import { cn } from '@/lib/cn'
import { useTheme, type ThemeMode } from '@/context/ThemeContext'

const OPTIONS: { id: ThemeMode; label: string; Icon: React.ElementType; note: string }[] = [
  { id: 'light', label: 'Light',  Icon: Sun,     note: 'Always light' },
  { id: 'dark',  label: 'Dark',   Icon: Moon,    note: 'Always dark'  },
  { id: 'auto',  label: 'System', Icon: Monitor, note: 'Follows OS'   },
]

export function SettingsAppearanceTab() {
  const { theme, setTheme } = useTheme()

  return (
    <div className="p-4 space-y-6">
      <div>
        <p className="text-sm font-medium mb-1">Theme</p>
        <p className="text-xs text-muted-foreground mb-3">Choose how the app looks.</p>
        <div className="grid grid-cols-3 gap-3">
          {OPTIONS.map(({ id, label, Icon, note }) => (
            <button
              key={id}
              onClick={() => setTheme(id)}
              className={cn(
                'flex flex-col items-center gap-2.5 rounded-xl border p-4 text-sm transition-all',
                theme === id
                  ? 'border-primary ring-1 ring-primary/20 text-foreground bg-primary/5'
                  : 'border-border/50 text-muted-foreground hover:border-border hover:bg-muted/30',
              )}
            >
              <Icon className="size-5" />
              <span className="font-medium">{label}</span>
              <span className="text-xs text-muted-foreground">{note}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
