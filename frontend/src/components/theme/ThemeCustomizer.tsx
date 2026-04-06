import React, { useState, useRef, useEffect } from "react"
import { createPortal } from "react-dom"
import { Sun, Moon, RotateCcw, Type, ChevronUp, ChevronDown, Check, LayoutGrid } from "lucide-react"
import { useTheme } from "./ThemeProvider"
import { palettes } from "./themes"

// Radius Icon (Custom Corner pill)
const RadiusIcon = ({ className }: { className?: string }) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M6 4h12c1.1 0 2 .9 2 2v12" />
    <path d="M4 20h2" />
    <circle cx="4" cy="4" r="1.5" fill="currentColor" stroke="none" />
  </svg>
)

const ThemeCustomizer: React.FC = () => {
  const { theme, setTheme, radius, setRadius, palette, setPalette, font, setFont, reset } = useTheme()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [radiusOpen, setRadiusOpen] = useState(false)
  const [styleOpen, setStyleOpen] = useState(false)
  
  // Anchors for each popover
  const [pickerAnchor, setPickerAnchor] = useState({ bottom: 0, left: 0 })
  const [radiusAnchor, setRadiusAnchor] = useState({ bottom: 0, left: 0 })
  const [styleAnchor, setStyleAnchor] = useState({ bottom: 0, left: 0 })
  
  const containerRef = useRef<HTMLDivElement>(null)
  
  // Refs for buttons to calculate position
  const paletteBtnRef = useRef<HTMLButtonElement>(null)
  const radiusBtnRef = useRef<HTMLButtonElement>(null)
  const styleBtnRef = useRef<HTMLButtonElement>(null)

  const currentPalette = palettes.find(p => p.id === palette) || palettes[0]

  // Function to recalibrate all anchor positions
  const updateAnchors = () => {
    if (paletteBtnRef.current) {
      const rect = paletteBtnRef.current.getBoundingClientRect()
      setPickerAnchor({ bottom: window.innerHeight - rect.top + 12, left: rect.left + rect.width / 2 })
    }
    if (radiusBtnRef.current) {
      const rect = radiusBtnRef.current.getBoundingClientRect()
      setRadiusAnchor({ bottom: window.innerHeight - rect.top + 12, left: rect.left + rect.width / 2 })
    }
    if (styleBtnRef.current) {
      const rect = styleBtnRef.current.getBoundingClientRect()
      setStyleAnchor({ bottom: window.innerHeight - rect.top + 12, left: rect.left + rect.width / 2 })
    }
  }

  // Recalibrate on open or resize
  useEffect(() => {
    if (pickerOpen || radiusOpen || styleOpen) {
      updateAnchors()
      window.addEventListener("resize", updateAnchors)
      window.addEventListener("scroll", updateAnchors, true) // Capture scroll to keep anchored
    }
    return () => {
      window.removeEventListener("resize", updateAnchors)
      window.removeEventListener("scroll", updateAnchors, true)
    }
  }, [pickerOpen, radiusOpen, styleOpen])

  // Close menus on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      // Check if click was inside customizer container
      if (containerRef.current && containerRef.current.contains(event.target as Node)) {
        return
      }

      // Check if click was inside any opened portal
      const palettePortal = document.getElementById("palette-portal")
      const radiusPortal = document.getElementById("radius-portal")
      const stylePortal = document.getElementById("style-portal")

      if (palettePortal && palettePortal.contains(event.target as Node)) return
      if (radiusPortal && radiusPortal.contains(event.target as Node)) return
      if (stylePortal && stylePortal.contains(event.target as Node)) return

      setPickerOpen(false)
      setRadiusOpen(false)
      setStyleOpen(false)
    }
    
    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [])

  return (
    <div 
      ref={containerRef}
      className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-0 bg-card/80 backdrop-blur-3xl p-2 px-3 rounded-full border border-border/10 shadow-m4 z-50 animate-in fade-in slide-in-from-bottom-4 duration-700"
    >
      
      {/* Palette Picker */}
      <div className="relative">
        <button 
          ref={paletteBtnRef}
          onClick={() => {
            setPickerOpen(!pickerOpen)
            setRadiusOpen(false)
            setStyleOpen(false)
          }}
          className={`flex items-center gap-3 px-4 py-2.5 hover:bg-foreground/5 rounded-full transition-all group min-w-[160px] whitespace-nowrap ${pickerOpen ? 'bg-foreground/10' : ''}`}
        >
          <div 
            className="w-4 h-4 rounded-full shadow-sm border border-white/10 ring-2 ring-primary/20 shrink-0" 
            style={{ backgroundColor: currentPalette.swatch }} 
          />
          <span className="text-sm font-black text-foreground tracking-tight">{currentPalette.label}</span>
          <ChevronUp 
            size={14} 
            className={`text-muted-foreground transition-transform duration-300 ${pickerOpen ? 'rotate-180' : ''} shrink-0 ml-auto`} 
          />
        </button>

        {pickerOpen && createPortal(
          <div 
            id="palette-portal"
            className="fixed z-[100] w-[480px] bg-card/95 backdrop-blur-2xl border border-border/10 rounded-[2rem] p-8 shadow-m4 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300 origin-bottom"
            style={{ 
                bottom: `${pickerAnchor.bottom}px`, 
                left: `${Math.max(12, Math.min(window.innerWidth - 492, pickerAnchor.left - 240))}px`
            }}
          >
            <div className="flex items-center gap-2 mb-8 px-1">
              <LayoutGrid size={18} className="text-primary" />
              <span className="text-xs font-black uppercase tracking-[0.3em] text-muted-foreground">Select Palette</span>
            </div>
            <div className="grid grid-cols-6 gap-6 max-h-[420px] overflow-y-auto pr-4 custom-scrollbar px-1">
              {palettes.map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setPalette(p.id)
                    setPickerOpen(false)
                  }}
                  className="group relative flex flex-col items-center gap-2"
                >
                  <div 
                    className={`w-12 h-12 rounded-full transition-all duration-300 group-hover:scale-110 group-active:scale-95 flex items-center justify-center border border-white/5 ${
                      palette === p.id 
                        ? "ring-2 ring-primary ring-offset-4 ring-offset-card shadow-lg" 
                        : "shadow-sm group-hover:shadow-md"
                    }`}
                    style={{ backgroundColor: p.swatch }}
                  >
                    {palette === p.id && (
                      <Check size={18} className="text-white animate-in zoom-in-50 duration-300" />
                    )}
                  </div>
                  
                  <div className="absolute -top-12 left-1/2 -translate-x-1/2 px-3 py-2 bg-foreground text-background text-[10px] font-black rounded-xl opacity-0 group-hover:opacity-100 transition-all pointer-events-none whitespace-nowrap z-[110] shadow-2xl uppercase tracking-tighter transform translate-y-2 group-hover:translate-y-0">
                    {p.label}
                  </div>
                </button>
              ))}
            </div>
          </div>,
          document.body
        )}
      </div>

      <div className="w-px h-6 bg-border/20 mx-2" />

      {/* Mode Switcher */}
      <div className="flex items-center gap-1 px-1">
        {[
          { id: 'light', icon: Sun, label: 'Light' },
          { id: 'dark', icon: Moon, label: 'Dark' }
        ].map((mode) => (
          <button
            key={mode.id}
            onClick={() => setTheme(mode.id as any)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full transition-all duration-300 ${
              theme === mode.id 
                ? "bg-foreground/10 text-foreground shadow-sm" 
                : "text-muted-foreground hover:text-foreground hover:bg-foreground/5"
            }`}
          >
            <mode.icon size={14} className={theme === mode.id ? "text-primary" : ""} />
            <span className="text-[10px] font-black tracking-widest uppercase">{mode.label}</span>
          </button>
        ))}
      </div>

      <div className="w-px h-6 bg-border/20 mx-2" />

      {/* Radius Selector */}
      <div className="relative">
        <button 
          ref={radiusBtnRef}
          onClick={() => {
            setRadiusOpen(!radiusOpen)
            setPickerOpen(false)
            setStyleOpen(false)
          }}
          className={`flex items-center gap-2 px-4 py-2 hover:bg-foreground/5 rounded-full transition-all duration-300 min-w-[120px] whitespace-nowrap ${radiusOpen ? 'bg-foreground/10' : ''} group`}
        >
          <RadiusIcon className="text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          <span className="text-[10px] font-black uppercase text-muted-foreground tracking-widest shrink-0">Radius</span>
          <span className="text-xs font-black text-foreground capitalize ml-auto">
            {radius === "0" ? "Sharp" : radius === "0.5rem" ? "Rounded" : "Pill"}
          </span>
          <ChevronDown size={12} className={`text-muted-foreground transition-transform ${radiusOpen ? 'rotate-180 text-primary' : ''} shrink-0`} />
        </button>

        {radiusOpen && createPortal(
          <div 
            id="radius-portal"
            className="fixed z-[100] w-48 bg-card/95 backdrop-blur-2xl border border-border/10 rounded-2xl p-2 shadow-m4 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300 origin-bottom"
            style={{ 
                bottom: `${radiusAnchor.bottom}px`, 
                left: `${Math.max(12, Math.min(window.innerWidth - 204, radiusAnchor.left - 96))}px`
            }}
          >
            {[
              { value: "0", label: "Sharp" },
              { value: "0.5rem", label: "Rounded" },
              { value: "1rem", label: "Pill" }
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setRadius(opt.value as any)
                  setRadiusOpen(false)
                }}
                className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                  radius === opt.value 
                    ? "bg-primary text-primary-foreground shadow-sm" 
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                }`}
              >
                <span>{opt.label}</span>
                {radius === opt.value && <Check size={12} />}
              </button>
            ))}
          </div>,
          document.body
        )}
      </div>

      <div className="w-px h-6 bg-border/20 mx-2" />

      {/* Font Selector */}
      <div className="relative">
        <button 
          ref={styleBtnRef}
          onClick={() => {
            setStyleOpen(!styleOpen)
            setPickerOpen(false)
            setRadiusOpen(false)
          }}
          className={`flex items-center gap-2 px-4 py-2 hover:bg-foreground/5 rounded-full transition-all duration-300 min-w-[124px] whitespace-nowrap ${styleOpen ? 'bg-foreground/10' : ''} group`}
        >
          <Type size={14} className="text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          <span className="text-[10px] font-black uppercase text-muted-foreground tracking-widest shrink-0">Style</span>
          <span className="text-xs font-black text-foreground capitalize ml-auto">
            {font === "roboto" ? "Roboto" : "Serif"}
          </span>
          <ChevronDown size={12} className={`text-muted-foreground transition-transform ${styleOpen ? 'rotate-180 text-primary' : ''} shrink-0`} />
        </button>

        {styleOpen && createPortal(
          <div 
            id="style-portal"
            className="fixed z-[100] w-48 bg-card/95 backdrop-blur-2xl border border-border/10 rounded-2xl p-2 shadow-m4 animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-300 origin-bottom"
            style={{ 
                bottom: `${styleAnchor.bottom}px`, 
                left: `${Math.max(12, Math.min(window.innerWidth - 204, styleAnchor.left - 96))}px`
            }}
          >
            {[
              { value: "roboto", label: "Roboto" },
              { value: "merriweather", label: "Serif" }
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  setFont(opt.value as any)
                  setStyleOpen(false)
                }}
                className={`w-full flex items-center justify-between px-4 py-2.5 rounded-xl text-xs font-black uppercase tracking-widest transition-all ${
                  font === opt.value 
                    ? "bg-primary text-primary-foreground shadow-sm" 
                    : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                }`}
              >
                <span>{opt.label}</span>
                {font === opt.value && <Check size={12} />}
              </button>
            ))}
          </div>,
          document.body
        )}
      </div>

      <div className="w-px h-6 bg-border/20 mx-2" />

      {/* Reset */}
      <button 
        onClick={reset}
        className="p-2.5 hover:bg-primary/10 hover:text-primary rounded-full transition-all duration-500 text-muted-foreground group mr-1 shrink-0"
        title="Reset Theme"
      >
        <RotateCcw size={16} className="group-hover:rotate-[-180deg] transition-transform duration-700" />
      </button>
    </div>
  )
}

export default ThemeCustomizer
