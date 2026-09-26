-- Up Migration
-- compliance: KYC, AML rules engine config, screenings, manual review queue, sanctions lists,
-- regulatory reports (FINTRAC STR / international EFT reports). No money moves until this says pass.

-- KYC tier limits (CAD minor units). Rolling windows: daily = last 24h, monthly = last 30 days.
CREATE TABLE compliance.kyc_tiers (
  tier                      smallint PRIMARY KEY CHECK (tier BETWEEN 0 AND 3),
  name                      text NOT NULL,
  requirements              text[] NOT NULL,
  currency                  char(3) NOT NULL DEFAULT 'CAD',
  per_transfer_limit_minor  bigint NOT NULL CHECK (per_transfer_limit_minor >= 0),
  daily_limit_minor         bigint NOT NULL CHECK (daily_limit_minor >= 0),
  monthly_limit_minor       bigint NOT NULL CHECK (monthly_limit_minor >= 0),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  updated_by                text
);
CREATE TRIGGER kyc_tiers_updated_at BEFORE UPDATE ON compliance.kyc_tiers FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Current compliance view of each customer (compliance-service is the source of truth for KYC tier).
CREATE TABLE compliance.customer_profiles (
  user_id      uuid PRIMARY KEY, -- core.users.id
  kyc_tier     smallint NOT NULL DEFAULT 0 REFERENCES compliance.kyc_tiers (tier),
  kyc_status   text NOT NULL DEFAULT 'PENDING'
                 CHECK (kyc_status IN ('PENDING', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED')),
  risk_rating  text NOT NULL DEFAULT 'low' CHECK (risk_rating IN ('low', 'medium', 'high')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER customer_profiles_updated_at BEFORE UPDATE ON compliance.customer_profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per KYC submission. Raw ID images are never stored here: only the vendor's references.
CREATE TABLE compliance.kyc_records (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id           uuid NOT NULL,
  tier_requested    smallint NOT NULL REFERENCES compliance.kyc_tiers (tier),
  status            text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED')),
  vendor            text NOT NULL DEFAULT 'mock',
  vendor_reference  text,
  document_type     text CHECK (document_type IN ('drivers_licence', 'passport', 'national_id', 'pr_card')),
  document_country  char(2),
  rejection_reason  text,
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decided_by        text, -- 'vendor' or a staff user id
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, vendor_reference)
);
CREATE INDEX kyc_records_user_idx ON compliance.kyc_records (user_id, created_at DESC);
CREATE INDEX kyc_records_open_idx ON compliance.kyc_records (status) WHERE status IN ('SUBMITTED', 'UNDER_REVIEW');
CREATE TRIGGER kyc_records_updated_at BEFORE UPDATE ON compliance.kyc_records FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE compliance.kyc_documents (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  kyc_record_id    uuid NOT NULL REFERENCES compliance.kyc_records (id),
  kind             text NOT NULL CHECK (kind IN ('id_front', 'id_back', 'selfie', 'proof_of_address', 'proof_of_income')),
  vendor_file_ref  text NOT NULL,
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (kyc_record_id, kind)
);

-- ---------------------------------------------------------------- AML rules engine configuration
-- Rules are data, so compliance officers can tune them without a code change.
CREATE TABLE compliance.aml_rules (
  code          text PRIMARY KEY,
  description   text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  action        text NOT NULL CHECK (action IN ('block', 'flag', 'score', 'report')),
  score_weight  smallint NOT NULL DEFAULT 0 CHECK (score_weight BETWEEN 0 AND 100),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  updated_by    text
);
CREATE TRIGGER aml_rules_updated_at BEFORE UPDATE ON compliance.aml_rules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Fraud score (0-100) routing: < auto_approve_below passes, >= block_at_or_above blocks, in between is flagged.
CREATE TABLE compliance.risk_thresholds (
  id                  smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  auto_approve_below  smallint NOT NULL CHECK (auto_approve_below BETWEEN 0 AND 100),
  block_at_or_above   smallint NOT NULL CHECK (block_at_or_above BETWEEN 0 AND 100),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          text,
  CHECK (auto_approve_below <= block_at_or_above)
);
CREATE TRIGGER risk_thresholds_updated_at BEFORE UPDATE ON compliance.risk_thresholds FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE compliance.country_risk (
  country_code  char(2) PRIMARY KEY CHECK (country_code ~ '^[A-Z]{2}$'),
  risk_tier     smallint NOT NULL CHECK (risk_tier BETWEEN 1 AND 3),
  note          text,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER country_risk_updated_at BEFORE UPDATE ON compliance.country_risk FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- screening results
CREATE TABLE compliance.screenings (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  transfer_id      uuid NOT NULL, -- core.transfers.id
  user_id          uuid NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('pass', 'flag', 'block')),
  fraud_score      smallint NOT NULL CHECK (fraud_score BETWEEN 0 AND 100),
  rules_triggered  text[] NOT NULL DEFAULT '{}',
  sanctions_hit    boolean NOT NULL DEFAULT false,
  duration_ms      integer,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX screenings_transfer_idx ON compliance.screenings (transfer_id);
CREATE INDEX screenings_user_idx ON compliance.screenings (user_id, created_at DESC);
SELECT public.make_append_only('compliance.screenings');

-- Every compliance decision with full context, for audit (append-only, kept >= 5 years).
CREATE TABLE compliance.compliance_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  screening_id  uuid REFERENCES compliance.screenings (id),
  transfer_id   uuid,
  user_id       uuid,
  event_type    text NOT NULL CHECK (event_type IN ('kyc_decision', 'sanctions_check', 'aml_rule', 'fraud_score',
                                                     'manual_review', 'report_generated', 'config_changed')),
  rule_code     text,
  result        text NOT NULL CHECK (result IN ('pass', 'flag', 'block', 'info')),
  score         smallint,
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_type    text NOT NULL DEFAULT 'system' CHECK (actor_type IN ('system', 'staff', 'vendor')),
  actor_id      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX compliance_events_transfer_idx ON compliance.compliance_events (transfer_id, id);
CREATE INDEX compliance_events_user_idx ON compliance.compliance_events (user_id, created_at DESC);
SELECT public.make_append_only('compliance.compliance_events');

-- Manual review queue for flagged transfers.
CREATE TABLE compliance.review_cases (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  transfer_id      uuid NOT NULL,
  user_id          uuid NOT NULL,
  screening_id     uuid NOT NULL REFERENCES compliance.screenings (id),
  reason           text NOT NULL,
  rules_triggered  text[] NOT NULL DEFAULT '{}',
  fraud_score      smallint,
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  status           text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_review', 'approved', 'rejected')),
  assigned_to      uuid,
  decided_by       uuid,
  decision_note    text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  decided_at       timestamptz,
  CONSTRAINT review_cases_decision CHECK (
    (status IN ('approved', 'rejected')) = (decided_by IS NOT NULL AND decided_at IS NOT NULL AND decision_note IS NOT NULL)
  )
);
CREATE UNIQUE INDEX review_cases_one_open_per_transfer ON compliance.review_cases (transfer_id) WHERE status IN ('open', 'in_review');
CREATE INDEX review_cases_queue_idx ON compliance.review_cases (status, priority, created_at);
CREATE TRIGGER review_cases_updated_at BEFORE UPDATE ON compliance.review_cases FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------------------------------------------------------------- sanctions lists (free official downloads)
CREATE TABLE compliance.sanctions_lists (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  source        text NOT NULL CHECK (source IN ('OFAC_SDN', 'UN_CONSOLIDATED', 'CA_CONSOLIDATED')),
  version       text NOT NULL,        -- publish date / checksum reported by the source
  checksum      text NOT NULL,
  entry_count   integer NOT NULL DEFAULT 0,
  is_active     boolean NOT NULL DEFAULT false,
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source, checksum)
);
CREATE UNIQUE INDEX sanctions_lists_one_active ON compliance.sanctions_lists (source) WHERE is_active;

CREATE TABLE compliance.sanctions_entries (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  list_id        uuid NOT NULL REFERENCES compliance.sanctions_lists (id) ON DELETE CASCADE,
  source_uid     text NOT NULL,
  entity_type    text NOT NULL CHECK (entity_type IN ('individual', 'entity', 'vessel', 'aircraft', 'other')),
  primary_name   text NOT NULL,
  programs       text[] NOT NULL DEFAULT '{}',
  nationalities  text[] NOT NULL DEFAULT '{}',
  dates_of_birth text[] NOT NULL DEFAULT '{}',
  remarks        text,
  raw            jsonb,
  UNIQUE (list_id, source_uid)
);

-- Primary names and aliases, normalised (lower-case, no accents/punctuation) for fuzzy matching.
CREATE TABLE compliance.sanctions_names (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id         bigint NOT NULL REFERENCES compliance.sanctions_entries (id) ON DELETE CASCADE,
  name             text NOT NULL,
  name_normalized  text NOT NULL,
  is_primary       boolean NOT NULL DEFAULT false
);
CREATE INDEX sanctions_names_trgm_idx ON compliance.sanctions_names USING gin (name_normalized gin_trgm_ops);
CREATE INDEX sanctions_names_entry_idx ON compliance.sanctions_names (entry_id);

-- Old list versions are removed by the loader once a new version is active.
GRANT DELETE ON compliance.sanctions_lists TO ap_compliance;

-- ---------------------------------------------------------------- regulatory reports (FINTRAC)
-- Engineering generates drafts; the Compliance Officer reviews and files them.
CREATE TABLE compliance.regulatory_reports (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  report_type        text NOT NULL CHECK (report_type IN ('STR', 'EFTR')), -- suspicious transaction / international EFT >= CAD 10,000
  transfer_id        uuid,
  user_id            uuid,
  trigger            text NOT NULL,  -- rule code or 'manual'
  status             text NOT NULL DEFAULT 'draft'
                       CHECK (status IN ('draft', 'pending_review', 'approved', 'filed', 'rejected')),
  payload            jsonb NOT NULL,
  document_path      text,           -- generated PDF under the reports storage folder
  due_by             timestamptz,
  prepared_by        text NOT NULL DEFAULT 'system',
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  filed_at           timestamptz,
  filing_reference   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX regulatory_reports_queue_idx ON compliance.regulatory_reports (status, due_by);
CREATE UNIQUE INDEX regulatory_reports_one_per_transfer ON compliance.regulatory_reports (report_type, transfer_id) WHERE transfer_id IS NOT NULL;
CREATE TRIGGER regulatory_reports_updated_at BEFORE UPDATE ON compliance.regulatory_reports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

SELECT public.create_messaging_tables('compliance');

-- Down Migration
DROP TABLE compliance.inbox;
DROP TABLE compliance.outbox;
DROP TABLE compliance.regulatory_reports;
DROP TABLE compliance.sanctions_names;
DROP TABLE compliance.sanctions_entries;
DROP TABLE compliance.sanctions_lists;
DROP TABLE compliance.review_cases;
DROP TABLE compliance.compliance_events;
DROP TABLE compliance.screenings;
DROP TABLE compliance.country_risk;
DROP TABLE compliance.risk_thresholds;
DROP TABLE compliance.aml_rules;
DROP TABLE compliance.kyc_documents;
DROP TABLE compliance.kyc_records;
DROP TABLE compliance.customer_profiles;
DROP TABLE compliance.kyc_tiers;
