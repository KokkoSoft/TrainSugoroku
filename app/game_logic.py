from __future__ import annotations

import datetime as dt
import random
import secrets
import string
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from .data_loader import (
    SubwayGraph,
    line_station_candidates,
    load_city_graph,
    ordered_station_ids_by_line_geometry,
)
from .db import get_conn

MODE_SOLO_GOAL = "solo_goal"
MODE_SOLO_ENDLESS = "solo_endless"
MODE_MULTI_RACE = "multi_race"
MODE_MULTI_STATION = "multi_station_count"
ALL_MODES = {MODE_SOLO_GOAL, MODE_SOLO_ENDLESS, MODE_MULTI_RACE, MODE_MULTI_STATION}


@dataclass
class MoveResult:
    roll: int
    path: List[str]
    roulette: List[Dict[str, Any]]
    final_station_id: str
    final_line_key: Optional[str]
    prev_station_id_before_final: Optional[str]


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(ts: dt.datetime) -> str:
    return ts.replace(microsecond=0).isoformat()


def _parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s)


def _game_code() -> str:
    chars = string.ascii_uppercase + string.digits
    return "".join(secrets.choice(chars) for _ in range(6))


def _is_multi_mode(mode: str) -> bool:
    return mode in {MODE_MULTI_RACE, MODE_MULTI_STATION}


def _choices_for_station(
    graph: SubwayGraph,
    station_id: str,
    selected_line_key: Optional[str] = None,
) -> Dict[str, Any]:
    candidates = graph.edges.get(station_id, [])
    lines = sorted({e.line_key for e in candidates})
    line_key = selected_line_key or (lines[0] if len(lines) == 1 else None)
    direction_choices: List[Dict[str, str]] = []
    if line_key:
        dirs = sorted({e.to_station_id for e in candidates if e.line_key == line_key})
        direction_choices = [
            {"station_id": sid, "name": graph.nodes[sid].name}
            for sid in dirs
            if sid in graph.nodes
        ]
    return {
        "line_choices": lines,
        "selected_line_key": line_key,
        "direction_choices": direction_choices,
    }


def _direction_candidates(
    graph: SubwayGraph,
    station_id: str,
    line_key: str,
    exclude_station_id: Optional[str] = None,
) -> List[str]:
    cands = [e.to_station_id for e in graph.edges.get(station_id, []) if e.line_key == line_key]
    if exclude_station_id is not None:
        forward = [sid for sid in cands if sid != exclude_station_id]
        if forward:
            return sorted(set(forward))
    return sorted(set(cands))


def _move_one_step(
    graph: SubwayGraph,
    current_station_id: str,
    current_line_key: Optional[str],
    prev_station_id: Optional[str],
    rng: random.Random,
) -> Tuple[str, Optional[str], Dict[str, Any]]:
    candidates = graph.edges.get(current_station_id, [])
    if not candidates:
        return current_station_id, current_line_key, {"type": "dead_end", "at": current_station_id}

    if prev_station_id is not None:
        non_back = [e for e in candidates if e.to_station_id != prev_station_id]
        if non_back:
            candidates = non_back

    lines = sorted({e.line_key for e in candidates})
    roulette_event: Dict[str, Any] = {
        "type": "roulette",
        "at": current_station_id,
        "choices": lines,
        "selected": None,
    }

    if len(lines) == 1:
        selected_line = lines[0]
        roulette_event["type"] = "line_fixed"
    else:
        selected_line = rng.choice(lines)
        roulette_event["selected"] = selected_line

    same_line = [e for e in candidates if e.line_key == selected_line]
    if len(same_line) == 1:
        picked = same_line[0]
    else:
        if prev_station_id is not None:
            forward = [e for e in same_line if e.to_station_id != prev_station_id]
            picked = rng.choice(forward or same_line)
        else:
            picked = rng.choice(same_line)

    return picked.to_station_id, picked.line_key, roulette_event


def simulate_roll(
    graph: SubwayGraph,
    station_id: str,
    line_key: Optional[str],
    seed: int,
) -> MoveResult:
    rng = random.Random(seed)
    roll = rng.randint(1, 6)

    cur = station_id
    cur_line = line_key
    prev: Optional[str] = None
    path = [cur]
    roulette: List[Dict[str, Any]] = []

    for _ in range(roll):
        nxt, nxt_line, event = _move_one_step(graph, cur, cur_line, prev, rng)
        roulette.append(event)
        prev, cur = cur, nxt
        cur_line = nxt_line
        path.append(cur)

    return MoveResult(
        roll=roll,
        path=path,
        roulette=roulette,
        final_station_id=cur,
        final_line_key=cur_line,
        prev_station_id_before_final=prev,
    )


