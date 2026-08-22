import type { PermitStage } from '@flph/shared';

/** Human labels for the fourteen stages. Kept next to the badge so every
 *  surface in the app spells a stage the same way. */
export const STAGE_LABELS: Record<PermitStage, string> = {
  DRAFT: 'Draft',
  READY_TO_SUBMIT: 'Ready to submit',
  SUBMITTED: 'Submitted',
  INTAKE_REVIEW: 'Intake review',
  IN_REVIEW: 'In review',
  CORRECTIONS_REQUIRED: 'Corrections required',
  RESUBMITTED: 'Resubmitted',
  APPROVED: 'Approved',
  ISSUED: 'Issued',
  INSPECTIONS: 'Inspections',
  CLOSED: 'Closed',
  EXPIRED: 'Expired',
  WITHDRAWN: 'Withdrawn',
  DENIED: 'Denied',
};

/** Who the stage says we are waiting on. Drives the colour. */
const STAGE_CLASS: Record<PermitStage, string> = {
  DRAFT: 'badge-gray',
  READY_TO_SUBMIT: 'badge-blue',
  SUBMITTED: 'badge-blue',
  INTAKE_REVIEW: 'badge-blue',
  IN_REVIEW: 'badge-blue',
  CORRECTIONS_REQUIRED: 'badge-amber',
  RESUBMITTED: 'badge-blue',
  APPROVED: 'badge-green',
  ISSUED: 'badge-green',
  INSPECTIONS: 'badge-green',
  CLOSED: 'badge-gray',
  EXPIRED: 'badge-red',
  WITHDRAWN: 'badge-gray',
  DENIED: 'badge-red',
};

export function stageLabel(stage: PermitStage | null | undefined): string {
  return stage ? (STAGE_LABELS[stage] ?? stage) : 'Unknown';
}

export default function StageBadge({
  stage,
  className = '',
  title,
}: {
  stage: PermitStage | null | undefined;
  className?: string;
  title?: string;
}) {
  if (!stage) return <span className={`badge-gray ${className}`}>No stage</span>;
  return (
    <span className={`${STAGE_CLASS[stage] ?? 'badge-gray'} ${className}`} title={title}>
      {STAGE_LABELS[stage] ?? stage}
    </span>
  );
}
