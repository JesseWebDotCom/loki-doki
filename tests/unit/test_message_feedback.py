"""Unit tests for message feedback (thumbs up / thumbs down).

Coverage:
- upsert creates a new feedback row
- upsert updates existing feedback (toggle)
- list_message_feedback returns entries with message content
- feedback is user-scoped (user A can't see user B's feedback)
"""
import pytest

from lokidoki.core.memory_provider import MemoryProvider


@pytest.fixture
async def memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "feedback.db"))
    await mp.initialize()
    yield mp
    await mp.close()


@pytest.mark.anyio
async def test_upsert_creates_feedback(memory):
    uid = await memory.get_or_create_user("alice")
    sid = await memory.create_session(uid, "test")
    mid = await memory.add_message(user_id=uid, session_id=sid, role="assistant", content="Hello!")

    fid = await memory.upsert_message_feedback(
        user_id=uid,
        message_id=mid,
        rating=1,
        tags=["accurate", "helpful"],
        prompt="Tell me a joke.",
        response="Why did the chicken cross the road?",
    )
    assert fid > 0

    row = await memory.get_message_feedback(user_id=uid, message_id=mid)
    assert row is not None
    assert row["rating"] == 1
    assert row["comment"] == ""
    assert "accurate" in row["tags"]
    assert "helpful" in row["tags"]
    assert row["snapshot_prompt"] == "Tell me a joke."
    assert row["snapshot_response"] == "Why did the chicken cross the road?"


@pytest.mark.anyio
async def test_upsert_updates_existing(memory):
    uid = await memory.get_or_create_user("alice")
    sid = await memory.create_session(uid, "test")
    mid = await memory.add_message(user_id=uid, session_id=sid, role="assistant", content="Hello!")

    await memory.upsert_message_feedback(user_id=uid, message_id=mid, rating=1)
    await memory.upsert_message_feedback(
        user_id=uid, message_id=mid, rating=-1, comment="not helpful", tags=["hallucination"]
    )

    row = await memory.get_message_feedback(user_id=uid, message_id=mid)
    assert row["rating"] == -1
    assert row["comment"] == "not helpful"
    assert row["tags"] == '["hallucination"]' or "hallucination" in row["tags"]



@pytest.mark.anyio
async def test_list_feedback_with_content(memory):
    uid = await memory.get_or_create_user("alice")
    sid = await memory.create_session(uid, "test")
    m1 = await memory.add_message(user_id=uid, session_id=sid, role="assistant", content="Good answer")
    m2 = await memory.add_message(user_id=uid, session_id=sid, role="assistant", content="Bad answer")

    await memory.upsert_message_feedback(user_id=uid, message_id=m1, rating=1)
    await memory.upsert_message_feedback(user_id=uid, message_id=m2, rating=-1)

    all_fb = await memory.list_message_feedback(user_id=uid)
    assert len(all_fb) == 2

    positive = await memory.list_message_feedback(user_id=uid, rating=1)
    assert len(positive) == 1
    assert positive[0]["content"] == "Good answer"

    negative = await memory.list_message_feedback(user_id=uid, rating=-1)
    assert len(negative) == 1
    assert negative[0]["content"] == "Bad answer"


@pytest.mark.anyio
async def test_feedback_user_scoped(memory):
    alice = await memory.get_or_create_user("alice")
    bob = await memory.get_or_create_user("bob")
    sid = await memory.create_session(alice, "test")
    mid = await memory.add_message(user_id=alice, session_id=sid, role="assistant", content="Hello!")

    await memory.upsert_message_feedback(user_id=alice, message_id=mid, rating=1)

    # Bob should not see Alice's feedback
    row = await memory.get_message_feedback(user_id=bob, message_id=mid)
    assert row is None

    bob_list = await memory.list_message_feedback(user_id=bob)
    assert len(bob_list) == 0
