"""REST clients for the memory-layer HTTP server."""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any, Optional
from urllib.parse import quote, urlencode

import httpx

from .models import (
    ActorRef,
    Association,
    AssociationGraph,
    AuditListResponse,
    ChangeListResponse,
    HandoffListResponse,
    HandoffRecord,
    CompactionLogListResponse,
    CompactResponse,
    ContextResponse,
    CreatedResource,
    DueReverificationResponse,
    HealthResponse,
    KnowledgeInspectionResponse,
    KnowledgeListResponse,
    MaintenanceResponse,
    MemoryEvent,
    MemoryEventRecord,
    MemoryScope,
    MonitorResponse,
    ReadyResponse,
    ReverificationResponse,
    SearchResponse,
    StoredExchange,
    StoredTurn,
    TemporalDiffResponse,
    TemporalEventLogResponse,
    TemporalStateResponse,
    CognitiveSearchResult,
    EpisodeSearchResponse,
    EpisodeSummary,
    Playbook,
    PlaybookSearchHit,
    Profile,
    ReflectResult,
    RevisePlaybookResult,
    SessionSnapshot,
    TrustAssessmentResponse,
    WorkClaim,
    WorkClaimListResponse,
)


class MemoryLayerError(RuntimeError):
    """Raised when the memory-layer service returns an error.

    Attributes:
        status_code: HTTP status code returned by the service, or None if
            the error occurred before a response was received (e.g. invalid
            JSON, transport failure).
    """

    def __init__(self, message: str, status_code: Optional[int] = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def _merge_scope(
    body: Optional[dict[str, Any]],
    scope: Optional[MemoryScope],
    default_scope: Optional[MemoryScope],
) -> Optional[dict[str, Any]]:
    resolved = scope or default_scope
    if resolved is None:
        return body
    payload = dict(body or {})
    payload["scope"] = resolved.to_dict()
    return payload


def _resolve_scope(
    scope: Optional[MemoryScope],
    default_scope: Optional[MemoryScope],
) -> Optional[MemoryScope]:
    return scope or default_scope


def _scope_headers(
    scope: Optional[MemoryScope],
    default_scope: Optional[MemoryScope],
) -> dict[str, str]:
    resolved = _resolve_scope(scope, default_scope)
    return resolved.to_headers() if resolved else {}


def _append_query_params(path: str, params: dict[str, Any]) -> str:
    filtered = {key: value for key, value in params.items() if value is not None}
    if not filtered:
        return path
    return f"{path}?{urlencode(filtered)}"


def _event_stream_path(
    event_types: Optional[list[str]],
    scope_level: str,
    scope: Optional[MemoryScope],
    default_scope: Optional[MemoryScope],
) -> str:
    params: dict[str, Any] = {
        "event_types": ",".join(event_types) if event_types else None,
        "scope_level": scope_level,
    }
    resolved_scope = scope or default_scope
    if resolved_scope:
        params.update(resolved_scope.to_dict())
    return _append_query_params("/v1/events", params)


def _parse_sse_payload(line: str) -> Optional[MemoryEvent]:
    if not line.startswith("data:"):
        return None
    payload = line[5:].strip()
    if not payload:
        return None
    parsed = json.loads(payload)
    if not isinstance(parsed, dict):
        raise MemoryLayerError("memory-layer event stream returned a non-object payload")
    return MemoryEvent.from_dict(parsed)


def _parse_change_sse_payload(line: str) -> Optional[MemoryEventRecord]:
    if not line.startswith("data:"):
        return None
    payload = line[5:].strip()
    if not payload:
        return None
    parsed = json.loads(payload)
    if not isinstance(parsed, dict):
        raise MemoryLayerError("memory-layer change stream returned a non-object payload")
    if parsed.get("type") in {"connected", "error"}:
        return None
    return MemoryEventRecord.from_dict(parsed)


def _actor_to_dict(actor: ActorRef) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "actor_kind": actor.actor_kind,
        "actor_id": actor.actor_id,
    }
    if actor.system_id is not None:
        payload["system_id"] = actor.system_id
    if actor.display_name is not None:
        payload["display_name"] = actor.display_name
    if actor.metadata is not None:
        payload["metadata"] = actor.metadata
    return payload


def _viewer_query_params(viewer: Optional[ActorRef]) -> dict[str, Any]:
    if viewer is None:
        return {}
    return {
        "viewer_actor_kind": viewer.actor_kind,
        "viewer_actor_id": viewer.actor_id,
        "viewer_system_id": viewer.system_id,
        "viewer_display_name": viewer.display_name,
    }


