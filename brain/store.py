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
import json
import os
import secrets
import sqlite3
import threading
import time
import uuid
from datetime import date as _dt_date, datetime, timedelta, timezone
from pathlib import Path

from agents import LEVELS, LEVEL_ORDER, MAX_TURNS

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
            # Durable browser identity (vh_device cookie) — daily locks anchor
            # here so "Start over" can't reset them with a fresh pid.
            "device_id": "TEXT",
            # JSON audit blob itemizing how the score was built (base, turn
            # bonus, streak bonus, sweep bonus, retry) so a 2,500-point play is
            # legible in the admin views. Display-only; nothing computes from it.
            "detail": "TEXT",
            # The player's own lines for the heist, newline-joined. Prize-audit
            # trail: weekly winners are verified by reading how the score was
            # earned (judge-injection is the cheat vector, not multi-accounting).
            "transcript": "TEXT",
        },
    }
    for table, cols in wanted.items():
        have = {r["name"] for r in _conn.execute(f"PRAGMA table_info({table})")}
        for col, ddl in cols.items():
            if col not in have:
                _conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")


def backup_db(dest_dir: str | Path, keep: int = 28) -> Path:
    """Consistent online snapshot via SQLite's backup API, pruned to the newest
    `keep` files. Corruption/fat-finger insurance on the same volume; offsite
    replication is Litestream's job (see entrypoint.sh). Called periodically
    from app.py; holding _lock means the copy sees no concurrent writes."""
    assert _conn is not None
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / f"voice-heist-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}.db"
    with _lock:
        target = sqlite3.connect(out)
        try:
            _conn.backup(target)
        finally:
            target.close()
    for old in sorted(dest.glob("voice-heist-*.db"))[:-keep]:
        old.unlink(missing_ok=True)
    return out


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
def create_quick_player(handle: str, email: str | None = None) -> dict:
    # Email is optional (quick walk-up play); store it when given so these players
    # can still get prize/contact follow-up like registered ones. Not verified.
    email = (email or "").strip()[:120] or None
    return _insert_player("quick", handle=handle.strip()[:24] or "Player", email=email)


def create_anon_player() -> dict:
    """One-tap 'Just play' — no handle, no email, nothing typed. Plays are still
    recorded against the pid (turn caps etc. work), but tier 'anon' is excluded
    from the public leaderboard and daily winners."""
    return _insert_player("anon", handle="Guest")


