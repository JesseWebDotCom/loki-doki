/**
 * Facts tab — grouped by subject (self first, then people alphabetical)
 * with a conflicts callout above the list.
 *
 * Search box hits ``/facts/search`` and is debounced 250ms so the
 * BM25 query doesn't flood the backend on every keystroke. Hitting a
 * conflict candidate confirms it via a fresh upsert (the backend's
 * dedup-and-confirm path bumps confidence).
 */
import React, { useEffect, useMemo, useState } from "react";
import { Search, AlertTriangle } from "lucide-react";
import type { Fact, FactConflict, Person } from "../../lib/api";
import { searchFacts } from "../../lib/api";
import { FactRow } from "./FactRow";

export interface FactsTabProps {
  facts: Fact[];
  conflicts: FactConflict[];
  people: Person[];
  onConfirm: (id: number) => void;
  onReject: (id: number) => void;
  onDelete: (id: number) => void;
  onEditValue: (id: number, value: string) => void;
  onReassign: (id: number, personId: number | null) => void;
}

interface SearchHit {
  fact: string;
  score: number;
  subject?: string;
}

function groupBySubject(facts: Fact[]): Array<[string, Fact[]]> {
  const groups: Record<string, Fact[]> = {};
  for (const f of facts) {
    const key = (f.subject ?? "self") || "self";
    (groups[key] ||= []).push(f);
  }
  const keys = Object.keys(groups).sort((a, b) => {
    if (a === "self") return -1;
    if (b === "self") return 1;
    return a.localeCompare(b);
  });
  return keys.map((k) => [k, groups[k]]);
}

export const FactsTab: React.FC<FactsTabProps> = ({
  facts,
  conflicts,
  people,
  onConfirm,
  onReject,
  onDelete,
  onEditValue,
  onReassign,
}) => {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const grouped = useMemo(() => groupBySubject(facts), [facts]);

  // 250ms debounce: see file header. We track the latest query in a
  // closure variable so a stale request can't overwrite a fresh one.
  useEffect(() => {
    if (!query.trim()) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const r = await searchFacts(query);
        if (!cancelled) setHits(r.results);
      } catch {
        if (!cancelled) setHits([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query]);

  return (
    <div className="space-y-6" data-testid="facts-tab">
      {conflicts.length > 0 && (
        <div
          className="p-4 rounded-xl border border-amber-500/30 bg-amber-500/10 space-y-3"
          data-testid="conflicts-callout"
        >
          <div className="flex items-center gap-2 text-amber-300 text-xs font-bold uppercase tracking-widest">
            <AlertTriangle size={14} />
            {conflicts.length} unresolved {conflicts.length === 1 ? "conflict" : "conflicts"}
          </div>
          {conflicts.map((c) => (
            <div key={`${c.subject}:${c.predicate}`} className="space-y-1">
              <div className="text-xs text-muted-foreground">
                <span className="font-mono">{c.subject}</span>.
                <span className="font-mono">{c.predicate}</span> — which is correct?
              </div>
              <div className="flex flex-wrap gap-2">
                {c.candidates.map((cand) => (
                  <button
                    key={cand.id}
                    type="button"
                    onClick={() => onConfirm(cand.id)}
                    className="px-3 py-1.5 rounded-lg bg-card/60 border border-border/40 hover:border-primary/50 text-xs font-medium"
                  >
                    {cand.value}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="relative">
        <Search
          size={16}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search facts (BM25)…"
          aria-label="search facts"
          className="w-full bg-card/40 border border-border/40 rounded-xl py-2 pl-10 pr-4 text-sm focus:outline-none focus:border-primary/40"
        />
      </div>

      {hits !== null ? (
        <div className="space-y-2" data-testid="search-results">
          {hits.length === 0 ? (
            <div className="text-xs text-muted-foreground italic">No matches.</div>
          ) : (
            hits.map((h, i) => (
              <div
                key={i}
                className="p-3 rounded-xl bg-primary/5 border border-primary/10 text-sm"
              >
                {h.fact}
              </div>
            ))
          )}
        </div>
      ) : (
        <div className="space-y-6" data-testid="facts-grouped">
          {grouped.length === 0 && (
            <div className="text-center py-12 text-muted-foreground text-sm italic">
              No facts stored yet.
            </div>
          )}
          {grouped.map(([subject, rows]) => (
            <div key={subject} className="space-y-2">
              <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
                {subject === "self" ? "About you" : subject}
              </h3>
              {rows.map((f) => (
                <FactRow
                  key={f.id ?? `${f.predicate}-${f.value}`}
                  fact={f}
                  people={people}
                  onConfirm={onConfirm}
                  onReject={onReject}
                  onDelete={onDelete}
                  onEditValue={onEditValue}
                  onReassign={onReassign}
                />
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
