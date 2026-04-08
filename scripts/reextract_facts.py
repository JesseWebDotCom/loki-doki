"""Re-run the decomposer over historical user messages and re-persist facts.

The Memory tab can fill up with extraction garbage when the decomposer
prompt is too loose (the Biodome / St. Elmo's Fire bug). The fix is in
the prompt, but old rows produced by the old prompt stay broken until
something walks the source messages and re-extracts them.

This script does exactly that. It:
  1. Wipes the existing facts/people/relationships rows for a user
     (optional — gated by --wipe).
  2. Walks every user-role message for that user in chronological order.
  3. Calls the current decomposer for each message.
  4. Pipes the validated long_term_memory items through
     ``persist_long_term_item`` exactly as the live orchestrator would.

Run it after any change to the decomposer prompt or to LongTermItem.

Usage:
    uv run python -m scripts.reextract_facts --user jesse --wipe
    uv run python -m scripts.reextract_facts --user jesse --dry-run
"""
from __future__ import annotations

import argparse
import asyncio
import logging

from lokidoki.core.decomposer import Decomposer
from lokidoki.core.inference import InferenceClient
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import memory_people_ops  # noqa: F401 — binds people methods onto MemoryProvider
from lokidoki.core.orchestrator_memory import persist_long_term_item

logger = logging.getLogger("reextract")


async def _wipe_user_memory(memory: MemoryProvider, user_id: int) -> None:
    """Hard-delete every fact/person/relationship row for one user.

    Messages are preserved — they're the source we're re-extracting from.
    """
    def _do(conn):
        conn.execute("DELETE FROM facts WHERE owner_user_id = ?", (user_id,))
        conn.execute("DELETE FROM relationships WHERE owner_user_id = ?", (user_id,))
        conn.execute("DELETE FROM ambiguity_groups WHERE owner_user_id = ?", (user_id,))
        conn.execute("DELETE FROM people WHERE owner_user_id = ?", (user_id,))
        conn.commit()

    await memory.run_sync(_do)


async def _all_user_messages(memory: MemoryProvider, user_id: int) -> list[dict]:
    """Return every user-role message for a user, oldest first."""
    def _do(conn):
        rows = conn.execute(
            "SELECT id, session_id, content, created_at FROM messages "
            "WHERE owner_user_id = ? AND role = 'user' "
            "ORDER BY id ASC",
            (user_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    return await memory.run_sync(_do)


async def reextract(
    *,
    username: str,
    wipe: bool,
    dry_run: bool,
    db_path: str,
) -> None:
    memory = MemoryProvider(db_path=db_path)
    await memory.initialize()
    try:
        user_id = await memory.get_or_create_user(username)
        if wipe and not dry_run:
            logger.info("wiping facts/people/relationships for user_id=%s", user_id)
            await _wipe_user_memory(memory, user_id)

        messages = await _all_user_messages(memory, user_id)
        logger.info("re-extracting %d user messages for %s", len(messages), username)

        inference = InferenceClient()
        decomposer = Decomposer(inference_client=inference)

        total_items = 0
        for i, msg in enumerate(messages, start=1):
            content = msg["content"] or ""
            if not content.strip():
                continue
            try:
                result = await decomposer.decompose(user_input=content)
            except Exception:
                logger.exception("[%d/%d] decompose failed for msg %s", i, len(messages), msg["id"])
                continue
            # Mirror the live orchestrator: when every ask is a verbatim
            # lookup ("Who is X?", "What is Y?"), drop long_term_memory
            # wholesale. The decomposer reliably misreads question
            # phrasing as a fact assertion, and downstream salvages
            # can't safely undo that.
            if (
                result.asks
                and all(
                    getattr(a, "response_shape", "synthesized") == "verbatim"
                    for a in result.asks
                )
            ):
                continue
            items = result.long_term_memory or []
            if dry_run:
                if items:
                    print(f"[{i}/{len(messages)}] msg {msg['id']}: {len(items)} items")
                    for it in items:
                        print(f"    {it}")
                continue
            for item in items:
                try:
                    await persist_long_term_item(
                        memory,
                        user_id=user_id,
                        user_msg_id=int(msg["id"]),
                        item=item or {},
                        user_input=content,
                    )
                    total_items += 1
                except Exception:
                    logger.exception("persist failed for item=%r", item)

        logger.info("done. %d items written.", total_items)
    finally:
        await memory.close()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user", required=True, help="username to re-extract for")
    parser.add_argument("--wipe", action="store_true", help="delete existing facts/people first")
    parser.add_argument("--dry-run", action="store_true", help="print extracted items without writing")
    parser.add_argument("--db", default="data/lokidoki.db", help="path to the SQLite DB")
    args = parser.parse_args()
    asyncio.run(reextract(
        username=args.user,
        wipe=args.wipe,
        dry_run=args.dry_run,
        db_path=args.db,
    ))


if __name__ == "__main__":
    main()
