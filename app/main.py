from __future__ import annotations

import datetime as dt
import re
import secrets
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel, Field
from starlette.requests import Request

from .data_loader import supported_cities
from .db import get_conn, init_db
from .game_logic import (
    ALL_MODES,
    checkin,
    create_game,
    get_game_state,
    get_roll_options,
    join_game,
    line_options,
    random_station,
    random_goal,
    roll,
    start_game,
    station_options,
)

app = FastAPI(title="トレインすごろく")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")
UPLOAD_DIR = Path("static/uploads")


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def _iso(ts: dt.datetime) -> str:
    return ts.replace(microsecond=0).isoformat()


def _parse_iso(s: str) -> dt.datetime:
    return dt.datetime.fromisoformat(s)


def _email_valid(email: str) -> bool:
    return bool(re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email))


def _display_name_from_email(email: str) -> str:
    base = email.split("@")[0]
    return base[:30] if base else "player"


def _get_user_by_token(token: str) -> Optional[dict]:
    with get_conn() as conn:
        session = conn.execute("SELECT * FROM sessions WHERE token=?", (token,)).fetchone()
        if not session:
            return None
        if _parse_iso(session["expires_at"]) < _now():
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))
            return None
        user = conn.execute("SELECT * FROM users WHERE id=?", (session["user_id"],)).fetchone()
        return dict(user) if user else None


def auth_user(authorization: str = Header(default="")) -> dict:
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.replace("Bearer ", "", 1).strip()
    user = _get_user_by_token(token)
    if not user:
        raise HTTPException(status_code=401, detail="invalid session")
    return user


class RequestCodeIn(BaseModel):
    email: str


class VerifyCodeIn(BaseModel):
    email: str
    code: str


class CreateGameIn(BaseModel):
    city: str
    mode: str
    start_station_id: str
    start_random: bool = False
    goal_enabled: bool = True
    goal_station_id: Optional[str] = None
    goal_random: bool = False
    join_password: Optional[str] = None
    min_stay_minutes: int = Field(default=3, ge=0, le=120)
    max_players: int = Field(default=1, ge=1, le=20)

class JoinGameIn(BaseModel):
    join_password: Optional[str] = None

class RollIn(BaseModel):
    selected_line_key: Optional[str] = None
    selected_direction_station_id: Optional[str] = None

class UpdateProfileIn(BaseModel):
    display_name: str
    icon: Optional[str] = None


def _normalize_icon(icon: Optional[str]) -> str:
    v = (icon or "").strip()
    if not v:
        return "🚃"
    if v.startswith("http://") or v.startswith("https://") or v.startswith("/static/"):
        return v[:200]
    return v[:2]


@app.on_event("startup")
def on_startup() -> None:
    init_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request, "app_name": "トレインすごろく"})


@app.get("/api/config")
def api_config() -> Dict[str, Any]:
    return {
        "app_name": "トレインすごろく",
        "cities": supported_cities(),
        "modes": sorted(list(ALL_MODES)),
    }


