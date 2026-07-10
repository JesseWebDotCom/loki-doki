import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, ChevronLeft, ExternalLink, Search, Settings, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";
import { AppIconTile } from "@/components/shared/AppIconTile";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useSpotlight } from "@/components/shared/SpotlightSearch";
import type { AppHeaderConfig } from "@/context/BreadcrumbSearchContext";

// The phone-only replacement for the breadcrumb. Instead of the full Home / Group / App
// crumb chain plus an inline search field (which crowds a narrow screen), it shows just the
// app identity + the contextual actions the page published via useAppHeader: a Search button
// that opens Spotlight, the app's toggle slots, and the settings / external-link buttons. When
// the page is a layout app that publishes a rail, the title becomes a chevron button that opens
// that rail in a left drawer (the desktop rail has no room on mobile).
export function MobileTopBar({
  title,
  icon,
  gradient,
  color,
  onReload,
  config,
}: {
  title: string;
  icon: LucideIcon | null;
  gradient?: string;
  color?: string;
  onReload: () => void;
  config: AppHeaderConfig | null;
}) {
  const { openSpotlight } = useSpotlight();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [railOpen, setRailOpen] = useState(false);
  const hasRail = !!config?.rail;

  // Picking a rail item navigates but doesn't dismiss the drawer on its own, close it
  // whenever the route changes so the content is visible right away.
  useEffect(() => {
    setRailOpen(false);
  }, [pathname]);

  const Icon = icon;
  const Identity = (
    <>
      {Icon &&
        (gradient ? (
          <AppIconTile icon={Icon} gradient={gradient} size="md" />
        ) : (
          <Icon className="size-5" style={color ? { color } : undefined} />
        ))}
      <span className="truncate text-sm font-semibold">{title}</span>
      {hasRail && <ChevronDown className="size-4 shrink-0 text-muted-foreground" />}
    </>
  );

  return (
    <div className="md:hidden shrink-0 glass-chrome border-b border-border/50">
      <div className="flex h-12 items-center gap-2 px-3">
        {/* Back: installed PWAs have no browser chrome, so this is the only history
            affordance on a phone (Mobile Design Contract). idx is React Router's
            position in the session history; 0 means there is nothing to go back to.
            pathname is read above, so a navigation re-renders and re-reads it. */}
        {(window.history.state?.idx ?? 0) > 0 && (
          <Button
            variant="ghost"
            size="icon"
            className="-ml-1 size-10 shrink-0"
            aria-label="Back"
            onClick={() => navigate(-1)}
          >
            <ChevronLeft className="size-5" />
          </Button>
        )}
        {/* App identity, opens the rail drawer for layout apps, else reloads the app */}
        <button
          type="button"
          onClick={hasRail ? () => setRailOpen(true) : onReload}
          className="flex min-w-0 items-center gap-2 rounded-control py-1 pr-1 text-left"
        >
          {Identity}
        </button>

        <div className="flex-1" />

        {/* Contextual actions the page published */}
        {config?.leftSlot}
        {config?.rightSlot}

        <Button variant="ghost" size="icon" className="size-10 shrink-0" aria-label="Search" onClick={openSpotlight}>
          <Search className="size-4" />
        </Button>

        {config?.settingsHref && (
          <Button
            variant="ghost"
            size="icon"
            className="size-10 shrink-0"
            aria-label="Settings"
            onClick={() => navigate(config.settingsHref!)}
          >
            <Settings className="size-4" />
          </Button>
        )}
        {config?.externalHref && (
          <a href={config.externalHref} target="_blank" rel="noopener noreferrer" aria-label="Open website">
            <Button variant="ghost" size="icon" className="size-10 shrink-0" asChild>
              <span>
                <ExternalLink className="size-4" />
              </span>
            </Button>
          </a>
        )}
      </div>

      {/* Rail drawer (layout apps only) */}
      {hasRail && (
        <Sheet open={railOpen} onOpenChange={setRailOpen}>
          <SheetContent side="left" className="w-72 max-w-[85vw] gap-0 p-0">
            <SheetTitle className="sr-only">{title} navigation</SheetTitle>
            <div className={cn("flex min-h-0 flex-1 flex-col overflow-y-auto")}>{config?.rail}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
