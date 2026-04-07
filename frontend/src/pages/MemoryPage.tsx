/**
 * MemoryPage — three tabs (You / People / Other) with full per-fact and
 * per-person mutation surface. Owns the refetch loop and threads action
 * callbacks down into the tab components.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Brain, User, Users, Database } from "lucide-react";
import Sidebar from "../components/sidebar/Sidebar";
import { PeopleTab } from "../components/memory/PeopleTab";
import { FactsTab } from "../components/memory/FactsTab";
import {
  getFacts,
  getPeople,
  getProjects,
  getRelationships,
  getFactConflicts,
  getAmbiguityGroups,
  confirmFact,
  rejectFact,
  patchFact,
  deleteFact,
  createPerson,
  renamePerson,
  deletePerson,
  setPrimaryRelationship,
  resolveAmbiguityGroup,
  mergePeople,
} from "../lib/api";
import type {
  Fact,
  Person,
  Relationship,
  FactConflict,
  AmbiguityGroup,
} from "../lib/api";

type TabId = "you" | "people" | "other";

const MemoryPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>("you");
  const [people, setPeople] = useState<Person[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [conflicts, setConflicts] = useState<FactConflict[]>([]);
  const [ambiguityGroups, setAmbiguityGroups] = useState<AmbiguityGroup[]>([]);
  const [projects, setProjects] = useState<Array<{ id: number; name: string }>>([]);
  const [projectFilter, setProjectFilter] = useState<number | null>(null);

  const refreshAll = useCallback(async () => {
    try {
      const [p, r, c, pr, ag, f] = await Promise.all([
        getPeople(),
        getRelationships(),
        getFactConflicts(),
        getProjects(),
        getAmbiguityGroups(),
        getFacts(projectFilter ?? undefined),
      ]);
      setPeople(p.people);
      setRelationships(r.relationships);
      setConflicts(c.conflicts);
      setProjects(pr.projects as Array<{ id: number; name: string }>);
      setAmbiguityGroups(ag.groups);
      setFacts(f.facts as Fact[]);
    } catch {
      // Backend not reachable — render empties rather than crashing.
    }
  }, [projectFilter]);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  // ---- mutation handlers --------------------------------------------------

  const handleConfirm = useCallback(
    async (id: number) => {
      await confirmFact(id);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleReject = useCallback(
    async (id: number) => {
      await rejectFact(id);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleDelete = useCallback(
    async (id: number) => {
      await deleteFact(id);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleEditValue = useCallback(
    async (id: number, value: string) => {
      await patchFact(id, { value });
      await refreshAll();
    },
    [refreshAll],
  );
  const handleReassign = useCallback(
    async (id: number, personId: number | null) => {
      const target = personId
        ? people.find((p) => p.id === personId)
        : null;
      await patchFact(id, {
        subject_ref_id: personId,
        subject_type: personId ? "person" : "self",
        subject: target ? target.name.toLowerCase() : "self",
      });
      await refreshAll();
    },
    [people, refreshAll],
  );
  const handleResolveAmbiguity = useCallback(
    async (groupId: number, personId: number) => {
      await resolveAmbiguityGroup(groupId, personId);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleRenamePerson = useCallback(
    async (id: number, name: string) => {
      await renamePerson(id, name);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleDeletePerson = useCallback(
    async (id: number) => {
      await deletePerson(id);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleSetPrimaryRelationship = useCallback(
    async (id: number, relation: string) => {
      await setPrimaryRelationship(id, relation);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleMergePerson = useCallback(
    async (sourceId: number, intoId: number) => {
      await mergePeople(sourceId, intoId);
      await refreshAll();
    },
    [refreshAll],
  );
  const handleCreatePerson = useCallback(
    async (name: string) => {
      await createPerson(name);
      await refreshAll();
    },
    [refreshAll],
  );

  // Partition facts.
  const { selfFacts, otherFacts, selfConflicts, otherConflicts } = useMemo(() => {
    const personIds = new Set(people.map((p) => p.id));
    const isSelf = (f: Fact) =>
      (f.subject_type ?? "self") === "self" || !f.subject_ref_id;
    const isPerson = (f: Fact) =>
      f.subject_ref_id != null && personIds.has(f.subject_ref_id);
    return {
      selfFacts: facts.filter(isSelf),
      otherFacts: facts.filter((f) => !isSelf(f) && !isPerson(f)),
      selfConflicts: conflicts.filter((c) => c.subject === "self"),
      otherConflicts: conflicts.filter(
        (c) =>
          c.subject !== "self" &&
          !people.some((p) => p.name.toLowerCase() === c.subject.toLowerCase()),
      ),
    };
  }, [facts, conflicts, people]);

  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode; count: number }> = [
    { id: "you", label: "You", icon: <User size={14} />, count: selfFacts.length },
    { id: "people", label: "People", icon: <Users size={14} />, count: people.length },
    { id: "other", label: "Other", icon: <Database size={14} />, count: otherFacts.length },
  ];

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main className="flex-1 flex flex-col bg-background overflow-y-auto">
        <header className="p-10 border-b border-border/10">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary">
              <Brain size={28} />
            </div>
            <div>
              <h1 className="text-3xl font-bold tracking-tight">Memory</h1>
              <p className="text-muted-foreground text-sm font-medium">
                {selfFacts.length} about you • {people.length} people •{" "}
                {facts.length} facts
                {conflicts.length > 0 && ` • ${conflicts.length} conflicts`}
                {ambiguityGroups.length > 0 &&
                  ` • ${ambiguityGroups.length} ambiguous`}
              </p>
            </div>
          </div>
        </header>

        <section className="p-10 flex-1">
          <div className="max-w-4xl mx-auto space-y-8">
            <div className="flex items-center justify-between gap-4">
              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">
                Scope
              </span>
              <select
                value={projectFilter ?? ""}
                onChange={(e) =>
                  setProjectFilter(e.target.value ? Number(e.target.value) : null)
                }
                className="bg-card border border-border/20 rounded-lg px-3 py-1.5 text-xs font-medium text-foreground focus:outline-none focus:border-primary/40"
              >
                <option value="">All memories</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div
              className="flex gap-2 border-b border-border/10 pb-2"
              role="tablist"
              aria-label="Memory views"
            >
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                    activeTab === tab.id
                      ? "bg-primary/10 text-primary border border-primary/20"
                      : "text-muted-foreground hover:bg-card/50 border border-transparent"
                  }`}
                >
                  {tab.icon}
                  {tab.label}
                  <span className="text-[10px] font-mono opacity-60">({tab.count})</span>
                </button>
              ))}
            </div>

            {activeTab === "you" && (
              <FactsTab
                facts={selfFacts}
                conflicts={selfConflicts}
                people={people}
                onConfirm={handleConfirm}
                onReject={handleReject}
                onDelete={handleDelete}
                onEditValue={handleEditValue}
                onReassign={handleReassign}
              />
            )}
            {activeTab === "people" && (
              <PeopleTab
                people={people}
                facts={facts}
                relationships={relationships}
                ambiguityGroups={ambiguityGroups}
                onConfirm={handleConfirm}
                onReject={handleReject}
                onDelete={handleDelete}
                onEditValue={handleEditValue}
                onReassign={handleReassign}
                onResolveAmbiguity={handleResolveAmbiguity}
                onRenamePerson={handleRenamePerson}
                onDeletePerson={handleDeletePerson}
                onSetPrimaryRelationship={handleSetPrimaryRelationship}
                onMergePerson={handleMergePerson}
                onCreatePerson={handleCreatePerson}
              />
            )}
            {activeTab === "other" && (
              <FactsTab
                facts={otherFacts}
                conflicts={otherConflicts}
                people={people}
                onConfirm={handleConfirm}
                onReject={handleReject}
                onDelete={handleDelete}
                onEditValue={handleEditValue}
                onReassign={handleReassign}
              />
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default MemoryPage;
