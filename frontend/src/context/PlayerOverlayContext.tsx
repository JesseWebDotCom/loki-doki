import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";

// Open/close state for the app-wide full-page music player (NowPlayingOverlay). The overlay is
// mounted once in AppShell (and portaled to <body> so it covers the sidebar too) and driven from
// here so any surface (the mini-player bar, the Now Playing page) can raise the same immersive
// player without a route change, the audio keeps playing wherever you are.
//
// The player IS the fullscreen experience: openPlayer() enters real browser fullscreen (Fullscreen
// API) and shows the overlay; leaving fullscreen (the Esc key, the close button, anything) closes
// the overlay entirely, so you land back exactly where you were, never on a windowed copy. The
// requestFullscreen call must run inside the click gesture, which it does (openPlayer is called
// synchronously from the button handler).
interface PlayerOverlayValue {
  open: boolean;
  openPlayer: () => void;
  closePlayer: () => void;
  // Immersive visualizer mode (Plexamp-style fullscreen visuals) - an independent top layer
  // that any surface can raise; it enters real browser fullscreen for the lean-back/TV feel.
  immersive: boolean;
  openImmersive: () => void;
  closeImmersive: () => void;
}

const Ctx = createContext<PlayerOverlayValue | null>(null);

// Phones never enter real browser fullscreen: the installed PWA has no browser chrome
// to hide, the transition is jarring, and the Mobile Design Contract keeps the bottom
// tab bar on screen (the overlays stop above it instead of covering it).
const isPhone = () => window.matchMedia("(max-width: 767px)").matches;

function requestFs() {
  if (isPhone()) return;
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> };
  try {
    (el.requestFullscreen ?? el.webkitRequestFullscreen)?.call(el)?.catch?.(() => {});
  } catch {
    /* fullscreen unsupported (e.g. iOS Safari); overlay still shows full-viewport */
  }
}
function fsElement() {
  const doc = document as Document & { webkitFullscreenElement?: Element };
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}
function exitFs() {
  const doc = document as Document & { webkitExitFullscreen?: () => Promise<void> };
  if (fsElement()) (doc.exitFullscreen ?? doc.webkitExitFullscreen)?.call(doc)?.catch?.(() => {});
}

export function PlayerOverlayProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [immersive, setImmersive] = useState(false);
  const { pathname } = useLocation();
  // On phones the tab bar stays visible (and tappable) under the player, so navigating
  // must fold the player away or it would keep covering the new page. The grace window
  // protects the /music/now-playing deep-link shim, which opens the player and then
  // immediately redirects to /music.
  const openedAtRef = useRef(0);
  const firstPathRef = useRef(true);
  useEffect(() => {
    if (firstPathRef.current) {
      firstPathRef.current = false;
      return;
    }
    if (!isPhone()) return;
    if (Date.now() - openedAtRef.current < 600) return;
    setOpen(false);
    setImmersive(false);
  }, [pathname]);
  // Tracks whether we actually reached fullscreen for this session, so the change→false handler
  // only auto-closes after a real fullscreen exit (not on the brief pre-activation frame, and not
  // on platforms where requestFullscreen silently no-ops).
  const enteredRef = useRef(false);

  useEffect(() => {
    const onChange = () => {
      if (fsElement()) {
        enteredRef.current = true;
      } else if (enteredRef.current) {
        // Left fullscreen (Esc key or programmatic) → close whichever fullscreen layer is up.
        enteredRef.current = false;
        setOpen(false);
        setImmersive(false);
      }
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  const openPlayer = useCallback(() => {
    enteredRef.current = false;
    openedAtRef.current = Date.now();
    setOpen(true);
    requestFs();
  }, []);

  const closePlayer = useCallback(() => {
    enteredRef.current = false;
    setOpen(false);
    exitFs();
  }, []);

  const openImmersive = useCallback(() => {
    enteredRef.current = false;
    openedAtRef.current = Date.now();
    setImmersive(true);
    requestFs();
  }, []);
  const closeImmersive = useCallback(() => {
    enteredRef.current = false;
    setImmersive(false);
    exitFs();
  }, []);

  const value = useMemo(
    () => ({ open, openPlayer, closePlayer, immersive, openImmersive, closeImmersive }),
    [open, openPlayer, closePlayer, immersive, openImmersive, closeImmersive],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePlayerOverlay(): PlayerOverlayValue {
  const ctx = useContext(Ctx);
  if (!ctx) return { open: false, openPlayer: () => {}, closePlayer: () => {}, immersive: false, openImmersive: () => {}, closeImmersive: () => {} };
  return ctx;
}
