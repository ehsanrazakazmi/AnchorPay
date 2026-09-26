-- Up Migration
-- core: users, recipients (address book), transfers and the transfer state machine.
--
-- PII rule: columns ending in _enc hold AES-256-GCM ciphertext produced by the application
-- (key id in encryption_key_id). Columns ending in _hash hold HMAC-SHA256 "blind index" values
-- so we can look a user up by email/phone without storing it in plain text.
-- Money rule: amounts are integers in minor units (cents/paisa) + ISO-4217 currency code.

CREATE TABLE core.users (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  email_hash          bytea NOT NULL UNIQUE,
  email_enc           bytea NOT NULL,
  phone_hash          bytea NOT NULL UNIQUE,
  phone_enc           bytea NOT NULL,
  full_name_enc       bytea NOT NULL,
  date_of_birth_enc   bytea,
  address_enc         bytea,
  encryption_key_id   text NOT NULL,
  country             char(2) NOT NULL DEFAULT 'CA' CHECK (country ~ '^[A-Z]{2}$'),
  password_hash       text NOT NULL, -- bcrypt, never the plain password
  role                text NOT NULL DEFAULT 'customer'
                        CHECK (role IN ('customer', 'agent', 'compliance_officer', 'admin')),
  status              text NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'locked', 'suspended', 'closed')),
  email_verified_at   timestamptz,
  phone_verified_at   timestamptz,
  failed_login_count  integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until        timestamptz,
  last_login_at       timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  closed_at           timestamptz
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON core.users FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
COMMENT ON TABLE core.users IS 'Registered customers and staff. PII is encrypted at the application layer.';

CREATE TABLE core.recipients (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id             uuid NOT NULL REFERENCES core.users (id),
  nickname            text,
  full_name_enc       bytea NOT NULL,
  phone_enc           bytea,
  encryption_key_id   text NOT NULL,
  country             char(2) NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency            char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  relationship        text,
  payout_method       text NOT NULL CHECK (payout_method IN ('bank_account', 'mobile_wallet')),
  bank_name           text,
  bank_code           text,  -- SWIFT/BIC or local bank code
  account_number_enc  bytea, -- account number or IBAN
  account_last4       text CHECK (account_last4 ~ '^[0-9A-Z]{1,4}$'),
  wallet_provider     text CHECK (wallet_provider IN ('jazzcash', 'easypaisa')),
  wallet_number_enc   bytea,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz, -- soft delete: past transfers still reference the recipient
  CONSTRAINT recipients_payout_details CHECK (
    (payout_method = 'bank_account'  AND bank_name IS NOT NULL AND account_number_enc IS NOT NULL) OR
    (payout_method = 'mobile_wallet' AND wallet_provider IS NOT NULL AND wallet_number_enc IS NOT NULL)
  )
);
CREATE INDEX recipients_user_idx ON core.recipients (user_id) WHERE deleted_at IS NULL;
CREATE TRIGGER recipients_updated_at BEFORE UPDATE ON core.recipients FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- transfer state machine
CREATE TABLE core.transfer_statuses (
  status      text PRIMARY KEY,
  is_terminal boolean NOT NULL,
  description text NOT NULL
);

INSERT INTO core.transfer_statuses (status, is_terminal, description) VALUES
  ('INITIATED',            false, 'Transfer created: amount, recipient and corridor saved.'),
  ('FX_LOCKED',            false, 'Exchange rate locked for 30 minutes; waiting for the payment authorisation (funds held, not yet charged).'),
  ('COMPLIANCE_SCREENING', false, 'Payment authorised. KYC limits, sanctions, AML rules and fraud score are being checked.'),
  ('ON_HOLD',              false, 'Flagged by screening; waiting for a compliance officer to review.'),
  ('AWAITING_RECONFIRM',   false, 'Approved after the rate lock expired; sender must accept the new rate or cancel.'),
  ('PAYMENT_COLLECTED',    false, 'Compliance passed and the held payment was captured.'),
  ('PAYOUT_DISPATCHED',    false, 'Funds sent to the recipient through the payout partner.'),
  ('COMPLETED',            true,  'Payout partner confirmed the recipient received the funds.'),
  ('FAILED',               false, 'A step failed after retries. Terminal unless money was collected, then it moves to REFUNDED.'),
  ('CANCELLED',            true,  'Stopped before any money was captured; the payment hold was released.'),
  ('REFUNDED',             true,  'Failed after capture; the payment was returned to the sender.');

CREATE TABLE core.transfer_transitions (
  from_status text NOT NULL REFERENCES core.transfer_statuses (status),
  to_status   text NOT NULL REFERENCES core.transfer_statuses (status),
  PRIMARY KEY (from_status, to_status)
);

