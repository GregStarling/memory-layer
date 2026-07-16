"""REST clients for the memory-layer HTTP server.

This module is the stable public import surface — ``MemoryClient``,
``AsyncMemoryClient`` and ``MemoryLayerError`` — and is intentionally thin:

  * the transport/lifecycle plumbing and the hand-kept conveniences (health
    probes and the SSE streaming readers) live in :mod:`._base`;
  * every uniform request/response method is generated from the operation
    registry into :mod:`._generated` by ``scripts/generate-python-client.mjs``.

Import paths and class names are unchanged from previous releases; the split
into ``_base`` / ``_generated`` is an internal refactor (Phase 6.6b).
"""

from __future__ import annotations

from ._base import MemoryLayerError
from ._generated import AsyncMemoryClient, MemoryClient

__all__ = ["AsyncMemoryClient", "MemoryClient", "MemoryLayerError"]
