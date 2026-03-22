import httpx

from memory_layer_client import MemoryClient, MemoryScope


def _scope() -> MemoryScope:
    return MemoryScope(
        tenant_id="acme",
        system_id="planner",
        scope_id="run-a",
        workspace_id="factory",
        collaboration_id="release-42",
    )


def test_store_turn_sends_scope_in_body_and_headers(httpx_mock) -> None:
    scope = _scope()

    def handler(request: httpx.Request) -> httpx.Response:
        payload = request.read().decode("utf-8")
        assert '"collaboration_id":"release-42"' in payload
        assert request.headers["x-memory-collaboration"] == "release-42"
        return httpx.Response(201, json={"turnId": 12, "role": "user"})

    httpx_mock.add_callback(handler, method="POST", url="http://test/v1/turns")

    client = MemoryClient("http://test", default_scope=scope)
    result = client.store_turn("user", "remember this")
    client.close()

    assert result.turn_id == 12


def test_cross_scope_search_and_inspection_methods(httpx_mock) -> None:
    scope = _scope()
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/search/cross-scope?q=rollback&scope_level=workspace&limit=5&tenant_id=acme&system_id=planner&scope_id=run-a&workspace_id=factory&collaboration_id=release-42",
        json={"turns": [], "knowledge": [{"id": 1, "fact": "rollback"}]},
    )
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/inspect/knowledge/1?tenant_id=acme&system_id=planner&scope_id=run-a&workspace_id=factory&collaboration_id=release-42",
        json={"knowledge": {"id": 1}, "evidence": [{"id": 2}], "audits": [{"id": 3}]},
    )
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/inspect/audits?knowledge_id=1&limit=10&tenant_id=acme&system_id=planner&scope_id=run-a&workspace_id=factory&collaboration_id=release-42",
        json={"audits": [{"id": 3}]},
    )

    client = MemoryClient("http://test", default_scope=scope)
    search = client.search_cross_scope("rollback", scope_level="workspace", limit=5)
    detail = client.inspect_knowledge(1)
    audits = client.list_audits(knowledge_id=1, limit=10)
    client.close()

    assert search.knowledge[0]["fact"] == "rollback"
    assert detail.evidence[0]["id"] == 2
    assert audits.audits[0]["id"] == 3


def test_change_and_reverification_methods(httpx_mock) -> None:
    scope = _scope()
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/changes?since=2026-03-01T00%3A00%3A00Z&scope_level=workspace&tenant_id=acme&system_id=planner&scope_id=run-a&workspace_id=factory&collaboration_id=release-42",
        json={"changes": [{"id": 5, "fact": "shared memory"}]},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://test/v1/reverification/run",
        json={"reverifiedKnowledgeIds": [1], "demotedKnowledgeIds": []},
    )
    httpx_mock.add_response(
        method="POST",
        url="http://test/v1/reverification/1",
        json={"trust_score": 0.95, "state": "trusted", "decision": "confirm", "reasons": ["support"]},
    )

    client = MemoryClient("http://test", default_scope=scope)
    changes = client.poll_changes("2026-03-01T00:00:00Z", scope_level="workspace")
    run = client.run_reverification(limit=5, admin_key="admin-secret")
    single = client.reverify_knowledge(1, admin_key="admin-secret")
    client.close()

    assert changes.changes[0]["fact"] == "shared memory"
    assert run.reverified_knowledge_ids == [1]
    assert single.state == "trusted"
