# Chunk 3 — Persona packs on top of character/workspace systems

## Goal

Add inspectable local persona-pack files while preserving the current
character/workspace database model and SQLite-backed memory tiers.

## Files

Touch:

- `lokidoki/persona_packs/store.py`
- `lokidoki/persona_packs/composer.py`
- `lokidoki/api/routes/characters.py`
- `lokidoki/api/routes/workspaces.py`
- `tests/unit/test_persona_pack_composer.py`

Read-only:

- `docs/companion-device-master-service/DESIGN.md`
- `docs/lokidoki-presence-enhancement-design.md`

## Actions

1. Define persona-pack file layout and load rules.
2. Add composer logic that merges:
   - character metadata
   - persona-pack files
   - workspace persona selection
   - effective interaction policy knobs
3. Keep durable user memory in existing memory tiers.
4. Add tests proving:
   - pack loading is deterministic
   - workspace selection changes persona composition
   - interaction policy can flatten styling without changing selected character

## Verify

```bash
pytest tests/unit/test_persona_pack_composer.py
```

## Commit message

```text
feat(persona): add local persona-pack composition
```
