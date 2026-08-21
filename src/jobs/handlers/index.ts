/**
 * Handler registration.
 *
 * One place that knows every job type. The worker refuses to start a job type
 * it has no handler for, so a job enqueued but never registered here fails
 * loudly and permanently rather than sitting queued forever.
 */
import { register as registerPermitStatus } from './permitStatus.js';
import { register as registerCompliance } from './compliance.js';
import { register as registerNotifications } from './notifications.js';
import { register as registerSystem } from './system.js';
import { register as registerPayments } from './payments.js';
import { register as registerSupervision } from './supervision.js';

let registered = false;

export function registerAllHandlers(): void {
  if (registered) return;
  registerPermitStatus();
  registerCompliance();
  registerNotifications();
  registerSystem();
  registerPayments();
  registerSupervision();
  registered = true;
}
