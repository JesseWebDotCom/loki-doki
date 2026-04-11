"""Error classes for the v2 execution layer."""
from __future__ import annotations


class HandlerError(Exception):
    """Base class for handler-side failures."""


class HandlerTimeout(HandlerError):
    """Raised when a handler exceeds its per-call timeout."""


class HandlerUnavailable(HandlerError):
    """Raised when no enabled implementation can serve a capability."""


class TransientHandlerError(HandlerError):
    """Raised when a handler fails in a way that should be retried."""
