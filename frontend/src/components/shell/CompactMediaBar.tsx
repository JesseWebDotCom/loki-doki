import type { ReactNode } from "react";
import { Pause, Play, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

// The phone-width mini-player row (Mobile Design Contract): artwork + title/artist +
// play/pause + optional next + close, and the whole body is one big "open the full
// player" tap target. Every media bar (music, live radio, podcast, video) composes
// this inside `md:hidden` while keeping its rich desktop row untouched, so all bars
// share one height and one look. The dropped controls (viz, DJ, karaoke, repeat,
// seek +/-, PiP...) live in each source's full player.
export function CompactMediaBar({
  art,
  title,
  subtitle,
  playing,
  loading = false,
  onToggle,
  onNext,
  onClose,
  onExpand,
  expandLabel = "Open player",
  extra,
  accent,
  accentText,
}: {
  art: ReactNode;
  title: string;
  subtitle?: ReactNode;
  playing: boolean;
  loading?: boolean;
  onToggle: () => void;
  /** Omit for live streams (no next track). */
  onNext?: () => void;
  onClose: () => void;
  /** Tapping the artwork/title body. */
  onExpand: () => void;
  expandLabel?: string;
  /** One optional bar-specific control rendered before play (e.g. the radio bar's
   *  visualizer selector). Keep it to a single icon button; more is clutter. */
  extra?: ReactNode;
  /** Play-button tint (album persona); defaults to the standard foreground pill. */
  accent?: string;
  accentText?: string;
}) {
  return (
    <div className="relative z-10 flex h-14 items-center gap-2 px-3 md:hidden">
      {/* design-ok(hand-styled-button): the bar body is the expand tap target, mirrors YoutubeMiniBar */}
      <button type="button" onClick={onExpand} aria-label={expandLabel} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        <span className="relative block size-10 shrink-0 overflow-hidden rounded-control bg-muted">
          {art}
          {loading && (
            <span className="absolute inset-0 grid place-items-center bg-black/40">
              <Spinner className="size-4 text-white" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{title}</span>
          {subtitle && (
            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">{subtitle}</span>
          )}
        </span>
      </button>

      {extra}
      <Button
        size="icon"
        onClick={onToggle}
        className="size-10 shrink-0 rounded-full bg-foreground text-background hover:bg-foreground/90"
        style={accent ? { background: accent, color: accentText } : undefined}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause className="size-4 fill-current" /> : <Play className="ml-0.5 size-4 fill-current" />}
      </Button>
      {onNext && (
        <Button variant="ghost" size="icon" onClick={onNext} className="size-10 shrink-0 text-muted-foreground" aria-label="Next">
          <SkipForward className="size-4" />
        </Button>
      )}
      <Button variant="ghost" size="icon" onClick={onClose} className="size-10 shrink-0 text-muted-foreground" aria-label="Close">
        <X className="size-4" />
      </Button>
    </div>
  );
}
