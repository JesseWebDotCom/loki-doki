import React, { useEffect, useMemo, useState } from "react";
import { List, Upload, Users, ImagePlus, X } from "lucide-react";
import Sidebar from "../components/sidebar/Sidebar";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { useAuth } from "../auth/useAuth";
import { FocusedTreeCanvas } from "../components/people/FocusedTreeCanvas";
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

const PeoplePage: React.FC = () => {
  useDocumentTitle("People");
  const { currentUser, refresh } = useAuth();
  const isAdmin = currentUser?.role === "admin";
  const [view, setView] = useState<ViewMode>("tree");
  const [people, setPeople] = useState<Person[]>([]);
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
  const [profileOptions, setProfileOptions] = useState<PersonMedia[]>([]);
  const [reconcileGroups, setReconcileGroups] = useState<ReconcileGroup[]>([]);
  const [showTreeDetailPanel, setShowTreeDetailPanel] = useState(false);

  useEffect(() => {
    if (!currentUser?.linked_person_id || people.length === 0) {
      return;
    }
    const linkedVisible = people.some((person) => person.id === currentUser.linked_person_id);
    if (!linkedVisible) {
      return;
    }
    const selectedVisible = selectedId != null && people.some((person) => person.id === selectedId);
    if (!selectedVisible) {
      setSelectedId(currentUser.linked_person_id);
    }
  }, [people, selectedId, currentUser?.linked_person_id]);

  useEffect(() => {
    void (async () => {
      const payload = await getPeopleGraph({
        search,
        bucket,
        relationship_state: relationshipState,
        interaction_preference: interactionPreference,
      });
      setPeople(payload.people);
    })();
  }, [search, bucket, relationshipState, interactionPreference]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    void (async () => {
      setDetail(await getStructuredPersonDetail(selectedId));
    })();
  }, [selectedId]);

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
    () => people.find((person) => person.id === selectedId) ?? detail?.person ?? null,
    [people, selectedId, detail],
  );

  const refreshGraph = async () => {
    const payload = await getPeopleGraph({
      search,
      bucket,
      relationship_state: relationshipState,
      interaction_preference: interactionPreference,
    });
    setPeople(payload.people);
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
      <div className="p-5 space-y-5">
        <div className="rounded-2xl border border-border/20 bg-background/70 p-4 space-y-4">
          <div className="flex items-center gap-3">
            {photoThumb(selectedPerson, "w-20 h-20")}
            <div>
              <div className="font-bold text-lg">{selectedPerson.name}</div>
              <div className="text-sm text-muted-foreground">
                {selectedPerson.bucket} • {selectedPerson.living_status}
              </div>
              <div className="text-xs text-muted-foreground">
                {selectedPerson.linked_username ? `Linked user: ${selectedPerson.linked_username}` : "No linked app user"}
                {currentUser?.linked_person_id === selectedPerson.id ? " • This is you" : ""}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm space-y-1">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Relationship state</div>
              <select
                value={selectedPerson.relationship_state ?? "active"}
                onChange={(e) => {
                  void patchPersonOverlay(selectedPerson.id, { relationship_state: e.target.value }).then(refreshGraph);
                }}
                className="w-full bg-background border border-border/20 rounded-xl px-3 py-2"
              >
                <option value="active">Active</option>
                <option value="former">Former</option>
                <option value="unknown">Unknown</option>
              </select>
            </label>
            <label className="text-sm space-y-1">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Interaction pref</div>
              <select
                value={selectedPerson.interaction_preference ?? "normal"}
                onChange={(e) => {
                  void patchPersonOverlay(selectedPerson.id, { interaction_preference: e.target.value }).then(refreshGraph);
                }}
                className="w-full bg-background border border-border/20 rounded-xl px-3 py-2"
              >
                <option value="normal">Normal</option>
                <option value="avoid">Avoid</option>
              </select>
            </label>
          </div>

          {isAdmin && (
            <label className="text-sm space-y-1 block">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Link to app user</div>
              <select
                value={selectedPerson.linked_user_id ?? ""}
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) return;
                  void linkUserToPerson(selectedPerson.id, Number(value)).then(refreshGraph);
                }}
                className="w-full bg-background border border-border/20 rounded-xl px-3 py-2"
              >
                <option value="">Select user...</option>
                {adminUsers.map((user) => (
                  <option key={user.id} value={user.id}>{user.username}</option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="rounded-2xl border border-border/20 bg-background/70 p-4 space-y-3">
          <div className="font-semibold flex items-center gap-2"><ImagePlus size={16} /> Photos</div>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              void uploadPersonMedia(selectedPerson.id, file).then(refreshGraph);
            }}
          />
          <div className="grid grid-cols-2 gap-3">
            {detail.media.map((media) => (
              <div key={media.id} className="rounded-xl border border-border/20 overflow-hidden bg-card/70">
                {media.thumbnail_url ? (
                  <img src={media.thumbnail_url} alt={media.original_filename} className="w-full h-28 object-cover" />
                ) : (
                  <div className="w-full h-28 bg-card" />
                )}
                <div className="p-3 space-y-2">
                  <div className="text-xs truncate">{media.original_filename}</div>
                  <button type="button" onClick={() => void setPreferredPersonMedia(selectedPerson.id, media.id).then(refreshGraph)} className="w-full text-xs px-2 py-1 rounded-lg border border-border/20">
                    Use in tree
                  </button>
                  {currentUser?.linked_person_id === selectedPerson.id && (
                    <button
                      type="button"
                      onClick={() => {
                        void selectProfilePhoto(media.id).then(async () => {
                          await refresh();
                          const next = await getProfilePhotoOptions();
                          setProfileOptions(next.options);
                        });
                      }}
                      className="w-full text-xs px-2 py-1 rounded-lg border border-primary/30 bg-primary/10 text-primary"
                    >
                      Use as profile photo
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {currentUser?.linked_person_id === selectedPerson.id && profileOptions.length > 0 && (
          <div className="rounded-2xl border border-border/20 bg-background/70 p-4 space-y-3">
            <div className="font-semibold">Profile photo options</div>
            <div className="flex flex-wrap gap-3">
              {profileOptions.map((media) => (
                <button key={media.id} type="button" onClick={() => void selectProfilePhoto(media.id).then(refresh)} className="rounded-xl overflow-hidden border border-border/20">
                  {media.thumbnail_url && <img src={media.thumbnail_url} alt={media.original_filename} className="w-16 h-16 object-cover" />}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-border/20 bg-background/70 p-4 space-y-3">
          <div className="font-semibold flex items-center gap-2"><List size={16} /> Facts and events</div>
          <div className="space-y-2 text-sm">
            {detail.events.slice(0, 5).map((event) => (
              <div key={`event-${event.id}`} className="rounded-xl bg-card/60 p-3">
                <div className="font-medium">{event.event_type}</div>
                <div className="text-muted-foreground text-xs">{event.event_date || event.value || "No date"}</div>
              </div>
            ))}
            {detail.facts.slice(0, 5).map((fact) => (
              <div key={`fact-${fact.id}`} className="rounded-xl bg-card/60 p-3">
                <div className="font-medium">{fact.predicate}</div>
                <div className="text-muted-foreground text-xs">{fact.value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="flex h-screen w-screen bg-background text-foreground overflow-hidden font-sans antialiased">
      <Sidebar phase="idle" />
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="p-8 border-b border-border/10 bg-gradient-to-r from-card via-background to-card">
          <div className="w-full px-4 sm:px-6 flex items-center justify-between gap-6">
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-2xl bg-primary/10 border border-primary/20 text-primary">
                <Users size={28} />
              </div>
              <div>
                <h1 className="text-3xl font-bold tracking-tight">People</h1>
                <p className="text-sm text-muted-foreground">
                  Structured graph, photos, overlays, and family import/export.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              {(["tree", "list", "imports"] as ViewMode[]).filter((mode) => mode !== "imports" || isAdmin).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  className={`px-4 py-2 rounded-xl border text-xs font-bold uppercase tracking-wide ${
                    view === mode ? "bg-primary/10 border-primary/30 text-primary" : "bg-card/40 border-border/20 text-muted-foreground"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
        </header>

        <section className="flex-1 overflow-hidden p-6">
          <div className={`w-full px-4 sm:px-6 grid gap-6 h-full ${isTreeView && showTreeDetailPanel ? "lg:grid-cols-[minmax(0,1fr)_24rem]" : isTreeView ? "grid-cols-1" : "grid-cols-[minmax(0,1fr)_24rem]"}`}>
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
                    edges={selectedEdges}
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
              <div className="p-5 space-y-5">
                <div className="rounded-2xl border border-border/20 bg-background/70 p-4 space-y-3">
                  <div className="font-semibold">Quick add</div>
                  <div className="flex gap-2">
                    <input value={newPersonName} onChange={(e) => setNewPersonName(e.target.value)} placeholder="Add a person" className="flex-1 bg-background border border-border/20 rounded-xl px-3 py-2 text-sm" />
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
                      className="px-4 py-2 rounded-xl bg-primary/10 border border-primary/30 text-primary text-sm font-semibold"
                    >
                      Add
                    </button>
                  </div>
                </div>
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
