-- Ledgerline schema
-- Amounts are stored as INTEGER cents to avoid float drift.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- A SimpleFIN app connection. One row unless you run multiple Bridge accounts.
CREATE TABLE IF NOT EXISTS connections (
  id                 INTEGER PRIMARY KEY,
  label              TEXT    NOT NULL,
  access_url_enc     BLOB    NOT NULL,   -- AES-256-GCM, key from ENCRYPTION_KEY
  access_url_iv      BLOB    NOT NULL,
  access_url_tag     BLOB    NOT NULL,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  last_synced_at     TEXT,
  last_sync_error    TEXT,
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);

-- One row per account. Manual accounts have connection_id IS NULL.
CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY,
  connection_id  INTEGER REFERENCES connections(id) ON DELETE CASCADE,
  simplefin_id   TEXT UNIQUE,           -- NULL for manual accounts
  org_name       TEXT    NOT NULL,      -- institution name as SimpleFIN reports it
  org_domain     TEXT,
  name           TEXT    NOT NULL,      -- account name as SimpleFIN reports it
  nickname       TEXT,                  -- user override shown in the UI
  currency       TEXT    NOT NULL DEFAULT 'USD',

  -- Does it count, and which way? asset | liability | excluded
  classification TEXT    NOT NULL DEFAULT 'asset'
                 CHECK (classification IN ('asset','liability','excluded')),

  -- How reachable is it? Orthogonal to classification: a 401(k) loan is a
  -- retirement liability, a HELOC is an illiquid one.
  --   liquid     — spendable this week: checking, savings, taxable brokerage
  --   retirement — penalty or age-gated: 401(k), IRA, Roth, HSA
  --   illiquid   — real, slow: property, vehicles, private equity
  bucket         TEXT    NOT NULL DEFAULT 'liquid'
                 CHECK (bucket IN ('liquid','retirement','illiquid')),

  balance_cents  INTEGER NOT NULL DEFAULT 0,  -- normalized: + owned, - owed
  raw_balance    TEXT,                        -- exactly as SimpleFIN sent it, for audit
  balance_date   TEXT,                        -- institution's own as-of, not our fetch time
  is_manual      INTEGER NOT NULL DEFAULT 0,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  archived       INTEGER NOT NULL DEFAULT 0,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_accounts_active
  ON accounts(archived, classification, bucket);

-- Daily point-in-time record. This is the history; without it there's no chart.
CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  taken_on      TEXT    NOT NULL,   -- YYYY-MM-DD, local date
  balance_cents INTEGER NOT NULL,

  -- Denormalized on purpose. If you later reclassify an account -- roll a 401(k)
  -- into an IRA, move a brokerage from liquid to retirement -- joining to accounts
  -- would silently rewrite every past chart. Freezing it here means history shows
  -- what was actually true on that date.
  classification TEXT   NOT NULL,
  bucket         TEXT   NOT NULL,

  UNIQUE (account_id, taken_on)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(taken_on);

-- Investment positions, where the institution reports them.
-- Not used by the v1 UI. Captured now because backfilling it later is impossible.
CREATE TABLE IF NOT EXISTS holdings (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  simplefin_id     TEXT,
  symbol           TEXT,
  description      TEXT,
  shares           TEXT,
  market_value_cents INTEGER,
  cost_basis_cents   INTEGER,
  as_of            TEXT,
  UNIQUE (account_id, simplefin_id)
);

-- Rate limit ledger. SimpleFIN allows 24 requests/day; we self-cap below that.
CREATE TABLE IF NOT EXISTS request_log (
  id           INTEGER PRIMARY KEY,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  endpoint     TEXT NOT NULL,
  status       INTEGER,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_log_time ON request_log(requested_at);

-- Institutions we expect to hear from on every sync.
--
-- This exists because absence is silent: when an institution returns nothing, the
-- response omits its accounts and leaves `errors` empty. Nothing in the payload says
-- anything is wrong, and the total simply shrinks. Diffing what arrived against this
-- table is the only way to notice.
CREATE TABLE IF NOT EXISTS expected_orgs (
  id            INTEGER PRIMARY KEY,
  org_name      TEXT    NOT NULL UNIQUE,
  org_domain    TEXT,
  first_seen_at TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at  TEXT,
  -- Set when the user has deliberately disconnected an institution, so a legitimate
  -- removal doesn't raise an alarm forever.
  retired       INTEGER NOT NULL DEFAULT 0
);

-- Small key/value bag for settings and cache metadata.
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
