from pydantic import BaseModel
from typing import Optional
from datetime import datetime


class ProjectBase(BaseModel):
    name: str
    description: Optional[str] = ""
    instructions: Optional[str] = ""
    icon: Optional[str] = "Folder"
    icon_color: Optional[str] = "#3b82f6"


class ProjectCreate(ProjectBase):
    pass


class ProjectUpdate(ProjectBase):
    name: Optional[str] = None


class ProjectResponse(ProjectBase):
    id: str
    created_at: datetime

    class Config:
        from_attributes = True
        json_schema_extra = {
            "example": {
                "id": "proj_12345",
                "name": "Novel Writing",
                "description": "Drafting chapter 1",
                "instructions": "Always respond in a descriptive, literary tone.",
                "icon": "Book",
                "icon_color": "#8b5cf6",
                "created_at": "2026-05-12T12:00:00Z",
            }
        }
