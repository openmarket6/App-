-- 0038_ops_failsafes.sql
--
-- Everything here exists because of one live incident: on 22 Aug 2026 the
-- worker was killed mid-job by a redeploy. Two jobs stayed `running` with an
-- expired lock. One of them was `system.reap_stuck_jobs` -- the job whose only
-- purpose is to clear exactly that state. The dedupe index then made every
-- subsequent enqueue of the reaper a silent no-op, while `job_schedules`
-- carried on advancing `next_run_at` as if it were running. `/healthz/queue`
-- reported `ok` throughout, because its only test was heartbeat freshness.
--
-- The lesson: a watchdog must not be a member of the set it watches, and a
-- schedule that claims to have run must record whether it actually did.

-- ---------------------------------------------------------------------------
-- 1. Schedules record their outcome.
--
-- `last_run_at` currently means "the scheduler tried to enqueue this", which
-- is not the same as "this ran". Without an outcome column there is no way to
-- tell a schedule that succeeded from one whose enqueue was deduped against a
-- wedged job.
-- ---------------------------------------------------------------------------
alter table ocs.job_schedules
  add column if not exists last_status          text,
  add column if not exists last_error           text,
  add column if not exists consecutive_failures integer not null default 0,
  add column if not exists last_enqueued_job_id uuid;

comment on column ocs.job_schedules.last_status is
  'Outcome of the most recent run: enqueued | deduped | succeeded | failed | dead. '
  'NULL means it has never been recorded -- treat that as unknown, not healthy.';

-- ---------------------------------------------------------------------------
-- 2. A reaper that lives in the database.
--
-- The Node reaper is fine, but it can only run if the worker is healthy, which
-- is precisely the case where it is not needed. This one runs regardless -- by
-- pg_cron if the extension is available, or by the API process, or by hand.
-- ---------------------------------------------------------------------------
create or replace function ocs.reap_stuck_jobs()
returns integer
language plpgsql
security definer
set search_path = ocs, pg_temp
as $$
declare
  n integer;
begin
  with reaped as (
    update ocs.jobs
       set status      = (case when attempts >= max_attempts then 'dead' else 'failed' end)::ocs.job_status,
           last_error  = coalesce(last_error, 'lock expired; worker died before completing'),
           error_count = error_count + 1,
           locked_at   = null,
           locked_by   = null,
           run_at      = now() + interval '60 seconds',
           finished_at = case when attempts >= max_attempts then now() else null end
     where status = 'running'
       and locked_at < now() - make_interval(secs => timeout_seconds)
    returning id
  )
  select count(*) into n from reaped;
  return n;
end;
$$;

grant execute on function ocs.reap_stuck_jobs() to ocs_service;

-- ---------------------------------------------------------------------------
-- 3. The hunter.
--
-- One function that knows every way this system rots quietly. The health
-- endpoint reads it, the external watchdog reads it, and a human can read it
-- in the SQL editor. One definition, so the three cannot disagree.
--
-- Severity: 'critical' = money, data or legal exposure. 'warn' = will become
-- critical if ignored. Anything returned here is a fact, not a guess.
-- ---------------------------------------------------------------------------
create or replace function ocs.ops_alerts()
returns table (severity text, code text, detail jsonb)
language sql
stable
security definer
set search_path = ocs, pg_temp
as $$
  -- The worker has stopped checking in.
  select 'critical', 'worker_silent',
         jsonb_build_object('lastSeenAt', max(h.last_seen_at),
                            'instanceId', max(h.instance_id))
    from ocs.worker_heartbeats h
   having coalesce(max(h.last_seen_at), 'epoch'::timestamptz) < now() - interval '5 minutes'

  union all
  -- Jobs holding an expired lock. This is the state that deadlocked the reaper.
  select 'critical', 'jobs_stuck',
         jsonb_build_object('count', count(*),
                            'types', jsonb_agg(distinct j.job_type),
                            'oldestLockedFor', max(now() - j.locked_at)::text)
    from ocs.jobs j
   where j.status = 'running'
     and j.locked_at < now() - make_interval(secs => j.timeout_seconds)
  having count(*) > 0

  union all
  -- Work that has exhausted its retries. Someone must decide what happens.
  select 'critical', 'jobs_dead',
         jsonb_build_object('count', count(*), 'types', jsonb_agg(distinct j.job_type))
    from ocs.jobs j
   where j.status = 'dead' and j.finished_at > now() - interval '24 hours'
  having count(*) > 0

  union all
  -- A schedule whose next run is far past due: the scheduler is not ticking.
  select 'critical', 'schedule_overdue',
         jsonb_build_object('names', jsonb_agg(s.name),
                            'worstOverdueBy', max(now() - s.next_run_at)::text)
    from ocs.job_schedules s
   where s.is_enabled
     and s.next_run_at < now() - make_interval(secs => s.interval_seconds)
  having count(*) > 0

  union all
  -- A schedule that keeps failing. Distinct from overdue: this one runs, and
  -- loses, every time.
  select 'warn', 'schedule_failing',
         jsonb_build_object('names', jsonb_agg(s.name), 'worst', max(s.consecutive_failures))
    from ocs.job_schedules s
   where s.consecutive_failures >= 3
  having count(*) > 0

  union all
  -- Tables that only ever grow. Cheap to check, invisible until it is not.
  select 'warn', 'refresh_tokens_bloat',
         jsonb_build_object('total', count(*),
                            'reclaimable', count(*) filter (where revoked_at is not null
                                                               or expires_at < now()))
    from ocs.refresh_tokens
  having count(*) filter (where revoked_at is not null or expires_at < now()) > 1000

  union all
  -- Uploads that got a signed URL and never completed. Each one is either an
  -- orphaned object in the bucket or a document a user believes they filed.
  select 'warn', 'uploads_abandoned',
         jsonb_build_object('count', count(*), 'oldest', min(v.created_at))
    from ocs.document_versions v
   where v.upload_state = 'pending' and v.created_at < now() - interval '2 hours'
  having count(*) > 0

  union all
  -- A permit nobody has checked against its agency in far longer than intended.
  -- This is the failure that costs a client a deadline.
  select 'critical', 'permits_unchecked',
         jsonb_build_object('count', count(*), 'oldestCheckedAt', min(p.last_checked_at))
    from ocs.permits p
   where p.status not in ('issued', 'closed', 'expired', 'rejected', 'withdrawn')
     and coalesce(p.last_checked_at, p.created_at) < now() - interval '3 days'
  having count(*) > 0

  union all
  -- An account that can sign in as ADMIN and was created for a test.
  select 'critical', 'test_accounts_live',
         jsonb_build_object('emails', jsonb_agg(u.email))
    from ocs.app_users u
   where u.is_active
     and u.deleted_at is null
     and (u.email like '%@test.invalid' or u.email like '%@example.com'
          or u.email like 'dryrun%' or u.email like '%+test@%')
  having count(*) > 0

  union all
  -- An invitation nobody accepted, still redeemable. Invite tokens are stored
  -- in plaintext, so an old one is a standing account-takeover primitive.
  select 'warn', 'invites_stale',
         jsonb_build_object('count', count(*), 'emails', jsonb_agg(u.email))
    from ocs.app_users u
   where u.invite_token is not null
     and u.password_hash is null
     and u.created_at < now() - interval '7 days'
  having count(*) > 0

  union all
  -- Money that does not add up. An invoice whose recorded payments disagree
  -- with its paid total means a reconciliation has silently failed.
  select 'critical', 'invoice_payment_mismatch',
         jsonb_build_object('count', count(*), 'invoiceIds', jsonb_agg(x.id))
    from (
      select i.id
        from ocs.invoices i
        left join ocs.payments p on p.invoice_id = i.id and p.status = 'succeeded'
       group by i.id, i.amount_paid_cents
      having coalesce(sum(p.amount_cents), 0) <> i.amount_paid_cents
    ) x
  having count(*) > 0
