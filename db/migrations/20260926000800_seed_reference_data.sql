-- Up Migration
-- Baseline configuration every environment starts with. All values are editable later
-- (admin endpoints / new migrations). Rationale for each number: docs/DECISIONS.md.
-- Amounts are CAD minor units (cents): 50000 = CAD 500.00.

INSERT INTO compliance.kyc_tiers (tier, name, requirements, per_transfer_limit_minor, daily_limit_minor, monthly_limit_minor) VALUES
  (0, 'Registered',   ARRAY['account created'],                                   0,       0,       0),
  (1, 'Basic',        ARRAY['email verified', 'phone verified'],                  50000,   99900,   150000),
  (2, 'Verified',     ARRAY['government photo ID', 'live selfie'],                300000,  500000,  1500000),
  (3, 'Enhanced',     ARRAY['government photo ID', 'live selfie', 'proof of address', 'proof of income'],
                                                                                  1000000, 2000000, 5000000)
ON CONFLICT (tier) DO NOTHING;

INSERT INTO compliance.risk_thresholds (id, auto_approve_below, block_at_or_above) VALUES (1, 40, 80)
ON CONFLICT (id) DO NOTHING;

INSERT INTO compliance.aml_rules (code, description, action, score_weight, params) VALUES
  ('AMOUNT_OVER_TIER_LIMIT', 'Transfer or rolling 24h/30d total exceeds the sender''s KYC tier limit', 'block', 0,   '{}'),
  ('VELOCITY_1H',            'More than 3 transfers initiated in any 60-minute window',                'flag',  30,  '{"maxTransfers": 3, "windowMinutes": 60}'),
  ('VELOCITY_24H',           'More than 5 transfers initiated in 24 hours',                            'flag',  25,  '{"maxTransfers": 5, "windowHours": 24}'),
  ('DAILY_AMOUNT',           'Total sent in the last 24 hours exceeds CAD 5,000',                      'flag',  25,  '{"maxAmountMinor": 500000, "currency": "CAD", "windowHours": 24}'),
  ('NEW_BENEFICIARY',        'Recipient not seen in the sender''s history before',                     'score', 15,  '{}'),
  ('HIGH_RISK_CORRIDOR',     'Destination country is on the internal risk tier 3 list',                'flag',  40,  '{"minRiskTier": 3}'),
  ('SANCTIONS_MATCH',        'Sender or recipient name matches a sanctions list entry',                'block', 100, '{"blockAtOrAbove": 0.90, "reviewAtOrAbove": 0.75}'),
  ('ROUND_AMOUNT_PATTERN',   'Repeated transfers of exactly the same round amount (possible structuring)', 'flag', 30, '{"minRepeats": 3, "windowDays": 7, "roundToMinor": 10000}'),
  ('LARGE_EFT_REPORT',       'International EFT of CAD 10,000+ (single or within 24h): draft a FINTRAC EFT report', 'report', 0, '{"thresholdMinor": 1000000, "currency": "CAD", "windowHours": 24}')
ON CONFLICT (code) DO NOTHING;

INSERT INTO compliance.country_risk (country_code, risk_tier, note) VALUES
  ('CA', 1, 'Send country'),
  ('PK', 2, 'Primary destination corridor — standard enhanced monitoring'),
  ('IN', 2, 'Secondary destination corridor — standard enhanced monitoring'),
  ('KP', 3, 'FATF call-for-action jurisdiction'),
  ('IR', 3, 'FATF call-for-action jurisdiction'),
  ('MM', 3, 'FATF call-for-action jurisdiction')
ON CONFLICT (country_code) DO NOTHING;

INSERT INTO fx.corridors (code, send_country, send_currency, receive_country, receive_currency, spread_bps,
                          fixed_fee_minor, card_surcharge_bps, min_send_minor, max_send_minor, payout_methods, delivery_estimate) VALUES
  ('CA-PK', 'CA', 'CAD', 'PK', 'PKR', 150, 299, 200, 1000, 1000000, ARRAY['bank_account', 'mobile_wallet'], 'Within minutes to 1 business day'),
  ('CA-IN', 'CA', 'CAD', 'IN', 'INR', 120, 299, 200, 1000, 1000000, ARRAY['bank_account'],                  'Within 1 business day')
ON CONFLICT (code) DO NOTHING;

INSERT INTO ledger.accounts (code, currency, name, type, normal_balance) VALUES
  ('payment_clearing_cad', 'CAD', 'Payment processor clearing (money collected, not yet settled to bank)', 'asset',     'debit'),
  ('customer_funds_cad',   'CAD', 'Customer funds held for payout (owed to senders)',                      'liability', 'credit'),
  ('fee_revenue_cad',      'CAD', 'Transfer fees and card surcharges',                                     'revenue',   'credit'),
  ('fx_position_cad',      'CAD', 'FX conversion position (CAD side)',                                     'asset',     'debit'),
  ('fx_position_pkr',      'PKR', 'FX conversion position (PKR side)',                                     'asset',     'debit'),
  ('fx_position_inr',      'INR', 'FX conversion position (INR side)',                                     'asset',     'debit'),
  ('partner_prefund_pkr',  'PKR', 'Pre-funded balance at payout partner (Pakistan)',                       'asset',     'debit'),
  ('partner_prefund_inr',  'INR', 'Pre-funded balance at payout partner (India)',                          'asset',     'debit')
ON CONFLICT (code) DO NOTHING;

-- Down Migration
-- Removes only seed rows nothing references: rolling back must not fail (or destroy history) just because
-- locks, profiles or ledger entries point at a corridor, tier or account. Tables are dropped by earlier
-- migrations' Down sections anyway; Up above is idempotent, so rollback + re-apply always works.
DELETE FROM ledger.accounts a
 WHERE code IN ('payment_clearing_cad', 'customer_funds_cad', 'fee_revenue_cad', 'fx_position_cad',
                'fx_position_pkr', 'fx_position_inr', 'partner_prefund_pkr', 'partner_prefund_inr')
   AND NOT EXISTS (SELECT 1 FROM ledger.entries e WHERE e.account_code = a.code);
DELETE FROM fx.corridors c
 WHERE code IN ('CA-PK', 'CA-IN')
   AND NOT EXISTS (SELECT 1 FROM fx.fx_locks l WHERE l.corridor_code = c.code);
DELETE FROM compliance.country_risk WHERE country_code IN ('CA', 'PK', 'IN', 'KP', 'IR', 'MM');
DELETE FROM compliance.aml_rules;
DELETE FROM compliance.risk_thresholds;
DELETE FROM compliance.kyc_tiers t
 WHERE NOT EXISTS (SELECT 1 FROM compliance.customer_profiles p WHERE p.kyc_tier = t.tier)
   AND NOT EXISTS (SELECT 1 FROM compliance.kyc_records r WHERE r.tier_requested = t.tier);
