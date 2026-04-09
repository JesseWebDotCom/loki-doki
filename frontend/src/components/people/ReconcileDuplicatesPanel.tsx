import { useMemo, useState } from "react";
import { ArrowRightLeft, CheckCircle2, Combine, RefreshCcw, UserRound } from "lucide-react";
import { mergeStructuredPeople } from "../../lib/api";
import type { ReconcileCandidate, ReconcileGroup } from "../../lib/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";

type Props = {
  groups: ReconcileGroup[];
  onRefresh: () => Promise<void>;
  onFocusPerson: (id: number) => void;
  onMerged?: (survivorId: number) => void;
};

type ReviewState = {
  group: ReconcileGroup;
  sourceId: number;
  intoId: number;
} | null;

function photoThumb(candidate: ReconcileCandidate) {
  if (candidate.preferred_photo_url) {
    return (
      <img
        src={candidate.preferred_photo_url}
        alt={candidate.name}
        className="h-16 w-16 rounded-2xl border border-border/20 object-cover"
      />
    );
  }
  return (
    <div className="flex h-16 w-16 items-center justify-center rounded-2xl border border-primary/20 bg-primary/10 text-xl font-bold text-primary">
      {(candidate.name || "?").slice(0, 1).toUpperCase()}
    </div>
  );
}

function CompareCard({
  candidate,
  isTarget,
  onChooseTarget,
  onFocus,
}: {
  candidate: ReconcileCandidate;
  isTarget: boolean;
  onChooseTarget: () => void;
  onFocus: () => void;
}) {
  const statLine = [
    `${candidate.fact_count ?? 0} facts`,
    `${candidate.event_count ?? 0} events`,
    `${candidate.media_count ?? 0} photos`,
    `${candidate.edge_count ?? 0} links`,
  ].join(" • ");

  return (
    <div className={`rounded-3xl border p-4 ${isTarget ? "border-primary/30 bg-primary/10" : "border-border/20 bg-background/70"}`}>
      <div className="flex items-start gap-3">
        {photoThumb(candidate)}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="truncate text-lg font-semibold">{candidate.name}</div>
            {candidate.linked_user_id && (
              <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[10px] uppercase tracking-wide text-emerald-300">
                Linked user
              </span>
            )}
            {isTarget && (
              <span className="rounded-full bg-primary/15 px-2 py-1 text-[10px] uppercase tracking-wide text-primary">
                Keeps surviving
              </span>
            )}
          </div>
          <div className="text-sm text-muted-foreground">
            {candidate.bucket || "person"} • {candidate.living_status || "unknown"}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            {candidate.linked_username ? `User: ${candidate.linked_username}` : "No linked app user"}
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 text-sm">
        <div className="rounded-2xl bg-card/60 px-3 py-2">{statLine}</div>
        <div className="rounded-2xl bg-card/60 px-3 py-2">
          Overlay: {candidate.relationship_state || "active"} • {candidate.interaction_preference || "normal"}
        </div>
        <div className="rounded-2xl bg-card/60 px-3 py-2">
          Birth date: {candidate.birth_date || "Unknown"}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onChooseTarget}
          className={`rounded-xl border px-3 py-2 text-xs font-semibold ${isTarget ? "border-primary/30 bg-primary/15 text-primary" : "border-border/20 bg-card/70"}`}
        >
          {isTarget ? "Surviving record" : "Keep this record"}
        </button>
        <button
          type="button"
          onClick={onFocus}
          className="rounded-xl border border-border/20 bg-card/70 px-3 py-2 text-xs"
        >
          Focus in People
        </button>
      </div>
    </div>
  );
}

