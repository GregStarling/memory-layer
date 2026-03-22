"""
Python Agent with Memory Layer

Start the memory-layer HTTP server first:
  npx memory-layer serve --transport http --port 3100 --db ./agent-memory.db

Then run this agent:
  python agent.py
"""

import sys
sys.path.insert(0, "../../clients/python")

from memory_layer_client import MemoryClient, MemoryRuntimeClient, MemoryScope

client = MemoryClient(
    "http://localhost:3100",
    default_scope=MemoryScope(
        tenant_id="acme",
        system_id="python-agent",
        workspace_id="factory",
        collaboration_id="release-42",
        scope_id="run-42",
    ),
)
runtime = MemoryRuntimeClient(client)


def agent_loop():
    # Learn some initial facts
    client.learn_fact("User prefers Python over JavaScript", "preference")
    client.learn_fact("Project uses FastAPI framework", "reference")

    turns = [
        "What framework should we use?",
        "Set up the project structure",
        "Add authentication",
    ]

    for user_msg in turns:
        result = runtime.run_turn(
            user_msg,
            lambda prepared: f"Using memory for: {prepared.context.current_objective or 'agent work'}",
        )
        print(f"Prepared prompt:\n{result.prepared.prompt}\n")
        print(f"Stored exchange: {result.exchange}")

    # Search for relevant knowledge
    results = client.search("framework")
    print(f"\nSearch results for 'framework':")
    for k in results.knowledge:
        print(f"  - {k['fact']} (type: {k['fact_type']}, rank: {k['rank']:.2f})")

    # Get full context
    context = client.get_context(query="authentication setup")
    print(f"\nContext:")
    print(f"  Active turns: {context.active_turn_count}")
    print(f"  Token estimate: {context.token_estimate}")
    print(f"  Knowledge items: {len(context.relevant_knowledge)}")

    # Check health
    health = client.health()
    print(f"\nHealth: {health}")


if __name__ == "__main__":
    agent_loop()
