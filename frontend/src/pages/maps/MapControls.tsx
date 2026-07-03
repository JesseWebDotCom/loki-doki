import { Globe, LocateFixed } from "lucide-react";
import { Button } from "@/components/ui/button";
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
        <Button
          type="button"
          variant="outline"
          onClick={onGlobe}
          aria-label="Globe view"
          title="Globe view"
          className="h-10 w-10 p-0 border-border/40 bg-background/90 shadow-md"
        >
          <Globe className="size-5" />
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        onClick={onResetNorth}
        aria-label="Reset to north"
        title="Reset to north"
        className={cn(
          "h-10 w-10 p-0 border-border/40 bg-background/90 shadow-md text-sm",
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
      </Button>
      {onLocate ? (
        <Button
          type="button"
          variant="outline"
          onClick={onLocate}
          aria-label="Show my location"
          title="Show my location"
          className={cn(
            "h-10 w-10 p-0 border-border/40 bg-background/90 shadow-md",
            locateActive && "text-brand",
          )}
        >
          <LocateFixed className="size-5" />
        </Button>
      ) : null}
      <div className="flex flex-col overflow-hidden rounded-control border border-border/40 bg-background/90 shadow-md">
        <Button
          type="button"
          variant="ghost"
          onClick={onZoomIn}
          aria-label="Zoom in"
          className="h-10 w-10 rounded-none p-0 text-xl font-light"
        >
          +
        </Button>
        <div className="h-px mx-2 bg-border/40" />
        <Button
          type="button"
          variant="ghost"
          onClick={onZoomOut}
          aria-label="Zoom out"
          className="h-10 w-10 rounded-none p-0 text-xl font-light"
        >
          −
        </Button>
      </div>
    </div>
  );
}