function ReconcileReviewDialog({
  state,
  onClose,
  onConfirm,
  onChooseTarget,
  onFocusPerson,
}: {
  state: ReviewState;
  onClose: () => void;
  onConfirm: () => void;
  onChooseTarget: (targetId: number) => void;
  onFocusPerson: (id: number) => void;
}) {
  const candidates = state?.group.candidates ?? [];
  const source = candidates.find((candidate) => candidate.id === state?.sourceId) ?? null;
  const target = candidates.find((candidate) => candidate.id === state?.intoId) ?? null;

  return (
    <Dialog open={Boolean(state)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-5xl border-border/20 bg-card/95 p-0 shadow-m4">
        {state && source && target && (
          <div className="max-h-[85vh] overflow-auto p-6">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Combine className="h-5 w-5 text-primary" />
                Review duplicate merge
              </DialogTitle>
              <DialogDescription>
                Compare both records before merging. The surviving record keeps its ID while facts, media, links, and graph connections move into it.
              </DialogDescription>
            </DialogHeader>

            <div className="mt-6 flex items-center justify-between rounded-2xl border border-border/20 bg-background/60 px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                Suggested survivor: <span className="font-semibold">{target.name}</span>
              </div>
              <div className="text-muted-foreground">{state.group.suggestion_reason}</div>
            </div>

            <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1fr)_4rem_minmax(0,1fr)]">
              <CompareCard
                candidate={target}
                isTarget
                onChooseTarget={() => onChooseTarget(target.id)}
                onFocus={() => onFocusPerson(target.id)}
              />
              <div className="hidden items-center justify-center lg:flex">
                <ArrowRightLeft className="h-5 w-5 text-muted-foreground" />
              </div>
              <CompareCard
                candidate={source}
                isTarget={false}
                onChooseTarget={() => onChooseTarget(source.id)}
                onFocus={() => onFocusPerson(source.id)}
              />
            </div>

            <DialogFooter className="mt-6 gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-xl border border-border/20 bg-background/80 px-4 py-2 text-sm"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                className="rounded-xl border border-primary/30 bg-primary/10 px-4 py-2 text-sm font-semibold text-primary"
              >
                Merge into {target.name}
              </button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ReconcileDuplicatesPanel({
  groups,
  onRefresh,
  onFocusPerson,
  onMerged,
}: Props) {
  const [reviewState, setReviewState] = useState<ReviewState>(null);
  const [isMerging, setIsMerging] = useState(false);

  const sortedGroups = useMemo(
    () => [...groups].sort((a, b) => a.label.localeCompare(b.label)),
    [groups],
  );

  const openReview = (group: ReconcileGroup) => {
    const targetId = group.suggested_target_id;
    const sourceId = group.candidates.find((candidate) => candidate.id !== targetId)?.id ?? targetId;
    setReviewState({ group, intoId: targetId, sourceId });
  };

  const swapTarget = (targetId: number) => {
    setReviewState((current) => {
      if (!current) return current;
      const nextSourceId = current.group.candidates.find((candidate) => candidate.id !== targetId)?.id ?? targetId;
      return {
        ...current,
        intoId: targetId,
        sourceId: nextSourceId,
      };
    });
  };

  const confirmMerge = async () => {
    if (!reviewState || reviewState.intoId === reviewState.sourceId) {
      return;
    }
    setIsMerging(true);
    try {
      await mergeStructuredPeople(reviewState.sourceId, reviewState.intoId);
      await onRefresh();
      onMerged?.(reviewState.intoId);
      setReviewState(null);
    } finally {
      setIsMerging(false);
    }
  };

  return (
    <>
      <div className="rounded-2xl border border-border/20 bg-background/70 p-5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-semibold">Reconcile duplicates</div>
            <div className="text-sm text-muted-foreground">
              Review likely duplicates at any time and merge them into one canonical person.
            </div>
          </div>
          <button
            type="button"
            onClick={() => void onRefresh()}
            className="rounded-xl border border-border/20 bg-card/60 px-3 py-2 text-xs font-semibold"
          >
            <RefreshCcw className="mr-2 inline h-3.5 w-3.5" />
            Refresh suggestions
          </button>
        </div>

        {sortedGroups.length === 0 ? (
          <div className="text-sm italic text-muted-foreground">No duplicate candidates right now.</div>
        ) : (
          sortedGroups.map((group) => {
            const target = group.candidates.find((candidate) => candidate.id === group.suggested_target_id) ?? group.candidates[0];
            return (
              <div key={`${group.label}-${group.candidates.map((candidate) => candidate.id).join("-")}`} className="rounded-2xl border border-border/10 bg-card/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-sm font-semibold">{group.label}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      Suggested survivor: {target.name} ({group.suggestion_reason})
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => openReview(group)}
                    className="rounded-xl border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary"
                  >
                    Review merge
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {group.candidates.map((candidate) => (
                    <button
                      key={candidate.id}
                      type="button"
                      onClick={() => onFocusPerson(candidate.id)}
                      className={`rounded-xl border px-3 py-2 text-left text-xs ${candidate.id === group.suggested_target_id ? "border-primary/30 bg-primary/10" : "border-border/20 bg-background/70"}`}
                    >
                      <div className="flex items-center gap-2">
                        <UserRound className="h-3.5 w-3.5" />
                        #{candidate.id} {candidate.name}
                      </div>
                      <div className="mt-1 text-muted-foreground">
                        {(candidate.fact_count ?? 0) + (candidate.event_count ?? 0) + (candidate.media_count ?? 0) + (candidate.edge_count ?? 0)} data points
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>

      <ReconcileReviewDialog
        state={reviewState}
        onClose={() => { if (!isMerging) setReviewState(null); }}
        onConfirm={() => { void confirmMerge(); }}
        onChooseTarget={swapTarget}
        onFocusPerson={onFocusPerson}
      />
    </>
  );
}
