from memory_layer_client.cli import main


def test_cli_health_command_outputs_json(httpx_mock, capsys) -> None:
    httpx_mock.add_response(
        method="GET",
        url="http://test/v1/health?tenant_id=acme&system_id=planner&scope_id=run-a",
        json={
            "activeTurnCount": 1,
            "tokenEstimate": 42,
            "knowledgeCount": 2,
            "objectiveCount": 0,
            "unresolvedWorkCount": 0,
        },
    )

    exit_code = main(
        [
            "--base-url",
            "http://test",
            "health",
            "--tenant-id",
            "acme",
            "--system-id",
            "planner",
            "--scope-id",
            "run-a",
        ]
    )

    captured = capsys.readouterr()
    assert exit_code == 0
    assert '"knowledge_count": 2' in captured.out
