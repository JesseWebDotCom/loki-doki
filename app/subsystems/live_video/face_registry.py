"""Flat-file registry storage for recognized people."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from app.config import FACE_REGISTRY_PATH


@dataclass(frozen=True)
class RegisteredFace:
    """One registered person identity vector."""

    name: str
    vector: tuple[float, ...]
    sample_count: int = 0
    modes: tuple[str, ...] = ()

    def to_dict(self) -> dict[str, object]:
        """Return a JSON-safe registry payload."""
        payload: dict[str, object] = {
            "name": self.name,
            "vector": [round(value, 8) for value in self.vector],
        }
        if self.sample_count > 0:
            payload["sample_count"] = self.sample_count
        if self.modes:
            payload["modes"] = list(self.modes)
        return payload


def load_registered_faces(path: Path = FACE_REGISTRY_PATH) -> tuple[RegisteredFace, ...]:
    """Load all registered people from disk."""
    if not path.exists():
        return ()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return ()
    if not isinstance(payload, list):
        return ()
    faces: list[RegisteredFace] = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        vector = item.get("vector")
        if not name or not isinstance(vector, list):
            continue
        try:
            normalized = tuple(float(value) for value in vector)
        except (TypeError, ValueError):
            continue
        if normalized:
            sample_count = int(item.get("sample_count") or 0)
            modes = item.get("modes")
            normalized_modes = tuple(
                str(mode).strip()
                for mode in modes
                if isinstance(mode, str) and str(mode).strip()
            ) if isinstance(modes, list) else ()
            faces.append(
                RegisteredFace(
                    name=name,
                    vector=normalized,
                    sample_count=max(sample_count, 0),
                    modes=tuple(dict.fromkeys(normalized_modes)),
                )
            )
    return tuple(faces)


def save_registered_faces(faces: tuple[RegisteredFace, ...], path: Path = FACE_REGISTRY_PATH) -> None:
    """Persist registered people to disk."""
    path.parent.mkdir(parents=True, exist_ok=True)
    ordered = sorted(faces, key=lambda item: item.name.lower())
    path.write_text(json.dumps([face.to_dict() for face in ordered], indent=2), encoding="utf-8")


def upsert_registered_face(face: RegisteredFace, path: Path = FACE_REGISTRY_PATH) -> tuple[RegisteredFace, ...]:
    """Insert or replace one registered person."""
    faces = [item for item in load_registered_faces(path) if item.name.lower() != face.name.lower()]
    faces.append(face)
    saved = tuple(faces)
    save_registered_faces(saved, path)
    return tuple(sorted(saved, key=lambda item: item.name.lower()))


def remove_registered_face(name: str, path: Path = FACE_REGISTRY_PATH) -> bool:
    """Delete one registered person by name."""
    existing = load_registered_faces(path)
    kept = tuple(face for face in existing if face.name.lower() != name.strip().lower())
    if len(kept) == len(existing):
        return False
    save_registered_faces(kept, path)
    return True
