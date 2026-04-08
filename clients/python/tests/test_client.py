import httpx

from memory_layer_client import ActorRef, MemoryClient, MemoryScope


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
        json={"changes": [{"id": 5, "fact": "shared memory"}], "nextCursor": "17"},
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
    assert changes.next_cursor == "17"
    assert run.reverified_knowledge_ids == [1]
    assert single.state == "trusted"


def test_sync_client_can_stream_events(httpx_mock) -> None:
    scope = _scope()
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/events?event_types=knowledge_change%2Ccapability&scope_level=workspace&tenant_id=acme&system_id=planner&scope_id=run-a&workspace_id=factory&collaboration_id=release-42",
        text='data: {"type":"connected"}\n\ndata: {"type":"knowledge_change","scope":{"tenant_id":"acme"},"timestamp":1,"durationMs":0,"meta":{"action":"promote"}}\n\n',
        headers={"content-type": "text/event-stream"},
    )

    with MemoryClient("http://test", default_scope=scope) as client:
        events = list(
            client.stream_events(
                event_types=["knowledge_change", "capability"],
                scope_level="workspace",
            )
        )

    assert events[0].type == "knowledge_change"
    assert events[0].meta["action"] == "promote"


def test_sync_client_can_poll_changes_by_cursor(httpx_mock) -> None:
    scope = _scope()
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/changes?cursor=17&scope_level=workspace&tenant_id=acme&system_id=planner&scope_id=run-a&workspace_id=factory&collaboration_id=release-42",
        json={
            "changes": [
                {
                    "event_id": "18",
                    "event_type": "knowledge.retired",
                    "id": 5,
                    "fact": "shared memory",
                    "retired_at": 42,
                }
            ],
            "nextCursor": "18",
        },
    )

    with MemoryClient("http://test", default_scope=scope) as client:
        changes = client.poll_changes(cursor=17, scope_level="workspace")

    assert changes.changes[0]["event_type"] == "knowledge.retired"
    assert changes.next_cursor == "18"


def test_sync_client_supports_coordination_endpoints(httpx_mock) -> None:
    scope = _scope()
    actor = ActorRef(actor_kind="agent", actor_id="planner", system_id=None, display_name=None, metadata=None)
    other = ActorRef(actor_kind="human", actor_id="operator", system_id=None, display_name="Op", metadata=None)

    httpx_mock.add_response(
        method="POST",
        url="http://test/v1/work-items/12/claim",
        json={
            "claim": {
                "id": 1,
                "work_item_id": 12,
                "actor": {"actor_kind": "agent", "actor_id": "planner"},
                "session_id": None,
                "claim_token": "claim-1",
                "status": "active",
                "claimed_at": 1,
                "expires_at": 301,
                "released_at": None,
                "release_reason": None,
                "source_event_id": 9,
                "visibility_class": "workspace",
                "version": 1,
            }
        },
    )
    httpx_mock.add_response(
        method="POST",
        url="http://test/v1/work-items/12/handoffs",
        json={
            "handoff": {
                "id": 2,
                "work_item_id": 12,
                "from_actor": {"actor_kind": "agent", "actor_id": "planner"},
                "to_actor": {"actor_kind": "human", "actor_id": "operator", "display_name": "Op"},
                "session_id": None,
                "summary": "Take over deploy watch",
                "context_bundle_ref": "watermark:9",
                "status": "pending",
                "created_at": 2,
                "accepted_at": None,
                "rejected_at": None,
                "canceled_at": None,
                "expires_at": None,
                "decision_reason": None,
                "source_event_id": 10,
                "visibility_class": "workspace",
                "version": 1,
            }
        },
    )
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/changes/stream?cursor=5&tenant_id=acme&system_id=planner&scope_id=run-a&workspace_id=factory&collaboration_id=release-42",
        text='data: {"type":"connected","cursor":5}\n\ndata: {"event_id":6,"entity_kind":"work_claim","entity_id":"1","event_type":"work_claim.claimed","payload":{},"created_at":3}\n\n',
        headers={"content-type": "text/event-stream"},
    )

    with MemoryClient("http://test", default_scope=scope) as client:
        claim = client.claim_work_item(12, actor, lease_seconds=300)
        handoff = client.handoff_work_item(12, actor, other, "Take over deploy watch", context_bundle_ref="watermark:9")
        changes = list(client.stream_changes(cursor=5))

    assert claim.actor.actor_id == "planner"
    assert handoff.to_actor.actor_id == "operator"
    assert changes[0].event_type == "work_claim.claimed"
