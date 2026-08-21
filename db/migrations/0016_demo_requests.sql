-- 0016  Demo requests from the public site
--
-- The one table written by someone who is not a customer yet, which makes it
-- the only public write surface in the schema and the reason it is fenced this
-- carefully.
--
-- Nothing here is tenant-scoped: a prospect has no company in this system, and
-- inventing one for them would put a stranger's typed-in text inside a
-- contractor's tenant boundary. Instead the table is readable only in service
-- context (staff, via the API) and insertable by the unauthenticated route.

create table ocs.demo_requests (
  id            uuid primary key default gen_random_uuid(),

  company_name  text not null check (length(btrim(company_name)) between 1 and 200),
  contact_name  text not null check (length(btrim(contact_name)) between 1 and 200),
  email         text not null check (position('@' in email) > 1),
  phone         text,

  -- What they said they need. Free text, deliberately: a prospect describing
  -- their problem in their own words is worth more than a dropdown.
  trades        text[] not null default '{}',
  counties      text[] not null default '{}',
  monthly_permits text,
  message       text check (message is null or length(message) <= 4000),

  -- Where they came from. Not analytics for its own sake -- knowing which page
  -- produced a lead is what tells us which claim actually lands.
  source_page   text,
  referrer      text,

  -- Sales workflow. Kept minimal on purpose; this is a lead list, not a CRM.
  status        text not null default 'new'
                  check (status in ('new', 'contacted', 'scheduled', 'won', 'lost', 'spam')),
  handled_by    uuid references ocs.app_users (id),
  handled_at    timestamptz,
  internal_note text,

  -- Kept for abuse handling only. A submission flood is traced and blocked by
  -- address; nothing else reads these.
  ip_address    inet,
  user_agent    text,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index demo_requests_status_idx on ocs.demo_requests (status, created_at desc);
create index demo_requests_email_idx on ocs.demo_requests (lower(email), created_at desc);

create trigger demo_requests_set_updated_at
  before update on ocs.demo_requests
  for each row execute function ocs.set_updated_at();

-- Normalise the email so the duplicate check below sees "A@x.com" and
-- "a@x.com" as one person.
create or replace function ocs.normalise_demo_request() returns trigger
  language plpgsql set search_path = ocs, pg_temp
as $$
begin
  new.email := lower(btrim(new.email));
  new.company_name := btrim(new.company_name);
  new.contact_name := btrim(new.contact_name);
  return new;
end;
$$;

create trigger demo_requests_normalise
  before insert or update of email, company_name, contact_name on ocs.demo_requests
  for each row execute function ocs.normalise_demo_request();

-- -----------------------------------------------------------------------------
-- RLS
--
-- Reading the list, changing a status, seeing anyone's email address: all
-- require service context, which only authenticated staff routes can open.
-- Writing goes through the function below and nowhere else.
--
-- The asymmetry is the point: a stranger may add a row and can never read one
-- back, so this table cannot be used to enumerate who else has enquired.
-- -----------------------------------------------------------------------------

alter table ocs.demo_requests enable row level security;
alter table ocs.demo_requests force row level security;

create policy demo_requests_read on ocs.demo_requests
  for select to ocs_app, ocs_service using (ocs.is_service_context());

create policy demo_requests_update on ocs.demo_requests
  for update to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());

grant select, update on ocs.demo_requests to ocs_app, ocs_service;

-- -----------------------------------------------------------------------------
-- The one way in.
--
-- Note there is no INSERT policy above and no INSERT grant. A plain insert by
-- an unauthenticated caller is impossible; the only route in is this function.
--
-- It is SECURITY DEFINER, so it runs as the owner and can therefore do the one
-- thing an anonymous caller cannot: read the table, to see whether this address
-- already wrote in minutes ago. That read is why the function exists. An
-- ordinary INSERT ... RETURNING would need the same read privilege for its
-- RETURNING clause, and granting it would let anyone with the public form
-- enumerate every lead in the table.
--
-- What makes the elevated privilege safe is that it has no reach: the arguments
-- are the contents of one row, the body performs exactly one insert into one
-- table, and the only thing it returns is the id of the row it just wrote.
-- There is no parameter here that can widen what it touches.
-- -----------------------------------------------------------------------------

create or replace function ocs.submit_demo_request(
  p_company_name    text,
  p_contact_name    text,
  p_email           text,
  p_phone           text,
  p_trades          text[],
  p_counties        text[],
  p_monthly_permits text,
  p_message         text,
  p_source_page     text,
  p_referrer        text,
  p_ip              inet,
  p_user_agent      text,
  p_dedupe_minutes  int default 10
) returns uuid
  language plpgsql
  security definer
  set search_path = ocs, pg_temp
as $$
declare
  existing uuid;
  fresh    uuid;
begin
  -- Someone double-clicking Send, or resubmitting because the page scrolled,
  -- should not become two leads for sales to work. Deliberately not a unique
  -- constraint: the same company enquiring again months later is a real second
  -- lead, and refusing it would lose a customer.
  select id into existing
    from ocs.demo_requests
   where lower(email) = lower(btrim(p_email))
     and created_at > now() - make_interval(mins => greatest(p_dedupe_minutes, 0))
   order by created_at desc
   limit 1;

  if existing is not null then
    return existing;
  end if;

  insert into ocs.demo_requests
    (company_name, contact_name, email, phone, trades, counties,
     monthly_permits, message, source_page, referrer, ip_address, user_agent)
  values
    (p_company_name, p_contact_name, p_email, p_phone,
     coalesce(p_trades, '{}'), coalesce(p_counties, '{}'),
     p_monthly_permits, p_message, p_source_page, p_referrer, p_ip, p_user_agent)
  returning id into fresh;

  return fresh;
end;
$$;

-- PUBLIC would include every future role. Named roles only.
revoke all on function ocs.submit_demo_request(
  text, text, text, text, text[], text[], text, text, text, text, inet, text, int
) from public;

grant execute on function ocs.submit_demo_request(
  text, text, text, text, text[], text[], text, text, text, text, inet, text, int
) to ocs_app, ocs_service;
