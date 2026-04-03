export type ThemePresetId = "familiar" | "studio" | "minimal" | "amoled"
export type ThemeMode = "light" | "dark" | "auto"
export type LayoutPresetId = string

export type ThemePreview = {
  background: string
  panel: string
  accent: string
  text: string
}

export type ThemePresetSummary = {
  id: ThemePresetId
  name: string
  description: string
  supports_light: boolean
  supports_dark: boolean
  font_label: string
  motion_label: string
  radius_label: string
  preview: {
    light: ThemePreview
    dark: ThemePreview
  }
}

export const fallbackThemePresets: ThemePresetSummary[] = [
  {
    id: "familiar",
    name: "Familiar",
    description: "Neutral and familiar for everyday conversation.",
    supports_light: true,
    supports_dark: true,
    font_label: "Geist",
    motion_label: "Balanced",
    radius_label: "Soft",
    preview: {
      light: { background: "#f5f7fb", panel: "#ffffff", accent: "#10a37f", text: "#111827" },
      dark: { background: "#0d1117", panel: "#161b22", accent: "#10a37f", text: "#f3f4f6" },
    },
  },
  {
    id: "studio",
    name: "Studio",
    description: "The exact character-editor visual language carried app-wide.",
    supports_light: true,
    supports_dark: true,
    font_label: "Geist Variable",
    motion_label: "Studio",
    radius_label: "Instrument",
    preview: {
      light: { background: "#edf4ff", panel: "#ffffff", accent: "#0ea5e9", text: "#0f172a" },
      dark: { background: "#07111f", panel: "#0f172a", accent: "#38bdf8", text: "#e6f1ff" },
    },
  },
  {
    id: "minimal",
    name: "Minimal",
    description: "Cool, restrained, and low-noise.",
    supports_light: true,
    supports_dark: true,
    font_label: "Geist",
    motion_label: "Subtle",
    radius_label: "Crisp",
    preview: {
      light: { background: "#f2f4f7", panel: "#fbfcfd", accent: "#2f6fed", text: "#101828" },
      dark: { background: "#0b1020", panel: "#121826", accent: "#7c9bff", text: "#edf2ff" },
    },
  },
  {
    id: "amoled",
    name: "AMOLED",
    description: "Pure black surfaces with crisp contrast for OLED screens.",
    supports_light: true,
    supports_dark: true,
    font_label: "Geist",
    motion_label: "Quiet",
    radius_label: "Clean",
    preview: {
      light: { background: "#f6f7fb", panel: "#ffffff", accent: "#ffffff", text: "#111111" },
      dark: { background: "#000000", panel: "#050505", accent: "#f5f5f5", text: "#ffffff" },
    },
  },
]

export function resolveThemeMode(mode: ThemeMode): Exclude<ThemeMode, "auto"> {
  if (mode === "auto") {
    if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      return "dark"
    }
    return "light"
  }
  return mode
}

export function applyThemeAttributes(presetId: ThemePresetId, mode: ThemeMode) {
  if (typeof document === "undefined") {
    return
  }
  const effectiveMode = resolveThemeMode(mode)
  const root = document.documentElement
  root.dataset.themePreset = presetId
  root.dataset.themeMode = effectiveMode
  root.style.colorScheme = effectiveMode
}
