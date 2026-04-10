"""Structured People graph routes."""
from __future__ import annotations

import mimetypes
import os
import re
from collections import defaultdict
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

from lokidoki.auth.dependencies import current_user, get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.core import people_graph_sql as gql
from lokidoki.core.person_pronunciation import (
    VALID_NAME_PARTS,
    delete_person_pronunciation,
    list_person_pronunciations,
    set_person_pronunciation,
)

router = APIRouter()

MEDIA_ROOT = "data/media"


def _display_person_name(name: Optional[str]) -> str:
    cleaned = (name or "").strip()
    if not cleaned:
        return "Unnamed person"
    if re.fullmatch(r"@[^@]+@", cleaned):
        return "Unnamed person"
    return cleaned


def _media_url(path: Optional[str]) -> Optional[str]:
    if not path:
        return None
    return f"/media/{path}"


def _decorate_person(row: dict) -> dict:
    out = dict(row)
    out["name"] = _display_person_name(out.get("name"))
    out["preferred_photo_url"] = _media_url(out.get("preferred_photo_path"))
    return out


def _decorate_media(row: dict) -> dict:
    out = dict(row)
    out["file_url"] = _media_url(out.get("file_path"))
    out["thumbnail_url"] = _media_url(out.get("thumbnail_path"))
    out["medium_url"] = _media_url(out.get("medium_path"))
    return out


def _parse_gedcom(text: str) -> dict:
    people: dict[str, dict] = {}
    families: dict[str, dict] = {}
    current: dict | None = None
    current_type = ""
    current_event: Optional[str] = None
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m = re.match(r"(\d+)\s+(@[^@]+@)?\s*([A-Z0-9_]+)?\s*(.*)", line)
        if not m:
            continue
        level = int(m.group(1))
        xref = m.group(2)
        tag = (m.group(3) or "").strip()
        value = m.group(4).strip()
        if level == 0:
            current_event = None
            record_type = value or tag
            if record_type == "INDI" and xref:
                current = people.setdefault(xref, {"id": xref})
                current_type = "INDI"
            elif record_type == "FAM" and xref:
                current = families.setdefault(
                    xref,
                    {"id": xref, "children": []},
                )
                current_type = "FAM"
            else:
                current = None
                current_type = ""
            continue
        if current is None:
            continue
        if level == 1 and tag in {"BIRT", "DEAT", "MARR"}:
            current_event = tag
            continue
        if current_type == "INDI":
            if level == 1 and tag == "NAME":
                current["name"] = value.replace("/", "").strip()
            elif level == 1 and tag == "SEX":
                current["sex"] = value
            elif level == 1 and tag in {"FAMC", "FAMS"}:
                current.setdefault(tag.lower(), []).append(value)
            elif level == 2 and tag == "DATE" and current_event:
                current[current_event.lower() + "_date"] = value
        elif current_type == "FAM":
            if level == 1 and tag in {"HUSB", "WIFE"}:
                current[tag.lower()] = value
            elif level == 1 and tag == "CHIL":
                current.setdefault("children", []).append(value)
            elif level == 2 and tag == "DATE" and current_event == "MARR":
                current["marriage_date"] = value
    return {"people": people, "families": families}


