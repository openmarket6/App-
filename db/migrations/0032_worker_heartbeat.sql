-- 0032  Worker heartbeat
--
-- The background worker is the whole reason this system runs on Render rather
-- than entirely on Netlify: it is what polls municipal portals, sends licence
-- expiry reminders and delivers notifications. On the previous all-Netlify
-- build those scheduled checks never fired, and nobody knew for months.
--
-- Nothing currently records that it is running. An idle worker and a crashed
-- one are indistinguishable from the outside: both leave an empty queue. So the
-- exact failure that motivated the move is invisible again -- work silently
-- stops happening, and the first symptom is a contractor asking why nobody told
-- them their permit was approved.
--
-- A row updated on every poll makes it observable. One row, not a log of them:
-- what matters is "when did it last check in", and history of that is the job
-- of a metrics system, not this table.

create table ocs.worker_heartbeats (
  -- The worker's identity. Render restarts give a new instance id, so the
  -- queue name is the stable key -- otherwise every deploy leaves a dead row
  -- behind and "is anything alive" becomes a question about which row to read.
  queue         text primary key,

  instance_id   text,
  last_seen_at  timestamptz not null default now(),
  started_at    timestamptz not null default now(),

  -- What it has actually done, so a heartbeat proves work rather than merely
  -- proving a process exists. A worker that polls and never completes anything
  -- is a different failure, and one this distinguishes.
  jobs_processed bigint not null default 0,
  last_job_at   timestamptz,

  commit_sha    text,
  created_at    timestamptz not null default now()
);

-- Service-only. A heartbeat is written by the worker and read by the health
-- endpoint, both of which run in service context; no tenant has business here.
alter table ocs.worker_heartbeats enable row level security;
alter table ocs.worker_heartbeats force row level security;

create policy service_only on ocs.worker_heartbeats
  for all to ocs_app, ocs_service
  using (ocs.is_service_context()) with check (ocs.is_service_context());

grant select, insert, update on ocs.worker_heartbeats to ocs_app, ocs_service;

/*
 * Is a worker alive?
 *
 * Two minutes rather than a tighter bound: the poll interval plus a slow job
 * plus a restart has to fit inside it, or a healthy worker reports as dead
 * during an ordinary deploy and the alarm stops meaning anything.
 */
create or replace function ocs.worker_is_alive(p_queue text default 'default')
returns boolean language sql stable set search_path = ocs, pg_temp
as $$
  select exists (
    select 1 from ocs.worker_heartbeats
     where queue = p_queue and last_seen_at > now() - interval '2 minutes'
  )
$$;

grant execute on function ocs.worker_is_alive(text) to ocs_app, ocs_service;
