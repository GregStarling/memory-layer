"""Typed data models for the memory-layer Python client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


@dataclass(slots=True)
class MemoryScope:
    tenant_id: str
    system_id: str
    scope_id: str
    workspace_id: Optional[str] = None

    def to_dict(self) -> dict[str, str]:
        data = {
            "tenant_id": self.tenant_id,
            "system_id": self.system_id,
            "scope_id": self.scope_id,
        }
        if self.workspace_id:
            data["workspace_id"] = self.workspace_id
        return data


@dataclass(slots=True)
class StoredTurn:
    turn_id: int
    role: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "StoredTurn":
        return cls(turn_id=int(payload["turnId"]), role=str(payload["role"]))


@dataclass(slots=True)
class StoredExchange:
    user_turn_id: int
    assistant_turn_id: int
    compacted: bool

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "StoredExchange":
        return cls(
            user_turn_id=int(payload["userTurnId"]),
            assistant_turn_id=int(payload["assistantTurnId"]),
            compacted=bool(payload["compacted"]),
        )


@dataclass(slots=True)
class ContextResponse:
    current_objective: Optional[str]
    active_turn_count: int
    working_memory: Optional[dict[str, Any]]
    relevant_knowledge: list[dict[str, Any]]
    active_objectives: list[dict[str, Any]]
    unresolved_work: list[dict[str, Any]]
    token_estimate: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ContextResponse":
        return cls(
            current_objective=payload.get("currentObjective"),
            active_turn_count=int(payload["activeTurnCount"]),
            working_memory=payload.get("workingMemory"),
            relevant_knowledge=list(payload.get("relevantKnowledge", [])),
            active_objectives=list(payload.get("activeObjectives", [])),
            unresolved_work=list(payload.get("unresolvedWork", [])),
            token_estimate=int(payload["tokenEstimate"]),
        )


@dataclass(slots=True)
class SearchResponse:
    turns: list[dict[str, Any]]
    knowledge: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SearchResponse":
        return cls(
            turns=list(payload.get("turns", [])),
            knowledge=list(payload.get("knowledge", [])),
        )


@dataclass(slots=True)
class CreatedResource:
    resource_id: int

    @classmethod
    def from_key(cls, payload: dict[str, Any], key: str) -> "CreatedResource":
        return cls(resource_id=int(payload[key]))


@dataclass(slots=True)
class HealthResponse:
    active_turn_count: int
    token_estimate: int
    knowledge_count: int
    objective_count: int
    unresolved_work_count: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "HealthResponse":
        return cls(
            active_turn_count=int(payload["activeTurnCount"]),
            token_estimate=int(payload["tokenEstimate"]),
            knowledge_count=int(payload["knowledgeCount"]),
            objective_count=int(payload["objectiveCount"]),
            unresolved_work_count=int(payload["unresolvedWorkCount"]),
        )


@dataclass(slots=True)
class MaintenanceResponse:
    expired_working_memory: int
    retired_knowledge: int
    deleted_work_items: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "MaintenanceResponse":
        return cls(
            expired_working_memory=int(payload["expiredWorkingMemory"]),
            retired_knowledge=int(payload["retiredKnowledge"]),
            deleted_work_items=int(payload["deletedWorkItems"]),
        )


@dataclass(slots=True)
class CompactResponse:
    compacted: bool
    archived_turn_count: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CompactResponse":
        return cls(
            compacted=bool(payload["compacted"]),
            archived_turn_count=int(payload["archivedTurnCount"]),
        )


@dataclass(slots=True)
class ReadyResponse:
    ok: bool
    scopes: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ReadyResponse":
        return cls(ok=bool(payload["ok"]), scopes=int(payload["scopes"]))