class MemoryClient:
    """Typed synchronous client for the memory-layer HTTP API."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        default_scope: Optional[MemoryScope] = None,
        timeout: float = 10.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.default_scope = default_scope
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout, headers=self._headers())

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        *,
        admin: bool = False,
        admin_key: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        request_headers = dict(headers or {})
        if admin and admin_key:
            request_headers["x-admin-key"] = admin_key
        response = self._client.request(
            method,
            path,
            json=body,
            headers=request_headers or None,
        )
        if response.is_error:
            raise MemoryLayerError(
                f"memory-layer API error {response.status_code}: {response.text}",
                status_code=response.status_code,
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise MemoryLayerError("memory-layer API returned a non-object JSON payload")
        return payload

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "MemoryClient":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    def store_turn(
        self,
        role: str,
        content: str,
        actor: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> StoredTurn:
        body: dict[str, Any] = {"role": role, "content": content}
        if actor:
            body["actor"] = actor
        payload = self._request(
            "POST",
            "/v1/turns",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return StoredTurn.from_dict(payload)

    def store_exchange(
        self,
        user_content: str,
        assistant_content: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> StoredExchange:
        payload = self._request(
            "POST",
            "/v1/exchanges",
            _merge_scope(
                {
                    "userContent": user_content,
                    "assistantContent": assistant_content,
                },
                scope,
                self.default_scope,
            ),
            headers=_scope_headers(scope, self.default_scope),
        )
        return StoredExchange.from_dict(payload)

    def get_context(
        self,
        query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
        view: Optional[str] = None,
        include_coordination: Optional[bool] = None,
        viewer: Optional[ActorRef] = None,
    ) -> ContextResponse:
        params = {
            "query": query,
            "view": view,
            "include_coordination": str(include_coordination).lower() if include_coordination is not None else None,
        }
        params.update(_viewer_query_params(viewer))
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/context", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ContextResponse.from_dict(payload)

    def get_state_at(
        self,
        as_of: int,
        query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
        view: Optional[str] = None,
        include_coordination: Optional[bool] = None,
        viewer: Optional[ActorRef] = None,
    ) -> TemporalStateResponse:
        params: dict[str, Any] = {
            "as_of": as_of,
            "query": query,
            "view": view,
            "include_coordination": str(include_coordination).lower() if include_coordination is not None else None,
        }
        params.update(_viewer_query_params(viewer))
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/state", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalStateResponse.from_dict(payload)

    def get_timeline(
        self,
        *,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        start_at: Optional[int] = None,
        end_at: Optional[int] = None,
        limit: Optional[int] = None,
        cursor: Optional[str | int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> TemporalEventLogResponse:
        params: dict[str, Any] = {
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
            "start_at": start_at,
            "end_at": end_at,
            "limit": limit,
            "cursor": cursor,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/timeline", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalEventLogResponse.from_dict(payload)

    def diff_state(
        self,
        from_timestamp: int,
        to_timestamp: int,
        *,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> TemporalDiffResponse:
        params: dict[str, Any] = {
            "from": from_timestamp,
            "to": to_timestamp,
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/state/diff", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalDiffResponse.from_dict(payload)

    def list_memory_events(
        self,
        *,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        start_at: Optional[int] = None,
        end_at: Optional[int] = None,
        limit: Optional[int] = None,
        cursor: Optional[str | int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> TemporalEventLogResponse:
        params: dict[str, Any] = {
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
            "start_at": start_at,
            "end_at": end_at,
            "limit": limit,
            "cursor": cursor,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/events/log", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalEventLogResponse.from_dict(payload)

    def search(
        self,
        query: str,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": query, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/search", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SearchResponse.from_dict(payload)

    def search_cross_scope(
        self,
        query: str,
        scope_level: str = "workspace",
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": query, "scope_level": scope_level, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/search/cross-scope", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SearchResponse.from_dict(payload)

    def learn_fact(
        self,
        fact: str,
        fact_type: str,
        confidence: str = "high",
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CreatedResource:
        payload = self._request(
            "POST",
            "/v1/facts",
            _merge_scope(
                {
                    "fact": fact,
                    "factType": fact_type,
                    "confidence": confidence,
                },
                scope,
                self.default_scope,
            ),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CreatedResource.from_key(payload, "knowledgeId")

    def track_work(
        self,
        title: str,
        kind: str = "objective",
        status: str = "open",
        detail: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
        visibility_class: Optional[str] = None,
    ) -> CreatedResource:
        body: dict[str, Any] = {"title": title, "kind": kind, "status": status}
        if detail:
            body["detail"] = detail
        if visibility_class is not None:
            body["visibility_class"] = visibility_class
        payload = self._request(
            "POST",
            "/v1/work",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CreatedResource.from_key(payload, "workItemId")

    def update_work_item(
        self,
        work_item_id: int,
        *,
        title: Optional[str] = None,
        detail: Optional[str] = None,
        status: Optional[str] = None,
        visibility_class: Optional[str] = None,
        expected_version: Optional[int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if detail is not None:
            body["detail"] = detail
        if status is not None:
            body["status"] = status
        if visibility_class is not None:
            body["visibility_class"] = visibility_class
        if expected_version is not None:
            body["expectedVersion"] = expected_version
        payload = self._request(
            "POST",
            f"/v1/work-items/{work_item_id}",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return dict(payload["workItem"])

    def claim_work_item(
        self,
        work_item_id: int,
        actor: ActorRef,
        *,
        lease_seconds: Optional[int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> WorkClaim:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if lease_seconds is not None:
            body["lease_seconds"] = lease_seconds
        payload = self._request(
            "POST",
            f"/v1/work-items/{work_item_id}/claim",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return WorkClaim.from_dict(payload["claim"])

    def renew_work_claim(
        self,
        claim_id: int,
        actor: ActorRef,
        *,
        lease_seconds: Optional[int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[WorkClaim]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if lease_seconds is not None:
            body["lease_seconds"] = lease_seconds
        payload = self._request(
            "POST",
            f"/v1/work-claims/{claim_id}/renew",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        claim = payload.get("claim")
        return WorkClaim.from_dict(claim) if isinstance(claim, dict) else None

    def release_work_claim(
        self,
        claim_id: int,
        actor: ActorRef,
        *,
        reason: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[WorkClaim]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if reason is not None:
            body["reason"] = reason
        payload = self._request(
            "POST",
            f"/v1/work-claims/{claim_id}/release",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        claim = payload.get("claim")
        return WorkClaim.from_dict(claim) if isinstance(claim, dict) else None

    def list_work_claims(self, *, scope: Optional[MemoryScope] = None) -> WorkClaimListResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/work-claims", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return WorkClaimListResponse.from_dict(payload)

    def handoff_work_item(
        self,
        work_item_id: int,
        from_actor: ActorRef,
        to_actor: ActorRef,
        summary: str,
        *,
        context_bundle_ref: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> HandoffRecord:
        body: dict[str, Any] = {
            "from_actor": _actor_to_dict(from_actor),
            "to_actor": _actor_to_dict(to_actor),
            "summary": summary,
        }
        if context_bundle_ref is not None:
            body["context_bundle_ref"] = context_bundle_ref
        payload = self._request(
            "POST",
            f"/v1/work-items/{work_item_id}/handoffs",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HandoffRecord.from_dict(payload["handoff"])

    def _handoff_action(
        self,
        handoff_id: int,
        action: str,
        actor: ActorRef,
        *,
        reason: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[HandoffRecord]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if reason is not None:
            body["reason"] = reason
        payload = self._request(
            "POST",
            f"/v1/handoffs/{handoff_id}/{action}",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        handoff = payload.get("handoff")
        return HandoffRecord.from_dict(handoff) if isinstance(handoff, dict) else None

    def accept_handoff(self, handoff_id: int, actor: ActorRef, *, reason: Optional[str] = None, scope: Optional[MemoryScope] = None) -> Optional[HandoffRecord]:
        return self._handoff_action(handoff_id, "accept", actor, reason=reason, scope=scope)

    def reject_handoff(self, handoff_id: int, actor: ActorRef, *, reason: Optional[str] = None, scope: Optional[MemoryScope] = None) -> Optional[HandoffRecord]:
        return self._handoff_action(handoff_id, "reject", actor, reason=reason, scope=scope)

    def cancel_handoff(self, handoff_id: int, actor: ActorRef, *, reason: Optional[str] = None, scope: Optional[MemoryScope] = None) -> Optional[HandoffRecord]:
        return self._handoff_action(handoff_id, "cancel", actor, reason=reason, scope=scope)

    def list_pending_handoffs(self, *, scope: Optional[MemoryScope] = None) -> HandoffListResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/handoffs", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HandoffListResponse.from_dict(payload)

    def compact(
        self,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> CompactResponse:
        payload = self._request(
            "POST",
            "/v1/compact",
            _merge_scope({}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return CompactResponse.from_dict(payload)

    def health(self, *, scope: Optional[MemoryScope] = None) -> HealthResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/health", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HealthResponse.from_dict(payload)

    def live(self) -> ReadyResponse:
        payload = self._request("GET", "/healthz")
        return ReadyResponse.from_dict(payload)

    def maintenance(
        self,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> MaintenanceResponse:
        payload = self._request(
            "POST",
            "/v1/maintenance",
            _merge_scope({}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return MaintenanceResponse.from_dict(payload)

    def ready(self) -> ReadyResponse:
        payload = self._request("GET", "/readyz")
        return ReadyResponse.from_dict(payload)

    def search_episodes(
        self,
        query: str,
        detail_level: Optional[str] = None,
        limit: Optional[int] = None,
        time_range: Optional[dict[str, int]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> EpisodeSearchResponse:
        params: dict[str, Any] = {"q": query, "detail": detail_level, "limit": limit}
        if time_range is not None:
            if "start_at" in time_range:
                params["start_at"] = time_range["start_at"]
            if "end_at" in time_range:
                params["end_at"] = time_range["end_at"]
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/episodes", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return EpisodeSearchResponse.from_dict(payload)

    def summarize_episode(
        self,
        session_id: str,
        detail_level: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> EpisodeSummary:
        body: dict[str, Any] = {"session_id": session_id}
        if detail_level is not None:
            body["detailLevel"] = detail_level
        payload = self._request(
            "POST",
            "/v1/episodes/summarize",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return EpisodeSummary.from_dict(payload["episode"])

    def reflect(
        self,
        query: str,
        detail_level: Optional[str] = None,
        include_episodic: Optional[bool] = None,
        include_declarative: Optional[bool] = None,
        limit: Optional[int] = None,
        time_range: Optional[dict[str, int]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ReflectResult:
        body: dict[str, Any] = {"query": query}
        if detail_level is not None:
            body["detailLevel"] = detail_level
        if include_episodic is not None:
            body["includeEpisodic"] = include_episodic
        if include_declarative is not None:
            body["includeDeclarative"] = include_declarative
        if limit is not None:
            body["limit"] = limit
        if time_range is not None:
            body["timeRange"] = time_range
        payload = self._request(
            "POST",
            "/v1/reflect",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ReflectResult.from_dict(payload)

    def search_cognitive(
        self,
        query: str,
        types: Optional[list[str]] = None,
        limit: Optional[int] = None,
        minimum_trust_score: Optional[float] = None,
        active_only: Optional[bool] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CognitiveSearchResult:
        params: dict[str, Any] = {
            "q": query,
            "types": ",".join(types) if types else None,
            "limit": limit,
            "minimumTrustScore": minimum_trust_score,
            "activeOnly": str(active_only).lower() if active_only is not None else None,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/memory", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CognitiveSearchResult.from_dict(payload)

    def get_profile(
        self,
        view: Optional[str] = None,
        sections: Optional[list[str]] = None,
        min_trust: Optional[float] = None,
        include_provisional: Optional[bool] = None,
        include_disputed: Optional[bool] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> "Profile":
        params: dict[str, Any] = {
            "view": view,
            "sections": ",".join(sections) if sections else None,
            "min_trust": min_trust,
            "includeProvisional": str(include_provisional).lower() if include_provisional is not None else None,
            "includeDisputed": str(include_disputed).lower() if include_disputed is not None else None,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/profile", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Profile.from_dict(payload["profile"])

    def create_playbook(
        self,
        title: str,
        description: str,
        instructions: str,
        tags: Optional[list[str]] = None,
        status: Optional[str] = None,
        references: Optional[list[str]] = None,
        templates: Optional[list[str]] = None,
        scripts: Optional[list[str]] = None,
        assets: Optional[list[str]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        body: dict[str, Any] = {
            "title": title,
            "description": description,
            "instructions": instructions,
        }
        if tags is not None:
            body["tags"] = tags
        if status is not None:
            body["status"] = status
        if references is not None:
            body["references"] = references
        if templates is not None:
            body["templates"] = templates
        if scripts is not None:
            body["scripts"] = scripts
        if assets is not None:
            body["assets"] = assets
        if scope or self.default_scope:
            body["scope"] = (scope or self.default_scope).to_dict()  # type: ignore[union-attr]
        payload = self._request("POST", "/v1/playbooks", body, headers=_scope_headers(scope, self.default_scope))
        return Playbook.from_dict(payload["playbook"])

    def list_playbooks(
        self,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[Playbook]:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/playbooks", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [Playbook.from_dict(p) for p in payload.get("playbooks", [])]

    def search_playbooks(
        self,
        query: str,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[PlaybookSearchHit]:
        """Search playbooks by query. Returns ranked hits preserving rank and
        the full playbook payload including scope metadata."""
        params: dict[str, Any] = {"q": query, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/playbooks", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [PlaybookSearchHit.from_dict(p) for p in payload.get("playbooks", [])]

    def get_playbook(
        self,
        playbook_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        """Fetch a playbook by id. Raises MemoryLayerError on 404."""
        payload = self._request(
            "GET",
            f"/v1/playbooks/{playbook_id}",
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])

    def revise_playbook(
        self,
        playbook_id: int,
        instructions: str,
        revision_reason: str,
        source_session_id: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> RevisePlaybookResult:
        body: dict[str, Any] = {
            "instructions": instructions,
            "revisionReason": revision_reason,
        }
        if source_session_id is not None:
            body["sourceSessionId"] = source_session_id
        if scope or self.default_scope:
            body["scope"] = (scope or self.default_scope).to_dict()  # type: ignore[union-attr]
        payload = self._request(
            "POST",
            f"/v1/playbooks/{playbook_id}/revise",
            body,
            headers=_scope_headers(scope, self.default_scope),
        )
        return RevisePlaybookResult.from_dict(payload)

    def record_playbook_use(
        self,
        playbook_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> None:
        self._request(
            "POST",
            f"/v1/playbooks/{playbook_id}/use",
            headers=_scope_headers(scope, self.default_scope),
        )

    def create_playbook_from_task(
        self,
        title: str,
        description: str,
        session_id: str,
        tags: Optional[list[str]] = None,
        source_working_memory_id: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        body: dict[str, Any] = {
            "title": title,
            "description": description,
            "sessionId": session_id,
        }
        if tags is not None:
            body["tags"] = tags
        if source_working_memory_id is not None:
            body["sourceWorkingMemoryId"] = source_working_memory_id
        if scope or self.default_scope:
            body["scope"] = (scope or self.default_scope).to_dict()  # type: ignore[union-attr]
        payload = self._request(
            "POST",
            "/v1/playbooks/from-task",
            body,
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])

    def add_association(
        self,
        source_kind: str,
        source_id: int,
        target_kind: str,
        target_id: int,
        association_type: str,
        confidence: Optional[float] = None,
        auto_generated: Optional[bool] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Association:
        body: dict[str, Any] = {
            "source_kind": source_kind,
            "source_id": source_id,
            "target_kind": target_kind,
            "target_id": target_id,
            "association_type": association_type,
        }
        if confidence is not None:
            body["confidence"] = confidence
        if auto_generated is not None:
            body["auto_generated"] = auto_generated
        payload = self._request(
            "POST",
            "/v1/associations",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Association.from_dict(payload["association"])

    def get_associations(
        self,
        kind: str,
        target_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> dict[str, list[Association]]:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params(f"/v1/associations/{kind}/{target_id}", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return {
            "from": [Association.from_dict(a) for a in payload.get("from", [])],
            "to": [Association.from_dict(a) for a in payload.get("to", [])],
        }

    def traverse_associations(
        self,
        kind: str,
        target_id: int,
        max_depth: Optional[int] = None,
        max_nodes: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> AssociationGraph:
        body: dict[str, Any] = {"kind": kind, "id": target_id}
        if max_depth is not None:
            body["maxDepth"] = max_depth
        if max_nodes is not None:
            body["maxNodes"] = max_nodes
        payload = self._request(
            "POST",
            "/v1/associations/traverse",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return AssociationGraph.from_dict(payload)

    def remove_association(
        self,
        association_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> None:
        self._request(
            "DELETE",
            f"/v1/associations/{association_id}",
            headers=_scope_headers(scope, self.default_scope),
        )

    def capture_snapshot(
        self,
        session_id: str,
        relevance_query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SessionSnapshot:
        body: dict[str, Any] = {}
        if relevance_query is not None:
            body["relevanceQuery"] = relevance_query
        encoded = quote(session_id, safe="")
        payload = self._request(
            "POST",
            f"/v1/sessions/{encoded}/snapshot",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SessionSnapshot.from_dict(payload["snapshot"])

    def get_snapshot(
        self,
        session_id: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[SessionSnapshot]:
        encoded = quote(session_id, safe="")
        try:
            payload = self._request(
                "GET",
                f"/v1/sessions/{encoded}/snapshot",
                headers=_scope_headers(scope, self.default_scope),
            )
        except MemoryLayerError as err:
            if err.status_code == 404:
                return None
            raise
        return SessionSnapshot.from_dict(payload["snapshot"])

    def refresh_snapshot(
        self,
        session_id: str,
        relevance_query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SessionSnapshot:
        body: dict[str, Any] = {}
        if relevance_query is not None:
            body["relevanceQuery"] = relevance_query
        encoded = quote(session_id, safe="")
        payload = self._request(
            "POST",
            f"/v1/sessions/{encoded}/refresh",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SessionSnapshot.from_dict(payload["snapshot"])

    def stream_events(
        self,
        *,
        event_types: Optional[list[str]] = None,
        scope_level: str = "scope",
        scope: Optional[MemoryScope] = None,
    ) -> Iterator[MemoryEvent]:
        path = _event_stream_path(event_types, scope_level, scope, self.default_scope)
        headers = _scope_headers(scope, self.default_scope) or None
        with self._client.stream("GET", path, headers=headers) as response:
            if response.is_error:
                raise MemoryLayerError(
                    f"memory-layer API error {response.status_code}: {response.text}",
                    status_code=response.status_code,
                )
            for line in response.iter_lines():
                event = _parse_sse_payload(line)
                if event is not None:
                    yield event

    def stream_changes(
        self,
        *,
        cursor: Optional[str | int] = None,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Iterator[MemoryEventRecord]:
        params: dict[str, Any] = {
            "cursor": cursor,
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        path = _append_query_params("/v1/changes/stream", params)
        headers = _scope_headers(scope, self.default_scope) or None
        with self._client.stream("GET", path, headers=headers) as response:
            if response.is_error:
                raise MemoryLayerError(
                    f"memory-layer API error {response.status_code}: {response.text}",
                    status_code=response.status_code,
                )
            for line in response.iter_lines():
                event = _parse_change_sse_payload(line)
                if event is not None:
                    yield event

    def poll_changes(
        self,
        since: str,
        scope_level: str = "scope",
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ChangeListResponse:
        params: dict[str, Any] = {"since": since, "scope_level": scope_level}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/changes", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ChangeListResponse.from_dict(payload)

    def list_knowledge(
        self,
        limit: Optional[int] = None,
        cursor: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> KnowledgeListResponse:
        params: dict[str, Any] = {"limit": limit, "cursor": cursor}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/inspect/knowledge", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return KnowledgeListResponse.from_dict(payload)

    def inspect_knowledge(
        self,
        knowledge_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> KnowledgeInspectionResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params(f"/v1/inspect/knowledge/{knowledge_id}", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return KnowledgeInspectionResponse.from_dict(payload)

    def list_audits(
        self,
        knowledge_id: Optional[int] = None,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> AuditListResponse:
        params: dict[str, Any] = {"knowledge_id": knowledge_id, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/inspect/audits", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return AuditListResponse.from_dict(payload)

    def inspect_monitor(self, *, scope: Optional[MemoryScope] = None) -> MonitorResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/inspect/monitor", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return MonitorResponse.from_dict(payload)

    def inspect_compactions(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CompactionLogListResponse:
        params: dict[str, Any] = {"limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/inspect/compactions", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CompactionLogListResponse.from_dict(payload)

    def inspect_reverification(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> DueReverificationResponse:
        params: dict[str, Any] = {"limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request(
            "GET",
            _append_query_params("/v1/inspect/reverification", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return DueReverificationResponse.from_dict(payload)

    def reverify_knowledge(
        self,
        knowledge_id: int,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> TrustAssessmentResponse:
        payload = self._request(
            "POST",
            f"/v1/reverification/{knowledge_id}",
            _merge_scope({}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return TrustAssessmentResponse.from_dict(payload)

    def run_reverification(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> ReverificationResponse:
        payload = self._request(
            "POST",
            "/v1/reverification/run",
            _merge_scope({"limit": limit}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return ReverificationResponse.from_dict(payload)


class AsyncMemoryClient:
    """Typed asynchronous client for the memory-layer HTTP API."""

    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        default_scope: Optional[MemoryScope] = None,
        timeout: float = 10.0,
    ):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.default_scope = default_scope
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            headers=self._headers(),
        )

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    async def _request(
        self,
        method: str,
        path: str,
        body: Optional[dict[str, Any]] = None,
        *,
        admin: bool = False,
        admin_key: Optional[str] = None,
        headers: Optional[dict[str, str]] = None,
    ) -> dict[str, Any]:
        request_headers = dict(headers or {})
        if admin and admin_key:
            request_headers["x-admin-key"] = admin_key
        response = await self._client.request(
            method,
            path,
            json=body,
            headers=request_headers or None,
        )
        if response.is_error:
            raise MemoryLayerError(
                f"memory-layer API error {response.status_code}: {response.text}",
                status_code=response.status_code,
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise MemoryLayerError("memory-layer API returned a non-object JSON payload")
        return payload

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> "AsyncMemoryClient":
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        await self.aclose()

    async def store_turn(
        self,
        role: str,
        content: str,
        actor: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> StoredTurn:
        body: dict[str, Any] = {"role": role, "content": content}
        if actor:
            body["actor"] = actor
        payload = await self._request(
            "POST",
            "/v1/turns",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return StoredTurn.from_dict(payload)

    async def store_exchange(
        self,
        user_content: str,
        assistant_content: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> StoredExchange:
        payload = await self._request(
            "POST",
            "/v1/exchanges",
            _merge_scope(
                {
                    "userContent": user_content,
                    "assistantContent": assistant_content,
                },
                scope,
                self.default_scope,
            ),
            headers=_scope_headers(scope, self.default_scope),
        )
        return StoredExchange.from_dict(payload)

    async def get_context(
        self,
        query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
        view: Optional[str] = None,
        include_coordination: Optional[bool] = None,
        viewer: Optional[ActorRef] = None,
    ) -> ContextResponse:
        params = {
            "query": query,
            "view": view,
            "include_coordination": str(include_coordination).lower() if include_coordination is not None else None,
        }
        params.update(_viewer_query_params(viewer))
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/context", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ContextResponse.from_dict(payload)

    async def get_state_at(
        self,
        as_of: int,
        query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
        view: Optional[str] = None,
        include_coordination: Optional[bool] = None,
        viewer: Optional[ActorRef] = None,
    ) -> TemporalStateResponse:
        params: dict[str, Any] = {
            "as_of": as_of,
            "query": query,
            "view": view,
            "include_coordination": str(include_coordination).lower() if include_coordination is not None else None,
        }
        params.update(_viewer_query_params(viewer))
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/state", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalStateResponse.from_dict(payload)

    async def get_timeline(
        self,
        *,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        start_at: Optional[int] = None,
        end_at: Optional[int] = None,
        limit: Optional[int] = None,
        cursor: Optional[str | int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> TemporalEventLogResponse:
        params: dict[str, Any] = {
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
            "start_at": start_at,
            "end_at": end_at,
            "limit": limit,
            "cursor": cursor,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/timeline", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalEventLogResponse.from_dict(payload)

    async def diff_state(
        self,
        from_timestamp: int,
        to_timestamp: int,
        *,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> TemporalDiffResponse:
        params: dict[str, Any] = {
            "from": from_timestamp,
            "to": to_timestamp,
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/state/diff", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalDiffResponse.from_dict(payload)

    async def list_memory_events(
        self,
        *,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        start_at: Optional[int] = None,
        end_at: Optional[int] = None,
        limit: Optional[int] = None,
        cursor: Optional[str | int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> TemporalEventLogResponse:
        params: dict[str, Any] = {
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
            "start_at": start_at,
            "end_at": end_at,
            "limit": limit,
            "cursor": cursor,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/events/log", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalEventLogResponse.from_dict(payload)

    async def search(
        self,
        query: str,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": query, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/search", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SearchResponse.from_dict(payload)

    async def search_cross_scope(
        self,
        query: str,
        scope_level: str = "workspace",
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": query, "scope_level": scope_level, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/search/cross-scope", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SearchResponse.from_dict(payload)

    async def learn_fact(
        self,
        fact: str,
        fact_type: str,
        confidence: str = "high",
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CreatedResource:
        payload = await self._request(
            "POST",
            "/v1/facts",
            _merge_scope(
                {
                    "fact": fact,
                    "factType": fact_type,
                    "confidence": confidence,
                },
                scope,
                self.default_scope,
            ),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CreatedResource.from_key(payload, "knowledgeId")

    async def track_work(
        self,
        title: str,
        kind: str = "objective",
        status: str = "open",
        detail: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
        visibility_class: Optional[str] = None,
    ) -> CreatedResource:
        body: dict[str, Any] = {"title": title, "kind": kind, "status": status}
        if detail:
            body["detail"] = detail
        if visibility_class is not None:
            body["visibility_class"] = visibility_class
        payload = await self._request(
            "POST",
            "/v1/work",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CreatedResource.from_key(payload, "workItemId")

    async def update_work_item(
        self,
        work_item_id: int,
        *,
        title: Optional[str] = None,
        detail: Optional[str] = None,
        status: Optional[str] = None,
        visibility_class: Optional[str] = None,
        expected_version: Optional[int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if title is not None:
            body["title"] = title
        if detail is not None:
            body["detail"] = detail
        if status is not None:
            body["status"] = status
        if visibility_class is not None:
            body["visibility_class"] = visibility_class
        if expected_version is not None:
            body["expectedVersion"] = expected_version
        payload = await self._request(
            "POST",
            f"/v1/work-items/{work_item_id}",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return dict(payload["workItem"])

    async def claim_work_item(
        self,
        work_item_id: int,
        actor: ActorRef,
        *,
        lease_seconds: Optional[int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> WorkClaim:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if lease_seconds is not None:
            body["lease_seconds"] = lease_seconds
        payload = await self._request(
            "POST",
            f"/v1/work-items/{work_item_id}/claim",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return WorkClaim.from_dict(payload["claim"])

    async def renew_work_claim(
        self,
        claim_id: int,
        actor: ActorRef,
        *,
        lease_seconds: Optional[int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[WorkClaim]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if lease_seconds is not None:
            body["lease_seconds"] = lease_seconds
        payload = await self._request(
            "POST",
            f"/v1/work-claims/{claim_id}/renew",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        claim = payload.get("claim")
        return WorkClaim.from_dict(claim) if isinstance(claim, dict) else None

    async def release_work_claim(
        self,
        claim_id: int,
        actor: ActorRef,
        *,
        reason: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[WorkClaim]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if reason is not None:
            body["reason"] = reason
        payload = await self._request(
            "POST",
            f"/v1/work-claims/{claim_id}/release",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        claim = payload.get("claim")
        return WorkClaim.from_dict(claim) if isinstance(claim, dict) else None

    async def list_work_claims(self, *, scope: Optional[MemoryScope] = None) -> WorkClaimListResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/work-claims", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return WorkClaimListResponse.from_dict(payload)

    async def handoff_work_item(
        self,
        work_item_id: int,
        from_actor: ActorRef,
        to_actor: ActorRef,
        summary: str,
        *,
        context_bundle_ref: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> HandoffRecord:
        body: dict[str, Any] = {
            "from_actor": _actor_to_dict(from_actor),
            "to_actor": _actor_to_dict(to_actor),
            "summary": summary,
        }
        if context_bundle_ref is not None:
            body["context_bundle_ref"] = context_bundle_ref
        payload = await self._request(
            "POST",
            f"/v1/work-items/{work_item_id}/handoffs",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HandoffRecord.from_dict(payload["handoff"])

    async def _handoff_action(
        self,
        handoff_id: int,
        action: str,
        actor: ActorRef,
        *,
        reason: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[HandoffRecord]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if reason is not None:
            body["reason"] = reason
        payload = await self._request(
            "POST",
            f"/v1/handoffs/{handoff_id}/{action}",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        handoff = payload.get("handoff")
        return HandoffRecord.from_dict(handoff) if isinstance(handoff, dict) else None

    async def accept_handoff(
        self, handoff_id: int, actor: ActorRef, *, reason: Optional[str] = None, scope: Optional[MemoryScope] = None
    ) -> Optional[HandoffRecord]:
        return await self._handoff_action(handoff_id, "accept", actor, reason=reason, scope=scope)

    async def reject_handoff(
        self, handoff_id: int, actor: ActorRef, *, reason: Optional[str] = None, scope: Optional[MemoryScope] = None
    ) -> Optional[HandoffRecord]:
        return await self._handoff_action(handoff_id, "reject", actor, reason=reason, scope=scope)

    async def cancel_handoff(
        self, handoff_id: int, actor: ActorRef, *, reason: Optional[str] = None, scope: Optional[MemoryScope] = None
    ) -> Optional[HandoffRecord]:
        return await self._handoff_action(handoff_id, "cancel", actor, reason=reason, scope=scope)

    async def list_pending_handoffs(self, *, scope: Optional[MemoryScope] = None) -> HandoffListResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/handoffs", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HandoffListResponse.from_dict(payload)

    async def compact(
        self,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> CompactResponse:
        payload = await self._request(
            "POST",
            "/v1/compact",
            _merge_scope({}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return CompactResponse.from_dict(payload)

    async def health(self, *, scope: Optional[MemoryScope] = None) -> HealthResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/health", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HealthResponse.from_dict(payload)

    async def live(self) -> ReadyResponse:
        payload = await self._request("GET", "/healthz")
        return ReadyResponse.from_dict(payload)

    async def maintenance(
        self,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> MaintenanceResponse:
        payload = await self._request(
            "POST",
            "/v1/maintenance",
            _merge_scope({}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return MaintenanceResponse.from_dict(payload)

    async def ready(self) -> ReadyResponse:
        payload = await self._request("GET", "/readyz")
        return ReadyResponse.from_dict(payload)

    async def search_episodes(
        self,
        query: str,
        detail_level: Optional[str] = None,
        limit: Optional[int] = None,
        time_range: Optional[dict[str, int]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> EpisodeSearchResponse:
        params: dict[str, Any] = {"q": query, "detail": detail_level, "limit": limit}
        if time_range is not None:
            if "start_at" in time_range:
                params["start_at"] = time_range["start_at"]
            if "end_at" in time_range:
                params["end_at"] = time_range["end_at"]
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/episodes", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return EpisodeSearchResponse.from_dict(payload)

    async def summarize_episode(
        self,
        session_id: str,
        detail_level: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> EpisodeSummary:
        body: dict[str, Any] = {"session_id": session_id}
        if detail_level is not None:
            body["detailLevel"] = detail_level
        payload = await self._request(
            "POST",
            "/v1/episodes/summarize",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return EpisodeSummary.from_dict(payload["episode"])

    async def reflect(
        self,
        query: str,
        detail_level: Optional[str] = None,
        include_episodic: Optional[bool] = None,
        include_declarative: Optional[bool] = None,
        limit: Optional[int] = None,
        time_range: Optional[dict[str, int]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ReflectResult:
        body: dict[str, Any] = {"query": query}
        if detail_level is not None:
            body["detailLevel"] = detail_level
        if include_episodic is not None:
            body["includeEpisodic"] = include_episodic
        if include_declarative is not None:
            body["includeDeclarative"] = include_declarative
        if limit is not None:
            body["limit"] = limit
        if time_range is not None:
            body["timeRange"] = time_range
        payload = await self._request(
            "POST",
            "/v1/reflect",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ReflectResult.from_dict(payload)

    async def search_cognitive(
        self,
        query: str,
        types: Optional[list[str]] = None,
        limit: Optional[int] = None,
        minimum_trust_score: Optional[float] = None,
        active_only: Optional[bool] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CognitiveSearchResult:
        params: dict[str, Any] = {
            "q": query,
            "types": ",".join(types) if types else None,
            "limit": limit,
            "minimumTrustScore": minimum_trust_score,
            "activeOnly": str(active_only).lower() if active_only is not None else None,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/memory", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CognitiveSearchResult.from_dict(payload)

    async def get_profile(
        self,
        view: Optional[str] = None,
        sections: Optional[list[str]] = None,
        min_trust: Optional[float] = None,
        include_provisional: Optional[bool] = None,
        include_disputed: Optional[bool] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> "Profile":
        params: dict[str, Any] = {
            "view": view,
            "sections": ",".join(sections) if sections else None,
            "min_trust": min_trust,
            "includeProvisional": str(include_provisional).lower() if include_provisional is not None else None,
            "includeDisputed": str(include_disputed).lower() if include_disputed is not None else None,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/profile", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Profile.from_dict(payload["profile"])

    async def create_playbook(
        self,
        title: str,
        description: str,
        instructions: str,
        tags: Optional[list[str]] = None,
        status: Optional[str] = None,
        references: Optional[list[str]] = None,
        templates: Optional[list[str]] = None,
        scripts: Optional[list[str]] = None,
        assets: Optional[list[str]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        body: dict[str, Any] = {
            "title": title,
            "description": description,
            "instructions": instructions,
        }
        if tags is not None:
            body["tags"] = tags
        if status is not None:
            body["status"] = status
        if references is not None:
            body["references"] = references
        if templates is not None:
            body["templates"] = templates
        if scripts is not None:
            body["scripts"] = scripts
        if assets is not None:
            body["assets"] = assets
        if scope or self.default_scope:
            body["scope"] = (scope or self.default_scope).to_dict()  # type: ignore[union-attr]
        payload = await self._request("POST", "/v1/playbooks", body, headers=_scope_headers(scope, self.default_scope))
        return Playbook.from_dict(payload["playbook"])

    async def list_playbooks(
        self,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[Playbook]:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/playbooks", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [Playbook.from_dict(p) for p in payload.get("playbooks", [])]

    async def search_playbooks(
        self,
        query: str,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[PlaybookSearchHit]:
        """Search playbooks by query. Returns ranked hits preserving rank and
        the full playbook payload including scope metadata."""
        params: dict[str, Any] = {"q": query, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/playbooks", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [PlaybookSearchHit.from_dict(p) for p in payload.get("playbooks", [])]

    async def get_playbook(
        self,
        playbook_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        """Fetch a playbook by id. Raises MemoryLayerError on 404."""
        payload = await self._request(
            "GET",
            f"/v1/playbooks/{playbook_id}",
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])

    async def revise_playbook(
        self,
        playbook_id: int,
        instructions: str,
        revision_reason: str,
        source_session_id: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> RevisePlaybookResult:
        body: dict[str, Any] = {
            "instructions": instructions,
            "revisionReason": revision_reason,
        }
        if source_session_id is not None:
            body["sourceSessionId"] = source_session_id
        if scope or self.default_scope:
            body["scope"] = (scope or self.default_scope).to_dict()  # type: ignore[union-attr]
        payload = await self._request(
            "POST",
            f"/v1/playbooks/{playbook_id}/revise",
            body,
            headers=_scope_headers(scope, self.default_scope),
        )
        return RevisePlaybookResult.from_dict(payload)

    async def record_playbook_use(
        self,
        playbook_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> None:
        await self._request(
            "POST",
            f"/v1/playbooks/{playbook_id}/use",
            headers=_scope_headers(scope, self.default_scope),
        )

    async def create_playbook_from_task(
        self,
        title: str,
        description: str,
        session_id: str,
        tags: Optional[list[str]] = None,
        source_working_memory_id: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        body: dict[str, Any] = {
            "title": title,
            "description": description,
            "sessionId": session_id,
        }
        if tags is not None:
            body["tags"] = tags
        if source_working_memory_id is not None:
            body["sourceWorkingMemoryId"] = source_working_memory_id
        if scope or self.default_scope:
            body["scope"] = (scope or self.default_scope).to_dict()  # type: ignore[union-attr]
        payload = await self._request(
            "POST",
            "/v1/playbooks/from-task",
            body,
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])

    async def add_association(
        self,
        source_kind: str,
        source_id: int,
        target_kind: str,
        target_id: int,
        association_type: str,
        confidence: Optional[float] = None,
        auto_generated: Optional[bool] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Association:
        body: dict[str, Any] = {
            "source_kind": source_kind,
            "source_id": source_id,
            "target_kind": target_kind,
            "target_id": target_id,
            "association_type": association_type,
        }
        if confidence is not None:
            body["confidence"] = confidence
        if auto_generated is not None:
            body["auto_generated"] = auto_generated
        payload = await self._request(
            "POST",
            "/v1/associations",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Association.from_dict(payload["association"])

    async def get_associations(
        self,
        kind: str,
        target_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> dict[str, list[Association]]:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params(f"/v1/associations/{kind}/{target_id}", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return {
            "from": [Association.from_dict(a) for a in payload.get("from", [])],
            "to": [Association.from_dict(a) for a in payload.get("to", [])],
        }

    async def traverse_associations(
        self,
        kind: str,
        target_id: int,
        max_depth: Optional[int] = None,
        max_nodes: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> AssociationGraph:
        body: dict[str, Any] = {"kind": kind, "id": target_id}
        if max_depth is not None:
            body["maxDepth"] = max_depth
        if max_nodes is not None:
            body["maxNodes"] = max_nodes
        payload = await self._request(
            "POST",
            "/v1/associations/traverse",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return AssociationGraph.from_dict(payload)

    async def remove_association(
        self,
        association_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> None:
        await self._request(
            "DELETE",
            f"/v1/associations/{association_id}",
            headers=_scope_headers(scope, self.default_scope),
        )

    async def capture_snapshot(
        self,
        session_id: str,
        relevance_query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SessionSnapshot:
        body: dict[str, Any] = {}
        if relevance_query is not None:
            body["relevanceQuery"] = relevance_query
        encoded = quote(session_id, safe="")
        payload = await self._request(
            "POST",
            f"/v1/sessions/{encoded}/snapshot",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SessionSnapshot.from_dict(payload["snapshot"])

    async def get_snapshot(
        self,
        session_id: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[SessionSnapshot]:
        encoded = quote(session_id, safe="")
        try:
            payload = await self._request(
                "GET",
                f"/v1/sessions/{encoded}/snapshot",
                headers=_scope_headers(scope, self.default_scope),
            )
        except MemoryLayerError as err:
            if err.status_code == 404:
                return None
            raise
        return SessionSnapshot.from_dict(payload["snapshot"])

    async def refresh_snapshot(
        self,
        session_id: str,
        relevance_query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SessionSnapshot:
        body: dict[str, Any] = {}
        if relevance_query is not None:
            body["relevanceQuery"] = relevance_query
        encoded = quote(session_id, safe="")
        payload = await self._request(
            "POST",
            f"/v1/sessions/{encoded}/refresh",
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SessionSnapshot.from_dict(payload["snapshot"])

    async def astream_events(
        self,
        *,
        event_types: Optional[list[str]] = None,
        scope_level: str = "scope",
        scope: Optional[MemoryScope] = None,
    ) -> AsyncIterator[MemoryEvent]:
        path = _event_stream_path(event_types, scope_level, scope, self.default_scope)
        headers = _scope_headers(scope, self.default_scope) or None
        async with self._client.stream("GET", path, headers=headers) as response:
            if response.is_error:
                raise MemoryLayerError(
                    f"memory-layer API error {response.status_code}: {response.text}",
                    status_code=response.status_code,
                )
            async for line in response.aiter_lines():
                event = _parse_sse_payload(line)
                if event is not None:
                    yield event

    async def astream_changes(
        self,
        *,
        cursor: Optional[str | int] = None,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> AsyncIterator[MemoryEventRecord]:
        params: dict[str, Any] = {
            "cursor": cursor,
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
        }
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        path = _append_query_params("/v1/changes/stream", params)
        headers = _scope_headers(scope, self.default_scope) or None
        async with self._client.stream("GET", path, headers=headers) as response:
            if response.is_error:
                raise MemoryLayerError(
                    f"memory-layer API error {response.status_code}: {response.text}",
                    status_code=response.status_code,
                )
            async for line in response.aiter_lines():
                event = _parse_change_sse_payload(line)
                if event is not None:
                    yield event

    async def poll_changes(
        self,
        since: str,
        scope_level: str = "scope",
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ChangeListResponse:
        params: dict[str, Any] = {"since": since, "scope_level": scope_level}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/changes", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ChangeListResponse.from_dict(payload)

    async def list_knowledge(
        self,
        limit: Optional[int] = None,
        cursor: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> KnowledgeListResponse:
        params: dict[str, Any] = {"limit": limit, "cursor": cursor}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/inspect/knowledge", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return KnowledgeListResponse.from_dict(payload)

    async def inspect_knowledge(
        self,
        knowledge_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> KnowledgeInspectionResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params(f"/v1/inspect/knowledge/{knowledge_id}", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return KnowledgeInspectionResponse.from_dict(payload)

    async def list_audits(
        self,
        knowledge_id: Optional[int] = None,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> AuditListResponse:
        params: dict[str, Any] = {"knowledge_id": knowledge_id, "limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/inspect/audits", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return AuditListResponse.from_dict(payload)

    async def inspect_monitor(self, *, scope: Optional[MemoryScope] = None) -> MonitorResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/inspect/monitor", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return MonitorResponse.from_dict(payload)

    async def inspect_compactions(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CompactionLogListResponse:
        params: dict[str, Any] = {"limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/inspect/compactions", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CompactionLogListResponse.from_dict(payload)

    async def inspect_reverification(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> DueReverificationResponse:
        params: dict[str, Any] = {"limit": limit}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request(
            "GET",
            _append_query_params("/v1/inspect/reverification", params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return DueReverificationResponse.from_dict(payload)

    async def reverify_knowledge(
        self,
        knowledge_id: int,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> TrustAssessmentResponse:
        payload = await self._request(
            "POST",
            f"/v1/reverification/{knowledge_id}",
            _merge_scope({}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return TrustAssessmentResponse.from_dict(payload)

    async def run_reverification(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> ReverificationResponse:
        payload = await self._request(
            "POST",
            "/v1/reverification/run",
            _merge_scope({"limit": limit}, scope, self.default_scope),
            admin=True,
            admin_key=admin_key,
            headers=_scope_headers(scope, self.default_scope),
        )
        return ReverificationResponse.from_dict(payload)
