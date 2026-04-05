from memory_layer_client import MemoryClient, MemoryRuntimeClient, MemoryScope


def _scope() -> MemoryScope:
    return MemoryScope(
        tenant_id="acme",
        system_id="python-agent",
        scope_id="run-42",
        workspace_id="factory",
        collaboration_id="release-42",
    )


def test_runtime_helper_prepares_prompt_and_commits_exchange(httpx_mock) -> None:
    scope = _scope()
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/context?query=rollback+plan&tenant_id=acme&system_id=python-agent&scope_id=run-42&workspace_id=factory&collaboration_id=release-42",
        json={
            "currentObjective": "Ship the rollback plan",
            "sessionState": {
                "currentObjective": "Ship the rollback plan",
                "blockers": ["Document the rollback checklist"],
                "assumptions": ["Assume blue-green deploy remains intact"],
                "pendingDecisions": ["Choose approver for rollback"],
                "activeTools": ["deploy-bot"],
                "recentOutputs": ["Rollback rehearsal completed"],
                "updatedAt": 42,
            },
            "activeTurnCount": 2,
            "workingMemory": {"summary": "We are preparing a rollback plan."},
            "relevantKnowledge": [{"fact": "Deployments must remain blue-green."}],
            "activeObjectives": [],
            "unresolvedWork": ["Document the rollback checklist"],
            "tokenEstimate": 42,
        },
    )
    httpx_mock.add_response(
        method="POST",
        url="http://test/v1/exchanges",
        json={"userTurnId": 1, "assistantTurnId": 2, "compacted": False},
    )

    with MemoryClient("http://test", default_scope=scope) as client:
        runtime = MemoryRuntimeClient(client)
        result = runtime.run_turn(
            "rollback plan",
            lambda prepared: f"Using memory: {prepared.context.current_objective}",
        )

    assert "Ship the rollback plan" in result.prepared.prompt
    assert "Session state" in result.prepared.prompt
    assert "Document the rollback checklist" in result.prepared.prompt
    assert result.exchange.user_turn_id == 1
    assert "Using memory" in result.response_text
