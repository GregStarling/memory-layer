"""Typed data models for the memory-layer Python client."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional


def _normalize_unresolved_work(payload: Any) -> list[str]:
    if not isinstance(payload, list):
        return []

    normalized: list[str] = []
    for item in payload:
        if isinstance(item, str):
            normalized.append(item)
            continue
        if isinstance(item, dict):
            title = item.get("title")
            if isinstance(title, str) and title:
                normalized.append(title)
    return normalized


def _parse_actor_ref(payload: Any) -> "ActorRef":
    if not isinstance(payload, dict):
        return ActorRef(
            actor_kind="agent",
            actor_id="unknown",
            system_id=None,
            display_name=None,
            metadata=None,
        )
    metadata = payload.get("metadata")
    return ActorRef(
        actor_kind=str(payload.get("actor_kind", "agent")),
        actor_id=str(payload.get("actor_id", "unknown")),
        system_id=payload.get("system_id") if isinstance(payload.get("system_id"), str) else None,
        display_name=payload.get("display_name") if isinstance(payload.get("display_name"), str) else None,
        metadata=dict(metadata) if isinstance(metadata, dict) else None,
    )


def _parse_temporal_id(value: Any) -> Optional[str]:
    if value is None:
        return None
    return str(value)


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
class ActorRef:
    actor_kind: str
    actor_id: str
    system_id: Optional[str]
    display_name: Optional[str]
    metadata: Optional[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ActorRef":
        return _parse_actor_ref(payload)


@dataclass(slots=True)
class WorkClaim:
    id: int
    work_item_id: int
    actor: ActorRef
    session_id: Optional[str]
    claim_token: str
    status: str
    claimed_at: int
    expires_at: int
    released_at: Optional[int]
    release_reason: Optional[str]
    source_event_id: Optional[str]
    visibility_class: str
    version: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "WorkClaim":
        return cls(
            id=int(payload["id"]),
            work_item_id=int(payload["work_item_id"]),
            actor=_parse_actor_ref(payload.get("actor")),
            session_id=payload.get("session_id"),
            claim_token=str(payload["claim_token"]),
            status=str(payload["status"]),
            claimed_at=int(payload["claimed_at"]),
            expires_at=int(payload["expires_at"]),
            released_at=int(payload["released_at"]) if payload.get("released_at") is not None else None,
            release_reason=payload.get("release_reason"),
            source_event_id=_parse_temporal_id(payload.get("source_event_id")),
            visibility_class=str(payload.get("visibility_class", "private")),
            version=int(payload.get("version", 1)),
        )


@dataclass(slots=True)
class HandoffRecord:
    id: int
    work_item_id: int
    from_actor: ActorRef
    to_actor: ActorRef
    session_id: Optional[str]
    summary: str
    context_bundle_ref: Optional[str]
    status: str
    created_at: int
    accepted_at: Optional[int]
    rejected_at: Optional[int]
    canceled_at: Optional[int]
    expires_at: Optional[int]
    decision_reason: Optional[str]
    source_event_id: Optional[str]
    visibility_class: str
    version: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "HandoffRecord":
        return cls(
            id=int(payload["id"]),
            work_item_id=int(payload["work_item_id"]),
            from_actor=_parse_actor_ref(payload.get("from_actor")),
            to_actor=_parse_actor_ref(payload.get("to_actor")),
            session_id=payload.get("session_id"),
            summary=str(payload["summary"]),
            context_bundle_ref=payload.get("context_bundle_ref"),
            status=str(payload["status"]),
            created_at=int(payload["created_at"]),
            accepted_at=int(payload["accepted_at"]) if payload.get("accepted_at") is not None else None,
            rejected_at=int(payload["rejected_at"]) if payload.get("rejected_at") is not None else None,
            canceled_at=int(payload["canceled_at"]) if payload.get("canceled_at") is not None else None,
            expires_at=int(payload["expires_at"]) if payload.get("expires_at") is not None else None,
            decision_reason=payload.get("decision_reason"),
            source_event_id=_parse_temporal_id(payload.get("source_event_id")),
            visibility_class=str(payload.get("visibility_class", "private")),
            version=int(payload.get("version", 1)),
        )


@dataclass(slots=True)
class CoordinationState:
    owned_claims: list[WorkClaim]
    pending_inbound_handoffs: list[HandoffRecord]
    pending_outbound_handoffs: list[HandoffRecord]
    shared_work_items: list[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CoordinationState":
        return cls(
            owned_claims=[WorkClaim.from_dict(item) for item in payload.get("ownedClaims", [])],
            pending_inbound_handoffs=[
                HandoffRecord.from_dict(item) for item in payload.get("pendingInboundHandoffs", [])
            ],
            pending_outbound_handoffs=[
                HandoffRecord.from_dict(item) for item in payload.get("pendingOutboundHandoffs", [])
            ],
            shared_work_items=list(payload.get("sharedWorkItems", [])),
        )


@dataclass(slots=True)
class MemoryEventRecord:
    event_id: str
    entity_kind: str
    entity_id: str
    event_type: str
    created_at: int
    payload: dict[str, Any]
    session_id: Optional[str]
    actor_id: Optional[str]
    actor_kind: Optional[str]
    actor_system_id: Optional[str]
    actor_display_name: Optional[str]
    actor_metadata: Optional[dict[str, Any]]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "MemoryEventRecord":
        actor_metadata = payload.get("actor_metadata")
        return cls(
            event_id=str(payload["event_id"]),
            entity_kind=str(payload["entity_kind"]),
            entity_id=str(payload["entity_id"]),
            event_type=str(payload["event_type"]),
            created_at=int(payload["created_at"]),
            payload=dict(payload.get("payload", {})),
            session_id=payload.get("session_id"),
            actor_id=payload.get("actor_id"),
            actor_kind=payload.get("actor_kind"),
            actor_system_id=payload.get("actor_system_id"),
            actor_display_name=payload.get("actor_display_name"),
            actor_metadata=dict(actor_metadata) if isinstance(actor_metadata, dict) else None,
        )


@dataclass(slots=True)
class ContextResponse:
    current_objective: Optional[str]
    session_state: Optional[dict[str, Any]]
    active_turn_count: int
    working_memory: Optional[dict[str, Any]]
    relevant_knowledge: list[dict[str, Any]]
    active_objectives: list[dict[str, Any]]
    unresolved_work: list[str]
    token_estimate: int
    debug_trace: Optional[dict[str, Any]] = None
    coordination_state: Optional[CoordinationState] = None

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ContextResponse":
        session_state = payload.get("sessionState")
        debug_trace = payload.get("debugTrace")
        coordination_state = payload.get("coordinationState")
        return cls(
            current_objective=payload.get("currentObjective"),
            session_state=dict(session_state) if isinstance(session_state, dict) else None,
            active_turn_count=int(payload["activeTurnCount"]),
            working_memory=payload.get("workingMemory"),
            relevant_knowledge=list(payload.get("relevantKnowledge", [])),
            active_objectives=list(payload.get("activeObjectives", [])),
            unresolved_work=_normalize_unresolved_work(payload.get("unresolvedWork")),
            token_estimate=int(payload["tokenEstimate"]),
            debug_trace=dict(debug_trace) if isinstance(debug_trace, dict) else None,
            coordination_state=
                CoordinationState.from_dict(coordination_state)
                if isinstance(coordination_state, dict)
                else None,
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
class TemporalEventLogResponse:
    events: list[MemoryEventRecord]
    next_cursor: Optional[str]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TemporalEventLogResponse":
        next_cursor = payload.get("nextCursor")
        return cls(
            events=[MemoryEventRecord.from_dict(item) for item in payload.get("events", [])],
            next_cursor=_parse_temporal_id(next_cursor),
        )


@dataclass(slots=True)
class TemporalStateResponse:
    as_of: int
    exact: bool
    cutover_at: Optional[int]
    watermark_event_id: Optional[str]
    context: ContextResponse
    session_state: Optional[dict[str, Any]]
    turns: list[dict[str, Any]]
    working_memory: list[dict[str, Any]]
    knowledge: list[dict[str, Any]]
    work_items: list[dict[str, Any]]
    associations: list[dict[str, Any]]
    playbooks: list[dict[str, Any]]
    work_claims: list[WorkClaim]
    handoffs: list[HandoffRecord]
    coordination_state: Optional[CoordinationState]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TemporalStateResponse":
        context_payload = payload.get("context")
        return cls(
            as_of=int(payload["asOf"]),
            exact=bool(payload["exact"]),
            cutover_at=int(payload["cutoverAt"]) if payload.get("cutoverAt") is not None else None,
            watermark_event_id=_parse_temporal_id(payload.get("watermarkEventId")),
            context=ContextResponse.from_dict(context_payload if isinstance(context_payload, dict) else {}),
            session_state=dict(payload.get("sessionState", {})) if isinstance(payload.get("sessionState"), dict) else None,
            turns=list(payload.get("turns", [])),
            working_memory=list(payload.get("workingMemory", [])),
            knowledge=list(payload.get("knowledge", [])),
            work_items=list(payload.get("workItems", [])),
            associations=list(payload.get("associations", [])),
            playbooks=list(payload.get("playbooks", [])),
            work_claims=[WorkClaim.from_dict(item) for item in payload.get("workClaims", [])],
            handoffs=[HandoffRecord.from_dict(item) for item in payload.get("handoffs", [])],
            coordination_state=
                CoordinationState.from_dict(payload["coordinationState"])
                if isinstance(payload.get("coordinationState"), dict)
                else None,
        )


@dataclass(slots=True)
class TemporalDiffResponse:
    from_timestamp: int
    to_timestamp: int
    exact: bool
    cutover_at: Optional[int]
    watermark_range: dict[str, Any]
    events: list[MemoryEventRecord]
    summary: dict[str, Any]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "TemporalDiffResponse":
        return cls(
            from_timestamp=int(payload["from"]),
            to_timestamp=int(payload["to"]),
            exact=bool(payload["exact"]),
            cutover_at=int(payload["cutoverAt"]) if payload.get("cutoverAt") is not None else None,
            watermark_range=dict(payload.get("watermarkRange", {})),
            events=[MemoryEventRecord.from_dict(item) for item in payload.get("events", [])],
            summary=dict(payload.get("summary", {})),
        )


@dataclass(slots=True)
class WorkClaimListResponse:
    claims: list[WorkClaim]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "WorkClaimListResponse":
        return cls(claims=[WorkClaim.from_dict(item) for item in payload.get("claims", [])])


@dataclass(slots=True)
class HandoffListResponse:
    handoffs: list[HandoffRecord]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "HandoffListResponse":
        return cls(handoffs=[HandoffRecord.from_dict(item) for item in payload.get("handoffs", [])])


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
class EpisodeSourceReference:
    type: str
    id: int
    excerpt: Optional[str]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "EpisodeSourceReference":
        return cls(
            type=str(payload["type"]),
            id=int(payload["id"]),
            excerpt=payload.get("excerpt"),
        )


@dataclass(slots=True)
class EpisodeRecap:
    objective: str
    actions: list[str]
    outcomes: list[str]
    artifacts: list[str]
    unresolved_items: list[str]
    source_type: str
    sources: list[EpisodeSourceReference]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "EpisodeRecap":
        return cls(
            objective=str(payload["objective"]),
            actions=[str(a) for a in payload.get("actions", [])],
            outcomes=[str(o) for o in payload.get("outcomes", [])],
            artifacts=[str(r) for r in payload.get("artifacts", [])],
            unresolved_items=[str(u) for u in payload.get("unresolvedItems", [])],
            source_type=str(payload["sourceType"]),
            sources=[EpisodeSourceReference.from_dict(s) for s in payload.get("sources", [])],
        )


@dataclass(slots=True)
class EpisodeSummary:
    session_id: str
    recap: EpisodeRecap
    detail_level: str
    turn_range: dict[str, int]
    created_at: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "EpisodeSummary":
        return cls(
            session_id=str(payload["sessionId"]),
            recap=EpisodeRecap.from_dict(payload["recap"]),
            detail_level=str(payload["detailLevel"]),
            turn_range=dict(payload.get("turnRange", {})),
            created_at=int(payload["createdAt"]),
        )


@dataclass(slots=True)
class ReflectResult:
    synthesis: str
    source_type: str
    sources: list[EpisodeSourceReference]
    episodes: list[EpisodeSummary]
    detail_level: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ReflectResult":
        return cls(
            synthesis=str(payload["synthesis"]),
            source_type=str(payload["sourceType"]),
            sources=[EpisodeSourceReference.from_dict(s) for s in payload.get("sources", [])],
            episodes=[EpisodeSummary.from_dict(e) for e in payload.get("episodes", [])],
            detail_level=str(payload["detailLevel"]),
        )


@dataclass(slots=True)
class CognitiveMemoryItem:
    id: int
    type: str
    fact: str
    created_at: int
    last_accessed_at: int
    metadata: dict[str, Any]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CognitiveMemoryItem":
        return cls(
            id=int(payload["id"]),
            type=str(payload["type"]),
            fact=str(payload["fact"]),
            created_at=int(payload["createdAt"]),
            last_accessed_at=int(payload["lastAccessedAt"]),
            metadata=dict(payload.get("metadata", {})),
        )


@dataclass(slots=True)
class CognitiveSearchHit:
    item: CognitiveMemoryItem
    rank: float

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CognitiveSearchHit":
        return cls(
            item=CognitiveMemoryItem.from_dict(payload["item"]),
            rank=payload["rank"],
        )


@dataclass(slots=True)
class CognitiveSearchResult:
    by_type: dict[str, list[CognitiveSearchHit]]
    all: list[CognitiveSearchHit]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "CognitiveSearchResult":
        by_type = {}
        for key, hits in payload.get("byType", {}).items():
            by_type[key] = [CognitiveSearchHit.from_dict(h) for h in hits]
        return cls(
            by_type=by_type,
            all=[CognitiveSearchHit.from_dict(h) for h in payload.get("all", [])],
        )


@dataclass(slots=True)
class EpisodeSearchResponse:
    episodes: list[EpisodeSummary]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "EpisodeSearchResponse":
        return cls(
            episodes=[EpisodeSummary.from_dict(e) for e in payload.get("episodes", [])],
        )


@dataclass(slots=True)
class ProfileEntry:
    knowledge_id: int
    fact: str
    trust_score: float
    knowledge_state: str
    confidence: str
    last_confirmed_at: Optional[int]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "ProfileEntry":
        return cls(
            knowledge_id=int(payload["knowledgeId"]),
            fact=str(payload["fact"]),
            trust_score=float(payload["trustScore"]),
            knowledge_state=str(payload["knowledgeState"]),
            confidence=str(payload["confidence"]),
            last_confirmed_at=payload.get("lastConfirmedAt"),
        )


@dataclass(slots=True)
class Profile:
    view: str
    sections: dict[str, list[ProfileEntry]]
    generated_at: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Profile":
        sections: dict[str, list[ProfileEntry]] = {}
        for key, entries in payload.get("sections", {}).items():
            sections[key] = [ProfileEntry.from_dict(e) for e in entries]
        return cls(
            view=str(payload["view"]),
            sections=sections,
            generated_at=int(payload["generatedAt"]),
        )


@dataclass(slots=True)
class PlaybookRevision:
    id: int
    playbook_id: int
    instructions: str
    revision_reason: str
    source_session_id: Optional[str]
    created_at: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PlaybookRevision":
        return cls(
            id=int(payload["id"]),
            playbook_id=int(payload["playbook_id"]),
            instructions=str(payload["instructions"]),
            revision_reason=str(payload["revision_reason"]),
            source_session_id=payload.get("source_session_id"),
            created_at=int(payload["created_at"]),
        )


@dataclass(slots=True)
class Playbook:
    id: int
    title: str
    description: str
    instructions: str
    references: list[str]
    templates: list[str]
    scripts: list[str]
    assets: list[str]
    tags: list[str]
    status: str
    source_session_id: Optional[str]
    source_working_memory_id: Optional[int]
    revision_count: int
    use_count: int
    last_used_at: Optional[int]
    created_at: int
    updated_at: int
    schema_version: int
    # Scope fields — required so consumers can trust that a playbook record
    # carries provenance and tenancy metadata instead of only shallow fields.
    tenant_id: str
    system_id: str
    workspace_id: str
    collaboration_id: str
    scope_id: str

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Playbook":
        return cls(
            id=int(payload["id"]),
            title=str(payload["title"]),
            description=str(payload["description"]),
            instructions=str(payload["instructions"]),
            references=[str(r) for r in payload.get("references", [])],
            templates=[str(t) for t in payload.get("templates", [])],
            scripts=[str(s) for s in payload.get("scripts", [])],
            assets=[str(a) for a in payload.get("assets", [])],
            tags=[str(t) for t in payload.get("tags", [])],
            status=str(payload["status"]),
            source_session_id=payload.get("source_session_id"),
            source_working_memory_id=payload.get("source_working_memory_id"),
            revision_count=int(payload.get("revision_count", 0)),
            use_count=int(payload.get("use_count", 0)),
            last_used_at=payload.get("last_used_at"),
            created_at=int(payload["created_at"]),
            updated_at=int(payload["updated_at"]),
            schema_version=int(payload.get("schema_version", 1)),
            tenant_id=str(payload.get("tenant_id", "")),
            system_id=str(payload.get("system_id", "")),
            workspace_id=str(payload.get("workspace_id", "")),
            collaboration_id=str(payload.get("collaboration_id", "")),
            scope_id=str(payload.get("scope_id", "")),
        )


@dataclass(slots=True)
class PlaybookSearchHit:
    """A playbook returned from a ranked search, with its relevance rank."""

    playbook: Playbook
    rank: float

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "PlaybookSearchHit":
        return cls(
            playbook=Playbook.from_dict(payload),
            rank=float(payload.get("rank", 0.0)),
        )


@dataclass(slots=True)
class RevisePlaybookResult:
    playbook: Playbook
    revision: PlaybookRevision

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "RevisePlaybookResult":
        return cls(
            playbook=Playbook.from_dict(payload["playbook"]),
            revision=PlaybookRevision.from_dict(payload["revision"]),
        )


@dataclass(slots=True)
class Association:
    id: int
    source_kind: str
    source_id: int
    target_kind: str
    target_id: int
    association_type: str
    confidence: float
    auto_generated: bool
    created_at: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "Association":
        return cls(
            id=int(payload["id"]),
            source_kind=str(payload["source_kind"]),
            source_id=int(payload["source_id"]),
            target_kind=str(payload["target_kind"]),
            target_id=int(payload["target_id"]),
            association_type=str(payload["association_type"]),
            confidence=float(payload.get("confidence", 0)),
            auto_generated=bool(payload.get("auto_generated", False)),
            created_at=int(payload["created_at"]),
        )


@dataclass(slots=True)
class AssociationNode:
    kind: str
    id: int

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "AssociationNode":
        return cls(
            kind=str(payload["kind"]),
            id=int(payload["id"]),
        )


@dataclass(slots=True)
class AssociationGraph:
    nodes: list[AssociationNode]
    edges: list[Association]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "AssociationGraph":
        return cls(
            nodes=[AssociationNode.from_dict(n) for n in payload.get("nodes", [])],
            edges=[Association.from_dict(e) for e in payload.get("edges", [])],
        )


@dataclass(slots=True)
class SessionSnapshot:
    snapshot_id: str
    session_id: str
    bootstrap: dict[str, Any]
    context: dict[str, Any]
    frozen_at: int
    watermark_event_id: Optional[str]

    @classmethod
    def from_dict(cls, payload: dict[str, Any]) -> "SessionSnapshot":
        return cls(
            snapshot_id=str(payload["snapshotId"]),
            session_id=str(payload.get("sessionId", "")),
            bootstrap=dict(payload.get("bootstrap", {})),
            context=dict(payload.get("context", {})),
            frozen_at=int(payload["frozenAt"]),
            watermark_event_id=_parse_temporal_id(payload.get("watermarkEventId")),
        )


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
