import React, { createContext, useContext, useEffect, useState } from "react"

export type Theme = "dark" | "light" | "system"
export type Radius = "0" | "0.5rem" | "1rem"
export type Palette = "material" | "ocean" | "onyx"
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
    root.classList.remove("light", "dark")

    if (theme === "system") {
      const systemTheme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
      root.classList.add(systemTheme)
    } else {
      root.classList.add(theme)
    }

    // Apply Radius
    root.style.setProperty("--radius", radius)

    // Apply Font
    if (font === "merriweather") {
      root.style.setProperty("--font-primary", "Merriweather, serif")
    } else {
      root.style.setProperty("--font-primary", "Roboto, Inter, sans-serif")
    }

    // Apply Palette Overrides
    if (palette === "ocean") {
      root.style.setProperty("--primary", "oklch(0.65 0.20 160)") // Vibrant Cyan/Green
    } else if (palette === "onyx") {
      root.style.setProperty("--primary", "oklch(0.985 0 0)") // Silver/White accent
    } else {
      root.style.removeProperty("--primary") // Fallback to index.css Material Purple
    }

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
