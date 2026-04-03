"""Ambient context signals (Time, Date, Weather, Location, Calendar)."""

from __future__ import annotations

import logging
import sqlite3
from datetime import datetime
from typing import Any, Optional

LOGGER = logging.getLogger(__name__)


def get_ambient_context(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: Optional[str] = None,
    location: Optional[str] = None,
) -> str:
    """Assembles the <ambient_context> block for prompt injection."""
    now = datetime.now()
    
    signals = {
        "now": now.strftime("%A %p, %B %d, %Y"),
        "time_of_day": _get_time_of_day(now),
        "day_of_week": now.strftime("%A"),
    }
    
    # 1. Calendar / Holidays / Birthdays
    calendar_event = _get_calendar_event(conn, user_id, now)
    if calendar_event:
        signals["calendar"] = calendar_event
        
    # 2. Weather (Mocked fallback for now)
    weather = _get_weather_signal(location)
    if weather:
        signals["weather"] = weather
        
    # 3. Time Since Last Talk
    last_talked = _get_time_since_last_talk(conn, user_id, character_id)
    if last_talked:
        signals["last_talked"] = last_talked
        
    # 4. Location
    if location:
        signals["location"] = location

    # Render XML block
    lines = ["<ambient_context>"]
    for key, value in signals.items():
        lines.append(f"  <{key}>{value}</{key}>")
    lines.append("</ambient_context>")
    
    return "\n".join(lines)


def _get_time_of_day(dt: datetime) -> str:
    hour = dt.hour
    if 5 <= hour < 12:
        return "morning"
    if 12 <= hour < 17:
        return "afternoon"
    if 17 <= hour < 21:
        return "evening"
    return "night"


def _get_calendar_event(conn: sqlite3.Connection, user_id: str, now: datetime) -> Optional[str]:
    """Check for recurring dates (birthdays) or major holidays."""
    # Check recurring dates (birthdays, etc)
    # Note: entity_id in mem_recurring_dates could be a character or user.
    # For now we check all recurring dates for the user.
    month, day = now.month, now.day
    
    rows = conn.execute(
        """
        SELECT label, remind_days_before
        FROM mem_recurring_dates
        WHERE month = ? AND day = ?
        """,
        (month, day)
    ).fetchall()
    
    if rows:
        return rows[0]["label"]
        
    # Check +- 2 days window for "upcoming"
    # (Simplified for now, just current day)
    
    # Static major holidays (Sample list)
    holidays = {
        (1, 1): "New Year's Day",
        (2, 14): "Valentine's Day",
        (3, 17): "St. Patrick's Day",
        (7, 4): "Independence Day",
        (10, 31): "Halloween",
        (12, 24): "Christmas Eve",
        (12, 25): "Christmas Day",
        (12, 31): "New Year's Eve",
    }
    return holidays.get((month, day))


def _get_weather_signal(location: Optional[str]) -> Optional[str]:
    """Fetch weather if location is provided. (Mocked base implementation)"""
    if not location:
        return None
    # In a real impl, this would call OpenWeatherMap and cache for 30m.
    # For now, return a generic descriptive placeholder if we don't have an API key.
    return "variable conditions"


def _get_time_since_last_talk(
    conn: sqlite3.Connection,
    user_id: str,
    character_id: Optional[str],
) -> Optional[str]:
    """Calculate days since the last session ended."""
    if not character_id:
        return None
        
    row = conn.execute(
        """
        SELECT last_message_at, updated_at
        FROM chat_sessions
        WHERE user_id = ? AND character_id = ?
        ORDER BY COALESCE(last_message_at, updated_at) DESC
        LIMIT 1
        """,
        (user_id, character_id)
    ).fetchone()
    
    if not row:
        return "first time talking"
        
    last_dt_str = row["last_message_at"] or row["updated_at"]
    try:
        # SQLite timestamps are usually YYYY-MM-DD HH:MM:SS
        last_dt = datetime.fromisoformat(last_dt_str.replace("Z", "+00:00"))
        delta = datetime.now() - last_dt
        
        days = delta.days
        if days == 0:
            return "talked recently"
        if days == 1:
            return "yesterday"
        if days < 7:
            return f"{days} days ago"
        if days < 30:
            return f"{days // 7} weeks ago"
        return "a while ago"
    except (ValueError, TypeError):
        return None
