import pytest

from memory_layer_client import AsyncMemoryClient, MemoryScope


def _scope() -> MemoryScope:
    return MemoryScope(
        tenant_id="acme",
        system_id="executor",
        scope_id="run-b",
        workspace_id="factory",
        collaboration_id="release-42",
    )


@pytest.mark.asyncio
async def test_async_client_supports_inspection_and_health(httpx_mock) -> None:
    scope = _scope()
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/inspect/knowledge?limit=20&tenant_id=acme&system_id=executor&scope_id=run-b&workspace_id=factory&collaboration_id=release-42",
        json={"items": [{"id": 9, "fact": "rollback"}], "hasMore": False, "nextCursor": None},
    )
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/inspect/reverification?limit=5&tenant_id=acme&system_id=executor&scope_id=run-b&workspace_id=factory&collaboration_id=release-42",
        json={"due": [{"id": 9, "fact": "rollback"}]},
    )
    httpx_mock.add_response(method="GET", url="http://test/healthz", json={"ok": True, "scopes": 2})

    client = AsyncMemoryClient("http://test", default_scope=scope)
    listing = await client.list_knowledge(limit=20)
    due = await client.inspect_reverification(limit=5)
    live = await client.live()
    await client.aclose()

    assert listing.items[0]["id"] == 9
    assert due.due[0]["fact"] == "rollback"
    assert live.ok is True