$$;

grant execute on function ocs.ops_alerts() to ocs_service;

-- ---------------------------------------------------------------------------
-- 4. Indexes for the paths that will table-scan.
--
-- Row-level security rewrites every statement on these tables to include
-- `company_id = ocs.current_company_id()`. A tenant table whose company_id
-- leads no index sequential-scans on every single read.
-- ---------------------------------------------------------------------------
create index if not exists document_seals_company_idx        on ocs.document_seals (company_id);
create index if not exists drafting_deliverables_company_idx on ocs.drafting_deliverables (company_id);
create index if not exists support_messages_company_idx      on ocs.support_messages (company_id);
create index if not exists webhook_events_company_idx        on ocs.webhook_events (company_id);

-- Keyset pagination orders by (created_at desc, id desc) within a tenant.
create index if not exists payments_company_created_idx on ocs.payments (company_id, created_at desc, id desc);
create index if not exists invoices_company_created_idx on ocs.invoices (company_id, created_at desc, id desc);

-- Cascade deletes and joins that currently scan the child table.
create index if not exists notification_deliveries_notification_idx on ocs.notification_deliveries (notification_id);
create index if not exists integration_runs_job_idx                 on ocs.integration_runs (job_id);
create index if not exists integration_credentials_municipality_idx on ocs.integration_credentials (municipality_id);
create index if not exists invoices_permit_idx                      on ocs.invoices (permit_id);
create index if not exists invoices_project_idx                     on ocs.invoices (project_id);
create index if not exists payments_permit_idx                      on ocs.payments (permit_id);
create index if not exists supervision_incidents_visit_idx          on ocs.supervision_incidents (visit_id);
create index if not exists licenses_qualifier_idx                   on ocs.licenses (qualifier_id);
create index if not exists message_attachments_document_idx         on ocs.message_attachments (document_id);

-- Cheap, and it is what `jobs_stuck` and the reaper both scan.
create index if not exists jobs_running_locked_idx on ocs.jobs (locked_at) where status = 'running';

-- ---------------------------------------------------------------------------
-- 5. Run the hunter on a schedule.
--
-- Fifteen minutes is chosen so a problem is found while the person who caused
-- it is still at their desk.
-- ---------------------------------------------------------------------------
insert into ocs.job_schedules (name, job_type, queue, interval_seconds, payload, is_enabled, next_run_at)
values ('integrity-sweep', 'system.integrity_sweep', 'default', 900, '{}'::jsonb, true, now())
on conflict (name) do update
  set job_type = excluded.job_type,
      interval_seconds = excluded.interval_seconds,
      is_enabled = true;

-- Re-enable the refresh-token cleanup: it now has a handler.
update ocs.job_schedules
   set is_enabled = true, last_status = null, last_error = null, consecutive_failures = 0,
       next_run_at = now()
 where job_type = 'system.cleanup_refresh_tokens';

-- Free any job whose lock expired while this migration was being written. The
-- reaper cannot do it if the reaper is one of them.
select ocs.reap_stuck_jobs();