@app.post("/api/auth/request-code")
def api_request_code(body: RequestCodeIn) -> Dict[str, Any]:
    email = body.email.strip().lower()
    if not _email_valid(email):
        raise HTTPException(status_code=400, detail="invalid email")

    code = f"{secrets.randbelow(10**6):06d}"
    expires = _now() + dt.timedelta(minutes=10)

    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO email_codes (email, code, expires_at)
            VALUES (?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET code=excluded.code, expires_at=excluded.expires_at, created_at=CURRENT_TIMESTAMP
            """,
            (email, code, _iso(expires)),
        )

    # 本番ではメール送信。開発簡易用にcodeを返す。
    return {
        "message": "認証コードを発行しました",
        "dev_code": code,
        "expires_at": _iso(expires),
    }


@app.post("/api/auth/verify-code")
def api_verify_code(body: VerifyCodeIn) -> Dict[str, Any]:
    email = body.email.strip().lower()
    code = body.code.strip()
    if not _email_valid(email):
        raise HTTPException(status_code=400, detail="invalid email")
    if not code:
        raise HTTPException(status_code=400, detail="code required")

    with get_conn() as conn:
        row = conn.execute("SELECT * FROM email_codes WHERE email=?", (email,)).fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="code not found")
        if row["code"] != code:
            raise HTTPException(status_code=400, detail="invalid code")
        if _parse_iso(row["expires_at"]) < _now():
            raise HTTPException(status_code=400, detail="code expired")

        user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not user:
            conn.execute(
                "INSERT INTO users (email, display_name) VALUES (?, ?)",
                (email, _display_name_from_email(email)),
            )
            user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()

        token = secrets.token_urlsafe(32)
        conn.execute(
            "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
            (token, user["id"], _iso(_now() + dt.timedelta(days=30))),
        )
        conn.execute("DELETE FROM email_codes WHERE email=?", (email,))

    return {
        "token": token,
        "user": {
            "id": user["id"],
            "email": user["email"],
            "display_name": user["display_name"],
            "icon": user["icon"] or "🚃",
        },
    }


@app.get("/api/me")
def api_me(user=Depends(auth_user)) -> Dict[str, Any]:
    return {
        "user": {
            "id": user["id"],
            "email": user["email"],
            "display_name": user["display_name"],
            "icon": user["icon"] or "🚃",
        }
    }


@app.post("/api/me/profile")
def api_update_profile(body: UpdateProfileIn, user=Depends(auth_user)) -> Dict[str, Any]:
    display_name = body.display_name.strip()
    icon = _normalize_icon(body.icon)
    if not display_name:
        raise HTTPException(status_code=400, detail="display_name is required")
    if len(display_name) > 30:
        raise HTTPException(status_code=400, detail="display_name must be <= 30 chars")
    with get_conn() as conn:
        conn.execute("UPDATE users SET display_name=?, icon=? WHERE id=?", (display_name, icon, user["id"]))
        updated = conn.execute("SELECT * FROM users WHERE id=?", (user["id"],)).fetchone()
    return {
        "user": {
            "id": updated["id"],
            "email": updated["email"],
            "display_name": updated["display_name"],
            "icon": updated["icon"] or "🚃",
        }
    }


@app.post("/api/me/icon-upload")
def api_upload_icon(file: UploadFile = File(...), user=Depends(auth_user)) -> Dict[str, Any]:
    if not file.content_type or not file.content_type.startswith("image/"):
        raise HTTPException(status_code=400, detail="image file required")
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".gif", ".webp"}:
        suffix = ".png"
    name = f"user_{user['id']}_{secrets.token_hex(8)}{suffix}"
    path = UPLOAD_DIR / name
    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="empty file")
    path.write_bytes(data)
    return {"url": f"/static/uploads/{name}"}


@app.get("/api/lines")
def api_lines(city: str, user=Depends(auth_user)) -> Dict[str, Any]:
    del user
    try:
        return {"lines": line_options(city)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/stations")
def api_stations(city: str, line_key: Optional[str] = None, user=Depends(auth_user)) -> Dict[str, Any]:
    del user
    try:
        return {"stations": station_options(city, line_key)}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/games")
def api_create_game(body: CreateGameIn, user=Depends(auth_user)) -> Dict[str, Any]:
    if body.mode not in ALL_MODES:
        raise HTTPException(status_code=400, detail="unsupported mode")

    goal_enabled = body.goal_enabled and body.mode != "solo_endless"
    start_station_id = body.start_station_id
    goal_station_id = body.goal_station_id

    try:
        if body.start_random:
            start_station_id = random_station(body.city, secrets.randbits(63))
        if goal_enabled and body.goal_random:
            goal_station_id = random_goal(body.city, start_station_id, secrets.randbits(63))

        out = create_game(
            user_id=user["id"],
            city=body.city,
            mode=body.mode,
            start_station_id=start_station_id,
            goal_station_id=goal_station_id,
            goal_enabled=goal_enabled,
            min_stay_minutes=body.min_stay_minutes,
            max_players=body.max_players,
            join_password=body.join_password,
        )
        return out
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/games/{game_code}/join")
def api_join_game(game_code: str, body: JoinGameIn, user=Depends(auth_user)) -> Dict[str, Any]:
    try:
        join_game(user["id"], game_code, body.join_password)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.post("/api/games/{game_code}/start")
def api_start_game(game_code: str, user=Depends(auth_user)) -> Dict[str, Any]:
    try:
        start_game(user["id"], game_code)
        return {"ok": True}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/games/{game_code}")
def api_game_state(game_code: str, user=Depends(auth_user)) -> Dict[str, Any]:
    try:
        return get_game_state(user["id"], game_code)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

@app.get("/api/games/{game_code}/roll-options")
def api_roll_options(game_code: str, selected_line_key: Optional[str] = None, user=Depends(auth_user)) -> Dict[str, Any]:
    try:
        return get_roll_options(user["id"], game_code, selected_line_key)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/games/{game_code}/roll")
def api_roll(game_code: str, body: RollIn, user=Depends(auth_user)) -> Dict[str, Any]:
    try:
        return roll(
            user["id"],
            game_code,
            selected_line_key=body.selected_line_key,
            selected_direction_station_id=body.selected_direction_station_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/games/{game_code}/checkin")
def api_checkin(game_code: str, user=Depends(auth_user)) -> Dict[str, Any]:
    try:
        return checkin(user["id"], game_code)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
