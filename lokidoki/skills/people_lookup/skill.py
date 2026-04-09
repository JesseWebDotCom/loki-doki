"""People lookup skill — searches the user's relationship graph."""
from __future__ import annotations

from lokidoki.core.skill_executor import BaseSkill, MechanismResult


class PeopleLookupSkill(BaseSkill):
    async def execute_mechanism(
        self, method: str, parameters: dict
    ) -> MechanismResult:
        if method != "graph_query":
            raise ValueError(f"Unknown mechanism: {method}")

        people_rows: list[dict] = parameters.get("_people_rows") or []
        relationships: list[dict] = parameters.get("_relationships") or []
        graph_relations: list[str] = parameters.get("_graph_relations") or []
        query_relation = (parameters.get("relation") or "").strip().lower()
        query_name = (parameters.get("name") or "").strip().lower()

        # Build a lookup: person_id → {name, relations[]}
        people_by_id: dict[int, dict] = {}
        for p in people_rows:
            pid = int(p.get("id") or 0)
            name = (p.get("name") or "").strip()
            if pid and name:
                people_by_id[pid] = {
                    "id": pid,
                    "name": name,
                    "bucket": p.get("bucket", ""),
                    "relations": [],
                }

        # Attach relation labels from the relationships list.
        for rel in relationships:
            pid = int(rel.get("person_id") or 0)
            relation = (rel.get("relation") or "").strip()
            if pid in people_by_id and relation:
                people_by_id[pid]["relations"].append(relation)

        # Also parse graph_relations lines "- relation: Name".
        name_to_relations: dict[str, list[str]] = {}
        for line in graph_relations:
            parts = line.lstrip("- ").split(":", 1)
            if len(parts) == 2:
                relation = parts[0].strip()
                gname = parts[1].strip()
                if gname and relation:
                    name_to_relations.setdefault(gname.lower(), []).append(relation)

        for entry in people_by_id.values():
            extra = name_to_relations.get(entry["name"].lower(), [])
            for r in extra:
                if r not in entry["relations"]:
                    entry["relations"].append(r)

        # Search by relation, name, or both.
        matches: list[dict] = []
        if query_relation:
            for entry in people_by_id.values():
                if any(query_relation in r.lower() for r in entry["relations"]):
                    matches.append(entry)
        if query_name and not matches:
            for entry in people_by_id.values():
                if query_name in entry["name"].lower():
                    matches.append(entry)
        if not query_relation and not query_name:
            # No specific query — return all people with relations.
            matches = [e for e in people_by_id.values() if e["relations"]]

        if not matches:
            # No match — signal clarification needed.
            relation_label = query_relation or query_name or "that person"
            return MechanismResult(
                success=True,
                data={
                    "needs_clarification": True,
                    "clarification_prompt": (
                        f"I don't have a record of your {relation_label} yet. "
                        f"What's their name?"
                    ),
                    "matches": [],
                },
            )

        # Format matches for the synthesis prompt.
        formatted: list[dict] = []
        for m in matches[:8]:
            formatted.append({
                "name": m["name"],
                "relations": m["relations"],
                "bucket": m["bucket"],
                "id": m["id"],
            })

        if len(formatted) == 1:
            person = formatted[0]
            rels = ", ".join(person["relations"]) or "known person"
            lead = f"Your {rels}: {person['name']}"
        else:
            lines = []
            for person in formatted:
                rels = ", ".join(person["relations"]) or "known"
                lines.append(f"- {person['name']} ({rels})")
            lead = "\n".join(lines)

        return MechanismResult(
            success=True,
            data={
                "lead": lead,
                "matches": formatted,
                "match_count": len(formatted),
            },
        )
