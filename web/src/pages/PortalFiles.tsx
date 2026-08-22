import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { can, type PortalFolder } from '@flph/shared';
import { get, post } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { fmtDate, fmtDateTime } from '../lib/format.ts';
import { fmtBytes, readFileAsUpload } from '../lib/upload.ts';
import { errorMessage } from '../components/ErrorState.tsx';
import { DOC_STATUS_CLASS, DOC_STATUS_LABEL } from '../lib/portal-copy.ts';
import type {
  PortalFolderDocument,
  PortalFolderResponse,
  PortalTrailStep,
  PortalTreeResponse,
  PortalUploadResponse,
} from '../lib/portal-shapes.ts';
import DocumentLink from '../components/DocumentLink.tsx';
import EmptyState from '../components/EmptyState.tsx';
import ErrorState from '../components/ErrorState.tsx';
import { LoadingPanel } from '../components/Spinner.tsx';

/**
 * Your files.
 *
 * The folder tree is derived on the server from the contractor's own rows, so
 * there is nothing here to keep in sync and no way to mis-file: a folder that
 * accepts uploads decides for itself what category the upload becomes, which
 * is why the upload body deliberately carries no `category`, `permitId` or
 * `clientId` at all. The path is the association.
 *
 * Two details do most of the work for the person holding the phone. Every
 * folder states what belongs in it even when it is empty — an empty folder
 * saying "no files" teaches nobody anything, and an empty folder saying
 * "Florida Product Approval sheets for every product in the assembly" is a
 * checklist. And older revisions fold under the current one rather than
 * sitting beside it, because five rows called "roof-plan.pdf" is how the wrong
 * revision gets sent to a plans examiner.
 */

const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** `/files` for the root, `/files/company/compliance` for anything else. */
function href(path: string): string {
  return path ? `/files/${path}` : '/files';
}

/** Encode each segment, keep the separators — the API decodes the whole path. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

/**
 * The folder carries `needsAttention` as a boolean; the sentence behind it is
 * a presentation decision, so it is made here rather than shipped from the API.
 */
function attentionReason(folder: PortalFolder): string {
  switch (folder.kind) {
    case 'compliance':
      return 'Something in here is missing or out of date. Until it is current we cannot file anything new for you.';
    case 'agreements':
      return 'Something in here is waiting for your signature.';
    default:
      return 'Something inside this folder needs you. Open it to see what.';
  }
}

