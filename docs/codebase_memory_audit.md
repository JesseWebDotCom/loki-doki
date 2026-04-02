# LokiDoki Codebase & Memory System Audit

## 1. Files That Need to Be Broken Up

### `app/main.py`
- **Why:**
  - Exceeds 300 lines (project guideline).
  - Contains API endpoints, models, DB logic, business logic, and utility functions all in one file.
  - Hard to maintain, test, and extend.
  - Should be split by route or subsystem (e.g., auth, chat, memory, admin, etc.).

### `app/runtime_metrics.py`
- **Why:**
  - Contains 20+ functions for system metrics, process tracking, and storage.
  - Mixes unrelated responsibilities (CPU, memory, storage, process info).
  - Should be split into focused modules (e.g., memory, CPU, storage, process).

---

## 2. Memory System: Implementation & Gaps

### **Current Implementation**
- **Persistence:**
  - All memory is stored in SQLite tables.
  - Tables: `mem_household_context` (shared), `mem_char_user_memory` (per-user/character), `mem_archival_content`/`vec_archival` (archival), `chat_sessions`/`chat_messages` (chat history).
- **Usage:**
  - Memory facts are injected into LLM prompts as context (`get_l1_context`).
  - Chat history is loaded per session for conversational context.
- **APIs:**
  - Backend supports manual add/delete for user and household memories (not exposed in UI).
- **Schema:**
  - Each memory has `updated_at`; some have `expires_at` (emotional context).
  - No enforced size, TTL, or retention policy.

### **What’s Missing / Not Professional-Grade**
- **No Automatic Shrinking/Aging:**
  - No logic to prune, shrink, or expire old/unused memories.
  - No enforcement of LLM context window/token limits.
  - No prioritization of recent/important facts.
- **No UI Controls:**
  - Users/admins cannot add/delete memories from the UI.
  - No visibility or management of memory from frontend.
- **No Retention Policy:**
  - Memories persist indefinitely unless manually deleted.
  - No background cleanup or scheduled purging.
- **No Memory Ranking:**
  - No scoring, ranking, or semantic prioritization for what gets injected into context.
- **No Usage Analytics:**
  - No tracking of which memories are actually used by the LLM.
- **No Family/Account-Level Memory CRUD:**
  - Household memory exists in schema, but no robust API/UI for shared memory management.
- **No Professional-Grade Features:**
  - No memory windowing, summarization, or context compression.
  - No user-facing controls for memory privacy, export, or audit.

---

**Summary:**
- The codebase needs file splitting for maintainability.
- The memory system is persistent and multi-layered, but lacks automatic management, UI, and professional-grade features found in top-tier apps like ChatGPT.
