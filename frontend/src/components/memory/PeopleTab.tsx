/**
 * People tab — one expandable card per resolved person, with their
 * relationship to the user (if any) and every fact about them nested
 * inside the card. Replaces the prior flat grid + separate Relationships
 * tab; everything person-scoped now lives in one place.
 */
import React, { useMemo, useState } from "react";
import { User, ChevronDown, ChevronRight } from "lucide-react";
import type { Fact, Person, Relationship } from "../../lib/api";
import { ConfidenceBar } from "./ConfidenceBar";

export interface PeopleTabProps {
  people: Person[];
  facts: Fact[];
  relationships: Relationship[];
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

function factsForPerson(facts: Fact[], name: string): Fact[] {
  const target = name.toLowerCase();
  return facts.filter((f) => (f.subject ?? "").toLowerCase() === target);
}

function relationshipFor(
  relationships: Relationship[],
  personId: number,
): Relationship | undefined {
  return relationships.find((r) => r.person_id === personId);
}

export const PeopleTab: React.FC<PeopleTabProps> = ({
  people,
  facts,
  relationships,
}) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const cards = useMemo(
    () =>
      people.map((p) => ({
        person: p,
        facts: factsForPerson(facts, p.name),
        relationship: relationshipFor(relationships, p.id),
      })),
    [people, facts, relationships],
  );

  if (people.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm italic">
        No people resolved yet. Tell me about someone in chat.
      </div>
    );
  }

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-3" data-testid="people-list">
      {cards.map(({ person, facts: pFacts, relationship }) => {
        const isOpen = expanded.has(person.id);
        return (
          <div
            key={person.id}
            className="rounded-xl bg-card/50 border border-border/30 overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggle(person.id)}
              className="w-full flex items-center gap-3 p-4 text-left hover:bg-card/70 transition-all"
              aria-expanded={isOpen}
            >
              <div className="shrink-0 w-10 h-10 rounded-full bg-primary/10 border border-primary/20 text-primary font-bold flex items-center justify-center">
                {initials(person.name)}
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-medium truncate flex items-center gap-2">
                  {person.name}
                  {relationship && (
                    <span className="text-[10px] uppercase tracking-widest font-bold text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full">
                      {relationship.relation}
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <User size={10} />
                  {pFacts.length} {pFacts.length === 1 ? "fact" : "facts"}
                </div>
              </div>
              {isOpen ? (
                <ChevronDown size={16} className="text-muted-foreground" />
              ) : (
                <ChevronRight size={16} className="text-muted-foreground" />
              )}
            </button>

            {isOpen && (
              <div className="px-4 pb-4 space-y-2 border-t border-border/20">
                {pFacts.length === 0 ? (
                  <div className="pt-3 text-xs text-muted-foreground italic">
                    No facts recorded for {person.name} yet.
                  </div>
                ) : (
                  pFacts.map((f) => (
                    <div
                      key={f.id ?? `${f.predicate}-${f.value}`}
                      className="mt-3 p-3 rounded-lg bg-background/40 border border-border/20 space-y-2"
                    >
                      <div className="flex items-baseline gap-2 text-sm">
                        <span className="text-muted-foreground font-mono text-xs">
                          {f.predicate ?? "states"}
                        </span>
                        <span className="font-medium">{f.value ?? f.fact}</span>
                      </div>
                      <ConfidenceBar value={f.confidence ?? 0.6} />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
