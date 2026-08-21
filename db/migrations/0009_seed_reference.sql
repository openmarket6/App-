-- =============================================================================
-- 0009  Seed: Florida jurisdictions and recurring job schedules
-- =============================================================================
-- Idempotent -- safe to re-run on every deploy.
--
-- NOTE ON INTEGRATION FIELDS: every jurisdiction is seeded with
-- integration_method = 'manual' and status_check_enabled = false, and
-- portal_url is left NULL. Those values are deliberately blank rather than
-- guessed. Automated status checking stays off for a jurisdiction until someone
-- has confirmed its real portal URL and access method and filled them in --
-- pointing a scraper at a guessed URL produces confidently wrong permit
-- statuses, which is worse than no automation at all.
-- =============================================================================

insert into ocs.municipalities (name, kind, county, state, integration_method)
select v.name, 'county'::ocs.jurisdiction_kind, v.name, 'FL', 'manual'::ocs.integration_method
from (values
  ('Alachua'),('Baker'),('Bay'),('Bradford'),('Brevard'),('Broward'),('Calhoun'),
  ('Charlotte'),('Citrus'),('Clay'),('Collier'),('Columbia'),('DeSoto'),('Dixie'),
  ('Duval'),('Escambia'),('Flagler'),('Franklin'),('Gadsden'),('Gilchrist'),
  ('Glades'),('Gulf'),('Hamilton'),('Hardee'),('Hendry'),('Hernando'),
  ('Highlands'),('Hillsborough'),('Holmes'),('Indian River'),('Jackson'),
  ('Jefferson'),('Lafayette'),('Lake'),('Lee'),('Leon'),('Levy'),('Liberty'),
  ('Madison'),('Manatee'),('Marion'),('Martin'),('Miami-Dade'),('Monroe'),
  ('Nassau'),('Okaloosa'),('Okeechobee'),('Orange'),('Osceola'),('Palm Beach'),
  ('Pasco'),('Pinellas'),('Polk'),('Putnam'),('St. Johns'),('St. Lucie'),
  ('Santa Rosa'),('Sarasota'),('Seminole'),('Sumter'),('Suwannee'),('Taylor'),
  ('Union'),('Volusia'),('Wakulla'),('Walton'),('Washington')
) as v(name)
on conflict (name, kind, state) do nothing;

insert into ocs.municipalities (name, kind, county, state, integration_method)
select v.name, 'city'::ocs.jurisdiction_kind, v.county, 'FL', 'manual'::ocs.integration_method
from (values
  ('Jacksonville','Duval'),
  ('Miami','Miami-Dade'),
  ('Tampa','Hillsborough'),
  ('Orlando','Orange'),
  ('St. Petersburg','Pinellas'),
  ('Hialeah','Miami-Dade'),
  ('Port St. Lucie','St. Lucie'),
  ('Cape Coral','Lee'),
  ('Tallahassee','Leon'),
  ('Fort Lauderdale','Broward'),
  ('Pembroke Pines','Broward'),
  ('Hollywood','Broward'),
  ('Gainesville','Alachua'),
  ('Miramar','Broward'),
  ('Coral Springs','Broward'),
  ('Palm Bay','Brevard'),
  ('West Palm Beach','Palm Beach'),
  ('Clearwater','Pinellas'),
  ('Lakeland','Polk'),
  ('Pompano Beach','Broward'),
  ('Miami Gardens','Miami-Dade'),
  ('Davie','Broward'),
  ('Boca Raton','Palm Beach'),
  ('Sunrise','Broward'),
  ('Deltona','Volusia'),
  ('Plantation','Broward'),
  ('Fort Myers','Lee'),
  ('Naples','Collier'),
  ('Sarasota','Sarasota'),
  ('Kissimmee','Osceola'),
  ('Bradenton','Manatee'),
  ('Melbourne','Brevard'),
  ('Ocala','Marion'),
  ('Daytona Beach','Volusia'),
  ('Pensacola','Escambia')
) as v(name, county)
on conflict (name, kind, state) do nothing;

-- Statewide licensing authority (DBPR) as a jurisdiction row so state-certified
-- licenses have something to reference.
insert into ocs.municipalities (name, kind, state, integration_method)
values ('Florida DBPR', 'state', 'FL', 'manual')
on conflict (name, kind, state) do nothing;

-- -----------------------------------------------------------------------------
-- Recurring jobs.
--
-- Intervals are conservative on purpose. Municipal portals are the fragile part
-- of this system: checking a permit every few minutes gets our IP blocked and
-- helps nobody, because jurisdictions update status daily at best.
-- -----------------------------------------------------------------------------

insert into ocs.job_schedules (name, job_type, queue, interval_seconds, payload)
values
  -- Fans out one status-check job per permit that is due.
  ('permit-status-sweep', 'permit.status_sweep', 'integrations', 3600, '{}'::jsonb),

  -- Licenses, insurance and permits approaching expiry -> notifications.
  ('expiration-scan', 'compliance.expiration_scan', 'default', 86400, '{}'::jsonb),

  -- Reclaims jobs whose worker died mid-run (see reaper in src/jobs/runner.ts).
  ('reap-stuck-jobs', 'system.reap_stuck_jobs', 'default', 300, '{}'::jsonb),

  -- Retries provider webhooks that failed to process.
  ('retry-failed-webhooks', 'system.retry_failed_webhooks', 'default', 900, '{}'::jsonb),

  -- Hard-deletes storage objects for documents past their retention window.
  ('purge-deleted-documents', 'documents.purge_expired', 'default', 86400, '{}'::jsonb),

  -- Clears expired idempotency keys so the table does not grow without bound.
  ('cleanup-idempotency-keys', 'system.cleanup_idempotency', 'default', 3600, '{}'::jsonb),

  -- Flags succeeded payments that have never been reconciled.
  ('payment-reconciliation', 'payments.reconcile', 'default', 86400, '{}'::jsonb)
on conflict (name) do nothing;
