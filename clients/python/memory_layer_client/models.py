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
    collaboration_id: Optional[str] = None

    def to_dict(self) -> dict[str, str]:
        data = {
            "tenant_id": self.tenant_id,
            "system_id": self.system_id,
            "scope_id": self.scope_id,
        }
        if self.workspace_id:
            data["workspace_id"] = self.workspace_id
        if self.collaboration_id:
            data["collaboration_id"] = self.collaboration_id
        return data

    def to_headers(self) -> dict[str, str]:
        headers = {
            "x-memory-tenant": self.tenant_id,
            "x-memory-system": self.system_id,
            "x-memory-scope": self.scope_id,
        }
        if self.workspace_id:
            headers["x-memory-workspace"] = self.workspace_id
        if self.collaboration_id:
            headers["x-memory-collaboration"] = self.collaboration_id
        return headers


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
class MemoryEvent:
    type: str
    scope: dict[str, Any]
    timestamp: int
    duration_ms: int
    meta: dict[str, Any]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "MemoryEvent":
        return cls(
            type=str(payload["type"]),
            scope=dict(payload.get("scope", {})),
            timestamp=int(payload["timestamp"]),
            duration_ms=int(payload.get("durationMs", 0)),
            meta=dict(payload.get("meta", {})),
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
class KnowledgeListResponse:
    items: list[dict[str, Any]]
    has_more: bool
    next_cursor: Optional[int]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "KnowledgeListResponse":
        next_cursor = payload.get("nextCursor")
        return cls(
            items=list(payload.get("items", [])),
            has_more=bool(payload.get("hasMore")),
            next_cursor=int(next_cursor) if next_cursor is not None else None,
        )


@dataclass(slots=True)
class KnowledgeInspectionResponse:
    knowledge: Optional[dict[str, Any]]
    evidence: list[dict[str, Any]]
    audits: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "KnowledgeInspectionResponse":
        knowledge = payload.get("knowledge")
        return cls(
          knowledge=dict(knowledge) if isinstance(knowledge, dict) else None,
          evidence=list(payload.get("evidence", [])),
          audits=list(payload.get("audits", [])),
        )


@dataclass(slots=True)
class AuditListResponse:
    audits: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "AuditListResponse":
        return cls(audits=list(payload.get("audits", [])))


@dataclass(slots=True)
class MonitorResponse:
    monitor: Optional[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "MonitorResponse":
        monitor = payload.get("monitor")
        return cls(monitor=dict(monitor) if isinstance(monitor, dict) else None)


@dataclass(slots=True)
class CompactionLogListResponse:
    logs: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CompactionLogListResponse":
        return cls(logs=list(payload.get("logs", [])))


@dataclass(slots=True)
class ChangeListResponse:
    changes: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ChangeListResponse":
        return cls(changes=list(payload.get("changes", [])))


@dataclass(slots=True)
class DueReverificationResponse:
    due: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "DueReverificationResponse":
        return cls(due=list(payload.get("due", [])))


@dataclass(slots=True)
class ReverificationResponse:
    reverified_knowledge_ids: list[int]
    demoted_knowledge_ids: list[int]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ReverificationResponse":
        return cls(
            reverified_knowledge_ids=[int(item) for item in payload.get("reverifiedKnowledgeIds", [])],
            demoted_knowledge_ids=[int(item) for item in payload.get("demotedKnowledgeIds", [])],
        )


@dataclass(slots=True)
class TrustAssessmentResponse:
    trust_score: float
    state: str
    decision: str
    reasons: list[str]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TrustAssessmentResponse":
        return cls(
            trust_score=float(payload["trust_score"]),
            state=str(payload["state"]),
            decision=str(payload["decision"]),
            reasons=[str(item) for item in payload.get("reasons", [])],
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


@dataclass(slots=True)
class PreparedMemoryTurn:
    user_input: str
    query: str
    prompt: str
    context: ContextResponse


@dataclass(slots=True)
class RuntimeTurnResult:
    prepared: PreparedMemoryTurn
    response_text: str
    exchange: StoredExchange
