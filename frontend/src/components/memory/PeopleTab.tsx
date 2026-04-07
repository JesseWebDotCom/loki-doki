/**
 * People tab — one expandable card per resolved person.
 *
 * Each card has actions (rename, set relationship, delete, merge), and
 * each fact inside renders as a FactRow with the inline action cluster.
 * A "Needs disambiguation" callout sits at the top listing facts whose
 * person reference couldn't be resolved.
 */
import React, { useMemo, useState } from "react";
import { User, ChevronDown, ChevronRight, Edit3, Trash2, GitMerge, Plus } from "lucide-react";
import type { Fact, Person, Relationship, AmbiguityGroup } from "../../lib/api";
import { FactRow } from "./FactRow";

export interface PeopleTabProps {
  people: Person[];
  facts: Fact[];
  relationships: Relationship[];
  ambiguityGroups: AmbiguityGroup[];
  onConfirm: (id: number) => void;
  onReject: (id: number) => void;
  onDelete: (id: number) => void;
  onEditValue: (id: number, value: string) => void;
  onReassign: (id: number, personId: number | null) => void;
  onResolveAmbiguity: (groupId: number, personId: number) => void;
  onRenamePerson: (id: number, name: string) => void;
  onDeletePerson: (id: number) => void;
  onAddRelationship: (id: number, relation: string) => void;
  onMergePerson: (sourceId: number, intoId: number) => void;
  onCreatePerson: (name: string) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? "").join("") || "?";
}

function factsForPerson(facts: Fact[], personId: number): Fact[] {
  return facts.filter((f) => f.subject_ref_id === personId);
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
  ambiguityGroups,
  onConfirm,
  onReject,
  onDelete,
  onEditValue,
  onReassign,
  onResolveAmbiguity,
  onRenamePerson,
  onDeletePerson,
  onAddRelationship,
  onMergePerson,
  onCreatePerson,
}) => {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [newPersonName, setNewPersonName] = useState("");

  const ambiguousFacts = useMemo(
    () => facts.filter((f) => f.status === "ambiguous"),
    [facts],
  );

  const cards = useMemo(
    () =>
      people.map((p) => ({
        person: p,
        facts: factsForPerson(facts, p.id),
        relationship: relationshipFor(relationships, p.id),
      })),
    [people, facts, relationships],
  );

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
      {ambiguousFacts.length > 0 && (
        <div className="rounded-xl bg-amber-500/5 border border-amber-500/30 p-4 space-y-3">
          <div className="text-xs font-bold text-amber-300 uppercase tracking-widest">
            Needs disambiguation ({ambiguousFacts.length})
          </div>
          {ambiguousFacts.map((f) => (
            <FactRow
              key={f.id}
              fact={f}
              people={people}
              candidatePersonIds={
                ambiguityGroups.find((g) => g.id === f.ambiguity_group_id)
                  ?.candidate_person_ids ?? []
              }
              onConfirm={onConfirm}
              onReject={onReject}
              onDelete={onDelete}
              onEditValue={onEditValue}
              onReassign={onReassign}
              onResolveAmbiguity={onResolveAmbiguity}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 p-3 rounded-xl bg-card/30 border border-border/20">
        <Plus size={14} className="text-primary" />
        <input
          value={newPersonName}
          onChange={(e) => setNewPersonName(e.target.value)}
          placeholder="Add a person…"
          className="flex-1 bg-transparent text-sm focus:outline-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && newPersonName.trim()) {
              onCreatePerson(newPersonName.trim());
              setNewPersonName("");
            }
          }}
        />
      </div>

      {people.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground text-sm italic">
          No people yet. Tell me about someone in chat or add one above.
        </div>
      ) : (
        cards.map(({ person, facts: pFacts, relationship }) => {
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
                  {renamingId === person.id ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={() => {
                        if (renameDraft.trim() && renameDraft !== person.name) {
                          onRenamePerson(person.id, renameDraft.trim());
                        }
                        setRenamingId(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      className="font-medium bg-card border border-primary/40 rounded px-2 py-0.5"
                    />
                  ) : (
                    <div className="font-medium truncate flex items-center gap-2">
                      {person.name}
                      {relationship && (
                        <span className="text-[10px] uppercase tracking-widest font-bold text-primary/80 bg-primary/10 px-2 py-0.5 rounded-full">
                          {relationship.relation}
                        </span>
                      )}
                    </div>
                  )}
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
                <div className="px-4 pb-4 space-y-3 border-t border-border/20">
                  <div className="pt-3 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setRenamingId(person.id);
                        setRenameDraft(person.name);
                      }}
                      className="text-[11px] flex items-center gap-1 px-2 py-1 rounded-md bg-card border border-border/40 hover:border-primary/40"
                    >
                      <Edit3 size={11} /> Rename
                    </button>
                    <RelationshipPicker
                      onPick={(rel) => onAddRelationship(person.id, rel)}
                    />
                    <MergePicker
                      people={people.filter((p) => p.id !== person.id)}
                      onPick={(target) => onMergePerson(person.id, target)}
                    />
                    <button
                      type="button"
                      onClick={() => {
                        if (confirm(`Delete ${person.name}? Their facts will cascade.`)) {
                          onDeletePerson(person.id);
                        }
                      }}
                      className="text-[11px] flex items-center gap-1 px-2 py-1 rounded-md bg-red-400/10 border border-red-400/30 text-red-400 hover:bg-red-400/20"
                    >
                      <Trash2 size={11} /> Delete
                    </button>
                  </div>

                  {pFacts.length === 0 ? (
                    <div className="text-xs text-muted-foreground italic">
                      No facts recorded for {person.name} yet.
                    </div>
                  ) : (
                    pFacts.map((f) => (
                      <FactRow
                        key={f.id}
                        fact={f}
                        people={people}
                        onConfirm={onConfirm}
                        onReject={onReject}
                        onDelete={onDelete}
                        onEditValue={onEditValue}
                        onReassign={onReassign}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
};

const RELATION_OPTIONS = [
  "brother", "sister", "mother", "father", "wife", "husband",
  "son", "daughter", "friend", "coworker", "boss", "neighbor", "pet",
];

const RelationshipPicker: React.FC<{ onPick: (rel: string) => void }> = ({ onPick }) => {
  return (
    <select
      onChange={(e) => {
        if (e.target.value) {
          onPick(e.target.value);
          e.target.value = "";
        }
      }}
      defaultValue=""
      className="text-[11px] bg-card border border-border/40 rounded-md px-2 py-1"
    >
      <option value="">+ Relationship…</option>
      {RELATION_OPTIONS.map((r) => (
        <option key={r} value={r}>
          {r}
        </option>
      ))}
    </select>
  );
};

const MergePicker: React.FC<{
  people: Person[];
  onPick: (id: number) => void;
}> = ({ people, onPick }) => {
  if (people.length === 0) return null;
  return (
    <select
      onChange={(e) => {
        if (e.target.value) {
          onPick(Number(e.target.value));
          e.target.value = "";
        }
      }}
      defaultValue=""
      className="text-[11px] bg-card border border-border/40 rounded-md px-2 py-1"
    >
      <option value="">
        <GitMerge size={10} /> Merge into…
      </option>
      {people.map((p) => (
        <option key={p.id} value={p.id}>
          → {p.name}
        </option>
      ))}
    </select>
  );
};
