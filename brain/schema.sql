-- brain/schema.sql — Voice Heist auth + play state (SQLite)
--
-- Single source of truth for the database schema. Applied by store.py:init_db()
-- on startup. Safe to run repeatedly (CREATE TABLE IF NOT EXISTS). For an
-- already-populated DB, new columns are added via additive ALTER TABLE in
-- store.py's migration step rather than here.
--
-- See the auth v2 plan: ~/.claude/plans/your-task-is-to-reflective-storm.md

PRAGMA journal_mode = WAL;   -- concurrent reads from HTTP routes + the brain WS
PRAGMA foreign_keys = ON;

-- One row per registered player. Identity converges on `code`, the short
-- credential a player uses to sign in at the shared booth kiosk.
CREATE TABLE IF NOT EXISTS players (
    pid             TEXT PRIMARY KEY,             -- uuid4
    code            TEXT NOT NULL UNIQUE,         -- booth credential, e.g. "7F2K" (collision-retry on insert)
    tier            TEXT NOT NULL,                -- 'quick' | 'oauth' | 'staff'
    handle          TEXT,                         -- Quick Play display handle

    -- OAuth/OIDC identity (NULL for non-OAuth tiers)
    auth_provider   TEXT,                         -- e.g. 'auth0' (the OIDC issuer/connection)
    provider_sub    TEXT,                         -- OIDC `sub` claim
    name            TEXT,
    email           TEXT,
    email_verified  INTEGER NOT NULL DEFAULT 0,

    consent_at      TEXT,                         -- ISO ts when audio/social consent given (PRD requirement)
    created_at      TEXT NOT NULL,                -- ISO 8601 UTC
    last_seen       TEXT NOT NULL,

    UNIQUE (auth_provider, provider_sub)          -- dedup verified identities
);

CREATE INDEX IF NOT EXISTS idx_players_email ON players(email);

-- One row per completed heist. Powers scores (leaderboard workstream),
-- returning-player recognition, and the one-play-per-scenario-per-day limit.
CREATE TABLE IF NOT EXISTS plays (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    pid         TEXT NOT NULL REFERENCES players(pid),
    scenario    TEXT NOT NULL,                    -- 'list' | 'order' | 'receptionist' | 'refund'
    event_day   TEXT NOT NULL,                    -- local event-date 'YYYY-MM-DD' (EVENT_TZ, not UTC)
    mode        TEXT NOT NULL DEFAULT 'booth',    -- 'booth' | 'web' (forward-compat for PRD booth bonus)
    outcome     TEXT NOT NULL,                    -- 'win' | 'lose'
    path        TEXT,                             -- named win/fail path, e.g. "Honesty Wins"
    score       INTEGER,                          -- NULL until the scoring-depth workstream lands
    created_at  TEXT NOT NULL,

    UNIQUE (pid, scenario, event_day)             -- enforces one play per scenario per day per player
);

CREATE INDEX IF NOT EXISTS idx_plays_daily ON plays(pid, scenario, event_day);
CREATE INDEX IF NOT EXISTS idx_plays_board ON plays(scenario, event_day, score);

-- Runtime-mutable operational config (the admin portal's source of truth).
-- Seeded from env on first boot; thereafter the portal is authoritative, so
-- changes (heist availability, gate kill-switch, site password) take effect
-- without a redeploy and survive restarts.
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,   -- 'available' | 'gate_epoch' | 'site_password'
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Audit trail for high-impact admin actions (kill switch, password rotation).
CREATE TABLE IF NOT EXISTS admin_audit (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT NOT NULL,
    action     TEXT NOT NULL,
    detail     TEXT,
    ip         TEXT,
    created_at TEXT NOT NULL
);
