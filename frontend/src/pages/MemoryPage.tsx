/**
 * MemoryPage — three tabs: You / People / Other.
 *
 * - **You** holds self facts (subject = "self") and conflicts on those.
 * - **People** is one expandable card per resolved person, with their
 *   relationship to the user and every fact about them nested inside.
 * - **Other** catches facts whose subject is neither "self" nor a known
 *   person — orphans the orchestrator hasn't bound to a person row yet.
 *
 * The page is the only stateful piece; each tab is presentational.
 */
import React, { useEffect, useMemo, useState } from "react";
import { Brain, User, Users, Database } from "lucide-react";
import Sidebar from "../components/sidebar/Sidebar";
import { PeopleTab } from "../components/memory/PeopleTab";
import { FactsTab } from "../components/memory/FactsTab";
import {
  getFacts,
  getPeople,
  getRelationships,
  getFactConflicts,
} from "../lib/api";
import type {
  Fact,
  Person,
  Relationship,
  FactConflict,
} from "../lib/api";

type TabId = "you" | "people" | "other";

const MemoryPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>("you");
  const [people, setPeople] = useState<Person[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [conflicts, setConflicts] = useState<FactConflict[]>([]);

  useEffect(() => {
    (async () => {
      // Parallel fetch — all four endpoints are independent and the
      // header counts need them all anyway.
      try {
        const [p, r, f, c] = await Promise.all([
          getPeople(),
          getRelationships(),
          getFacts(),
          getFactConflicts(),
        ]);
        setPeople(p.people);
        setRelationships(r.relationships);
        setFacts(f.facts as Fact[]);
        setConflicts(c.conflicts);
      } catch {
        // Backend not reachable — render empties rather than crashing.
      }
    })();
  }, []);

  // Partition facts into self / per-person / orphan buckets. The
  // person bucket isn't used directly here — PeopleTab does its own
  // filtering — but counting orphan facts requires knowing who's a
  // resolved person.
  const { selfFacts, otherFacts, selfConflicts, otherConflicts } = useMemo(() => {
    const personNames = new Set(people.map((p) => p.name.toLowerCase()));
    const isSelf = (subject: string | undefined) =>
      !subject || subject.toLowerCase() === "self";
    const isPerson = (subject: string | undefined) =>
      !!subject && personNames.has(subject.toLowerCase());

    return {
      selfFacts: facts.filter((f) => isSelf(f.subject)),
      otherFacts: facts.filter(
        (f) => !isSelf(f.subject) && !isPerson(f.subject),
      ),
      selfConflicts: conflicts.filter((c) => isSelf(c.subject)),
      otherConflicts: conflicts.filter(
        (c) => !isSelf(c.subject) && !isPerson(c.subject),
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
              </p>
            </div>
          </div>
        </header>

        <section className="p-10 flex-1">
          <div className="max-w-4xl mx-auto space-y-8">
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
              <FactsTab facts={selfFacts} conflicts={selfConflicts} />
            )}
            {activeTab === "people" && (
              <PeopleTab
                people={people}
                facts={facts}
                relationships={relationships}
              />
            )}
            {activeTab === "other" && (
              <FactsTab facts={otherFacts} conflicts={otherConflicts} />
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default MemoryPage;
