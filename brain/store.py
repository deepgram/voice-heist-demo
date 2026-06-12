"""SQLite persistence for Voice Heist (players + plays).

The schema lives in `schema.sql` (single source of truth); `init_db()` applies it
on startup and runs a tiny additive migration so an already-populated DB picks up
new columns. One warm Fly machine + conference scale means a single shared
connection (WAL mode) is plenty; writes are guarded by a lock.

Identity converges on `code` — the short credential a player uses to sign in at
the shared booth kiosk. `plays` records scores, powers returning-player lookup,
and enforces the one-play-per-scenario-per-day limit via a UNIQUE constraint.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from agents import LEVEL_ORDER, MAX_TURNS

ALL_SCENARIOS = list(LEVEL_ORDER)

SCHEMA_PATH = Path(__file__).resolve().parent / "schema.sql"
DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "voice-heist.db"

# Unambiguous alphabet for player codes (no 0/O/1/I/L) so they're easy to read
# off a phone screen and type at the booth.
_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
_CODE_LEN = 5

_conn: sqlite3.Connection | None = None
_lock = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def event_day() -> str:
    """Today's date in the event timezone — 'today' flips at local midnight.
    (In the booth build this lived in auth.py; the demo keeps it here.)"""
    tz = os.environ.get("EVENT_TZ", "America/New_York")
    return datetime.now(ZoneInfo(tz)).strftime("%Y-%m-%d")


def _db_path() -> str:
    return os.environ.get("VH_DB_PATH") or str(DEFAULT_DB_PATH)


def init_db() -> None:
    """Open the connection and apply schema.sql. Safe to call once at startup."""
    global _conn
    _conn = sqlite3.connect(_db_path(), check_same_thread=False)
    _conn.row_factory = sqlite3.Row
    _conn.executescript(SCHEMA_PATH.read_text())
    _migrate()
    _conn.commit()
    _load_settings()
    _seed_settings()
    _seed_test_player()


def _migrate() -> None:
    """Additively add any columns missing from an older DB (no-op on a fresh one)."""
    assert _conn is not None
    wanted = {
        "players": {
            "auth_provider": "TEXT",
            "provider_sub": "TEXT",
            "name": "TEXT",
            "email": "TEXT",
            "email_verified": "INTEGER NOT NULL DEFAULT 0",
            "consent_at": "TEXT",
            "handle": "TEXT",
        },
        "plays": {
            "mode": "TEXT NOT NULL DEFAULT 'booth'",
            "path": "TEXT",
            "score": "INTEGER",
        },
    }
    for table, cols in wanted.items():
        have = {r["name"] for r in _conn.execute(f"PRAGMA table_info({table})")}
        for col, ddl in cols.items():
            if col not in have:
                _conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def _player_row_to_dict(row: sqlite3.Row | None) -> dict | None:
    return dict(row) if row is not None else None


def _gen_code() -> str:
    return "".join(secrets.choice(_CODE_ALPHABET) for _ in range(_CODE_LEN))


# Fun, stable display name derived from the (unique) login code, so the public
# leaderboard shows "Crimson Fox 42" instead of a raw login credential.
# Deterministic — no storage or migration, and a code always maps to one codename.
_CODENAME_ADJ = [
    "Crimson", "Silver", "Midnight", "Golden", "Shadow", "Electric", "Velvet",
    "Cosmic", "Rapid", "Silent", "Neon", "Iron", "Lucky", "Turbo", "Mellow",
    "Royal", "Frost", "Amber", "Jade", "Scarlet", "Vivid", "Stealth", "Brave", "Quantum",
]
_CODENAME_NOUN = [
    "Fox", "Falcon", "Otter", "Wolf", "Comet", "Raven", "Tiger", "Koala",
    "Phoenix", "Lynx", "Bison", "Heron", "Cobra", "Panda", "Hawk", "Mantis",
    "Marlin", "Badger", "Jaguar", "Dragon", "Sparrow", "Walrus", "Gecko", "Orca",
]


def codename_for(code: str) -> str:
    """Deterministic public codename for a login code, e.g. 'Crimson Fox 42'."""
    h = hashlib.sha256((code or "").encode()).digest()
    adj = _CODENAME_ADJ[h[0] % len(_CODENAME_ADJ)]
    noun = _CODENAME_NOUN[h[1] % len(_CODENAME_NOUN)]
    return f"{adj} {noun} {h[2] % 100:02d}"


def _insert_player(tier: str, **fields) -> dict:
    """Insert a player, retrying on the rare code collision."""
    assert _conn is not None
    pid = str(uuid.uuid4())
    now = _now()
    for _ in range(10):
        code = _gen_code()
        try:
            with _lock:
                _conn.execute(
                    """INSERT INTO players
                       (pid, code, tier, handle, auth_provider, provider_sub,
                        name, email, email_verified, consent_at, created_at, last_seen)
                       VALUES (:pid, :code, :tier, :handle, :auth_provider, :provider_sub,
                               :name, :email, :email_verified, :consent_at, :created_at, :last_seen)""",
                    {
                        "pid": pid,
                        "code": code,
                        "tier": tier,
                        "handle": fields.get("handle"),
                        "auth_provider": fields.get("auth_provider"),
                        "provider_sub": fields.get("provider_sub"),
                        "name": fields.get("name"),
                        "email": fields.get("email"),
                        "email_verified": 1 if fields.get("email_verified") else 0,
                        "consent_at": fields.get("consent_at"),
                        "created_at": now,
                        "last_seen": now,
                    },
                )
                _conn.commit()
            return get_player_by_pid(pid)  # type: ignore[return-value]
        except sqlite3.IntegrityError as e:
            if "players.code" in str(e):
                continue  # code collision — try another
            raise
    raise RuntimeError("could not generate a unique player code")


# ---- sign-in tiers --------------------------------------------------------
def create_quick_player(handle: str) -> dict:
    return _insert_player("quick", handle=handle.strip()[:24] or "Player")


def create_staff_player(name: str | None, company: str | None = None) -> dict:
    return _insert_player("staff", name=(name or "").strip()[:64] or None)


def create_user(first: str, last: str, email: str) -> dict:
    """Admin-created player (first/last/email). Tier 'staff'; not email-verified
    (no OAuth). Returns the player incl. the generated code to hand to them."""
    name = f"{first.strip()} {last.strip()}".strip()
    handle = (first.strip() or name)[:24] or "Player"
    return _insert_player("staff", handle=handle, name=name or None,
                          email=(email.strip() or None))


def ensure_test_player(code: str) -> dict:
    """Idempotently create a tier='test' player whose login code IS `code`.
    Test players get unlimited turns + replays and never appear on the
    leaderboard — seeded from VH_TEST_CODE for internal testing. Because the
    test code is a normal login code, the regular code sign-in just works."""
    assert _conn is not None
    code = code.strip().upper()
    existing = get_player_by_code(code)
    if existing:
        return existing
    pid = str(uuid.uuid4())
    now = _now()
    with _lock:
        _conn.execute(
            """INSERT INTO players (pid, code, tier, handle, name,
                                    email_verified, created_at, last_seen)
               VALUES (?, ?, 'test', 'Tester', 'Test Player', 0, ?, ?)""",
            (pid, code, now, now),
        )
        _conn.commit()
    return get_player_by_pid(pid)  # type: ignore[return-value]


def upsert_oauth_player(
    provider: str, sub: str, email: str | None, email_verified: bool,
    name: str | None, consent: bool = False,
) -> dict:
    """Create-or-return a player keyed by (provider, sub). Verified-identity dedup."""
    assert _conn is not None
    row = _conn.execute(
        "SELECT * FROM players WHERE auth_provider = ? AND provider_sub = ?",
        (provider, sub),
    ).fetchone()
    if row is not None:
        with _lock:
            _conn.execute(
                "UPDATE players SET last_seen = ?, email = COALESCE(?, email), name = COALESCE(?, name) WHERE pid = ?",
                (_now(), email, name, row["pid"]),
            )
            _conn.commit()
        return get_player_by_pid(row["pid"])  # type: ignore[return-value]
    return _insert_player(
        "oauth", auth_provider=provider, provider_sub=sub, email=email,
        email_verified=email_verified, name=name,
        consent_at=_now() if consent else None,
    )


# ---- lookups --------------------------------------------------------------
def get_player_by_code(code: str) -> dict | None:
    assert _conn is not None
    row = _conn.execute(
        "SELECT * FROM players WHERE code = ?", (code.strip().upper(),)
    ).fetchone()
    return _player_row_to_dict(row)


def get_player_by_pid(pid: str) -> dict | None:
    assert _conn is not None
    row = _conn.execute("SELECT * FROM players WHERE pid = ?", (pid,)).fetchone()
    return _player_row_to_dict(row)


def touch_last_seen(pid: str) -> None:
    assert _conn is not None
    with _lock:
        _conn.execute("UPDATE players SET last_seen = ? WHERE pid = ?", (_now(), pid))
        _conn.commit()


# ---- plays / daily limit --------------------------------------------------
def record_play(pid: str, scenario: str, event_day: str, outcome: str,
                path: str | None, mode: str = "booth", score: int | None = None) -> None:
    """Record a completed heist. INSERT OR IGNORE respects the one-per-day UNIQUE."""
    assert _conn is not None
    with _lock:
        _conn.execute(
            """INSERT OR IGNORE INTO plays
               (pid, scenario, event_day, mode, outcome, path, score, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (pid, scenario, event_day, mode, outcome, path, score, _now()),
        )
        _conn.commit()


