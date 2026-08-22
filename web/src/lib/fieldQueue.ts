/**
 * The supervisor's outbox.
 *
 * A job site is the worst network on earth: a concrete stairwell, a metal roof,
 * one bar that comes and goes. The field screen is the one place in this
 * product where losing a request means losing evidence that cannot be
 * recreated — nobody can go back and photograph a roof deck that is now
 * covered.
 *
 * So every field action is written to disk BEFORE it is sent, and stays there
 * until the server has confirmed it. The screen reads its state from the same
 * store, which is why a queued item looks identical whether it is waiting for
 * signal or waiting for a response.
 *
 * IndexedDB rather than localStorage, deliberately: a single photograph as
 * base64 runs past a megabyte and localStorage caps out around five. A
 * supervisor who takes twelve photographs on a site with no signal must not
 * lose the twelfth.
 */

const DB_NAME = 'ocs-field';
const DB_VERSION = 1;
const STORE = 'outbox';

export type FieldActionKind = 'check-in' | 'photo' | 'sign-off';

export interface FieldAction {
  id: string;
  visitId: string;
  kind: FieldActionKind;
  /** The request body, exactly as it will be sent. */
  body: unknown;
  /** Something short to show in a list: "Photo — work in progress". */
  label: string;
  createdAt: string;
  attempts: number;
  lastError: string | null;
  /**
   * Set when the server refused in a way that retrying cannot fix — a 400, a
   * 403, a 409. Those need a person, not another attempt, and a queue that
   * retries them forever looks busy while achieving nothing.
   */
  blocked: boolean;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser has no offline storage.'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open offline storage'));
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('Offline storage failed'));
    t.oncomplete = () => db.close();
  });
}

/** A stable id without depending on crypto.randomUUID being present. */
function newId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

export async function enqueue(
  input: Omit<FieldAction, 'id' | 'createdAt' | 'attempts' | 'lastError' | 'blocked'>,
): Promise<FieldAction> {
  const action: FieldAction = {
    ...input,
    id: newId(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
    blocked: false,
  };
  await tx('readwrite', (s) => s.put(action));
  return action;
}

export async function listQueue(): Promise<FieldAction[]> {
  const all = await tx<FieldAction[]>('readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function remove(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id));
}

async function update(action: FieldAction): Promise<void> {
  await tx('readwrite', (s) => s.put(action));
}

export interface FlushResult {
  sent: number;
  blocked: number;
  remaining: number;
}

/**
 * Send everything that is waiting, oldest first.
 *
 * ORDER MATTERS and is not an implementation detail: a photograph posted before
 * its check-in, or a sign-off posted before its photographs, is refused by the
 * server for a reason that will not go away on retry. So the flush stops at the
 * first action for a visit that fails temporarily, and moves on to other
 * visits — one site with no signal must not hold up another.
 */
export async function flush(
  send: (action: FieldAction) => Promise<void>,
): Promise<FlushResult> {
  const queue = await listQueue();
  const stalled = new Set<string>();
  let sent = 0;
  let blocked = 0;

  for (const action of queue) {
    if (action.blocked) {
      blocked += 1;
      continue;
    }
    if (stalled.has(action.visitId)) continue;

    try {
      await send(action);
      await remove(action.id);
      sent += 1;
    } catch (err) {
      const status = (err as { status?: number }).status;
      const permanent = typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
      await update({
        ...action,
        attempts: action.attempts + 1,
        lastError: err instanceof Error ? err.message : 'Could not send',
        blocked: permanent,
      });
      if (permanent) blocked += 1;
      // Whether it was permanent or not, later actions for this visit depend
      // on this one having landed. Skip the rest of the visit, keep the order.
      stalled.add(action.visitId);
    }
  }

  const remaining = (await listQueue()).length;
  return { sent, blocked, remaining };
}

/** Drop a blocked action a person has looked at and decided to abandon. */
export async function discard(id: string): Promise<void> {
  await remove(id);
}

/** Un-block an action so the next flush tries it again. */
export async function retry(id: string): Promise<void> {
  const all = await listQueue();
  const found = all.find((a) => a.id === id);
  if (found) await update({ ...found, blocked: false, lastError: null });
}
