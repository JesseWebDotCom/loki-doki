// Single source of truth for how the AppShell chrome treats a given route.
// Both AppShell (which paints the breadcrumb + backdrop) and PageShell (which
// self-tints full-bleed / chat pages) read from here so the two never disagree
// about who owns the background.

const PANEL_PREFIXES = ["/settings", "/admin", "/devtools"];

export interface RouteChrome {
  isHome: boolean;
  isChat: boolean;
  isPanel: boolean;
  /** ZIM reader (/read/:id) + docs: provide their own breadcrumb header. */
  isReader: boolean;
  /** Apps that own their full height (no scroller, no shell backdrop). */
  isFullBleed: boolean;
  /** True when the shell itself paints the registry color/gradient backdrop. */
  shellBackdrop: boolean;
}

export function classifyRoute(pathname: string): RouteChrome {
  const isHome = pathname === "/";
  const isChat = pathname.startsWith("/chat");
  const isPanel = PANEL_PREFIXES.some((p) => pathname.startsWith(p));
  // Match "/read/" (trailing slash) so the Bookmarks app at "/bookmarks" is NOT caught.
  const isReader = pathname.startsWith("/read/") || pathname.startsWith("/docs");
  const isFullBleed =
    pathname.startsWith("/maps") ||
    isReader ||
    pathname.startsWith("/imaging") ||
    // "/video" also covers the "/videos" hub (and the legacy "/youtube" era redirects there).
    pathname.startsWith("/video") ||
    pathname.startsWith("/youtube") ||
    pathname.startsWith("/music") ||
    pathname.startsWith("/bookmarks") ||
    // Notes is a rail+scroller layout app like Bookmarks: it owns its full height.
    pathname.startsWith("/notes") ||
    pathname.startsWith("/books") ||
    // Movies + Shows live in the always-dark MediaLayout cinema shell (owns its scroller
    // + backdrop). "/showtimes" is NOT caught: fifth char differs ("/shows" vs "/showt").
    pathname.startsWith("/movies") ||
    pathname.startsWith("/shows") ||
    // A real terminal (xterm.js) edge-to-edge: keeps the automatic breadcrumb
    // (not isReader, that suppresses it), just owns its own full-height content.
    pathname.startsWith("/coding") ||
    pathname.startsWith("/remote") ||
    // Doki TV linear channels: always-dark cinema shell that owns its scroller.
    pathname.startsWith("/channels");
  // The shell paints the backdrop for standard scroller apps only. Full-bleed,
  // chat and panel routes own their own backgrounds (PageShell self-tints them).
  const shellBackdrop = !isHome && !isChat && !isPanel && !isFullBleed;
  return { isHome, isChat, isPanel, isReader, isFullBleed, shellBackdrop };
}
