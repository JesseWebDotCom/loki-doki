import React from "react";
import { ExternalLink, FileCode2 } from "lucide-react";

import type { Block } from "../../../lib/response-types";
import { Card, CardContent, CardHeader } from "../../ui/card";
import { Button } from "../../ui/button";
import BlockShell from "./BlockShell";
import { useBlockContext } from ".";

type PreviewItem = {
  artifact_id?: string;
  title?: string;
  kind?: string;
  version?: number;
  preview_text?: string;
};

const ArtifactPreviewBlock: React.FC<{ block: Block }> = ({ block }) => {
  const { artifactSurface, onOpenArtifact } = useBlockContext();
  const preview = (((block.items as unknown[]) ?? [])[0] ?? {}) as PreviewItem;
  const title = preview.title ?? artifactSurface?.title ?? "Artifact";
  const kind = (preview.kind ?? artifactSurface?.kind ?? "html").toUpperCase();
  const version = preview.version ?? artifactSurface?.selected_version;
  const snippet = (preview.preview_text ?? "").trim();

  return (
    <BlockShell block={block}>
      <Card
        data-slot="artifact-preview-block"
        className="mt-4 border-border/50 bg-card/60 shadow-m2"
      >
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.22em] text-primary/80">
                <FileCode2 size={14} />
                <span>{kind}</span>
                {version ? <span>v{version}</span> : null}
              </div>
              <div className="mt-1 text-base font-semibold text-foreground">
                {title}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onOpenArtifact?.()}
              aria-label="Open artifact"
              className="shrink-0"
            >
              <ExternalLink size={14} className="mr-2" />
              Open
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <div
            data-slot="artifact-preview-text"
            className="rounded-xl border border-border/40 bg-muted/30 p-3 font-mono text-xs leading-6 text-muted-foreground"
          >
            {snippet || "Preview available in the artifact surface."}
          </div>
        </CardContent>
      </Card>
    </BlockShell>
  );
};

export default ArtifactPreviewBlock;
