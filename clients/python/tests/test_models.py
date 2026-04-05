from memory_layer_client.models import (
    ChangeListResponse,
    CoordinationState,
    ContextResponse,
    HandoffListResponse,
    KnowledgeInspectionResponse,
    KnowledgeListResponse,
    MaintenanceResponse,
    MemoryEventRecord,
    MemoryScope,
    ReverificationResponse,
    TemporalEventLogResponse,
    TemporalStateResponse,
    TrustAssessmentResponse,
    WorkClaimListResponse,
)


def test_memory_scope_includes_collaboration_headers() -> None:
    scope = MemoryScope(
        tenant_id="acme",
        system_id="planner",
        scope_id="run-a",
        workspace_id="factory",
        collaboration_id="release-42",
    )

    assert scope.to_dict()["collaboration_id"] == "release-42"
    assert scope.to_headers()["x-memory-collaboration"] == "release-42"


def test_inspection_models_parse_expected_payloads() -> None:
    listing = KnowledgeListResponse.from_dict(
        {"items": [{"id": 1, "fact": "rollback"}], "hasMore": True, "nextCursor": 10}
    )
    detail = KnowledgeInspectionResponse.from_dict(
        {"knowledge": {"id": 1}, "evidence": [{"id": 2}], "audits": [{"id": 3}]}
    )
    changes = ChangeListResponse.from_dict({"changes": [{"id": 4, "fact": "shared"}]})
    reverification = ReverificationResponse.from_dict(
        {"reverifiedKnowledgeIds": [1, 2], "demotedKnowledgeIds": [3]}
    )
    assessment = TrustAssessmentResponse.from_dict(
        {"trust_score": 0.9, "state": "trusted", "decision": "confirm", "reasons": ["support"]}
    )
    maintenance = MaintenanceResponse.from_dict(
        {
            "expiredWorkingMemory": 1,
            "retiredKnowledge": 2,
            "deletedWorkItems": 3,
            "deletedAssociationIds": [4, 5],
        }
    )

    assert listing.next_cursor == 10
    assert detail.evidence[0]["id"] == 2
    assert changes.changes[0]["fact"] == "shared"
    assert reverification.demoted_knowledge_ids == [3]
    assert assessment.state == "trusted"
    assert maintenance.deleted_association_ids == [4, 5]


def test_context_response_normalizes_unresolved_work_strings_and_legacy_objects() -> None:
    context = ContextResponse.from_dict(
        {
            "currentObjective": "Ship rollout",
            "sessionState": {
                "currentObjective": "Ship rollout",
                "blockers": ["Document rollback"],
                "assumptions": ["Assume staging is current"],
                "pendingDecisions": ["Choose rollback owner"],
                "activeTools": ["deploy-bot"],
                "recentOutputs": ["Rollback dry run succeeded"],
                "updatedAt": 123,
            },
            "activeTurnCount": 1,
            "workingMemory": None,
            "relevantKnowledge": [],
            "activeObjectives": [],
            "unresolvedWork": [
                "Document rollback checklist",
                {"title": "Confirm staging smoke tests"},
                {"title": ""},
                {"detail": "ignored"},
                123,
            ],
            "coordinationState": {
                "ownedClaims": [
                    {
                        "id": 8,
                        "work_item_id": 99,
                        "actor": {"actor_kind": "agent", "actor_id": "planner"},
                        "session_id": "sess-1",
                        "claim_token": "claim-1",
                        "status": "active",
                        "claimed_at": 123,
                        "expires_at": 456,
                        "released_at": None,
                        "release_reason": None,
                        "source_event_id": 77,
                        "visibility_class": "workspace",
                        "version": 2,
                    }
                ],
                "pendingInboundHandoffs": [],
                "pendingOutboundHandoffs": [],
                "sharedWorkItems": [{"id": 99, "title": "Coordinate rollout"}],
            },
            "tokenEstimate": 12,
        }
    )

    assert context.unresolved_work == [
        "Document rollback checklist",
        "Confirm staging smoke tests",
    ]
    assert context.session_state is not None
    assert context.session_state["blockers"] == ["Document rollback"]
    assert context.coordination_state is not None
    assert context.coordination_state.owned_claims[0].actor.actor_id == "planner"


def test_temporal_and_coordination_models_parse_expected_payloads() -> None:
    events = TemporalEventLogResponse.from_dict(
        {
            "events": [
                {
                    "event_id": 10,
                    "entity_kind": "work_claim",
                    "entity_id": "8",
                    "event_type": "work_claim.claimed",
                    "payload": {"after": {"id": 8}},
                    "created_at": 123,
                }
            ],
            "nextCursor": 10,
        }
    )
    state = TemporalStateResponse.from_dict(
        {
            "asOf": 123,
            "exact": True,
            "cutoverAt": 100,
            "watermarkEventId": 10,
            "context": {
                "currentObjective": None,
                "sessionState": None,
                "activeTurnCount": 0,
                "workingMemory": None,
                "relevantKnowledge": [],
                "activeObjectives": [],
                "unresolvedWork": [],
                "tokenEstimate": 0,
            },
            "sessionState": None,
            "turns": [],
            "workingMemory": [],
            "knowledge": [],
            "workItems": [],
            "associations": [],
            "playbooks": [],
            "workClaims": [
                {
                    "id": 8,
                    "work_item_id": 99,
                    "actor": {"actor_kind": "agent", "actor_id": "planner"},
                    "session_id": None,
                    "claim_token": "claim-1",
                    "status": "active",
                    "claimed_at": 123,
                    "expires_at": 456,
                    "released_at": None,
                    "release_reason": None,
                    "source_event_id": 10,
                    "visibility_class": "workspace",
                    "version": 1,
                }
            ],
            "handoffs": [],
            "coordinationState": {
                "ownedClaims": [],
                "pendingInboundHandoffs": [],
                "pendingOutboundHandoffs": [],
                "sharedWorkItems": [],
            },
        }
    )
    claims = WorkClaimListResponse.from_dict(
        {
            "claims": [
                {
                    "id": 8,
                    "work_item_id": 99,
                    "actor": {"actor_kind": "agent", "actor_id": "planner"},
                    "session_id": None,
                    "claim_token": "claim-1",
                    "status": "active",
                    "claimed_at": 123,
                    "expires_at": 456,
                    "released_at": None,
                    "release_reason": None,
                    "source_event_id": 10,
                    "visibility_class": "workspace",
                    "version": 1,
                }
            ]
        }
    )
    handoffs = HandoffListResponse.from_dict({"handoffs": []})
    event = MemoryEventRecord.from_dict(
        {
            "event_id": 11,
            "entity_kind": "handoff",
            "entity_id": "12",
            "event_type": "handoff.created",
            "payload": {},
            "created_at": 124,
        }
    )

    assert events.events[0].event_type == "work_claim.claimed"
    assert state.work_claims[0].visibility_class == "workspace"
    assert isinstance(state.coordination_state, CoordinationState)
    assert claims.claims[0].id == 8
    assert handoffs.handoffs == []
    assert event.entity_kind == "handoff"
