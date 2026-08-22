-- 0034  Which service line a contractor is on, and whether they may file
--
-- Two facts the application has been asserting for a while with nowhere to
-- store them.
--
-- SERVICE LINE. `ocs.service_line` was added in 0030, but only to invoices --
-- so the line could be billed correctly while nothing recorded which line a
-- contractor was actually on. The frontend has a `serviceLine` on every client
-- and decides real behaviour with it: the supervision tab appears only for
-- MANAGED_LICENSE, and a permit on that line cannot be filed without naming a
-- qualifying agent. All of that was running off a value the API invented at
-- read time, which meant every contractor looked like EXPEDITING no matter
-- what they had been sold.
--
-- The distinction is not cosmetic. On MANAGED_LICENSE our qualifier's licence
-- goes on the permit and we become the contractor of record, which makes
-- supervision a legal obligation rather than a service. Recording the wrong
-- line is how a job ends up supervised by nobody with our licence on it.
--
-- FILING HOLD. A coordinator puts a contractor on hold when insurance lapses
-- or paperwork is outstanding, and nothing new should be filed until it is
-- resolved. The screen to do it already exists and has been posting into a
-- 404. Storing the REASON alongside the flag is the point: a hold with no
-- stated reason is one nobody can clear, because nobody remembers what it was
-- waiting for.

alter table ocs.companies
  add column service_line ocs.service_line not null default 'EXPEDITING',

  add column filing_hold boolean not null default false,
  add column filing_hold_reason text,

  -- A hold with no reason cannot be acted on. Enforced rather than asked for,
  -- because the moment it is optional it will be left blank in a hurry and the
  -- next person will have to guess.
  add constraint companies_filing_hold_has_reason
    check (not filing_hold or (filing_hold_reason is not null
                               and length(btrim(filing_hold_reason)) > 0));

-- Held accounts are read together on the dashboard and before every filing, and
-- they are a small minority of rows -- a partial index is the whole table's
-- worth of benefit for a fraction of its cost.
create index companies_filing_hold_idx on ocs.companies (id)
  where filing_hold and deleted_at is null;

create index companies_service_line_idx on ocs.companies (service_line)
  where deleted_at is null;

comment on column ocs.companies.service_line is
  'EXPEDITING: the contractor holds the licence and we file for them. '
  'MANAGED_LICENSE: our licence and our qualifier, so supervision is a legal '
  'obligation. Drives pricing, required paperwork and whether a permit may be '
  'filed without a qualifying agent.';

comment on column ocs.companies.filing_hold is
  'Set by a coordinator when paperwork or insurance blocks new filings. '
  'Existing permits continue; nothing new may be started.';
