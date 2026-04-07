"""PIN / password hashing + per-user rate limiter.

Uses passlib[bcrypt]. The rate limiter is in-process: a dict of
``user_id -> deque[float timestamps]`` guarded by an asyncio.Lock.
5 attempts per 60-second sliding window per user is enough for a
family appliance and avoids any external dep.
"""
from __future__ import annotations

import asyncio
import time
from collections import defaultdict, deque

import bcrypt

# We use the ``bcrypt`` package directly rather than passlib's CryptContext
# because passlib's runtime version probe trips on bcrypt 5.x and emits a
# noisy DeprecationWarning. bcrypt's own API is small enough to use raw.
_BCRYPT_MAX = 72  # bytes; bcrypt silently truncates beyond this otherwise

PIN_MIN_LEN = 4
PIN_MAX_LEN = 8
PASSWORD_MIN_LEN = 8

RATE_WINDOW_S = 60.0
RATE_MAX_ATTEMPTS = 5

_attempts: dict[int, deque[float]] = defaultdict(deque)
_rate_lock = asyncio.Lock()


def _to_bytes(s: str) -> bytes:
    return s.encode("utf-8")[:_BCRYPT_MAX]


def hash_secret(plain: str) -> str:
    return bcrypt.hashpw(_to_bytes(plain), bcrypt.gensalt()).decode("utf-8")


def verify_secret(plain: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        return bcrypt.checkpw(_to_bytes(plain), hashed.encode("utf-8"))
    except Exception:
        return False


def validate_pin(pin: str) -> None:
    if not pin.isdigit():
        raise ValueError("PIN must be digits only")
    if not (PIN_MIN_LEN <= len(pin) <= PIN_MAX_LEN):
        raise ValueError(f"PIN must be {PIN_MIN_LEN}-{PIN_MAX_LEN} digits")


def validate_password(password: str) -> None:
    if len(password) < PASSWORD_MIN_LEN:
        raise ValueError(f"password must be at least {PASSWORD_MIN_LEN} chars")


async def check_rate_limit(user_id: int) -> bool:
    """Return True if the attempt is allowed, False if rate-limited.

    Records the attempt timestamp on success.
    """
    now = time.monotonic()
    async with _rate_lock:
        dq = _attempts[user_id]
        while dq and now - dq[0] > RATE_WINDOW_S:
            dq.popleft()
        if len(dq) >= RATE_MAX_ATTEMPTS:
            return False
        dq.append(now)
        return True


def reset_rate_limit(user_id: int | None = None) -> None:
    """Test hook."""
    if user_id is None:
        _attempts.clear()
    else:
        _attempts.pop(user_id, None)