def claim_player(pid: str, handle: str, email: str | None = None) -> dict | None:
    """Promote an anonymous player onto the leaderboard IN PLACE: same pid — so
    every play already recorded today surfaces on the board the moment the tier
    flips — with tier 'quick' and the handle they just picked. Refuses (returns
    None) unless the row is still tier 'anon', so it can't rewrite a registered
    player."""
    assert _conn is not None
    with _lock:
        cur = _conn.execute(
            """UPDATE players SET tier = 'quick', handle = ?,
                      email = COALESCE(?, email), last_seen = ?
               WHERE pid = ? AND tier = 'anon'""",
            (handle.strip()[:24] or "Player", email, _now(), pid),
        )
        _conn.commit()
    if cur.rowcount == 0:
        return None
    return get_player_by_pid(pid)


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
                path: str | None, mode: str = "booth", score: int | None = None,
                device_id: str | None = None, detail: str | None = None,
                transcript: str | None = None, allow_upgrade: bool = False) -> None:
    """Record a completed heist. INSERT OR IGNORE respects the one-per-day UNIQUE.

    `allow_upgrade` is the earned-retry path: a retry WIN replaces the original
    lose row in place (outcome, path, score, created_at — the total was genuinely
    reached at retry time, which is what the rank tie-break keys on). A retry
    that busts again writes NOTHING — the original row, and its points, stand."""
    assert _conn is not None
    with _lock:
        if allow_upgrade:
            if outcome != "win":
                return  # failed retry: the first attempt's row is the record
            cur = _conn.execute(
                """UPDATE plays SET outcome = ?, path = ?, score = ?, detail = ?,
                       transcript = ?, created_at = ?
                   WHERE pid = ? AND scenario = ? AND event_day = ? AND outcome = 'lose'""",
                (outcome, path, score, detail, transcript, _now(), pid, scenario, event_day),
            )
            if cur.rowcount:
                _conn.commit()
                return
            # No lose row under THIS pid (the bust happened under a previous pid
            # on the same device) — fall through and insert normally.
        _conn.execute(
            """INSERT OR IGNORE INTO plays
               (pid, scenario, event_day, mode, outcome, path, score, device_id,
                detail, transcript, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (pid, scenario, event_day, mode, outcome, path, score, device_id,
             detail, transcript, _now()),
        )
        _conn.commit()


def played_today(pid: str, event_day: str, device_id: str | None = None) -> dict[str, str]:
    """Scenarios already completed today → their outcome, by this player OR by
    any player on the same device. The device leg is what makes daily locks
    survive "Start over" (a fresh anonymous pid on the same browser inherits
    them). Used to lock replays and to restore results for a returning player."""
    assert _conn is not None
    rows = _conn.execute(
        """SELECT scenario, outcome FROM plays
           WHERE event_day = ?
             AND (pid = ? OR (? IS NOT NULL AND device_id = ?))
           ORDER BY created_at ASC""",
        (event_day, pid, device_id, device_id),
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


def player_best_day(pid: str, before_day: str | None = None) -> dict | None:
    """A player's best single-day total ({day, total}), optionally only from
    days strictly BEFORE `before_day` (to detect a new personal best)."""
    assert _conn is not None
    row = _conn.execute(
        """SELECT event_day AS day, SUM(score) AS total FROM plays
           WHERE pid = ? AND score IS NOT NULL
             AND (? IS NULL OR event_day < ?)
           GROUP BY event_day ORDER BY total DESC, event_day DESC LIMIT 1""",
        (pid, before_day, before_day),
    ).fetchone()
    return {"day": row["day"], "total": int(row["total"])} if row else None


def day_streak(pid: str, up_to_day: str) -> int:
    """Consecutive event days with at least one play, ending exactly at
    `up_to_day` (0 if that day has no play). Derived fresh from history each
    call — no stored counter to corrupt, self-heals after admin deletions."""
    assert _conn is not None
    rows = _conn.execute(
        "SELECT DISTINCT event_day FROM plays WHERE pid = ? AND event_day <= ?",
        (pid, up_to_day),
    ).fetchall()
    days = {r["event_day"] for r in rows}
    try:
        d = _dt_date.fromisoformat(up_to_day)
    except ValueError:
        return 0
    streak = 0
    while d.isoformat() in days:
        streak += 1
        d -= timedelta(days=1)
    return streak


# ---- earned retry (one second chance per player per event day) ------------
def retry_used_today(pid: str, event_day: str, device_id: str | None = None) -> str | None:
    """The scenario this player (or this device — same anchoring as the daily
    locks) already spent today's second chance on, or None if it's unspent."""
    assert _conn is not None
    row = _conn.execute(
        """SELECT scenario FROM retries
           WHERE event_day = ?
             AND (pid = ? OR (? IS NOT NULL AND device_id = ?))
           LIMIT 1""",
        (event_day, pid, device_id, device_id),
    ).fetchone()
    return row["scenario"] if row else None


def record_retry_start(pid: str, scenario: str, event_day: str,
                       device_id: str | None = None) -> bool:
    """Durably spend today's second chance the moment the retry actually starts.
    Returns False if it was already spent (pid or device) — a lost race or a
    farming attempt; the caller proceeds either way, the play just can't mint
    another token."""
    assert _conn is not None
    with _lock:
        row = _conn.execute(
            """SELECT 1 FROM retries
               WHERE event_day = ?
                 AND (pid = ? OR (? IS NOT NULL AND device_id = ?))
               LIMIT 1""",
            (event_day, pid, device_id, device_id),
        ).fetchone()
        if row:
            return False
        try:
            _conn.execute(
                """INSERT INTO retries (pid, device_id, event_day, scenario, created_at)
                   VALUES (?, ?, ?, ?, ?)""",
                (pid, device_id, event_day, scenario, _now()),
            )
            _conn.commit()
        except sqlite3.IntegrityError:
            return False  # UNIQUE(pid, event_day) — lost a race to ourselves
    return True


# ---- leaderboard (public, daily) + all-time podium + weekly winners --------
# The PUBLIC board ranks each player's TOTAL score per event day; the landing
# page additionally shows the top single-day totals EVER (the all-time podium).
# Admin winners stay weekly (Mon–Sun) to match the "top weekly scorers get the prize"
# promise. Test players, anonymous players (they never signed in, so there's
# nobody to attribute or contact), and unscored plays are excluded everywhere.
# Ties are broken deterministically: whoever REACHED their total first (earliest
# final play) ranks higher — so a winner is never SQLite row order.
_DAILY_TOTALS_SQL = """
    SELECT pl.pid AS pid, p.code AS code, p.name AS name, p.email AS email,
           pl.event_day AS day, SUM(pl.score) AS total
    FROM plays pl JOIN players p ON p.pid = pl.pid
    WHERE pl.score IS NOT NULL AND p.tier NOT IN ('test', 'anon')
    GROUP BY pl.pid, pl.event_day
    ORDER BY pl.event_day DESC, total DESC, MAX(pl.created_at) ASC
"""


def day_rank(event_day: str, total: int, pid: str | None = None) -> int:
    """Rank a day total against the ranked (non-test, non-anon) field, with the
    SAME tie semantics as the public board (_DAILY_TOTALS_SQL): a tied total
    outranks this one only if it was reached earlier (MAX(created_at), the time
    of the final play). Pass the player's own pid so their rows are excluded and
    their final-play time anchors the tiebreak; for an anonymous would-be rank
    leave pid None — that score isn't on the board yet, so any existing tie
    counts as ahead of it. Keeping these aligned means a "NEW HIGH SCORE" card
    can never contradict the public board."""
    assert _conn is not None
    own_ts = None
    if pid:
        row = _conn.execute(
            "SELECT MAX(created_at) AS ts FROM plays "
            "WHERE pid = ? AND event_day = ? AND score IS NOT NULL",
            (pid, event_day),
        ).fetchone()
        own_ts = row["ts"] if row else None
    row = _conn.execute(
        """SELECT COUNT(*) AS n FROM (
               SELECT pl.pid AS opid, SUM(pl.score) AS t,
                      MAX(pl.created_at) AS ts
               FROM plays pl JOIN players p ON p.pid = pl.pid
               WHERE pl.event_day = :day AND pl.score IS NOT NULL
                 AND p.tier NOT IN ('test', 'anon')
                 AND pl.pid != COALESCE(:pid, '')
               GROUP BY pl.pid
               HAVING t > :total
                  OR (t = :total AND ts <= COALESCE(:own_ts, ts)))""",
        {"day": event_day, "pid": pid, "total": total, "own_ts": own_ts},
    ).fetchone()
    return int(row["n"]) + 1


def day_rival(event_day: str, total: int, pid: str | None = None) -> dict | None:
    """The NEAREST player ahead of a day total on the board — the one to chase.
    Same tie semantics (and same own-timestamp anchor) as day_rank, so "300
    behind Crimson Fox 42" always agrees with the rank shown beside it. Returns
    {codename, gap} or None when the total leads the day."""
    assert _conn is not None
    own_ts = None
    if pid:
        row = _conn.execute(
            "SELECT MAX(created_at) AS ts FROM plays "
            "WHERE pid = ? AND event_day = ? AND score IS NOT NULL",
            (pid, event_day),
        ).fetchone()
        own_ts = row["ts"] if row else None
    row = _conn.execute(
        """SELECT p.code AS code, SUM(pl.score) AS t, MAX(pl.created_at) AS ts
           FROM plays pl JOIN players p ON p.pid = pl.pid
           WHERE pl.event_day = :day AND pl.score IS NOT NULL
             AND p.tier NOT IN ('test', 'anon')
             AND pl.pid != COALESCE(:pid, '')
           GROUP BY pl.pid
           HAVING t > :total
              OR (t = :total AND ts <= COALESCE(:own_ts, ts))
           ORDER BY t ASC, ts DESC
           LIMIT 1""",
        {"day": event_day, "pid": pid, "total": total, "own_ts": own_ts},
    ).fetchone()
    if row is None:
        return None
    return {"codename": codename_for(row["code"]), "gap": int(row["t"]) - int(total)}


def all_time_top(n: int = 3) -> list[dict]:
    """The best single-day totals EVER — the landing page's all-time podium.
    The same player may hold more than one spot (two legendary days both
    count), exactly like an arcade cabinet's initials board."""
    assert _conn is not None
    rows = _conn.execute(
        """SELECT p.code AS code, pl.event_day AS day, SUM(pl.score) AS total
           FROM plays pl JOIN players p ON p.pid = pl.pid
           WHERE pl.score IS NOT NULL AND p.tier NOT IN ('test', 'anon')
           GROUP BY pl.pid, pl.event_day
           ORDER BY total DESC, MAX(pl.created_at) ASC
           LIMIT ?""",
        (n,),
    ).fetchall()
    return [{"rank": i + 1, "codename": codename_for(r["code"]),
             "score": r["total"], "day": r["day"]} for i, r in enumerate(rows)]


# Weekly (Mon–Sun) totals power the ADMIN winners view only — the prize is weekly.
# `date(event_day, 'weekday 0', '-6 days')` is SQLite for "Monday of that week".
_WEEKLY_TOTALS_SQL = """
    SELECT p.code AS code, p.name AS name, p.email AS email,
           date(pl.event_day, 'weekday 0', '-6 days') AS week, SUM(pl.score) AS total
    FROM plays pl JOIN players p ON p.pid = pl.pid
    WHERE pl.score IS NOT NULL AND p.tier NOT IN ('test', 'anon')
    GROUP BY pl.pid, week
    ORDER BY week DESC, total DESC, MAX(pl.created_at) ASC
"""


def board_badges(today: str | None = None) -> dict[tuple[str, str], list[str]]:
    """Per-(day, pid) badge lists for the public board — earned flair that also
    advertises the mechanics. Derived from plays.detail; display-only.
      'sweep'    — cracked every available heist that day (sweep bonus paid)
      'fast'     — the day's biggest turns-to-spare win (one holder per day)
      'streak:N' — today's rows only: N >= 2 consecutive days with a play"""
    assert _conn is not None
    badges: dict[tuple[str, str], list[str]] = {}

    def add(day: str, pid: str, badge: str) -> None:
        badges.setdefault((day, pid), []).append(badge)

    for r in _conn.execute(
        "SELECT pid, event_day FROM plays "
        "WHERE detail IS NOT NULL AND json_extract(detail, '$.sweep_bonus') > 0"
    ):
        add(r["event_day"], r["pid"], "sweep")

    # Fastest crack per day: largest turn bonus among wins; ties to the earliest.
    best: dict[str, tuple[int, str, str]] = {}
    for r in _conn.execute(
        "SELECT pid, event_day, created_at, "
        "CAST(json_extract(detail, '$.turn_bonus') AS INTEGER) AS tb "
        "FROM plays WHERE outcome = 'win' AND detail IS NOT NULL "
        "AND json_extract(detail, '$.turn_bonus') > 0"
    ):
        cur = best.get(r["event_day"])
        if cur is None or r["tb"] > cur[0] or (r["tb"] == cur[0] and r["created_at"] < cur[1]):
            best[r["event_day"]] = (r["tb"], r["created_at"], r["pid"])
    for day, (_tb, _ts, pid) in best.items():
        add(day, pid, "fast")

    if today:
        per_pid: dict[str, set[str]] = {}
        for r in _conn.execute("SELECT DISTINCT pid, event_day FROM plays"):
            per_pid.setdefault(r["pid"], set()).add(r["event_day"])
        for pid, days in per_pid.items():
            if today not in days:
                continue
            n = 0
            try:
                d = _dt_date.fromisoformat(today)
            except ValueError:
                break
            while d.isoformat() in days:
                n += 1
                d -= timedelta(days=1)
            if n >= 2:
                add(today, pid, f"streak:{n}")
    return badges


def leaderboard(today: str | None = None, max_per_day: int = 100) -> list[dict]:
    """Public board: every event day (newest first), each with players ranked by
    their day's total. Codenames only — never PII. The page renders one section
    per day, so the board accumulates rather than resetting. Pass `today` to
    include streak badges on the current day's rows."""
    assert _conn is not None
    rows = _conn.execute(_DAILY_TOTALS_SQL).fetchall()
    badges = board_badges(today)
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
                           "score": r["total"],
                           "badges": badges.get((r["day"], r["pid"]), [])})
    return [{"day": d, "entries": days[d]} for d in order]


