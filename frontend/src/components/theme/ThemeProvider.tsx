import React, { createContext, useContext, useEffect, useState } from "react"

export type Theme = "dark" | "light" | "system"
export type Radius = "0" | "0.5rem" | "1rem"
export type Palette = "material" | "ocean" | "onyx"

interface ThemeProviderProps {
  children: React.ReactNode
  defaultTheme?: Theme
  defaultRadius?: Radius
  defaultPalette?: Palette
  storageKey?: string
}

interface ThemeProviderState {
  theme: Theme
  radius: Radius
  palette: Palette
  setTheme: (theme: Theme) => void
  setRadius: (radius: Radius) => void
  setPalette: (palette: Palette) => void
  reset: () => void
}

const initialState: ThemeProviderState = {
  theme: "system",
  radius: "1rem",
  palette: "material",
  setTheme: () => null,
  setRadius: () => null,
  setPalette: () => null,
  reset: () => null,
}

const ThemeProviderContext = createContext<ThemeProviderState>(initialState)

export function ThemeProvider({
  children,
  defaultTheme = "system",
  defaultRadius = "1rem",
  defaultPalette = "material",
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

    // Apply Palette Overrides
    if (palette === "ocean") {
      root.style.setProperty("--primary", "oklch(0.65 0.20 160)") // Vibrant Cyan/Green
    } else if (palette === "onyx") {
      root.style.setProperty("--primary", "oklch(0.985 0 0)") // Silver/White accent
    } else {
      root.style.removeProperty("--primary") // Fallback to index.css Material Purple
    }

  }, [theme, radius, palette])

  const value = {
    theme,
    radius,
    palette,
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
    reset: () => {
      localStorage.removeItem(`${storageKey}-mode`)
      localStorage.removeItem(`${storageKey}-radius`)
      localStorage.removeItem(`${storageKey}-palette`)
      setTheme(defaultTheme)
      setRadius(defaultRadius)
      setPalette(defaultPalette)
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
