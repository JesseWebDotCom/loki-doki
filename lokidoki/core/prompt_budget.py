from __future__ import annotations

from typing import Callable


def estimate_prompt_tokens(text: str) -> int:
    return max(1, (len(text or "") + 3) // 4)


def _is_bucketed_facts(facts: object) -> bool:
    return isinstance(facts, dict)


def _sort_facts_for_budget(facts: list[dict]) -> list[dict]:
    return sorted(
        list(facts or []),
        key=lambda fact: (
            float(fact.get("score", 0.0) or 0.0),
            float(fact.get("confidence", 0.0) or 0.0),
            int(fact.get("id", 0) or 0),
        ),
        reverse=True,
    )


def _sort_bucketed_facts_for_budget(
    facts_by_bucket: dict[str, list[dict]],
) -> list[tuple[str, dict]]:
    rows: list[tuple[str, dict]] = []
    for bucket, facts in (facts_by_bucket or {}).items():
        for fact in facts or []:
            rows.append((bucket, fact))
    rows.sort(
        key=lambda item: (
            float(item[1].get("score", 0.0) or 0.0),
            float(item[1].get("confidence", 0.0) or 0.0),
            int(item[1].get("id", 0) or 0),
        ),
        reverse=True,
    )
    return rows


def _copy_bucketed_facts(facts_by_bucket: dict[str, list[dict]]) -> dict[str, list[dict]]:
    return {bucket: list(rows or []) for bucket, rows in (facts_by_bucket or {}).items()}


def _trim_skill_data_detail(skill_data: str) -> str:
    text = (skill_data or "").strip()
    if not text:
        return text
    parts = text.split(" | ")
    longest_index = max(range(len(parts)), key=lambda idx: len(parts[idx]))
    longest = parts[longest_index]
    if len(longest) <= 96:
        return text

    prefix = ""
    body = longest
    if longest.startswith("[src:") and "] " in longest:
        prefix, body = longest.split("] ", 1)
        prefix = prefix + "] "

    keep = max(72, int(len(body) * 0.7))
    shortened = prefix + body[:keep].rstrip()
    if not shortened.endswith("..."):
        shortened += "..."
    parts[longest_index] = shortened
    return " | ".join(parts)


def enforce_prompt_budget(
    *,
    build_prompt: Callable[..., str],
    facts: list[dict],
    past_messages: list[dict],
    skill_data: str,
    num_ctx: int,
    budget_ratio: float = 0.8,
) -> tuple[str, dict]:
    if _is_bucketed_facts(facts):
        kept_facts = _copy_bucketed_facts(facts)
    else:
        kept_facts = _sort_facts_for_budget(facts)
    kept_messages = list(past_messages or [])
    kept_skill_data = skill_data or ""
    max_tokens = max(1, int(num_ctx * budget_ratio))
    dropped_fact_ids: list[int] = []
    dropped_message_ids: list[int] = []
    skill_data_trimmed = False

    prompt = build_prompt(
        facts=kept_facts,
        messages=kept_messages,
        skill_data=kept_skill_data,
        )
    estimated_tokens = estimate_prompt_tokens(prompt)

    while estimated_tokens > max_tokens and kept_facts:
        if _is_bucketed_facts(kept_facts):
            ranked = _sort_bucketed_facts_for_budget(kept_facts)
            if not ranked:
                break
            bucket, dropped = ranked[-1]
            kept_facts[bucket] = [
                row for row in kept_facts.get(bucket, [])
                if row is not dropped
            ]
        else:
            dropped = kept_facts.pop()
        if dropped.get("id") is not None:
            dropped_fact_ids.append(int(dropped["id"]))
        prompt = build_prompt(
            facts=kept_facts,
            messages=kept_messages,
            skill_data=kept_skill_data,
        )
        estimated_tokens = estimate_prompt_tokens(prompt)

    while estimated_tokens > max_tokens and kept_messages:
        dropped = kept_messages.pop()
        if dropped.get("id") is not None:
            dropped_message_ids.append(int(dropped["id"]))
        prompt = build_prompt(
            facts=kept_facts,
            messages=kept_messages,
            skill_data=kept_skill_data,
        )
        estimated_tokens = estimate_prompt_tokens(prompt)

    while estimated_tokens > max_tokens:
        trimmed = _trim_skill_data_detail(kept_skill_data)
        if trimmed == kept_skill_data:
            break
        kept_skill_data = trimmed
        skill_data_trimmed = True
        prompt = build_prompt(
            facts=kept_facts,
            messages=kept_messages,
            skill_data=kept_skill_data,
        )
        estimated_tokens = estimate_prompt_tokens(prompt)

    return prompt, {
        "truncated": bool(dropped_fact_ids or dropped_message_ids or skill_data_trimmed),
        "estimated_tokens": estimated_tokens,
        "max_tokens": max_tokens,
        "dropped_fact_ids": dropped_fact_ids,
        "dropped_message_ids": dropped_message_ids,
        "skill_data_trimmed": skill_data_trimmed,
        "facts_kept": (
            sum(len(rows or []) for rows in kept_facts.values())
            if _is_bucketed_facts(kept_facts)
            else len(kept_facts)
        ),
        "messages_kept": len(kept_messages),
    }
