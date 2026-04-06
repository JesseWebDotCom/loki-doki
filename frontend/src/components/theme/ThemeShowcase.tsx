import React from 'react';
import { useTheme } from './ThemeProvider';

// Mapping the user's provided theme objects to a format we can use for preview
const lightTheme = {
    '--background': 'oklch(0.98 0.01 334.35)',
    '--foreground': 'oklch(0.22 0 0)',
    '--card': 'oklch(0.96 0.01 335.69)',
    '--card-foreground': 'oklch(0.14 0 0)',
    '--popover': 'oklch(0.95 0.01 316.67)',
    '--popover-foreground': 'oklch(0.40 0.04 309.35)',
    '--primary': 'oklch(0.51 0.21 286.50)',
    '--primary-foreground': 'oklch(1.00 0 0)',
    '--secondary': 'oklch(0.49 0.04 300.23)',
    '--secondary-foreground': 'oklch(1.00 0 0)',
    '--muted': 'oklch(0.96 0.01 335.69)',
    '--muted-foreground': 'oklch(0.14 0 0)',
    '--accent': 'oklch(0.92 0.04 303.47)',
    '--accent-foreground': 'oklch(0.14 0 0)',
    '--destructive': 'oklch(0.57 0.23 29.21)',
    '--border': 'oklch(0.83 0.02 308.26)',
    '--input': 'oklch(0.57 0.02 309.68)',
    '--ring': 'oklch(0.50 0.13 293.77)',
    '--chart-1': 'oklch(0.61 0.21 279.42)',
    '--chart-2': 'oklch(0.72 0.15 157.67)',
    '--chart-3': 'oklch(0.66 0.17 324.24)',
    '--chart-4': 'oklch(0.81 0.15 127.91)',
    '--chart-5': 'oklch(0.68 0.17 258.25)',
}

const darkTheme = {
    '--background': 'oklch(0.15 0.01 317.69)',
    '--foreground': 'oklch(0.95 0.01 321.50)',
    '--card': 'oklch(0.22 0.02 322.13)',
    '--card-foreground': 'oklch(0.95 0.01 321.50)',
    '--popover': 'oklch(0.22 0.02 322.13)',
    '--popover-foreground': 'oklch(0.95 0.01 321.50)',
    '--primary': 'oklch(0.60 0.22 279.81)',
    '--primary-foreground': 'oklch(0.98 0.01 321.51)',
    '--secondary': 'oklch(0.45 0.03 294.79)',
    '--secondary-foreground': 'oklch(0.95 0.01 321.50)',
    '--muted': 'oklch(0.22 0.01 319.50)',
    '--muted-foreground': 'oklch(0.70 0.01 320.70)',
    '--accent': 'oklch(0.35 0.06 299.57)',
    '--accent-foreground': 'oklch(0.95 0.01 321.50)',
    '--destructive': 'oklch(0.57 0.23 29.21)',
    '--border': 'oklch(0.40 0.04 309.35)',
    '--input': 'oklch(0.40 0.04 309.35)',
    '--ring': 'oklch(0.50 0.15 294.97)',
    '--chart-1': 'oklch(0.50 0.25 274.99)',
    '--chart-2': 'oklch(0.60 0.15 150.16)',
    '--chart-3': 'oklch(0.65 0.20 309.96)',
    '--chart-4': 'oklch(0.60 0.17 132.98)',
    '--chart-5': 'oklch(0.60 0.20 255.25)',
}

