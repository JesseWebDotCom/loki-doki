"""Phase 7 unit tests: experiment framework logic.

Tests the deterministic arm assignment, experiment registry, and
the get_or_assign_arm async helper.
"""
from __future__ import annotations

import pytest

from lokidoki.core.experiment import (
    MEMORY_FORMAT_EXPERIMENT,
    RERANKER_EXPERIMENT,
    Experiment,
    ExperimentArm,
    assign_arm,
    get_experiment,
    get_or_assign_arm,
    list_experiments,
)


class TestAssignArm:
    def test_deterministic_for_same_user(self):
        arm1 = assign_arm(MEMORY_FORMAT_EXPERIMENT, 42)
        arm2 = assign_arm(MEMORY_FORMAT_EXPERIMENT, 42)
        assert arm1 == arm2

    def test_different_users_may_differ(self):
        """With enough users, both arms should appear."""
        arms = {assign_arm(MEMORY_FORMAT_EXPERIMENT, uid) for uid in range(100)}
        assert len(arms) == 2  # both "control" and "warm" assigned

    def test_all_arms_are_valid(self):
        valid = {a.name for a in MEMORY_FORMAT_EXPERIMENT.arms}
        for uid in range(50):
            assert assign_arm(MEMORY_FORMAT_EXPERIMENT, uid) in valid

    def test_reranker_experiment_arms(self):
        valid = {a.name for a in RERANKER_EXPERIMENT.arms}
        for uid in range(50):
            assert assign_arm(RERANKER_EXPERIMENT, uid) in valid

    def test_single_arm_experiment(self):
        exp = Experiment(
            experiment_id="test_single",
            description="test",
            arms=(ExperimentArm("only_arm"),),
        )
        assert assign_arm(exp, 1) == "only_arm"
        assert assign_arm(exp, 999) == "only_arm"

    def test_weighted_arms(self):
        exp = Experiment(
            experiment_id="test_weighted",
            description="test",
            arms=(
                ExperimentArm("rare", weight=0.1),
                ExperimentArm("common", weight=0.9),
            ),
        )
        counts = {"rare": 0, "common": 0}
        for uid in range(1000):
            counts[assign_arm(exp, uid)] += 1
        # With 90/10 split over 1000 users, common should dominate.
        assert counts["common"] > counts["rare"]


class TestExperimentRegistry:
    def test_list_experiments(self):
        exps = list_experiments()
        assert len(exps) >= 2
        ids = {e.experiment_id for e in exps}
        assert "memory_format_v1" in ids
        assert "reranker_v1" in ids

    def test_get_experiment_found(self):
        exp = get_experiment("memory_format_v1")
        assert exp is not None
        assert exp.experiment_id == "memory_format_v1"

    def test_get_experiment_missing(self):
        assert get_experiment("nonexistent") is None


class TestGetOrAssignArm:
    """Tests the async get_or_assign_arm with a mock memory provider."""

    @pytest.fixture
    def mock_memory(self):
        class MockMemory:
            def __init__(self):
                self._arms: dict[tuple[int, str], str] = {}

            async def get_experiment_arm(self, uid, exp_id):
                return self._arms.get((uid, exp_id))

            async def set_experiment_arm(self, uid, exp_id, arm):
                self._arms[(uid, exp_id)] = arm

        return MockMemory()

    @pytest.mark.anyio
    async def test_assigns_and_persists(self, mock_memory):
        arm = await get_or_assign_arm(
            mock_memory, user_id=1, experiment_id="memory_format_v1"
        )
        assert arm in ("control", "warm")
        # Second call returns the same (persisted) value.
        arm2 = await get_or_assign_arm(
            mock_memory, user_id=1, experiment_id="memory_format_v1"
        )
        assert arm2 == arm

    @pytest.mark.anyio
    async def test_unknown_experiment_returns_control(self, mock_memory):
        arm = await get_or_assign_arm(
            mock_memory, user_id=1, experiment_id="nonexistent_exp"
        )
        assert arm == "control"

    @pytest.mark.anyio
    async def test_persisted_override_sticks(self, mock_memory):
        # Pre-assign to "warm".
        await mock_memory.set_experiment_arm(1, "memory_format_v1", "warm")
        arm = await get_or_assign_arm(
            mock_memory, user_id=1, experiment_id="memory_format_v1"
        )
        assert arm == "warm"