def played_today(pid: str, event_day: str) -> dict[str, str]:
    """Scenarios this player already completed today → their outcome.
    Used to lock replays and to restore prior results for a returning player."""
    assert _conn is not None
    rows = _conn.execute(
        "SELECT scenario, outcome FROM plays WHERE pid = ? AND event_day = ?",
        (pid, event_day),
    ).fetchall()
    return {r["scenario"]: r["outcome"] for r in rows}


def player_day_total(pid: str, event_day: str) -> int:
    """Sum of a player's scored plays for the event day — their running total."""
    assert _conn is not None
    row = _conn.execute(
        "SELECT COALESCE(SUM(score), 0) AS total FROM plays "
        "WHERE pid = ? AND event_day = ? AND score IS NOT NULL",
        (pid, event_day),
    ).fetchone()
    return int(row["total"]) if row else 0


# ---- leaderboard (public) + daily winners (admin) -------------------------
# Ranking is by each player's TOTAL score for a given event day (summed across
# the scenarios they played). Test players and unscored plays are excluded.
_DAILY_TOTALS_SQL = """
    SELECT p.code AS code, p.name AS name, p.email AS email,
           pl.event_day AS day, SUM(pl.score) AS total
    FROM plays pl JOIN players p ON p.pid = pl.pid
    WHERE pl.score IS NOT NULL AND p.tier != 'test'
    GROUP BY pl.pid, pl.event_day
    ORDER BY pl.event_day DESC, total DESC
"""


