"""Error classes for the execution layer."""
from __future__ import annotations

from enum import Enum


class ErrorKind(str, Enum):
    """Standardised error taxonomy for skill results."""

    none = "none"
    invalid_params = "invalid_params"
    no_data = "no_data"
    offline = "offline"
    provider_down = "provider_down"
    rate_limited = "rate_limited"
    timeout = "timeout"
    internal_error = "internal_error"


class HandlerError(Exception):
    """Base class for handler-side failures."""


class HandlerTimeout(HandlerError):
    """Raised when a handler exceeds its per-call timeout."""


class HandlerUnavailable(HandlerError):
    """Raised when no enabled implementation can serve a capability."""


class TransientHandlerError(HandlerError):
    """Raised when a handler fails in a way that should be retried."""
