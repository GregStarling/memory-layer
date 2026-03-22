"""REST client for the memory-layer HTTP server."""

from __future__ import annotations

import json
from typing import Any, Optional
from urllib.request import Request, urlopen
from urllib.error import HTTPError


class MemoryClient:
    """Thin REST client for the memory-layer HTTP server.

    Usage::

        from memory_layer_client import MemoryClient

        client = MemoryClient("http://localhost:3100")
        client.store_exchange("Hello!", "Hi there!")
        context = client.get_context(query="greeting")
        print(context)
    """

    def __init__(self, base_url: str, api_key: Optional[str] = None):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body else None
        req = Request(url, data=data, headers=self._headers(), method=method)
        try:
            with urlopen(req) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except HTTPError as e:
            error_body = e.read().decode("utf-8") if e.fp else ""
            raise RuntimeError(
                f"memory-layer API error {e.code}: {error_body}"
            ) from e

    def store_turn(
        self,
        role: str,
        content: str,
        actor: Optional[str] = None,
    ) -> dict:
        """Store a single conversation turn."""
        body: dict[str, Any] = {"role": role, "content": content}
        if actor:
            body["actor"] = actor
        return self._request("POST", "/v1/turns", body)

    def store_exchange(
        self,
        user_content: str,
        assistant_content: str,
    ) -> dict:
        """Store a user+assistant exchange atomically."""
        return self._request("POST", "/v1/exchanges", {
            "userContent": user_content,
            "assistantContent": assistant_content,
        })

    def get_context(self, query: Optional[str] = None) -> dict:
        """Retrieve assembled memory context."""
        path = "/v1/context"
        if query:
            from urllib.parse import quote
            path += f"?query={quote(query)}"
        return self._request("GET", path)

    def search(self, query: str, limit: Optional[int] = None) -> dict:
        """Search turns and knowledge."""
        from urllib.parse import quote
        path = f"/v1/search?q={quote(query)}"
        if limit:
            path += f"&limit={limit}"
        return self._request("GET", path)

    def learn_fact(
        self,
        fact: str,
        fact_type: str,
        confidence: str = "high",
    ) -> dict:
        """Manually add a durable knowledge fact."""
        return self._request("POST", "/v1/facts", {
            "fact": fact,
            "factType": fact_type,
            "confidence": confidence,
        })

    def track_work(
        self,
        title: str,
        kind: str = "objective",
        status: str = "open",
        detail: Optional[str] = None,
    ) -> dict:
        """Track an objective or work item."""
        body: dict[str, Any] = {"title": title, "kind": kind, "status": status}
        if detail:
            body["detail"] = detail
        return self._request("POST", "/v1/work", body)

    def compact(self) -> dict:
        """Force compaction of conversation history."""
        return self._request("POST", "/v1/compact")

    def health(self) -> dict:
        """Get memory health report."""
        return self._request("GET", "/v1/health")

    def maintenance(self) -> dict:
        """Run maintenance to clean up stale data."""
        return self._request("POST", "/v1/maintenance")
