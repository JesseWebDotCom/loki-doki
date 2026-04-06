import math
import re
from collections import Counter


class BM25Index:
    """Lightweight BM25 (Best Match 25) keyword index for fast memory retrieval.

    Designed for Pi 5: no embedding model overhead, pure CPU-based scoring.
    """

    def __init__(self, k1: float = 1.5, b: float = 0.75):
        self._k1 = k1
        self._b = b
        self._docs: dict[str, list[str]] = {}  # doc_id -> tokenized words
        self._doc_freqs: Counter = Counter()  # term -> number of docs containing it
        self._total_doc_len = 0

    @property
    def doc_count(self) -> int:
        return len(self._docs)

    @property
    def _avg_doc_len(self) -> float:
        if not self._docs:
            return 0.0
        return self._total_doc_len / len(self._docs)

    def add_document(self, doc_id: str, text: str) -> None:
        """Add or update a document in the index."""
        if doc_id in self._docs:
            self.remove_document(doc_id)

        tokens = self._tokenize(text)
        self._docs[doc_id] = tokens
        self._total_doc_len += len(tokens)

        seen = set()
        for token in tokens:
            if token not in seen:
                self._doc_freqs[token] += 1
                seen.add(token)

    def remove_document(self, doc_id: str) -> None:
        """Remove a document from the index."""
        if doc_id not in self._docs:
            return
        tokens = self._docs[doc_id]
        self._total_doc_len -= len(tokens)

        seen = set()
        for token in tokens:
            if token not in seen:
                self._doc_freqs[token] -= 1
                if self._doc_freqs[token] <= 0:
                    del self._doc_freqs[token]
                seen.add(token)

        del self._docs[doc_id]

    def search(self, query: str, top_k: int = 10) -> list[tuple[str, float]]:
        """Search the index and return (doc_id, score) pairs ranked by relevance."""
        if not query.strip() or not self._docs:
            return []

        query_tokens = self._tokenize(query)
        if not query_tokens:
            return []

        scores: dict[str, float] = {}
        n = len(self._docs)
        avgdl = self._avg_doc_len

        for doc_id, doc_tokens in self._docs.items():
            score = 0.0
            doc_len = len(doc_tokens)
            tf_counter = Counter(doc_tokens)

            for term in query_tokens:
                if term not in self._doc_freqs:
                    continue

                tf = tf_counter.get(term, 0)
                if tf == 0:
                    continue

                df = self._doc_freqs[term]
                idf = math.log((n - df + 0.5) / (df + 0.5) + 1)
                tf_norm = (tf * (self._k1 + 1)) / (
                    tf + self._k1 * (1 - self._b + self._b * doc_len / max(avgdl, 1))
                )
                score += idf * tf_norm

            if score > 0:
                scores[doc_id] = score

        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        return ranked[:top_k]

    @staticmethod
    def _tokenize(text: str) -> list[str]:
        """Simple whitespace + punctuation tokenizer."""
        return re.findall(r'\w+', text.lower())
