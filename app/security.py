"""Security utilities for password hashing and JWT handling."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt


HASH_ITERATIONS = 120_000


def hash_password(password: str) -> str:
    """Return a salted PBKDF2 password hash."""
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        HASH_ITERATIONS,
    )
    return "$".join(
        [
            "pbkdf2_sha256",
            str(HASH_ITERATIONS),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def verify_password(password: str, encoded_hash: str) -> bool:
    """Verify a plaintext password against a stored PBKDF2 hash."""
    try:
        _, iteration_text, salt_text, digest_text = encoded_hash.split("$", 3)
        salt = base64.b64decode(salt_text.encode("ascii"))
        expected = base64.b64decode(digest_text.encode("ascii"))
        actual = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt,
            int(iteration_text),
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def create_access_token(
    user_id: str,
    username: str,
    secret: str,
    expires_in_minutes: int = 60 * 12,
) -> str:
    """Create a JWT access token."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": user_id,
        "username": username,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=expires_in_minutes)).timestamp()),
    }
    return jwt.encode(payload, secret, algorithm="HS256")


def decode_access_token(token: str, secret: str) -> dict[str, Any]:
    """Decode and validate a JWT access token."""
    return jwt.decode(token, secret, algorithms=["HS256"])
