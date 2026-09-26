-- Up Migration
-- notify: per-user channel preferences and a delivery log.
-- audit: the shared immutable audit trail (who did what, when, before/after).

CREATE TABLE notify.preferences (
  user_id        uuid NOT NULL, -- core.users.id
  event_type     text NOT NULL CHECK (event_type IN (
                   'transfer_created', 'payment_collected', 'transfer_on_hold', 'payout_dispatched',
                   'transfer_completed', 'transfer_failed', 'transfer_cancelled', 'transfer_refunded',
                   'rate_reconfirm_required', 'kyc_approved', 'kyc_rejected', 'security_alert')),
  sms_enabled    boolean NOT NULL,
  email_enabled  boolean NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event_type)
);
CREATE TRIGGER preferences_updated_at BEFORE UPDATE ON notify.preferences FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE notify.notification_log (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id              uuid NOT NULL,
  transfer_id          uuid,
  event_type           text NOT NULL,
  source_event_id      uuid NOT NULL,
  channel              text NOT NULL CHECK (channel IN ('sms', 'email')),
  template             text NOT NULL,
  destination_masked   text NOT NULL, -- e.g. +1 *** *** 4521 / a***@gmail.com
  status               text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed', 'skipped')),
  provider             text NOT NULL,
  provider_message_id  text,
  error                text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  sent_at              timestamptz,
  UNIQUE (source_event_id, channel)
);
CREATE INDEX notification_log_user_idx ON notify.notification_log (user_id, created_at DESC);

SELECT public.create_messaging_tables('notify', false);

-- Audit trail: append-only, retained at least 5 years (FINTRAC record keeping).
-- before/after must never contain decrypted PII; store ids, statuses and masked values only.
CREATE TABLE audit.audit_log (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  service      text NOT NULL,
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'staff', 'service', 'system', 'vendor')),
  actor_id     text,
  action       text NOT NULL,  -- e.g. transfer.status_changed, user.login_failed, aml_rule.updated
  entity_type  text NOT NULL,
  entity_id    text,
  before       jsonb,
  after        jsonb,
  request_id   text,
  ip           inet,
  user_agent   text
);
CREATE INDEX audit_log_entity_idx ON audit.audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX audit_log_actor_idx ON audit.audit_log (actor_id, occurred_at DESC);
CREATE INDEX audit_log_time_idx ON audit.audit_log (occurred_at DESC);
SELECT public.make_append_only('audit.audit_log');

-- Down Migration
DROP TABLE audit.audit_log;
DROP TABLE notify.inbox;
DROP TABLE notify.notification_log;
DROP TABLE notify.preferences;
