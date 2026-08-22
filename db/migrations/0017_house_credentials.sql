-- 0017  House credentials, and the rule for which login files a permit
--
-- Two organisations can file the same permit, and which one does it is not a
-- preference. It follows from whose license the work is qualified under:
--
--   White Glove          -> the permit is pulled under OUR license and our
--                           qualifier supervises it, so it must go in under our
--                           municipal account.
--   Bring your own       -> the permit is under the CONTRACTOR'S license, so it
--                           must go in under theirs. Filing that under our
--                           account would put our license on their job.
--
-- Getting this backwards is not a cosmetic bug. It is a license attached to
-- work nobody from this company qualified, which is the exact offence the
-- supervision model exists to avoid. So it is recorded on the permit as a fact,
-- resolved by a database function, and not left to whichever code path happens
-- to be filing.

-- -----------------------------------------------------------------------------
-- permits: whose license is this under?
-- -----------------------------------------------------------------------------

create type ocs.qualifying_party as enum (
  'contractor',    -- the contractor's own license
  'ocs_license'    -- ours, with our qualifier supervising
);

alter table ocs.permits
  add column qualified_by ocs.qualifying_party not null default 'contractor';

comment on column ocs.permits.qualified_by is
  'Whose contractor license this permit is filed under. Determines which '
  'municipal account files it, and who is answerable for supervision.';

create index permits_qualified_by_idx on ocs.permits (company_id, qualified_by)
  where deleted_at is null;

-- -----------------------------------------------------------------------------
-- integration_credentials: allow a credential that belongs to nobody
--
-- A null company_id means a HOUSE credential: our own municipal login, not any
-- contractor's. It has to be nullable rather than a separate table because
-- everything else about the row -- the encryption, the verification state, the
-- error tracking, the adapter it belongs to -- is identical, and two tables
-- would mean two of every query and one of them eventually forgotten.
-- -----------------------------------------------------------------------------

alter table ocs.integration_credentials
  alter column company_id drop not null;

-- Records who the credential is for, in a form a person reading a row can see
-- at a glance without having to know that null means something.
alter table ocs.integration_credentials
  add column is_house boolean generated always as (company_id is null) stored;

-- The original unique constraint ignores house rows, because NULL is never
-- equal to NULL in a unique index. This gives them the same protection.
create unique index integration_credentials_house_key
  on ocs.integration_credentials (integration_key, municipality_id)
  where company_id is null;

-- Same again for a house credential that is not tied to one jurisdiction (an
-- account covering every Accela agency, for instance).
create unique index integration_credentials_house_global_key
  on ocs.integration_credentials (integration_key)
  where company_id is null and municipality_id is null;

create index integration_credentials_house_idx
  on ocs.integration_credentials (integration_key) where company_id is null and is_active;

-- -----------------------------------------------------------------------------
-- RLS
--
-- 0008 gave this table the standard tenant policy: a row is visible when its
-- company_id matches the caller's, or in service context. A house row has no
-- company_id, so under that policy it is visible ONLY in service context --
-- which is exactly right and needs no new policy. A contractor cannot see our
-- municipal accounts, and the worker can.
--
-- Stated explicitly here because "it works because NULL never matches" is the
-- kind of accident that gets tidied away by someone later.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- Which credential files this permit?
--
-- Returns the credential to use, or null when none is configured -- in which
-- case the caller must fall back to a person doing it by hand, never to the
-- other party's account.
-- -----------------------------------------------------------------------------

create or replace function ocs.resolve_filing_credential(p_permit_id uuid)
returns uuid
  language plpgsql
  stable
  security definer
  set search_path = ocs, pg_temp
as $$
declare
  v_company    uuid;
  v_muni       uuid;
  v_qualified  ocs.qualifying_party;
  v_platform   ocs.permit_platform;
  v_key        text;
  v_credential uuid;
begin
  select p.company_id, p.municipality_id, p.qualified_by, m.platform
    into v_company, v_muni, v_qualified, v_platform
    from ocs.permits p
    left join ocs.municipalities m on m.id = p.municipality_id
   where p.id = p_permit_id and p.deleted_at is null;

  if v_company is null then
    return null;
  end if;

  v_key := coalesce(v_platform::text, 'none');

  if v_qualified = 'ocs_license' then
    -- Ours. Prefer a credential for this specific agency, then a global one.
    select id into v_credential
      from ocs.integration_credentials
     where company_id is null
       and integration_key = v_key
       and is_active
       and (municipality_id = v_muni or municipality_id is null)
     order by (municipality_id is not null) desc
     limit 1;
  else
    -- Theirs. Never fall back to a house credential here: doing so would file
    -- the contractor's own-license work under our account.
    select id into v_credential
      from ocs.integration_credentials
     where company_id = v_company
       and integration_key = v_key
       and is_active
       and (municipality_id = v_muni or municipality_id is null)
     order by (municipality_id is not null) desc
     limit 1;
  end if;

  return v_credential;
end;
$$;

revoke all on function ocs.resolve_filing_credential(uuid) from public;
grant execute on function ocs.resolve_filing_credential(uuid) to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- Accela is the first adapter, so record what we know about it.
-- Still 'documented': nothing here has been run against a live Florida agency.
-- -----------------------------------------------------------------------------

update ocs.platform_capabilities
   set has_public_api = true,
       auth_method    = 'oauth2',
       docs_url       = 'https://developer.accela.com/docs/api_reference/api-index.html',
       notes = 'Construct API v4. Agency apps authenticate with the OAuth2 password '
               'grant against apis.accela.com, scoped to an agency name and '
               'environment (PROD/TEST). One app credential serves every agency '
               'that authorises it, which is why this is modelled per vendor '
               'rather than per jurisdiction.'
 where platform = 'accela';
