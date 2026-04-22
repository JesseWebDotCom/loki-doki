import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import type { ChatSearchResult } from "../../../lib/api-types";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

interface FindInChatBarProps {
  open: boolean;
  query: string;
  results: ChatSearchResult[];
  activeIndex: number;
  loading?: boolean;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSelectResult: (result: ChatSearchResult) => void;
}

export default function FindInChatBar({
  open,
  query,
  results,
  activeIndex,
  loading = false,
  onQueryChange,
  onClose,
  onNext,
  onPrev,
  onSelectResult,
}: FindInChatBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(query);

  useEffect(() => {
    setDraft(query);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => {
      onQueryChange(draft.trim());
    }, 200);
    return () => window.clearTimeout(timer);
  }, [draft, onQueryChange, open]);

  if (!open) {
    return null;
  }

  const countLabel = query
    ? `${results.length === 0 ? "No" : results.length} match${results.length === 1 ? "" : "es"}`
    : "Type to search this chat";

  return (
    <div
      className="sticky top-0 z-10 mb-4 rounded-3xl border border-border/50 bg-background/95 p-3 shadow-m2 backdrop-blur"
      data-slot="find-in-chat-bar"
    >
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
              if (event.key === "Enter") {
                event.preventDefault();
                const active = results[activeIndex];
                if (active) onSelectResult(active);
              }
            }}
            placeholder="Find in this chat"
            className="h-11 rounded-2xl pl-10"
            aria-label="Find in this chat"
          />
        </div>
        <div className="flex items-center gap-2 self-end md:self-auto">
          <span className="min-w-[7rem] text-right text-xs text-muted-foreground">
            {loading ? "Searching…" : countLabel}
          </span>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11 rounded-2xl"
            onClick={onPrev}
            aria-label="Previous search result"
          >
            <ChevronUp className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-11 w-11 rounded-2xl"
            onClick={onNext}
            aria-label="Next search result"
          >
            <ChevronDown className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-11 w-11 rounded-2xl"
            onClick={onClose}
            aria-label="Close find in chat"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
