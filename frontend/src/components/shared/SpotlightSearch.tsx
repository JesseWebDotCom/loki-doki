import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog as RadixDialog } from "radix-ui";
import {
  Search,
  Home,
  Sparkles,
  BookOpen,
  Package,
  Play,
  Newspaper,
  Mic,
  type LucideIcon,
} from "lucide-react";
import { Dialog, DialogPortal, DialogOverlay, DialogTrigger } from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { categoryVisual } from "@/lib/archiveCategories";
import { APP_GROUPS } from "@/lib/appCategories";

// ── Types ────────────────────────────────────────────────────────────────────

interface NavItem {
  kind: "nav";
  label: string;
  href: string;
  icon: LucideIcon;
  description?: string;
  gradient?: string;
}

interface LibraryItem {
  kind: "library";
  label: string;
  description: string | null;
  category: string;
  sourceId: string;
  faviconUrl: string | null;
}

// Mirrors backend SearchHit (routes/search.ts).
interface ContentHit {
  kind: "content";
  type: "bookmark" | "news" | "companion" | "device" | "youtube" | "podcast";
  id: string;
  title: string;
  subtitle: string | null;
  icon: string | null;
  route: string;
  group: string;
}

type SearchResult = NavItem | LibraryItem | ContentHit;

// ── Static nav data ──────────────────────────────────────────────────────────
//
// The app list is derived from the canonical APP_GROUPS registry so every app is launchable
// (the old hardcoded list of 10 missed News, YouTube, Home Inventory, Reader, and more). A few
// destinations that live outside the category grid are prepended by hand.

const EXTRA_NAV: NavItem[] = [
  { kind: "nav", label: "Home",       href: "/",           icon: Home,     description: "Your dashboard", gradient: "linear-gradient(135deg,#1e293b,#475569)" },
  { kind: "nav", label: "Companions", href: "/companions", icon: Sparkles, description: "Browse AI companions", gradient: "linear-gradient(135deg,#3a0a72,#db2777)" },
];

const NAV_ITEMS: NavItem[] = [
  ...EXTRA_NAV,
  ...APP_GROUPS.flatMap((g) =>
    g.apps.map((a): NavItem => ({
      kind: "nav",
      label: a.label,
      href: a.to,
      icon: a.icon,
      description: a.description,
      gradient: a.gradient,
    })),
  ),
];

// Fallback glyph per content type when a hit has no image icon.
const CONTENT_ICON: Record<ContentHit["type"], LucideIcon> = {
  news: Newspaper,
  bookmark: BookOpen,
  companion: Sparkles,
  device: Package,
  youtube: Play,
  podcast: Mic,
};

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

// ── Result rows ──────────────────────────────────────────────────────────────

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
      <div
        className="flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-white/10"
        style={item.gradient ? { background: item.gradient } : undefined}
      >
        <item.icon className={cn("size-3.5", item.gradient && "text-white")} />
      </div>
      <span className="flex-1 min-w-0 text-left">
        <span className="block truncate">{item.label}</span>
        {item.description && (
          <span className="block truncate text-xs text-foreground/35">{item.description}</span>
        )}
      </span>
    </button>
  );
}

function ContentRow({ item, selected, onSelect, onHover }: {
  item: ContentHit;
  selected: boolean;
  onSelect: () => void;
  onHover: () => void;
}) {
  const [iconOk, setIconOk] = useState(true);
  const Fallback = CONTENT_ICON[item.type];

  return (
    <button
      onClick={onSelect}
      onMouseEnter={onHover}
      className={cn(
        "flex w-[calc(100%-8px)] mx-1 items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
        selected ? "bg-foreground/8 text-foreground" : "text-foreground/60",
      )}
    >
      <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/5 overflow-hidden">
        {item.icon && iconOk ? (
          <img
            src={item.icon}
            className="size-4 object-contain"
            alt=""
            onError={() => setIconOk(false)}
          />
        ) : (
          <Fallback className="size-3.5" />
        )}
      </div>
      <span className="flex-1 min-w-0 text-left">
        <span className="block truncate">{item.title}</span>
        {item.subtitle && (
          <span className="block truncate text-xs text-foreground/35">{item.subtitle}</span>
        )}
      </span>
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
  const [content, setContent] = useState<ContentHit[]>([]);
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

  // Debounced content search across the user's saved items (Reader, links, companions, home
  // inventory, YouTube). An aborter cancels the in-flight request whenever the query changes.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    if (q.length < 2) {
      setContent([]);
      abortRef.current?.abort();
      return;
    }
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    const t = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}`, { credentials: "include", signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => {
          setContent(
            (d.hits ?? []).map((h: Record<string, unknown>) => ({ kind: "content" as const, ...h }))
          );
        })
        .catch(() => {});
    }, 180);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

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

  // Group content hits by their backend `group`, preserving first-seen (provider) order.
  const contentGroups: { group: string; hits: ContentHit[] }[] = [];
  for (const hit of content) {
    let g = contentGroups.find((x) => x.group === hit.group);
    if (!g) { g = { group: hit.group, hits: [] }; contentGroups.push(g); }
    g.hits.push(hit);
  }

  // Flat list drives keyboard navigation; section render walks the same order.
  const allResults: SearchResult[] = [
    ...filteredNav,
    ...contentGroups.flatMap((g) => g.hits),
    ...filteredLibraries,
  ];
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
    setContent([]);
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  const select = useCallback(
    (item: SearchResult) => {
      if (item.kind === "nav") navigate(item.href);
      else if (item.kind === "library") navigate(`/read/${item.sourceId}`);
      else navigate(item.route);
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
              placeholder="Search apps, articles, links, and libraries..."
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

                {/* Content sections (Saved Articles, Links, Companions, …) */}
                {contentGroups.map((cg) => {
                  // Running offset = nav + all hits in earlier content groups.
                  const earlier = contentGroups
                    .slice(0, contentGroups.indexOf(cg))
                    .reduce((n, g) => n + g.hits.length, 0);
                  const base = filteredNav.length + earlier;
                  return (
                    <div key={cg.group}>
                      <p className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-foreground/25">
                        {cg.group}
                      </p>
                      {cg.hits.map((hit, i) => {
                        const idx = base + i;
                        return (
                          <ContentRow
                            key={`${hit.type}:${hit.id}`}
                            item={hit}
                            selected={idx === selectedIndex}
                            onSelect={() => select(hit)}
                            onHover={() => setSelectedIndex(idx)}
                          />
                        );
                      })}
                    </div>
                  );
                })}

                {/* Libraries section */}
                {filteredLibraries.length > 0 && (
                  <>
                    <p className="px-4 pt-3 pb-1 text-[11px] font-medium uppercase tracking-wider text-foreground/25">
                      Libraries
                    </p>
                    {filteredLibraries.map((item, i) => {
                      const idx = filteredNav.length + content.length + i;
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
