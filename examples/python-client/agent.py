"""
Python Agent with Memory Layer

Start the memory-layer HTTP server first:
  npx memory-layer serve --transport http --port 3100 --db ./agent-memory.db

Then run this agent:
  python agent.py
"""

import sys
sys.path.insert(0, "../../clients/python")

from memory_layer_client import MemoryClient

client = MemoryClient("http://localhost:3100")


def agent_loop():
    # Learn some initial facts
    client.learn_fact("User prefers Python over JavaScript", "preference")
    client.learn_fact("Project uses FastAPI framework", "reference")

    # Simulate a conversation
    exchanges = [
        ("What framework should we use?", "Based on your preferences, I recommend FastAPI."),
        ("Set up the project structure", "I'll create a standard FastAPI layout with routers."),
        ("Add authentication", "I'll implement JWT-based auth with FastAPI security."),
    ]

    for user_msg, assistant_msg in exchanges:
        result = client.store_exchange(user_msg, assistant_msg)
        print(f"Stored exchange: {result}")

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
