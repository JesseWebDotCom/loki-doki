import React from "react";
import { WifiOff } from "lucide-react";

import Badge from "../ui/Badge";
import { cn } from "../../lib/utils";

interface OfflineTrustChipProps {
  className?: string;
}

/**
 * Offline trust chip.
 *
 * Mounted at the top of an assistant message shell when
 * ``envelope.offline_degraded`` is ``true`` (see chunk 11). The chip
 * tells the user the response came from local knowledge because at
 * least one network-dependent skill failed this turn — they should
 * trust-but-verify if the question depends on fresh data.
 *
 * Style: muted Onyx Material ``outline`` ``Badge`` + lucide
 * ``WifiOff`` icon. Purely presentational — there's no click behavior
 * (the chip is a trust signal, not a control).
 */
const OfflineTrustChip: React.FC<OfflineTrustChipProps> = ({ className }) => {
  return (
    <div
      data-slot="offline-trust-chip"
      className={cn(
        "mb-2 inline-flex items-center gap-1.5 text-muted-foreground",
        className,
      )}
      role="status"
      aria-label="Offline response — used local knowledge because the network was unreachable"
    >
      <Badge
        variant="outline"
        className="gap-1.5 border-border/50 bg-muted/30 px-2 py-1 text-muted-foreground"
      >
        <WifiOff size={11} aria-hidden="true" />
        <span>Offline — using local knowledge</span>
      </Badge>
    </div>
  );
};

export default OfflineTrustChip;
