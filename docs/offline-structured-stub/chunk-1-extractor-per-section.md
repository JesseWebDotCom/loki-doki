# Chunk 1 — `_LeadExtractor` captures per-section opening paragraphs

## Goal

Extend [`_LeadExtractor`](../../lokidoki/skills/knowledge/_parse.py#L140) to capture not just H2 section **titles** but also the **first `<p>` paragraph** inside each section. `parse_wiki_html` returns a richer shape so downstream callers can render structured markdown (chunk 2). Zero LLM. Pure HTMLParser logic.

## Files

Touch:
- `lokidoki/skills/knowledge/_parse.py`
- `lokidoki/skills/knowledge/skill.py` (adjust only the call-site destructuring if return shape changes)
- `tests/unit/test_knowledge_parse.py` (locate via `rg -n "parse_wiki_html\|_LeadExtractor" tests`; create if absent)

Read-only reference:
- `lokidoki/skills/knowledge/_parse.py` L140–233 (current extractor)

## Actions

1. Define a new dataclass (or TypedDict) `WikiSection` with fields `title: str, paragraph: str` at module top of `_parse.py`.
2. Extend `_LeadExtractor` state:
   - `self._current_section_title: str | None = None` (set at `</h2>` close).
   - `self._current_section_paragraph: list[str] = []` (accumulating the first `<p>` inside the current section).
   - `self._section_paragraph_captured: bool = False` (per-section flag — only capture the FIRST paragraph, skip the rest of the section body).
   - `self.section_items: list[WikiSection] = []`.
3. In `handle_starttag` / `handle_endtag`:
   - On `<h2>` open after `_seen_first_h2`: reset `_current_section_title`, `_current_section_paragraph`, `_section_paragraph_captured = False`.
   - On `<p>` open inside a section (`_seen_first_h2 and _current_section_title is not None and not _section_paragraph_captured`): flip `_in_section_p = True`.
   - On `</p>` close if `_in_section_p`: join buffer into one string, strip, if non-empty assign to `_current_section_paragraph`, set `_section_paragraph_captured = True`.
   - On next `<h2>` open OR end of content: flush the current section item by appending `WikiSection(title=_current_section_title, paragraph=''.join(_current_section_paragraph))` to `self.section_items` if both title and paragraph non-empty.
4. Skip `<table>`, `<sup>`, `<style>`, `<script>`, `<div class="hatnote">` inside sections (extend existing skip logic).
5. Update `parse_wiki_html` signature: `def parse_wiki_html(html: str) -> tuple[str, list[WikiSection]]:`. Keep `lead` shape unchanged.
6. In `skill.py` L261: `lead, sections = parse_wiki_html(...)` — the variable name stays, but the element type changes from `str` to `WikiSection`. Update `MechanismResult.data["sections"]` to serialize dataclasses: `[{"title": s.title, "paragraph": s.paragraph} for s in sections]`.
7. Keep the legacy H2-titles-only behavior available if needed: expose `parser.sections` (flat title list) alongside `parser.section_items` for any existing title-only consumer — OR audit callers and migrate them. Default: migrate.
8. Cap per-section paragraph length (e.g. 600 chars, soft-cut at sentence boundary with existing `_soft_cut` helper).

## Verify

```
uv run pytest tests/unit/test_knowledge_parse.py -v
```

Parser tests should cover: Ada Lovelace fixture (or Luke Skywalker placeholder wiki HTML), article with no H2s, article with H2 before any `<p>` (edge case — should produce section with empty paragraph, which we filter out), table/script skip.

## Commit message

```
feat(knowledge/parse): capture per-section opening paragraphs

Extends _LeadExtractor to record the first <p> inside each <h2>
section alongside the section title, returning a list of
WikiSection{title, paragraph} from parse_wiki_html. Enables structured
stub rendering in the knowledge skill (chunk 2) without engaging the
LLM. Lead paragraph extraction unchanged.

Refs docs/offline-structured-stub/PLAN.md chunk 1.
```

## Deferrals

(append-only)
