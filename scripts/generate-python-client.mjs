#!/usr/bin/env node
/**
 * generate-python-client.mjs — Phase 6.6b (PyGen)
 *
 * Emits the sync + async Python client methods for the memory-layer HTTP API
 * from a SINGLE shared template per operation, replacing the ~1400 lines that
 * were previously hand-duplicated between the sync and async halves of
 * clients/python/memory_layer_client/client.py.
 *
 * The operation registry (dist/server/operations/registry.js — the structural
 * source of truth built by Phase 6.3) DRIVES this generator:
 *
 *   * each method is joined to its registry operation by name; the HTTP method,
 *     the URL path, and the admin-auth flag are injected FROM the registry
 *     (never hand-typed here), so a path/method/auth change in the registry
 *     propagates into the client and cannot silently drift;
 *   * a completeness guard asserts, by construction, that every registry
 *     operation is either generated here, hand-kept in _base.py (the two SSE
 *     streams), or listed in UNEXPOSED with a reason — the same "routing can't
 *     exist without a registry entry" contract the server enforces.
 *
 * The per-method Python marshalling (parameter list, request-body / query
 * construction, response parsing) is authored ONCE below in `sync` form and
 * mechanically transformed to async (`async def`, `await self._request`). The
 * hand-written plumbing and non-uniform conveniences live in _base.py.
 *
 * Output: clients/python/memory_layer_client/_generated.py (DO-NOT-EDIT).
 * The generator is deterministic — regenerating on an unchanged registry
 * produces a byte-identical file (CI enforces this with git diff --exit-code).
 *
 * Usage: node scripts/generate-python-client.mjs
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { OPERATIONS } from '../dist/server/operations/registry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '../clients/python/memory_layer_client/_generated.py');

/**
 * Registry operations intentionally NOT exposed on the Python client. Listing
 * them here (rather than silently omitting them) makes the coverage guard
 * total: registry === generated ∪ handKept ∪ unexposed. Reasons are kept for
 * the next maintainer who wonders "why is there no python method for X?".
 */
const UNEXPOSED = {
  // Document ingestion / wiki surface — no Python bindings shipped yet.
  promoteResponse: 'document/wiki surface — no python binding shipped',
  ingestDocument: 'document/wiki surface — no python binding shipped',
  listDocuments: 'document/wiki surface — no python binding shipped',
  getDocument: 'document/wiki surface — no python binding shipped',
  exportMarkdown: 'document/wiki surface — non-JSON (markdown) response',
  lintKnowledge: 'document/wiki surface — no python binding shipped',
  requestContext: 'server-driven context request — no python binding shipped',
  // Context governance (admin) — no Python bindings shipped.
  getContextConfig: 'context governance (admin) — no python binding shipped',
  setDefaultContract: 'context governance (admin) — no python binding shipped',
  deleteDefaultContract: 'context governance (admin) — no python binding shipped',
  putContract: 'context governance (admin) — no python binding shipped',
  deleteContract: 'context governance (admin) — no python binding shipped',
  putInvariant: 'context governance (admin) — no python binding shipped',
  deleteInvariant: 'context governance (admin) — no python binding shipped',
  setEscalationPolicy: 'context governance (admin) — no python binding shipped',
  // Inspection endpoints without Python bindings.
  inspectContext: 'inspection endpoint — no python binding shipped',
  inspectSessionState: 'inspection endpoint — no python binding shipped',
  inspectRetrieval: 'inspection endpoint — no python binding shipped',
  // Playbook update (PUT) — the client exposes revise, not raw update.
  updatePlaybook: 'raw PUT — client exposes revise_playbook instead',
};

/**
 * Registry operations served by hand-written methods in _base.py because their
 * transport shape is not the uniform "one JSON request → one JSON envelope"
 * the generator emits (they hijack the response body as an SSE stream).
 */
