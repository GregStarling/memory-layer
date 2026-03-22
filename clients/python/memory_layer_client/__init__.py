"""memory-layer-client: Python REST client for the memory-layer server."""

from .client import AsyncMemoryClient, MemoryClient, MemoryLayerError
from .models import (
    CompactResponse,
    ContextResponse,
    CreatedResource,
    HealthResponse,
    MaintenanceResponse,
    MemoryScope,
    ReadyResponse,
    SearchResponse,
    StoredExchange,
    StoredTurn,
)

__all__ = [
    "AsyncMemoryClient",
    "CompactResponse",
    "ContextResponse",
    "CreatedResource",
    "HealthResponse",
    "MaintenanceResponse",
    "MemoryClient",
    "MemoryLayerError",
    "MemoryScope",
    "ReadyResponse",
    "SearchResponse",
    "StoredExchange",
    "StoredTurn",
]
__version__ = "2.0.0"