def simulate_roll_with_first_step(
    graph: SubwayGraph,
    station_id: str,
    line_key: Optional[str],
    prev_station_id: Optional[str],
    seed: int,
    forced_first_line_key: Optional[str],
    first_step_station_id: Optional[str],
    first_step_line_key: Optional[str],
) -> MoveResult:
    rng = random.Random(seed)
    roll = rng.randint(1, 6)

    path = [station_id]
    roulette: List[Dict[str, Any]] = []
    cur = station_id
    cur_line = line_key
    prev = prev_station_id

    if roll >= 1 and first_step_station_id and first_step_line_key:
        path.append(first_step_station_id)
        roulette.append(
            {
                "type": "manual_first_step",
                "at": station_id,
                "selected_line": first_step_line_key,
                "selected_direction_station_id": first_step_station_id,
            }
        )
        prev, cur = station_id, first_step_station_id
        cur_line = first_step_line_key

    start_i = 1 if (roll >= 1 and first_step_station_id and first_step_line_key) else 0
    for step_i in range(start_i, roll):
        candidates = graph.edges.get(cur, [])
        if not candidates:
            roulette.append({"type": "dead_end", "at": cur})
            break

        lines = sorted({e.line_key for e in candidates})
        if step_i == 0 and forced_first_line_key and forced_first_line_key in lines:
            selected_line = forced_first_line_key
        elif len(lines) == 1:
            selected_line = lines[0]
        else:
            selected_line = rng.choice(lines)
            roulette.append(
                {
                    "type": "roulette",
                    "at": cur,
                    "choices": lines,
                    "selected": selected_line,
                }
            )

        line_changed = (cur_line is None) or (selected_line != cur_line)
        dir_exclude = None if line_changed else prev
        all_candidates = _direction_candidates(graph, cur, selected_line, None)
        dir_candidates = _direction_candidates(graph, cur, selected_line, dir_exclude)
        if not dir_candidates:
            fallback = _direction_candidates(graph, cur, selected_line, None)
            if fallback:
                roulette.append(
                    {
                        "type": "terminal_bounce",
                        "at": cur,
                        "line": selected_line,
                    }
                )
            dir_candidates = fallback
        elif dir_exclude is not None and all_candidates and dir_candidates == [dir_exclude]:
            roulette.append(
                {
                    "type": "terminal_bounce",
                    "at": cur,
                    "line": selected_line,
                }
            )
        if not dir_candidates:
            roulette.append({"type": "dead_end", "at": cur})
            break

        # 方面サイコロは、初回出発時または別路線へ乗換えた時のみ。
        if line_changed and len(dir_candidates) > 1:
            picked = rng.choice(dir_candidates)
            roulette.append(
                {
                    "type": "direction_roulette",
                    "at": cur,
                    "line": selected_line,
                    "choices": dir_candidates,
                    "selected": picked,
                }
            )
            nxt = picked
        else:
            nxt = dir_candidates[0]

        prev, cur = cur, nxt
        cur_line = selected_line
        path.append(cur)

    return MoveResult(
        roll=roll,
        path=path,
        roulette=roulette,
        final_station_id=cur,
        final_line_key=cur_line,
        prev_station_id_before_final=prev,
    )


