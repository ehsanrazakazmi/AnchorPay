-- Up Migration
-- payments: collecting money from the sender (authorise -> capture), refunds, payouts to the
-- recipient, and inbound provider webhooks. Card numbers and bank credentials are never stored:
-- only provider tokens/ids (and card brand + last 4 for display).

CREATE TABLE payments.payments (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  transfer_id          uuid NOT NULL UNIQUE, -- core.transfers.id
  user_id              uuid NOT NULL,
  method               text NOT NULL CHECK (method IN ('card', 'bank_debit')),
  provider             text NOT NULL CHECK (provider IN ('mock', 'stripe')),
  provider_payment_id  text,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  currency             char(3) NOT NULL,
  status               text NOT NULL DEFAULT 'requires_action'
                         CHECK (status IN ('requires_action', 'authorized', 'captured', 'voided', 'failed',
                                           'refunded', 'partially_refunded')),
  card_brand           text,
  card_last4           text CHECK (card_last4 ~ '^[0-9]{4}$'),
  failure_code         text,
  failure_message      text,
  authorized_at        timestamptz,
  captured_at          timestamptz,
  voided_at            timestamptz,
  authorization_expires_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE payments.refunds (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  payment_id          uuid NOT NULL REFERENCES payments.payments (id),
  transfer_id         uuid NOT NULL,
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL,
  provider_refund_id  text,
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  reason              text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refunds_payment_idx ON payments.refunds (payment_id);
CREATE TRIGGER refunds_updated_at BEFORE UPDATE ON payments.refunds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE payments.payouts (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  transfer_id          uuid NOT NULL UNIQUE,
  partner              text NOT NULL CHECK (partner IN ('mock', 'thunes', 'flutterwave', 'currencycloud')),
  partner_payout_id    text,
  method               text NOT NULL CHECK (method IN ('bank_account', 'mobile_wallet')),
  destination_country  char(2) NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  currency             char(3) NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'dispatched', 'completed', 'failed', 'manual_review')),
  attempts             smallint NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts         smallint NOT NULL DEFAULT 3,
  next_attempt_at      timestamptz,
  last_error           text,
  dispatched_at        timestamptz,
  completed_at         timestamptz,
  failed_at            timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (partner, partner_payout_id)
);
CREATE INDEX payouts_retry_idx ON payments.payouts (next_attempt_at) WHERE status = 'pending';
CREATE INDEX payouts_open_idx ON payments.payouts (status) WHERE status IN ('pending', 'dispatched', 'manual_review');
CREATE TRIGGER payouts_updated_at BEFORE UPDATE ON payments.payouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per call to the payout partner (request is stored redacted: no account numbers).
CREATE TABLE payments.payout_attempts (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payout_id         uuid NOT NULL REFERENCES payments.payouts (id),
  attempt_no        smallint NOT NULL,
  request_redacted  jsonb NOT NULL,
  response_status   integer,
  response_body     jsonb,
  error             text,
  duration_ms       integer,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payout_id, attempt_no)
);
SELECT public.make_append_only('payments.payout_attempts');

-- Inbound webhooks (Stripe, payout partner). Unique provider event id makes processing idempotent.
CREATE TABLE payments.webhook_events (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  provider           text NOT NULL,
  provider_event_id  text NOT NULL,
  event_type         text NOT NULL,
  signature_valid    boolean NOT NULL,
  payload            jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz,
  processing_error   text,
  UNIQUE (provider, provider_event_id)
);
CREATE INDEX webhook_events_unprocessed_idx ON payments.webhook_events (received_at) WHERE processed_at IS NULL;

SELECT public.create_messaging_tables('payments');

-- Down Migration
DROP TABLE payments.inbox;
DROP TABLE payments.outbox;
DROP TABLE payments.webhook_events;
DROP TABLE payments.payout_attempts;
DROP TABLE payments.payouts;
DROP TABLE payments.refunds;
DROP TABLE payments.payments;
