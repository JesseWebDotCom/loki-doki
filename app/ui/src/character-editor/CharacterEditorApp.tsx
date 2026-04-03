import "@/character-editor/index.css"
import "@/character-editor/integration/appTheme.css"

import { useEffect } from "react"

import { applyThemeAttributes, type ThemeMode, type ThemePresetId } from "@/theme"
import LabApp from "@/character-editor/lab/LabApp"

export default function CharacterEditorApp() {
  useEffect(() => {
    if (typeof window === "undefined") {
      return
    }
    const params = new URLSearchParams(window.location.search)
    const preset = params.get("theme_preset")
    const mode = params.get("theme_mode")
    const nextPreset: ThemePresetId =
      preset === "studio" || preset === "minimal" || preset === "amoled" ? preset : "familiar"
    const nextMode: ThemeMode = mode === "light" || mode === "dark" || mode === "auto" ? mode : "dark"
    applyThemeAttributes(nextPreset, nextMode)
  }, [])

  return <LabApp />
}
