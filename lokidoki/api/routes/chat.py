from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, field_validator

from lokidoki.core.inference import InferenceClient
from lokidoki.core.decomposer import Decomposer
from lokidoki.core.memory import SessionMemory
from lokidoki.core.orchestrator import Orchestrator
from lokidoki.core.registry import SkillRegistry
from lokidoki.core.skill_executor import SkillExecutor
from lokidoki.core.model_manager import ModelManager, ModelPolicy
from lokidoki.core.platform import detect_platform

router = APIRouter()

# Module-level singletons (shared across requests in this process)
_session_memory = SessionMemory()
_registry = SkillRegistry(skills_dir="lokidoki/skills")
_registry.scan()
_model_policy = ModelPolicy()


def get_inference_client() -> InferenceClient:
    """Factory for the inference client. Patched in tests."""
    return InferenceClient()


class ChatRequest(BaseModel):
    message: str

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be empty")
        return v


@router.post("")
async def chat(request: ChatRequest):
    """Process a chat message through the agentic pipeline, streaming SSE events."""
    client = get_inference_client()
    model_manager = ModelManager(inference_client=client, policy=_model_policy)
    decomposer = Decomposer(
        inference_client=client,
        model=_model_policy.fast_model,
    )
    orchestrator = Orchestrator(
        decomposer=decomposer,
        inference_client=client,
        memory=_session_memory,
        model_manager=model_manager,
        registry=_registry,
        skill_executor=SkillExecutor(),
    )

    async def event_stream():
        try:
            async for event in orchestrator.process(
                request.message,
                available_intents=_registry.get_all_intents(),
            ):
                yield event.to_sse()
        finally:
            await client.close()

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/memory")
async def get_memory():
    """Return current session memory state."""
    return {
        "messages": _session_memory.messages,
        "sentiment": _session_memory.sentiment,
        "facts": _session_memory.facts,
    }


@router.get("/skills")
async def get_skills():
    """Return registered skills and their intents."""
    return {
        "skills": list(_registry.skills.keys()),
        "intents": _registry.get_all_intents(),
    }


@router.get("/platform")
async def get_platform():
    """Return detected platform and active model policy."""
    return {
        "platform": _model_policy.platform,
        "fast_model": _model_policy.fast_model,
        "thinking_model": _model_policy.thinking_model,
    }


@router.delete("/memory")
async def clear_memory():
    """Clear session memory (messages + sentiment, keeps facts)."""
    _session_memory.clear_session()
    return {"status": "cleared"}
