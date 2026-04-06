from fastapi import APIRouter, Query
from lokidoki.core.sqlite_memory import SQLiteMemoryProvider
from lokidoki.core.bm25 import BM25Index
from lokidoki.core.context_restore import ContextRestorer

router = APIRouter()

# Module-level singletons (initialized on first use)
_db: SQLiteMemoryProvider | None = None
_restorer: ContextRestorer | None = None


async def get_db() -> SQLiteMemoryProvider:
    global _db
    if _db is None:
        _db = SQLiteMemoryProvider(db_path="data/lokidoki.db")
        await _db.initialize()
    return _db


async def get_restorer() -> ContextRestorer:
    global _restorer
    if _restorer is None:
        db = await get_db()
        bm25 = BM25Index()
        _restorer = ContextRestorer(db=db, bm25=bm25)
        await _restorer.rebuild_index()
    return _restorer


@router.get("/facts")
async def get_facts():
    """Return all stored long-term facts."""
    db = await get_db()
    facts = await db.get_all_facts()
    return {"facts": facts}


@router.get("/facts/search")
async def search_facts(q: str = Query(..., min_length=1)):
    """Search facts by keyword (BM25-powered)."""
    restorer = await get_restorer()
    results = restorer.search_relevant(q, top_k=10)
    return {"query": q, "results": [{"fact": text, "score": score} for text, score in results]}


@router.get("/sessions")
async def list_sessions():
    """List all chat session IDs."""
    db = await get_db()
    sessions = await db.list_sessions()
    return {"sessions": sessions}


@router.get("/sessions/{session_id}/messages")
async def get_session_messages(session_id: str, limit: int = Query(50, ge=1, le=500)):
    """Return messages for a specific session."""
    db = await get_db()
    messages = await db.get_messages(session_id, limit=limit)
    return {"session_id": session_id, "messages": messages}


@router.get("/sessions/{session_id}/sentiment")
async def get_session_sentiment(session_id: str):
    """Return sentiment for a specific session."""
    db = await get_db()
    sentiment = await db.get_sentiment(session_id)
    return {"session_id": session_id, "sentiment": sentiment}


@router.get("/context")
async def get_restoration_context(q: str = Query("", min_length=0)):
    """Get cross-chat context restoration data for a new chat."""
    restorer = await get_restorer()
    rolling = await restorer.get_rolling_context(limit=5)
    relevant = restorer.search_relevant(q, top_k=5) if q else []
    return {
        "rolling_context": rolling,
        "relevant_facts": [{"fact": text, "score": score} for text, score in relevant],
    }


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    """Delete a session and its messages."""
    db = await get_db()
    await db.delete_session(session_id)
    return {"status": "deleted", "session_id": session_id}
