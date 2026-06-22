import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog as RadixDialog } from "radix-ui";
import {
  Search,
  Home,
  MessageCircle,
  Sparkles,
  Map,
  Cloud,
  Camera,
  Clapperboard,
  Globe,
  LayoutGrid,
  Lightbulb,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogPortal, DialogOverlay, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { categoryVisual } from "@/lib/archiveCategories";

// ── Types ────────────────────────────────────────────────────────────────────

interface NavItem {
  kind: "nav";
  label: string;
  href: string;
  icon: LucideIcon;
}

interface LibraryItem {
  kind: "library";
  label: string;
  description: string | null;
  category: string;
  sourceId: string;
  faviconUrl: string | null;
}

type SearchResult = NavItem | LibraryItem;

// ── Static nav data ──────────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  { kind: "nav", label: "Home",       href: "/",           icon: Home },
  { kind: "nav", label: "Chat",       href: "/chat",       icon: MessageCircle },
  { kind: "nav", label: "I'm Bored",  href: "/bored",      icon: Lightbulb },
  { kind: "nav", label: "Characters", href: "/characters", icon: Sparkles },
  { kind: "nav", label: "Categories", href: "/categories", icon: LayoutGrid },
  { kind: "nav", label: "Maps",       href: "/maps",       icon: Map },
  { kind: "nav", label: "Weather",    href: "/weather",    icon: Cloud },
  { kind: "nav", label: "Imaging",    href: "/imaging",    icon: Camera },
  { kind: "nav", label: "Video",      href: "/video",      icon: Clapperboard },
  { kind: "nav", label: "Links",      href: "/links",      icon: Globe },
];

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

// ── Result row ───────────────────────────────────────────────────────────────

function NavRow({ item, selected, onSelect, onHover }: {
  item: NavItem;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "flex w-[calc(100%-8px)] mx-1 items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
        selected ? "bg-foreground/8 text-foreground" : "text-foreground/60",
      )}
    >
      <div className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-lg",
        selected ? "bg-foreground/10" : "bg-foreground/5",
      )}>
        <item.icon className="size-3.5" />
      </div>
      {item.label}
    </button>
  );
}

