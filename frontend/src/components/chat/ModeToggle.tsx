import React, { useRef, useState } from "react";
import { Info } from "lucide-react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "../ui/toggle-group";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../ui/popover";
import type { ResponseMode } from "./SlashCommandParser";

/**
 * Compose-bar mode selector — chunk 13 of the rich-response rollout.
 *
 * Exposes four user-selectable response modes:
 *
 *  - ``auto`` (the default — backend derives via ``derive_response_mode``)
 *  - ``rich`` (synthesized + sources/media layout)
 *  - ``deep`` (long-latency thinking-model path; chunk 18 wires budgets)
 *  - ``search`` (retrieval-first result layout)
 *
 * "Direct" and "standard" are not exposed in the UI — users who want
 * those type the ``/direct`` or ``/standard`` slash commands. Slash
 * commands parse at send time and override whatever the toggle reads.
 *
 * Touch targets are 44px min per the Onyx Material spec (enforced by
 * ``toggle-group``'s primitive). Deep mode click surfaces a one-shot
 * popover explaining the latency cost so the user isn't surprised.
 */
export type ToggleMode = "auto" | "rich" | "deep" | "search";

export const TOGGLE_MODES: readonly ToggleMode[] = [
  "auto",
  "rich",
  "deep",
  "search",
] as const;

/**
 * Map a ``ToggleMode`` into the backend's ``user_mode_override`` wire
 * value. ``auto`` means "no override" and flows as ``null``.
 */
export function toggleModeToOverride(mode: ToggleMode): ResponseMode | null {
  if (mode === "auto") return null;
  return mode;
}

export interface ModeToggleProps {
  value: ToggleMode;
  onChange: (next: ToggleMode) => void;
  disabled?: boolean;
}

const MODE_LABEL: Record<ToggleMode, string> = {
  auto: "Auto",
  rich: "Rich",
  deep: "Deep",
  search: "Search",
};

/**
 * Session-key used to suppress the deep-mode latency advisory after
 * it's been shown once. We intentionally scope this to ``sessionStorage``
 * so each new browser tab/session can re-inform the user; the same tab
 * only shows it once.
 */
const DEEP_ADVISORY_KEY = "lokidoki.deep-mode-advisory-shown";

function hasSeenDeepAdvisory(): boolean {
  try {
    return window.sessionStorage.getItem(DEEP_ADVISORY_KEY) === "1";
  } catch {
    return false;
  }
}

function markDeepAdvisorySeen(): void {
  try {
    window.sessionStorage.setItem(DEEP_ADVISORY_KEY, "1");
  } catch {
    /* sessionStorage unavailable — swallow */
  }
}

const ModeToggle: React.FC<ModeToggleProps> = ({
  value,
  onChange,
  disabled,
}) => {
  const [deepAdvisoryOpen, setDeepAdvisoryOpen] = useState(false);
  const deepItemRef = useRef<HTMLButtonElement | null>(null);

  const handleChange = (next: string) => {
    // Radix ToggleGroup emits ``""`` when the user deselects the
    // active item. We map that back to ``auto`` so the compose bar
    // always has a well-defined mode.
    const resolved: ToggleMode = (TOGGLE_MODES as readonly string[]).includes(next)
      ? (next as ToggleMode)
      : "auto";
    onChange(resolved);
    if (resolved === "deep" && !hasSeenDeepAdvisory()) {
      setDeepAdvisoryOpen(true);
      markDeepAdvisorySeen();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={handleChange}
        disabled={disabled}
        aria-label="Response mode"
        data-testid="mode-toggle"
      >
        {TOGGLE_MODES.map((mode) => (
          <ToggleGroupItem
            key={mode}
            value={mode}
            aria-label={`${MODE_LABEL[mode]} mode`}
            data-testid={`mode-toggle-item-${mode}`}
            ref={mode === "deep" ? deepItemRef : undefined}
          >
            {MODE_LABEL[mode]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <Popover open={deepAdvisoryOpen} onOpenChange={setDeepAdvisoryOpen}>
        <PopoverAnchor asChild>
          <span aria-hidden className="sr-only">
            deep-mode advisory anchor
          </span>
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="end"
          className="w-72"
          data-testid="deep-advisory"
        >
          <div className="flex items-start gap-2">
            <Info
              size={16}
              className="mt-0.5 shrink-0 text-primary"
              aria-hidden
            />
            <div className="space-y-1">
              <p className="text-sm font-medium text-foreground">
                Deep mode can take up to 90s on Pi
              </p>
              <p className="text-xs text-muted-foreground">
                LokiDoki streams progress as it runs. You can keep typing
                while it thinks, or cancel anytime.
              </p>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
};

export default ModeToggle;
