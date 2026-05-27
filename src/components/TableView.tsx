import { useState, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { QueryResult } from "../types";
import { formatValue } from "./ResultPanel";

interface TableViewProps {
  result: QueryResult;
}

type SortDir = "asc" | "desc" | null;

interface SortState {
  col: string;
  dir: SortDir;
}

const ROW_HEIGHT = 36;

function TableView({ result }: TableViewProps) {
  const [sort, setSort] = useState<SortState>({ col: "", dir: null });
  const [copiedCell, setCopiedCell] = useState<string | null>(null);
  const parentRef = useRef<HTMLDivElement>(null);

  const sortedRows = (() => {
    if (!sort.col || !sort.dir) return result.rows;
    return [...result.rows].sort((a, b) => {
      const av = formatValue(a[sort.col]);
      const bv = formatValue(b[sort.col]);
      const cmp = av.localeCompare(bv, undefined, { numeric: true });
      return sort.dir === "asc" ? cmp : -cmp;
    });
  })();

  const rowVirtualizer = useVirtualizer({
    count: sortedRows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const handleSort = (col: string) => {
    setSort((prev) => {
      if (prev.col !== col) return { col, dir: "asc" };
      if (prev.dir === "asc") return { col, dir: "desc" };
      return { col: "", dir: null };
    });
  };

  const copyCell = useCallback(async (value: string, key: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedCell(key);
      setTimeout(() => setCopiedCell(null), 1200);
    } catch {
      // clipboard not available in test env
    }
  }, []);

  if (result.rows.length === 0) {
    return <div className="no-data">No data returned</div>;
  }

  return (
    <div className="table-container" ref={parentRef}>
      <table className="result-table">
        <thead>
          <tr>
            <th className="row-number">#</th>
            {result.columns.map((col) => {
              const active = sort.col === col;
              return (
                <th
                  key={col}
                  className={`sortable-col ${active ? "sorted" : ""}`}
                  onClick={() => handleSort(col)}
                  data-testid={`col-header-${col}`}
                >
                  {col}
                  <span className="sort-icon">
                    {active && sort.dir === "asc"
                      ? " ▲"
                      : active && sort.dir === "desc"
                        ? " ▼"
                        : " ⇅"}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
          {rowVirtualizer.getVirtualItems().map((vRow) => {
            const row = sortedRows[vRow.index];
            return (
              <tr
                key={vRow.index}
                style={{
                  position: "absolute",
                  top: 0,
                  transform: `translateY(${vRow.start}px)`,
                  width: "100%",
                  display: "table",
                  tableLayout: "fixed",
                }}
                data-testid={`row-${vRow.index}`}
              >
                <td className="row-number">{vRow.index + 1}</td>
                {result.columns.map((col) => {
                  const cellKey = `${vRow.index}-${col}`;
                  const val = formatValue(row[col]);
                  return (
                    <td
                      key={col}
                      title="Click to copy"
                      className={`copyable-cell ${copiedCell === cellKey ? "copied" : ""}`}
                      onClick={() => copyCell(val, cellKey)}
                      data-testid={`cell-${vRow.index}-${col}`}
                    >
                      {copiedCell === cellKey ? "✓ Copied" : val}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default TableView;
