/**
 * FactRow — single fact card with the inline action cluster.
 *
 * Renders predicate / value / ConfidenceBar plus on-hover buttons:
 * confirm, edit value, reassign person, reject, delete. Ambiguous
 * facts get a prominent "Who is this?" person picker at the top.
 *
 * Stays presentational: every mutation is a callback. The parent
 * (PeopleTab / FactsTab / MemoryPage) owns refetch logic.
 */
import React, { useState } from "react";
import { Check, X, Edit3, Trash2, AlertTriangle, MessageSquare } from "lucide-react";
import type { Fact, Person } from "../../lib/api";
import { getMessage, type SourceMessage } from "../../lib/api";
import { ConfidenceBar } from "./ConfidenceBar";
import ConfirmDialog from "../ui/ConfirmDialog";

export interface FactRowProps {
  fact: Fact;
  people: Person[];
  candidatePersonIds?: number[];
  onConfirm: (id: number) => void;
  onReject: (id: number) => void;
  onDelete: (id: number) => void;
  onEditValue: (id: number, value: string) => void;
  onReassign: (id: number, personId: number | null) => void;
  onResolveAmbiguity?: (groupId: number, personId: number) => void;
}

export const FactRow: React.FC<FactRowProps> = ({
  fact,
  people,
  candidatePersonIds,
  onConfirm,
  onReject,
  onDelete,
  onEditValue,
  onReassign,
  onResolveAmbiguity,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.value ?? fact.fact ?? "");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [source, setSource] = useState<SourceMessage | null>(null);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceError, setSourceError] = useState<string | null>(null);

  const id = fact.id ?? 0;
  const sourceId = fact.source_message_id;

  const toggleSource = async () => {
    if (source) {
      setSource(null);
      return;
    }
    if (!sourceId) return;
    setSourceLoading(true);
    setSourceError(null);
    try {
      const { message } = await getMessage(sourceId);
      setSource(message);
    } catch {
      setSourceError("Source message not found");
    } finally {
      setSourceLoading(false);
    }
  };
  const eff =
    fact.effective_confidence != null ? fact.effective_confidence : fact.confidence ?? 0.6;
  const isAmbiguous = fact.status === "ambiguous" && fact.ambiguity_group_id != null;

  const submitEdit = () => {
    if (draft.trim() && draft !== fact.value) {
      onEditValue(id, draft.trim());
    }
    setEditing(false);
  };

  const candidates = (candidatePersonIds ?? [])
    .map((pid) => people.find((p) => p.id === pid))
    .filter(Boolean) as Person[];

  return (
    <div
      className={`group p-3 rounded-lg border space-y-2 transition-colors ${
        isAmbiguous
          ? "bg-amber-500/5 border-amber-500/30"
          : "bg-background/40 border-border/20 hover:border-border/40"
      }`}
      data-testid={`fact-row-${id}`}
    >
      {isAmbiguous && fact.ambiguity_group_id != null && (
        <div className="flex items-start gap-2 text-xs">
          <AlertTriangle size={12} className="text-amber-400 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="text-amber-300 font-bold mb-1">Who is this?</div>
            <div className="flex flex-wrap gap-1.5">
              {candidates.length > 0 ? (
                candidates.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() =>
                      onResolveAmbiguity?.(fact.ambiguity_group_id!, p.id)
                    }
                    className="px-2 py-0.5 rounded-md bg-card border border-border/40 hover:border-amber-400/50 text-[11px] font-medium"
                  >
                    {p.name}
                  </button>
                ))
              ) : (
                <span className="text-muted-foreground italic">
                  No candidates listed
                </span>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="flex items-baseline gap-2 text-sm">
        <span className="text-muted-foreground font-mono text-xs">
          {fact.predicate ?? "states"}
        </span>
        {editing ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={submitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") submitEdit();
              if (e.key === "Escape") {
                setDraft(fact.value ?? "");
                setEditing(false);
              }
            }}
            className="flex-1 bg-card border border-primary/40 rounded px-2 py-0.5 text-sm"
          />
        ) : (
          <span className="font-medium flex-1">{fact.value ?? fact.fact}</span>
        )}
      </div>

      <ConfidenceBar
        value={eff}
        rawValue={fact.confidence}
        observationCount={fact.observation_count}
        lastObservedAt={fact.last_observed_at}
      />

      <div className="flex items-center gap-1 pt-1 border-t border-border/10">
        <button
          type="button"
          onClick={() => onConfirm(id)}
          title="Confirm"
          className="p-1 rounded hover:bg-green-400/10 text-green-400"
        >
          <Check size={13} />
        </button>
        <button
          type="button"
          onClick={() => setEditing(true)}
          title="Edit value"
          className="p-1 rounded hover:bg-primary/10 text-primary"
        >
          <Edit3 size={13} />
        </button>
        <select
          title="Reassign to person"
          value={fact.subject_ref_id ?? ""}
          onChange={(e) =>
            onReassign(id, e.target.value ? Number(e.target.value) : null)
          }
          className="text-[10px] bg-card border border-border/40 rounded px-1 py-0.5 max-w-[100px]"
        >
          <option value="">— self —</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => onReject(id)}
          title="Reject (soft)"
          className="p-1 rounded hover:bg-amber-400/10 text-amber-400"
        >
          <X size={13} />
        </button>
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          title="Delete"
          className="p-1 rounded hover:bg-red-400/10 text-red-400"
        >
          <Trash2 size={13} />
        </button>
        {sourceId != null && (
          <button
            type="button"
            onClick={toggleSource}
            title={source ? "Hide source message" : "View source message"}
            className={`p-1 rounded ml-auto ${
              source
                ? "bg-primary/10 text-primary"
                : "hover:bg-primary/10 text-muted-foreground"
            }`}
          >
            <MessageSquare size={13} />
          </button>
        )}
      </div>

      {(source || sourceLoading || sourceError) && (
        <div className="text-[11px] border-t border-border/10 pt-2 space-y-1">
          <div className="text-muted-foreground font-bold uppercase tracking-wider text-[9px]">
            Source message
          </div>
          {sourceLoading && (
            <div className="text-muted-foreground italic">Loading…</div>
          )}
          {sourceError && (
            <div className="text-red-400">{sourceError}</div>
          )}
          {source && (
            <div className="bg-card/40 rounded px-2 py-1.5 border border-border/20">
              <div className="text-foreground/90 whitespace-pre-wrap">
                {source.content}
              </div>
              <div className="text-muted-foreground text-[9px] mt-1">
                {source.role} · {new Date(source.created_at).toLocaleString()}
              </div>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        title="Delete fact?"
        description="This fact will be permanently removed. This cannot be undone."
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          setConfirmOpen(false);
          onDelete(id);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
};
