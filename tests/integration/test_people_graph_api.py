from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from lokidoki.auth.dependencies import current_user, get_memory, require_admin
from lokidoki.auth.users import User
from lokidoki.core import memory_people_ops  # noqa: F401
from lokidoki.core import memory_singleton
from lokidoki.core import people_graph_sql as gql
from lokidoki.core.memory_provider import MemoryProvider
from lokidoki.main import app


@pytest.fixture(autouse=True)
async def _isolated_memory(tmp_path):
    mp = MemoryProvider(db_path=str(tmp_path / "people-graph.db"))
    await mp.initialize()
    uid = await mp.get_or_create_user("owner")
    memory_singleton.set_memory_provider(mp)

    fake = User(
        id=uid, username="owner", role="admin", status="active",
        last_password_auth_at=None,
    )

    async def _ovr_user():
        return fake

    async def _ovr_memory():
        return mp

    app.dependency_overrides[current_user] = _ovr_user
    app.dependency_overrides[require_admin] = _ovr_user
    app.dependency_overrides[get_memory] = _ovr_memory
    yield mp, uid
    app.dependency_overrides.clear()
    memory_singleton.set_memory_provider(None)
    await mp.close()


async def _client():
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.mark.anyio
async def test_people_graph_filters_overlay(_isolated_memory):
    mp, uid = _isolated_memory
    pid = await mp.run_sync(
        lambda conn: gql.create_person_graph(conn, uid, name="Mira", bucket="friends")
    )
    await mp.run_sync(
        lambda conn: gql.set_person_overlay(
            conn, uid, pid, relationship_state="former", interaction_preference="avoid"
        )
    )
    async with await _client() as ac:
        r = await ac.get(
            "/api/v1/people",
            params={"bucket": "friends", "relationship_state": "former", "interaction_preference": "avoid"},
        )
    assert r.status_code == 200
    people = r.json()["people"]
    assert len(people) == 1
    assert people[0]["name"] == "Mira"


@pytest.mark.anyio
async def test_upload_media_and_select_profile_photo(_isolated_memory):
    mp, uid = _isolated_memory
    def _seed(conn):
        pid = gql.create_person_graph(conn, uid, name="Owner Person", bucket="family")
        gql.link_user_to_person(conn, user_id=uid, person_id=pid)
        return pid
    person_id = await mp.run_sync(_seed)
    async with await _client() as ac:
        upload = await ac.post(
            f"/api/v1/people/{person_id}/media",
            files={"file": ("avatar.jpg", b"fake-image-bytes", "image/jpeg")},
        )
        assert upload.status_code == 200
        media_id = upload.json()["id"]
        opts = await ac.get("/api/v1/people/profile-photo-options")
        assert opts.status_code == 200
        assert len(opts.json()["options"]) == 1
        pick = await ac.put("/api/v1/people/profile-photo", json={"media_id": media_id})
        assert pick.status_code == 200

    def _signed_me(conn):
        return gql.get_user_profile(conn, uid)
    profile = await mp.run_sync(_signed_me)
    assert profile["profile_media_id"] == media_id


@pytest.mark.anyio
async def test_admin_can_import_and_export_gedcom(_isolated_memory):
    async with await _client() as ac:
        gedcom = "\n".join([
            "0 HEAD",
            "0 @I1@ INDI",
            "1 NAME John /Doe/",
            "1 BIRT",
            "2 DATE 1 JAN 1970",
            "0 @I2@ INDI",
            "1 NAME Jane /Doe/",
            "0 @F1@ FAM",
            "1 HUSB @I1@",
            "1 WIFE @I2@",
            "0 TRLR",
        ])
        imp = await ac.post(
            "/api/v1/people/admin/import-gedcom",
            files={"file": ("family.ged", gedcom.encode("utf-8"), "text/plain")},
        )
        assert imp.status_code == 200
        assert imp.json()["summary"]["people_imported"] == 2
        exp = await ac.get("/api/v1/people/admin/export-gedcom")
        assert exp.status_code == 200
        assert "John Doe" in exp.text
        assert "Jane Doe" in exp.text


@pytest.mark.anyio
async def test_gedcom_missing_name_is_exposed_as_unnamed_person(_isolated_memory):
    async with await _client() as ac:
        gedcom = "\n".join([
            "0 HEAD",
            "0 @I402404390909@ INDI",
            "1 BIRT",
            "2 DATE BEF 1951",
            "0 TRLR",
        ])
        imp = await ac.post(
            "/api/v1/people/admin/import-gedcom",
            files={"file": ("family.ged", gedcom.encode("utf-8"), "text/plain")},
        )
        assert imp.status_code == 200

        graph = await ac.get("/api/v1/people")
        assert graph.status_code == 200
        names = [person["name"] for person in graph.json()["people"]]
        assert "Unnamed person" in names
        assert "@I402404390909@" not in names


@pytest.mark.anyio
async def test_reconcile_candidates_and_merge_endpoint(_isolated_memory):
    mp, uid = _isolated_memory

    def _seed(conn):
        first = gql.create_person_graph(conn, uid, name="Luke", bucket="family")
        second = gql.create_person_graph(conn, uid, name="Luke", bucket="family")
        gql.set_person_overlay(conn, uid, second, relationship_state="former")
        return first, second

    first_id, second_id = await mp.run_sync(_seed)

    async with await _client() as ac:
        candidates = await ac.get("/api/v1/people/reconcile-candidates")
        assert candidates.status_code == 200
        groups = candidates.json()["groups"]
        artie_group = next(group for group in groups if group["label"] == "Luke")
        assert artie_group["suggested_target_id"] in {first_id, second_id}
        assert artie_group["suggestion_reason"]

        merged = await ac.post(
            "/api/v1/people/reconcile/merge",
            json={"source_id": second_id, "into_id": first_id},
        )
        assert merged.status_code == 200

        graph = await ac.get("/api/v1/people")
        assert graph.status_code == 200
        arties = [person for person in graph.json()["people"] if person["name"] == "Luke"]
        assert len(arties) == 1
