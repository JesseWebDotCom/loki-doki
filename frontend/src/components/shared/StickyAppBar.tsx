import { useEffect, useState } from "react";
import { type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { ChromeWash } from "./ChromeWash";

export interface AppBarAction {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  iconClassName?: string;
}

interface StickyAppBarProps {
  name: string;
  gradient: string;
  icon: LucideIcon;
  actions?: AppBarAction[];
}

export function StickyAppBar({ name, gradient, icon: Icon, actions = [] }: StickyAppBarProps) {
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    const scroller = document.getElementById("main-scroll");
    if (!scroller) return;
    const handler = () => setPinned(scroller.scrollTop > 80);
    scroller.addEventListener("scroll", handler, { passive: true });
    return () => scroller.removeEventListener("scroll", handler);
  }, []);

  return (
    <div className="sticky top-0 z-20 h-0 overflow-visible">
      <div
        className={cn(
          "transition-all duration-200",
          pinned ? "opacity-100 translate-y-0" : "opacity-0 -translate-y-1 pointer-events-none",
        )}
      >
        <div className="relative flex items-center gap-3 border-b border-border/40 bg-background/70 px-6 py-3 backdrop-blur-md">
        <ChromeWash />
        <div
          className="flex size-7 shrink-0 items-center justify-center rounded-lg"
          style={{ background: gradient }}
        >
          <Icon className="size-3.5 text-white" />
        </div>
        <span className="flex-1 text-sm font-semibold">{name}</span>
        {actions.map(({ icon: ActionIcon, label, onClick, iconClassName }) => (
          <button
            key={label}
            onClick={onClick}
            aria-label={label}
            className="flex size-8 items-center justify-center rounded-xl bg-foreground/5 text-foreground/60 transition-colors hover:bg-foreground/10 hover:text-foreground active:scale-95"
          >
            <ActionIcon className={cn('size-4', iconClassName)} />
          </button>
        ))}
        </div>
      </div>
    </div>
  );
}
