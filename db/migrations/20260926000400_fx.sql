-- Up Migration
-- fx: corridor pricing config, mid-market rate history, rate locks.
-- Redis holds the live rate cache and the lock TTL; these tables are the durable record.

CREATE TABLE fx.corridors (
  code                 text PRIMARY KEY CHECK (code ~ '^[A-Z]{2}-[A-Z]{2}$'), -- e.g. CA-PK
  send_country         char(2) NOT NULL,
  send_currency        char(3) NOT NULL,
  receive_country      char(2) NOT NULL,
  receive_currency     char(3) NOT NULL,
  spread_bps           integer NOT NULL CHECK (spread_bps BETWEEN 0 AND 1000), -- 150 = 1.50%
  fixed_fee_minor      bigint NOT NULL CHECK (fixed_fee_minor >= 0),           -- in send currency
  card_surcharge_bps   integer NOT NULL DEFAULT 0 CHECK (card_surcharge_bps BETWEEN 0 AND 1000),
  min_send_minor       bigint NOT NULL CHECK (min_send_minor > 0),
  max_send_minor       bigint NOT NULL,
  payout_methods       text[] NOT NULL,
  delivery_estimate    text NOT NULL, -- shown to the customer, e.g. 'Within minutes'
  enabled              boolean NOT NULL DEFAULT true,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text,
  CHECK (max_send_minor >= min_send_minor),
  CHECK (payout_methods <@ ARRAY['bank_account', 'mobile_wallet']::text[] AND cardinality(payout_methods) > 0),
  UNIQUE (send_country, send_currency, receive_country, receive_currency)
);
CREATE TRIGGER corridors_updated_at BEFORE UPDATE ON fx.corridors FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE fx.rate_snapshots (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  base_currency   char(3) NOT NULL,
  quote_currency  char(3) NOT NULL,
  mid_rate        numeric(20, 10) NOT NULL CHECK (mid_rate > 0),
  source          text NOT NULL,          -- open-er-api | mock | ...
  source_time     timestamptz,            -- when the source says the rate was published
  fetched_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_snapshots_pair_idx ON fx.rate_snapshots (base_currency, quote_currency, fetched_at DESC);
SELECT public.make_append_only('fx.rate_snapshots');

CREATE TABLE fx.fx_locks (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  transfer_id           uuid NOT NULL, -- core.transfers.id
  user_id               uuid NOT NULL,
  quote_id              uuid NOT NULL,          -- the quote the customer saw (quotes live 60s in Redis)
  corridor_code         text NOT NULL REFERENCES fx.corridors (code),
  funding_method        text NOT NULL CHECK (funding_method IN ('card', 'bank_debit')),
  send_currency         char(3) NOT NULL,
  send_amount_minor     bigint NOT NULL CHECK (send_amount_minor > 0),
  fee_minor             bigint NOT NULL CHECK (fee_minor >= 0),
  card_surcharge_minor  bigint NOT NULL CHECK (card_surcharge_minor >= 0),
  total_charge_minor    bigint NOT NULL,
  receive_currency      char(3) NOT NULL,
  receive_amount_minor  bigint NOT NULL CHECK (receive_amount_minor > 0),
  mid_rate              numeric(20, 10) NOT NULL,
  offer_rate            numeric(20, 10) NOT NULL,
  spread_bps            integer NOT NULL,
  rate_snapshot_id      bigint REFERENCES fx.rate_snapshots (id),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'consumed', 'expired', 'released')),
  locked_at             timestamptz NOT NULL DEFAULT now(),
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > locked_at),
  CHECK (total_charge_minor = send_amount_minor + fee_minor + card_surcharge_minor)
);
CREATE UNIQUE INDEX fx_locks_one_active_per_transfer ON fx.fx_locks (transfer_id) WHERE status = 'active';
CREATE INDEX fx_locks_expiry_idx ON fx.fx_locks (expires_at) WHERE status = 'active';
CREATE TRIGGER fx_locks_updated_at BEFORE UPDATE ON fx.fx_locks FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

SELECT public.create_messaging_tables('fx');

-- Down Migration
DROP TABLE fx.inbox;
DROP TABLE fx.outbox;
DROP TABLE fx.fx_locks;
DROP TABLE fx.rate_snapshots;
DROP TABLE fx.corridors;
