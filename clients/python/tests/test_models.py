from memory_layer_client.models import (
    ChangeListResponse,
    ContextResponse,
    KnowledgeInspectionResponse,
    KnowledgeListResponse,
    MemoryScope,
    ReverificationResponse,
    TrustAssessmentResponse,
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

    assert listing.next_cursor == 10
    assert detail.evidence[0]["id"] == 2
    assert changes.changes[0]["fact"] == "shared"
    assert reverification.demoted_knowledge_ids == [3]
    assert assessment.state == "trusted"


def test_context_response_normalizes_unresolved_work_strings_and_legacy_objects() -> None:
    context = ContextResponse.from_dict(
        {
            "currentObjective": "Ship rollout",
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
            "tokenEstimate": 12,
        }
    )

    assert context.unresolved_work == [
        "Document rollback checklist",
        "Confirm staging smoke tests",
    ]
