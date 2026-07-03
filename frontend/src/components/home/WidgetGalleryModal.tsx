import { Plus } from "lucide-react";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { HOME_WIDGETS, type WidgetMeta } from "@/lib/homeWidgets";
import { cn } from "@/lib/cn";

interface Props {
  /** Canonical ids already on the canvas - hidden from the gallery. */
  usedIds: Set<string>;
  /** Optional gate (e.g. underlying tool enabled). Defaults to always available. */
  isAvailable?: (w: WidgetMeta) => boolean;
  onPick: (id: string) => void;
  onClose: () => void;
}

/**
 * iOS-style widget gallery. Lists real widgets only (from HOME_WIDGETS), each
 * with its own icon tile, title and description. Tap to add.
 */
export function WidgetGalleryModal({ usedIds, isAvailable, onPick, onClose }: Props) {
  const items = HOME_WIDGETS
    .filter(w => !usedIds.has(w.id))
    .filter(w => (isAvailable ? isAvailable(w) : true));

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border/40 px-4 py-3 text-left">
          <DialogTitle className="text-base">Add Widget</DialogTitle>
          <DialogDescription className="text-caption">
            Tap a widget to add it to your home
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto p-2">
          {items.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-muted-foreground/60">
              Every widget is already on your home.
            </p>
          ) : (
            <div className="space-y-1">
              {items.map(w => {
                const Icon = w.icon;
                const soon = w.comingSoon;
                return (
                  <button
                    key={w.id}
                    disabled={soon}
                    onClick={() => { if (!soon) { onPick(w.id); onClose(); } }}
                    className={cn(
                      "w-full flex items-center gap-3 rounded-control p-2.5 text-left transition-all",
                      soon ? "opacity-50 cursor-default" : "hover:bg-accent/50 active:scale-[0.99]",
                    )}
                  >
                    <span
                      className="flex size-11 shrink-0 items-center justify-center rounded-card shadow-inner"
                      style={{ background: w.gradient }}
                    >
                      <Icon className="size-5 text-white" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-semibold text-foreground/90">{w.title}</span>
                        {soon ? (
                          <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground/60">Soon</span>
                        ) : w.allowWide ? (
                          <span className="rounded-full bg-muted px-1.5 py-px text-[9px] font-medium text-muted-foreground/55">resizable</span>
                        ) : null}
                      </div>
                      <p className="text-[11px] text-muted-foreground/60 leading-snug truncate">{w.description}</p>
                    </div>
                    {!soon && <Plus className="size-4 text-muted-foreground/40 shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
