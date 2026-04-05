"""Hosted runtime helpers for memory-layer Python clients."""

from __future__ import annotations

import inspect
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from typing import Optional

from .client import AsyncMemoryClient, MemoryClient
from .models import MemoryEvent, MemoryScope, PreparedMemoryTurn, RuntimeTurnResult, StoredExchange


def format_prompt(prepared: PreparedMemoryTurn) -> str:
    """Render a simple prompt-ready view of hosted memory context."""
    sections: list[str] = []
    context = prepared.context

    if context.current_objective:
        sections.append(f"Current objective:\n{context.current_objective}")

    if context.session_state:
        session_lines: list[str] = []
        blockers = context.session_state.get("blockers")
        if isinstance(blockers, list) and blockers:
            session_lines.append("Blockers: " + "; ".join(str(item) for item in blockers if item))
        assumptions = context.session_state.get("assumptions")
        if isinstance(assumptions, list) and assumptions:
            session_lines.append("Assumptions: " + "; ".join(str(item) for item in assumptions if item))
        pending_decisions = context.session_state.get("pendingDecisions")
        if isinstance(pending_decisions, list) and pending_decisions:
            session_lines.append(
                "Pending decisions: "
                + "; ".join(str(item) for item in pending_decisions if item)
            )
        active_tools = context.session_state.get("activeTools")
        if isinstance(active_tools, list) and active_tools:
            session_lines.append("Active tools: " + ", ".join(str(item) for item in active_tools if item))
        recent_outputs = context.session_state.get("recentOutputs")
        if isinstance(recent_outputs, list) and recent_outputs:
            session_lines.append("Recent outputs: " + " | ".join(str(item) for item in recent_outputs if item))
        if session_lines:
            sections.append("Session state:\n" + "\n".join(session_lines))

    if context.working_memory and context.working_memory.get("summary"):
        sections.append(f"Working memory:\n{context.working_memory['summary']}")

    if context.relevant_knowledge:
        knowledge_lines = [
            f"- {item.get('fact', '')}" for item in context.relevant_knowledge if item.get("fact")
        ]
        if knowledge_lines:
            sections.append("Relevant knowledge:\n" + "\n".join(knowledge_lines))

    if context.unresolved_work:
        work_lines = [f"- {item}" for item in context.unresolved_work if item]
        if work_lines:
            sections.append("Open work:\n" + "\n".join(work_lines))

    sections.append(f"User input:\n{prepared.user_input}")
    return "\n\n".join(sections)


class MemoryRuntimeClient:
    """Sync runtime helper that mirrors the Node runtime flow over HTTP."""

    def __init__(self, client: MemoryClient):
        self.client = client

    def before_model_call(
        self,
        user_input: str,
        *,
        query: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> PreparedMemoryTurn:
        resolved_query = query or user_input
        context = self.client.get_context(query=resolved_query, scope=scope)
        prepared = PreparedMemoryTurn(
            user_input=user_input,
            query=resolved_query,
            prompt="",
            context=context,
        )
        return PreparedMemoryTurn(
            user_input=user_input,
            query=resolved_query,
            prompt=format_prompt(prepared),
            context=context,
        )

    def after_model_call(
        self,
        user_input: str,
        assistant_output: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> StoredExchange:
        return self.client.store_exchange(user_input, assistant_output, scope=scope)

    def run_turn(
        self,
        user_input: str,
        model_call: Callable[[PreparedMemoryTurn], str],
        *,
        query: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> RuntimeTurnResult:
        prepared = self.before_model_call(user_input, query=query, scope=scope)
        response_text = model_call(prepared)
        exchange = self.after_model_call(user_input, response_text, scope=scope)
        return RuntimeTurnResult(prepared=prepared, response_text=response_text, exchange=exchange)

    def iter_events(
        self,
        *,
        event_types: Optional[list[str]] = None,
        scope_level: str = "scope",
        scope: Optional[MemoryScope] = None,
    ) -> Iterator[MemoryEvent]:
        return self.client.stream_events(
            event_types=event_types,
            scope_level=scope_level,
            scope=scope,
        )


class AsyncMemoryRuntimeClient:
    """Async runtime helper that mirrors the Node runtime flow over HTTP."""

    def __init__(self, client: AsyncMemoryClient):
        self.client = client

    async def before_model_call(
        self,
        user_input: str,
        *,
        query: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> PreparedMemoryTurn:
        resolved_query = query or user_input
        context = await self.client.get_context(query=resolved_query, scope=scope)
        prepared = PreparedMemoryTurn(
            user_input=user_input,
            query=resolved_query,
            prompt="",
            context=context,
        )
        return PreparedMemoryTurn(
            user_input=user_input,
            query=resolved_query,
            prompt=format_prompt(prepared),
            context=context,
        )

    async def after_model_call(
        self,
        user_input: str,
        assistant_output: str,
        *,
        scope: Optional[MemoryScope] = None,
    ) -> StoredExchange:
        return await self.client.store_exchange(user_input, assistant_output, scope=scope)

    async def run_turn(
        self,
        user_input: str,
        model_call: Callable[[PreparedMemoryTurn], Awaitable[str] | str],
        *,
        query: Optional[str] = None,
        scope: Optional[MemoryScope] = None,
    ) -> RuntimeTurnResult:
        prepared = await self.before_model_call(user_input, query=query, scope=scope)
        maybe_response = model_call(prepared)
        response_text = await maybe_response if inspect.isawaitable(maybe_response) else maybe_response
        exchange = await self.after_model_call(user_input, str(response_text), scope=scope)
        return RuntimeTurnResult(
            prepared=prepared,
            response_text=str(response_text),
            exchange=exchange,
        )

    def iter_events(
        self,
        *,
        event_types: Optional[list[str]] = None,
        scope_level: str = "scope",
        scope: Optional[MemoryScope] = None,
    ) -> AsyncIterator[MemoryEvent]:
        return self.client.astream_events(
            event_types=event_types,
            scope_level=scope_level,
            scope=scope,
        )
