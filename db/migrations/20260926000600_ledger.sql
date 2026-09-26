-- Up Migration
-- ledger: immutable double-entry ledger + nightly reconciliation against payout partner settlements.
-- Every journal must balance per currency (sum of debits = sum of credits). Entries are never
-- updated or deleted; corrections are new journals.

CREATE TABLE ledger.accounts (
  code            text NOT NULL,
  currency        char(3) NOT NULL,
  name            text NOT NULL,
  type            text NOT NULL CHECK (type IN ('asset', 'liability', 'revenue', 'expense', 'equity')),
  normal_balance  text NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (code),
  UNIQUE (code, currency)
);

CREATE TABLE ledger.journals (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  transfer_id  uuid,
  kind         text NOT NULL CHECK (kind IN ('payment_captured', 'payout_dispatched', 'refund', 'fee',
                                            'adjustment', 'reconciliation_adjustment')),
  description  text NOT NULL,
  source_event_id uuid UNIQUE, -- Kafka event that produced this journal (idempotency)
  created_by   text NOT NULL DEFAULT 'ledger-service',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX journals_transfer_idx ON ledger.journals (transfer_id);
SELECT public.make_append_only('ledger.journals');

CREATE TABLE ledger.entries (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  journal_id    uuid NOT NULL REFERENCES ledger.journals (id),
  account_code  text NOT NULL,
  currency      char(3) NOT NULL,
  direction     text NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- An entry's currency must be the account's currency.
  FOREIGN KEY (account_code, currency) REFERENCES ledger.accounts (code, currency)
);
CREATE INDEX entries_journal_idx ON ledger.entries (journal_id);
CREATE INDEX entries_account_idx ON ledger.entries (account_code, created_at);
SELECT public.make_append_only('ledger.entries');

-- Checked at COMMIT: each journal touched in the transaction must balance in every currency.
CREATE FUNCTION ledger.assert_journal_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  unbalanced record;
BEGIN
  SELECT currency, sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) AS diff
    INTO unbalanced
    FROM ledger.entries
   WHERE journal_id = NEW.journal_id
   GROUP BY currency
  HAVING sum(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Journal % is unbalanced in % by % minor units', NEW.journal_id, unbalanced.currency, unbalanced.diff
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER entries_balanced AFTER INSERT ON ledger.entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger.assert_journal_balanced();

CREATE VIEW ledger.account_balances AS
SELECT a.code, a.currency, a.name, a.type, a.normal_balance,
       COALESCE(sum(CASE WHEN e.direction = a.normal_balance THEN e.amount_minor ELSE -e.amount_minor END), 0) AS balance_minor
  FROM ledger.accounts a
  LEFT JOIN ledger.entries e ON e.account_code = a.code
 GROUP BY a.code, a.currency, a.name, a.type, a.normal_balance;
GRANT SELECT ON ledger.account_balances TO ap_ledger, ap_reporting;

-- ---------------------------------------------------------------- reconciliation
CREATE TABLE ledger.reconciliation_runs (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  run_date           date NOT NULL,
  partner            text NOT NULL,
  settlement_file    text,
  status             text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'matched', 'discrepancies', 'failed')),
  total_items        integer NOT NULL DEFAULT 0,
  matched_items      integer NOT NULL DEFAULT 0,
  discrepancy_count  integer NOT NULL DEFAULT 0,
  error              text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  finished_at        timestamptz,
  UNIQUE (run_date, partner)
);

CREATE TABLE ledger.reconciliation_items (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id             uuid NOT NULL REFERENCES ledger.reconciliation_runs (id),
  transfer_id        uuid,
  payout_id          uuid,
  partner_payout_id  text,
  issue              text NOT NULL CHECK (issue IN ('missing_at_partner', 'missing_in_ledger', 'amount_mismatch',
                                                    'currency_mismatch', 'status_mismatch')),
  internal_record    jsonb,
  partner_record     jsonb,
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text
);
CREATE INDEX reconciliation_items_open_idx ON ledger.reconciliation_items (run_id) WHERE resolved_at IS NULL;

SELECT public.create_messaging_tables('ledger');

-- Down Migration
DROP TABLE ledger.inbox;
DROP TABLE ledger.outbox;
DROP TABLE ledger.reconciliation_items;
DROP TABLE ledger.reconciliation_runs;
DROP VIEW ledger.account_balances;
DROP TABLE ledger.entries;
DROP FUNCTION ledger.assert_journal_balanced();
DROP TABLE ledger.journals;
DROP TABLE ledger.accounts;
