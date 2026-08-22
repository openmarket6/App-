import { useMemo, useState, type ReactNode } from 'react';
import EmptyState from './EmptyState.tsx';
import ErrorState from './ErrorState.tsx';
import Spinner from './Spinner.tsx';

export interface Column<T> {
  /** Stable key. Also the sort key. */
  key: string;
  header: ReactNode;
  render: (row: T, index: number) => ReactNode;
  /** Return a comparable value to make the column sortable. Omit for no sorting. */
  sortValue?: (row: T) => string | number | null | undefined;
  align?: 'left' | 'right' | 'center';
  /** Applied to both the header cell and every body cell. */
  className?: string;
  width?: string;
}

export interface DataTableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** Rendered when there are no rows and nothing is loading. */
  empty?: ReactNode;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  /** Tighter rows for long lists. */
  dense?: boolean;
  /** Wrap in a card. On by default. */
  bare?: boolean;
  /** Row-level highlight, e.g. a coloured left border on at-risk rows. */
  rowClassName?: (row: T) => string;
  footer?: ReactNode;
  /** Cap the body height and scroll inside it. */
  maxBodyHeight?: string;
}

const ALIGN: Record<NonNullable<Column<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

function compare(a: string | number | null | undefined, b: string | number | null | undefined): number {
  // Nulls always sort last regardless of direction — an empty cell is not the
  // smallest value, it is an absent one.
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

export default function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  loading = false,
  error,
  onRetry,
  empty,
  initialSort,
  dense = false,
  bare = false,
  rowClassName,
  footer,
  maxBodyHeight,
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => dir * compare(col.sortValue!(a), col.sortValue!(b)));
  }, [rows, sort, columns]);

  function toggle(col: Column<T>) {
    if (!col.sortValue) return;
    setSort((prev) =>
      prev?.key === col.key ? { key: col.key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key: col.key, dir: 'asc' },
    );
  }

  const shell = (children: ReactNode) => (bare ? <div>{children}</div> : <div className="card overflow-hidden">{children}</div>);

  if (error) return shell(<div className="p-4"><ErrorState error={error} onRetry={onRetry} /></div>);

  const tdPad = dense ? 'px-3 py-1.5' : 'px-4 py-3';
  const thPad = dense ? 'px-3 py-2' : 'px-4 py-2.5';

  return shell(
    <>
      <div className="overflow-x-auto" style={maxBodyHeight ? { maxHeight: maxBodyHeight, overflowY: 'auto' } : undefined}>
        <table className="w-full border-collapse">
          <thead className="bg-page sticky top-0 z-10">
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th
                    key={c.key}
                    style={c.width ? { width: c.width } : undefined}
                    className={`label border-b border-line ${thPad} ${ALIGN[c.align ?? 'left']} ${c.className ?? ''} ${
                      c.sortValue ? 'cursor-pointer select-none hover:text-ink' : ''
                    }`}
                    onClick={() => toggle(c)}
                    aria-sort={active ? (sort!.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {c.header}
                      {c.sortValue && (
                        <span className={active ? 'text-brand' : 'text-ink-mute/40'}>
                          {active ? (sort!.dir === 'asc' ? '▲' : '▼') : '↕'}
                        </span>
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8">
                  <Spinner />
                </td>
              </tr>
            )}
            {!loading &&
              sorted.map((row, i) => (
                <tr
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`${onRowClick ? 'cursor-pointer hover:bg-page' : ''} ${rowClassName?.(row) ?? ''}`}
                >
                  {columns.map((c) => (
                    <td
                      key={c.key}
                      className={`border-b border-line align-top text-sm ${tdPad} ${ALIGN[c.align ?? 'left']} ${c.className ?? ''}`}
                    >
                      {c.render(row, i)}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && rows.length === 0 && (empty ?? <EmptyState title="Nothing here yet" compact />)}
      {footer && <div className="border-t border-line px-4 py-2.5 text-[12px] text-ink-soft">{footer}</div>}
    </>,
  );
}
