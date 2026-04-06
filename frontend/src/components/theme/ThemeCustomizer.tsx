import React from "react"
import { Sun, Moon, Monitor, RotateCcw, CornerLeftUp, Type } from "lucide-react"
import { useTheme } from "./ThemeProvider"
import type { Theme, Radius, Palette as PaletteType, Font as FontType } from "./ThemeProvider"

const ThemeCustomizer: React.FC = () => {
  const { theme, setTheme, radius, setRadius, palette, setPalette, font, setFont, reset } = useTheme()

  return (
    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-4 bg-card/60 backdrop-blur-3xl p-3 px-8 rounded-full border border-border/10 shadow-m4 animate-in fade-in zoom-in-95 duration-700 z-50">
      
      {/* Palette Select */}
      <div className="flex items-center gap-2.5 border-r border-border/20 pr-6 group">
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
        <CornerLeftUp size={16} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground/80">Radius</span>
        <select 
          value={radius} 
          onChange={(e) => setRadius(e.target.value as Radius)}
          className="bg-transparent text-sm font-bold focus:outline-none cursor-pointer hover:text-primary transition-colors appearance-none pr-1"
        >
          <option value="0" className="bg-onyx-2">Sharp</option>
          <option value="0.5rem" className="bg-onyx-2">Rounded</option>
          <option value="1rem" className="bg-onyx-2">Pill</option>
        </select>
        <span className="text-[10px] text-muted-foreground transition-transform group-hover:translate-y-0.5">▾</span>
      </div>

      {/* Style (Font) Select */}
      <div className="flex items-center gap-2 border-r border-border/20 pr-4 group">
        <Type size={16} className="text-muted-foreground" />
        <span className="text-sm font-medium text-foreground/80">Style</span>
        <select 
          value={font} 
          onChange={(e) => setFont(e.target.value as FontType)}
          className="bg-transparent text-sm font-bold focus:outline-none cursor-pointer hover:text-primary transition-colors appearance-none pr-1"
        >
          <option value="roboto" className="bg-onyx-2">Roboto</option>
          <option value="merriweather" className="bg-onyx-2">Merriweather</option>
        </select>
        <span className="text-[10px] text-muted-foreground transition-transform group-hover:translate-y-0.5">▾</span>
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
