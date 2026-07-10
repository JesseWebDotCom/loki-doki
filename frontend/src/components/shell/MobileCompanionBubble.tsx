import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

// Transient companion speech bubble for phones: surfaces proactive replies
// (briefings, alarms, hands-free answers) that arrive while the quick-ask sheet
// is CLOSED, so they render in exactly one place. Holds for a few seconds after
// the companion stops talking, then fades; X dismisses until the next turn.
// Tapping the body opens the quick-ask sheet, which shows the full reply.
const HOLD_MS = 4000;

export function MobileCompanionBubble({
  text,
  thinking,
  active,
  onOpen,
}: {
  /** Reply/caption text (already emote-stripped by the dock). */
  text: string;
  /** Streaming with no tokens yet - a new turn is starting. */
  thinking: boolean;
  /** Reply is being generated or spoken right now. */
  active: boolean;
  onOpen: () => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [held, setHeld] = useState(false);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new turn (rising edge of thinking) clears a previous dismissal.
  const prevThinking = useRef(false);
  useEffect(() => {
    if (thinking && !prevThinking.current) setDismissed(false);
    prevThinking.current = thinking;
  }, [thinking]);

  // Visible while the companion is active, then linger HOLD_MS so the last
  // sentence can actually be read.
  useEffect(() => {
    if (active) {
      if (holdTimer.current) clearTimeout(holdTimer.current);
      holdTimer.current = null;
      setHeld(true);
      return;
    }
    if (held && !holdTimer.current) {
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        setHeld(false);
      }, HOLD_MS);
    }
    return () => {
      if (holdTimer.current) {
        clearTimeout(holdTimer.current);
        holdTimer.current = null;
      }
    };
  }, [active, held]);

  const visible = !dismissed && held && (text.length > 0 || thinking);
  if (!visible) return null;

  return (
    <div
      className={cn(
        "md:hidden fixed inset-x-3 z-[90] bottom-[calc(var(--bottom-chrome,76px)+0.5rem)]",
        "flex items-start gap-2 rounded-sheet border border-border/40 bg-background/95 px-3 py-2 shadow-2xl backdrop-blur-xl",
      )}
    >
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className="max-h-20 overflow-hidden text-sm leading-snug">{text || "…"}</p>
      </button>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={() => setDismissed(true)}
        className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
