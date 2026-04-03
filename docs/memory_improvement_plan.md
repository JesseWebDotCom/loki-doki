# 🧠 Phase-Driven Implementation Plan: Memory System Improvements

This plan outlines the steps to upgrade the LokiDoki memory system with Onyx-inspired retrieval techniques.

## 🎯 Goal
Improve the accuracy, precision, and performance of memory retrieval by implementing hybrid search, multi-stage retrieval (reranking), and metadata filtering.

---

## 🏗 Phase 1: Foundations & Hybrid Search (High Priority)
**Focus:** Build retrieval infrastructure and metadata scoping.

- [ ] **1.1 Database Migration**
    - [ ] Update `mem_archival_content` table with `user_id`, `character_id`, `importance`, and `confidence`.
    - [ ] Create FTS5 virtual table `mem_archival_fts` for keyword search.
- [ ] **1.2 Hybrid Retrieval Logic**
    - [ ] Update `index_archival` to handle metadata.
    - [ ] Implement `search_archival_hybrid` in `store.py`.
    - [ ] Add metadata filtering to all retrieval queries.
- [ ] **1.3 Basic Scoring**
    - [ ] Implement relevance scoring combining vector distance and keyword matches.

---

## 🚀 Phase 2: Intelligence & Reranking (High Priority)
**Focus:** Smart query processing and multi-stage refinement.

- [ ] **2.1 Query De-contextualization**
    - [ ] Expand `reformulate_followup_query` for general memory retrieval.
- [ ] **2.2 Reranking Layer**
    - [ ] Implement `rerank_memories` function using the `llm_fast` or `llm_thinking` provider.
- [ ] **2.3 Multi-Stage Pipeline Integration**
    - [ ] Update `build_memory_context` for `Retrieve(20) -> Rerank(5)` flow.
    - [ ] Reduce default story history to 4-6 messages.

---

## ⚙️ Phase 3: Sophistication & Performance (Medium Priority)
**Focus:** Long-term hygiene and background processing.

- [ ] **3.1 Deduplication & Merging**
- [ ] **3.2 Semantic Chunking**
- [ ] **3.3 Async Memory Queue**

---

## 🧪 Verification Plan
- **Manual Test:** Ask LokiDoki about a fact mentioned 20+ turns ago.
- **Precision Test:** Ask about a specific proper noun to verify Hybrid search.
- **Latency Check:** Ensure reranking adds < 1.5s delay.
