-- 0025  A portal login cannot outlive its company
--
-- 0014 says a CLIENT must have a client_id and a staff account must not. 0001
-- declared that column `on delete set null`, so deleting a contractor company
-- set its portal users' client_id to null while leaving them CLIENT -- a state
-- the constraint forbids. The next write touching one of those rows failed,
-- and the failure surfaced somewhere unrelated to the deletion that caused it.
--
-- The two rules were each right and together impossible. This makes them agree:
-- a portal login exists to see one company's permits and invoices, so when that
-- company goes, the login goes with it. There is nothing left for it to show.
--
-- Cascade rather than a trigger that demotes them, because a demoted CLIENT is
-- an account with a password, no company and no role -- which is exactly the
-- "can sign in but sees nothing" state that already costs support time.

alter table ocs.app_users
  drop constraint if exists app_users_client_id_fkey;

alter table ocs.app_users
  add constraint app_users_client_id_fkey
  foreign key (client_id) references ocs.companies (id) on delete cascade;

-- Any row already in the broken state: no company to belong to, still marked
-- as a portal user. Deleted rather than repaired, because there is no company
-- to repair them back to.
delete from ocs.app_users
 where app_role = 'CLIENT' and client_id is null;

-- Now that no row can violate it, validate the constraint so PostgreSQL
-- enforces it on existing rows too rather than only on new ones.
alter table ocs.app_users
  validate constraint app_users_client_role_consistency;
