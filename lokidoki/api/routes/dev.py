"""Developer-only prototype endpoints."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, field_validator

from lokidoki.auth.dependencies import require_admin
from lokidoki.auth.users import User
from v2.bmo_nlu.core.pipeline import run_pipeline

router = APIRouter()


class V2RunRequest(BaseModel):
    message: str

    @field_validator("message")
    @classmethod
    def message_not_empty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("message must not be empty")
        return value


@router.post("/v2/run")
async def run_v2_pipeline(
    request: V2RunRequest,
    _: User = Depends(require_admin),
):
    """Run the isolated v2 prototype pipeline."""
    return run_pipeline(request.message).to_dict()
