-- Up Migration
-- Step 5: what payment-service and ledger-service need on top of the Foundation tables (DECISIONS D-44 to D-51).

-- payments: the fee split travels with the payment so payment.captured can tell the ledger what is revenue.
ALTER TABLE payments.payments
  ADD COLUMN fee_minor             bigint NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
  ADD COLUMN card_surcharge_minor  bigint NOT NULL DEFAULT 0 CHECK (card_surcharge_minor >= 0),
  ADD CONSTRAINT payments_fee_within_amount CHECK (fee_minor + card_surcharge_minor < amount_minor);
-- The sweeper finds holds that are about to lapse.
CREATE INDEX payments_authorization_expiry_idx ON payments.payments (authorization_expires_at) WHERE status = 'authorized';

-- Full refunds only: at most one refund per payment that hasn't failed (the idempotency backstop).
CREATE UNIQUE INDEX refunds_one_per_payment ON payments.refunds (payment_id) WHERE status <> 'failed';
CREATE INDEX refunds_unsent_idx ON payments.refunds (created_at) WHERE status = 'pending' AND provider_refund_id IS NULL;

-- payouts: what a retry needs without asking transfer-service again.
ALTER TABLE payments.payouts
  ADD COLUMN recipient_id        uuid NOT NULL,
  ADD COLUMN transfer_reference  text NOT NULL,
  ADD COLUMN send_amount_minor   bigint NOT NULL CHECK (send_amount_minor > 0),
  ADD COLUMN send_currency       char(3) NOT NULL;

-- ledger: deterministic journal references make every posting happen at most once, whatever order events arrive in.
ALTER TABLE ledger.journals
  ADD COLUMN payout_id  uuid,
  ADD COLUMN ref        text UNIQUE; -- e.g. capture:<transferId>, payout:<payoutId>, payout-reversal:<payoutId>, refund:<refundId>
CREATE INDEX journals_payout_idx ON ledger.journals (payout_id) WHERE payout_id IS NOT NULL;

-- What the ledger has learned about each transfer from events. Journals are derived from these facts, so the
-- outcome is the same whichever event arrives first (Kafka only orders events within one topic).
CREATE TABLE ledger.transfer_facts (
  transfer_id     uuid PRIMARY KEY,
  captured        jsonb,        -- payment.captured: paymentId, amount, fee, cardSurcharge, capturedAt
  payout          jsonb,        -- payout.dispatched: payoutId, partner, amount, sendAmount, dispatchedAt
  failed_at       timestamptz,  -- transfer.status-changed to FAILED
  refunded        jsonb,        -- payment.refunded: refundId, amount, refundedAt
  screening       jsonb,        -- compliance.screening-completed: decision, fraudScore, completedAt
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER transfer_facts_updated_at BEFORE UPDATE ON ledger.transfer_facts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
-- Reconciliation reads payouts by the day they were dispatched.
CREATE INDEX transfer_facts_payout_day_idx ON ledger.transfer_facts (((payout ->> 'dispatchedAt'))) WHERE payout IS NOT NULL;

-- Down Migration
DROP TABLE ledger.transfer_facts;
DROP INDEX ledger.journals_payout_idx;
ALTER TABLE ledger.journals DROP COLUMN ref, DROP COLUMN payout_id;
ALTER TABLE payments.payouts
  DROP COLUMN send_currency,
  DROP COLUMN send_amount_minor,
  DROP COLUMN transfer_reference,
  DROP COLUMN recipient_id;
DROP INDEX payments.refunds_unsent_idx;
DROP INDEX payments.refunds_one_per_payment;
DROP INDEX payments.payments_authorization_expiry_idx;
ALTER TABLE payments.payments
  DROP CONSTRAINT payments_fee_within_amount,
  DROP COLUMN card_surcharge_minor,
  DROP COLUMN fee_minor;