const HAND_KEPT = {
  eventsStream: 'SSE stream — stream_events / astream_events in _base.py',
  streamChanges: 'SSE stream — stream_changes / astream_changes in _base.py',
};

/**
 * Method descriptors. Each entry:
 *   op        registry operation name (join key; drives method/path/admin)
 *   pathArgs  {registryParamName: pythonExpr} for path templates (optional)
 *   body      the Python method source in SYNC form, authored once, using the
 *             tokens %%METHOD%% (HTTP method literal), %%PATH%% (path
 *             expression), and %%ADMIN%% (admin kwargs line, admin ops only).
 *
 * Bodies are indented for placement directly inside a class body (4-space
 * `def`, 8-space statements). Async variants are derived mechanically.
 */
const METHODS = [
  {
    op: 'storeTurn',
    body: `    def store_turn(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return StoredTurn.from_dict(payload)`,
  },
  {
    op: 'storeExchange',
    body: `    def store_exchange(
        self,
        user_content: str,
        assistant_content: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> StoredExchange:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
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
        return StoredExchange.from_dict(payload)`,
  },
  {
    op: 'getContext',
    body: `    def get_context(
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
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ContextResponse.from_dict(payload)`,
  },
  {
    op: 'getStateAt',
    body: `    def get_state_at(
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
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalStateResponse.from_dict(payload)`,
  },
  {
    op: 'getTimeline',
    body: `    def get_timeline(
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
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalEventLogResponse.from_dict(payload)`,
  },
  {
    op: 'diffState',
    body: `    def diff_state(
        self,
        from_timestamp: int,
        to_timestamp: int,
        *,
        session_id: Optional[str] = None,
        entity_kind: Optional[str] = None,
        entity_id: Optional[str] = None,
        max_events: Optional[int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> TemporalDiffResponse:
        params: dict[str, Any] = {
            "from": from_timestamp,
            "to": to_timestamp,
            "session_id": session_id,
            "entity_kind": entity_kind,
            "entity_id": entity_id,
            "max_events": max_events,
        }
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalDiffResponse.from_dict(payload)`,
  },
  {
    op: 'listEvents',
    body: `    def list_memory_events(
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
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return TemporalEventLogResponse.from_dict(payload)`,
  },
  {
    op: 'search',
    body: `    def search(
        self,
        query: str,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": query, "limit": limit}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SearchResponse.from_dict(payload)`,
  },
  {
    op: 'searchCrossScope',
    body: `    def search_cross_scope(
        self,
        query: str,
        scope_level: str = "workspace",
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> SearchResponse:
        params: dict[str, Any] = {"q": query, "scope_level": scope_level, "limit": limit}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SearchResponse.from_dict(payload)`,
  },
  {
    op: 'learnFact',
    body: `    def learn_fact(
        self,
        fact: str,
        fact_type: str,
        confidence: str = "high",
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CreatedResource:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
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
        return CreatedResource.from_key(payload, "knowledgeId")`,
  },
  {
    op: 'trackWork',
    body: `    def track_work(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CreatedResource.from_key(payload, "workItemId")`,
  },
  {
    op: 'updateWorkItem',
    pathArgs: { id: 'work_item_id' },
    body: `    def update_work_item(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return dict(payload["workItem"])`,
  },
  {
    op: 'claimWorkItem',
    pathArgs: { id: 'work_item_id' },
    body: `    def claim_work_item(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return WorkClaim.from_dict(payload["claim"])`,
  },
  {
    op: 'renewWorkClaim',
    pathArgs: { id: 'claim_id' },
    body: `    def renew_work_claim(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        claim = payload.get("claim")
        return WorkClaim.from_dict(claim) if isinstance(claim, dict) else None`,
  },
  {
    op: 'releaseWorkClaim',
    pathArgs: { id: 'claim_id' },
    body: `    def release_work_claim(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        claim = payload.get("claim")
        return WorkClaim.from_dict(claim) if isinstance(claim, dict) else None`,
  },
  {
    op: 'listWorkClaims',
    body: `    def list_work_claims(self, *, scope: Optional[MemoryScope] = None) -> WorkClaimListResponse:
        params: dict[str, Any] = {}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return WorkClaimListResponse.from_dict(payload)`,
  },
  {
    op: 'handoffWorkItem',
    pathArgs: { id: 'work_item_id' },
    body: `    def handoff_work_item(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HandoffRecord.from_dict(payload["handoff"])`,
  },
  {
    op: 'acceptHandoff',
    pathArgs: { id: 'handoff_id' },
    body: `    def accept_handoff(
        self,
        handoff_id: int,
        actor: ActorRef,
        *,
        reason: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[HandoffRecord]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if reason is not None:
            body["reason"] = reason
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        handoff = payload.get("handoff")
        return HandoffRecord.from_dict(handoff) if isinstance(handoff, dict) else None`,
  },
  {
    op: 'rejectHandoff',
    pathArgs: { id: 'handoff_id' },
    body: `    def reject_handoff(
        self,
        handoff_id: int,
        actor: ActorRef,
        *,
        reason: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[HandoffRecord]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if reason is not None:
            body["reason"] = reason
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        handoff = payload.get("handoff")
        return HandoffRecord.from_dict(handoff) if isinstance(handoff, dict) else None`,
  },
  {
    op: 'cancelHandoff',
    pathArgs: { id: 'handoff_id' },
    body: `    def cancel_handoff(
        self,
        handoff_id: int,
        actor: ActorRef,
        *,
        reason: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[HandoffRecord]:
        body: dict[str, Any] = {"actor": _actor_to_dict(actor)}
        if reason is not None:
            body["reason"] = reason
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        handoff = payload.get("handoff")
        return HandoffRecord.from_dict(handoff) if isinstance(handoff, dict) else None`,
  },
  {
    op: 'listPendingHandoffs',
    body: `    def list_pending_handoffs(self, *, scope: Optional[MemoryScope] = None) -> HandoffListResponse:
        params: dict[str, Any] = {}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HandoffListResponse.from_dict(payload)`,
  },
  {
    op: 'forceCompact',
    body: `    def compact(
        self,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> CompactResponse:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope({}, scope, self.default_scope),
%%ADMIN%%
            headers=_scope_headers(scope, self.default_scope),
        )
        return CompactResponse.from_dict(payload)`,
  },
  {
    op: 'getHealth',
    body: `    def health(self, *, scope: Optional[MemoryScope] = None) -> HealthResponse:
        params: dict[str, Any] = {}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return HealthResponse.from_dict(payload)`,
  },
  {
    op: 'runMaintenance',
    body: `    def maintenance(
        self,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> MaintenanceResponse:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope({}, scope, self.default_scope),
%%ADMIN%%
            headers=_scope_headers(scope, self.default_scope),
        )
        return MaintenanceResponse.from_dict(payload)`,
  },
  {
    op: 'searchEpisodes',
    body: `    def search_episodes(
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
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return EpisodeSearchResponse.from_dict(payload)`,
  },
  {
    op: 'summarizeEpisode',
    body: `    def summarize_episode(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return EpisodeSummary.from_dict(payload["episode"])`,
  },
  {
    op: 'reflect',
    body: `    def reflect(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ReflectResult.from_dict(payload)`,
  },
  {
    op: 'searchCognitive',
    body: `    def search_cognitive(
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
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CognitiveSearchResult.from_dict(payload)`,
  },
  {
    op: 'getProfile',
    body: `    def get_profile(
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
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Profile.from_dict(payload["profile"])`,
  },
  {
    op: 'createPlaybook',
    body: `    def create_playbook(
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
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])`,
  },
  {
    op: 'listPlaybooks',
    body: `    def list_playbooks(
        self,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[Playbook]:
        params: dict[str, Any] = {}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [Playbook.from_dict(p) for p in payload.get("playbooks", [])]`,
  },
  {
    op: 'listPlaybooks',
    body: `    def search_playbooks(
        self,
        query: str,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[PlaybookSearchHit]:
        """Search playbooks by query. Returns ranked hits preserving rank and
        the full playbook payload including scope metadata."""
        params: dict[str, Any] = {"q": query, "limit": limit}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [PlaybookSearchHit.from_dict(p) for p in payload.get("playbooks", [])]`,
  },
  {
    op: 'getPlaybook',
    pathArgs: { playbookId: 'playbook_id' },
    body: `    def get_playbook(
        self,
        playbook_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        """Fetch a playbook by id. Raises MemoryLayerError on 404."""
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])`,
  },
  {
    op: 'revisePlaybook',
    pathArgs: { playbookId: 'playbook_id' },
    body: `    def revise_playbook(
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
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return RevisePlaybookResult.from_dict(payload)`,
  },
  {
    op: 'usePlaybook',
    pathArgs: { playbookId: 'playbook_id' },
    body: `    def record_playbook_use(
        self,
        playbook_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Playbook:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])`,
  },
  {
    op: 'createPlaybookFromTask',
    body: `    def create_playbook_from_task(
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
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Playbook.from_dict(payload["playbook"])`,
  },
  {
    op: 'addAssociation',
    body: `    def add_association(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return Association.from_dict(payload["association"])`,
  },
  {
    op: 'getAssociations',
    pathArgs: { kind: 'kind', id: 'target_id' },
    body: `    def get_associations(
        self,
        kind: str,
        target_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> dict[str, list[Association]]:
        params: dict[str, Any] = {}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return {
            "from": [Association.from_dict(a) for a in payload.get("from", [])],
            "to": [Association.from_dict(a) for a in payload.get("to", [])],
        }`,
  },
  {
    op: 'traverseAssociations',
    body: `    def traverse_associations(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return AssociationGraph.from_dict(payload)`,
  },
  {
    op: 'removeAssociation',
    pathArgs: { id: 'association_id' },
    body: `    def remove_association(
        self,
        association_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> None:
        self._request(
            %%METHOD%%,
            %%PATH%%,
            headers=_scope_headers(scope, self.default_scope),
        )`,
  },
  {
    op: 'captureSnapshot',
    pathArgs: { id: 'encoded' },
    body: `    def capture_snapshot(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SessionSnapshot.from_dict(payload["snapshot"])`,
  },
  {
    op: 'getSnapshot',
    pathArgs: { id: 'encoded' },
    body: `    def get_snapshot(
        self,
        session_id: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[SessionSnapshot]:
        encoded = quote(session_id, safe="")
        try:
            payload = self._request(
                %%METHOD%%,
                %%PATH%%,
                headers=_scope_headers(scope, self.default_scope),
            )
        except MemoryLayerError as err:
            if err.status_code == 404:
                return None
            raise
        return SessionSnapshot.from_dict(payload["snapshot"])`,
  },
  {
    op: 'refreshSnapshot',
    pathArgs: { id: 'encoded' },
    body: `    def refresh_snapshot(
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
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return SessionSnapshot.from_dict(payload["snapshot"])`,
  },
  {
    op: 'listChanges',
    body: `    def poll_changes(
        self,
        since: Optional[str] = None,
        scope_level: str = "scope",
        *,
        cursor: Optional[str | int] = None,
        scope: Optional[MemoryScope] = None,
    ) -> ChangeListResponse:
        params: dict[str, Any] = {"since": since, "cursor": cursor, "scope_level": scope_level}
        resolved_scope = scope or self.default_scope
        if resolved_scope:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ChangeListResponse.from_dict(payload)`,
  },
  {
    op: 'inspectKnowledgeList',
    body: `    def list_knowledge(
        self,
        limit: Optional[int] = None,
        cursor: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> KnowledgeListResponse:
        params: dict[str, Any] = {"limit": limit, "cursor": cursor}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return KnowledgeListResponse.from_dict(payload)`,
  },
  {
    op: 'inspectKnowledgeItem',
    pathArgs: { knowledgeId: 'knowledge_id' },
    body: `    def inspect_knowledge(
        self,
        knowledge_id: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> KnowledgeInspectionResponse:
        params: dict[str, Any] = {}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return KnowledgeInspectionResponse.from_dict(payload)`,
  },
  {
    op: 'inspectAudits',
    body: `    def list_audits(
        self,
        knowledge_id: Optional[int] = None,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> AuditListResponse:
        params: dict[str, Any] = {"knowledge_id": knowledge_id, "limit": limit}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return AuditListResponse.from_dict(payload)`,
  },
  {
    op: 'inspectMonitor',
    body: `    def inspect_monitor(self, *, scope: Optional[MemoryScope] = None) -> MonitorResponse:
        params: dict[str, Any] = {}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return MonitorResponse.from_dict(payload)`,
  },
  {
    op: 'inspectCompactions',
    body: `    def inspect_compactions(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CompactionLogListResponse:
        params: dict[str, Any] = {"limit": limit}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CompactionLogListResponse.from_dict(payload)`,
  },
  {
    op: 'inspectReverification',
    body: `    def inspect_reverification(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> DueReverificationResponse:
        params: dict[str, Any] = {"limit": limit}
        resolved_scope = _resolve_scope(scope, self.default_scope)
        if resolved_scope is not None:
            params.update(resolved_scope.to_dict())
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return DueReverificationResponse.from_dict(payload)`,
  },
  {
    op: 'reverifyKnowledgeItem',
    pathArgs: { knowledgeId: 'knowledge_id' },
    body: `    def reverify_knowledge(
        self,
        knowledge_id: int,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> TrustAssessmentResponse:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope({}, scope, self.default_scope),
%%ADMIN%%
            headers=_scope_headers(scope, self.default_scope),
        )
        return TrustAssessmentResponse.from_dict(payload)`,
  },
  {
    op: 'reverifyKnowledge',
    body: `    def run_reverification(
        self,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
        admin_key: Optional[str] = None,
    ) -> ReverificationResponse:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope({"limit": limit}, scope, self.default_scope),
%%ADMIN%%
            headers=_scope_headers(scope, self.default_scope),
        )
        return ReverificationResponse.from_dict(payload)`,
  },
  {
    op: 'discover',
    body: `    def discover(
        self,
        max_results: Optional[int] = None,
        min_surprise_score: Optional[float] = None,
        max_depth: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> DiscoveryReport:
        params: dict[str, Any] = {"max_results": max_results, "min_score": min_surprise_score, "max_depth": max_depth}
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return DiscoveryReport.from_dict(payload)`,
  },
  {
    op: 'getReport',
    body: `    def get_report(
        self,
        token_budget: Optional[int] = None,
        include_sections: Optional[list[str]] = None,
        filter_by_tags: Optional[list[str]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> GraphReport:
        params: dict[str, Any] = {"token_budget": token_budget}
        if include_sections:
            params["sections"] = ",".join(include_sections)
        if filter_by_tags:
            params["tags"] = ",".join(filter_by_tags)
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return GraphReport.from_dict(payload)`,
  },
  {
    op: 'getFactsAt',
    body: `    def get_facts_at(
        self,
        timestamp: int,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> FactsAtResult:
        params: dict[str, Any] = {"timestamp": timestamp}
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return FactsAtResult.from_dict(payload)`,
  },
  {
    op: 'reflectKnowledge',
    body: `    def reflect_on_knowledge(
        self,
        max_facts: Optional[int] = None,
        include_playbooks: Optional[bool] = None,
        rate_limit_key: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> KnowledgeReflectionResult:
        body: dict[str, Any] = {}
        if max_facts is not None:
            body["maxFacts"] = max_facts
        if include_playbooks is not None:
            body["includePlaybooks"] = include_playbooks
        if rate_limit_key is not None:
            body["rateLimitKey"] = rate_limit_key
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return KnowledgeReflectionResult.from_dict(payload)`,
  },
  {
    op: 'derive',
    body: `    def derive(
        self,
        output_types: Optional[list[str]] = None,
        max_outputs: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[DerivedOutput]:
        body: dict[str, Any] = {}
        if output_types is not None:
            body["outputTypes"] = output_types
        if max_outputs is not None:
            body["maxOutputs"] = max_outputs
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [DerivedOutput.from_dict(o) for o in payload.get("outputs", [])]`,
  },
  {
    op: 'getCuration',
    body: `    def get_curation_summary(
        self,
        since: Optional[int] = None,
        action_types: Optional[list[str]] = None,
        limit: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CurationSummary:
        params: dict[str, Any] = {"since": since, "limit": limit}
        if action_types:
            params["action_types"] = ",".join(action_types)
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CurationSummary.from_dict(payload)`,
  },
  {
    op: 'getCoreMemory',
    body: `    def get_core_memory(
        self,
        token_budget: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> CoreMemoryBundle:
        params: dict[str, Any] = {"token_budget": token_budget}
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return CoreMemoryBundle.from_dict(payload)`,
  },
  {
    op: 'setAliases',
    body: `    def set_aliases(
        self,
        alias_map: dict[str, list[str]],
        *,
        scope: Optional[MemoryScope] = None,
    ) -> None:
        self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope({"aliasMap": alias_map}, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )`,
  },
  {
    op: 'getAliases',
    body: `    def get_aliases(
        self,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> dict[str, list[str]]:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            headers=_scope_headers(scope, self.default_scope),
        )
        return dict(payload.get("aliasMap", {}))`,
  },
  {
    op: 'getAliasCandidates',
    body: `    def get_alias_candidates(
        self,
        min_similarity: Optional[float] = None,
        max_candidates: Optional[int] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> list[AliasCandidate]:
        params: dict[str, Any] = {"min_similarity": min_similarity, "max_candidates": max_candidates}
        payload = self._request(
            %%METHOD%%,
            _append_query_params(%%PATH%%, params),
            headers=_scope_headers(scope, self.default_scope),
        )
        return [AliasCandidate.from_dict(c) for c in payload.get("candidates", [])]`,
  },
  {
    op: 'setOntology',
    body: `    def set_ontology(
        self,
        ontology: dict[str, Any],
        *,
        scope: Optional[MemoryScope] = None,
    ) -> None:
        self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope({"ontology": ontology}, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )`,
  },
  {
    op: 'getOntology',
    body: `    def get_ontology(
        self,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> Optional[dict[str, Any]]:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            headers=_scope_headers(scope, self.default_scope),
        )
        return payload.get("ontology")`,
  },
  {
    op: 'exportBundle',
    body: `    def export_bundle(
        self,
        name: str,
        include_tags: Optional[list[str]] = None,
        knowledge_class_filter: Optional[list[str]] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ExportBundleResult:
        body: dict[str, Any] = {"name": name}
        if include_tags is not None:
            body["includeTags"] = include_tags
        if knowledge_class_filter is not None:
            body["knowledgeClassFilter"] = knowledge_class_filter
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(body, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ExportBundleResult.from_dict(payload)`,
  },
  {
    op: 'importBundle',
    body: `    def import_bundle(
        self,
        bundle: dict[str, Any],
        conflict_resolution: str = "skip",
        preserve_trust: bool = False,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ImportBundleResult:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope(
                {"bundle": bundle, "conflictResolution": conflict_resolution, "preserveTrust": preserve_trust},
                scope,
                self.default_scope,
            ),
            headers=_scope_headers(scope, self.default_scope),
        )
        return ImportBundleResult.from_dict(payload)`,
  },
  {
    op: 'refreshDocuments',
    body: `    def refresh_documents(
        self,
        documents: list[dict[str, Any]],
        *,
        scope: Optional[MemoryScope] = None,
    ) -> RefreshResult:
        payload = self._request(
            %%METHOD%%,
            %%PATH%%,
            _merge_scope({"documents": documents}, scope, self.default_scope),
            headers=_scope_headers(scope, self.default_scope),
        )
        return RefreshResult.from_dict(payload)`,
  },
];