def leaderboard(max_per_day: int = 100) -> list[dict]:
    """Public board: every event day (newest first), each with players ranked by
    their day's total. Codenames only — never PII. The page renders one section
    per day, so the board accumulates rather than resetting."""
    assert _conn is not None
    rows = _conn.execute(_DAILY_TOTALS_SQL).fetchall()
    days: dict[str, list[dict]] = {}
    order: list[str] = []
    for r in rows:
        if r["day"] not in days:
            days[r["day"]] = []
            order.append(r["day"])
        bucket = days[r["day"]]
        if len(bucket) < max_per_day:
            bucket.append({"rank": len(bucket) + 1,
                           "codename": codename_for(r["code"]),
                           "score": r["total"]})
    return [{"day": d, "entries": days[d]} for d in order]


def daily_winners() -> list[dict]:
    """Admin view: the top scorer per event day WITH contact details, so staff
    can notify them manually. Newest day first. Excludes test players."""
    assert _conn is not None
    rows = _conn.execute(_DAILY_TOTALS_SQL).fetchall()
    winners: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        if r["day"] in seen:
            continue  # rows are day-desc, total-desc, so the first per day wins
        seen.add(r["day"])
        winners.append({"day": r["day"], "codename": codename_for(r["code"]),
                        "name": r["name"], "email": r["email"], "score": r["total"]})
    return winners


