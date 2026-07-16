"""Hand-written base + shared plumbing for the memory-layer REST clients.

This module holds everything that is *not* mechanically derivable from the
operation registry:

  * the module-level request/scope helper functions,
  * the ``MemoryLayerError`` exception,
  * the sync/async client *base classes* (constructor, transport, lifecycle),
  * the hand-kept convenience methods that do not fit the registry's uniform
    request/response shape — the unauthenticated health probes (``live`` /
    ``ready``, served before the server's auth+routing gate, so not registry
    operations) and the two SSE streaming readers (``stream_events`` /
    ``stream_changes`` and their async twins), which hijack the response body
    instead of decoding a single JSON envelope.

The bulk of the API surface — every uniform "build request → decode JSON
envelope → parse model" operation — lives in the generated ``_generated``
module, whose ``MemoryClient`` / ``AsyncMemoryClient`` subclass the bases
defined here. See ``scripts/generate-python-client.mjs``.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator, Iterator
from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from .models import (
    ActorRef,
    MemoryEvent,
    MemoryEventRecord,
    MemoryScope,
    ReadyResponse,
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
    if parsed.get("type") == "connected":
        return None
    if parsed.get("type") == "error":
        raise MemoryLayerError(
            f"memory-layer event stream returned an error frame: {parsed.get('error', 'unknown error')}"
        )
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


class _SyncClientBase:
    """Transport, lifecycle, and hand-kept conveniences for :class:`MemoryClient`.

    The generated request methods live on the :class:`MemoryClient` subclass in
    the ``_generated`` module; this base owns everything that is not registry
    derived.
    """

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

    def __enter__(self) -> "_SyncClientBase":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        self.close()

    # --- hand-kept conveniences (not registry operations) ---

    def live(self) -> ReadyResponse:
        payload = self._request("GET", "/healthz")
        return ReadyResponse.from_dict(payload)

    def ready(self) -> ReadyResponse:
        payload = self._request("GET", "/readyz")
        return ReadyResponse.from_dict(payload)

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
        resolved_scope = scope or self.default_scope
        if resolved_scope:
            params.update(resolved_scope.to_dict())
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


class _AsyncClientBase:
    """Async transport, lifecycle, and hand-kept conveniences for
    :class:`AsyncMemoryClient`."""

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

    async def __aenter__(self) -> "_AsyncClientBase":
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> None:
        await self.aclose()

    # --- hand-kept conveniences (not registry operations) ---

    async def live(self) -> ReadyResponse:
        payload = await self._request("GET", "/healthz")
        return ReadyResponse.from_dict(payload)

    async def ready(self) -> ReadyResponse:
        payload = await self._request("GET", "/readyz")
        return ReadyResponse.from_dict(payload)

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
        resolved_scope = scope or self.default_scope
        if resolved_scope:
            params.update(resolved_scope.to_dict())
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
