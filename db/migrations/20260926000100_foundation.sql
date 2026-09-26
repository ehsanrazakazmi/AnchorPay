-- Up Migration
-- Foundation: one schema per service, shared helper functions, default privileges.
-- Services talk to each other through APIs and Kafka events; no role is granted access
-- to another service's schema (except the read-only reporting role).

CREATE EXTENSION IF NOT EXISTS pg_trgm; -- fuzzy name matching for sanctions screening

CREATE SCHEMA core;       -- identity-service + transfer-service (Module 1)
CREATE SCHEMA compliance; -- compliance-service: KYC, AML rules, sanctions, review queue, reports (Module 2)
CREATE SCHEMA fx;         -- fx-service: corridors, rates, rate locks (Module 3)
CREATE SCHEMA payments;   -- payment-service: collections, refunds, payouts, webhooks (Module 3)
CREATE SCHEMA ledger;     -- ledger-service: double-entry ledger, reconciliation, reporting (Module 3)
CREATE SCHEMA notify;     -- notification-service: preferences, delivery log (Module 4)
CREATE SCHEMA audit;      -- shared append-only audit trail; every service may INSERT

COMMENT ON SCHEMA core IS 'Owned by identity-service and transfer-service (role ap_core).';
COMMENT ON SCHEMA compliance IS 'Owned by compliance-service (role ap_compliance).';
COMMENT ON SCHEMA fx IS 'Owned by fx-service (role ap_fx).';
COMMENT ON SCHEMA payments IS 'Owned by payment-service (role ap_payments).';
COMMENT ON SCHEMA ledger IS 'Owned by ledger-service (role ap_ledger).';
COMMENT ON SCHEMA notify IS 'Owned by notification-service (role ap_notify).';
COMMENT ON SCHEMA audit IS 'Append-only audit trail. All service roles: INSERT only; ledger/reporting: SELECT.';

-- Keeps updated_at current on every UPDATE.
CREATE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

-- Attached to append-only tables: blocks UPDATE, DELETE and TRUNCATE for everyone, including the owner.
CREATE FUNCTION public.forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on %.% is not allowed: table is append-only', TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE FUNCTION public.make_append_only(target regclass) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER append_only_row BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION public.forbid_mutation()', target);
  EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION public.forbid_mutation()', target);
END;
$$;

-- Transactional outbox (events to publish) and inbox (events already consumed) for a service schema.
-- The outbox row is written in the same DB transaction as the state change, then relayed to Kafka,
-- so an event is never lost or published for a change that rolled back.
CREATE FUNCTION public.create_messaging_tables(target_schema text, with_outbox boolean DEFAULT true) RETURNS void
LANGUAGE plpgsql AS $fn$
BEGIN
  IF with_outbox THEN
    EXECUTE format($sql$
      CREATE TABLE %1$I.outbox (
        id           uuid PRIMARY KEY DEFAULT uuidv7(), -- equals the event envelope eventId
        topic        text NOT NULL,
        message_key  text NOT NULL,
        payload      jsonb NOT NULL,                    -- full event envelope (contracts/events)
        headers      jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at   timestamptz NOT NULL DEFAULT now(),
        published_at timestamptz,
        attempts     integer NOT NULL DEFAULT 0,
        last_error   text
      );
      CREATE INDEX outbox_unpublished_idx ON %1$I.outbox (created_at) WHERE published_at IS NULL;
      COMMENT ON TABLE %1$I.outbox IS 'Transactional outbox relayed to Kafka.';
    $sql$, target_schema);
  END IF;

  EXECUTE format($sql$
    CREATE TABLE %1$I.inbox (
      consumer     text NOT NULL,
      event_id     uuid NOT NULL,
      topic        text NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (consumer, event_id)
    );
    COMMENT ON TABLE %1$I.inbox IS 'Idempotent consumer log: an event id is processed at most once per consumer.';
  $sql$, target_schema);
END;
$fn$;

-- Default privileges: every table/sequence the migrator creates later is granted automatically.
-- DELETE is never granted to services; deletion of personal data is done by anonymising rows.
ALTER DEFAULT PRIVILEGES IN SCHEMA core       GRANT SELECT, INSERT, UPDATE ON TABLES TO ap_core;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT SELECT, INSERT, UPDATE ON TABLES TO ap_compliance;
ALTER DEFAULT PRIVILEGES IN SCHEMA fx         GRANT SELECT, INSERT, UPDATE ON TABLES TO ap_fx;
ALTER DEFAULT PRIVILEGES IN SCHEMA payments   GRANT SELECT, INSERT, UPDATE ON TABLES TO ap_payments;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger     GRANT SELECT, INSERT, UPDATE ON TABLES TO ap_ledger;
ALTER DEFAULT PRIVILEGES IN SCHEMA notify     GRANT SELECT, INSERT, UPDATE ON TABLES TO ap_notify;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit      GRANT INSERT ON TABLES TO ap_core, ap_compliance, ap_fx, ap_payments, ap_ledger, ap_notify;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit      GRANT SELECT ON TABLES TO ap_ledger;

