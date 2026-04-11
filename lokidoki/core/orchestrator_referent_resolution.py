"""Retrieval-first referent resolution between decomposition and routing."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Optional

from lokidoki.core.decomposer import Ask
from lokidoki.core.graph_walk_resolution import (
    candidate_aliases,
    fuzzy_match_name,
    normalize_query,
    resolve_graph_walk_candidate,
)
from lokidoki.core.model_manager import ModelManager
from lokidoki.core.orchestrator_skills import (
    _is_informative_anchor,
    execute_capability_lookup,
)
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor
from lokidoki.core.skill_executor import SkillResult


AUTO_RESOLVE_SCORE = 5.0
AUTO_RESOLVE_MARGIN = 1.0
FALLBACK_MARGIN = 1.0
FALLBACK_NUM_PREDICT = 96
DEFAULT_MEDIA_CAPABILITY = "current_media"
INFER_QUERY_NUM_PREDICT = 80


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
        alias_people = await self._load_alias_people(memory=memory, user_id=user_id)

        for ask in asks:
            if not (
                getattr(ask, "needs_referent_resolution", False)
                or self._should_force_resolution(ask, session_candidates)
            ):
                out.append(EnrichedAsk(ask=ask))
                continue

            candidates = self._collect_candidates(
                ask=ask,
                relevant_facts=relevant_facts,
                people=people,
                alias_people=alias_people,
                relationships=relationships,
                known_entities=known_entities,
                session_candidates=session_candidates,
            )
            graph_walk = await resolve_graph_walk_candidate(
                text=(
                    getattr(ask, "referent_anchor", "")
                    or getattr(ask, "distilled_query", "")
                    or user_input
                ),
                memory=memory,
                user_id=user_id,
            )
            if graph_walk is not None:
                candidates.append(
                    ReferentCandidate(
                        candidate_id=f"graph:{graph_walk['id']}",
                        type="person",
                        display_name=graph_walk["name"],
                        canonical_name=graph_walk["name"],
                        source="graph_walk",
                        source_ref=str(graph_walk["id"]),
                        score=9.6,
                        metadata={"aliases": list(candidate_aliases(graph_walk))},
                    )
                )
            candidates.sort(key=lambda c: c.score, reverse=True)

            resolution = self._resolve_from_candidates(candidates)
            if self._should_try_anchor_before_accepting(ask, resolution):
                anchored = await self._resolve_via_anchor_capabilities(
                    ask=ask,
                    user_id=user_id,
                    memory=memory,
                    candidates=candidates,
                )
                if anchored is not None:
                    candidates.append(anchored)
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
                anchored = await self._resolve_via_anchor_capabilities(
                    ask=ask,
                    user_id=user_id,
                    memory=memory,
                    candidates=candidates,
                )
                if anchored is not None:
                    candidates.append(anchored)
                    candidates.sort(key=lambda c: c.score, reverse=True)
                    resolution = self._resolve_from_candidates(candidates)
            if resolution.status != "resolved" and self._should_try_inferred_query(
                ask=ask,
                candidates=candidates,
                session_candidates=session_candidates,
            ):
                inferred = await self._resolve_via_inferred_query(
                    user_input=user_input,
                    ask=ask,
                    recent=recent,
                    user_id=user_id,
                    memory=memory,
                )
                if inferred is not None:
                    candidates.append(inferred)
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
            self._apply_resolution_upgrades(ask, resolution)
            await self._repair_followup_capability(
                user_input=user_input,
                ask=ask,
                resolution=resolution,
                recent=recent,
                session_candidates=session_candidates,
            )
            enriched.enriched_query = self._enrich_query(ask, resolution)
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
        alias_people: list[dict],
        relationships: list[dict],
        known_entities: list[str],
        session_candidates: list[ReferentCandidate],
    ) -> list[ReferentCandidate]:
        candidates: list[ReferentCandidate] = []
        anchor_text = normalize_query(
            getattr(ask, "referent_anchor", "") or getattr(ask, "distilled_query", "")
        )

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
        person_rank = 0
        for p in people[:8]:
            name = (p.get("name") or "").strip()
            if not name:
                continue
            # The linked user profile row lives in the same people table.
            # It should not compete with third-person referent resolution
            # like "what's his name", or it can tie with a real person and
            # force an unnecessary fallback.
            if p.get("linked_user_id") is not None:
                continue
            relation = rel_map.get(int(p.get("id") or 0), "")
            type_name = "person"
            if self._type_matches(ask, type_name):
                score = 4.5 - min(person_rank, 3)
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
                person_rank += 1

        if anchor_text and self._type_matches(ask, "person"):
            matched_person = fuzzy_match_name(anchor_text, alias_people, score_cutoff=82)
            if matched_person is not None:
                candidates.append(ReferentCandidate(
                    candidate_id=f"alias:{matched_person['id']}",
                    type="person",
                    display_name=matched_person["name"],
                    canonical_name=matched_person["name"],
                    source="alias_match",
                    source_ref=str(matched_person["id"]),
                    score=8.2,
                    metadata={"aliases": list(candidate_aliases(matched_person))},
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
            score = (
                4.0
                - min(idx, 3)
                + float(fact.get("confidence") or 0.0)
                + self._fuzzy_anchor_bonus(anchor_text, subject)
            )
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

    async def _load_alias_people(self, *, memory: Any, user_id: Optional[int]) -> list[dict]:
        if memory is None or user_id is None:
            return []
        return await memory.run_sync(
            lambda conn: [
                dict(row)
                for row in conn.execute(
                    "SELECT id, name, aliases FROM people WHERE owner_user_id = ? ORDER BY id ASC",
                    (user_id,),
                ).fetchall()
            ]
        )

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
            query=self._capability_query(ask),
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

    async def _resolve_via_anchor_capabilities(
        self,
        *,
        ask: Ask,
        user_id: Optional[int],
        memory: Any,
        candidates: list[ReferentCandidate],
    ) -> Optional[ReferentCandidate]:
        anchor = (getattr(ask, "referent_anchor", "") or "").strip()
        if not anchor:
            return None
        if any(c.source == "capability_lookup" for c in candidates):
            return None
        for category in self._anchor_capability_candidates(ask):
            looked_up = await execute_capability_lookup(
                category=category,
                query=self._capability_query(ask),
                registry=self._registry,
                executor=self._executor,
                memory=memory,
                user_id=user_id,
            )
            if not looked_up:
                continue
            candidate = self._candidate_from_lookup(ask, looked_up)
            if candidate is not None:
                return candidate
        return None

    async def _resolve_via_inferred_query(
        self,
        *,
        user_input: str,
        ask: Ask,
        recent: list[dict],
        user_id: Optional[int],
        memory: Any,
    ) -> Optional[ReferentCandidate]:
        inferred = await self._infer_lookup_query(
            user_input=user_input,
            ask=ask,
            recent=recent,
        )
        if not inferred:
            return None
        category = inferred.get("capability_need") or getattr(ask, "capability_need", "none")
        query = (inferred.get("lookup_query") or "").strip()
        if not category or category == "none" or not query:
            return None
        looked_up = await execute_capability_lookup(
            category=category,
            query=query,
            registry=self._registry,
            executor=self._executor,
            memory=memory,
            user_id=user_id,
        )
        if not looked_up:
            return None
        candidate = self._candidate_from_lookup(ask, looked_up)
        if candidate is None:
            return None
        return candidate

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

    async def _infer_lookup_query(
        self,
        *,
        user_input: str,
        ask: Ask,
        recent: list[dict],
    ) -> dict[str, str]:
        if self._inference is None:
            return {}
        schema = {
            "type": "object",
            "required": ["lookup_query", "capability_need"],
            "properties": {
                "lookup_query": {"type": "string"},
                "capability_need": {
                    "type": "string",
                    "enum": ["current_media", "web_search", "encyclopedic", "none"],
                },
            },
        }
        recent_lines = [f"{m.get('role')}: {m.get('content')}" for m in recent[-4:]]
        prompt = (
            "ROLE:infer a grounded lookup query for an unresolved referential ask.\n"
            "OUTPUT:valid JSON only.\n"
            f"USER_INPUT:{user_input}\n"
            f"DISTILLED_QUERY:{ask.distilled_query}\n"
            f"REFERENT_TYPE:{getattr(ask, 'referent_type', 'unknown')}\n"
            f"REFERENT_SCOPE:{','.join(getattr(ask, 'referent_scope', []) or [])}\n"
            f"REFERENT_ANCHOR:{getattr(ask, 'referent_anchor', '')}\n"
            f"DURABILITY:{getattr(ask, 'durability', 'durable')}\n"
            f"RECENT:{' | '.join(recent_lines)}\n"
            "Infer the best short lookup query only when there is a likely named thing to ground. "
            "Use current_media for likely movies in theaters, web_search for products/places/events, "
            "encyclopedic for stable well-known entities, else none.\n"
        )
        raw = await self._inference.generate(
            model=self._model_manager.policy.fast_model,
            prompt=prompt,
            keep_alive=self._model_manager.policy.fast_keep_alive,
            format_schema=schema,
            temperature=0.0,
            num_predict=INFER_QUERY_NUM_PREDICT,
        )
        try:
            data = json.loads(raw)
        except Exception:
            return {}
        return {
            "lookup_query": str(data.get("lookup_query") or "").strip(),
            "capability_need": str(data.get("capability_need") or "none").strip(),
        }

    def _candidate_from_lookup(
        self,
        ask: Ask,
        looked_up: dict,
    ) -> Optional[ReferentCandidate]:
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
                canonical = (showtimes[0] or {}).get("title") or ""
        if not canonical:
            return None
        skill_id = looked_up.get("skill_id") or looked_up.get("intent") or "capability"
        return ReferentCandidate(
            candidate_id=f"cap:{skill_id}:{canonical.lower()}",
            type=self._resolved_candidate_type(ask, looked_up),
            display_name=canonical,
            canonical_name=canonical,
            source="capability_lookup",
            source_ref=looked_up.get("intent") or str(skill_id),
            score=8.0,
            metadata={"lookup": looked_up},
        )

    def candidate_from_skill_result(
        self,
        ask: Ask,
        result: SkillResult,
        *,
        skill_id: str = "",
        intent: str = "",
    ) -> Optional[ReferentCandidate]:
        if not result or not result.success:
            return None
        return self._candidate_from_lookup(
            ask,
            {
                "skill_id": skill_id,
                "intent": intent,
                "data": result.data or {},
            },
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
        if (
            capability == "current_media"
            or (
                resolution.chosen_candidate.type == "media"
                and getattr(ask, "durability", "durable") == "tentative"
            )
        ):
            return f"showtimes for {canonical}"
        # General case: substitute the pronoun/anchor in the distilled
        # query with the resolved canonical name so downstream skills
        # see "is Avatar still playing" instead of "is it still playing".
        # Without this, distilled_query went to skills verbatim and
        # showtimes searched for `q=it`.
        distilled = (getattr(ask, "distilled_query", "") or "").strip()
        anchor = (getattr(ask, "referent_anchor", "") or "").strip()
        pronoun_phrase = self._leading_pronoun_phrase(anchor)
        if distilled and pronoun_phrase:
            import re
            pattern = re.compile(rf"\b{re.escape(pronoun_phrase)}\b", re.IGNORECASE)
            replacement = self._pronoun_phrase_replacement(pronoun_phrase, canonical)
            substituted, n = pattern.subn(replacement, distilled, count=1)
            if n:
                return substituted
        if distilled and anchor and anchor.lower() != canonical.lower():
            import re
            pattern = re.compile(rf"\b{re.escape(anchor)}\b", re.IGNORECASE)
            substituted, n = pattern.subn(canonical, distilled, count=1)
            if n:
                return substituted
        # Fallback: substitute bare pronouns when the anchor itself is
        # missing or non-informative ("it", "that", "there").
        if distilled:
            import re
            pron = re.compile(r"\b(it|that|this|there|them|he|she|his|her|their)\b", re.IGNORECASE)
            substituted, n = pron.subn(canonical, distilled, count=1)
            if n:
                return substituted
        return canonical

    @staticmethod
    def _leading_pronoun_phrase(anchor: str) -> str:
        text = (anchor or "").strip()
        if not text:
            return ""
        normalized = text.lower()
        for pronoun in ("his ", "her ", "their ", "he ", "she "):
            if normalized.startswith(pronoun):
                return text
        return ""

    @staticmethod
    def _pronoun_phrase_replacement(anchor: str, canonical: str) -> str:
        text = (anchor or "").strip()
        lower = text.lower()
        if lower.startswith("his "):
            return f"{canonical}'s {text[4:].strip()}"
        if lower.startswith("her "):
            return f"{canonical}'s {text[4:].strip()}"
        if lower.startswith("their "):
            return f"{canonical}'s {text[6:].strip()}"
        if lower in {"he", "she"}:
            return canonical
        if lower.startswith("he "):
            return f"{canonical} {text[3:].strip()}"
        if lower.startswith("she "):
            return f"{canonical} {text[4:].strip()}"
        return canonical

    def _apply_resolution_upgrades(
        self,
        ask: Ask,
        resolution: ReferentResolution,
    ) -> None:
        chosen = resolution.chosen_candidate
        if chosen is None:
            return
        if (
            chosen.type == "media"
            and getattr(ask, "capability_need", "none") == "none"
            and (
                getattr(ask, "durability", "durable") == "tentative"
                or getattr(ask, "needs_referent_resolution", False)
            )
        ):
            ask.capability_need = DEFAULT_MEDIA_CAPABILITY
            ask.requires_current_data = True
            if getattr(ask, "knowledge_source", "none") == "none":
                ask.knowledge_source = "web"
            if getattr(ask, "referent_type", "unknown") == "unknown":
                ask.referent_type = "media"

    async def _repair_followup_capability(
        self,
        *,
        user_input: str,
        ask: Ask,
        resolution: ReferentResolution,
        recent: list[dict],
        session_candidates: list[ReferentCandidate],
    ) -> None:
        chosen = resolution.chosen_candidate
        if chosen is None or chosen.type != "media":
            return
        if getattr(ask, "capability_need", "none") != "none":
            return
        if not self._should_try_followup_capability_repair(ask, session_candidates):
            return

        inferred = await self._infer_lookup_query(
            user_input=user_input,
            ask=ask,
            recent=recent,
        )
        capability = (inferred.get("capability_need") or "none").strip()
        if capability == "none":
            return

        ask.capability_need = capability
        if capability == DEFAULT_MEDIA_CAPABILITY:
            ask.requires_current_data = True
            ask.referent_type = "media"
            ask.knowledge_source = "web"
        elif capability == "web_search":
            ask.requires_current_data = True
            if getattr(ask, "knowledge_source", "none") == "none":
                ask.knowledge_source = "web"
        elif capability == "encyclopedic" and getattr(ask, "knowledge_source", "none") == "none":
            ask.knowledge_source = "encyclopedic"

    def _anchor_capability_candidates(self, ask: Ask) -> list[str]:
        seen: list[str] = []

        def _push(category: str) -> None:
            if category and category not in seen:
                seen.append(category)

        target = getattr(ask, "referent_type", "unknown")
        scope = list(getattr(ask, "referent_scope", []) or [])
        declared = getattr(ask, "capability_need", "none")

        if declared != "none":
            _push(declared)
        # Tentative + anchor used to push current_media unconditionally,
        # which made every "maybe I'll do X tonight" sentence run a
        # showtimes lookup. The fix is to require the anchor itself to
        # be a real-looking name — _is_informative_anchor blocks generic
        # temporal/pronoun stopwords like "tonight"/"it"/"that" while
        # still letting actual movie names like "avatar" through. This
        # preserves the safety net for cases where the decomposer
        # mistagged scope but caught the named referent.
        anchor = (getattr(ask, "referent_anchor", "") or "").strip()
        if (
            getattr(ask, "durability", "durable") == "tentative"
            and anchor
            and (
                target == "media"
                or "media" in scope
                or _is_informative_anchor(anchor)
            )
        ):
            _push(DEFAULT_MEDIA_CAPABILITY)
        if target == "media" or "media" in scope:
            _push(DEFAULT_MEDIA_CAPABILITY)
        if target == "entity" or "entity" in scope:
            _push("encyclopedic")
            _push("web_search")
        if (
            target in ("place", "product", "event")
            or any(s in ("place", "product", "event") for s in scope)
        ):
            _push("web_search")
        return seen

    @staticmethod
    def _should_try_anchor_before_accepting(
        ask: Ask,
        resolution: ReferentResolution,
    ) -> bool:
        chosen = resolution.chosen_candidate
        if resolution.status != "resolved" or chosen is None:
            return False
        if not (getattr(ask, "referent_anchor", "") or "").strip():
            return False
        if chosen.type != "person":
            return False
        if chosen.source != "long_term_memory":
            return False
        return getattr(ask, "context_source", "none") in ("recent_context", "external")

    def _resolved_candidate_type(self, ask: Ask, looked_up: dict) -> str:
        if looked_up.get("intent", "").startswith("movies_showtimes."):
            return "media"
        if getattr(ask, "capability_need", "none") == DEFAULT_MEDIA_CAPABILITY:
            return "media"
        declared = getattr(ask, "referent_type", "unknown")
        if declared != "unknown":
            return declared
        return "entity"

    @staticmethod
    def _fuzzy_anchor_bonus(anchor_text: str, candidate_name: str) -> float:
        if not anchor_text:
            return 0.0
        normalized = normalize_query(candidate_name)
        if not normalized:
            return 0.0
        if anchor_text == normalized:
            return 1.2
        if anchor_text in normalized or normalized in anchor_text:
            return 0.9
        return 0.0

    @staticmethod
    def _capability_query(ask: Ask) -> str:
        anchor = (getattr(ask, "referent_anchor", "") or "").strip()
        if anchor and not ReferentResolver._prefer_distilled_query_for_lookup(ask):
            return anchor
        return ask.distilled_query

    @staticmethod
    def _prefer_distilled_query_for_lookup(ask: Ask) -> bool:
        scope = list(getattr(ask, "referent_scope", []) or [])
        return (
            getattr(ask, "durability", "durable") == "tentative"
            and getattr(ask, "capability_need", "none") == "none"
            and "media" not in scope
        )

    @staticmethod
    def _should_force_resolution(
        ask: Ask,
        session_candidates: list[ReferentCandidate],
    ) -> bool:
        # A tentative+unresolved ask with no declared capability used to
        # force resolution unconditionally. That fired DDG searches on
        # chitchat like "maybe I'll go see Avatar tonight" because the
        # event-typed referent hit the anchor-capabilities path. Only
        # force when the scope/type plausibly grounds to a *named* thing
        # we can look up — media/entity/place/product. Bare events like
        # "tonight" do not benefit from a web round-trip.
        scope = set(getattr(ask, "referent_scope", []) or [])
        ref_type = getattr(ask, "referent_type", "unknown")
        groundable = bool(
            scope.intersection({"media", "entity", "place", "product"})
            or ref_type in ("media", "entity", "place", "product")
        )
        return (
            (
                getattr(ask, "referent_status", "none") == "unresolved"
                and getattr(ask, "durability", "durable") == "tentative"
                and getattr(ask, "capability_need", "none") == "none"
                and groundable
            )
            or (
                bool(session_candidates)
                and getattr(ask, "intent", "direct_chat") == "direct_chat"
                and getattr(ask, "response_shape", "synthesized") == "synthesized"
                and getattr(ask, "context_source", "none") in ("recent_context", "long_term_memory")
                and len((getattr(ask, "distilled_query", "") or "").split()) <= 6
                and (
                    getattr(ask, "referent_type", "unknown") != "unknown"
                    or bool(getattr(ask, "referent_scope", []) or [])
                    or getattr(ask, "referent_status", "none") == "unresolved"
                )
            )
        )

    @staticmethod
    def _should_try_inferred_query(
        *,
        ask: Ask,
        candidates: list[ReferentCandidate],
        session_candidates: list[ReferentCandidate],
    ) -> bool:
        if getattr(ask, "intent", "direct_chat") != "direct_chat":
            return False
        if getattr(ask, "response_shape", "synthesized") != "synthesized":
            return False
        if not candidates and not session_candidates:
            return True
        if getattr(ask, "capability_need", "none") != "none":
            return True
        if getattr(ask, "durability", "durable") == "tentative":
            return True
        scope = set(getattr(ask, "referent_scope", []) or [])
        return bool(scope.intersection({"media", "entity", "place", "product", "event"}))

    @staticmethod
    def _should_try_followup_capability_repair(
        ask: Ask,
        session_candidates: list[ReferentCandidate],
    ) -> bool:
        if not session_candidates:
            return False
        if getattr(ask, "intent", "direct_chat") != "direct_chat":
            return False
        if getattr(ask, "context_source", "none") not in ("recent_context", "long_term_memory"):
            return False
        if len((getattr(ask, "distilled_query", "") or "").split()) > 6:
            return False
        scope = set(getattr(ask, "referent_scope", []) or [])
        return (
            getattr(ask, "referent_type", "unknown") == "media"
            or "media" in scope
            or getattr(ask, "referent_status", "none") == "unresolved"
        )

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
