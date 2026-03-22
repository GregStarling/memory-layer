"""Command-line entry point for the memory-layer Python client."""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, is_dataclass
from typing import Any

from .client import MemoryClient
from .models import MemoryScope


def _add_scope_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--tenant-id")
    parser.add_argument("--system-id")
    parser.add_argument("--scope-id")
    parser.add_argument("--workspace-id")
    parser.add_argument("--collaboration-id")


def _resolve_scope(args: argparse.Namespace) -> MemoryScope | None:
    if args.tenant_id and args.system_id and args.scope_id:
        return MemoryScope(
            tenant_id=args.tenant_id,
            system_id=args.system_id,
            scope_id=args.scope_id,
            workspace_id=args.workspace_id,
            collaboration_id=args.collaboration_id,
        )
    return None


def _to_payload(value: Any) -> Any:
    if is_dataclass(value):
        return asdict(value)
    return value


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="memory-layer-client")
    parser.add_argument("--base-url", default="http://localhost:3100")
    parser.add_argument("--api-key")
    parser.add_argument("--admin-key")
    parser.add_argument("--timeout", type=float, default=10.0)

    subparsers = parser.add_subparsers(dest="command", required=True)

    store_turn = subparsers.add_parser("store-turn")
    store_turn.add_argument("role")
    store_turn.add_argument("content")
    store_turn.add_argument("--actor")
    _add_scope_arguments(store_turn)

    store_exchange = subparsers.add_parser("store-exchange")
    store_exchange.add_argument("user_content")
    store_exchange.add_argument("assistant_content")
    _add_scope_arguments(store_exchange)

    context = subparsers.add_parser("context")
    context.add_argument("--query")
    _add_scope_arguments(context)

    search = subparsers.add_parser("search")
    search.add_argument("query")
    search.add_argument("--limit", type=int)
    _add_scope_arguments(search)

    cross_scope = subparsers.add_parser("search-cross-scope")
    cross_scope.add_argument("query")
    cross_scope.add_argument("--scope-level", default="workspace")
    cross_scope.add_argument("--limit", type=int)
    _add_scope_arguments(cross_scope)

    learn_fact = subparsers.add_parser("learn-fact")
    learn_fact.add_argument("fact")
    learn_fact.add_argument("fact_type")
    learn_fact.add_argument("--confidence", default="high")
    _add_scope_arguments(learn_fact)

    for name in ("health", "live", "ready", "inspect-monitor"):
        subparser = subparsers.add_parser(name)
        _add_scope_arguments(subparser)

    changes = subparsers.add_parser("changes")
    changes.add_argument("--since", required=True)
    changes.add_argument("--scope-level", default="scope")
    _add_scope_arguments(changes)

    inspect_knowledge = subparsers.add_parser("inspect-knowledge")
    inspect_knowledge.add_argument("--knowledge-id", type=int)
    inspect_knowledge.add_argument("--limit", type=int)
    inspect_knowledge.add_argument("--cursor", type=int)
    _add_scope_arguments(inspect_knowledge)

    audits = subparsers.add_parser("inspect-audits")
    audits.add_argument("--knowledge-id", type=int)
    audits.add_argument("--limit", type=int)
    _add_scope_arguments(audits)

    compactions = subparsers.add_parser("inspect-compactions")
    compactions.add_argument("--limit", type=int)
    _add_scope_arguments(compactions)

    inspect_reverification = subparsers.add_parser("inspect-reverification")
    inspect_reverification.add_argument("--limit", type=int)
    _add_scope_arguments(inspect_reverification)

    run_reverification = subparsers.add_parser("run-reverification")
    run_reverification.add_argument("--limit", type=int)
    _add_scope_arguments(run_reverification)

    reverify_one = subparsers.add_parser("reverify-knowledge")
    reverify_one.add_argument("knowledge_id", type=int)
    _add_scope_arguments(reverify_one)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    scope = _resolve_scope(args)
    client = MemoryClient(
        args.base_url,
        api_key=args.api_key,
        default_scope=scope,
        timeout=args.timeout,
    )
    try:
        if args.command == "store-turn":
            result = client.store_turn(args.role, args.content, actor=args.actor, scope=scope)
        elif args.command == "store-exchange":
            result = client.store_exchange(args.user_content, args.assistant_content, scope=scope)
        elif args.command == "context":
            result = client.get_context(query=args.query, scope=scope)
        elif args.command == "search":
            result = client.search(args.query, limit=args.limit, scope=scope)
        elif args.command == "search-cross-scope":
            result = client.search_cross_scope(
                args.query,
                scope_level=args.scope_level,
                limit=args.limit,
                scope=scope,
            )
        elif args.command == "learn-fact":
            result = client.learn_fact(
                args.fact,
                args.fact_type,
                confidence=args.confidence,
                scope=scope,
            )
        elif args.command == "health":
            result = client.health(scope=scope)
        elif args.command == "live":
            result = client.live()
        elif args.command == "ready":
            result = client.ready()
        elif args.command == "changes":
            result = client.poll_changes(args.since, scope_level=args.scope_level, scope=scope)
        elif args.command == "inspect-knowledge":
            if args.knowledge_id is not None:
                result = client.inspect_knowledge(args.knowledge_id, scope=scope)
            else:
                result = client.list_knowledge(limit=args.limit, cursor=args.cursor, scope=scope)
        elif args.command == "inspect-audits":
            result = client.list_audits(
                knowledge_id=args.knowledge_id,
                limit=args.limit,
                scope=scope,
            )
        elif args.command == "inspect-monitor":
            result = client.inspect_monitor(scope=scope)
        elif args.command == "inspect-compactions":
            result = client.inspect_compactions(limit=args.limit, scope=scope)
        elif args.command == "inspect-reverification":
            result = client.inspect_reverification(limit=args.limit, scope=scope)
        elif args.command == "run-reverification":
            result = client.run_reverification(
                limit=args.limit,
                scope=scope,
                admin_key=args.admin_key,
            )
        elif args.command == "reverify-knowledge":
            result = client.reverify_knowledge(
                args.knowledge_id,
                scope=scope,
                admin_key=args.admin_key,
            )
        else:
            parser.error(f"Unknown command: {args.command}")
        print(json.dumps(_to_payload(result), indent=2))
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
