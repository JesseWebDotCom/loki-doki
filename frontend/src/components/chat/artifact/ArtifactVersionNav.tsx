import { ChevronLeft, ChevronRight, History } from "lucide-react";

import type { ArtifactVersion } from "@/lib/response-types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ArtifactVersionNavProps {
  versions: ArtifactVersion[];
  selectedVersion: number;
  onSelectVersion: (version: number) => void;
}

export default function ArtifactVersionNav({
  versions,
  selectedVersion,
  onSelectVersion,
}: ArtifactVersionNavProps) {
  const index = Math.max(
    0,
    versions.findIndex((version) => version.version === selectedVersion),
  );
  const total = versions.length;
  const canGoPrev = index > 0;
  const canGoNext = index < total - 1;
  const latest = versions[total - 1]?.version ?? selectedVersion;

  return (
    <div className="flex items-center gap-1.5">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => {
          if (canGoPrev) onSelectVersion(versions[index - 1].version);
        }}
        disabled={!canGoPrev}
        aria-label="Previous version"
      >
        <ChevronLeft size={16} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-w-[7rem]"
          >
            <History size={14} className="mr-2" />
            {`v${selectedVersion} of ${total}`}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="center">
          {versions.map((version) => (
            <DropdownMenuItem
              key={version.version}
              onSelect={() => onSelectVersion(version.version)}
            >
              {`Version ${version.version}`}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => onSelectVersion(latest)}
      >
        Latest
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => {
          if (canGoNext) onSelectVersion(versions[index + 1].version);
        }}
        disabled={!canGoNext}
        aria-label="Next version"
      >
        <ChevronRight size={16} />
      </Button>
    </div>
  );
}
