import type { HTMLAttributes, ReactNode, TableHTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cx } from "../../lib/cx.js";

/**
 * `.tbl-wrap`: horizontal scroll container so wide tables never cause page scroll (360px+).
 * Focusable + labelled so keyboard users can scroll it (WCAG 2.1.1 scrollable region).
 */
export function TableWrap({
  label,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { label: string }) {
  return (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={cx("relative overflow-x-auto rounded-lg border border-border bg-surface", className)}
      {...rest}
    >
      {children}
    </div>
  );
}

export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  // overflow-wrap: break-word (not the body's `anywhere`) so columns keep word-sized minimum widths: narrow tables
  // scroll inside TableWrap instead of breaking 버전 / 보존 정책 / ids one character per line
  return <table className={cx("w-full border-collapse text-[13px] [overflow-wrap:break-word]", className)} {...rest} />;
}

export function Th({ className, scope = "col", ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={scope}
      className={cx(
        "border-b border-border bg-surface-2 px-2.5 py-[7px] text-left align-top text-xs font-semibold text-muted",
        scope === "col" && "whitespace-nowrap",
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cx("border-b border-border px-2.5 py-[7px] text-left align-top", className)} {...rest} />;
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Use this column's cell as the row header (<th scope="row">). */
  rowHeader?: boolean;
}

export interface DataTableProps<T> {
  label: string;
  columns: Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Rendered in a single full-width cell when `rows` is empty. */
  empty?: ReactNode;
  caption?: ReactNode;
  onRowClick?: (row: T) => void;
  className?: string;
}

/** Column-driven table inside a TableWrap. */
export function DataTable<T>({ label, columns, rows, rowKey, empty, caption, onRowClick, className }: DataTableProps<T>) {
  return (
    <TableWrap label={label} className={className}>
      <Table>
        {caption && <caption className="px-2.5 py-2 text-left text-xs text-muted">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <Th key={c.key} className={c.className}>
                {c.header}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <Td colSpan={columns.length} className="py-6 text-center text-muted">
                {empty ?? "항목이 없습니다."}
              </Td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={cx(onRowClick && "cursor-pointer hover:bg-surface-2")}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((c) =>
                  c.rowHeader ? (
                    <Th key={c.key} scope="row" className={cx("bg-transparent text-[13px] text-text", c.className)}>
                      {c.cell(row)}
                    </Th>
                  ) : (
                    <Td key={c.key} className={c.className}>
                      {c.cell(row)}
                    </Td>
                  ),
                )}
              </tr>
            ))
          )}
        </tbody>
      </Table>
    </TableWrap>
  );
}
