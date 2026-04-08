from __future__ import annotations

import sqlite3
from pathlib import Path

DB_PATH = Path("train_sugoroku.db")


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                email TEXT UNIQUE NOT NULL,
                display_name TEXT NOT NULL,
                icon TEXT NOT NULL DEFAULT '🚃',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS email_codes (
                email TEXT PRIMARY KEY,
                code TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS games (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_code TEXT UNIQUE NOT NULL,
                city TEXT NOT NULL,
                mode TEXT NOT NULL,
                start_station_id TEXT NOT NULL,
                goal_station_id TEXT,
                goal_enabled INTEGER NOT NULL,
                min_stay_minutes INTEGER NOT NULL,
                max_players INTEGER NOT NULL DEFAULT 1,
                join_password TEXT,
                creator_user_id INTEGER NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                started_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(creator_user_id) REFERENCES users(id)
            );

            CREATE TABLE IF NOT EXISTS game_players (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                current_station_id TEXT NOT NULL,
                prev_station_id TEXT,
                current_line_key TEXT,
                next_roll_at TEXT NOT NULL,
                pending_station_id TEXT,
                pending_prev_station_id TEXT,
                pending_terminal_station_id TEXT,
                checkin_phase INTEGER NOT NULL DEFAULT 0,
                pending_line_key TEXT,
                checkin_required INTEGER NOT NULL DEFAULT 0,
                finished_rank INTEGER,
                finished_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(game_id, user_id),
                FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS visited_stations (
                game_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                station_id TEXT NOT NULL,
                visited_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY(game_id, user_id, station_id),
                FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS game_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS player_position_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                station_id TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            );
            """
        )
        _migrate(conn)


def _migrate(conn: sqlite3.Connection) -> None:
    user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()}
    if "icon" not in user_cols:
        conn.execute("ALTER TABLE users ADD COLUMN icon TEXT NOT NULL DEFAULT '🚃'")

    cols = {r["name"] for r in conn.execute("PRAGMA table_info(games)").fetchall()}
    if "max_players" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN max_players INTEGER NOT NULL DEFAULT 1")
    if "join_password" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN join_password TEXT")
    if "started_at" not in cols:
        conn.execute("ALTER TABLE games ADD COLUMN started_at TEXT")
    player_cols = {r["name"] for r in conn.execute("PRAGMA table_info(game_players)").fetchall()}
    if "pending_station_id" not in player_cols:
        conn.execute("ALTER TABLE game_players ADD COLUMN pending_station_id TEXT")
    if "prev_station_id" not in player_cols:
        conn.execute("ALTER TABLE game_players ADD COLUMN prev_station_id TEXT")
    if "pending_prev_station_id" not in player_cols:
        conn.execute("ALTER TABLE game_players ADD COLUMN pending_prev_station_id TEXT")
    if "pending_terminal_station_id" not in player_cols:
        conn.execute("ALTER TABLE game_players ADD COLUMN pending_terminal_station_id TEXT")
    if "checkin_phase" not in player_cols:
        conn.execute("ALTER TABLE game_players ADD COLUMN checkin_phase INTEGER NOT NULL DEFAULT 0")
    if "pending_line_key" not in player_cols:
        conn.execute("ALTER TABLE game_players ADD COLUMN pending_line_key TEXT")
    if "checkin_required" not in player_cols:
        conn.execute("ALTER TABLE game_players ADD COLUMN checkin_required INTEGER NOT NULL DEFAULT 0")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS player_position_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            game_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            station_id TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(game_id) REFERENCES games(id) ON DELETE CASCADE,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )
        """
    )