def create_game(
    *,
    user_id: int,
    city: str,
    mode: str,
    start_station_id: str,
    goal_station_id: Optional[str],
    goal_enabled: bool,
    min_stay_minutes: int,
    max_players: int,
    join_password: Optional[str],
) -> Dict[str, Any]:
    if mode not in ALL_MODES:
        raise ValueError("unsupported mode")
    if min_stay_minutes < 0:
        raise ValueError("min_stay_minutes must be >= 0")

    graph = load_city_graph(city)
    if start_station_id not in graph.nodes:
        raise ValueError("invalid start station")
    if goal_enabled:
        if not goal_station_id:
            raise ValueError("goal station required when goal is enabled")
        if goal_station_id not in graph.nodes:
            raise ValueError("invalid goal station")
        if goal_station_id == start_station_id:
            raise ValueError("goal station must be different from start")

    if _is_multi_mode(mode) and not join_password:
        raise ValueError("join password required for multiplayer")
    if max_players < 1:
        raise ValueError("max_players must be >= 1")
    if _is_multi_mode(mode) and max_players < 2:
        raise ValueError("max_players must be >= 2 for multiplayer")

    code = _game_code()
    now = _now()
    status = "waiting" if _is_multi_mode(mode) else "active"
    started_at = None if _is_multi_mode(mode) else _iso(now)

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO games (
                game_code, city, mode, start_station_id, goal_station_id, goal_enabled,
                min_stay_minutes, max_players, join_password, creator_user_id, status, started_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                code,
                city,
                mode,
                start_station_id,
                goal_station_id,
                1 if goal_enabled else 0,
                min_stay_minutes,
                max_players,
                join_password,
                user_id,
                status,
                started_at,
            ),
        )
        gid = conn.execute("SELECT id FROM games WHERE game_code=?", (code,)).fetchone()["id"]
        conn.execute(
            """
            INSERT INTO game_players (game_id, user_id, current_station_id, current_line_key, next_roll_at)
            VALUES (?, ?, ?, NULL, ?)
            """,
            (gid, user_id, start_station_id, _iso(now)),
        )
        conn.execute(
            """
            INSERT INTO player_position_history (game_id, user_id, station_id, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (gid, user_id, start_station_id, _iso(now)),
        )

    return {"game_code": code}


def join_game(user_id: int, game_code: str, join_password: Optional[str]) -> None:
    with get_conn() as conn:
        game = conn.execute("SELECT * FROM games WHERE game_code=?", (game_code,)).fetchone()
        if not game:
            raise ValueError("game not found")
        if not _is_multi_mode(game["mode"]):
            raise ValueError("solo game cannot be joined")
        if game["status"] != "waiting":
            raise ValueError("game already started. 途中参加不可")
        if (game["join_password"] or "") != (join_password or ""):
            raise ValueError("invalid password")
        if int(game["max_players"] or 0) > 0:
            count = conn.execute("SELECT COUNT(*) AS c FROM game_players WHERE game_id=?", (game["id"],)).fetchone()["c"]
            if count >= int(game["max_players"]):
                raise ValueError("game is full")

        now = _iso(_now())
        conn.execute(
            """
            INSERT OR IGNORE INTO game_players (game_id, user_id, current_station_id, current_line_key, next_roll_at)
            VALUES (?, ?, ?, NULL, ?)
            """,
            (game["id"], user_id, game["start_station_id"], now),
        )
        has_history = conn.execute(
            "SELECT 1 FROM player_position_history WHERE game_id=? AND user_id=? LIMIT 1",
            (game["id"], user_id),
        ).fetchone()
        if not has_history:
            conn.execute(
                """
                INSERT INTO player_position_history (game_id, user_id, station_id, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (game["id"], user_id, game["start_station_id"], now),
            )


def start_game(user_id: int, game_code: str) -> None:
    with get_conn() as conn:
        game = conn.execute("SELECT * FROM games WHERE game_code=?", (game_code,)).fetchone()
        if not game:
            raise ValueError("game not found")
        if not _is_multi_mode(game["mode"]):
            raise ValueError("solo game is already started")
        if game["creator_user_id"] != user_id:
            raise ValueError("only creator can start")
        if game["status"] != "waiting":
            raise ValueError("game already started")

        count = conn.execute("SELECT COUNT(*) AS c FROM game_players WHERE game_id=?", (game["id"],)).fetchone()["c"]
        if count < 2:
            raise ValueError("at least 2 players required")

        now = _iso(_now())
        conn.execute("UPDATE games SET status='active', started_at=? WHERE id=?", (now, game["id"]))
        conn.execute("UPDATE game_players SET next_roll_at=? WHERE game_id=?", (now, game["id"]))


def _player_summary(conn, game_id: int, graph: SubwayGraph) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT gp.*, u.display_name, u.icon
        FROM game_players gp
        JOIN users u ON u.id = gp.user_id
        WHERE gp.game_id=?
        ORDER BY gp.id
        """,
        (game_id,),
    ).fetchall()

    now = _now()
    counts = {
        r["user_id"]: conn.execute(
            """
            SELECT COUNT(*) AS c
            FROM visited_stations vs
            JOIN games g ON g.id = vs.game_id
            WHERE vs.game_id=? AND vs.user_id=? AND vs.station_id <> g.start_station_id
            """,
            (game_id, r["user_id"]),
        ).fetchone()["c"]
        for r in rows
    }

    out: List[Dict[str, Any]] = []
    for r in rows:
        next_roll_at = r["next_roll_at"]
        wait_sec = max(0, int((_parse_iso(next_roll_at) - now).total_seconds()))
        pending_id = r["pending_station_id"]
        out.append(
            {
                "user_id": r["user_id"],
                "display_name": r["display_name"],
                "current_station_id": r["current_station_id"],
                "current_station_name": graph.nodes[r["current_station_id"]].name,
                "current_station_lat": graph.nodes[r["current_station_id"]].lat,
                "current_station_lon": graph.nodes[r["current_station_id"]].lon,
                "current_line_key": r["current_line_key"],
                "icon": r["icon"] or "🚃",
                "next_roll_at": next_roll_at,
                "next_roll_in_seconds": wait_sec,
                "checkin_required": bool(r["checkin_required"]),
                "pending_station_id": pending_id,
                "pending_station_name": graph.nodes[pending_id].name if pending_id and pending_id in graph.nodes else None,
                "pending_terminal_station_id": r["pending_terminal_station_id"],
                "pending_terminal_station_name": (
                    graph.nodes[r["pending_terminal_station_id"]].name
                    if r["pending_terminal_station_id"] and r["pending_terminal_station_id"] in graph.nodes
                    else None
                ),
                "checkin_phase": int(r["checkin_phase"] or 0),
                "finished_rank": r["finished_rank"],
                "visited_station_count": counts[r["user_id"]],
            }
        )
    return out


def _event_log(conn, game_id: int, limit: int = 100) -> List[Dict[str, Any]]:
    rows = conn.execute(
        """
        SELECT ge.created_at, ge.message, u.display_name
        FROM game_events ge
        JOIN users u ON u.id = ge.user_id
        WHERE ge.game_id=?
        ORDER BY ge.id ASC
        LIMIT ?
        """,
        (game_id, limit),
    ).fetchall()
    return [
        {
            "created_at": r["created_at"],
            "display_name": r["display_name"],
            "message": r["message"],
        }
        for r in rows
    ]


def _line_label(line_key: str) -> str:
    if "|" in line_key:
        return line_key.split("|", 1)[1]
    return line_key


def _map_state(conn, game_id: int, user_id: int, graph: SubwayGraph, players: List[Dict[str, Any]]) -> Dict[str, Any]:
    stations = [
        {
            "station_id": sid,
            "name": n.name,
            "lat": n.lat,
            "lon": n.lon,
        }
        for sid, n in graph.nodes.items()
    ]
    route_rows = conn.execute(
        """
        SELECT station_id, created_at
        FROM player_position_history
        WHERE game_id=? AND user_id=?
        ORDER BY id ASC
        """,
        (game_id, user_id),
    ).fetchall()
    my_route = [
        {
            "station_id": r["station_id"],
            "name": graph.nodes[r["station_id"]].name,
            "lat": graph.nodes[r["station_id"]].lat,
            "lon": graph.nodes[r["station_id"]].lon,
            "created_at": r["created_at"],
        }
        for r in route_rows
        if r["station_id"] in graph.nodes
    ]
    player_markers = [
        {
            "user_id": p["user_id"],
            "display_name": p["display_name"],
            "icon": p.get("icon") or "🚃",
            "station_id": p["current_station_id"],
            "station_name": p["current_station_name"],
            "lat": p["current_station_lat"],
            "lon": p["current_station_lon"],
        }
        for p in players
    ]
    edge_seen = set()
    edges: List[Dict[str, Any]] = []
    for from_id, outs in graph.edges.items():
        if from_id not in graph.nodes:
            continue
        a = graph.nodes[from_id]
        for e in outs:
            to_id = e.to_station_id
            if to_id not in graph.nodes:
                continue
            key = tuple(sorted((from_id, to_id)))
            if key in edge_seen:
                continue
            edge_seen.add(key)
            b = graph.nodes[to_id]
            edges.append(
                {
                    "from_station_id": from_id,
                    "to_station_id": to_id,
                    "from_lat": a.lat,
                    "from_lon": a.lon,
                    "to_lat": b.lat,
                    "to_lon": b.lon,
                }
            )
    return {
        "stations": stations,
        "edges": edges,
        "my_route": my_route,
        "players": player_markers,
    }


def get_game_state(user_id: int, game_code: str) -> Dict[str, Any]:
    with get_conn() as conn:
        game = conn.execute("SELECT * FROM games WHERE game_code=?", (game_code,)).fetchone()
        if not game:
            raise ValueError("game not found")

        joined = conn.execute(
            "SELECT 1 FROM game_players WHERE game_id=? AND user_id=?",
            (game["id"], user_id),
        ).fetchone()
        if not joined:
            raise ValueError("not joined")

        graph = load_city_graph(game["city"])

        players = _player_summary(conn, game["id"], graph)

        ranking = []
        if game["mode"] == MODE_MULTI_STATION:
            ranking = sorted(players, key=lambda p: p["visited_station_count"], reverse=True)
        elif game["mode"] == MODE_MULTI_RACE:
            ranking = sorted(
                players,
                key=lambda p: (p["finished_rank"] is None, p["finished_rank"] or 10**9),
            )

        is_creator = game["creator_user_id"] == user_id
        can_start = bool(_is_multi_mode(game["mode"]) and is_creator and game["status"] == "waiting" and len(players) >= 2)

        return {
            "game": {
                "game_code": game["game_code"],
                "city": game["city"],
                "mode": game["mode"],
                "start_station_id": game["start_station_id"],
                "start_station_name": graph.nodes[game["start_station_id"]].name,
                "goal_enabled": bool(game["goal_enabled"]),
            "goal_station_id": game["goal_station_id"],
            "goal_station_name": graph.nodes[game["goal_station_id"]].name if game["goal_station_id"] else None,
            "min_stay_minutes": game["min_stay_minutes"],
            "max_players": game["max_players"],
            "status": game["status"],
                "started_at": game["started_at"],
                "is_creator": is_creator,
                "can_start": can_start,
                "join_url": f"/?join={game['game_code']}",
                "join_blocked_message": "ゲーム開始後は途中参加できません",
            },
            "players": players,
            "ranking": ranking,
            "logs": _event_log(conn, game["id"]),
            "map": _map_state(conn, game["id"], user_id, graph, players),
        }


def get_roll_options(user_id: int, game_code: str, selected_line_key: Optional[str]) -> Dict[str, Any]:
    with get_conn() as conn:
        game = conn.execute("SELECT * FROM games WHERE game_code=?", (game_code,)).fetchone()
        if not game:
            raise ValueError("game not found")
        if game["status"] != "active":
            raise ValueError("game is not started yet")

        player = conn.execute(
            "SELECT * FROM game_players WHERE game_id=? AND user_id=?",
            (game["id"], user_id),
        ).fetchone()
        if not player:
            raise ValueError("not joined")
        if bool(player["checkin_required"]):
            raise ValueError("checkin required")

        now = _now()
        can_roll_at = _parse_iso(player["next_roll_at"])
        if now < can_roll_at:
            wait_s = int((can_roll_at - now).total_seconds())
            raise ValueError(f"next roll available in {wait_s} seconds")

        graph = load_city_graph(game["city"])
        current_station_id = player["current_station_id"]
        if current_station_id not in graph.nodes:
            raise ValueError("invalid current station")

        choices = _choices_for_station(graph, current_station_id, selected_line_key)
        selected_line = choices["selected_line_key"]
        direction_choices: List[Dict[str, str]] = []
        direction_required = False
        if selected_line:
            current_line = player["current_line_key"]
            line_changed = (current_line is None) or (selected_line != current_line)
            direction_required = line_changed
            if line_changed:
                exclude = None if current_line is None else player["prev_station_id"]
                dir_ids = _direction_candidates(graph, current_station_id, selected_line, exclude)
                if not dir_ids:
                    dir_ids = _direction_candidates(graph, current_station_id, selected_line, None)
                direction_choices = [
                    {"station_id": sid, "name": graph.nodes[sid].name}
                    for sid in dir_ids
                    if sid in graph.nodes
                ]
        return {
            "current_station_id": current_station_id,
            "current_station_name": graph.nodes[current_station_id].name,
            "line_choices": choices["line_choices"],
            "selected_line_key": selected_line,
            "direction_required": direction_required,
            "direction_choices": direction_choices,
        }


def roll(
    user_id: int,
    game_code: str,
    selected_line_key: Optional[str],
    selected_direction_station_id: Optional[str],
) -> Dict[str, Any]:
    now = _now()
    with get_conn() as conn:
        game = conn.execute("SELECT * FROM games WHERE game_code=?", (game_code,)).fetchone()
        if not game:
            raise ValueError("game not found")

        if game["status"] != "active":
            raise ValueError("game is not started yet")

        player = conn.execute(
            "SELECT * FROM game_players WHERE game_id=? AND user_id=?",
            (game["id"], user_id),
        ).fetchone()
        if not player:
            raise ValueError("not joined")
        if bool(player["checkin_required"]):
            raise ValueError("checkin required")

        if player["finished_rank"] is not None and game["mode"] == MODE_MULTI_RACE:
            raise ValueError("already finished")

        can_roll_at = _parse_iso(player["next_roll_at"])
        if now < can_roll_at:
            wait_s = int((can_roll_at - now).total_seconds())
            raise ValueError(f"next roll available in {wait_s} seconds")

        graph = load_city_graph(game["city"])
        if player["current_station_id"] not in graph.nodes:
            raise ValueError("invalid current station")

        # 方面サイコロが必要なケースでは、方面未指定を許可しない。
        ropt = get_roll_options(user_id, game_code, selected_line_key)
        if ropt.get("direction_required") and len(ropt.get("direction_choices", [])) > 1 and not selected_direction_station_id:
            raise ValueError("direction selection required")

        first_step_station_id: Optional[str] = None
        first_step_line_key: Optional[str] = None
        if selected_direction_station_id:
            choices = _choices_for_station(graph, player["current_station_id"], selected_line_key)
            sel_line = choices["selected_line_key"]
            if sel_line and sel_line not in choices["line_choices"]:
                raise ValueError("invalid selected line")
            if sel_line:
                current_line = player["current_line_key"]
                line_changed = (current_line is None) or (sel_line != current_line)
                if line_changed:
                    exclude = None if current_line is None else player["prev_station_id"]
                    valid_dirs = set(_direction_candidates(graph, player["current_station_id"], sel_line, exclude))
                    if not valid_dirs:
                        valid_dirs = set(_direction_candidates(graph, player["current_station_id"], sel_line, None))
                    if selected_direction_station_id not in valid_dirs:
                        raise ValueError("invalid selected direction")
                    first_step_station_id = selected_direction_station_id
                    first_step_line_key = sel_line

        seed = secrets.randbits(63)
        move = simulate_roll_with_first_step(
            graph,
            station_id=player["current_station_id"],
            line_key=player["current_line_key"],
            prev_station_id=player["prev_station_id"],
            seed=seed,
            forced_first_line_key=ropt.get("selected_line_key"),
            first_step_station_id=first_step_station_id,
            first_step_line_key=first_step_line_key,
        )
        bounce_events = [e for e in move.roulette if e.get("type") == "terminal_bounce"]
        bounce_terminal_id = str(bounce_events[0]["at"]) if bounce_events else None

        # ロール後は移動先を指示するだけ。チェックインで現在地が確定する。
        conn.execute(
            """
            UPDATE game_players
            SET pending_station_id=?, pending_prev_station_id=?, pending_terminal_station_id=?, checkin_phase=?,
                pending_line_key=?, checkin_required=1
            WHERE id=?
            """,
            (
                move.final_station_id,
                move.prev_station_id_before_final,
                bounce_terminal_id,
                1,
                move.final_line_key,
                player["id"],
            ),
        )

        station_names = [graph.nodes[s].name for s in move.path]
        from_station_name = graph.nodes[player["current_station_id"]].name
        to_station_name = graph.nodes[move.final_station_id].name
        display_name = conn.execute("SELECT display_name FROM users WHERE id=?", (user_id,)).fetchone()["display_name"]
        roulette_events = [e for e in move.roulette if e.get("type") == "roulette"]
        direction_events = [e for e in move.roulette if e.get("type") == "direction_roulette"]
        direction_by_at: Dict[str, Dict[str, Any]] = {}
        for e in direction_events:
            at = str(e.get("at"))
            choices_ids = e.get("choices", []) or []
            selected_id = e.get("selected")
            direction_by_at[at] = {
                "choices": [
                    graph.nodes[sid].name
                    for sid in choices_ids
                    if sid in graph.nodes
                ],
                "selected": graph.nodes[selected_id].name if selected_id in graph.nodes else str(selected_id or ""),
            }
        roulette_summaries: List[Dict[str, Any]] = []
        for e in roulette_events:
            at_id = str(e.get("at"))
            at_name = graph.nodes.get(e["at"]).name if e.get("at") in graph.nodes else str(e.get("at"))
            choices = [_line_label(x) for x in e.get("choices", [])]
            selected = _line_label(e.get("selected", ""))
            roulette_summaries.append(
                {
                    "at_station_name": at_name,
                    "choices": choices,
                    "selected": selected,
                    "direction": direction_by_at.get(at_id),
                }
            )
            conn.execute(
                """
                INSERT INTO game_events (game_id, user_id, event_type, message, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    game["id"],
                    user_id,
                    "transfer_roulette",
                    f"{display_name}:{at_name}で路線ルーレット（{' / '.join(choices)}）→ {selected}",
                    _iso(now),
                ),
            )
        conn.execute(
            """
            INSERT INTO game_events (game_id, user_id, event_type, message, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                game["id"],
                user_id,
                "roll_move",
                f"{display_name}:{from_station_name}から{move.roll}マス {to_station_name}へ向かう",
                _iso(now),
            ),
        )
        return {
            "roll": move.roll,
            "path_station_ids": move.path,
            "path_station_names": station_names,
            "from_station_name": from_station_name,
            "roulette": move.roulette,
            "transfer_roulette_count": len(roulette_summaries),
            "transfer_roulettes": roulette_summaries,
            "terminal_bounce": (
                {
                    "terminal_station_id": bounce_terminal_id,
                    "terminal_station_name": (
                        graph.nodes[bounce_terminal_id].name
                        if bounce_terminal_id and bounce_terminal_id in graph.nodes
                        else None
                    ),
                }
                if bounce_terminal_id
                else None
            ),
            "final_station_id": move.final_station_id,
            "final_station_name": to_station_name,
            "checkin_required": True,
            "message": f"{to_station_name} 駅に向かってください",
        }


def checkin(user_id: int, game_code: str) -> Dict[str, Any]:
    now = _now()
    with get_conn() as conn:
        game = conn.execute("SELECT * FROM games WHERE game_code=?", (game_code,)).fetchone()
        if not game:
            raise ValueError("game not found")

        player = conn.execute(
            "SELECT * FROM game_players WHERE game_id=? AND user_id=?",
            (game["id"], user_id),
        ).fetchone()
        if not player:
            raise ValueError("not joined")
        if not bool(player["checkin_required"]):
            raise ValueError("no pending checkin")

        pending_station_id = player["pending_station_id"]
        pending_prev_station_id = player["pending_prev_station_id"]
        pending_terminal_station_id = player["pending_terminal_station_id"]
        pending_line_key = player["pending_line_key"]
        phase = int(player["checkin_phase"] or 0)
        if not pending_station_id:
            raise ValueError("invalid pending station")

        graph = load_city_graph(game["city"])
        display_name = conn.execute("SELECT display_name FROM users WHERE id=?", (user_id,)).fetchone()["display_name"]

        if pending_terminal_station_id and phase == 1:
            terminal_name = (
                graph.nodes[pending_terminal_station_id].name
                if pending_terminal_station_id in graph.nodes
                else pending_terminal_station_id
            )
            conn.execute(
                "UPDATE game_players SET checkin_phase=2 WHERE id=?",
                (player["id"],),
            )
            conn.execute(
                "INSERT OR IGNORE INTO visited_stations (game_id, user_id, station_id) VALUES (?, ?, ?)",
                (game["id"], user_id, pending_terminal_station_id),
            )
            conn.execute(
                """
                INSERT INTO player_position_history (game_id, user_id, station_id, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (game["id"], user_id, pending_terminal_station_id, _iso(now)),
            )
            conn.execute(
                """
                INSERT INTO game_events (game_id, user_id, event_type, message, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    game["id"],
                    user_id,
                    "checkin_terminal",
                    f"{display_name}:{terminal_name}駅へチェックイン",
                    _iso(now),
                ),
            )
            return {
                "checked_in": True,
                "phase": "terminal",
                "station_id": pending_terminal_station_id,
                "station_name": terminal_name,
                "next_checkin_station_id": pending_station_id,
                "next_checkin_station_name": (
                    graph.nodes[pending_station_id].name if pending_station_id in graph.nodes else pending_station_id
                ),
                "next_roll_in_seconds": None,
                "finished_rank": None,
            }

        next_roll_at = now + dt.timedelta(minutes=game["min_stay_minutes"])
        conn.execute(
            """
            UPDATE game_players
            SET current_station_id=?, prev_station_id=?, current_line_key=?, pending_station_id=NULL,
                pending_prev_station_id=NULL, pending_terminal_station_id=NULL, checkin_phase=0, pending_line_key=NULL,
                checkin_required=0, next_roll_at=?
            WHERE id=?
            """,
            (pending_station_id, pending_prev_station_id, pending_line_key, _iso(next_roll_at), player["id"]),
        )
        conn.execute(
            "INSERT OR IGNORE INTO visited_stations (game_id, user_id, station_id) VALUES (?, ?, ?)",
            (game["id"], user_id, pending_station_id),
        )
        conn.execute(
            """
            INSERT INTO player_position_history (game_id, user_id, station_id, created_at)
            VALUES (?, ?, ?, ?)
            """,
            (game["id"], user_id, pending_station_id, _iso(now)),
        )

        rank = None
        if bool(game["goal_enabled"]) and pending_station_id == game["goal_station_id"]:
            if game["mode"] == MODE_MULTI_RACE:
                finished_count = conn.execute(
                    "SELECT COUNT(*) AS c FROM game_players WHERE game_id=? AND finished_rank IS NOT NULL",
                    (game["id"],),
                ).fetchone()["c"]
                rank = finished_count + 1
                conn.execute(
                    "UPDATE game_players SET finished_rank=?, finished_at=? WHERE id=?",
                    (rank, _iso(now), player["id"]),
                )
            else:
                conn.execute(
                    "UPDATE game_players SET finished_rank=1, finished_at=? WHERE id=?",
                    (_iso(now), player["id"]),
                )

        checked_name = graph.nodes[pending_station_id].name if pending_station_id in graph.nodes else pending_station_id
        conn.execute(
            """
            INSERT INTO game_events (game_id, user_id, event_type, message, created_at)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                game["id"],
                user_id,
                "checkin",
                f"{display_name}:{checked_name}駅へチェックイン",
                _iso(now),
            ),
        )
        return {
            "checked_in": True,
            "station_id": pending_station_id,
            "station_name": checked_name,
            "next_roll_at": _iso(next_roll_at),
            "next_roll_in_seconds": int((next_roll_at - now).total_seconds()),
            "finished_rank": rank,
        }