function ThemePreview({ mode, styles }: { mode: 'light' | 'dark'; styles: Record<string, string> }) {
  const cssVars = Object.fromEntries(
    Object.entries(styles).map(([key, value]) => [key, value])
  ) as React.CSSProperties

  return (
    <div
      className="rounded-2xl border p-8 space-y-8 shadow-m3 transition-all duration-500"
      style={{
        ...cssVars,
        background: styles['--background'],
        color: styles['--foreground'],
        borderColor: styles['--border']
      }}
    >
      <div className="text-center space-y-2">
        <h3 className="text-xl font-bold tracking-tight">{mode === 'light' ? 'Authorized Day Mode' : 'Authorized Night Mode'}</h3>
        <p className="text-sm font-medium" style={{ color: styles['--muted-foreground'] }}>
          Google Material Design Architecture
        </p>
      </div>

      {/* Color Swatches */}
      <div className="grid grid-cols-5 gap-3">
        <div className="aspect-square rounded-xl shadow-m1" style={{ background: styles['--primary'] }} title="Primary" />
        <div className="aspect-square rounded-xl shadow-m1" style={{ background: styles['--secondary'] }} title="Secondary" />
        <div className="aspect-square rounded-xl shadow-m1" style={{ background: styles['--accent'] }} title="Accent" />
        <div className="aspect-square rounded-xl shadow-m1" style={{ background: styles['--muted'] }} title="Muted" />
        <div className="aspect-square rounded-xl shadow-m1" style={{ background: styles['--destructive'] }} title="Destructive" />
      </div>

      {/* Buttons */}
      <div className="flex flex-wrap gap-3">
        <button
          className="px-5 py-2.5 rounded-xl text-sm font-bold shadow-m2 transition-transform active:scale-95"
          style={{ background: styles['--primary'], color: styles['--primary-foreground'] }}
        >
          Primary Action
        </button>
        <button
          className="px-5 py-2.5 rounded-xl text-sm font-bold shadow-m1 transition-transform active:scale-95"
          style={{ background: styles['--secondary'], color: styles['--secondary-foreground'] }}
        >
          Secondary
        </button>
        <button
          className="px-5 py-2.5 rounded-xl text-sm font-bold border shadow-sm transition-transform active:scale-95"
          style={{ borderColor: styles['--border'], color: styles['--foreground'] }}
        >
          Outline View
        </button>
      </div>

      {/* Card */}
      <div
        className="rounded-xl border p-6 space-y-3 shadow-m1"
        style={{
          background: styles['--card'],
          borderColor: styles['--border'],
          color: styles['--card-foreground']
        }}
      >
        <h4 className="font-bold text-lg">Surface Layer 1</h4>
        <p className="text-sm leading-relaxed" style={{ color: styles['--muted-foreground'] }}>
          Material Design surface with oklch calibration and high-fidelity elevation.
        </p>
      </div>

      {/* Badges */}
      <div className="flex gap-3">
        <span
          className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest bg-primary/10 border border-primary/20"
          style={{ color: styles['--primary'] }}
        >
          Active
        </span>
        <span
          className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest bg-secondary/10 border border-secondary/20"
          style={{ color: styles['--secondary'] }}
        >
          Context
        </span>
      </div>

      {/* Chart Colors */}
      <div className="space-y-3">
        <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Visualization Core</p>
        <div className="grid grid-cols-5 gap-2">
          <div className="h-10 rounded-lg shadow-sm" style={{ background: styles['--chart-1'] }} />
          <div className="h-10 rounded-lg shadow-sm" style={{ background: styles['--chart-2'] }} />
          <div className="h-10 rounded-lg shadow-sm" style={{ background: styles['--chart-3'] }} />
          <div className="h-10 rounded-lg shadow-sm" style={{ background: styles['--chart-4'] }} />
          <div className="h-10 rounded-lg shadow-sm" style={{ background: styles['--chart-5'] }} />
        </div>
      </div>
    </div>
  )
}

const ThemeShowcase: React.FC = () => {
    const { theme } = useTheme();
    
    // Determine which preview to show based on current theme
    const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia("(prefers-color-scheme: dark)").matches);

    return (
        <div className="w-full space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-700">
            <div className="flex items-center gap-4 mb-4">
                <span className="h-[1px] flex-1 bg-border/20" />
                <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-[0.4em]">
                    Live Authoritative Preview
                </div>
                <span className="h-[1px] flex-1 bg-border/20" />
            </div>
            
            <ThemePreview 
                mode={isDark ? 'dark' : 'light'} 
                styles={isDark ? darkTheme : lightTheme} 
            />
        </div>
    );
};

export default ThemeShowcase;
