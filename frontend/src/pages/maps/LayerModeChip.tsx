import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

import type { LayerMode } from "./types";

const MODES: { value: LayerMode; label: string; requiresOnline?: boolean; info?: string }[] = [
  { value: "map",       label: "2D"  },
  { value: "3d",        label: "3D"  },
  { value: "satellite", label: "SAT", requiresOnline: true, info: "Esri ArcGIS Online imagery — online only. Check Esri's terms for commercial use." },
];

export function LayerModeChip({
  mode,
  onChange,
  appMode = 'standard',
  hasNetwork = true,
}: {
  mode: LayerMode;
  onChange: (mode: LayerMode) => void;
  appMode?: 'standard' | 'local';
  hasNetwork?: boolean;
}): JSX.Element {
  return (
    <TooltipProvider>
    <div className="inline-flex rounded-full border border-border/70 bg-background/80 p-1">
      {MODES.map(({ value, label, requiresOnline, info }) => {
        const disabledReason: 'local-mode' | 'no-network' | null =
          !requiresOnline   ? null
          : appMode === 'local' ? 'local-mode'
          : !hasNetwork          ? 'no-network'
          : null;

        const tooltip =
          disabledReason === 'local-mode'  ? 'Not available in local-only mode'
          : disabledReason === 'no-network' ? 'No internet connection'
          : info ?? null;

        const btn = (
          <Button
            key={value}
            size="sm"
            variant={mode === value ? "default" : "ghost"}
            onClick={() => !disabledReason && onChange(value)}
            disabled={!!disabledReason}
          >
            {label}
          </Button>
        );

        return tooltip ? (
          <Tooltip key={value}>
            <TooltipTrigger asChild>{btn}</TooltipTrigger>
            <TooltipContent side="bottom">{tooltip}</TooltipContent>
          </Tooltip>
        ) : btn;
      })}
    </div>
    </TooltipProvider>
  );
}
