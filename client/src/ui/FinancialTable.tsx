import type { ReactNode } from "react";
import { Table } from "./Table";
import { Skeleton } from "./Skeleton";
import { ErrorState } from "./ErrorState";
import { EmptyState } from "./EmptyState";

// The one reusable financial table pattern every future MIDAD financial
// screen (BOQ, Cost Plan, Commitments, Measurements, IPC, Forecast, Cash
// Flow, Invoices) is meant to build on — the "Financial Table Standard"
// from the frontend architecture discovery.
//
// This component NEVER computes a financial value. `total` (if supplied)
// receives the already-loaded `rows` array purely to format/sum a column
// for DISPLAY — if a column's "total" should be a canonical backend
// figure (e.g. Cost Plan's total already returned by the API) pass it
// directly rather than relying on this helper to re-derive it from rows.
export interface FinancialColumn<T> {
  key: string;
  header: string;
  // Logical alignment (RTL-safe): "start" is the app's default reading
  // edge (visually the right, under the app's RTL direction) and matches
  // the alignment already used for every column — text and numeric alike
  // — throughout the existing MIDAD UI. Only override to "end" for a
  // genuinely trailing element (e.g. a row-action icon column).
  align?: "start" | "end";
  render: (row: T) => ReactNode;
  total?: (rows: T[]) => ReactNode;
}

export interface FinancialTableProps<T> {
  columns: FinancialColumn<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyMessage?: string;
  rowActions?: (row: T) => ReactNode;
}

export function FinancialTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  error,
  onRetry,
  emptyMessage = "لا توجد بيانات بعد",
  rowActions,
}: FinancialTableProps<T>) {
  if (error) return <ErrorState message={error} onRetry={onRetry} />;
  if (loading || rows === null) return <Skeleton rows={4} />;
  if (rows.length === 0) return <EmptyState message={emptyMessage} />;

  const hasTotals = columns.some((c) => c.total);

  return (
    <Table>
      <thead className="bg-stone-50 text-stone-500">
        <tr>
          {columns.map((c) => (
            <th key={c.key} className={`p-3 font-medium ${c.align === "end" ? "text-end" : "text-start"}`}>
              {c.header}
            </th>
          ))}
          {rowActions && <th className="p-3" aria-label="إجراءات" />}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)} className="border-t border-stone-100">
            {columns.map((c) => (
              <td key={c.key} className={`p-3 ${c.align === "end" ? "text-end" : "text-start"}`}>
                {c.render(row)}
              </td>
            ))}
            {rowActions && <td className="p-3 text-end">{rowActions(row)}</td>}
          </tr>
        ))}
      </tbody>
      {hasTotals && (
        <tfoot className="border-t border-stone-200 bg-stone-50 font-semibold text-stone-700">
          <tr>
            {columns.map((c) => (
              <td key={c.key} className={`p-3 ${c.align === "end" ? "text-end" : "text-start"}`}>
                {c.total ? c.total(rows) : null}
              </td>
            ))}
            {rowActions && <td className="p-3" />}
          </tr>
        </tfoot>
      )}
    </Table>
  );
}
