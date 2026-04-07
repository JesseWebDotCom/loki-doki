/**
 * MemoryPage — PR3 rewrite.
 *
 * Three tabs (People / Relationships / Facts) plus a conflicts callout
 * surfaced inside the Facts tab. The page is the only stateful piece;
 * each tab is a presentational component in ``components/memory/``.
 *
 * The tab buttons are roll-your-own rather than a shadcn ``Tabs``
 * import: the project's ``components/ui`` only ships ``Badge`` +
 * ``tooltip`` and pulling shadcn's CLI for one component is more churn
 * than it's worth — see ConfidenceBar.tsx for the same call.
 */
import React, { useEffect, useState } from "react";
import { Brain, Users, Network, Database } from "lucide-react";
import Sidebar from "../components/sidebar/Sidebar";
import { PeopleTab } from "../components/memory/PeopleTab";
import { RelationshipsTab } from "../components/memory/RelationshipsTab";
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

type TabId = "people" | "relationships" | "facts";

const MemoryPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabId>("people");
  const [people, setPeople] = useState<Person[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [conflicts, setConflicts] = useState<FactConflict[]>([]);

  useEffect(() => {
    (async () => {
      // Parallel fetch — all four endpoints are independent and the
      // header ("X facts, Y people") needs them all anyway.
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

  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode; count: number }> = [
    { id: "people", label: "People", icon: <Users size={14} />, count: people.length },
    {
      id: "relationships",
      label: "Relationships",
      icon: <Network size={14} />,
      count: relationships.length,
    },
    { id: "facts", label: "Facts", icon: <Database size={14} />, count: facts.length },
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
                {people.length} people • {relationships.length} relationships •{" "}
                {facts.length} facts{conflicts.length > 0 && ` • ${conflicts.length} conflicts`}
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

            {activeTab === "people" && <PeopleTab people={people} />}
            {activeTab === "relationships" && (
              <RelationshipsTab relationships={relationships} />
            )}
            {activeTab === "facts" && (
              <FactsTab facts={facts} conflicts={conflicts} />
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default MemoryPage;
