/**
 * People tab — card grid of everyone the orchestrator has resolved
 * out of decomposer-extracted facts.
 *
 * Avatars are initials, not images: PR3 doesn't have a place to upload
 * a real photo and we don't want to make one up. Click through opens a
 * detail drawer (rendered by the parent so this stays presentational).
 */
import React from "react";
import { User } from "lucide-react";
import type { Person } from "../../lib/api";

export interface PeopleTabProps {
  people: Person[];
  onSelect?: (person: Person) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

export const PeopleTab: React.FC<PeopleTabProps> = ({ people, onSelect }) => {
  if (people.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm italic">
        No people resolved yet. Tell me about someone in chat.
      </div>
    );
  }
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3" data-testid="people-grid">
      {people.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => onSelect?.(p)}
          className="flex items-center gap-3 p-4 rounded-xl bg-card/50 border border-border/30 hover:border-primary/40 hover:bg-card/70 transition-all text-left"
        >
          <div className="shrink-0 w-10 h-10 rounded-full bg-primary/10 border border-primary/20 text-primary font-bold flex items-center justify-center">
            {initials(p.name)}
          </div>
          <div className="flex-1 min-w-0">
            <div className="font-medium truncate">{p.name}</div>
            <div className="text-[11px] text-muted-foreground flex items-center gap-1">
              <User size={10} />
              {p.fact_count ?? 0} facts
            </div>
          </div>
        </button>
      ))}
    </div>
  );
};
