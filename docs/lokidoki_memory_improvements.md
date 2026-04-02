# 📌 Memory System Improvements — Onyx-Inspired Enhancements (For Codex)

## Context

We have built a **LokiDoki memory system** that is significantly more advanced than typical RAG systems:

- Multi-layer memory (L1–L5)
- Identity-scoped memory (character × user)
- Reflection engine
- Emotional + temporal reasoning
- Background evolution

However, **Onyx-style systems excel at production-grade retrieval pipelines**.  
This document outlines **specific techniques we should adopt** to improve accuracy, performance, and scalability — without compromising our architecture.

---

# 🧠 Guiding Principle

We are NOT replacing our system.

We are upgrading:
- **Retrieval quality**
- **Precision**
- **Performance**

Think:
> LokiDoki = brain  
> Onyx = optimized search layer

---

# 🚀 High Priority Upgrades (Implement First)

---

## 1. Hybrid Retrieval (Vector + Keyword)

### Problem
Pure vector search:
- misses exact matches (names, phrases, IDs)
- weak for precise queries

### Solution

Implement hybrid scoring:

```python
final_relevance =
  (0.7 * vector_similarity) +
  (0.3 * keyword_score)  # BM25 or equivalent
```

### Why
Hybrid search significantly improves retrieval accuracy in real-world systems.

### Where to Apply
- L2 episodic retrieval
- L3 archival search

---

## 2. Multi-Stage Retrieval Pipeline

### Replace current:
```
retrieve → inject
```

### With:
```
1. Retrieve top 20 (fast)
2. Rerank top 20 (smart)
3. Inject top 5 (precise)
```

---

## 3. Reranking Layer (CRITICAL)

### Add new step:

```python
reranked = reranker(query, candidates)
top_k = reranked[:5]
```

---

## 4. Metadata Filtering (Pre-Retrieval)

### Before search:
Filter memory pool using structured constraints:

```sql
WHERE
  character_id = ?
  AND user_id = ?
  AND memory_type IN (...)
```

---

## 5. Query Rewriting Layer

### Add pre-processing step:

User: "what about my dog"  
→ "What is the name and details about the user's dog?"

---

# ⚙️ Medium Priority Improvements

---

## 6. Top-K Expansion Strategy

retrieve 20 → rerank → use 5

---

## 7. Chunking Strategy (Improve L2/L3)

- semantic chunking
- overlapping windows

---

## 8. Memory Deduplication / Merging

```python
if similarity(memory_a, memory_b) > 0.9:
    merge()
    increase_importance()
```

---

## 9. Source Attribution (Missing Feature)

```json
{
  "source": "conversation | reflection | user_input",
  "confidence": 0.92,
  "origin": "explicit | inferred | repeated"
}
```

---

## 10. Async / Incremental Processing

- embeddings queue
- memory write queue
- reflection queue

---

## 11. Embedding Standardization

Use ONE embedding model across all memory.

---

# ❌ What NOT to Adopt

- Pure RAG-only memory
- No importance scoring
- No reflection system
- Flat memory structure

---

# 🧠 Final Architecture Direction

## LokiDoki (keep)
- L1–L5 memory system
- reflection engine
- identity model
- emotional intelligence
- temporal awareness

## Onyx-Inspired (add)
- hybrid retrieval
- reranking
- query rewriting
- metadata filtering
- chunking
- deduplication

---

# 🔥 Most Important Takeaway

If we do ONLY three things:

1. Hybrid search  
2. Reranking  
3. Query rewriting  

We will see the biggest immediate improvement.