# ---- runtime settings (admin-controlled operational config) ---------------
# The admin portal edits availability / gate epoch / site password at runtime.
# verify_gate() reads the epoch on a very hot path, so cache settings briefly
# and refresh immediately on any write.
_SETTINGS_TTL = 5.0
_settings_cache: dict[str, str] = {}
_settings_loaded_at = 0.0


def _load_settings() -> None:
    global _settings_loaded_at
    assert _conn is not None
    rows = _conn.execute("SELECT key, value FROM settings").fetchall()
    _settings_cache.clear()
    for r in rows:
        _settings_cache[r["key"]] = r["value"]
    _settings_loaded_at = time.monotonic()


def _get_setting(key: str) -> str | None:
    if time.monotonic() - _settings_loaded_at > _SETTINGS_TTL:
        with _lock:
            _load_settings()
    return _settings_cache.get(key)


def _set_setting(key: str, value: str) -> None:
    assert _conn is not None
    with _lock:
        _conn.execute(
            """INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at""",
            (key, value, _now()),
        )
        _conn.commit()
        _load_settings()  # refresh cache so the change is visible immediately


def _seed_settings() -> None:
    """First-boot defaults from env; thereafter the DB (portal) is authoritative."""
    assert _conn is not None
    have = {r["key"] for r in _conn.execute("SELECT key FROM settings")}
    if "available" not in have:
        raw = os.environ.get("VOICE_HEIST_AVAILABLE")
        avail = [s.strip() for s in raw.split(",")] if raw else list(ALL_SCENARIOS)
        _set_setting("available", json.dumps([g for g in ALL_SCENARIOS if g in avail]))
    if "gate_epoch" not in have:
        _set_setting("gate_epoch", os.environ.get("GATE_EPOCH", "1"))
    if "site_password" not in have:
        _set_setting("site_password", _hash_password(os.environ.get("SITE_PASSWORD", "voiceheist")))
    if "turns" not in have:
        _set_setting("turns", json.dumps({g: MAX_TURNS for g in ALL_SCENARIOS}))


def _seed_test_player() -> None:
    """Seed the unlimited test player from VH_TEST_CODE, if configured."""
    code = (os.environ.get("VH_TEST_CODE") or "").strip().upper()
    if code:
        ensure_test_player(code)


# ---- typed accessors used by app.py / auth.py / admin.py ------------------
def get_available() -> list[str]:
    raw = _get_setting("available")
    try:
        want = set(json.loads(raw)) if raw else set(ALL_SCENARIOS)
    except (ValueError, TypeError):
        want = set(ALL_SCENARIOS)
    return [g for g in ALL_SCENARIOS if g in want]  # keep canonical order


def set_available(scenarios: list[str]) -> list[str]:
    clean = [g for g in ALL_SCENARIOS if g in set(scenarios)]
    _set_setting("available", json.dumps(clean))
    return clean


# ---- turns per game (admin-controlled, live) ------------------------------
_TURNS_MIN, _TURNS_MAX = 1, 20


def _clamp_turns(n: int) -> int:
    return max(_TURNS_MIN, min(_TURNS_MAX, n))


