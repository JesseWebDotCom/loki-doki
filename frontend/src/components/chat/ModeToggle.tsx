import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Info } from "lucide-react";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "../ui/toggle-group";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "../ui/popover";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { TOGGLE_MODES, type ToggleMode } from "./modeToggleOptions";

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
const NARROW_QUERY = "(max-width: 639px)";

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
  const [compact, setCompact] = useState(false);
  const deepItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return undefined;
    }
    const media = window.matchMedia(NARROW_QUERY);
    const update = () => setCompact(media.matches);
    update();
    media.addEventListener?.("change", update);
    return () => media.removeEventListener?.("change", update);
  }, []);

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
      {compact ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              className="h-11 min-w-[9rem] justify-between rounded-2xl px-4"
              aria-label="Response mode"
              data-testid="mode-toggle-compact"
            >
              <span>{MODE_LABEL[value]}</span>
              <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {TOGGLE_MODES.map((mode) => (
              <DropdownMenuItem
                key={mode}
                onSelect={() => handleChange(mode)}
                className="min-h-11 justify-between"
              >
                <span>{MODE_LABEL[mode]}</span>
                {mode === value ? <Check className="h-4 w-4 text-primary" /> : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
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
              className="min-h-11 min-w-11 rounded-2xl px-4"
            >
              {MODE_LABEL[mode]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
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
