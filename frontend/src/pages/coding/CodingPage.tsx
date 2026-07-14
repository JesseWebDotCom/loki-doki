// The Coding app: a real terminal (xterm.js) attached to this user's persistent tmux
// session on the backend, which wraps a single Claude Code CLI process, see
// lib/codingServer.ts. Full-bleed, right below the app breadcrumb (design-ok(page-shell):
// a terminal fills all available space like a video player or map view; the standard
// PageContainer/PageHeader chrome would just eat rows a real terminal needs).
//
// tmux itself owns the split-pane layout (drawn into this single character grid), the
// toolbar below only issues split/close commands; there's no local pane-layout state
// in React. Mouse-mode drag-to-resize works because xterm.js forwards mouse events
// straight through to the attached tmux client.
import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Maximize, Minimize, SplitSquareHorizontal, SplitSquareVertical, X, ShieldAlert, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/cn";
import { useAppHeader } from "@/context/BreadcrumbSearchContext";

type ConnStatus = "connecting" | "open" | "closed";
type PaneAction = "split-h" | "split-v" | "close";

export function CodingPage() {
  useAppHeader({ query: "", setQuery: () => {}, searchable: false, settingsHref: "/apps/coding/settings" });
  const wrapRef = useRef<HTMLDivElement>(null);
  const termContainerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<ConnStatus>("connecting");
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Split panes come from tmux, which doesn't exist on Windows; the backend reports whether
  // they're available and we hide the buttons when they're not. Default true so the mac/Linux
  // layout renders immediately without waiting on the fetch.
  const [splits, setSplits] = useState(true);
  // Admin-only: split a pane that runs OUTSIDE the OS sandbox (full host access). Only
  // offered when the sandbox is installed (otherwise every pane is already unsandboxed).
  const [canUnsandbox, setCanUnsandbox] = useState(false);

  useEffect(() => {
    const container = termContainerRef.current;
    if (!container) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      // design-ok(hex-in-tsx): xterm.js's Terminal renders to canvas, not the DOM, its
      // theme option takes literal hex colors, not Tailwind classes.
      theme: { background: "#0a0a0a" },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/api/coding/terminal`);
    wsRef.current = ws;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => { setStatus("open"); sendResize(); };
    ws.onmessage = (evt) => { term.write(evt.data as string); };
    ws.onclose = () => setStatus("closed");
    ws.onerror = () => setStatus("closed");

    // xterm.js's own onData is always a string (keystrokes, paste, or mouse-mode
    // escape sequences), sent as-is; the sidecar treats any non-JSON text frame as
    // raw PTY input (see coding-pty-sidecar.ts).
    const dataSub = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      dataSub.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
    };
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  }, []);

  useEffect(() => {
    fetch("/api/coding/capabilities", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((caps: { splits?: boolean; canUnsandbox?: boolean } | null) => {
        if (caps && typeof caps.splits === "boolean") setSplits(caps.splits);
        if (caps && typeof caps.canUnsandbox === "boolean") setCanUnsandbox(caps.canUnsandbox);
      })
      .catch(() => { /* keep default */ });
  }, []);

  // Toggle: exit if already fullscreen (so the button works both ways), else request,
  // same idiom as VideoPlayer.tsx's fullscreen() toggle.
  const toggleFullscreen = useCallback(() => {
    const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
    if (doc.fullscreenElement || doc.webkitFullscreenElement) {
      // Branch rather than combine-then-.call(): the standard and webkit-prefixed
      // methods have different return types (Promise<void> vs void), and TS's method
      // overload resolution rejects calling a unioned function through .call().
      try {
        if (document.exitFullscreen) void document.exitFullscreen();
        else doc.webkitExitFullscreen?.();
      } catch { /* noop */ }
      return;
    }
    const el = wrapRef.current as (HTMLElement & { webkitRequestFullscreen?: () => void }) | null;
    if (!el) return;
    try {
      if (el.requestFullscreen) void el.requestFullscreen();
      else el.webkitRequestFullscreen?.();
    } catch { /* noop */ }
  }, []);

  // tmux owns the actual pane layout, this just issues the command and lets the
  // terminal repaint whatever tmux sends next, no local layout state to track.
  const paneAction = useCallback(async (action: PaneAction, sandboxed = true) => {
    try {
      const q = sandboxed ? "" : "?sandbox=false";
      await fetch(`/api/coding/pane/${action}${q}`, { method: "POST" });
    } catch { /* best-effort, a failure here just means nothing visibly changes */ }
  }, []);

  return (
    <div ref={wrapRef} className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-end gap-1 border-b border-border/40 bg-muted/20 px-2 py-1">
        {splits && (
          <>
            <Button variant="ghost" size="icon-sm" onClick={() => void paneAction("split-h")} title="Split pane horizontally" aria-label="Split pane horizontally">
              <SplitSquareHorizontal className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => void paneAction("split-v")} title="Split pane vertically" aria-label="Split pane vertically">
              <SplitSquareVertical className="size-4" />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => void paneAction("close")} title="Close pane" aria-label="Close pane">
              <X className="size-4" />
            </Button>
            {canUnsandbox && (
              <Button variant="ghost" size="icon-sm" className="text-warning" onClick={() => void paneAction("split-h", false)}
                title="Split pane outside the sandbox (admin: full host access)" aria-label="Split unsandboxed pane">
                <ShieldOff className="size-4" />
              </Button>
            )}
          </>
        )}
        <Button variant="ghost" size="icon-sm" onClick={toggleFullscreen} title={isFullscreen ? "Exit fullscreen" : "Fullscreen"} aria-label="Toggle fullscreen">
          {isFullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
        </Button>
      </div>
      <div className="relative flex-1 overflow-hidden">
        {status === "connecting" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/80">
            <Spinner size="lg" />
          </div>
        )}
        {status === "closed" && (
          <div className={cn("absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/80 p-6 text-center")}>
            <ShieldAlert className="size-8 text-destructive" />
            <p className="text-sm text-muted-foreground">Lost connection to the coding terminal. Reload to reconnect, your session and scrollback are preserved.</p>
          </div>
        )}
        <div ref={termContainerRef} className="h-full w-full p-2" />
      </div>
    </div>
  );
}
