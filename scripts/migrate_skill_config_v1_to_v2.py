#!/usr/bin/env python3
"""Migrate v1 skill config rows to v2 capability names.

Run once after C15. Copies config values and toggles from v1 skill_id
keys to their v2 capability equivalents. Original rows are preserved
(idempotent — safe to run multiple times).

Usage:
    python scripts/migrate_skill_config_v1_to_v2.py [--db path/to/lokidoki.db] [--dry-run]
"""
from __future__ import annotations

import argparse
import logging
import sqlite3
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(message)s")
logger = logging.getLogger(__name__)

# v1 skill_id → v2 capability name for skills that share config keys.
V1_TO_V2: dict[str, str] = {
    "weather_openmeteo": "get_weather",
    "movies_fandango": "get_movie_showtimes",
    "movies_tmdb": "lookup_movie",
}

# For movies_tmdb, we also map to search_movies (same TMDB key).
V1_TO_V2_MULTI: dict[str, list[str]] = {
    "movies_tmdb": ["lookup_movie", "search_movies"],
}


def migrate(db_path: Path, *, dry_run: bool = False) -> int:
    """Run the migration. Returns the number of rows copied."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    copied = 0

    for table in [
        "skill_config_global",
        "skill_config_user",
    ]:
        try:
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        except sqlite3.OperationalError:
            logger.info("Table %s does not exist, skipping", table)
            continue

        for row in rows:
            old_id = row["skill_id"]
            targets = V1_TO_V2_MULTI.get(old_id, [V1_TO_V2[old_id]] if old_id in V1_TO_V2 else [])
            if not targets:
                continue
            for new_id in targets:
                cols = [c for c in row.keys() if c != "skill_id"]
                check_cols = ["skill_id"] + [c for c in cols if c in ("key", "user_id")]
                check_where = " AND ".join(f"{c} = ?" for c in check_cols)
                check_vals = [new_id] + [row[c] for c in cols if c in ("key", "user_id")]
                existing = conn.execute(
                    f"SELECT 1 FROM {table} WHERE {check_where} LIMIT 1",
                    check_vals,
                ).fetchone()
                if existing:
                    logger.info("  SKIP %s.%s → %s (already exists)", table, old_id, new_id)
                    continue
                if dry_run:
                    logger.info("  DRY-RUN: would copy %s.%s → %s", table, old_id, new_id)
                    copied += 1
                else:
                    all_cols = ["skill_id"] + cols
                    placeholders = ", ".join("?" for _ in all_cols)
                    col_names = ", ".join(all_cols)
                    values = [new_id] + [row[c] for c in cols]
                    conn.execute(
                        f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                        values,
                    )
                    logger.info("  COPIED %s.%s → %s", table, old_id, new_id)
                    copied += 1

    for table in [
        "skill_enabled_global",
        "skill_enabled_user",
    ]:
        try:
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
        except sqlite3.OperationalError:
            logger.info("Table %s does not exist, skipping", table)
            continue

        for row in rows:
            old_id = row["skill_id"]
            targets = V1_TO_V2_MULTI.get(old_id, [V1_TO_V2[old_id]] if old_id in V1_TO_V2 else [])
            if not targets:
                continue
            for new_id in targets:
                cols = [c for c in row.keys() if c != "skill_id"]
                check_cols = ["skill_id"] + [c for c in cols if c in ("user_id",)]
                check_where = " AND ".join(f"{c} = ?" for c in check_cols)
                check_vals = [new_id] + [row[c] for c in cols if c in ("user_id",)]
                existing = conn.execute(
                    f"SELECT 1 FROM {table} WHERE {check_where} LIMIT 1",
                    check_vals,
                ).fetchone()
                if existing:
                    logger.info("  SKIP %s.%s → %s (already exists)", table, old_id, new_id)
                    continue
                if dry_run:
                    logger.info("  DRY-RUN: would copy %s.%s → %s", table, old_id, new_id)
                    copied += 1
                else:
                    all_cols = ["skill_id"] + cols
                    placeholders = ", ".join("?" for _ in all_cols)
                    col_names = ", ".join(all_cols)
                    values = [new_id] + [row[c] for c in cols]
                    conn.execute(
                        f"INSERT INTO {table} ({col_names}) VALUES ({placeholders})",
                        values,
                    )
                    logger.info("  COPIED %s.%s → %s", table, old_id, new_id)
                    copied += 1

    if not dry_run:
        conn.commit()
    conn.close()
    return copied


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        default="data/lokidoki.db",
        help="Path to the SQLite database (default: data/lokidoki.db)",
    )
    parser.add_argument("--dry-run", action="store_true", help="Show what would be copied without writing")
    args = parser.parse_args()

    db_path = Path(args.db)
    if not db_path.exists():
        logger.error("Database not found: %s", db_path)
        return

    logger.info("Migrating skill config: %s%s", db_path, " (dry run)" if args.dry_run else "")
    copied = migrate(db_path, dry_run=args.dry_run)
    logger.info("Done. %d row(s) %s.", copied, "would be copied" if args.dry_run else "copied")


if __name__ == "__main__":
    main()
