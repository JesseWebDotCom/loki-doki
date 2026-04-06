import pytest
from lokidoki.core.bm25 import BM25Index


@pytest.fixture
def index():
    idx = BM25Index()
    idx.add_document("doc1", "The quick brown fox jumps over the lazy dog")
    idx.add_document("doc2", "User enjoys hiking in the mountains every weekend")
    idx.add_document("doc3", "Brother Billy loves watching The Incredibles movie")
    idx.add_document("doc4", "User lives in Seattle and works as an engineer")
    idx.add_document("doc5", "Family goes hiking together on Saturdays")
    return idx


class TestBM25Index:
    def test_search_single_keyword(self, index):
        """Test searching for a single keyword."""
        results = index.search("hiking")
        assert len(results) >= 2
        doc_ids = [r[0] for r in results]
        assert "doc2" in doc_ids
        assert "doc5" in doc_ids

    def test_search_returns_scores(self, index):
        """Test that results include relevance scores."""
        results = index.search("hiking")
        for doc_id, score in results:
            assert score > 0

    def test_search_ranked_by_relevance(self, index):
        """Test that results are ranked by BM25 score (descending)."""
        results = index.search("hiking mountains")
        scores = [r[1] for r in results]
        assert scores == sorted(scores, reverse=True)

    def test_search_multi_keyword(self, index):
        """Test search with multiple keywords."""
        results = index.search("Billy Incredibles")
        doc_ids = [r[0] for r in results]
        assert "doc3" in doc_ids

    def test_search_no_match(self, index):
        """Test that irrelevant queries return empty."""
        results = index.search("quantum physics")
        assert len(results) == 0

    def test_search_case_insensitive(self, index):
        """Test case-insensitive search."""
        results_lower = index.search("billy")
        results_upper = index.search("BILLY")
        assert len(results_lower) == len(results_upper)

    def test_search_with_limit(self, index):
        """Test limiting the number of results."""
        results = index.search("the", top_k=2)
        assert len(results) <= 2

    def test_add_document_updates_index(self, index):
        """Test that adding new documents makes them searchable."""
        index.add_document("doc6", "New fact about quantum computing research")
        results = index.search("quantum")
        doc_ids = [r[0] for r in results]
        assert "doc6" in doc_ids

    def test_remove_document(self, index):
        """Test removing a document from the index."""
        index.remove_document("doc3")
        results = index.search("Billy Incredibles")
        doc_ids = [r[0] for r in results]
        assert "doc3" not in doc_ids

    def test_empty_index_search(self):
        """Test searching an empty index."""
        idx = BM25Index()
        results = idx.search("anything")
        assert results == []

    def test_empty_query(self, index):
        """Test that empty query returns empty results."""
        results = index.search("")
        assert results == []

    def test_document_count(self, index):
        """Test document count tracking."""
        assert index.doc_count == 5
        index.add_document("doc6", "Another document")
        assert index.doc_count == 6

    def test_bulk_add(self):
        """Test adding many documents for average doc length calculation."""
        idx = BM25Index()
        for i in range(100):
            idx.add_document(f"doc_{i}", f"Document number {i} with content about topic {i % 10}")
        results = idx.search("topic 5")
        assert len(results) > 0
