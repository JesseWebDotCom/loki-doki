import { Link, useLocation } from "react-router-dom";
import { GripVertical, StarOff } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { cn } from "@/lib/cn";
import { StatusDot } from "@/components/shared/StatusDot";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface SortableNavItemProps {
  id: string;
  label: string;
  href: string;
  /** Lucide icon for built-in apps. Ignored if `iconNode` is provided. */
  icon?: LucideIcon;
  /** Custom icon node (e.g. an archive favicon) that overrides `icon`. */
  iconNode?: ReactNode;
  onUnpin: (id: string) => void;
  badge?: 'busy' | 'done' | null;
  /** Warm this app's data on hover/focus (intent prefetch). */
  onIntent?: () => void;
}

export function SortableNavItem({ id, label, href, icon: Icon, iconNode, onUnpin, badge, onIntent }: SortableNavItemProps) {
  const { pathname } = useLocation();
  const active = pathname === href || pathname.startsWith(href + "/");

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.4 : 1 }}
      className="relative flex group/item w-full items-center py-0.5"
    >
      {/* Drag handle */}
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag to reorder"
        className={cn(
          "shrink-0 p-1 rounded-full opacity-0 group-hover/item:opacity-100 cursor-grab active:cursor-grabbing",
          "text-muted-foreground/50 hover:text-muted-foreground transition-opacity",
          "focus-visible:opacity-100 focus-visible:outline-none",
        )}
      >
        <GripVertical className="size-3" aria-hidden="true" />
      </button>

      {/* Link */}
      <Link
        to={href}
        onPointerEnter={onIntent}
        onFocus={onIntent}
        className={cn(
          "flex flex-1 items-center gap-3 rounded-control px-2 py-2 text-sm transition-colors",
          active
            ? "bg-brand/10 text-brand font-medium"
            : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
        )}
      >
        <span className="flex shrink-0 items-center justify-center">
          {iconNode ?? (Icon ? <Icon className="size-4" /> : null)}
        </span>
        <span className="flex-1 truncate">{label}</span>
        {badge && (
          <StatusDot status={badge === 'busy' ? 'info' : 'ok'} pulse={badge === 'busy'} />
        )}
      </Link>

      {/* Remove-from-favorites button */}
      <button
        type="button"
        onClick={() => onUnpin(id)}
        aria-label={`Remove ${label} from favorites`}
        className={cn(
          "shrink-0 p-1 rounded-full opacity-0 group-hover/item:opacity-100",
          "text-muted-foreground hover:text-foreground transition-opacity",
          "focus-visible:opacity-100 focus-visible:outline-none",
        )}
      >
        <StarOff className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}
