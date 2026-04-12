import { useMemo, useState } from "react";
import { Crosshair, GitBranch, Minus, PanelRightOpen, Plus, RotateCcw, ScanSearch, UserRoundCheck } from "lucide-react";
import type { PeopleEdge, Person } from "../../lib/api-types";
import { buildGraphPeopleMap } from "./graphPeople";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";

// ---- edge helpers (same logic as treeLayout.ts) --------------------------

const PARENT_TERMS = new Set([
  "parent", "mother", "father", "mom", "dad", "mama", "papa",
  "step-mom", "step-dad", "stepmom", "stepdad",
]);
const CHILD_TERMS = new Set([
  "child", "son", "daughter", "kid",
]);
const SPOUSE_TERMS = new Set([
  "spouse", "wife", "husband", "partner", "fiancé", "fiancée",
  "fiance", "fiancee", "ex", "ex-wife", "ex-husband",
]);

function findParents(id: number, edges: PeopleEdge[], peopleMap: Map<number, Person>): Person[] {
  const ids = new Set<number>();
  for (const e of edges) {
    const et = (e.edge_type || "").toLowerCase().trim();
    if (PARENT_TERMS.has(et) && e.to_person_id === id && peopleMap.has(e.from_person_id)) ids.add(e.from_person_id);
    if (CHILD_TERMS.has(et) && e.from_person_id === id && peopleMap.has(e.to_person_id)) ids.add(e.to_person_id);
  }
  return [...ids].map((pid) => peopleMap.get(pid)!);
}

function findChildren(id: number, edges: PeopleEdge[], peopleMap: Map<number, Person>): Person[] {
  const ids = new Set<number>();
  for (const e of edges) {
    const et = (e.edge_type || "").toLowerCase().trim();
    if (PARENT_TERMS.has(et) && e.from_person_id === id && peopleMap.has(e.to_person_id)) ids.add(e.to_person_id);
    if (CHILD_TERMS.has(et) && e.to_person_id === id && peopleMap.has(e.from_person_id)) ids.add(e.from_person_id);
  }
  return [...ids].map((pid) => peopleMap.get(pid)!);
}

function findSpouses(id: number, edges: PeopleEdge[], peopleMap: Map<number, Person>): Person[] {
  const ids = new Set<number>();
  for (const e of edges) {
    const et = (e.edge_type || "").toLowerCase().trim();
    if (!SPOUSE_TERMS.has(et)) continue;
    if (e.from_person_id === id && peopleMap.has(e.to_person_id)) ids.add(e.to_person_id);
    if (e.to_person_id === id && peopleMap.has(e.from_person_id)) ids.add(e.from_person_id);
  }
  return [...ids].map((pid) => peopleMap.get(pid)!);
}

type AncestorBranch = {
  person: Person;
  grandparents: Person[];
  parents: Person[];
};

/** Filter out people with garbage GEDCOM IDs or unnamed entries. */
function isValidPerson(p: Person): boolean {
  const name = (p.name || "").trim();
  return !!name && !name.startsWith("@") && !name.toLowerCase().startsWith("unnamed");
}

// ---- tiny components -----------------------------------------------------

function Photo({ person, size = "w-10 h-10" }: { person: Person; size?: string }) {
  if (person.preferred_photo_url) {
    return <img src={person.preferred_photo_url} alt={person.name} className={`${size} rounded-xl object-cover border border-border/30`} />;
  }
  return (
    <div className={`${size} rounded-xl border border-primary/20 bg-primary/10 text-primary font-bold flex items-center justify-center text-sm`}>
      {(person.name || "?").charAt(0).toUpperCase()}
    </div>
  );
}

