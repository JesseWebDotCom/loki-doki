import React, { useEffect, useMemo, useState } from "react";
import { Calendar, GitBranch as ConnectIcon, ImagePlus, List, Upload, Users, X } from "lucide-react";
import Sidebar from "../components/sidebar/Sidebar";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useAuth } from "../auth/useAuth";
import { FocusedTreeCanvas } from "../components/people/FocusedTreeCanvas";
import { buildGraphPeopleMap } from "../components/people/graphPeople";
import { describeRelationshipForPerson } from "../components/people/relationshipLabels";
import { ReconcileDuplicatesPanel } from "../components/people/ReconcileDuplicatesPanel";
import {
  createGraphPerson,
  exportGedcom,
  getReconcileCandidates,
  getPeopleGraph,
  getProfilePhotoOptions,
  getStructuredPersonDetail,
  importGedcom,
  linkUserToPerson,
  patchPersonOverlay,
  selectProfilePhoto,
  setPreferredPersonMedia,
  uploadPersonMedia,
} from "../lib/api";
import type { PeopleEdge, Person, PersonMedia, ReconcileGroup } from "../lib/api";

type ViewMode = "tree" | "list" | "imports";

type StructuredPersonDetail = {
  person: Person;
  media: PersonMedia[];
  events: Array<Record<string, any>>;
  facts: Array<Record<string, any>>;
  edges: PeopleEdge[];
};

function dedupeEdges(edges: PeopleEdge[]): PeopleEdge[] {
  const merged = new Map<number, PeopleEdge>();
  for (const edge of edges) {
    merged.set(edge.id, edge);
  }
  return [...merged.values()];
}

function findSpouseIds(personId: number, edges: PeopleEdge[]): number[] {
  const spouseTerms = new Set(["spouse", "wife", "husband", "partner", "fiancé", "fiancée", "fiance", "fiancee", "ex", "ex-wife", "ex-husband"]);
  const ids = new Set<number>();
  for (const edge of edges) {
    const edgeType = (edge.edge_type || "").trim().toLowerCase();
    if (!spouseTerms.has(edgeType)) {
      continue;
    }
    if (edge.from_person_id === personId) {
      ids.add(edge.to_person_id);
    } else if (edge.to_person_id === personId) {
      ids.add(edge.from_person_id);
    }
  }
  return [...ids];
}

function findParentIds(personId: number, edges: PeopleEdge[]): number[] {
  const parentTerms = new Set(["parent", "mother", "father", "mom", "dad", "mama", "papa", "step-mom", "step-dad", "stepmom", "stepdad"]);
  const childTerms = new Set(["child", "son", "daughter", "kid"]);
  const ids = new Set<number>();
  for (const edge of edges) {
    const edgeType = (edge.edge_type || "").trim().toLowerCase();
    if (parentTerms.has(edgeType) && edge.to_person_id === personId) {
      ids.add(edge.from_person_id);
    }
    if (childTerms.has(edgeType) && edge.from_person_id === personId) {
      ids.add(edge.to_person_id);
    }
  }
  return [...ids];
}

