"""Retrieval-first referent resolution between decomposition and routing."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

from lokidoki.core.decomposer import Ask
from lokidoki.core.model_manager import ModelManager
from lokidoki.core.orchestrator_skills import execute_capability_lookup
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor


AUTO_RESOLVE_SCORE = 5.0
AUTO_RESOLVE_MARGIN = 1.0
FALLBACK_MARGIN = 1.0
FALLBACK_NUM_PREDICT = 96


@dataclass
class ReferentCandidate:
    candidate_id: str
    type: str
    display_name: str
    canonical_name: str
    source: str
    source_ref: str
    score: float
    metadata: dict = field(default_factory=dict)


@dataclass
class ReferentResolution:
    status: str = "none"
    chosen_candidate: Optional[ReferentCandidate] = None
    candidates: list[ReferentCandidate] = field(default_factory=list)
    source: str = "none"
    clarification_hint: str = ""


@dataclass
class EnrichedAsk:
    ask: Ask
    resolution: ReferentResolution = field(default_factory=ReferentResolution)
    enriched_query: str = ""

    def __getattr__(self, name: str) -> Any:
        return getattr(self.ask, name)


class ReferentResolver:
    def __init__(
        self,
        *,
        inference_client: Any,
        model_manager: ModelManager,
        registry: Optional[SkillRegistry],
        executor: Optional[SkillExecutor],
    ):
        self._inference = inference_client
        self._model_manager = model_manager
        self._registry = registry
        self._executor = executor

    async def resolve_asks(
        self,
        *,
        user_input: str,
        asks: list[Ask],
        recent: list[dict],
        relevant_facts: list[dict],
        past_messages: list[dict],
        people: list[dict],
        relationships: list[dict],
        known_entities: list[str],
        session_cache: dict,
        user_id: Optional[int],
        memory: Any,
    ) -> list[EnrichedAsk]:
        out: list[EnrichedAsk] = []
        session_candidates = list(session_cache.get("resolved_referents") or [])

        for ask in asks:
            if not getattr(ask, "needs_referent_resolution", False):
                out.append(EnrichedAsk(ask=ask))
                continue

            candidates = self._collect_candidates(
                ask=ask,
                relevant_facts=relevant_facts,
                people=people,
                relationships=relationships,
                known_entities=known_entities,
                session_candidates=session_candidates,
            )
            candidates.sort(key=lambda c: c.score, reverse=True)

            resolution = self._resolve_from_candidates(candidates)
            if resolution.status != "resolved" and getattr(ask, "capability_need", "none") != "none":
                looked_up = await self._resolve_via_capability(
                    ask=ask,
                    user_id=user_id,
                    memory=memory,
                )
                if looked_up is not None:
                    candidates.append(looked_up)
                    candidates.sort(key=lambda c: c.score, reverse=True)
                    resolution = self._resolve_from_candidates(candidates)

            if resolution.status != "resolved":
                resolution = await self._resolve_with_fallback(
                    user_input=user_input,
                    ask=ask,
                    candidates=candidates,
                    recent=recent,
                )

            enriched = EnrichedAsk(
                ask=ask,
                resolution=resolution,
                enriched_query=self._enrich_query(ask, resolution),
            )
            out.append(enriched)
            if resolution.chosen_candidate is not None:
                session_candidates.insert(0, resolution.chosen_candidate)

        session_cache["resolved_referents"] = session_candidates[:8]
        return out

    def _collect_candidates(
        self,
        *,
        ask: Ask,
        relevant_facts: list[dict],
        people: list[dict],
        relationships: list[dict],
        known_entities: list[str],
        session_candidates: list[ReferentCandidate],
    ) -> list[ReferentCandidate]:
        candidates: list[ReferentCandidate] = []

        for idx, cand in enumerate(session_candidates):
            if self._type_matches(ask, cand.type):
                candidates.append(ReferentCandidate(
                    candidate_id=cand.candidate_id,
                    type=cand.type,
                    display_name=cand.display_name,
                    canonical_name=cand.canonical_name,
                    source="recent_context",
                    source_ref=cand.source_ref,
                    score=7.0 - min(idx, 4),
                    metadata=dict(cand.metadata or {}),
                ))

        for idx, ent in enumerate(known_entities[:6]):
            if self._type_matches(ask, "media") or self._type_matches(ask, "entity"):
                candidates.append(ReferentCandidate(
                    candidate_id=f"entity:{ent.lower()}",
                    type="media" if getattr(ask, "referent_type", "unknown") == "media" else "entity",
                    display_name=ent,
                    canonical_name=ent,
                    source="recent_context",
                    source_ref="known_entities",
                    score=6.0 - min(idx, 3),
                    metadata={},
                ))

        rel_map = {int(r["person_id"]): (r.get("relation") or "").strip() for r in relationships if r.get("person_id") is not None}
        for idx, p in enumerate(people[:8]):
            name = (p.get("name") or "").strip()
            if not name:
                continue
            relation = rel_map.get(int(p.get("id") or 0), "")
            type_name = "person"
            if self._type_matches(ask, type_name):
                score = 4.5 - min(idx, 3)
                if relation:
                    score += 0.5
                candidates.append(ReferentCandidate(
                    candidate_id=f"person:{p['id']}",
                    type=type_name,
                    display_name=name,
                    canonical_name=name,
                    source="long_term_memory",
                    source_ref=str(p["id"]),
                    score=score,
                    metadata={"relationship": relation},
                ))

        for idx, fact in enumerate(relevant_facts[:8]):
            subject = (fact.get("subject") or "").strip()
            subject_type = fact.get("subject_type") or "self"
            if not subject or subject_type == "self":
                continue
            cand_type = "person" if subject_type == "person" else (
                "media" if (fact.get("category") or "") == "media" else "entity"
            )
            if not self._type_matches(ask, cand_type):
                continue
            score = 4.0 - min(idx, 3) + float(fact.get("confidence") or 0.0)
            candidates.append(ReferentCandidate(
                candidate_id=f"fact:{fact.get('id', idx)}",
                type=cand_type,
                display_name=subject,
                canonical_name=subject.title() if subject == subject.lower() else subject,
                source="long_term_memory",
                source_ref=str(fact.get("id", "")),
                score=score,
                metadata={"fact": dict(fact)},
            ))

        uniq: dict[str, ReferentCandidate] = {}
        for cand in candidates:
            key = f"{cand.type}:{cand.canonical_name.lower()}"
            prev = uniq.get(key)
            if prev is None or cand.score > prev.score:
                uniq[key] = cand
        return list(uniq.values())

    def _resolve_from_candidates(self, candidates: list[ReferentCandidate]) -> ReferentResolution:
        if not candidates:
            return ReferentResolution(status="unresolved", candidates=[], source="none")
        top = candidates[0]
        runner = candidates[1] if len(candidates) > 1 else None
        margin = top.score - (runner.score if runner else 0.0)
        if top.score >= AUTO_RESOLVE_SCORE and margin >= AUTO_RESOLVE_MARGIN:
            return ReferentResolution(
                status="resolved",
                chosen_candidate=top,
                candidates=candidates,
                source=top.source,
            )
        return ReferentResolution(
            status="ambiguous" if runner is not None else "unresolved",
            candidates=candidates,
            source="none",
        )

    async def _resolve_via_capability(
        self,
        *,
        ask: Ask,
        user_id: Optional[int],
        memory: Any,
    ) -> Optional[ReferentCandidate]:
        if getattr(ask, "capability_need", "none") == "none":
            return None
        looked_up = await execute_capability_lookup(
            category=getattr(ask, "capability_need", "none"),
            query=ask.distilled_query,
            registry=self._registry,
            executor=self._executor,
            memory=memory,
            user_id=user_id,
        )
        if not looked_up:
            return None
        data = looked_up.get("data") or {}
        canonical = (
            data.get("title")
            or data.get("name")
            or data.get("heading")
            or ""
        )
        if not canonical:
            showtimes = data.get("showtimes") or []
            if showtimes:
                title = (showtimes[0] or {}).get("title") or ""
                canonical = title
        if not canonical:
            return None
        skill_id = looked_up.get("skill_id") or looked_up.get("intent") or "capability"
        return ReferentCandidate(
            candidate_id=f"cap:{skill_id}:{canonical.lower()}",
            type=getattr(ask, "referent_type", "entity") or "entity",
            display_name=canonical,
            canonical_name=canonical,
            source="capability_lookup",
            source_ref=looked_up.get("intent") or str(skill_id),
            score=8.0,
            metadata={"lookup": looked_up},
        )

    async def _resolve_with_fallback(
        self,
        *,
        user_input: str,
        ask: Ask,
        candidates: list[ReferentCandidate],
        recent: list[dict],
    ) -> ReferentResolution:
        if self._inference is None:
            return ReferentResolution(
                status="unresolved",
                candidates=candidates,
                source="none",
                clarification_hint="Could you clarify what you mean?",
            )
        schema = {
            "type": "object",
            "required": ["chosen_candidate_id", "clarification_hint"],
            "properties": {
                "chosen_candidate_id": {"type": "string"},
                "clarification_hint": {"type": "string"},
            },
        }
        prompt = self._build_fallback_prompt(user_input=user_input, ask=ask, candidates=candidates, recent=recent)
        raw = await self._inference.generate(
            model=self._model_manager.policy.fast_model,
            prompt=prompt,
            keep_alive=self._model_manager.policy.fast_keep_alive,
            format_schema=schema,
            temperature=0.0,
            num_predict=FALLBACK_NUM_PREDICT,
        )
        try:
            data = json.loads(raw)
        except Exception:
            data = {"chosen_candidate_id": "", "clarification_hint": ""}
        chosen_id = str(data.get("chosen_candidate_id") or "")
        hint = str(data.get("clarification_hint") or "")
        for cand in candidates:
            if cand.candidate_id == chosen_id:
                return ReferentResolution(
                    status="resolved",
                    chosen_candidate=cand,
                    candidates=candidates,
                    source="llm_fallback",
                    clarification_hint=hint,
                )
        return ReferentResolution(
            status="unresolved",
            candidates=candidates,
            source="llm_fallback" if candidates else "none",
            clarification_hint=hint or "Could you clarify what you mean?",
        )

    def _build_fallback_prompt(
        self,
        *,
        user_input: str,
        ask: Ask,
        candidates: list[ReferentCandidate],
        recent: list[dict],
    ) -> str:
        recent_lines = [f"{m.get('role')}: {m.get('content')}" for m in recent[-4:]]
        cand_lines = [
            f"{c.candidate_id}|{c.type}|{c.canonical_name}|{c.source}|{c.score:.2f}"
            for c in candidates[:8]
        ]
        return (
            "ROLE:referent resolver. Choose the best candidate or leave blank.\n"
            "OUTPUT:valid JSON only.\n"
            f"USER_INPUT:{user_input}\n"
            f"ASK:{ask.distilled_query}\n"
            f"REFERENT_TYPE:{getattr(ask, 'referent_type', 'unknown')}\n"
            f"RECENT:{' | '.join(recent_lines)}\n"
            f"CANDIDATES:{' | '.join(cand_lines)}\n"
            "If none is safe, choose blank chosen_candidate_id and provide a short clarification_hint.\n"
        )

    def _enrich_query(self, ask: Ask, resolution: ReferentResolution) -> str:
        if resolution.chosen_candidate is None:
            return ""
        canonical = resolution.chosen_candidate.canonical_name
        capability = getattr(ask, "capability_need", "none")
        if capability == "current_media":
            return f"showtimes for {canonical}"
        return canonical

    @staticmethod
    def _type_matches(ask: Ask, cand_type: str) -> bool:
        target = getattr(ask, "referent_type", "unknown")
        if target == "unknown":
            return True
        if target == cand_type:
            return True
        if target == "media" and cand_type == "entity":
            return True
        return False