def _export_gedcom(conn, *, admin_user_id: int) -> str:
    people = conn.execute(
        "SELECT id, name, birth_date, death_date FROM people WHERE bucket = 'family' ORDER BY id"
    ).fetchall()
    edges = conn.execute(
        "SELECT from_person_id, to_person_id, edge_type FROM person_relationship_edges "
        "WHERE edge_type IN ('spouse', 'parent', 'child') ORDER BY id"
    ).fetchall()
    spouses: dict[tuple[int, int], list[int]] = defaultdict(list)
    families: dict[int, dict] = {}
    fam_index = 1
    for edge in edges:
        a = int(edge["from_person_id"])
        b = int(edge["to_person_id"])
        et = edge["edge_type"]
        if et == "spouse":
            key = tuple(sorted((a, b)))
            families.setdefault(hash(key), {"husb": key[0], "wife": key[1], "children": []})
        elif et == "child":
            spouses[(a, b)].append(b)
    lines: list[str] = ["0 HEAD", "1 SOUR LOKIDOKI", "1 GEDC", "2 VERS 5.5.1"]
    id_map = {int(p["id"]): f"@I{idx}@" for idx, p in enumerate(people, start=1)}
    for pid, xref in id_map.items():
        person = next(p for p in people if int(p["id"]) == pid)
        lines.append(f"0 {xref} INDI")
        lines.append(f"1 NAME {person['name']}")
        if person["birth_date"]:
            lines.append("1 BIRT")
            lines.append(f"2 DATE {person['birth_date']}")
        if person["death_date"]:
            lines.append("1 DEAT")
            lines.append(f"2 DATE {person['death_date']}")
    fam_id = 1
    spouse_seen: set[tuple[int, int]] = set()
    for edge in edges:
        from_id = int(edge["from_person_id"])
        to_id = int(edge["to_person_id"])
        et = edge["edge_type"]
        if et != "spouse":
            continue
        key = tuple(sorted((from_id, to_id)))
        if key in spouse_seen:
            continue
        spouse_seen.add(key)
        lines.append(f"0 @F{fam_id}@ FAM")
        lines.append(f"1 HUSB {id_map.get(key[0], f'@I{key[0]}@')}")
        lines.append(f"1 WIFE {id_map.get(key[1], f'@I{key[1]}@')}")
        children = conn.execute(
            "SELECT to_person_id FROM person_relationship_edges "
            "WHERE from_person_id IN (?, ?) AND edge_type = 'parent'",
            (key[0], key[1]),
        ).fetchall()
        for child in children:
            child_id = int(child["to_person_id"])
            if child_id in id_map:
                lines.append(f"1 CHIL {id_map[child_id]}")
        fam_id += 1
    lines.append("0 TRLR")
    gql.record_gedcom_export_job(
        conn,
        admin_user_id=admin_user_id,
        summary={"people": len(people), "families": max(fam_id - 1, 0)},
    )
    return "\n".join(lines) + "\n"


def _require_person_access(conn, person_id: int, user: User) -> dict:
    row = conn.execute(
        "SELECT id, owner_user_id FROM people WHERE id = ?",
        (person_id,),
    ).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="person_not_found")
    if not user.is_admin and int(row["owner_user_id"]) != user.id:
        overlay = conn.execute(
            "SELECT visibility_level FROM person_overlays WHERE viewer_user_id = ? AND person_id = ?",
            (user.id, person_id),
        ).fetchone()
        if not overlay or overlay["visibility_level"] == "hidden":
            raise HTTPException(status_code=403, detail="person_forbidden")
    return dict(row)


class CreatePersonBody(BaseModel):
    name: str
    bucket: str = "family"
    living_status: str = "unknown"
    birth_date: Optional[str] = None
    death_date: Optional[str] = None
    aliases: list[str] = Field(default_factory=list)


class PatchPersonBody(BaseModel):
    name: Optional[str] = None
    bucket: Optional[str] = None
    living_status: Optional[str] = None
    birth_date: Optional[str] = None
    death_date: Optional[str] = None
    aliases: Optional[list[str]] = None


class OverlayBody(BaseModel):
    relationship_state: Optional[str] = None
    interaction_preference: Optional[str] = None
    visibility_level: Optional[str] = None


class EdgeBody(BaseModel):
    from_person_id: int
    to_person_id: int
    edge_type: str


class EventBody(BaseModel):
    event_type: str
    event_date: Optional[str] = None
    date_precision: str = "exact"
    label: str = ""
    value: str = ""


class LinkUserBody(BaseModel):
    user_id: int


class ProfilePhotoBody(BaseModel):
    media_id: int


class MergePeopleBody(BaseModel):
    source_id: int
    into_id: int


