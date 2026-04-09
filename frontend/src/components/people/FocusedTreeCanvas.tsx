import { useMemo, useState } from "react";
import { Crosshair, GitBranch, Minus, PanelRightOpen, Plus, RotateCcw, ScanSearch, UserRoundCheck } from "lucide-react";
import type { PeopleEdge, Person } from "../../lib/api";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";

function Photo({ person, className = "w-12 h-12" }: { person: Person; className?: string }) {
  if (person.preferred_photo_url) {
    return <img src={person.preferred_photo_url} alt={person.name} className={`${className} rounded-xl object-cover border border-border/30`} />;
  }
  return (
    <div className={`${className} rounded-xl border border-primary/20 bg-primary/10 text-primary font-bold flex items-center justify-center`}>
      {(person.name || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

function PersonCard({
  person,
  caption,
  onClick,
  onShowAll,
  isYou = false,
  emphasis = "default",
  detailHint,
  onViewDetails,
}: {
  person: Person;
  caption: string;
  onClick: () => void;
  onShowAll?: () => void;
  isYou?: boolean;
  emphasis?: "default" | "focused";
  detailHint?: string;
  onViewDetails?: () => void;
}) {
  const cardTone =
    emphasis === "focused"
      ? "border-primary/30 bg-primary/10 shadow-[0_12px_40px_rgba(140,92,255,0.18)]"
      : "border-border/20 bg-background/80 hover:bg-card/80";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={`rounded-3xl border p-4 text-left transition-all ${cardTone} w-[15rem] sm:w-[16rem]`}
        >
          <div className="flex items-center gap-3">
            <Photo person={person} className="w-14 h-14 sm:w-16 sm:h-16" />
            <div className="min-w-0">
              <div className="font-semibold truncate flex items-center gap-2">
                {person.name}
                {isYou && (
                  <span className="rounded-full bg-primary/15 px-2 py-1 text-[10px] uppercase tracking-wide text-primary">
                    This is you
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground capitalize truncate">
                {person.bucket || "person"} • {person.living_status || "unknown"}
              </div>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] uppercase tracking-wide">
            <span className="rounded-full bg-card/80 px-2 py-1 text-muted-foreground">{caption}</span>
            {person.relationship_state && (
              <span className="rounded-full bg-card/80 px-2 py-1 text-muted-foreground">{person.relationship_state}</span>
            )}
            {person.interaction_preference && (
              <span className="rounded-full bg-card/80 px-2 py-1 text-muted-foreground">{person.interaction_preference}</span>
            )}
          </div>
          {detailHint && (
            <div className="mt-3 text-xs text-muted-foreground">
              {detailHint}
            </div>
          )}
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onClick}>
          <ScanSearch className="mr-2 h-4 w-4" />
          Focus this person
        </ContextMenuItem>
        {onShowAll && (
          <ContextMenuItem onSelect={onShowAll}>
            <GitBranch className="mr-2 h-4 w-4" />
            View entire tree
          </ContextMenuItem>
        )}
        {onViewDetails && (
          <ContextMenuItem onSelect={onViewDetails}>
            <PanelRightOpen className="mr-2 h-4 w-4" />
            View details
          </ContextMenuItem>
        )}
        {isYou && (
          <ContextMenuItem disabled>
            <UserRoundCheck className="mr-2 h-4 w-4" />
            Linked to your account
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

type FocusedTreeCanvasProps = {
  people: Person[];
  selectedPerson: Person | null;
  edges: PeopleEdge[];
  onSelectPerson: (id: number) => void;
  onClearFocus: () => void;
  currentUserPersonId?: number | null;
  onJumpToCurrentUser?: () => void;
  onRequestDetails?: () => void;
  onCanvasBackgroundClick?: () => void;
};

export function FocusedTreeCanvas({
  people,
  selectedPerson,
  edges,
  onSelectPerson,
  onClearFocus,
  currentUserPersonId,
  onJumpToCurrentUser,
  onRequestDetails,
  onCanvasBackgroundClick,
}: FocusedTreeCanvasProps) {
  const [zoom, setZoom] = useState(1);

  const relations = useMemo(() => {
    if (!selectedPerson) {
      return { parents: [], partners: [], children: [], others: [] } as Record<string, Array<{ edge: PeopleEdge; person: Person }>>;
    }
    const toTarget = (edge: PeopleEdge) => {
      const targetId = edge.from_person_id === selectedPerson.id ? edge.to_person_id : edge.from_person_id;
      const person = people.find((entry) => entry.id === targetId);
      return person ? { edge, person } : null;
    };
    const fromEdges = edges.map(toTarget).filter(Boolean) as Array<{ edge: PeopleEdge; person: Person }>;
    return {
      parents: fromEdges.filter(({ edge }) => edge.edge_type === "child" && edge.from_person_id === selectedPerson.id),
      partners: fromEdges.filter(({ edge }) => edge.edge_type === "spouse" && edge.from_person_id === selectedPerson.id),
      children: fromEdges.filter(({ edge }) => edge.edge_type === "parent" && edge.from_person_id === selectedPerson.id),
      others: fromEdges.filter(({ edge }) => !["child", "spouse", "parent"].includes(edge.edge_type)),
    };
  }, [edges, people, selectedPerson]);

  const focusSummary = useMemo(() => {
    if (!selectedPerson) {
      return "";
    }
    const pieces = [
      relations.parents.length ? `${relations.parents.length} upstream` : "",
      relations.partners.length ? `${relations.partners.length} partner${relations.partners.length === 1 ? "" : "s"}` : "",
      relations.children.length ? `${relations.children.length} downstream` : "",
      relations.others.length ? `${relations.others.length} other link${relations.others.length === 1 ? "" : "s"}` : "",
    ].filter(Boolean);
    return pieces.join(" • ");
  }, [relations, selectedPerson]);

  return (
    <div className="h-full flex flex-col gap-4" data-testid="people-tree-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <GitBranch size={18} className="text-primary" />
          <select
            aria-label="focused person"
            value={selectedPerson ? String(selectedPerson.id) : "all"}
            onChange={(e) => {
              if (e.target.value === "all") {
                onClearFocus();
                return;
              }
              onSelectPerson(Number(e.target.value));
            }}
            className="bg-background/80 border border-border/20 rounded-xl px-3 py-2 text-sm"
          >
            <option value="all">Entire tree</option>
            {people.map((person) => (
              <option key={person.id} value={person.id}>{person.name}</option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          {currentUserPersonId && onJumpToCurrentUser && (
            <button
              type="button"
              onClick={onJumpToCurrentUser}
              className="h-9 px-3 rounded-xl border border-primary/30 bg-primary/10 text-xs font-semibold flex items-center gap-2 text-primary"
            >
              <Crosshair size={12} />
              Jump to me
            </button>
          )}
          <button type="button" onClick={() => setZoom((prev) => Math.max(0.75, Number((prev - 0.1).toFixed(2))))} className="h-9 w-9 rounded-xl border border-border/20 bg-background/80 flex items-center justify-center">
            <Minus size={14} />
          </button>
          <div className="min-w-[4.5rem] text-center text-xs font-semibold text-muted-foreground">
            {Math.round(zoom * 100)}%
          </div>
          <button type="button" onClick={() => setZoom((prev) => Math.min(1.5, Number((prev + 0.1).toFixed(2))))} className="h-9 w-9 rounded-xl border border-border/20 bg-background/80 flex items-center justify-center">
            <Plus size={14} />
          </button>
          <button type="button" onClick={() => { setZoom(1); onClearFocus(); }} className="h-9 px-3 rounded-xl border border-border/20 bg-background/80 text-xs font-semibold flex items-center gap-2">
            <RotateCcw size={12} />
            Reset
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-auto rounded-[2rem] border border-border/10 bg-[radial-gradient(circle_at_top,rgba(134,86,255,0.18),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.03),rgba(255,255,255,0))]"
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            onCanvasBackgroundClick?.();
          }
        }}
      >
        <div
          className="min-w-[72rem] p-6 sm:p-10 origin-top transition-transform"
          style={{ transform: `scale(${zoom})` }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              onCanvasBackgroundClick?.();
            }
          }}
        >
          {!selectedPerson ? (
            <div className="mx-auto max-w-[64rem] space-y-6">
              <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Entire visible tree</div>
              <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
                {people.length === 0 ? (
                  <div className="text-sm text-muted-foreground italic">No visible people yet.</div>
                ) : people.map((person) => (
                  <PersonCard
                    key={person.id}
                    person={person}
                    caption="visible"
                    onClick={() => onSelectPerson(person.id)}
                    onShowAll={onClearFocus}
                    isYou={currentUserPersonId === person.id}
                    onViewDetails={onRequestDetails}
                  />
                ))}
              </div>
            </div>
          ) : (
          <div className="mx-auto max-w-[66rem] grid gap-8">
            {relations.parents.length > 0 && (
              <>
                <section className="flex flex-col items-center gap-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Parents / upstream</div>
                  {relations.parents.length > 1 && (
                    <div className="h-[3px] w-[32rem] rounded-full bg-primary/30 shadow-[0_0_20px_rgba(140,92,255,0.25)]" />
                  )}
                  <div className="flex flex-wrap justify-center gap-6">
                    {relations.parents.map(({ edge, person }) => (
                      <PersonCard key={edge.id} person={person} caption={edge.edge_type} onClick={() => onSelectPerson(person.id)} onShowAll={onClearFocus} isYou={currentUserPersonId === person.id} onViewDetails={onRequestDetails} />
                    ))}
                  </div>
                </section>
                <div className="mx-auto h-12 w-[3px] rounded-full bg-primary/30 shadow-[0_0_24px_rgba(140,92,255,0.24)]" />
              </>
            )}

            <section className="flex flex-col items-center gap-4">
              <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Focused person</div>
              <div className="flex flex-wrap justify-center gap-6">
                <PersonCard
                  person={selectedPerson}
                  caption="focus"
                  onClick={() => onSelectPerson(selectedPerson.id)}
                  onShowAll={onClearFocus}
                  isYou={currentUserPersonId === selectedPerson.id}
                  emphasis="focused"
                  detailHint={focusSummary || "Focused mini tree"}
                  onViewDetails={onRequestDetails}
                />
                {relations.partners.map(({ edge, person }) => (
                  <PersonCard key={edge.id} person={person} caption={edge.edge_type} onClick={() => onSelectPerson(person.id)} onShowAll={onClearFocus} isYou={currentUserPersonId === person.id} onViewDetails={onRequestDetails} />
                ))}
              </div>
            </section>

            {relations.children.length > 0 && (
              <>
                <div className="mx-auto h-12 w-[3px] rounded-full bg-primary/30 shadow-[0_0_24px_rgba(140,92,255,0.24)]" />
                <section className="flex flex-col items-center gap-4">
                  <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">Children / downstream</div>
                  {relations.children.length > 1 && (
                    <div className="h-[3px] w-[42rem] rounded-full bg-primary/35 shadow-[0_0_20px_rgba(140,92,255,0.28)]" />
                  )}
                  <div className="flex flex-wrap justify-center gap-6">
                    {relations.children.map(({ edge, person }) => (
                      <PersonCard key={edge.id} person={person} caption={edge.edge_type} onClick={() => onSelectPerson(person.id)} onShowAll={onClearFocus} isYou={currentUserPersonId === person.id} onViewDetails={onRequestDetails} />
                    ))}
                  </div>
                </section>
              </>
            )}

            <section className="rounded-3xl border border-border/20 bg-background/50 p-5">
              <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground mb-4">Other visible links</div>
              <div className="flex flex-wrap gap-4">
                {relations.others.length === 0 ? (
                  <div className="text-sm text-muted-foreground italic">No additional visible links.</div>
                ) : (
                  relations.others.map(({ edge, person }) => (
                    <PersonCard key={edge.id} person={person} caption={edge.edge_type} onClick={() => onSelectPerson(person.id)} onShowAll={onClearFocus} isYou={currentUserPersonId === person.id} onViewDetails={onRequestDetails} />
                  ))
                )}
              </div>
            </section>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}
