import sqlite3
import pytest
from datetime import datetime, timedelta
from app.subsystems.memory.ambient import get_ambient_context
from app.subsystems.memory.records import write_memory, list_memory, prune_memory
from app.db import initialize_database

@pytest.fixture
def conn():
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    initialize_database(connection)
    connection.execute(
        "INSERT INTO users (id, username, display_name, password_hash) VALUES (?, ?, ?, ?)",
        ("test_user", "test", "Test User", "hash")
    )
    connection.commit()
    return connection

def test_ambient_context_basics(conn):
    user_id = "test_user"
    character_id = "test_char"
    
    # 1. Basic time/date
    context = get_ambient_context(conn, user_id, character_id)
    assert "<now>" in context
    assert "<time_of_day>" in context
    assert "test_user" not in context # Should be XML tags only
    
    # 2. History signal (first time)
    assert "<last_talked>first time talking</last_talked>" in context
    
    # 3. Add a session to test "talked recently"
    conn.execute(
        "INSERT INTO chat_sessions (id, user_id, character_id, title, updated_at) VALUES (?, ?, ?, ?, ?)",
        ("session_1", user_id, character_id, "Old Chat", datetime.now().isoformat())
    )
    context = get_ambient_context(conn, user_id, character_id)
    assert "<last_talked>talked recently</last_talked>" in context

def test_memory_importance_queue(conn):
    user_id = "test_user"
    character_id = "test_char"
    
    # Low confidence fact - should NOT be in real memory, should be in queue
    fact_text = "I love blueberries"
    write_memory(conn, scope="person", user_id=user_id, character_id=character_id, key="ignore", value=fact_text, confidence=0.5)
    
    memories = list_memory(conn, "person", user_id, character_id=character_id)
    assert not any(m["value"] == fact_text for m in memories)
    
    # Check queue
    row = conn.execute("SELECT surface_count FROM memory_importance_queue WHERE candidate_text = ?", (fact_text,)).fetchone()
    assert row is not None
    assert row["surface_count"] == 1
    
    # Repeat the fact twice more to trigger promotion
    write_memory(conn, scope="person", user_id=user_id, character_id=character_id, key="ignore", value=fact_text, confidence=0.5)
    write_memory(conn, scope="person", user_id=user_id, character_id=character_id, key="ignore", value=fact_text, confidence=0.5)
    
    # Should now be promoted
    memories = list_memory(conn, "person", user_id, character_id=character_id)
    assert any(m["value"] == fact_text for m in memories)
    
    # Queue should be empty for this candidate
    row = conn.execute("SELECT * FROM memory_importance_queue WHERE candidate_text = ?", (fact_text,)).fetchone()
    assert row is None

def test_memory_pruning(conn):
    user_id = "test_user"
    character_id = "test_char"
    
    # Add an expired memory
    past = (datetime.now() - timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%fZ')
    conn.execute(
        "INSERT INTO mem_char_user_memory (character_id, user_id, key, value, expires_at) VALUES (?, ?, ?, ?, ?)",
        (character_id, user_id, "temp", "will vanish", past)
    )
    
    # Add a fresh memory
    future = (datetime.now() + timedelta(days=1)).strftime('%Y-%m-%dT%H:%M:%fZ')
    conn.execute(
        "INSERT INTO mem_char_user_memory (character_id, user_id, key, value, expires_at) VALUES (?, ?, ?, ?, ?)",
        (character_id, user_id, "stay", "will stay", future)
    )
    
    # Prune
    count = prune_memory(conn)
    assert count >= 1
    
    # Verify
    memories = conn.execute("SELECT key FROM mem_char_user_memory").fetchall()
    keys = [m["key"] for m in memories]
    assert "temp" not in keys
    assert "stay" in keys

def test_direct_high_confidence_write(conn):
    user_id = "test_user"
    character_id = "test_char"
    
    # 0.95 > WRITE_THRESHOLD (0.85). This should hit the fixed code path.
    fact_text = "I am a software engineer."
    write_memory(
        conn, 
        scope="person", 
        user_id=user_id, 
        character_id=character_id, 
        key="job", 
        value=fact_text, 
        confidence=0.95,
        importance=5
    )
    
    memories = list_memory(conn, "person", user_id, character_id=character_id)
    assert any(m["value"] == fact_text for m in memories)
    
    # Verify importance was also saved correctly
    row = conn.execute("SELECT importance FROM mem_char_user_memory WHERE key = 'job'").fetchone()
    assert row["importance"] == 5
