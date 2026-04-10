#!/usr/bin/env python3
"""Seed synthetic experiment data into chat_traces and fact_telemetry.

Creates four synthetic users (two per experiment arm), generates
realistic multi-turn conversation traces with non-deterministic
latency and injection behavior, so the eval script can compare arms
without built-in bias.

Usage:
    PYTHONPATH=. uv run python scripts/seed_experiment_data.py
    PYTHONPATH=. uv run python scripts/seed_experiment_data.py --turns 40
    PYTHONPATH=. uv run python scripts/seed_experiment_data.py --clean
"""
from __future__ import annotations

import argparse
import json
import random
import time

from lokidoki.core.memory_init import open_and_migrate
from lokidoki.core import memory_sql as sql

# ---------------------------------------------------------------------------
# Realistic multi-turn conversations modeled after actual user behavior.
# Each conversation is a sequence of turns with expected routing.
# ---------------------------------------------------------------------------

CONVERSATIONS = [
    # Conversation 1: Laptop thermal modding (technical, multi-turn)
    [
        {"input": "hey so I'm modding my laptop for better thermals", "lane": "social_ack", "injected_range": (0, 1), "retrieved_range": (2, 5)},
        {"input": "should I use liquid metal or PTM7950 for the CPU?", "lane": "full_synthesis", "injected_range": (1, 3), "retrieved_range": (4, 8)},
        {"input": "what about for 24/7 operation, which lasts longer?", "lane": "full_synthesis", "injected_range": (1, 3), "retrieved_range": (3, 7)},
        {"input": "ok what about the VRAM pads, I heard TG Putty Pro is good", "lane": "full_synthesis", "injected_range": (2, 4), "retrieved_range": (5, 9)},
        {"input": "and for the SSD?", "lane": "full_synthesis", "injected_range": (1, 2), "retrieved_range": (3, 6)},
        {"input": "thanks that helps a lot", "lane": "social_ack", "injected_range": (0, 0), "retrieved_range": (1, 2)},
    ],
    # Conversation 2: Cooking / personal (emotional + fact-sharing)
    [
        {"input": "im so tired today", "lane": "full_synthesis", "injected_range": (1, 2), "retrieved_range": (3, 6)},
        {"input": "my wife's birthday is coming up and I have no idea what to cook", "lane": "full_synthesis", "injected_range": (2, 4), "retrieved_range": (5, 9)},
        {"input": "she likes Italian food but nothing too heavy", "lane": "social_ack", "injected_range": (1, 2), "retrieved_range": (3, 6)},
        {"input": "what about a risotto? is that hard to make?", "lane": "full_synthesis", "injected_range": (1, 3), "retrieved_range": (4, 7)},
        {"input": "oh and she's allergic to shellfish, forgot to mention", "lane": "social_ack", "injected_range": (1, 2), "retrieved_range": (3, 5)},
        {"input": "ok mushroom risotto sounds perfect, thanks!", "lane": "social_ack", "injected_range": (0, 1), "retrieved_range": (2, 4)},
    ],
    # Conversation 3: People / relationships (pronoun follow-ups)
    [
        {"input": "tell me about my brother", "lane": "full_synthesis", "injected_range": (2, 4), "retrieved_range": (5, 10)},
        {"input": "what does he do for work?", "lane": "full_synthesis", "injected_range": (2, 3), "retrieved_range": (4, 8)},
        {"input": "and his wife, what's her name again?", "lane": "full_synthesis", "injected_range": (2, 4), "retrieved_range": (5, 9)},
        {"input": "right, Sarah. when did they get married?", "lane": "full_synthesis", "injected_range": (1, 3), "retrieved_range": (4, 7)},
        {"input": "no wait, that's wrong. her name is Emily not Sarah", "lane": "full_synthesis", "injected_range": (2, 3), "retrieved_range": (5, 8)},
    ],
    # Conversation 4: Current events / knowledge lookups
    [
        {"input": "what happened with the band Queensryche?", "lane": "grounded_direct", "injected_range": (0, 1), "retrieved_range": (2, 5)},
        {"input": "did they split into two bands?", "lane": "full_synthesis", "injected_range": (0, 1), "retrieved_range": (2, 4)},
        {"input": "who is the current lead singer?", "lane": "grounded_direct", "injected_range": (0, 0), "retrieved_range": (1, 3)},
        {"input": "what's their best album in your opinion?", "lane": "full_synthesis", "injected_range": (1, 2), "retrieved_range": (3, 6)},
    ],
    # Conversation 5: Movie night planning (mixed skills + memory)
    [
        {"input": "what movies are playing tonight?", "lane": "grounded_direct", "injected_range": (0, 1), "retrieved_range": (2, 5)},
        {"input": "anything good for my wife and me?", "lane": "full_synthesis", "injected_range": (2, 3), "retrieved_range": (4, 8)},
        {"input": "she doesn't like horror movies tho", "lane": "social_ack", "injected_range": (1, 2), "retrieved_range": (3, 5)},
        {"input": "what about that new Ryan Reynolds movie", "lane": "full_synthesis", "injected_range": (1, 3), "retrieved_range": (4, 7)},
        {"input": "ok book two tickets for the 7pm showing", "lane": "grounded_direct", "injected_range": (0, 1), "retrieved_range": (2, 4)},
    ],
    # Conversation 6: Quick greetings and gratitude
    [
        {"input": "good morning!", "lane": "social_ack", "injected_range": (0, 1), "retrieved_range": (1, 3)},
        {"input": "how's it going", "lane": "social_ack", "injected_range": (0, 1), "retrieved_range": (1, 3)},
    ],
    # Conversation 7: Emotional support (multi-turn)
    [
        {"input": "I'm really stressed about this job interview tomorrow", "lane": "full_synthesis", "injected_range": (1, 3), "retrieved_range": (3, 7)},
        {"input": "it's for a senior engineering role at a startup", "lane": "social_ack", "injected_range": (1, 2), "retrieved_range": (3, 6)},
        {"input": "what if they ask me about system design and I blank?", "lane": "full_synthesis", "injected_range": (1, 2), "retrieved_range": (3, 6)},
        {"input": "you're right, I've done this before. thanks for talking me through it", "lane": "social_ack", "injected_range": (0, 1), "retrieved_range": (2, 4)},
    ],
    # Conversation 8: Raspberry Pi / home server setup
    [
        {"input": "I want to set up a home media server on my pi", "lane": "full_synthesis", "injected_range": (1, 3), "retrieved_range": (4, 8)},
        {"input": "should I use Jellyfin or Plex?", "lane": "full_synthesis", "injected_range": (1, 2), "retrieved_range": (3, 7)},
        {"input": "can the pi 5 handle 4K transcoding?", "lane": "full_synthesis", "injected_range": (0, 2), "retrieved_range": (3, 6)},
        {"input": "what about running it with an external SSD?", "lane": "full_synthesis", "injected_range": (1, 2), "retrieved_range": (3, 6)},
        {"input": "cool, I'll go with Jellyfin then", "lane": "social_ack", "injected_range": (0, 1), "retrieved_range": (2, 4)},
    ],
]

