from lokidoki.core.sqlite_memory import SQLiteMemoryProvider
from lokidoki.core.bm25 import BM25Index


class ContextRestorer:
    """Cross-chat continuity using BM25 keyword matching + rolling context.

    Prevents new chats from starting "at zero" by injecting relevant
    historical facts into the synthesis prompt.
    """

    def __init__(self, db: SQLiteMemoryProvider, bm25: BM25Index):
        self._db = db
        self._bm25 = bm25
        self._fact_texts: dict[str, str] = {}  # doc_id -> original text

    async def rebuild_index(self) -> None:
        """Rebuild the BM25 index from all stored facts."""
        facts = await self._db.get_all_facts()
        for i, fact in enumerate(facts):
            doc_id = f"fact_{i}"
            self._bm25.add_document(doc_id, fact["fact"])
            self._fact_texts[doc_id] = fact["fact"]

    async def get_rolling_context(self, limit: int = 5) -> list[dict]:
        """Return the N most recent facts for cross-chat injection."""
        return await self._db.get_recent_facts(limit=limit)

    def search_relevant(self, query: str, top_k: int = 5) -> list[tuple[str, float]]:
        """Search BM25 index for facts relevant to the query.

        Returns (fact_text, score) pairs.
        """
        results = self._bm25.search(query, top_k=top_k)
        output = []
        for doc_id, score in results:
            text = self._fact_texts.get(doc_id, "")
            if text:
                output.append((text, score))
        return output

    async def add_fact(self, category: str, fact: str) -> None:
        """Add a fact to both SQLite and BM25 index."""
        await self._db.add_fact(category, fact)
        doc_id = f"fact_{self._bm25.doc_count}"
        self._bm25.add_document(doc_id, fact)
        self._fact_texts[doc_id] = fact

    async def build_restoration_prompt(self, user_input: str, max_facts: int = 5) -> str:
        """Build a token-efficient context restoration fragment.

        Combines rolling recent facts + BM25-matched relevant facts.
        """
        # Get rolling context (most recent facts from any session)
        rolling = await self.get_rolling_context(limit=3)
        rolling_texts = [f["fact"] for f in rolling]

        # Get BM25-matched facts relevant to current input
        relevant = self.search_relevant(user_input, top_k=3)
        relevant_texts = [text for text, _ in relevant]

        # Deduplicate and combine
        seen = set()
        combined = []
        for text in rolling_texts + relevant_texts:
            if text.lower() not in seen and len(combined) < max_facts:
                seen.add(text.lower())
                combined.append(text)

        if not combined:
            return ""

        return "KNOWN_FACTS:" + " | ".join(combined)