function PersonCard({
  person,
  roleLabel,
  isFocused,
  isYou,
  onClick,
  onViewDetails,
  onShowAll,
}: {
  person: Person;
  roleLabel?: string;
  isFocused?: boolean;
  isYou?: boolean;
  onClick: () => void;
  onViewDetails?: () => void;
  onShowAll?: () => void;
}) {
  const dead = person.living_status === "deceased";
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          className={`
            rounded-2xl border p-3 text-left transition-all w-[11rem] shrink-0
            ${isFocused
              ? "border-primary/40 bg-primary/10 shadow-[0_8px_30px_rgba(140,92,255,0.2)] scale-105"
              : "border-border/20 bg-background/90 hover:bg-card/90 hover:border-border/40"}
            ${dead ? "opacity-55" : ""}
          `}
        >
          <div className="flex items-center gap-2.5">
            <Photo person={person} size={isFocused ? "w-12 h-12" : "w-10 h-10"} />
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-[13px] leading-tight truncate">
                {person.name}
              </div>
              {roleLabel && (
                <span className="inline-block mt-0.5 rounded-full bg-primary/15 px-1.5 py-[1px] text-[9px] font-bold text-primary capitalize">
                  {roleLabel}
                </span>
              )}
              {isYou && !roleLabel && (
                <span className="inline-block mt-0.5 rounded-full bg-primary/15 px-1.5 py-[1px] text-[9px] font-bold text-primary uppercase tracking-wide">
                  You
                </span>
              )}
              <div className="text-[9px] text-muted-foreground mt-0.5 truncate leading-tight">
                {person.birth_date && `b. ${person.birth_date.slice(0, 4)}`}
                {dead && person.death_date && ` · d. ${person.death_date.slice(0, 4)}`}
              </div>
            </div>
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onClick}><ScanSearch className="mr-2 h-4 w-4" />Focus</ContextMenuItem>
        {onShowAll && <ContextMenuItem onSelect={onShowAll}><GitBranch className="mr-2 h-4 w-4" />View all</ContextMenuItem>}
        {onViewDetails && <ContextMenuItem onSelect={onViewDetails}><PanelRightOpen className="mr-2 h-4 w-4" />Details</ContextMenuItem>}
        {isYou && <ContextMenuItem disabled><UserRoundCheck className="mr-2 h-4 w-4" />You</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Vertical connector line between rows. */
function VerticalLine() {
  return <div className="mx-auto h-8 w-[2px] rounded-full bg-primary/30 shadow-[0_0_12px_rgba(140,92,255,0.2)]" />;
}


/** A row of person cards with an optional label above. */
function GenerationRow({
  label,
  people: rowPeople,
  roleLabel,
  focusedId,
  currentUserPersonId,
  onSelect,
  onShowAll,
  onViewDetails,
}: {
  label: string;
  people: Person[];
  roleLabel: string;
  focusedId: number;
  currentUserPersonId?: number | null;
  onSelect: (id: number) => void;
  onShowAll: () => void;
  onViewDetails?: () => void;
}) {
  if (rowPeople.length === 0) return null;
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">{label}</div>
      <div className="flex flex-wrap justify-center gap-3">
        {rowPeople.map((p) => (
          <PersonCard
            key={p.id}
            person={p}
            roleLabel={p.id === focusedId ? undefined : roleLabel}
            isFocused={p.id === focusedId}
            isYou={currentUserPersonId === p.id}
            onClick={() => onSelect(p.id)}
            onShowAll={onShowAll}
            onViewDetails={onViewDetails}
          />
        ))}
      </div>
    </div>
  );
}

function AncestorBranchColumn({
  branch,
  focusedId,
  currentUserPersonId,
  onSelect,
  onShowAll,
  onViewDetails,
}: {
  branch: AncestorBranch;
  focusedId: number;
  currentUserPersonId?: number | null;
  onSelect: (id: number) => void;
  onShowAll: () => void;
  onViewDetails?: () => void;
}) {
  return (
    <div className="flex min-w-[24rem] flex-1 flex-col items-center gap-1 px-2">
      <GenerationRow
        label="Grandparents"
        people={branch.grandparents}
        roleLabel="Grandparent"
        focusedId={focusedId}
        currentUserPersonId={currentUserPersonId}
        onSelect={onSelect}
        onShowAll={onShowAll}
        onViewDetails={onViewDetails}
      />
      {branch.grandparents.length > 0 && <VerticalLine />}
      <GenerationRow
        label="Parents"
        people={branch.parents}
        roleLabel="Parent"
        focusedId={focusedId}
        currentUserPersonId={currentUserPersonId}
        onSelect={onSelect}
        onShowAll={onShowAll}
        onViewDetails={onViewDetails}
      />
      {branch.parents.length > 0 && <VerticalLine />}
    </div>
  );
}

// ---- main canvas ---------------------------------------------------------

