import { Globe, LocateFixed } from "lucide-react";
import { cn } from "@/lib/cn";

export function MapControls({
  bearing,
  onZoomIn,
  onZoomOut,
  onResetNorth,
  onLocate,
  onGlobe,
  locateActive = false,
}: {
  bearing: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetNorth: () => void;
  onLocate?: () => void;
  onGlobe?: () => void;
  locateActive?: boolean;
}): JSX.Element {
  const showCompass = Math.abs(bearing) > 1;
  return (
    <div className="absolute bottom-6 right-3 z-20 flex flex-col items-center gap-2">
      {onGlobe ? (
        <button
          type="button"
          onClick={onGlobe}
          aria-label="Globe view"
          title="Globe view"
          className="flex h-10 w-10 items-center justify-center rounded-full border border-border/40 bg-background/90 shadow-md transition-colors hover:bg-accent"
        >
          <Globe className="size-5" />
        </button>
      ) : null}
      <button
        type="button"
        onClick={onResetNorth}
        aria-label="Reset to north"
        title="Reset to north"
        className={cn(
          "flex h-10 w-10 items-center justify-center rounded-full border border-border/40 bg-background/90 shadow-md text-sm transition-all hover:bg-accent",
          showCompass ? "opacity-100" : "opacity-0 pointer-events-none",
        )}
      >
        <span
          className="inline-block text-base leading-none"
          style={{ transform: `rotate(${-bearing}deg)` }}
          aria-hidden="true"
        >
          ↑
        </span>
      </button>
      {onLocate ? (
        <button
          type="button"
          onClick={onLocate}
          aria-label="Show my location"
          title="Show my location"
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-full border border-border/40 bg-background/90 shadow-md transition-colors hover:bg-accent",
            locateActive && "text-violet-500",
          )}
        >
          <LocateFixed className="size-5" />
        </button>
      ) : null}
      <div className="flex flex-col overflow-hidden rounded-xl border border-border/40 bg-background/90 shadow-md">
        <button
          type="button"
          onClick={onZoomIn}
          aria-label="Zoom in"
          className="flex h-10 w-10 items-center justify-center text-xl font-light hover:bg-accent transition-colors"
        >
          +
        </button>
        <div className="h-px mx-2 bg-border/40" />
        <button
          type="button"
          onClick={onZoomOut}
          aria-label="Zoom out"
          className="flex h-10 w-10 items-center justify-center text-xl font-light hover:bg-accent transition-colors"
        >
          −
        </button>
      </div>
    </div>
  );
}
