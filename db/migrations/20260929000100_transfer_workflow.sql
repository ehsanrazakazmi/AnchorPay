-- Up Migration
-- Progress markers for transfer-service's workflow. Each side-effect (capture, payout, refund) is recorded
-- before/after the call, so the recovery job can resume any transfer from its last saved step after a crash.

ALTER TABLE core.transfers
  ADD COLUMN quote_id              uuid,        -- the fx quote the customer confirmed
  ADD COLUMN delivery_estimate     text,        -- shown to the customer, from the quote
  ADD COLUMN payout_method         text CHECK (payout_method IN ('bank_account', 'mobile_wallet')),
  ADD COLUMN screening_id          uuid,        -- compliance.screenings.id
  ADD COLUMN review_case_id        uuid,        -- compliance.review_cases.id when the transfer was flagged
  ADD COLUMN collect_requested_at  timestamptz, -- cleared to charge (screening passed / review approved / new rate accepted)
  ADD COLUMN payment_captured_at   timestamptz, -- money actually taken from the sender
  ADD COLUMN payout_requested_at   timestamptz, -- payout instruction accepted by payment-service
  ADD COLUMN refund_requested_at   timestamptz; -- refund started after a failure post-capture

-- The recovery job scans unfinished transfers by how long they've been in their state.
CREATE INDEX transfers_recovery_idx ON core.transfers (status, updated_at)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'REFUNDED');

-- Down Migration
DROP INDEX core.transfers_recovery_idx;
ALTER TABLE core.transfers
  DROP COLUMN refund_requested_at,
  DROP COLUMN payout_requested_at,
  DROP COLUMN payment_captured_at,
  DROP COLUMN collect_requested_at,
  DROP COLUMN review_case_id,
  DROP COLUMN screening_id,
  DROP COLUMN payout_method,
  DROP COLUMN delivery_estimate,
  DROP COLUMN quote_id;