// --------------------------------------------------------------------------
// Generation
// --------------------------------------------------------------------------

const opByName = new Map(OPERATIONS.map((op) => [op.name, op]));

/** Build the Python path expression for an operation, from the registry path. */
function pathExpression(op, pathArgs) {
  const raw = op.http.path;
  if (!raw.includes('{')) {
    return JSON.stringify(raw); // plain double-quoted string literal
  }
  const filled = raw.replace(/\{([^}]+)\}/g, (_full, inner) => {
    const name = inner.split(':')[0];
    const expr = pathArgs && pathArgs[name];
    if (!expr) {
      throw new Error(`generate-python-client: missing pathArgs["${name}"] for op ${op.name} (path ${raw})`);
    }
    return `{${expr}}`;
  });
  if (filled.includes('"')) {
    // Python < 3.12 forbids backslashes/quotes inside f-string expressions;
    // path arg expressions must resolve to a pre-computed local (e.g. `encoded`).
    throw new Error(`generate-python-client: f-string path for ${op.name} contains a quote: ${filled}`);
  }
  return `f"${filled}"`;
}

function renderMethod(desc, variant) {
  const op = opByName.get(desc.op);
  if (!op) {
    throw new Error(`generate-python-client: descriptor references unknown op "${desc.op}"`);
  }
  const isAdmin = op.auth === 'admin';
  const hasAdminToken = desc.body.includes('%%ADMIN%%');
  if (isAdmin !== hasAdminToken) {
    throw new Error(
      `generate-python-client: admin mismatch for ${desc.op} — registry auth=${op.auth} but body ${
        hasAdminToken ? 'has' : 'lacks'
      } %%ADMIN%% token`,
    );
  }

  const methodLiteral = JSON.stringify(op.http.method);
  const pathExpr = pathExpression(op, desc.pathArgs);

  const outLines = [];
  for (const line of desc.body.split('\n')) {
    if (line.trim() === '%%ADMIN%%') {
      if (isAdmin) {
        outLines.push('            admin=True,');
        outLines.push('            admin_key=admin_key,');
      }
      continue; // drop the token line entirely for non-admin ops
    }
    outLines.push(line.replace('%%METHOD%%', methodLiteral).replace('%%PATH%%', pathExpr));
  }
  let text = outLines.join('\n');

  if (variant === 'async') {
    text = text.replace('    def ', '    async def ');
    text = text.replace(/self\._request\(/g, 'await self._request(');
  }
  return text;
}

function renderClass(className, baseName, docstring, variant) {
  const parts = [`class ${className}(${baseName}):`, `    """${docstring}"""`, ''];
  const rendered = METHODS.map((desc) => renderMethod(desc, variant));
  parts.push(rendered.join('\n\n'));
  return parts.join('\n');
}

// --- coverage / completeness guard (by construction) ---------------------
const generatedOps = new Set(METHODS.map((d) => d.op));
const handKeptOps = new Set(Object.keys(HAND_KEPT));
const unexposedOps = new Set(Object.keys(UNEXPOSED));

const problems = [];
for (const name of [...generatedOps, ...handKeptOps, ...unexposedOps]) {
  if (!opByName.has(name)) {
    problems.push(`referenced op "${name}" is not in the registry`);
  }
}
for (const op of OPERATIONS) {
  const covered =
    generatedOps.has(op.name) || handKeptOps.has(op.name) || unexposedOps.has(op.name);
  if (!covered) {
    problems.push(`registry op "${op.name}" (${op.http.method} ${op.http.path}) is neither generated, hand-kept, nor listed UNEXPOSED`);
  }
}
for (const name of generatedOps) {
  if (handKeptOps.has(name) || unexposedOps.has(name)) {
    problems.push(`op "${name}" is generated AND also listed hand-kept/unexposed`);
  }
}
if (problems.length > 0) {
  console.error('generate-python-client: registry coverage guard failed:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// --- emit -----------------------------------------------------------------
const header = `# @generated by scripts/generate-python-client.mjs — DO NOT EDIT.
#
# The sync + async request methods below are emitted from the operation
# registry (src/server/operations/registry.ts, via the built dist module) by
# scripts/generate-python-client.mjs. Each method's HTTP verb, URL path, and
# admin-auth flag come directly from that registry, so they cannot drift from
# the server's transport surface. To change a method, edit the generator (its
# METHODS table) or the registry, then run:  node scripts/generate-python-client.mjs
#
# Hand-written plumbing and the non-uniform conveniences (health probes, SSE
# streams) live in _base.py; this file only holds the mechanically generated
# request/response methods.
"""Generated typed REST client methods for the memory-layer HTTP API."""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import quote

from ._base import (
    MemoryLayerError,
    _AsyncClientBase,
    _SyncClientBase,
    _actor_to_dict,
    _append_query_params,
    _merge_scope,
    _resolve_scope,
    _scope_headers,
    _viewer_query_params,
)
from .models import (
    ActorRef,
    AliasCandidate,
    Association,
    AssociationGraph,
    AuditListResponse,
    ChangeListResponse,
    CognitiveSearchResult,
    CompactResponse,
    CompactionLogListResponse,
    ContextResponse,
    CoreMemoryBundle,
    CreatedResource,
    CurationSummary,
    DerivedOutput,
    DiscoveryReport,
    DueReverificationResponse,
    EpisodeSearchResponse,
    EpisodeSummary,
    ExportBundleResult,
    FactsAtResult,
    GraphReport,
    HandoffListResponse,
    HandoffRecord,
    HealthResponse,
    ImportBundleResult,
    KnowledgeInspectionResponse,
    KnowledgeListResponse,
    KnowledgeReflectionResult,
    MaintenanceResponse,
    MemoryScope,
    MonitorResponse,
    Playbook,
    PlaybookSearchHit,
    Profile,
    ReflectResult,
    RefreshResult,
    ReverificationResponse,
    RevisePlaybookResult,
    SearchResponse,
    SessionSnapshot,
    StoredExchange,
    StoredTurn,
    TemporalDiffResponse,
    TemporalEventLogResponse,
    TemporalStateResponse,
    TrustAssessmentResponse,
    WorkClaim,
    WorkClaimListResponse,
)

__all__ = ["MemoryClient", "AsyncMemoryClient"]

`;

const syncClass = renderClass(
  'MemoryClient',
  '_SyncClientBase',
  'Typed synchronous client for the memory-layer HTTP API.',
  'sync',
);
const asyncClass = renderClass(
  'AsyncMemoryClient',
  '_AsyncClientBase',
  'Typed asynchronous client for the memory-layer HTTP API.',
  'async',
);

const output = `${header}${syncClass}\n\n\n${asyncClass}\n`;
writeFileSync(OUTPUT, output);

const total = OPERATIONS.length;
console.log(
  `generate-python-client: wrote ${OUTPUT}\n` +
    `  ${METHODS.length} generated methods across ${generatedOps.size} registry ops` +
    ` (+${handKeptOps.size} hand-kept, ${unexposedOps.size} unexposed) of ${total} total registry ops.`,
);
