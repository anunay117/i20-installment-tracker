CREATE TABLE IF NOT EXISTS app_setup (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plan (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  car_name TEXT NOT NULL,
  sale_price INTEGER NOT NULL,
  down_payment INTEGER NOT NULL,
  down_payment_date TEXT NOT NULL,
  monthly_installment INTEGER NOT NULL,
  first_installment_date TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO plan (id, car_name, sale_price, down_payment, down_payment_date, monthly_installment, first_installment_date, updated_at)
VALUES (1, 'i20 Active', 275000, 70000, '2026-08-10', 15000, '2026-09-03', '2026-11-03T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'friend')),
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role = 'friend'),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  amount INTEGER NOT NULL CHECK (amount > 0),
  paid_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  receipt_mime TEXT NOT NULL,
  receipt_data TEXT NOT NULL,
  submitted_by TEXT,
  submitted_name TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  reviewed_by TEXT,
  reviewed_name TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  FOREIGN KEY (submitted_by) REFERENCES sessions(id),
  FOREIGN KEY (reviewed_by) REFERENCES sessions(id)
);

CREATE INDEX IF NOT EXISTS payments_status_created ON payments(status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS payments_paid_at ON payments(paid_at DESC);

INSERT OR IGNORE INTO payments
  (id, amount, paid_at, status, receipt_mime, receipt_data, submitted_by, submitted_name, submitted_at, reviewed_by, reviewed_name, reviewed_at)
VALUES
  ('legacy-payment-2026-09-03', 15000, '2026-09-03', 'approved', 'image/jpeg', '', NULL, 'Previously recorded', '2026-09-03T00:00:00.000Z', NULL, 'Anunay', '2026-11-03T00:00:00.000Z'),
  ('legacy-payment-2026-11-02', 15000, '2026-11-02', 'approved', 'image/jpeg', '', NULL, 'Previously recorded', '2026-11-02T00:00:00.000Z', NULL, 'Anunay', '2026-11-03T00:00:00.000Z');

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'friend')),
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_session TEXT,
  actor_name TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_events_occurred ON audit_events(occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS payments_no_delete
BEFORE DELETE ON payments
BEGIN
  SELECT RAISE(ABORT, 'payment records are retained for the audit trail');
END;

CREATE TRIGGER IF NOT EXISTS payments_immutable_details
BEFORE UPDATE ON payments
WHEN NEW.id != OLD.id
  OR NEW.amount != OLD.amount
  OR NEW.paid_at != OLD.paid_at
  OR NEW.receipt_mime != OLD.receipt_mime
  OR NEW.receipt_data != OLD.receipt_data
  OR NEW.submitted_by IS NOT OLD.submitted_by
  OR NEW.submitted_name != OLD.submitted_name
  OR NEW.submitted_at != OLD.submitted_at
  OR NOT (OLD.status = 'pending' AND NEW.status IN ('approved', 'rejected'))
BEGIN
  SELECT RAISE(ABORT, 'payment details are immutable; submit a correction as a new record');
END;
