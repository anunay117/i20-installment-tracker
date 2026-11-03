CREATE TABLE IF NOT EXISTS access_codes (
  role TEXT PRIMARY KEY CHECK (role IN ('owner', 'friend')),
  code_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
