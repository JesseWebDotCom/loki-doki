import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/cn";

/** A single settings toggle row - the house convention (AdminAppsTab's "Lock
 *  layout" row): bordered card, no per-row icon (icons are reserved for a
 *  section's own header strip), semibold title + smaller muted description,
 *  switch pinned right. `chip` renders a small badge next to the title (e.g.
 *  the abilities card's "online" tag). */
export function ToggleRow({ title, description, checked, onCheckedChange, disabled, chip, className }: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: () => void;
  disabled?: boolean;
  chip?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-3 rounded-card border border-border/50 bg-background/50 px-4 py-3", className)}>
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <span className="truncate">{title}</span>
          {chip}
        </p>
        <p className="text-[11px] text-muted-foreground">{description}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </div>
  );
}
