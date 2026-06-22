import { CompassIcon, MapPinIcon, RouteIcon, SearchIcon, Settings2Icon } from "lucide-react";
import type { ElementType } from "react";

import { cn } from "@/lib/cn";

import type { PanelKind } from "./types";

const NAV_ITEMS: { id: PanelKind; label: string; Icon: ElementType<{ className?: string }>; color: string }[] = [
  { id: null, label: "Search", Icon: SearchIcon, color: "#007AFF" },
  { id: "directions", label: "Directions", Icon: RouteIcon, color: "#34C759" },
  { id: "pins", label: "Pins", Icon: MapPinIcon, color: "#FF3B30" },
  { id: "guides", label: "Guides", Icon: CompassIcon, color: "#AF52DE" },
  { id: "settings", label: "Settings", Icon: Settings2Icon, color: "#8E8E93" },
];

export function LeftRail({
  activePanel,
  onPanelChange,
  theme = "dark",
}: {
  activePanel: PanelKind;
  onPanelChange: (panel: PanelKind) => void;
  theme?: "light" | "dark";
}): JSX.Element {
  return (
    <aside
      aria-label="Maps sections"
      style={{ backgroundColor: theme === "light" ? "#b5dcfb" : "#0a2745" }}
      className="flex w-full shrink-0 flex-row border-b border-border/20 md:h-full md:w-16 md:flex-col md:border-b-0 md:border-r"
    >
      <h1 className="sr-only">Maps</h1>
      <nav aria-label="Maps tools" className="flex w-full flex-row md:flex-col md:py-2">
        {NAV_ITEMS.map(({ id, label, Icon, color }) => {
          const active = activePanel === id;
          return (
            <button
              key={id ?? "search"}
              type="button"
              aria-pressed={active}
              onClick={() => onPanelChange(id)}
              title={label}
              className={cn(
                "flex flex-1 flex-col items-center justify-center gap-1 py-3 text-[10px] font-medium leading-none transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:flex-none md:w-full md:py-2.5",
                active
                  ? "text-white"
                  : theme === "light" ? "text-sky-900/70 hover:text-sky-900" : "text-sky-100/60 hover:text-sky-100",
              )}
            >
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-xl transition-all",
                  active ? "scale-105 shadow-md" : "opacity-80 hover:opacity-100",
                )}
                style={{ backgroundColor: color }}
              >
                <Icon className="size-5 text-white" />
              </span>
              {label}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