# Base latency ranges for synthesis (ms). These are the SAME for both
# experiment arms — no built-in bias.
SYNTHESIS_LATENCY_RANGE = (3000, 7500)
ROUTING_LATENCY_BASE = (20, 80)
# Reranker adds overhead to routing, measured independently
RERANKER_ROUTING_OVERHEAD = (40, 120)


def _random_latency(lo: float, hi: float) -> float:
    return random.uniform(lo, hi)


def _make_trace(
    turn: dict,
    mem_arm: str,
    reranker_arm: str,
) -> dict:
    injected = random.randint(*turn["injected_range"])
    retrieved = random.randint(*turn["retrieved_range"])
    # Ensure retrieved >= injected (can't inject what wasn't retrieved)
    retrieved = max(retrieved, injected)

    synth_ms = _random_latency(*SYNTHESIS_LATENCY_RANGE)
    route_ms = _random_latency(*ROUTING_LATENCY_BASE)
    if reranker_arm == "reranker":
        route_ms += _random_latency(*RERANKER_ROUTING_OVERHEAD)

    facts_by_bucket = {b: [] for b in ("working_context", "semantic_profile", "relational_graph", "episodic_threads")}
    cand_by_bucket = {b: [] for b in ("working_context", "semantic_profile", "relational_graph", "episodic_threads")}
    buckets = list(facts_by_bucket.keys())

    for i in range(injected):
        b = buckets[i % 4]
        facts_by_bucket[b].append({"id": random.randint(1, 200), "value": f"fact_{i}", "subject": "self"})
    for i in range(retrieved):
        b = buckets[i % 4]
        cand_by_bucket[b].append({"id": random.randint(1, 200), "value": f"cand_{i}", "subject": "self"})

    return {
        "response_lane_actual": turn["lane"],
        "response_lane_planned": turn["lane"],
        "shadow_disagrees": False,
        "decomposition": {
            "model": "gemma4:e2b",
            "latency_ms": random.uniform(80, 250),
            "reasoning_complexity": "thinking" if synth_ms > 5000 else "fast",
            "asks": [{"ask_id": "ask_001", "intent": "direct_chat", "distilled_query": turn["input"]}],
        },
        "referent_resolution": {"asks": []},
        "retrieved_memory_candidates": {"facts_by_bucket": cand_by_bucket, "past_messages": []},
        "selected_injected_memories": {
            "facts_by_bucket": facts_by_bucket,
            "past_messages": [],
            "experiment_arms": {
                "memory_format_v1": mem_arm,
                "reranker_v1": reranker_arm,
            },
        },
        "skill_results": {"routing_log": [], "results": {}},
        "prompt_sizes": {"decomposition": {"chars": random.randint(1500, 3000)}, "synthesis": {"chars": random.randint(3000, 6000)}},
        "response_spec_shadow": {"reply_mode": turn["lane"]},
        "phase_latencies": {
            "augmentation": random.uniform(15, 70),
            "decomposition": random.uniform(80, 250),
            "synthesis": synth_ms,
            "routing": route_ms,
            "verifier": random.uniform(0.1, 3.0),
        },
    }


