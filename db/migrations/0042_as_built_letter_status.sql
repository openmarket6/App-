-- 0042  Let an as-built letter reach a terminal status
--
-- Separate from 0041 because Postgres will not let a value added by
-- ALTER TYPE ... ADD VALUE be USED in the same transaction, and the runner
-- wraps each migration in one. 0041 adds the value; this uses it.
--
-- generated_documents_status_fits_kind pairs each kind with the terminal status
-- that means something for it: a Notice of Commencement is 'recorded' with the
-- clerk, a Notice to Owner is 'served' on the owner. A letter is 'executed' —
-- signed by the contractor whose licence backs it — which is the same terminal
-- state as the agreements, and the constraint listed those two kinds by name.
--
-- Recreated rather than added alongside: two check constraints saying
-- overlapping things about one column is how a later reader gets it wrong.

alter table ocs.generated_documents
  drop constraint generated_documents_status_fits_kind;

alter table ocs.generated_documents
  add constraint generated_documents_status_fits_kind check (
    status in ('draft', 'issued', 'void')
    or (kind = 'NOC' and status = 'recorded')
    or (kind = 'NTO' and status = 'served')
    or (kind in ('HOLD_HARMLESS', 'CONTRACTOR_AGREEMENT', 'AS_BUILT_LETTER')
        and status = 'executed')
  );
