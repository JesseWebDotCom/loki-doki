import { useEffect, useMemo, useState } from "react";
import { Box, RotateCcw } from "lucide-react";

import type {
  ArtifactSurfaceData,
  ArtifactVersion,
} from "@/lib/response-types";
import { Button } from "@/components/ui/button";
import ConfirmDialog from "@/components/ui/ConfirmDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";

import ArtifactExportMenu from "./ArtifactExportMenu";
import ArtifactVersionNav from "./ArtifactVersionNav";
import SandboxedFrame from "./SandboxedFrame";

interface ArtifactSurfaceProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifact: ArtifactSurfaceData;
}

function useWideViewport(minWidth = 1280): boolean {
  const query = `(min-width: ${minWidth}px)`;
  const getMatch = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : true;

  const [isWide, setIsWide] = useState(getMatch);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const media = window.matchMedia(query);
    const update = () => setIsWide(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, [query]);

  return isWide;
}

function cloneVersions(versions: ArtifactVersion[]): ArtifactVersion[] {
  return versions.map((version) => ({ ...version }));
}

export default function ArtifactSurface({
  open,
  onOpenChange,
  artifact,
}: ArtifactSurfaceProps) {
  const isWide = useWideViewport();
  const [versions, setVersions] = useState<ArtifactVersion[]>(
    cloneVersions(artifact.versions),
  );
  const [selectedVersion, setSelectedVersion] = useState(artifact.selected_version);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setVersions(cloneVersions(artifact.versions));
    setSelectedVersion(artifact.selected_version);
  }, [artifact]);

  const currentVersion = useMemo(
    () =>
      versions.find((version) => version.version === selectedVersion) ??
      versions[versions.length - 1],
    [selectedVersion, versions],
  );

  if (!currentVersion) {
    return null;
  }

  const chrome = (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Box size={15} />
            <span className="text-xs font-bold uppercase tracking-[0.22em]">
              Artifact Surface
            </span>
          </div>
          <div className="mt-1 text-lg font-semibold text-foreground">
            {artifact.title}
          </div>
          <div className="text-sm text-muted-foreground">
            {artifact.kind.toUpperCase()} rendered sandboxed and offline
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ArtifactVersionNav
            versions={versions}
            selectedVersion={currentVersion.version}
            onSelectVersion={setSelectedVersion}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-11 rounded-2xl px-4"
            onClick={() => setConfirmOpen(true)}
            aria-label="Revert to this version"
          >
            <RotateCcw size={14} className="mr-2" />
            Revert
          </Button>
          <ArtifactExportMenu
            title={artifact.title}
            kind={artifact.kind}
            content={currentVersion.content}
          />
        </div>
      </div>
      <div className="mt-4">
        <SandboxedFrame title={artifact.title} content={currentVersion.content} />
      </div>
      <div className="border-t border-border/40 pt-3 text-xs text-muted-foreground">
        Runs sandboxed and offline.
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Revert to this version?"
        description="LokiDoki preserves history by creating a new version with this content."
        confirmLabel="Revert"
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => {
          const nextVersion = (versions[versions.length - 1]?.version ?? 0) + 1;
          const reverted: ArtifactVersion = {
            ...currentVersion,
            version: nextVersion,
          };
          const nextVersions = [...versions, reverted];
          setVersions(nextVersions);
          setSelectedVersion(nextVersion);
          setConfirmOpen(false);
        }}
      />
    </>
  );

  if (isWide) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
          side="right"
          className="flex w-full flex-col p-0 sm:w-[680px] lg:w-[820px] lg:max-w-[820px]"
          data-slot="artifact-surface-sheet"
        >
          <SheetHeader>
            <SheetTitle>{artifact.title}</SheetTitle>
            <SheetDescription>
              Inspect and export artifact versions without leaving the chat.
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 py-5">{chrome}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[90vh] max-w-[95vw] overflow-y-auto rounded-[2rem] p-0 sm:max-w-3xl"
        data-slot="artifact-surface-dialog"
      >
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>{artifact.title}</DialogTitle>
          <DialogDescription>
            Inspect and export artifact versions without leaving the chat.
          </DialogDescription>
        </DialogHeader>
        <div className="px-6 pb-6">{chrome}</div>
      </DialogContent>
    </Dialog>
  );
}
