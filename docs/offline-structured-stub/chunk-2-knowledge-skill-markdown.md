# Chunk 2 — Knowledge skill composes structured markdown

## Goal

Knowledge skill assembles a structured markdown stub from the chunk-1 parse output: lead paragraph on top, followed by the first 2–3 H2 sections each rendered as `## Title\n\n<paragraph>\n\n`. This rendered string replaces the current lead-only body in the skill's response data. Pure string assembly; no LLM.

## Files

Touch:
- `lokidoki/skills/knowledge/skill.py`
- `tests/unit/test_knowledge_skill.py` (locate via `rg -n "knowledge" tests/unit`; create if absent)

Read-only reference:
- `lokidoki/skills/knowledge/_parse.py` (post-chunk 1 shape)
- `lokidoki/core/skill_executor.py` (`MechanismResult` shape)

## Actions

1. In `skill.py`, after `lead, sections = parse_wiki_html(...)` (L261), compose a new field `structured_markdown`:
   - Start with `lead.strip()`.
   - Append up to **3** sections: `\n\n## {title}\n\n{paragraph}` for the first 3 `WikiSection` entries.
   - Drop any section whose paragraph is empty after strip.
   - Cap total output at ~2500 chars (soft-cut at sentence boundary on the last section's paragraph).
2. Filter out stub/navigational sections by title — drop if `title.lower()` ∈ `{"see also", "references", "notes", "external links", "bibliography", "further reading", "footnotes", "sources"}`. These are zero-value in a voice/chat context.
3. Return shape: `MechanismResult.data = {"title": title, "lead": lead, "sections": [...], "structured_markdown": structured_markdown, "url": url}`. Keep the existing fields to avoid breaking downstream consumers that read `lead` directly.
4. Keep `source_url` / `source_title` unchanged (chunk 3 routing uses these for the source chip).
5. Tests: mock `httpx.AsyncClient.get` with a fixture Wikipedia HTML (pop-culture placeholder — Luke Skywalker, Leia Organa, etc.). Assert:
   - `structured_markdown` contains the lead AND at least two `## ` section headers.
   - "See also" and "References" sections are absent.
   - Length cap enforced.
   - When the article has zero H2s, `structured_markdown == lead` exactly.

## Verify

```
uv run pytest tests/unit/test_knowledge_skill.py tests/unit/test_knowledge_parse.py -v
```

## Commit message

```
feat(knowledge): compose structured markdown stub

Assembles ``structured_markdown`` from the lead paragraph plus the
first 2-3 H2 sections (each as ``## Title\n\n<paragraph>``), filtering
navigational sections (See also / References / etc.) and capping at
~2500 chars. Skill data keeps existing fields; chunk 3 wires this into
the Auto-mode non-rich response path.

Refs docs/offline-structured-stub/PLAN.md chunk 2.
```

## Deferrals

(append-only)