def _clean_eval_data(conn):
    """Remove previously seeded eval traces and users."""
    for username in ("eval_user_a", "eval_user_b", "eval_user_c", "eval_user_d"):
        row = conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone()
        if row:
            uid = int(row["id"])
            conn.execute("DELETE FROM chat_traces WHERE owner_user_id = ?", (uid,))
            conn.execute("DELETE FROM messages WHERE owner_user_id = ?", (uid,))
            conn.execute("DELETE FROM sessions WHERE owner_user_id = ?", (uid,))
            conn.execute("DELETE FROM experiment_assignments WHERE user_id = ?", (uid,))
    conn.commit()
    print("Cleaned previous eval data.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed experiment data")
    parser.add_argument("--db", default="data/lokidoki.db")
    parser.add_argument("--turns", type=int, default=40, help="Min turns per arm (default: 40)")
    parser.add_argument("--clean", action="store_true", help="Remove previous eval data first")
    args = parser.parse_args()

    conn, _ = open_and_migrate(args.db)

    if args.clean:
        _clean_eval_data(conn)

    # Four users: 2 per arm combo, so we get variance within arms too
    users = [
        ("eval_user_a", "control", "control"),
        ("eval_user_b", "warm", "reranker"),
        ("eval_user_c", "control", "reranker"),
        ("eval_user_d", "warm", "control"),
    ]

    total = 0
    for username, mem_arm, rer_arm in users:
        uid = sql.get_or_create_user(conn, username)
        sid = sql.create_session(conn, uid, f"eval session {username}")
        sql.set_experiment_arm(conn, uid, "memory_format_v1", mem_arm)
        sql.set_experiment_arm(conn, uid, "reranker_v1", rer_arm)

        # Each user runs through the conversations, cycling until we hit
        # the target turn count
        turn_count = 0
        conv_idx = 0
        while turn_count < args.turns:
            conv = CONVERSATIONS[conv_idx % len(CONVERSATIONS)]
            for turn in conv:
                trace = _make_trace(turn, mem_arm, rer_arm)
                msg_id = sql.add_message(
                    conn, user_id=uid, session_id=sid,
                    role="user", content=turn["input"],
                )
                sql.add_chat_trace(
                    conn,
                    user_id=uid,
                    session_id=sid,
                    user_message_id=msg_id,
                    response_lane_actual=trace["response_lane_actual"],
                    response_lane_planned=trace["response_lane_planned"],
                    shadow_disagrees=trace["shadow_disagrees"],
                    decomposition=trace["decomposition"],
                    referent_resolution=trace["referent_resolution"],
                    retrieved_memory_candidates=trace["retrieved_memory_candidates"],
                    selected_injected_memories=trace["selected_injected_memories"],
                    skill_results=trace["skill_results"],
                    prompt_sizes=trace["prompt_sizes"],
                    response_spec_shadow=trace["response_spec_shadow"],
                    phase_latencies=trace["phase_latencies"],
                )
                turn_count += 1
                total += 1
            conv_idx += 1

        print(f"  {username}: {turn_count} turns (memory_format={mem_arm}, reranker={rer_arm})")

    conn.close()
    print(f"\nSeeded {total} traces across {len(users)} users.")
    print(f"Run: PYTHONPATH=. uv run python scripts/eval_experiments.py")


if __name__ == "__main__":
    main()
