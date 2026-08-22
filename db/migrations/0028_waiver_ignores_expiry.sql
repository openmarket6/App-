-- 0028  A waiver is not subject to an expiry date
--
-- can_file_for in 0027 required every blocking requirement to be both decided
-- ('accepted' or 'waived') AND unexpired. That second condition is right for an
-- accepted certificate and wrong for a waiver: waiving a requirement is a
-- person deciding it does not apply to this contractor, which cannot then be
-- undone by a date on the document it was waived against.
--
-- The practical case is a contractor whose expired workers-comp policy has been
-- waived because they are an exempt qualifying officer. Under 0027 they stayed
-- blocked forever, and the waiver did nothing at all.
--
-- A new migration rather than an edit to 0027. Editing an applied migration is
-- what froze every deploy earlier tonight: the runner checksums each applied
-- file and refuses to continue when one changes, which is correct and is why
-- forward-only is the rule here regardless of where 0027 has reached.

create or replace function ocs.can_file_for(p_company_id uuid)
returns boolean language sql stable set search_path = ocs, pg_temp
as $$
  select not exists (
    select 1
      from unnest(array['GENERAL_LIABILITY','WORKERS_COMP','STATE_LICENSE']::ocs.compliance_kind[]) as required(kind)
     where not exists (
       select 1 from ocs.compliance_items c
        where c.company_id = p_company_id
          and c.decision in ('accepted', 'waived')
          -- A waiver stands regardless of the date on what was waived.
          and (
            c.decision = 'waived'
            or c.expires_at is null
            or c.expires_at >= current_date
          )
          and (
            c.kind = required.kind
            or (required.kind = 'WORKERS_COMP' and c.kind = 'WORKERS_COMP_EXEMPTION')
          )
     )
  )
$$;
