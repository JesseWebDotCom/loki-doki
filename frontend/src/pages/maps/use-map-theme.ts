import { useEffect, useState } from "react";
import { useMapPrefs } from "./use-map-prefs";

/**
 * Resolve the map's light/dark theme.
 *
 * The map honours the user's explicit map preference (`autoDarkMode`) and
 * otherwise follows the app's effective theme, read from the
 * `data-theme` attribute on <html> (v3's theming strategy — see index.html).
 */
function detectAppTheme(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function useMapTheme(): { theme: "light" | "dark" } {
  const { prefs } = useMapPrefs();
  const [appTheme, setAppTheme] = useState<"light" | "dark">(detectAppTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setAppTheme(detectAppTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  if (prefs.autoDarkMode === "light") return { theme: "light" };
  if (prefs.autoDarkMode === "dark") return { theme: "dark" };
  return { theme: appTheme };
}