type Props = {
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
}: Props) {
  const [zoom, setZoom] = useState(1);
  const peopleMap = useMemo(() => buildGraphPeopleMap(people, edges), [people, edges]);

  // Build the pedigree: direct ancestors up, descendants down.
  const pedigree = useMemo(() => {
    if (!selectedPerson) return null;
    const id = selectedPerson.id;
    const spouses = findSpouses(id, edges, peopleMap).filter(isValidPerson);
    const center = [selectedPerson, ...spouses.filter((s) => s.id !== selectedPerson.id)];
    const branches: AncestorBranch[] = center.map((person) => {
      const parents = findParents(person.id, edges, peopleMap).filter(isValidPerson).slice(0, 2);
      const grandparents: Person[] = [];
      for (const parent of parents) {
        for (const gp of findParents(parent.id, edges, peopleMap).filter(isValidPerson).slice(0, 2)) {
          if (!grandparents.some((x) => x.id === gp.id)) grandparents.push(gp);
        }
      }
      return { person, parents, grandparents };
    });
    const childIds = new Set<number>();
    const children: Person[] = [];
    for (const c of findChildren(id, edges, peopleMap).filter(isValidPerson)) {
      if (!childIds.has(c.id)) { childIds.add(c.id); children.push(c); }
    }
    for (const s of spouses) {
      for (const c of findChildren(s.id, edges, peopleMap).filter(isValidPerson)) {
        if (!childIds.has(c.id)) { childIds.add(c.id); children.push(c); }
      }
    }
    const grandchildren: Person[] = [];
    const gcIds = new Set<number>();
    for (const c of children) {
      for (const gc of findChildren(c.id, edges, peopleMap).filter(isValidPerson)) {
        if (!gcIds.has(gc.id)) { gcIds.add(gc.id); grandchildren.push(gc); }
      }
    }
    return { branches, center, children, grandchildren };
  }, [selectedPerson, edges, peopleMap]);

  return (
    <div className="h-full flex flex-col gap-3" data-testid="people-tree-view">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <GitBranch size={18} className="text-primary" />
          <select
            aria-label="focused person"
            value={selectedPerson ? String(selectedPerson.id) : "all"}
            onChange={(e) => e.target.value === "all" ? onClearFocus() : onSelectPerson(Number(e.target.value))}
            className="bg-background/80 border border-border/20 rounded-xl px-3 py-2 text-sm"
          >
            <option value="all">Entire tree</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2">
          {currentUserPersonId && onJumpToCurrentUser && (
            <button type="button" onClick={onJumpToCurrentUser} className="h-9 px-3 rounded-xl border border-primary/30 bg-primary/10 text-xs font-semibold flex items-center gap-2 text-primary">
              <Crosshair size={12} /> Jump to me
            </button>
          )}
          <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} className="h-9 w-9 rounded-xl border border-border/20 bg-background/80 flex items-center justify-center"><Minus size={14} /></button>
          <div className="min-w-[3.5rem] text-center text-xs font-semibold text-muted-foreground">{Math.round(zoom * 100)}%</div>
          <button type="button" onClick={() => setZoom((z) => Math.min(2, +(z + 0.1).toFixed(2)))} className="h-9 w-9 rounded-xl border border-border/20 bg-background/80 flex items-center justify-center"><Plus size={14} /></button>
          <button type="button" onClick={() => { setZoom(1); onClearFocus(); }} className="h-9 px-3 rounded-xl border border-border/20 bg-background/80 text-xs font-semibold flex items-center gap-2"><RotateCcw size={12} /> Reset</button>
        </div>
      </div>

      {/* Canvas */}
      <div
        className="flex-1 overflow-auto rounded-[2rem] border border-border/10 bg-[radial-gradient(circle_at_top,rgba(134,86,255,0.15),transparent_40%)]"
        onClick={(e) => { if (e.target === e.currentTarget) onCanvasBackgroundClick?.(); }}
      >
        <div
          className="p-8 origin-top transition-transform"
          style={{ transform: `scale(${zoom})` }}
          onClick={(e) => { if (e.target === e.currentTarget) onCanvasBackgroundClick?.(); }}
        >
          {!selectedPerson ? (
            /* Entire tree: flat grid */
            <div>
              <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground mb-4 font-semibold">All visible people</div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {people.length === 0
                  ? <div className="text-sm text-muted-foreground italic col-span-full">No visible people yet.</div>
                  : people.map((p) => (
                    <PersonCard
                      key={p.id}
                      person={p}
                      onClick={() => onSelectPerson(p.id)}
                      isYou={currentUserPersonId === p.id}
                      onShowAll={onClearFocus}
                      onViewDetails={onRequestDetails}
                    />
                  ))}
              </div>
            </div>
          ) : pedigree && (
            /* Pedigree: vertical stack of generations */
            <div className="mx-auto flex min-w-max flex-col items-center gap-3 px-6">
              <div className="flex flex-nowrap items-start justify-center gap-8">
                {pedigree.branches.map((branch) => (
                  <AncestorBranchColumn
                    key={branch.person.id}
                    branch={branch}
                    focusedId={selectedPerson.id}
                    currentUserPersonId={currentUserPersonId}
                    onSelect={onSelectPerson}
                    onShowAll={onClearFocus}
                    onViewDetails={onRequestDetails}
                  />
                ))}
              </div>

              {/* Center: focused person + spouse(s) */}
              <div className="flex flex-col items-center gap-2">
                <div className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground font-semibold">
                  {pedigree.center.length > 1 ? "You & Spouse" : "Focused"}
                </div>
                <div className="flex flex-nowrap justify-center gap-8">
                  {pedigree.center.map((p, i) => (
                    <PersonCard
                      key={p.id}
                      person={p}
                      roleLabel={i > 0 ? "Spouse" : undefined}
                      isFocused={p.id === selectedPerson.id}
                      isYou={currentUserPersonId === p.id}
                      onClick={() => onSelectPerson(p.id)}
                      onShowAll={onClearFocus}
                      onViewDetails={onRequestDetails}
                    />
                  ))}
                </div>
              </div>

              {pedigree.children.length > 0 && <VerticalLine />}
              <GenerationRow label="Children" people={pedigree.children} roleLabel="Child" focusedId={selectedPerson.id} currentUserPersonId={currentUserPersonId} onSelect={onSelectPerson} onShowAll={onClearFocus} onViewDetails={onRequestDetails} />

              {pedigree.grandchildren.length > 0 && <VerticalLine />}
              <GenerationRow label="Grandchildren" people={pedigree.grandchildren} roleLabel="Grandchild" focusedId={selectedPerson.id} currentUserPersonId={currentUserPersonId} onSelect={onSelectPerson} onShowAll={onClearFocus} onViewDetails={onRequestDetails} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