def get_turns() -> dict[str, int]:
    """Per-scenario turn cap, admin-editable live. Missing/invalid entries fall
    back to MAX_TURNS; values are clamped to a sane range."""
    raw = _get_setting("turns")
    try:
        stored = json.loads(raw) if raw else {}
    except (ValueError, TypeError):
        stored = {}
    out = {}
    for g in ALL_SCENARIOS:
        try:
            out[g] = _clamp_turns(int(stored.get(g, MAX_TURNS)))
        except (ValueError, TypeError):
            out[g] = MAX_TURNS
    return out


def set_turns(turns: dict) -> dict[str, int]:
    """Merge admin-provided per-scenario turn caps (clamped) and persist."""
    current = get_turns()
    for g, v in (turns or {}).items():
        if g in current:
            try:
                current[g] = _clamp_turns(int(v))
            except (ValueError, TypeError):
                pass
    _set_setting("turns", json.dumps(current))
    return current


def get_gate_epoch() -> int:
    try:
        return int(_get_setting("gate_epoch") or "1")
    except ValueError:
        return 1


def bump_gate_epoch() -> int:
    nxt = get_gate_epoch() + 1
    _set_setting("gate_epoch", str(nxt))
    return nxt


def verify_site_password(pw: str) -> bool:
    stored = _get_setting("site_password")
    return _check_password(pw, stored) if stored else False


def set_site_password(pw: str) -> None:
    _set_setting("site_password", _hash_password(pw))


# ---- password hashing (PBKDF2, stdlib) ------------------------------------
def _hash_password(pw: str, *, salt: bytes | None = None, iterations: int = 100_000) -> str:
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, iterations)
    return f"{iterations}${salt.hex()}${dk.hex()}"


def _check_password(pw: str, stored: str) -> bool:
    try:
        iters, salt_hex, hash_hex = stored.split("$")
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt_hex), int(iters))
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


# ---- admin audit ----------------------------------------------------------
def record_audit(email: str, action: str, detail: str | None = None, ip: str | None = None) -> None:
    assert _conn is not None
    with _lock:
        _conn.execute(
            "INSERT INTO admin_audit (email, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)",
            (email, action, detail, ip, _now()),
        )
        _conn.commit()


# ---- read-only table browsing (admin data scanner) -----------------------
# Values that should never be shown even to an admin (credential-derived).
_REDACT = {("settings", "value"): lambda row: "(hidden)" if row.get("key") == "site_password" else None}


def _user_tables() -> set[str]:
    assert _conn is not None
    rows = _conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).fetchall()
    return {r["name"] for r in rows}


def list_tables() -> list[dict]:
    """Table names + row counts for the admin data section."""
    assert _conn is not None
    out = []
    for name in sorted(_user_tables()):
        cnt = _conn.execute(f'SELECT COUNT(*) AS c FROM "{name}"').fetchone()["c"]
        out.append({"name": name, "count": cnt})
    return out


def table_data(table: str, limit: int = 100, offset: int = 0) -> dict | None:
    """Rows of one table (most-recent first), paginated. Returns None if the
    table isn't a real user table. Table name is validated against the live
    schema whitelist before it's ever interpolated into SQL."""
    assert _conn is not None
    if table not in _user_tables():
        return None
    limit = max(1, min(int(limit), 500))
    offset = max(0, int(offset))
    total = _conn.execute(f'SELECT COUNT(*) AS c FROM "{table}"').fetchone()["c"]
    cur = _conn.execute(
        f'SELECT * FROM "{table}" ORDER BY rowid DESC LIMIT ? OFFSET ?', (limit, offset)
    )
    columns = [d[0] for d in cur.description]
    rows = []
    for r in cur.fetchall():
        record = dict(r)
        for (tbl, col), fn in _REDACT.items():
            if tbl == table and col in record:
                masked = fn(record)
                if masked is not None:
                    record[col] = masked
        rows.append([record[c] for c in columns])
    return {"columns": columns, "rows": rows, "total": total, "limit": limit, "offset": offset}
