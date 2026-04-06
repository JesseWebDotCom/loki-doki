import React from "react"
import { Sun, Moon, Monitor, RotateCcw, CornerUpLeft } from "lucide-react"
import { useTheme } from "./ThemeProvider"
import type { Theme, Radius, Palette as PaletteType } from "./ThemeProvider"

const ThemeCustomizer: React.FC = () => {
  const { theme, setTheme, radius, setRadius, palette, setPalette, reset } = useTheme()

  return (
    <div className="flex items-center gap-4 bg-card/80 backdrop-blur-xl p-2.5 px-6 rounded-2xl border border-border/50 shadow-m3 animate-in fade-in slide-in-from-bottom-2 duration-500 max-w-fit mx-auto">
      
      {/* Palette Select */}
      <div className="flex items-center gap-2 border-r border-border/20 pr-4">
        <div className={`w-3 h-3 rounded-full ${
          palette === 'material' ? 'bg-primary' : 
          palette === 'ocean' ? 'bg-[oklch(0.65_0.20_160)]' : 'bg-gray-400'
        }`} />
        <select 
          value={palette} 
          onChange={(e) => setPalette(e.target.value as PaletteType)}
          className="bg-transparent text-sm font-bold focus:outline-none cursor-pointer hover:text-primary transition-colors"
        >
          <option value="material" className="bg-card">Material Purple</option>
          <option value="ocean" className="bg-card">Ocean Breeze</option>
          <option value="onyx" className="bg-card">Onyx Silver</option>
        </select>
      </div>

      {/* Mode Switcher */}
      <div className="flex items-center gap-1 border-r border-border/20 pr-4">
        {[
          { id: 'light', icon: Sun, label: 'Light' },
          { id: 'dark', icon: Moon, label: 'Dark' },
          { id: 'system', icon: Monitor, label: 'System' }
        ].map((mode) => (
          <button
            key={mode.id}
            onClick={() => setTheme(mode.id as Theme)}
            className={`p-2 rounded-xl transition-all ${
              theme === mode.id 
                ? "bg-primary/20 text-primary border border-primary/20 shadow-sm" 
                : "text-muted-foreground hover:text-foreground"
            }`}
            title={mode.label}
          >
            <mode.icon size={16} />
          </button>
        ))}
      </div>

      {/* Radius Select */}
      <div className="flex items-center gap-2 border-r border-border/20 pr-4">
        <CornerUpLeft size={16} className="text-muted-foreground" />
        <select 
          value={radius} 
          onChange={(e) => setRadius(e.target.value as Radius)}
          className="bg-transparent text-sm font-bold focus:outline-none cursor-pointer hover:text-primary transition-colors"
        >
          <option value="0" className="bg-card">Sharp</option>
          <option value="0.5rem" className="bg-card">Rounded</option>
          <option value="1rem" className="bg-card">Pill (Default)</option>
        </select>
      </div>

      {/* Reset */}
      <button 
        onClick={reset}
        className="flex items-center gap-2 px-3 py-2 rounded-xl text-muted-foreground hover:text-primary hover:bg-primary/10 transition-all text-sm font-bold group"
      >
        <RotateCcw size={16} className="group-hover:rotate-[-45deg] transition-transform" />
        <span>Reset</span>
      </button>
    </div>
  )
}

export default ThemeCustomizer
