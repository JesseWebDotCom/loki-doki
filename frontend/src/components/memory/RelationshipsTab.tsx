/**
 * Relationships tab — flat list grouped by ``relation`` family.
 *
 * The roadmap explicitly scopes a graph viz out of PR3, so this is a
 * bucketed list with confidence bars. Family / Friends / Other is a
 * cheap heuristic until we add an explicit category column.
 */
import React from "react";
import type { Relationship } from "../../lib/api";
import { ConfidenceBar } from "./ConfidenceBar";

const FAMILY = new Set([
  "mother", "father", "mom", "dad", "parent",
  "brother", "sister", "sibling",
  "son", "daughter", "child", "kid",
  "spouse", "wife", "husband", "partner",
  "uncle", "aunt", "cousin", "grandparent", "grandfather", "grandmother",
]);
const FRIEND = new Set(["friend", "bestfriend", "buddy"]);

function bucketOf(relation: string): "Family" | "Friends" | "Other" {
  const r = relation.toLowerCase().replace(/\s+/g, "");
  if (FAMILY.has(r)) return "Family";
  if (FRIEND.has(r)) return "Friends";
  return "Other";
}

export interface RelationshipsTabProps {
  relationships: Relationship[];
}

export const RelationshipsTab: React.FC<RelationshipsTabProps> = ({
  relationships,
}) => {
  if (relationships.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground text-sm italic">
        No relationships recorded yet.
      </div>
    );
  }

  const grouped: Record<string, Relationship[]> = { Family: [], Friends: [], Other: [] };
  for (const r of relationships) {
    grouped[bucketOf(r.relation)].push(r);
  }

  return (
    <div className="space-y-6" data-testid="relationships-list">
      {(Object.keys(grouped) as Array<keyof typeof grouped>).map((bucket) => {
        const rows = grouped[bucket];
        if (rows.length === 0) return null;
        return (
          <div key={bucket} className="space-y-2">
            <h3 className="text-xs font-bold text-muted-foreground uppercase tracking-widest">
              {bucket}
            </h3>
            {rows.map((r) => (
              <div
                key={r.id}
                className="p-3 rounded-xl bg-card/50 border border-border/30 flex items-center gap-4"
              >
                <div className="flex-1">
                  <div className="text-sm font-medium">
                    {r.person_name}{" "}
                    <span className="text-muted-foreground font-normal">
                      — {r.relation}
                    </span>
                  </div>
                  <ConfidenceBar value={r.confidence} />
                </div>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
};