function LibraryRow({ item, selected, onSelect, onHover }: {
  item: LibraryItem;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const visual = categoryVisual(item.category);
  const [faviconOk, setFaviconOk] = useState(true);

  return (
    <button
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "flex w-[calc(100%-8px)] mx-1 items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
        selected ? "bg-foreground/8 text-foreground" : "text-foreground/60",
      )}
    >
      <div
        className="flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-white/10"
        style={{ background: visual.gradient }}
      >
        {item.faviconUrl && faviconOk ? (
          <img
            src={item.faviconUrl}
            className="size-4 object-contain"
            alt=""
            onError={() => setFaviconOk(false)}
          />
        ) : (
          <visual.icon className="size-3.5 text-white" />
        )}
      </div>
      <span className="flex-1 min-w-0 text-left">
        <span className="block truncate">{item.label}</span>
        {item.description && (
          <span className="block truncate text-xs text-foreground/35">{item.description}</span>
        )}
      </span>
      <span
        className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium text-white/80"
        style={{ background: visual.accent + "55" }}
      >
        {item.category}
      </span>
    </button>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SpotlightSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [archives, setArchives] = useState<LibraryItem[]>([]);
  const navigate = useNavigate();

  // Fetch archives once per dialog open
  useEffect(() => {
    if (!open) return;
    fetch("/api/archives/installed", { credentials: "include" })
      .then((r) => r.json())
      .then((d) => {
        setArchives(
          (d.archives ?? []).map((a: Record<string, unknown>) => ({
            kind: "library" as const,
            label: a.label as string,
            description: (a.description as string | null) ?? null,
            category: a.category as string,
            sourceId: a.sourceId as string,
            faviconUrl: (a.faviconUrl as string | null) ?? null,
          }))
        );
      })
      .catch(() => {});
  }, [open]);

  const q = query.trim().toLowerCase();

  const filteredNav = q === ""
    ? NAV_ITEMS
    : NAV_ITEMS.filter((item) => item.label.toLowerCase().includes(q));

  const filteredLibraries = q === ""
    ? []
    : archives
        .filter((a) =>
          a.label.toLowerCase().includes(q) ||
          a.category.toLowerCase().includes(q) ||
          (a.description?.toLowerCase().includes(q) ?? false)
        )
        .slice(0, 8);

  const allResults: SearchResult[] = [...filteredNav, ...filteredLibraries];
  const isEmpty = allResults.length === 0;

  // Keyboard global toggle
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    };
    document.addEventListener("keydown", down);
    return () => document.removeEventListener("keydown", down);
  }, []);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const select = useCallback(
    (item: SearchResult) => {
      if (item.kind === "nav") navigate(item.href);
      else navigate(`/read/${item.sourceId}`);
      setOpen(false);
    },
    [navigate]
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-muted-foreground hover:bg-foreground/5 hover:text-foreground transition-colors cursor-pointer">
          <Search className="size-4 shrink-0" />
          <span className="flex-1 text-sm select-none">Search</span>
          <kbd className="inline-flex items-center gap-0.5 rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/25 leading-none">
            {isMac ? "⌘" : "Ctrl"}&thinsp;K
          </kbd>
        </button>
      </DialogTrigger>

      <DialogPortal>
        <DialogOverlay />
        <RadixDialog.Content
          className={cn(
            "fixed left-1/2 top-[22%] z-50 w-full max-w-[480px] -translate-x-1/2",
            "rounded-2xl border border-border bg-background shadow-2xl overflow-hidden",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
          )}
        >
          {/* Search input */}
          <div className="flex items-center gap-3 border-b border-border/50 px-4 py-3.5">
            <Search className="size-4 shrink-0 text-foreground/40" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSelectedIndex((i) => Math.min(i + 1, allResults.length - 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelectedIndex((i) => Math.max(i - 1, 0));
                } else if (e.key === "Enter" && allResults[selectedIndex]) {
                  select(allResults[selectedIndex]);
                }
              }}
              placeholder="Search apps and libraries..."
              className="flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-foreground/30"
            />
            <kbd className="inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground/25 leading-none">
              esc
            </kbd>
          </div>

          {/* Results */}
          <div className="py-1.5 max-h-[360px] overflow-y-auto">
            {isEmpty ? (
              <p className="px-4 py-8 text-center text-sm text-foreground/30">
                No results for &ldquo;{query}&rdquo;
              </p>
            ) : (
              <>
                {/* Apps section */}
                {filteredNav.length > 0 && (
                  <>
                    <p className="px-4 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wider text-foreground/25">
                      Apps
                    </p>
                    {filteredNav.map((item, i) => (
                      <NavRow
                        key={item.href}
                        item={item}
                        selected={i === selectedIndex}
                        onSelect={() => select(item)}
                        onHover={() => setSelectedIndex(i)}
                      />
                    ))}
                  </>
                )}

                {/* Libraries section */}
                {filteredLibraries.length > 0 && (
                  <>
                    <p className={cn(
                      "px-4 pb-1 text-[11px] font-medium uppercase tracking-wider text-foreground/25",
                      filteredNav.length > 0 ? "pt-3" : "pt-2",
                    )}>
                      Libraries
                    </p>
                    {filteredLibraries.map((item, i) => {
                      const idx = filteredNav.length + i;
                      return (
                        <LibraryRow
                          key={item.sourceId}
                          item={item}
                          selected={idx === selectedIndex}
                          onSelect={() => select(item)}
                          onHover={() => setSelectedIndex(idx)}
                        />
                      );
                    })}
                  </>
                )}
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center gap-3 border-t border-border/30 px-4 py-2">
            <span className="text-[11px] text-foreground/20">
              <kbd className="font-mono">↑↓</kbd> navigate &nbsp;
              <kbd className="font-mono">↵</kbd> open &nbsp;
              <kbd className="font-mono">esc</kbd> close
            </span>
          </div>
        </RadixDialog.Content>
      </DialogPortal>
    </Dialog>
  );
}
