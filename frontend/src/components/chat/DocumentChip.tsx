import React from "react";
import { FileText } from "lucide-react";

import Badge from "../ui/Badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../ui/tooltip";
import { cn } from "../../lib/utils";
import type { DocumentMode } from "../../lib/response-types";

interface DocumentChipProps {
  mode: DocumentMode;
  className?: string;
}

/**
 * Document-mode chip.
 *
 * Mounted at the top of an assistant message shell when
 * ``envelope.document_mode`` is set (chunk 17). The label tells the
 * user which adaptive-document path ran for their attachment:
 *
 *   * ``inline`` — the full document fit inside half the model's
 *     context window and was pasted verbatim into the synthesis
 *     prompt.
 *   * ``retrieval`` — the document was too large to fit, so BM25
 *     selected the top-K chunks relevant to the query.
 *
 * Offline-safe: the lucide ``FileText`` icon + local Onyx-Material
 * ``Badge`` / ``Tooltip`` primitives. No remote fonts or CDN assets.
 */
const DocumentChip: React.FC<DocumentChipProps> = ({ mode, className }) => {
  const label = mode === "inline" ? "Reading full document" : "Searching document";
  const tooltip =
    mode === "inline"
      ? "The full document fit inside the model's context window and was read verbatim."
      : "The document was too large to read whole, so relevant passages were retrieved locally.";

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            data-slot="document-chip"
            data-document-mode={mode}
            className={cn(
              "mb-2 inline-flex items-center gap-1.5 text-muted-foreground",
              className,
            )}
            role="status"
            aria-label={`Document mode: ${label}`}
          >
            <Badge
              variant="outline"
              className="gap-1.5 border-border/50 bg-muted/30 px-2 py-1 text-muted-foreground"
            >
              <FileText size={11} aria-hidden="true" />
              <span>{label}</span>
            </Badge>
          </div>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default DocumentChip;
