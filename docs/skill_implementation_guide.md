# LokiDoki Skill System: Technical Implementation Deep Dive

This document provides a comprehensive technical analysis of how skills are built, triggered, routed, and executed in LokiDoki.

---

## 1. Rationale: Why a Deterministic Skill System?

Most modern assistants rely on LLMs to decide which tools to use. For LokiDoki, we chose a **deterministic, manifest-driven approach** for several critical reasons:

-   **Zero-Latency Routing**: Running an LLM for every user turn adds measurable latency. For a Raspberry Pi 5 / CPU-first environment, routing should take <50ms.
-   **Reliability vs. Hallucination**: LLMs frequently hallucinate tool arguments or choose incorrect APIs. Deterministic scoring guarantees that "Turn off the lights" hits the `lights` skill every time.
-   **Resource Efficiency**: By resolving intent on the CPU using rule-based scoring and entity extraction, we save the NPU/Hailo for the heavy lifting: the actual character conversation.
-   **Privacy & Localism**: Deterministic routing doesn't require sending user data to a cloud-based router; all intent resolution happens locally within the `loki-doki` control plane.

---

## 2. Architecture Overview: The Pre-emptive Pipeline

The Skill System is implemented as a **pre-emptive routing layer** in the chat orchestration pipeline.

### Flow of a Request:
1.  **API Entry**: `app/api/chat.py` receives a `chat_message_stream_api` request.
2.  **Skill Inspection**: `SkillService.inspect_route` analyzes the message and history to determine if a skill match is likely.
3.  **Skill Execution**: `SkillService.route_and_execute` is called.
    -   If a match is found (`skill_call`), the skill is executed immediately.
    -   If a match is ambiguous (`clarify`), a clarification response is returned.
    -   If no match is found (`no_skill`), the system falls back to the standard LLM (`route_message_stream`).
4.  **Result Integration**: If a skill was executed, its structured result is passed to `app/skills/response.py`.
    -   `build_skill_reply`: Generates a natural language **voice reply** and a **UI card** based on the skill's data and its `presentation_type`.
5.  **Final Streaming**: The generated `reply` and `meta` (including the skill result) are streamed to the UI as NDJSON events.

---

## 3. Triggering Logic: Scoring and Routing

The core of the Skill System is the `SkillRouter` (`app/skills/router.py`). It uses a deterministic scoring algorithm based on the metadata provided in each skill's `manifest.json`.

### 3.1 The Scoring Algorithm (`_score_action`)
Each action in every enabled skill is scored against the user's message. The final score is a sum of several components:

| Component | Logic | Score Change |
| :--- | :--- | :--- |
| **Exact Phrase** | User message exactly matches or starts with an activator phrase. | **+3.2** |
| **Leading Phrase** | Message starts with "Please [phrase]", "Can you [phrase]", etc. | **+3.2** |
| **Keyword Hit** | Individual keyword from manifest found in message. | **+0.8 per hit** (max 2.4) |
| **Search Intent** | Message looks like a lookup ("Who is...", "What is...", long sentence). | **+0.8 to +1.4** |
| **Domain Lookup** | Specific keywords like "wiki", "movie", "show", "cast". | **+1.4 to +4.5** |

### 3.2 Thresholds and Outcomes
-   **Skill Call**: Top score >= `MIN_ROUTE_SCORE` (3.0).
-   **Clarification**: Top score is above `MIN_SKILL_CALL_SCORE` (1.5) but too close to the second-best candidate (delta < `CLARIFY_MARGIN` 0.75).

---

## 4. Conflict Resolution: Overlapping Skills

If two skills (e.g., `movies` and `tv_shows`) both claim to handle a query, LokiDoki uses two reconciliation strategies:

1.  **Scoring Hierarchy**: The skill with better-defined phrases and keyword density wins.
2.  **The "Clarify" Safety Valve**: If the scores of two top candidates are within **0.75 points** of each other, the system refuses to guess. It instead triggers a **Clarification Prompt** (e.g., "I found two options for showtimes. Did you mean the Movie skill or the YouTube skill?").

---

## 5. Execution Strategy: Parallelism vs. Sequentiality

LokiDoki optimizes for **predictable CPU usage** rather than raw through-put.

-   **Sequential Execution**: Skill routing and execution are **sequential**. We do not run multiple skills in parallel for a single request to avoid CPU spiking on Raspberry Pi hardware.
-   **Pre-emptive Win**: If a skill matches with high confidence, the system **cancels the general LLM generation** entirely. This "one-best" strategy ensures the user gets a fast, focused answer instead of multiple competing outputs.
-   **Reconciliation**: There is no "result reconciliation" because only one skill (or its fallback chain) is ever fully executed for a primary intent.

---

## 6. Performance & Efficiency Optimizations

-   **Lazy Loading**: Skills are imported via `SkillLoader` only when they are first routed or used, keeping initial startup memory low.
-   **Snippet-First Web Search**: The `web_search` skill avoids full-page scraping. It ingests 800-character snippets which provides sufficient context for the "Thinking LLM" without the latency of DOM parsing.
-   **Rule-Based NLU**: Entity extraction (dates, locations, queries) is done via regex and keyword mapping, avoiding the token cost and latency of a secondary LLM call.
-   **Response Styles**: The `resolve_response_style_policy` ensures that for long search results, the assistant remains "detailed", while for command execution, it stays "brief".

---

## 7. Skill Format: The Required Contract

A skill is a directory containing a `manifest.json` and a `skill.py`.

### manifest.json (Example)
```json
{
  "id": "lights_skill",
  "title": "Home Lights",
  "version": "1.0.0",
  "system": false,
  "actions": {
    "toggle": {
      "phrases": ["turn the lights", "toggle the light"],
      "keywords": ["lights", "on", "off", "bright"],
      "required_entities": ["state"]
    }
  }
}
```

### skill.py (Example)
```python
from app.skills.base import BaseSkill

class LightsSkill(BaseSkill):
    async def execute(self, action, ctx, **kwargs):
        state = kwargs.get("state", "on")
        # Logic to toggle lights using ctx['accounts'] or ctx['shared_context']
        return {
            "ok": True,
            "data": {"summary": f"I've turned the lights {state}."},
            "presentation": {"type": "summary"}
        }
```

For more details on building complex skills, see [skills.md](file:///Users/jessetorres/Projects/loki-doki/docs/skills.md).
