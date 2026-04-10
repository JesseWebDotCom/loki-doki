"""Phase 7: A/B experiment framework.

Deterministic experiment-arm assignment and experiment registry.
Each experiment defines a set of arms with weights. Users are
assigned once per experiment (persisted in experiment_assignments)
and stay on the same arm for comparability.

The framework is intentionally minimal: no external dependencies,
no dynamic experiment creation — experiments are registered in
code so every arm is testable and reviewable.
"""
from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ExperimentArm:
    name: str
    weight: float = 1.0


@dataclass(frozen=True)
class Experiment:
    experiment_id: str
    description: str
    arms: tuple[ExperimentArm, ...]
    default_arm: str = "control"


# ---- experiment registry --------------------------------------------
# All experiments are defined here. Adding a new experiment is a
# code change — reviewed, tested, and versioned.

MEMORY_FORMAT_EXPERIMENT = Experiment(
    experiment_id="memory_format_v1",
    description="Compare current bucket-header memory formatting against a warmer narrative variant",
    arms=(
        ExperimentArm("control", weight=1.0),
        ExperimentArm("warm", weight=1.0),
    ),
    default_arm="control",
)

RERANKER_EXPERIMENT = Experiment(
    experiment_id="reranker_v1",
    description="Compare baseline RRF retrieval against bge-reranker-base second-pass reranking",
    arms=(
        ExperimentArm("control", weight=1.0),
        ExperimentArm("reranker", weight=1.0),
    ),
    default_arm="control",
)

_REGISTRY: dict[str, Experiment] = {
    MEMORY_FORMAT_EXPERIMENT.experiment_id: MEMORY_FORMAT_EXPERIMENT,
    RERANKER_EXPERIMENT.experiment_id: RERANKER_EXPERIMENT,
}


def get_experiment(experiment_id: str) -> Optional[Experiment]:
    return _REGISTRY.get(experiment_id)


def list_experiments() -> list[Experiment]:
    return list(_REGISTRY.values())


def assign_arm(experiment: Experiment, user_id: int) -> str:
    """Deterministically assign a user to an experiment arm.

    Uses a hash of (experiment_id, user_id) so the assignment is
    stable across restarts and doesn't require DB state for the
    initial pick. The DB persists the assignment so it can be
    overridden or queried later.
    """
    key = f"{experiment.experiment_id}:{user_id}"
    h = int(hashlib.sha256(key.encode()).hexdigest(), 16)
    total_weight = sum(a.weight for a in experiment.arms)
    if total_weight <= 0:
        return experiment.default_arm
    target = (h % 10000) / 10000.0 * total_weight
    cumulative = 0.0
    for arm in experiment.arms:
        cumulative += arm.weight
        if target < cumulative:
            return arm.name
    return experiment.arms[-1].name


async def get_or_assign_arm(
    memory,
    *,
    user_id: int,
    experiment_id: str,
) -> str:
    """Get persisted arm or assign and persist a new one.

    ``memory`` is a MemoryProvider instance. The assignment is
    deterministic (hash-based) but persisted so manual overrides
    stick.
    """
    experiment = get_experiment(experiment_id)
    if experiment is None:
        return "control"

    existing = await memory.get_experiment_arm(user_id, experiment_id)
    if existing is not None:
        return existing

    arm = assign_arm(experiment, user_id)
    await memory.set_experiment_arm(user_id, experiment_id, arm)
    logger.info(
        "[experiment] assigned user %d to %s:%s",
        user_id, experiment_id, arm,
    )
    return arm
