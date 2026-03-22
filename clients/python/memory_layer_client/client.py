"""REST clients for the memory-layer HTTP server."""

from __future__ import annotations

from typing import Any, Optional
from urllib.parse import urlencode

import httpx

from .models import (
    CompactResponse,
    ContextResponse,
    CreatedResource,
    HealthResponse,
    MaintenanceResponse,
    MemoryScope,
    ReadyResponse,
    SearchResponse,
    StoredExchange,
    StoredTurn,
)


class MemoryLayerError(RuntimeError):
    """Raised when the memory-layer service returns an error."""


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


def _append_query_params(path: str, params: dict[str, Any]) -> str:
    filtered = {key: value for key, value in params.items() if value is not None}
    if not filtered:
        return path
    return f"{path}?{urlencode(filtered)}"


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
    ) -> dict[str, Any]:
        headers = {}
        if admin and admin_key:
            headers["x-admin-key"] = admin_key
        response = self._client.request(method, path, json=body, headers=headers or None)
        if response.is_error:
            raise MemoryLayerError(
                f"memory-layer API error {response.status_code}: {response.text}"
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise MemoryLayerError("memory-layer API returned a non-object JSON payload")
        return payload

    def close(self) -> None:
        self._client.close()

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
        payload = self._request("POST", "/v1/turns", _merge_scope(body, scope, self.default_scope))
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
        )
        return StoredExchange.from_dict(payload)

    def get_context(
        self,
        query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ContextResponse:
        params = {"query": query}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request("GET", _append_query_params("/v1/context", params))
        return ContextResponse.from_dict(payload)

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
        payload = self._request("GET", _append_query_params("/v1/search", params))
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
    ) -> CreatedResource:
        body: dict[str, Any] = {"title": title, "kind": kind, "status": status}
        if detail:
            body["detail"] = detail
        payload = self._request("POST", "/v1/work", _merge_scope(body, scope, self.default_scope))
        return CreatedResource.from_key(payload, "workItemId")

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
        )
        return CompactResponse.from_dict(payload)

    def health(self, *, scope: Optional[MemoryScope] = None) -> HealthResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = self._request("GET", _append_query_params("/v1/health", params))
        return HealthResponse.from_dict(payload)

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
        )
        return MaintenanceResponse.from_dict(payload)

    def ready(self) -> ReadyResponse:
        payload = self._request("GET", "/readyz")
        return ReadyResponse.from_dict(payload)


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
    ) -> dict[str, Any]:
        headers = {}
        if admin and admin_key:
            headers["x-admin-key"] = admin_key
        response = await self._client.request(method, path, json=body, headers=headers or None)
        if response.is_error:
            raise MemoryLayerError(
                f"memory-layer API error {response.status_code}: {response.text}"
            )
        payload = response.json()
        if not isinstance(payload, dict):
            raise MemoryLayerError("memory-layer API returned a non-object JSON payload")
        return payload

    async def aclose(self) -> None:
        await self._client.aclose()

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
        )
        return StoredExchange.from_dict(payload)

    async def get_context(
        self,
        query: Optional[str] = None,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> ContextResponse:
        params = {"query": query}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request("GET", _append_query_params("/v1/context", params))
        return ContextResponse.from_dict(payload)

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
        payload = await self._request("GET", _append_query_params("/v1/search", params))
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
    ) -> CreatedResource:
        body: dict[str, Any] = {"title": title, "kind": kind, "status": status}
        if detail:
            body["detail"] = detail
        payload = await self._request(
            "POST",
            "/v1/work",
            _merge_scope(body, scope, self.default_scope),
        )
        return CreatedResource.from_key(payload, "workItemId")

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
        )
        return CompactResponse.from_dict(payload)

    async def health(self, *, scope: Optional[MemoryScope] = None) -> HealthResponse:
        params: dict[str, Any] = {}
        if scope or self.default_scope:
            params.update((scope or self.default_scope).to_dict())  # type: ignore[union-attr]
        payload = await self._request("GET", _append_query_params("/v1/health", params))
        return HealthResponse.from_dict(payload)

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
        )
        return MaintenanceResponse.from_dict(payload)

    async def ready(self) -> ReadyResponse:
        payload = await self._request("GET", "/readyz")
        return ReadyResponse.from_dict(payload)