ALTER DEFAULT PRIVILEGES IN SCHEMA core       GRANT USAGE, SELECT ON SEQUENCES TO ap_core;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance GRANT USAGE, SELECT ON SEQUENCES TO ap_compliance;
ALTER DEFAULT PRIVILEGES IN SCHEMA fx         GRANT USAGE, SELECT ON SEQUENCES TO ap_fx;
ALTER DEFAULT PRIVILEGES IN SCHEMA payments   GRANT USAGE, SELECT ON SEQUENCES TO ap_payments;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger     GRANT USAGE, SELECT ON SEQUENCES TO ap_ledger;
ALTER DEFAULT PRIVILEGES IN SCHEMA notify     GRANT USAGE, SELECT ON SEQUENCES TO ap_notify;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit      GRANT USAGE, SELECT ON SEQUENCES TO ap_core, ap_compliance, ap_fx, ap_payments, ap_ledger, ap_notify;

ALTER DEFAULT PRIVILEGES IN SCHEMA core, compliance, fx, payments, ledger, notify, audit GRANT SELECT ON TABLES TO ap_reporting;

GRANT USAGE ON SCHEMA core       TO ap_core, ap_reporting;
GRANT USAGE ON SCHEMA compliance TO ap_compliance, ap_reporting;
GRANT USAGE ON SCHEMA fx         TO ap_fx, ap_reporting;
GRANT USAGE ON SCHEMA payments   TO ap_payments, ap_reporting;
GRANT USAGE ON SCHEMA ledger     TO ap_ledger, ap_reporting;
GRANT USAGE ON SCHEMA notify     TO ap_notify, ap_reporting;
GRANT USAGE ON SCHEMA audit      TO ap_core, ap_compliance, ap_fx, ap_payments, ap_ledger, ap_notify, ap_reporting;

-- Down Migration
ALTER DEFAULT PRIVILEGES IN SCHEMA core, compliance, fx, payments, ledger, notify, audit REVOKE SELECT ON TABLES FROM ap_reporting;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit      REVOKE USAGE, SELECT ON SEQUENCES FROM ap_core, ap_compliance, ap_fx, ap_payments, ap_ledger, ap_notify;
ALTER DEFAULT PRIVILEGES IN SCHEMA notify     REVOKE USAGE, SELECT ON SEQUENCES FROM ap_notify;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger     REVOKE USAGE, SELECT ON SEQUENCES FROM ap_ledger;
ALTER DEFAULT PRIVILEGES IN SCHEMA payments   REVOKE USAGE, SELECT ON SEQUENCES FROM ap_payments;
ALTER DEFAULT PRIVILEGES IN SCHEMA fx         REVOKE USAGE, SELECT ON SEQUENCES FROM ap_fx;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance REVOKE USAGE, SELECT ON SEQUENCES FROM ap_compliance;
ALTER DEFAULT PRIVILEGES IN SCHEMA core       REVOKE USAGE, SELECT ON SEQUENCES FROM ap_core;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit      REVOKE SELECT ON TABLES FROM ap_ledger;
ALTER DEFAULT PRIVILEGES IN SCHEMA audit      REVOKE INSERT ON TABLES FROM ap_core, ap_compliance, ap_fx, ap_payments, ap_ledger, ap_notify;
ALTER DEFAULT PRIVILEGES IN SCHEMA notify     REVOKE SELECT, INSERT, UPDATE ON TABLES FROM ap_notify;
ALTER DEFAULT PRIVILEGES IN SCHEMA ledger     REVOKE SELECT, INSERT, UPDATE ON TABLES FROM ap_ledger;
ALTER DEFAULT PRIVILEGES IN SCHEMA payments   REVOKE SELECT, INSERT, UPDATE ON TABLES FROM ap_payments;
ALTER DEFAULT PRIVILEGES IN SCHEMA fx         REVOKE SELECT, INSERT, UPDATE ON TABLES FROM ap_fx;
ALTER DEFAULT PRIVILEGES IN SCHEMA compliance REVOKE SELECT, INSERT, UPDATE ON TABLES FROM ap_compliance;
ALTER DEFAULT PRIVILEGES IN SCHEMA core       REVOKE SELECT, INSERT, UPDATE ON TABLES FROM ap_core;

DROP FUNCTION public.create_messaging_tables(text, boolean);
DROP FUNCTION public.make_append_only(regclass);
DROP FUNCTION public.forbid_mutation();
DROP FUNCTION public.set_updated_at();
DROP SCHEMA audit, notify, ledger, payments, fx, compliance, core CASCADE;
DROP EXTENSION IF EXISTS pg_trgm;