@router.get("")
async def list_people_graph(
    q: str = Query("", alias="search"),
    bucket: str = Query("all"),
    relationship_state: str = Query("all"),
    interaction_preference: str = Query("all"),
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        payload = gql.list_people_graph(
            conn,
            user.id,
            is_admin=user.is_admin,
            search=q,
            bucket=bucket,
            relationship_state=relationship_state,
            interaction_preference=interaction_preference,
        )
        return {
            "people": [_decorate_person(p) for p in payload["people"]],
            "edges": payload["edges"],
        }
    return await memory.run_sync(_go)


@router.post("")
async def create_person_graph(
    body: CreatePersonBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="name_required")
    def _go(conn):
        person_id = gql.create_person_graph(
            conn,
            user.id,
            name=body.name.strip(),
            bucket=body.bucket,
            living_status=body.living_status,
            birth_date=body.birth_date,
            death_date=body.death_date,
            aliases=body.aliases,
        )
        if body.birth_date:
            gql.create_person_event(
                conn,
                person_id=person_id,
                event_type="birthday",
                event_date=body.birth_date,
                source="manual",
            )
        return {"id": person_id}
    return await memory.run_sync(_go)


@router.get("/profile-photo-options")
async def profile_photo_options(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        return {
            "options": [
                _decorate_media(dict(row))
                for row in gql.list_profile_photo_options(conn, user_id=user.id)
            ]
        }
    return await memory.run_sync(_go)


@router.put("/profile-photo")
async def select_profile_photo(
    body: ProfilePhotoBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        options = {
            int(row["id"])
            for row in gql.list_profile_photo_options(conn, user_id=user.id)
        }
        if body.media_id not in options:
            raise HTTPException(status_code=403, detail="profile_media_forbidden")
        gql.set_user_profile_media(conn, user_id=user.id, media_id=body.media_id)
        return {"ok": True}
    return await memory.run_sync(_go)


@router.get("/{person_id:int}")
async def get_person_detail(
    person_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        _require_person_access(conn, person_id, user)
        payload = gql.get_person_detail(
            conn, user.id, person_id, is_admin=user.is_admin,
        )
        if payload is None:
            raise HTTPException(status_code=404, detail="person_not_found")
        payload["person"] = _decorate_person(payload["person"])
        payload["media"] = [_decorate_media(m) for m in payload["media"]]
        return payload
    return await memory.run_sync(_go)


@router.patch("/{person_id:int}")
async def patch_person_graph(
    person_id: int,
    body: PatchPersonBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        owner = _require_person_access(conn, person_id, user)
        if not user.is_admin and int(owner["owner_user_id"]) != user.id:
            raise HTTPException(status_code=403, detail="person_forbidden")
        ok = gql.patch_person_graph(conn, person_id, **body.model_dump())
        return {"ok": ok}
    return await memory.run_sync(_go)


@router.patch("/{person_id:int}/overlay")
async def patch_person_overlay(
    person_id: int,
    body: OverlayBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        _require_person_access(conn, person_id, user)
        ok = gql.set_person_overlay(conn, user.id, person_id, **body.model_dump())
        return {"ok": ok}
    return await memory.run_sync(_go)


@router.post("/edges")
async def create_person_edge(
    body: EdgeBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        _require_person_access(conn, body.from_person_id, user)
        _require_person_access(conn, body.to_person_id, user)
        edge_id = gql.create_person_edge(
            conn,
            user.id,
            from_person_id=body.from_person_id,
            to_person_id=body.to_person_id,
            edge_type=body.edge_type,
        )
        return {"id": edge_id}
    return await memory.run_sync(_go)


@router.post("/{person_id:int}/events")
async def create_person_event(
    person_id: int,
    body: EventBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        owner = _require_person_access(conn, person_id, user)
        if not user.is_admin and int(owner["owner_user_id"]) != user.id:
            raise HTTPException(status_code=403, detail="person_forbidden")
        event_id = gql.create_person_event(conn, person_id=person_id, **body.model_dump())
        return {"id": event_id}
    return await memory.run_sync(_go)


@router.post("/{person_id:int}/media")
async def upload_person_media(
    person_id: int,
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="empty_file")
    checksum = gql.sha1_bytes(content)
    ext = os.path.splitext(file.filename or "")[1] or mimetypes.guess_extension(
        file.content_type or "image/jpeg"
    ) or ".bin"
    rel_dir = os.path.join("people", str(person_id))
    os.makedirs(os.path.join(MEDIA_ROOT, rel_dir), exist_ok=True)
    rel_path = os.path.join(rel_dir, f"{checksum}{ext}")
    full_path = os.path.join(MEDIA_ROOT, rel_path)
    if not os.path.exists(full_path):
        with open(full_path, "wb") as handle:
            handle.write(content)

    def _go(conn):
        owner = _require_person_access(conn, person_id, user)
        if not user.is_admin and int(owner["owner_user_id"]) != user.id:
            raise HTTPException(status_code=403, detail="person_forbidden")
        media_id = gql.create_person_media_row(
            conn,
            person_id=person_id,
            file_path=rel_path,
            thumbnail_path=rel_path,
            medium_path=rel_path,
            original_filename=file.filename or os.path.basename(rel_path),
            mime_type=file.content_type or "application/octet-stream",
            checksum=checksum,
        )
        gql.set_preferred_person_media(conn, person_id=person_id, media_id=media_id)
        return {"id": media_id, "file_url": _media_url(rel_path)}
    return await memory.run_sync(_go)


@router.post("/{person_id:int}/media/{media_id:int}/preferred")
async def set_preferred_media(
    person_id: int,
    media_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        owner = _require_person_access(conn, person_id, user)
        if not user.is_admin and int(owner["owner_user_id"]) != user.id:
            raise HTTPException(status_code=403, detail="person_forbidden")
        return {"ok": gql.set_preferred_person_media(conn, person_id=person_id, media_id=media_id)}
    return await memory.run_sync(_go)


@router.post("/admin/people/{person_id}/link-user")
async def link_user_to_person(
    person_id: int,
    body: LinkUserBody,
    _: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        person = conn.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone()
        if not person:
            raise HTTPException(status_code=404, detail="person_not_found")
        target = conn.execute("SELECT id FROM users WHERE id = ?", (body.user_id,)).fetchone()
        if not target:
            raise HTTPException(status_code=404, detail="user_not_found")
        gql.link_user_to_person(conn, user_id=body.user_id, person_id=person_id)
        return {"ok": True}
    return await memory.run_sync(_go)


@router.get("/reconcile-candidates")
async def reconcile_candidates(
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        groups = gql.list_reconcile_candidates(
            conn, viewer_user_id=user.id, is_admin=user.is_admin
        )
        for group in groups:
            group["candidates"] = [_decorate_person(candidate) for candidate in group["candidates"]]
        return {"groups": groups}
    return await memory.run_sync(_go)


@router.post("/reconcile/merge")
async def reconcile_merge(
    body: MergePeopleBody,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    def _go(conn):
        _require_person_access(conn, body.source_id, user)
        _require_person_access(conn, body.into_id, user)
        ok = gql.merge_graph_people(conn, source_id=body.source_id, into_id=body.into_id)
        if not ok:
            raise HTTPException(status_code=404, detail="person_not_found")
        return {"ok": True}
    return await memory.run_sync(_go)


@router.post("/admin/import-gedcom")
async def import_gedcom(
    file: UploadFile = File(...),
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    content = await file.read()
    if not content:
        raise HTTPException(status_code=400, detail="empty_file")
    parsed = _parse_gedcom(content.decode("utf-8", errors="ignore"))

    def _go(conn):
        id_map: dict[str, int] = {}
        for person in parsed["people"].values():
            pid = gql.create_person_graph(
                conn,
                admin.id,
                name=_display_person_name(person.get("name") or person["id"]),
                bucket="family",
                living_status="deceased" if person.get("deat_date") else "unknown",
                birth_date=person.get("birt_date"),
                death_date=person.get("deat_date"),
            )
            id_map[person["id"]] = pid
            if person.get("birt_date"):
                gql.create_person_event(
                    conn,
                    person_id=pid,
                    event_type="birthday",
                    event_date=person.get("birt_date"),
                    source="gedcom",
                )
        edge_count = 0
        for family in parsed["families"].values():
            husb = id_map.get(family.get("husb", ""))
            wife = id_map.get(family.get("wife", ""))
            if husb and wife:
                gql.create_person_edge(
                    conn,
                    admin.id,
                    from_person_id=husb,
                    to_person_id=wife,
                    edge_type="spouse",
                    provenance="gedcom",
                )
                gql.create_person_edge(
                    conn,
                    admin.id,
                    from_person_id=wife,
                    to_person_id=husb,
                    edge_type="spouse",
                    provenance="gedcom",
                )
                edge_count += 2
            for child in family.get("children", []):
                child_id = id_map.get(child)
                if not child_id:
                    continue
                for parent_id in (husb, wife):
                    if parent_id:
                        gql.create_person_edge(
                            conn,
                            admin.id,
                            from_person_id=parent_id,
                            to_person_id=child_id,
                            edge_type="parent",
                            provenance="gedcom",
                        )
                        gql.create_person_edge(
                            conn,
                            admin.id,
                            from_person_id=child_id,
                            to_person_id=parent_id,
                            edge_type="child",
                            provenance="gedcom",
                        )
                        edge_count += 2
        summary = {
            "people_imported": len(id_map),
            "families_imported": len(parsed["families"]),
            "edges_imported": edge_count,
        }
        job_id = gql.record_gedcom_import_job(
            conn,
            admin_user_id=admin.id,
            filename=file.filename or "import.ged",
            summary=summary,
        )
        return {"job_id": job_id, "summary": summary}
    return await memory.run_sync(_go)


@router.get("/admin/export-gedcom")
async def export_gedcom(
    admin: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    text = await memory.run_sync(lambda conn: _export_gedcom(conn, admin_user_id=admin.id))
    return PlainTextResponse(
        text,
        headers={"Content-Disposition": 'attachment; filename="lokidoki-family.ged"'},
    )


# ---- Per-person pronunciation overrides -----------------------------------


class PersonPronunciationBody(BaseModel):
    name_part: str = Field(description="first | middle | last | suffix | nickname | full")
    written: str = Field(description="The name as written (e.g. 'Nguyen')")
    spoken: str = Field(description="How TTS should say it (e.g. 'win')")


@router.get("/{person_id:int}/pronunciation")
async def get_person_pronunciation(
    person_id: int,
    user: User = Depends(current_user),
    memory: MemoryProvider = Depends(get_memory),
):
    """List pronunciation overrides for a person."""
    def _go(conn):
        _require_person_access(conn, person_id, user)
        return list_person_pronunciations(conn, person_id)
    fixes = await memory.run_sync(_go)
    return {"pronunciation": fixes}


@router.put("/{person_id:int}/pronunciation")
async def upsert_person_pronunciation(
    person_id: int,
    body: PersonPronunciationBody,
    user: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Create or update a pronunciation override for a person's name part."""
    part = body.name_part.strip().lower()
    if part not in VALID_NAME_PARTS:
        raise HTTPException(
            status_code=400,
            detail=f"name_part must be one of: {', '.join(VALID_NAME_PARTS)}",
        )
    written = body.written.strip()
    spoken = body.spoken.strip()
    if not written or not spoken:
        raise HTTPException(status_code=400, detail="written and spoken must not be empty")

    def _go(conn):
        _require_person_access(conn, person_id, user)
        return set_person_pronunciation(conn, person_id, part, written, spoken)
    row_id = await memory.run_sync(_go)
    return {"status": "saved", "id": row_id, "person_id": person_id, "name_part": part}


@router.delete("/{person_id:int}/pronunciation/{name_part}")
async def remove_person_pronunciation(
    person_id: int,
    name_part: str,
    user: User = Depends(require_admin),
    memory: MemoryProvider = Depends(get_memory),
):
    """Delete a pronunciation override for a person's name part."""
    def _go(conn):
        _require_person_access(conn, person_id, user)
        return delete_person_pronunciation(conn, person_id, name_part)
    deleted = await memory.run_sync(_go)
    if not deleted:
        raise HTTPException(status_code=404, detail="pronunciation override not found")
    return {"status": "deleted", "person_id": person_id, "name_part": name_part}