const PeoplePage: React.FC = () => {
  useDocumentTitle("People");
  const { currentUser, refresh } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const [view, setView] = useState<ViewMode>("tree");
  const [people, setPeople] = useState<Person[]>([]);
  const [allEdges, setAllEdges] = useState<PeopleEdge[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<{
    person: Person;
    media: PersonMedia[];
    events: Array<Record<string, any>>;
    facts: Array<Record<string, any>>;
    edges: PeopleEdge[];
  } | null>(null);
  const [search, setSearch] = useState("");
  const [bucket, setBucket] = useState("all");
  const [relationshipState, setRelationshipState] = useState("all");
  const [interactionPreference, setInteractionPreference] = useState("all");
  const [newPersonName, setNewPersonName] = useState("");
  const [gedcomSummary, setGedcomSummary] = useState<string>("");
  const [adminUsers, setAdminUsers] = useState<Array<{ id: number; username: string }>>([]);
  const [, setProfileOptions] = useState<PersonMedia[]>([]);
  const [reconcileGroups, setReconcileGroups] = useState<ReconcileGroup[]>([]);
  const [showTreeDetailPanel, setShowTreeDetailPanel] = useState(false);
  const [treeContextDetails, setTreeContextDetails] = useState<Record<number, StructuredPersonDetail>>({});

  const graphPeopleMap = useMemo(
    () => buildGraphPeopleMap(people, allEdges),
    [people, allEdges],
  );

  useEffect(() => {
    if (!currentUser?.linked_person_id || people.length === 0) {
      return;
    }
    const linkedVisible = people.some((person) => person.id === currentUser.linked_person_id);
    if (!linkedVisible) {
      return;
    }
    const selectedVisible = selectedId != null && graphPeopleMap.has(selectedId);
    if (!selectedVisible) {
      setSelectedId(currentUser.linked_person_id);
    }
  }, [people, selectedId, currentUser?.linked_person_id, graphPeopleMap]);

  useEffect(() => {
    void (async () => {
      const payload = await getPeopleGraph({
        search,
        bucket,
        relationship_state: relationshipState,
        interaction_preference: interactionPreference,
      });
      setPeople(payload.people);
      setAllEdges(payload.edges ?? []);
    })();
  }, [search, bucket, relationshipState, interactionPreference]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setTreeContextDetails({});
      return;
    }
    void (async () => {
      setDetail(await getStructuredPersonDetail(selectedId));
    })();
  }, [selectedId]);

  const baseTreeEdges = useMemo(
    () => dedupeEdges([...allEdges, ...(detail?.edges ?? [])]),
    [allEdges, detail?.edges],
  );

  useEffect(() => {
    if (!selectedId) {
      return;
    }
    const centerIds = new Set<number>([selectedId, ...findSpouseIds(selectedId, baseTreeEdges)]);
    const parentIds = new Set<number>();
    for (const centerId of centerIds) {
      for (const parentId of findParentIds(centerId, baseTreeEdges)) {
        parentIds.add(parentId);
      }
    }
    const desiredIds = [...new Set([...centerIds, ...parentIds])].filter((id) => id !== selectedId);
    const missingIds = desiredIds.filter((id) => treeContextDetails[id] == null);
    if (missingIds.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const loaded = await Promise.all(
        missingIds.map(async (id) => [id, await getStructuredPersonDetail(id)] as const),
      );
      if (cancelled) {
        return;
      }
      setTreeContextDetails((current) => {
        const next = { ...current };
        for (const [id, payload] of loaded) {
          next[id] = payload;
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, baseTreeEdges, treeContextDetails]);

  const treeEdges = useMemo(
    () => dedupeEdges([
      ...baseTreeEdges,
      ...Object.values(treeContextDetails).flatMap((payload) => payload.edges),
    ]),
    [baseTreeEdges, treeContextDetails],
  );

  useEffect(() => {
    if (!isAdmin) return;
    void (async () => {
      const r = await fetch("/api/v1/admin/users");
      if (!r.ok) return;
      const data = (await r.json()) as { users: Array<{ id: number; username: string }> };
      setAdminUsers(data.users);
      const reconcile = await getReconcileCandidates();
      setReconcileGroups(reconcile.groups);
    })();
  }, [isAdmin]);

  useEffect(() => {
    if (!currentUser?.linked_person_id) return;
    void (async () => {
      const data = await getProfilePhotoOptions();
      setProfileOptions(data.options);
    })();
  }, [currentUser?.linked_person_id, currentUser?.profile_media_id]);

  const selectedPerson = useMemo(
    () => {
      if (selectedId == null) {
        return detail?.person ?? null;
      }
      const detailPerson = detail?.person?.id === selectedId ? detail.person : null;
      return people.find((person) => person.id === selectedId)
        ?? detailPerson
        ?? graphPeopleMap.get(selectedId)
        ?? null;
    },
    [people, selectedId, detail, graphPeopleMap],
  );

  const refreshGraph = async () => {
    const payload = await getPeopleGraph({
      search,
      bucket,
      relationship_state: relationshipState,
      interaction_preference: interactionPreference,
    });
    setPeople(payload.people);
    setAllEdges(payload.edges ?? []);
    if (selectedId) {
      setDetail(await getStructuredPersonDetail(selectedId));
    }
    if (isAdmin) {
      const reconcile = await getReconcileCandidates();
      setReconcileGroups(reconcile.groups);
    }
  };

  const photoThumb = (person: Person, className = "w-12 h-12") =>
    person.preferred_photo_url ? (
      <img src={person.preferred_photo_url} alt={person.name} className={`${className} rounded-xl object-cover border border-border/30`} />
    ) : (
      <div className={`${className} rounded-xl border border-primary/20 bg-primary/10 text-primary font-bold flex items-center justify-center`}>
        {(person.name || "?").slice(0, 1).toUpperCase()}
      </div>
    );

  // Use all edges from the graph for the tree canvas (multi-generation).
  // Detail edges are still available for the detail panel.
  const selectedEdges = detail?.edges ?? [];
  const isTreeView = view === "tree";
  const handleSelectPerson = (id: number) => {
    setSelectedId(id);
    if (isTreeView) {
      setShowTreeDetailPanel(true);
    }
  };

  const renderSelectedPersonDetail = () => {
    if (!detail || !selectedPerson) {
      return (
        <div className="p-5">
          <div className="text-sm text-muted-foreground">Select a person</div>
        </div>
      );
    }

    return (
      <div className="p-5 space-y-4">
        {/* Identity */}
        <div className="rounded-2xl border border-border/20 bg-background/70 p-4 shadow-m2">
          <div className="flex items-center gap-4">
            {photoThumb(selectedPerson, "w-20 h-20")}
            <div className="min-w-0">
              <div className="font-bold text-lg">{selectedPerson.name}</div>
              <div className="flex flex-wrap gap-1.5 mt-1">
                {selectedPerson.bucket && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary capitalize">{selectedPerson.bucket}</span>
                )}
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${selectedPerson.living_status === "deceased" ? "bg-muted text-muted-foreground" : "bg-green-500/10 text-green-600"}`}>
                  {selectedPerson.living_status || "unknown"}
                </span>
                {currentUser?.linked_person_id === selectedPerson.id && (
                  <span className="rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-bold text-primary uppercase tracking-wide">You</span>
                )}
              </div>
              {(selectedPerson.birth_date || selectedPerson.death_date) && (
                <div className="text-xs text-muted-foreground mt-1">
                  {selectedPerson.birth_date && `Born: ${selectedPerson.birth_date}`}
                  {selectedPerson.death_date && ` · Died: ${selectedPerson.death_date}`}
                </div>
              )}
              <div className="text-xs text-muted-foreground mt-0.5">
                {selectedPerson.linked_username ? `Linked: ${selectedPerson.linked_username}` : "Not linked to a user"}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 mt-4">
            <label className="text-sm space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Status</div>
              <select
                value={selectedPerson.relationship_state ?? "active"}
                onChange={(e) => void patchPersonOverlay(selectedPerson.id, { relationship_state: e.target.value }).then(refreshGraph)}
                className="w-full bg-background border border-border/20 rounded-xl px-3 py-1.5 text-sm"
              >
                <option value="active">Active</option>
                <option value="former">Former</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="text-sm space-y-1">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Interaction</div>
              <select
                value={selectedPerson.interaction_preference ?? "normal"}
                onChange={(e) => void patchPersonOverlay(selectedPerson.id, { interaction_preference: e.target.value }).then(refreshGraph)}
                className="w-full bg-background border border-border/20 rounded-xl px-3 py-1.5 text-sm"
              >
                <option value="normal">Normal</option>
                <option value="avoid">Avoid</option>
              </select>
            </label>
          </div>

          {isAdmin && (
            <label className="text-sm space-y-1 block mt-3">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Link to user</div>
              <select
                value={selectedPerson.linked_user_id ?? ""}
                onChange={(e) => { const v = e.target.value; if (v) void linkUserToPerson(selectedPerson.id, Number(v)).then(refreshGraph); }}
                className="w-full bg-background border border-border/20 rounded-xl px-3 py-1.5 text-sm"
              >
                <option value="">Select user...</option>
                {adminUsers.map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
              </select>
            </label>
          )}
        </div>

        {/* Connections */}
        {selectedEdges.length > 0 && (() => {
          // Deduplicate: bidirectional edges mean the same person appears
          // twice (parent A→B + child B→A). Keep the first edge per target.
          const seenTargets = new Set<number>();
          const deduped = selectedEdges.filter((edge) => {
            const targetId = edge.from_person_id === selectedPerson.id
              ? edge.to_person_id : edge.from_person_id;
            if (seenTargets.has(targetId)) return false;
            seenTargets.add(targetId);
            return true;
          });
          return (
          <div className="rounded-2xl border border-border/20 bg-background/70 p-4 shadow-m2">
            <div className="font-semibold text-sm flex items-center gap-2 mb-3"><ConnectIcon size={14} /> Relationships</div>
            <div className="space-y-1.5">
              {deduped.map((edge) => {
                const isFrom = edge.from_person_id === selectedPerson.id;
                const targetName = isFrom ? edge.to_person_name : edge.from_person_name;
                const targetId = isFrom ? edge.to_person_id : edge.from_person_id;
                return (
                  <button
                    key={edge.id}
                    type="button"
                    onClick={() => handleSelectPerson(targetId)}
                    className="w-full text-left rounded-xl bg-card/60 px-3 py-2 text-sm hover:bg-card/80 transition-colors flex items-center justify-between"
                  >
                    <span className="font-medium">{targetName}</span>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary capitalize">
                      {describeRelationshipForPerson(edge, selectedPerson.id)}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          );
        })()}

        {/* Timeline */}
        {detail.events.length > 0 && (
          <div className="rounded-2xl border border-border/20 bg-background/70 p-4 shadow-m2">
            <div className="font-semibold text-sm flex items-center gap-2 mb-3"><Calendar size={14} /> Timeline</div>
            <div className="space-y-1.5">
              {detail.events.slice(0, 8).map((event) => (
                <div key={`event-${event.id}`} className="rounded-xl bg-card/60 px-3 py-2 text-sm flex items-center justify-between">
                  <span className="font-medium capitalize">{event.event_type}</span>
                  <span className="text-xs text-muted-foreground">{event.event_date || event.value || "—"}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Memory */}
        {detail.facts.length > 0 && (
          <div className="rounded-2xl border border-border/20 bg-background/70 p-4 shadow-m2">
            <div className="font-semibold text-sm flex items-center gap-2 mb-3"><List size={14} /> Memory</div>
            <div className="space-y-1.5">
              {detail.facts.slice(0, 8).map((fact) => (
                <div key={`fact-${fact.id}`} className="rounded-xl bg-card/60 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">{fact.predicate}</span>{" "}
                  <span className="font-medium">{fact.value}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Photos */}
        <div className="rounded-2xl border border-border/20 bg-background/70 p-4 shadow-m2">
          <div className="font-semibold text-sm flex items-center gap-2 mb-3"><ImagePlus size={14} /> Photos</div>
          <label className="block w-full cursor-pointer rounded-xl border-2 border-dashed border-border/30 bg-card/40 py-3 text-center text-xs text-muted-foreground hover:border-primary/30 hover:bg-primary/5 transition-colors">
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void uploadPersonMedia(selectedPerson.id, file).then(refreshGraph);
              }}
            />
            Click to upload a photo
          </label>
          {detail.media.length > 0 && (
            <div className="grid grid-cols-2 gap-2 mt-3">
              {detail.media.map((media) => (
                <div key={media.id} className="rounded-xl border border-border/20 overflow-hidden bg-card/70">
                  {media.thumbnail_url ? (
                    <img src={media.thumbnail_url} alt={media.original_filename} className="w-full h-24 object-cover" />
                  ) : (
                    <div className="w-full h-24 bg-card" />
                  )}
                  <div className="p-2 space-y-1.5">
                    <button type="button" onClick={() => void setPreferredPersonMedia(selectedPerson.id, media.id).then(refreshGraph)} className="w-full text-[10px] px-2 py-1 rounded-lg border border-border/20 hover:bg-card/80">
                      Use in tree
                    </button>
                    {currentUser?.linked_person_id === selectedPerson.id && (
                      <button
                        type="button"
                        onClick={() => void selectProfilePhoto(media.id).then(async () => { await refresh(); setProfileOptions((await getProfilePhotoOptions()).options); })}
                        className="w-full text-[10px] px-2 py-1 rounded-lg border border-primary/30 bg-primary/10 text-primary"
                      >
                        Profile photo
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="border-b border-border/10 bg-gradient-to-r from-card via-background to-card px-[var(--app-shell-gutter)] pt-8 pb-7 sm:pt-10">
          <div className="mx-auto flex w-full max-w-[var(--app-content-max)] items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary">
                <Users size={28} />
              </div>
              <div>
                <h1 className="text-3xl font-bold tracking-tight">People</h1>
                <p className="text-base font-medium text-muted-foreground">
                  Structured graph, photos, overlays, and family import/export.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex gap-1">
                <input
                  value={newPersonName}
                  onChange={(e) => setNewPersonName(e.target.value)}
                  placeholder="New person..."
                  className="w-36 rounded-xl border border-border/20 bg-background/80 px-3 py-2.5 text-sm"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newPersonName.trim()) {
                      void createGraphPerson({ name: newPersonName.trim(), bucket: bucket === "all" ? "family" : bucket }).then(async (result) => {
                        setNewPersonName("");
                        await refreshGraph();
                        setSelectedId(result.id);
                      });
                    }
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    if (!newPersonName.trim()) return;
                    void createGraphPerson({ name: newPersonName.trim(), bucket: bucket === "all" ? "family" : bucket }).then(async (result) => {
                      setNewPersonName("");
                      await refreshGraph();
                      setSelectedId(result.id);
                    });
                  }}
                  className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2.5 text-sm font-bold text-primary"
                >
                  + Add
                </button>
              </div>
              <div className="w-px h-6 bg-border/30 mx-1" />
              {(["tree", "list", "imports"] as ViewMode[]).filter((mode) => mode !== "imports" || isAdmin).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  className={`rounded-xl border px-4 py-2.5 text-sm font-bold uppercase tracking-wide ${
                    view === mode ? "bg-primary/10 border-primary/30 text-primary" : "bg-card/40 border-border/20 text-muted-foreground"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </header>

        <section className="flex-1 overflow-hidden px-[var(--app-shell-gutter)] pb-8 pt-8">
          <div className={`mx-auto grid h-full w-full max-w-[var(--app-content-max)] gap-6 ${isTreeView && showTreeDetailPanel ? "lg:grid-cols-[minmax(0,1fr)_24rem]" : isTreeView ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_24rem]"}`}>
            <div className="min-h-0 flex flex-col rounded-3xl border border-border/20 bg-card/40 shadow-m2 overflow-hidden">
              <div className="p-4 border-b border-border/10 flex flex-wrap items-center gap-3">
                <input
                  aria-label="search people"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search people..."
                  className="min-w-[12rem] flex-1 bg-background/80 border border-border/20 rounded-xl px-3 py-2 text-sm"
                />
                <select value={bucket} onChange={(e) => setBucket(e.target.value)} className="bg-background/80 border border-border/20 rounded-xl px-3 py-2 text-sm">
                  <option value="all">All buckets</option>
                  <option value="family">Family</option>
                  <option value="friends">Friends</option>
                  <option value="work">Work</option>
                  <option value="other">Other</option>
                </select>
                <select value={relationshipState} onChange={(e) => setRelationshipState(e.target.value)} className="bg-background/80 border border-border/20 rounded-xl px-3 py-2 text-sm">
                  <option value="all">All relationship states</option>
                  <option value="active">Active</option>
                  <option value="former">Former</option>
                  <option value="unknown">Unknown</option>
                </select>
                <select value={interactionPreference} onChange={(e) => setInteractionPreference(e.target.value)} className="bg-background/80 border border-border/20 rounded-xl px-3 py-2 text-sm">
                  <option value="all">All interaction prefs</option>
                  <option value="normal">Normal</option>
                  <option value="avoid">Avoid</option>
                </select>
              </div>

              {view === "list" && (
                <div className="overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground border-b border-border/10">
                      <tr>
                        <th className="p-3">Photo</th>
                        <th>Name</th>
                        <th>Bucket</th>
                        <th>Linked user</th>
                        <th>Living</th>
                        <th>State</th>
                        <th>Interaction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((person) => (
                        <tr key={person.id} className="border-b border-border/5 hover:bg-card/60 cursor-pointer" onClick={() => handleSelectPerson(person.id)}>
                          <td className="p-3">{photoThumb(person, "w-10 h-10")}</td>
                          <td>{person.name}</td>
                          <td>{person.bucket}</td>
                          <td>{person.linked_username ?? "—"}</td>
                          <td>{person.living_status}</td>
                          <td>{person.relationship_state}</td>
                          <td>{person.interaction_preference}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {view === "tree" && (
                <div className="flex-1 overflow-hidden p-6">
                  {selectedPerson && (
                    <div className="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border border-border/20 bg-background/60 px-4 py-3">
                      <div>
                        <div className="text-[11px] uppercase tracking-[0.2em] text-muted-foreground">Selected person</div>
                        <div className="font-semibold">{selectedPerson.name}</div>
                      </div>
                    </div>
                  )}
                  <FocusedTreeCanvas
                    people={people}
                    selectedPerson={selectedPerson}
                    edges={treeEdges}
                    onSelectPerson={handleSelectPerson}
                    onClearFocus={() => {
                      setSelectedId(null);
                      setShowTreeDetailPanel(false);
                    }}
                    currentUserPersonId={currentUser?.linked_person_id ?? null}
                    onJumpToCurrentUser={() => {
                      if (currentUser?.linked_person_id) {
                        handleSelectPerson(currentUser.linked_person_id);
                      }
                    }}
                    onRequestDetails={() => setShowTreeDetailPanel(true)}
                    onCanvasBackgroundClick={() => setShowTreeDetailPanel(false)}
                  />
                </div>
              )}

              {view === "imports" && isAdmin && (
                <div className="flex-1 overflow-auto p-6 space-y-6" data-testid="people-imports-view">
                  <div className="rounded-2xl border border-border/20 bg-background/70 p-5 space-y-3">
                    <div className="font-semibold flex items-center gap-2"><Upload size={16} /> Import GEDCOM</div>
                    <input
                      type="file"
                      accept=".ged,.gedcom,.txt"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        void importGedcom(file).then((result) => {
                          setGedcomSummary(JSON.stringify(result.summary, null, 2));
                          void refreshGraph();
                        });
                      }}
                    />
                  </div>
                  <div className="rounded-2xl border border-border/20 bg-background/70 p-5 space-y-3">
                    <div className="font-semibold">Export family GEDCOM</div>
                    <button
                      type="button"
                      className="px-4 py-2 rounded-xl bg-primary/10 border border-primary/30 text-primary text-sm font-semibold"
                      onClick={() => {
                        void exportGedcom().then((text) => {
                          setGedcomSummary(text);
                        });
                      }}
                    >
                      Generate export
                    </button>
                  </div>
                  {gedcomSummary && (
                    <pre className="rounded-2xl border border-border/20 bg-black/20 p-4 text-xs whitespace-pre-wrap">{gedcomSummary}</pre>
                  )}
                  <ReconcileDuplicatesPanel
                    groups={reconcileGroups}
                    onRefresh={refreshGraph}
                    onFocusPerson={setSelectedId}
                    onMerged={setSelectedId}
                  />
                </div>
              )}
            </div>

            {(!isTreeView || showTreeDetailPanel) && (
            <aside className="rounded-3xl border border-border/20 bg-card/50 shadow-m3 overflow-auto">
              <div className="p-5 border-b border-border/10">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.25em] text-muted-foreground">People detail</div>
                    {selectedPerson ? <div className="mt-2 font-semibold text-lg">{selectedPerson.name}</div> : <div className="mt-2 text-sm text-muted-foreground">Select a person</div>}
                  </div>
                  {isTreeView && (
                    <button
                      type="button"
                      onClick={() => setShowTreeDetailPanel(false)}
                      className="rounded-xl border border-border/20 bg-background/80 p-2 text-muted-foreground"
                      aria-label="Close details"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              </div>
              <div className="p-5 space-y-4">
                {renderSelectedPersonDetail()}
              </div>
            </aside>
            )}
          </div>
        </section>
      </main>
    </div>
  );
};

export default PeoplePage;