export default function PortalFiles() {
  const params = useParams();
  const path = (params['*'] ?? '').replace(/^\/+|\/+$/g, '');
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState<Set<string>>(() => new Set(['company', 'projects']));

  const canUpload = !!user && (can(user.role, 'portal:upload_own') || can(user.role, 'document:upload'));

  const treeQ = useQuery({
    queryKey: ['portal', 'tree'],
    queryFn: () => get<PortalTreeResponse>('/portal/folders'),
  });

  // The root's contents are already in the tree — it holds no documents of its
  // own — so asking for them again would be a second round trip for nothing.
  const folderQ = useQuery({
    queryKey: ['portal', 'folder', path],
    queryFn: () => get<PortalFolderResponse>(`/portal/folders/${encodePath(path)}`),
    enabled: path !== '',
  });

  const root = treeQ.data?.tree ?? null;

  const folder: PortalFolder | null = path === '' ? root : (folderQ.data?.folder ?? null);
  const trail: PortalTrailStep[] =
    path === ''
      ? root
        ? [{ path: '', name: root.name, kind: root.kind }]
        : []
      : (folderQ.data?.trail ?? []);
  const documents = path === '' ? [] : (folderQ.data?.documents ?? []);

  const groups = useMemo(() => groupVersions(documents), [documents]);

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['portal', 'tree'] });
    void qc.invalidateQueries({ queryKey: ['portal', 'folder'] });
    void qc.invalidateQueries({ queryKey: ['portal', 'actions'] });
    void qc.invalidateQueries({ queryKey: ['documents'] });
  }, [qc]);

  const toggle = useCallback((p: string) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }, []);

  const loading = treeQ.isLoading || (path !== '' && folderQ.isLoading);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Your files</h1>
        <p className="mt-1 text-sm text-ink-soft leading-relaxed max-w-2xl">
          Everything we hold for you, filed the way you think about it — your company paperwork in one place, then a
          folder per job with a folder inside for each permit on it. Folders are built from your own records, so
          nothing here can go stale or end up on the wrong job.
        </p>
      </div>

      {treeQ.isError && (
        <ErrorState error={treeQ.error} onRetry={() => void treeQ.refetch()} title="Could not load your folders" />
      )}

      {loading && !root && <LoadingPanel label="Opening your folders…" rows={5} />}

      {root && (
        <div className="grid gap-4 md:grid-cols-[248px_minmax(0,1fr)] items-start">
          {/* --- tree (desktop) --------------------------------------------- */}
          <aside className="hidden md:block card overflow-hidden">
            <div className="border-b border-line px-3 py-2">
              <span className="label">All folders</span>
            </div>
            <div className="max-h-[70vh] overflow-y-auto py-1.5">
              <TreeNode node={root} depth={0} activePath={path} open={open} onToggle={toggle} />
            </div>
          </aside>

          {/* --- contents --------------------------------------------------- */}
          <div className="min-w-0 space-y-4">
            <Breadcrumb trail={trail} />

            {path !== '' && folderQ.isError && (
              <ErrorState
                error={folderQ.error}
                onRetry={() => void folderQ.refetch()}
                title="Could not open that folder"
              />
            )}

            {folder && (
              <>
                <div className="card card-pad">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <h2 className="text-base font-semibold leading-tight">{folder.name}</h2>
                      {folder.hint && (
                        <p className="mt-1 text-[13px] text-ink-soft leading-relaxed max-w-2xl">{folder.hint}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {folder.needsAttention && (
                        <span className="badge-amber" title={attentionReason(folder)}>
                          Needs you
                        </span>
                      )}
                      <span className="badge-gray tabular-nums">
                        {folder.totalDocuments} file{folder.totalDocuments === 1 ? '' : 's'}
                      </span>
                    </div>
                  </div>
                  {folder.needsAttention && (
                    <p className="mt-2 rounded-md bg-warn-soft px-3 py-2 text-[12px] text-warn leading-relaxed">
                      {attentionReason(folder)}
                    </p>
                  )}
                </div>

                {folder.children.length > 0 && (
                  <section>
                    <h3 className="label mb-2">Folders inside</h3>
                    <ul className="card divide-y divide-line overflow-hidden">
                      {folder.children.map((child) => (
                        <li key={child.path}>
                          <Link
                            to={href(child.path)}
                            className="flex items-center gap-3 px-4 py-3.5 hover:bg-page transition-colors"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-2">
                                <span className="text-[14px] font-medium truncate">{child.name}</span>
                                {child.needsAttention && (
                                  <span
                                    className="h-2 w-2 shrink-0 rounded-full bg-warn"
                                    title={attentionReason(child)}
                                    aria-label="Needs your attention"
                                  />
                                )}
                              </span>
                              {child.hint && (
                                <span className="mt-0.5 block text-[12px] text-ink-soft leading-snug line-clamp-2">
                                  {child.hint}
                                </span>
                              )}
                            </span>
                            <span className="badge-gray shrink-0 tabular-nums">{child.totalDocuments}</span>
                            <span className="text-ink-mute shrink-0" aria-hidden>
                              ›
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {folder.acceptsUpload && canUpload && (
                  <FolderUpload key={folder.path} folder={folder} onUploaded={invalidate} />
                )}

                {folder.acceptsUpload && !canUpload && (
                  <div className="card">
                    <EmptyState
                      title="Your login cannot upload"
                      hint="You can open and read everything here. Ask whoever administers your company's logins to give you upload access, or send the file to your coordinator."
                      compact
                    />
                  </div>
                )}

                {!folder.acceptsUpload && folder.kind !== 'root' && folder.kind !== 'project' && (
                  <p className="text-[12px] text-ink-mute">
                    This folder is filled in from our side — you cannot upload into it, but everything that lands here
                    is yours to keep.
                  </p>
                )}

                <section>
                  <div className="flex items-baseline justify-between gap-3 mb-2">
                    <h3 className="label">Files in this folder</h3>
                    {groups.length > 0 && (
                      <span className="text-[12px] text-ink-mute tabular-nums">
                        {groups.length} file{groups.length === 1 ? '' : 's'} · newest first
                      </span>
                    )}
                  </div>

                  {path !== '' && folderQ.isLoading && <LoadingPanel label="Loading files…" rows={2} />}

                  {groups.length === 0 && !folderQ.isLoading ? (
                    <div className="card">
                      <EmptyState
                        title={folder.children.length > 0 ? 'Nothing filed at this level' : 'Nothing here yet'}
                        hint={
                          folder.children.length > 0
                            ? 'Files live in the folders above. Open one to see what belongs in it.'
                            : folder.acceptsUpload
                              ? (folder.hint ?? 'Drop a file above and it is filed for you.')
                              : 'Nothing has arrived here yet. When it does — an issued permit card, a correction notice, an inspection result — it appears here automatically.'
                        }
                        compact
                      />
                    </div>
                  ) : (
                    <ul className="card divide-y divide-line overflow-hidden">
                      {groups.map((g) => (
                        <FileRow key={g.current.id} group={g} />
                      ))}
                    </ul>
                  )}
                </section>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Breadcrumb                                                                  */
/* -------------------------------------------------------------------------- */

function Breadcrumb({ trail }: { trail: PortalTrailStep[] }) {
  if (trail.length === 0) return null;
  const parent = trail.length > 1 ? trail[trail.length - 2]! : null;

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {parent && (
        <Link to={href(parent.path)} className="btn-ghost md:hidden px-2.5 py-1.5 text-[13px]">
          ← {parent.name}
        </Link>
      )}
      <nav aria-label="Breadcrumb" className="min-w-0 overflow-x-auto">
        <ol className="flex items-center gap-1.5 whitespace-nowrap text-[13px]">
          {trail.map((step, i) => {
            const last = i === trail.length - 1;
            return (
              <li key={step.path || 'root'} className="flex items-center gap-1.5">
                {i > 0 && (
                  <span className="text-ink-mute" aria-hidden>
                    ›
                  </span>
                )}
                {last ? (
                  <span className="font-medium text-ink" aria-current="page">
                    {step.name}
                  </span>
                ) : (
                  <Link to={href(step.path)} className="link">
                    {step.name}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </nav>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tree                                                                        */
/* -------------------------------------------------------------------------- */

function TreeNode({
  node,
  depth,
  activePath,
  open,
  onToggle,
}: {
  node: PortalFolder;
  depth: number;
  activePath: string;
  open: Set<string>;
  onToggle: (path: string) => void;
}) {
  const isActive = node.path === activePath;
  // An ancestor of what you are looking at is always open, whatever you last
  // clicked — otherwise deep-linking into a permit section shows a shut tree.
  const isAncestor = activePath === node.path || activePath.startsWith(node.path ? `${node.path}/` : '');
  const expanded = node.children.length > 0 && (open.has(node.path) || isAncestor);

  return (
    <div>
      <div
        className={`flex items-center gap-1 pr-2 ${isActive ? 'bg-brand-soft' : 'hover:bg-page'}`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {node.children.length > 0 ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            className="w-4 shrink-0 text-[10px] text-ink-mute hover:text-ink"
            aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
            aria-expanded={expanded}
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4 shrink-0" aria-hidden />
        )}
        <Link
          to={href(node.path)}
          className={`min-w-0 flex-1 truncate py-1.5 text-[13px] ${
            isActive ? 'font-semibold text-brand' : 'text-ink hover:text-brand'
          }`}
          title={node.hint ?? node.name}
        >
          {node.name}
        </Link>
        {node.needsAttention && (
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-warn"
            title={attentionReason(node)}
            aria-label="Needs your attention"
          />
        )}
        {node.totalDocuments > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums text-ink-mute">{node.totalDocuments}</span>
        )}
      </div>
      {expanded &&
        node.children.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={depth + 1}
            activePath={activePath}
            open={open}
            onToggle={onToggle}
          />
        ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* File rows and version collapsing                                            */
/* -------------------------------------------------------------------------- */

interface DocGroup {
  current: PortalFolderDocument;
  earlier: PortalFolderDocument[];
}

/**
 * Fold every superseded revision under the row that replaced it.
 *
 * Chains are walked backwards from each current row through `supersedesId`.
 * A superseded row whose replacement was filed into a different folder would
 * otherwise disappear from the tree entirely, so anything left unclaimed at
 * the end is rendered on its own — a file that exists must be findable.
 */
function groupVersions(docs: PortalFolderDocument[]): DocGroup[] {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const claimed = new Set<string>();
  const groups: DocGroup[] = [];

  for (const d of docs) {
    if (d.superseded) continue;
    const earlier: PortalFolderDocument[] = [];
    const seen = new Set<string>([d.id]);
    let cursor = d.supersedesId;
    while (cursor && byId.has(cursor) && !seen.has(cursor)) {
      seen.add(cursor);
      const prev = byId.get(cursor)!;
      earlier.push(prev);
      claimed.add(prev.id);
      cursor = prev.supersedesId;
    }
    groups.push({ current: d, earlier });
  }

  for (const d of docs) {
    if (d.superseded && !claimed.has(d.id)) groups.push({ current: d, earlier: [] });
  }

  return groups.sort((a, b) => Date.parse(b.current.uploadedAt) - Date.parse(a.current.uploadedAt));
}

function FileRow({ group }: { group: DocGroup }) {
  const [showEarlier, setShowEarlier] = useState(false);
  const d = group.current;

  return (
    <li className="px-4 py-3">
      <div className="flex items-start gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <DocumentLink documentId={d.id} className="link text-[14px] font-medium text-left break-words">
            {d.fileName}
          </DocumentLink>
          <div className="mt-1 flex items-center gap-2 flex-wrap text-[12px] text-ink-soft">
            <span className={DOC_STATUS_CLASS[d.status]}>{DOC_STATUS_LABEL[d.status]}</span>
            <span className="badge-gray tabular-nums">v{d.version}</span>
            <span className="tabular-nums">{fmtBytes(d.sizeBytes)}</span>
            <span aria-hidden>·</span>
            <span>
              {fmtDate(d.uploadedAt)} by {d.uploadedByName ?? 'us'}
            </span>
          </div>
          {d.capturedAt && (
            <div className="mt-0.5 text-[11px] text-ink-mute">Taken {fmtDateTime(d.capturedAt)}</div>
          )}
        </div>
      </div>

      {group.earlier.length > 0 && (
        <div className="mt-2">
          <button
            type="button"
            className="link text-[12px]"
            onClick={() => setShowEarlier((v) => !v)}
            aria-expanded={showEarlier}
          >
            {showEarlier ? 'Hide' : 'Show'} {group.earlier.length} earlier version
            {group.earlier.length === 1 ? '' : 's'}
          </button>
          {showEarlier && (
            <ul className="mt-2 space-y-1.5 border-l-2 border-line pl-3">
              {group.earlier.map((e) => (
                <li key={e.id} className="flex items-baseline gap-2 flex-wrap text-[12px] text-ink-soft">
                  <span className="badge-gray tabular-nums">v{e.version}</span>
                  <DocumentLink documentId={e.id} className="link text-[12px]">
                    {e.fileName}
                  </DocumentLink>
                  <span className="tabular-nums">{fmtBytes(e.sizeBytes)}</span>
                  <span>
                    {fmtDate(e.uploadedAt)} by {e.uploadedByName ?? 'us'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Upload                                                                      */
/* -------------------------------------------------------------------------- */

type UploadState = 'queued' | 'reading' | 'uploading' | 'done' | 'error';

interface UploadRow {
  key: string;
  name: string;
  size: number;
  state: UploadState;
  error: string | null;
}

const STATE_LABEL: Record<UploadState, string> = {
  queued: 'Waiting',
  reading: 'Reading…',
  uploading: 'Uploading…',
  done: 'Filed',
  error: 'Failed',
};

/**
 * Drag-and-drop or pick, straight into this folder.
 *
 * Files go up one at a time and each carries its own outcome. A batch that
 * reports one error for eight files leaves somebody guessing which of the
 * eight is on the roof and which is not, so every row says for itself.
 */
function FolderUpload({ folder, onUploaded }: { folder: PortalFolder; onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [rows, setRows] = useState<UploadRow[]>([]);
  const [busy, setBusy] = useState(false);

  const photosOnly = folder.uploadCategories.some((c) => c === 'JOB_PHOTO' || c === 'SUPERVISION_PHOTO');
  const cap = photosOnly ? MAX_PHOTO_BYTES : MAX_UPLOAD_BYTES;

  const setRow = useCallback((key: string, patch: Partial<UploadRow>) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }, []);

  const start = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      const stamp = Date.now();
      const fresh: UploadRow[] = files.map((f, i) => ({
        key: `${stamp}-${i}-${f.name}`,
        name: f.name,
        size: f.size,
        state: 'queued',
        error: null,
      }));
      setRows((prev) => [...prev, ...fresh]);
      setBusy(true);

      let anySucceeded = false;
      for (const [i, file] of files.entries()) {
        const key = fresh[i]!.key;

        if (photosOnly && !file.type.startsWith('image/')) {
          setRow(key, { state: 'error', error: `${file.type || 'That file type'} is not an image — this folder takes photos only.` });
          continue;
        }
        if (file.size > cap) {
          setRow(key, {
            state: 'error',
            error: `${fmtBytes(file.size)} is over the ${fmtBytes(cap)} limit. Send a smaller copy.`,
          });
          continue;
        }

        try {
          setRow(key, { state: 'reading' });
          const payload = await readFileAsUpload(file);
          setRow(key, { state: 'uploading' });
          // No `category`, `permitId` or `clientId` in the body — the folder
          // path decides all three and the API rejects them outright.
          await post<PortalUploadResponse>(`/portal/folders/${encodePath(folder.path)}/upload`, {
            fileName: payload.fileName,
            contentType: payload.contentType,
            sizeBytes: payload.sizeBytes,
            dataBase64: payload.dataBase64,
            ...(photosOnly ? { capturedAt: new Date(file.lastModified).toISOString() } : {}),
          });
          setRow(key, { state: 'done', error: null });
          anySucceeded = true;
        } catch (e) {
          setRow(key, { state: 'error', error: errorMessage(e) });
        }
      }

      setBusy(false);
      if (anySucceeded) onUploaded();
    },
    [cap, folder.path, onUploaded, photosOnly, setRow],
  );

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    void start(Array.from(e.dataTransfer.files));
  };

  const doneCount = rows.filter((r) => r.state === 'done').length;
  const failedCount = rows.filter((r) => r.state === 'error').length;

  return (
    <section className="card card-pad">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <h3 className="label">Add a file to {folder.name}</h3>
        {rows.length > 0 && (
          <button type="button" className="link text-[12px]" onClick={() => setRows([])} disabled={busy}>
            Clear the list
          </button>
        )}
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        role="button"
        tabIndex={0}
        className={`rounded-card border-2 border-dashed px-4 py-8 text-center cursor-pointer transition-colors ${
          dragging ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand/40 hover:bg-page'
        }`}
      >
        <div className="text-sm font-medium">Tap to choose files, or drop them here</div>
        <div className="mt-1 text-[12px] text-ink-soft leading-relaxed">
          {photosOnly
            ? `Photos straight off your phone are fine. Images only, up to ${fmtBytes(cap)} each.`
            : `Up to ${fmtBytes(cap)} each. We file it into ${folder.name} for you — you never pick a category.`}
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        {...(photosOnly ? { accept: 'image/*', capture: 'environment' as const } : {})}
        onChange={(e) => {
          void start(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      {rows.length > 0 && (
        <>
          <ul className="mt-3 divide-y divide-line rounded-md border border-line">
            {rows.map((r) => (
              <li key={r.key} className="px-3 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 flex-1 truncate text-[13px]" title={r.name}>
                    {r.name}
                  </span>
                  <span
                    className={
                      r.state === 'error'
                        ? 'badge-red shrink-0'
                        : r.state === 'done'
                          ? 'badge-green shrink-0'
                          : 'badge-blue shrink-0'
                    }
                  >
                    {STATE_LABEL[r.state]}
                  </span>
                </div>
                <div className="mt-0.5 flex items-baseline gap-2 text-[11px] text-ink-mute">
                  <span className="tabular-nums">{fmtBytes(r.size)}</span>
                  {r.state === 'uploading' && <span>sending…</span>}
                </div>
                {r.error && <p className="mt-1 text-[12px] text-danger leading-snug">{r.error}</p>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12px] text-ink-soft">
            {busy
              ? `Uploading — ${doneCount} of ${rows.length} done.`
              : failedCount > 0
                ? `${doneCount} filed, ${failedCount} did not go up. Anything already filed is safe — try the rest again.`
                : `${doneCount} filed. Every file is hashed on arrival, so a silent replacement later would show up.`}
          </p>
        </>
      )}
    </section>
  );
}