def recent_wins(event_day: str, n: int = 8) -> list[dict]:
    """The day's latest cracks (wins), newest first — the board's pulse. For a
    distributed online game this is the proof-of-other-humans line. Codenames
    only; same test/anon exclusion as the public board."""
    assert _conn is not None
    rows = _conn.execute(
        """SELECT p.code AS code, pl.scenario AS scenario, pl.score AS score,
                  pl.created_at AS ts
           FROM plays pl JOIN players p ON p.pid = pl.pid
           WHERE pl.event_day = ? AND pl.outcome = 'win' AND pl.score IS NOT NULL
             AND p.tier NOT IN ('test', 'anon')
           ORDER BY pl.created_at DESC LIMIT ?""",
        (event_day, n),
    ).fetchall()
    now = datetime.now(timezone.utc)
    out = []
    for r in rows:
        try:
            ago = max(0, int((now - datetime.fromisoformat(r["ts"])).total_seconds() // 60))
        except (ValueError, TypeError):
            ago = None
        out.append({
            "codename": codename_for(r["code"]),
            "title": LEVELS.get(r["scenario"], {}).get("title", r["scenario"]),
            "score": r["score"],
            "agoMin": ago,
        })
    return out


def weekly_winners() -> list[dict]:
    """Admin view: the top scorer per Mon–Sun week WITH contact details, so staff
    can run the prize outreach manually. Newest week first. Excludes test players."""
    assert _conn is not None
    rows = _conn.execute(_WEEKLY_TOTALS_SQL).fetchall()
    winners: list[dict] = []
    seen: set[str] = set()
    for r in rows:
        if r["week"] in seen:
            continue  # rows are week-desc, total-desc, so the first per week wins
        seen.add(r["week"])
        winners.append({"week": r["week"], "codename": codename_for(r["code"]),
                        "name": r["name"], "email": r["email"], "score": r["total"]})
    return winners


def daily_player_totals() -> list[dict]:
    """Admin scores view: every event day (newest first), and within each day
    every player who played, ranked by their day total (high → low), WITH name +
    email and a per-scenario breakdown. Unlike the public leaderboard this carries
    PII and includes test players, so junk/test rows can be spotted and deleted."""
    assert _conn is not None
    rows = _conn.execute(
        """SELECT pl.id AS play_id, pl.pid AS pid, p.code AS code, p.name AS name,
                  p.email AS email, p.tier AS tier, pl.event_day AS day,
                  pl.scenario AS scenario, pl.outcome AS outcome, pl.score AS score,
                  pl.transcript AS transcript
           FROM plays pl JOIN players p ON p.pid = pl.pid
           ORDER BY pl.event_day DESC, pl.created_at ASC"""
    ).fetchall()
    days: dict[str, dict[str, dict]] = {}
    day_order: list[str] = []
    for r in rows:
        day = r["day"]
        if day not in days:
            days[day] = {}
            day_order.append(day)
        player = days[day].get(r["pid"])
        if player is None:
            player = days[day][r["pid"]] = {
                "pid": r["pid"], "code": r["code"],
                "codename": codename_for(r["code"]),
                "name": r["name"], "email": r["email"], "tier": r["tier"],
                "total": 0, "plays": [],
            }
        player["plays"].append({"play_id": r["play_id"], "scenario": r["scenario"],
                                "outcome": r["outcome"], "score": r["score"],
                                "transcript": r["transcript"]})
        player["total"] += r["score"] or 0
    out = []
    for day in day_order:
        ranked = sorted(days[day].values(), key=lambda x: x["total"], reverse=True)
        out.append({"day": day, "players": ranked})
    return out


def delete_day_plays(event_day: str) -> int:
    """Delete every play record for one event day (player rows are kept). Returns
    the number of play rows removed. Irreversible."""
    assert _conn is not None
    with _lock:
        cur = _conn.execute("DELETE FROM plays WHERE event_day = ?", (event_day,))
        _conn.commit()
    return cur.rowcount


def delete_player_day_plays(pid: str, event_day: str) -> int:
    """Delete one player's plays for one event day (a single scores row). The
    player's registration is kept. Returns the number of play rows removed."""
    assert _conn is not None
    with _lock:
        cur = _conn.execute(
            "DELETE FROM plays WHERE pid = ? AND event_day = ?", (pid, event_day)
        )
        _conn.commit()
    return cur.rowcount


# ---- runtime settings (admin-controlled operational config) ---------------
# The admin portal edits availability / turn caps at runtime. Settings are read
# on hot paths, so cache them briefly and refresh immediately on any write.
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
# site_password is gone from the code, but DBs created before the gate was
# removed may still carry the row — keep redacting it in dumps.
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
