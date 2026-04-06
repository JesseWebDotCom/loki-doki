import React, { createContext, useContext, useEffect, useState } from "react"
import { palettes, type PaletteId } from "./themes"

export type Theme = "dark" | "light" | "system"
export type Radius = "0" | "0.5rem" | "1rem"
export type Palette = PaletteId
export type Font = "roboto" | "merriweather"

interface ThemeProviderProps {
  children: React.ReactNode
  defaultTheme?: Theme
  defaultRadius?: Radius
  defaultPalette?: Palette
  defaultFont?: Font
  storageKey?: string
}

interface ThemeProviderState {
  theme: Theme
  radius: Radius
  palette: Palette
  font: Font
  setTheme: (theme: Theme) => void
  setRadius: (radius: Radius) => void
  setPalette: (palette: Palette) => void
  setFont: (font: Font) => void
  reset: () => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  radius: "1rem",
  palette: "material",
  font: "roboto",
  setTheme: () => null,
  setRadius: () => null,
  setPalette: () => null,
  setFont: () => null,
  reset: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "system",
  defaultRadius = "1rem",
  defaultPalette = "material",
  defaultFont = "roboto",
  storageKey = "lokidoki-ui-theme",
  ...props
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(`${storageKey}-mode`) as Theme) || defaultTheme
  )
  const [radius, setRadius] = useState<Radius>(
    () => (localStorage.getItem(`${storageKey}-radius`) as Radius) || defaultRadius
  )
  const [palette, setPalette] = useState<Palette>(
    () => (localStorage.getItem(`${storageKey}-palette`) as Palette) || defaultPalette
  )
  const [font, setFont] = useState<Font>(
    () => (localStorage.getItem(`${storageKey}-font`) as Font) || defaultFont
  )

  useEffect(() => {
    const root = window.document.documentElement
    
    // 1. Handle Dark/Light Mode
    root.classList.remove("light", "dark")
    const activeMode = theme === "system" 
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : theme
    root.classList.add(activeMode)

    // 2. Apply Radius
    root.style.setProperty("--radius", radius)

    // 3. Apply Font
    if (font === "merriweather") {
      root.style.setProperty("--font-primary", "Merriweather, Inter, serif")
    } else {
      root.style.setProperty("--font-primary", "Roboto, Inter, sans-serif")
    }

    // 4. Apply Palette Variables
    const currentPalette = palettes.find(p => p.id === palette) || palettes[0]
    const paletteVars = activeMode === "dark" ? currentPalette.dark : currentPalette.light

    Object.entries(paletteVars).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })

    // 5. Derive surface variables if not explicitly provided
    if (!paletteVars['--card']) {
      root.style.setProperty('--card', paletteVars['--background'])
    }
    if (!paletteVars['--popover']) {
      root.style.setProperty('--popover', paletteVars['--background'])
    }
    if (!paletteVars['--muted']) {
      root.style.setProperty('--muted', paletteVars['--background'])
    }
    
    // Sidebar fallback logic
    if (!paletteVars['--sidebar']) {
      root.style.setProperty('--sidebar', paletteVars['--background'])
    }
    if (!paletteVars['--sidebar-foreground']) {
      root.style.setProperty('--sidebar-foreground', paletteVars['--foreground'])
    }
    if (!paletteVars['--sidebar-border']) {
      root.style.setProperty('--sidebar-border', paletteVars['--border'] || 'transparent')
    }

    // Also update foregrounds if missing
    if (!paletteVars['--card-foreground']) root.style.setProperty('--card-foreground', paletteVars['--foreground'])
    if (!paletteVars['--popover-foreground']) root.style.setProperty('--popover-foreground', paletteVars['--foreground'])

  }, [theme, radius, palette, font])

  const value = {
    theme,
    radius,
    palette,
    font,
    setTheme: (theme: Theme) => {
      localStorage.setItem(`${storageKey}-mode`, theme)
      setTheme(theme)
    },
    setRadius: (radius: Radius) => {
      localStorage.setItem(`${storageKey}-radius`, radius)
      setRadius(radius)
    },
    setPalette: (palette: Palette) => {
      localStorage.setItem(`${storageKey}-palette`, palette)
      setPalette(palette)
    },
    setFont: (font: Font) => {
      localStorage.setItem(`${storageKey}-font`, font)
      setFont(font)
    },
    reset: () => {
      localStorage.removeItem(`${storageKey}-mode`)
      localStorage.removeItem(`${storageKey}-radius`)
      localStorage.removeItem(`${storageKey}-palette`)
      localStorage.removeItem(`${storageKey}-font`)
      setTheme(defaultTheme)
      setRadius(defaultRadius)
      setPalette(defaultPalette)
      setFont(defaultFont)
    }
  }

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  )
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext)
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider")
  return context
}