def line_options(city: str) -> List[Dict[str, str]]:
    graph = load_city_graph(city)
    all_lines = sorted({line for n in graph.nodes.values() for line in n.lines})
    return [{"line_key": lk, "name": lk} for lk in all_lines]


def station_options(city: str, line_key: Optional[str] = None) -> List[Dict[str, str]]:
    graph = load_city_graph(city)
    if not line_key:
        out = [{"station_id": sid, "name": node.name} for sid, node in graph.nodes.items()]
        out.sort(key=lambda x: (x["name"], x["station_id"]))
        return out

    out_map: Dict[str, str] = {}
    point_map: Dict[str, Tuple[float, float]] = {}
    for sid, node in graph.nodes.items():
        if line_key not in node.lines:
            continue
        out_map[sid] = node.name
        point_map[sid] = (node.lat, node.lon)

    # 路線選択時は、生データから同一路線名の駅候補も併合して終端欠落を防ぐ。
    try:
        for r in line_station_candidates(city, line_key):
            if r["station_id"] not in out_map:
                out_map[r["station_id"]] = r["name"]
            if "lat" in r and "lon" in r:
                point_map[r["station_id"]] = (float(r["lat"]), float(r["lon"]))
    except ValueError:
        pass

    ordered_ids = ordered_station_ids_by_line_geometry(city, line_key, point_map)
    used = set()
    out: List[Dict[str, str]] = []
    for sid in ordered_ids:
        if sid in out_map and sid not in used:
            out.append({"station_id": sid, "name": out_map[sid]})
            used.add(sid)
    for sid in out_map.keys():
        if sid not in used:
            out.append({"station_id": sid, "name": out_map[sid]})
    return out


def random_station(city: str, seed: int) -> str:
    graph = load_city_graph(city)
    station_ids = sorted(graph.nodes.keys())
    if not station_ids:
        raise ValueError("no stations")
    return station_ids[seed % len(station_ids)]


def random_goal(city: str, start_station_id: str, seed: int) -> str:
    graph = load_city_graph(city)
    if start_station_id not in graph.nodes:
        raise ValueError("invalid start")
    station_ids = sorted(graph.nodes.keys())
    if len(station_ids) <= 1:
        raise ValueError("not enough stations")
    idx = seed % len(station_ids)
    if station_ids[idx] == start_station_id:
        idx = (idx + 1) % len(station_ids)
    return station_ids[idx]