INSERT INTO core.transfer_transitions (from_status, to_status) VALUES
  ('INITIATED',            'FX_LOCKED'),
  ('INITIATED',            'FAILED'),
  ('FX_LOCKED',            'COMPLIANCE_SCREENING'),
  ('FX_LOCKED',            'CANCELLED'),
  ('FX_LOCKED',            'FAILED'),
  ('COMPLIANCE_SCREENING', 'PAYMENT_COLLECTED'),
  ('COMPLIANCE_SCREENING', 'ON_HOLD'),
  ('COMPLIANCE_SCREENING', 'FAILED'),
  ('ON_HOLD',              'PAYMENT_COLLECTED'),
  ('ON_HOLD',              'AWAITING_RECONFIRM'),
  ('ON_HOLD',              'CANCELLED'),
  ('ON_HOLD',              'FAILED'),
  ('AWAITING_RECONFIRM',   'PAYMENT_COLLECTED'),
  ('AWAITING_RECONFIRM',   'CANCELLED'),
  ('AWAITING_RECONFIRM',   'FAILED'),
  ('PAYMENT_COLLECTED',    'PAYOUT_DISPATCHED'),
  ('PAYMENT_COLLECTED',    'FAILED'),
  ('PAYOUT_DISPATCHED',    'COMPLETED'),
  ('PAYOUT_DISPATCHED',    'FAILED'),
  ('FAILED',               'REFUNDED');

-- The state tables are reference data: services may read them but never change them.
REVOKE INSERT, UPDATE ON core.transfer_statuses, core.transfer_transitions FROM ap_core;

CREATE TABLE core.transfers (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  reference             text NOT NULL UNIQUE,   -- human-friendly, e.g. AP-7K3F9Q2M
  user_id               uuid NOT NULL REFERENCES core.users (id),
  recipient_id          uuid NOT NULL REFERENCES core.recipients (id),
  idempotency_key       text NOT NULL,
  status                text NOT NULL DEFAULT 'INITIATED' REFERENCES core.transfer_statuses (status),
  corridor_code         text NOT NULL,          -- fx.corridors.code, e.g. CA-PK
  funding_method        text NOT NULL CHECK (funding_method IN ('card', 'bank_debit')),
  purpose               text NOT NULL CHECK (purpose IN ('family_support', 'education', 'medical', 'gift', 'savings_investment',
                                                     'property', 'business', 'travel', 'other')),
  send_currency         char(3) NOT NULL,
  send_amount_minor     bigint NOT NULL CHECK (send_amount_minor > 0),
  fee_minor             bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  card_surcharge_minor  bigint NOT NULL DEFAULT 0 CHECK (card_surcharge_minor >= 0),
  total_charge_minor    bigint NOT NULL,
  receive_currency      char(3) NOT NULL,
  receive_amount_minor  bigint CHECK (receive_amount_minor > 0),
  mid_rate              numeric(20, 10),
  offer_rate            numeric(20, 10),
  fx_lock_id            uuid,                   -- fx.fx_locks.id (other service: no FK)
  rate_locked_at        timestamptz,
  rate_lock_expires_at  timestamptz,
  payment_id            uuid,                   -- payments.payments.id
  payout_id             uuid,                   -- payments.payouts.id
  compliance_decision   text CHECK (compliance_decision IN ('pass', 'flag', 'block')),
  failure_code          text,
  failure_reason        text,
  cancel_reason         text,
  version               integer NOT NULL DEFAULT 1, -- optimistic locking for transitions
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  CONSTRAINT transfers_idempotency UNIQUE (user_id, idempotency_key),
  -- Fee model: the sender pays send amount + fee (+ card surcharge); the recipient gets send amount x offer rate.
  CONSTRAINT transfers_total_charge CHECK (total_charge_minor = send_amount_minor + fee_minor + card_surcharge_minor)
);
CREATE INDEX transfers_user_created_idx ON core.transfers (user_id, created_at DESC);
CREATE INDEX transfers_status_idx ON core.transfers (status) WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'REFUNDED');
CREATE TRIGGER transfers_updated_at BEFORE UPDATE ON core.transfers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Database-level guard: a status change must be an allowed transition, and bumps the version.
CREATE FUNCTION core.enforce_transfer_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'INITIATED' THEN
      RAISE EXCEPTION 'A transfer must be created in status INITIATED, not %', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT EXISTS (SELECT 1 FROM core.transfer_transitions WHERE from_status = OLD.status AND to_status = NEW.status) THEN
      RAISE EXCEPTION 'Invalid transfer transition % -> %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
    END IF;
    NEW.version := OLD.version + 1;
    IF NEW.status IN ('COMPLETED', 'CANCELLED', 'REFUNDED') AND NEW.completed_at IS NULL THEN
      NEW.completed_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER transfers_state_machine BEFORE INSERT OR UPDATE ON core.transfers
  FOR EACH ROW EXECUTE FUNCTION core.enforce_transfer_transition();

-- Every transition, persisted in the same transaction as the status change (crash-safe resume point).
CREATE TABLE core.transfer_status_history (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  uuid NOT NULL REFERENCES core.transfers (id),
  from_status  text REFERENCES core.transfer_statuses (status),
  to_status    text NOT NULL REFERENCES core.transfer_statuses (status),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'staff', 'service', 'system', 'vendor')),
  actor_id     text,
  reason       text,
  metadata     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX transfer_status_history_transfer_idx ON core.transfer_status_history (transfer_id, id);
SELECT public.make_append_only('core.transfer_status_history');
REVOKE UPDATE ON core.transfer_status_history FROM ap_core;

SELECT public.create_messaging_tables('core');

-- Down Migration
DROP TABLE core.inbox;
DROP TABLE core.outbox;
DROP TABLE core.transfer_status_history;
DROP TABLE core.transfers;
DROP FUNCTION core.enforce_transfer_transition();
DROP TABLE core.transfer_transitions;
DROP TABLE core.transfer_statuses;
DROP TABLE core.recipients;
DROP TABLE core.users;
