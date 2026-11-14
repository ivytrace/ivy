import { Fragment, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ExpandedState,
  type SortingState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils/cn";
import { useIsDesktop } from "@/lib/utils/media";

export function DataTable<TData>({
  columns,
  data,
  defaultSorting = [],
  manualSorting = false,
  empty,
  getRowId,
  rowClassName,
  renderExpanded,
  renderCard,
}: {
  columns: ColumnDef<TData, unknown>[];
  data: TData[];
  defaultSorting?: SortingState;
  manualSorting?: boolean;
  empty?: ReactNode;
  getRowId?: (row: TData) => string;
  rowClassName?: (row: TData) => string | undefined;
  /** Rows it returns content for can expand (`row.toggleExpanded()` in a cell); shown in a full-width row below. */
  renderExpanded?: (row: TData) => ReactNode | null;
  /** Below `md`, rows render as these cards instead of table rows. */
  renderCard?: (row: TData) => ReactNode;
}) {
  const desktop = useIsDesktop();
  const [sorting, setSorting] = useState<SortingState>(defaultSorting);
  const [expanded, setExpanded] = useState<ExpandedState>({});
  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, expanded },
    onSortingChange: setSorting,
    onExpandedChange: setExpanded,
    getRowCanExpand: (row) => !!renderExpanded?.(row.original),
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: manualSorting ? undefined : getSortedRowModel(),
    enableSorting: !manualSorting,
  });

  if (renderCard && !desktop) {
    const rows = table.getRowModel().rows;
    return (
      <div className="divide-y rounded-md border">
        {rows.length
          ? rows.map((row) => (
              <div key={row.id} className={rowClassName?.(row.original)}>
                {renderCard(row.original)}
              </div>
            ))
          : empty}
      </div>
    );
  }

  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="hover:bg-transparent">
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                const canSort = header.column.getCanSort();
                return (
                  <TableHead key={header.id} className="h-10 text-xs">
                    {header.isPlaceholder ? null : canSort ? (
                      <button
                        type="button"
                        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {sorted === "desc" ? (
                          <ArrowDown className="size-3.5" />
                        ) : sorted === "asc" ? (
                          <ArrowUp className="size-3.5" />
                        ) : (
                          <ChevronsUpDown className="size-3.5 opacity-50" />
                        )}
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length ? (
            table.getRowModel().rows.map((row) => (
              <Fragment key={row.id}>
                <TableRow className={cn(rowClassName?.(row.original), row.getIsExpanded() && "border-b-0")}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cn("py-2.5", cell.column.columnDef.meta?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
                {row.getIsExpanded() && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={row.getVisibleCells().length} className="pt-0 pb-3">
                      {renderExpanded?.(row.original)}
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            ))
          ) : (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columns.length} className="p-0">
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  );
}
