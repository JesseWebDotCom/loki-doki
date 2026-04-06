import json
import os
from typing import Any


class SessionMemory:
    """Session-local memory store for chat history, sentiment, and facts.

    Phase 1 uses JSON file storage. Phase 4 will migrate to SQLite + BM25.
    """

    def __init__(self, storage_path: str | None = None):
        self._storage_path = storage_path
        self.messages: list[dict[str, str]] = []
        self.sentiment: dict[str, str] = {}
        self.facts: list[dict[str, str]] = []

    def add_message(self, role: str, content: str) -> None:
        self.messages.append({"role": role, "content": content})

    def get_recent_context(self, n: int = 5) -> list[dict[str, str]]:
        return self.messages[-n:]

    def update_sentiment(self, sentiment: dict[str, str]) -> None:
        self.sentiment = sentiment

    def add_fact(self, fact: dict[str, str]) -> None:
        if fact not in self.facts:
            self.facts.append(fact)

    def search_facts(self, query: str) -> list[dict[str, str]]:
        q = query.lower()
        return [f for f in self.facts if q in f.get("fact", "").lower()]

    def ingest_decomposition(
        self,
        short_term: dict[str, str],
        long_term: list[dict[str, str]],
    ) -> None:
        if short_term:
            self.update_sentiment(short_term)
        for fact in long_term:
            self.add_fact(fact)

    def clear_session(self) -> None:
        self.messages = []
        self.sentiment = {}

    def save(self) -> None:
        if not self._storage_path:
            return
        os.makedirs(os.path.dirname(self._storage_path), exist_ok=True)
        with open(self._storage_path, "w") as f:
            json.dump({
                "messages": self.messages,
                "sentiment": self.sentiment,
                "facts": self.facts,
            }, f)

    def load(self) -> None:
        if not self._storage_path or not os.path.exists(self._storage_path):
            return
        with open(self._storage_path, "r") as f:
            data = json.load(f)
        self.messages = data.get("messages", [])
        self.sentiment = data.get("sentiment", {})
        self.facts = data.get("facts", [])
