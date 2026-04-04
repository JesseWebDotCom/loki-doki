LokiDoki’s current skill system is a highly optimized, **deterministic control plane** tailored for low-power hardware like the Raspberry Pi 5. In contrast, Onyx (formerly Danswer) and other modern AI apps like AnythingLLM or Open WebUI lean toward **probabilistic, LLM-driven orchestration** and **Model Context Protocol (MCP)** integration.

Below is a comparative review and a set of recommended design changes to bridge the gap between LokiDoki’s efficiency and Onyx’s enterprise-grade extensibility.

---

## 1. Comparative Analysis

| Feature | LokiDoki (Current) | Onyx (and others) | Key Difference |
| :--- | :--- | :--- | :--- |
| **Routing** | **Deterministic Scorer**: Rule-based (keywords, phrases). | **Agentic/LLM Routing**: LLMs decide which tool to call based on tool descriptions. | LokiDoki prioritizes **latency (<50ms)** while Onyx prioritizes **semantic flexibility**. |
| **Integrations** | **Skills**: Focused, in-process Python classes. | **Connectors**: Background workers that sync/index data (GitHub, Notion, etc.). | Onyx treats external data as **indexed knowledge (RAG)**; LokiDoki treats them as **live actions**. |
| **Extensibility** | Manifest-driven local packages. | **MCP (Model Context Protocol)**: Universal protocol for connecting any tool. | Onyx can consume any MCP server; LokiDoki requires custom skill wrappers. |
| **Latency** | **Zero-latency**: Runs on CPU/NPU. | **Variable**: Dependent on LLM inference time (0.5s–2s+). | LokiDoki is built for **Voice (Real-time)**; Onyx is built for **Search/Chat (Asynchronous)**. |

---

## 2. Review of Onyx & Similar Apps

### Onyx: The "Connector" Model
Onyx distinguishes between **Connectors** (data ingestion) and **Actions** (tool calling). 
* **Background Syncing**: Connectors (GitHub, Salesforce) run as background workers to maintain a vector index. 
* **Permission Sync**: It maps source permissions (e.g., GitHub private repo access) to the AI interface, a feature LokiDoki currently lacks but mentions in its "Future Context".

### Open WebUI & AnythingLLM: The "Native Mode"
* **Agentic Tool Calling**: They use "Native Mode" (direct function calling) for high-tier models but offer a "Legacy Mode" (prompt-based) for smaller models.
* **MCP Support**: Both now support **MCP**, allowing users to plug in community-made "servers" (e.g., a Google Drive MCP) without writing Python code in the app.

---

## 3. Recommended Design Changes for LokiDoki

LokiDoki’s deterministic routing is its "killer feature" for Pi-based hardware. However, to reach the extensibility of Onyx, three specific shifts are recommended:

### A. Implement an MCP Adapter Layer (Priority: High)
* **Why**: Writing a custom `skill.py` for every service is a bottleneck. The **Model Context Protocol (MCP)** is becoming the industry standard.
* **Change**: Instead of manual Python skills for everything, build a **Generic MCP Skill**. This skill would consume an MCP server manifest and map its tools to LokiDoki's `actions`.
* **Result**: Users could "install" a Slack or Jira integration by simply providing an MCP URL.

### B. Add "Semantic Routing" as a Scoring Component (Priority: Medium)
* **Why**: LokiDoki's keyword scoring can be brittle for complex queries.
* **Change**: Incorporate a **Small Embedding Matcher** (e.g., using a tiny model like `all-MiniLM-L6-v2`). 
* **Logic**: If the Keyword Scorer fails to clear the `MIN_ROUTE_SCORE`, run a quick vector search against the action descriptions. This adds ~20ms but drastically improves "fuzzy" matches without needing a full LLM router.

### C. Introduce "Data Connectors" vs. "Live Skills" (Priority: Low)
* **Why**: Onyx excels at searching *past* data (indexing); LokiDoki excels at *performing* tasks.
* **Change**: Allow skills to define an `indexing_interval`. For a "Notes" skill, LokiDoki could periodically pull notes into a local vector DB (RAG).
* **Result**: You can ask "What did I write about pizza last week?" (Index/RAG) vs. "Add pizza to my grocery list" (Action/Skill).

---

## 4. Summary: Should we change the design?
**No, do not abandon the deterministic core.** The choice to avoid LLM routing for every turn is the right one for a Raspberry Pi 5. Probabilistic routing is 10x–50x slower and less reliable for "Turn on the lights".

**Instead, evolve the "Skill Manager" into a "Bridge":**
1.  Keep the **Manifest-driven Scorer** for speed.
2.  Add **MCP Support** to inherit the global ecosystem of tools.
3.  Add **Semantic Router** hooks to handle the "Clarify" cases more intelligently.