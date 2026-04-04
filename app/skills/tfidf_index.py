"""Deterministic inverted index and TF-IDF/BM25 scoring for skill routing."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Dict, List, Set, Tuple

from app.skills.manifest import validate_manifest
from app.skills.normalizer import Normalizer
from app.skills.types import InstalledSkillRecord


@dataclass(frozen=True)
class ActionRef:
    """Stable reference to one skill action."""
    skill_id: str
    action_name: str


@dataclass
class IndexEntry:
    """Token-level metadata for one action."""
    action: ActionRef
    term_frequency: int
    weight: float = 1.0


class InvertedIndex:
    """High-performance, manifest-driven lookup of skill relevance."""

    def __init__(self, normalizer: Normalizer) -> None:
        self._normalizer = normalizer
        self._index: Dict[str, List[IndexEntry]] = {}
        self._docs_containing_term: Dict[str, int] = {}
        self._total_docs = 0
        self._action_records: Dict[ActionRef, InstalledSkillRecord] = {}

    def build(self, installed_skills: List[InstalledSkillRecord]) -> None:
        """Clear and rebuild the index from the provided skill manifests."""
        self._index.clear()
        self._docs_containing_term.clear()
        self._action_records.clear()
        self._total_docs = 0

        for record in installed_skills:
            if not record.enabled:
                continue
            definition = validate_manifest(record.manifest)
            for action_name, action in definition.actions.items():
                if not action.enabled:
                    continue
                ref = ActionRef(definition.skill_id, action_name)
                self._action_records[ref] = record
                self._total_docs += 1
                
                # Term weights for weighting intent
                # Phrases are strongest (3.0), Keywords second (1.5), Description third (0.5)
                # Note: We'll weight them in the TF-IDF pass
                tokens: Set[str] = set()

                # Process Phrases
                for phrase in action.phrases:
                    p_tokens = self._normalizer.normalize(phrase)
                    self._add_action_tokens(ref, p_tokens, weight=3.0)
                    tokens.update(p_tokens)
                
                # Process Keywords
                for keyword in action.keywords:
                    k_tokens = self._normalizer.normalize(keyword)
                    self._add_action_tokens(ref, k_tokens, weight=1.5)
                    tokens.update(k_tokens)
                
                # Update IDF stats
                for t in tokens:
                    self._docs_containing_term[t] = self._docs_containing_term.get(t, 0) + 1

    def score_query(self, query_tokens: List[str]) -> List[Tuple[ActionRef, float]]:
        """Return a ranked list of action references and their TF-IDF scores."""
        scores: Dict[ActionRef, float] = {}
        
        # Unique tokens in the query for matching
        q_set = set(query_tokens)
        
        for token in q_set:
            if token not in self._index:
                continue
            
            # Calculate IDF for this token
            docs_with_token = self._docs_containing_term.get(token, 0)
            if docs_with_token == 0:
                continue
                
            # Logarithmic IDF
            idf = math.log10(self._total_docs / docs_with_token)
            
            # Score each matching action
            for entry in self._index[token]:
                # Simple TF weighting: 1 + log(tf) * action-specific weight
                tf_score = (1 + math.log10(entry.term_frequency)) * entry.weight
                score = tf_score * idf
                scores[entry.action] = scores.get(entry.action, 0.0) + score
        
        # Sort and return
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return ranked

    def get_record(self, ref: ActionRef) -> InstalledSkillRecord | None:
        """Return the source registry record for an action reference."""
        return self._action_records.get(ref)

    def _add_action_tokens(self, action: ActionRef, tokens: List[str], weight: float) -> None:
        """Helper to accumulate term frequencies for an action."""
        for token in tokens:
            if token not in self._index:
                self._index[token] = []
            
            # Find existing entry for this action if any
            existing = next((e for e in self._index[token] if e.action == action), None)
            if existing:
                existing.term_frequency += 1
                # Use the highest weight encountered for a token in an action
                existing.weight = max(existing.weight, weight)
            else:
                self._index[token].append(IndexEntry(action, 1, weight))
