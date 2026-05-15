import { useState, useMemo } from "react";
import type { HistoryEntry } from "../types";
import "../styles/HistoryPanel.css";

interface HistoryPanelProps {
  entries: HistoryEntry[];
  onSelect: (query: string) => void;
  onToggleFavorite: (id: string) => void;
  onClear: () => void;
}

function HistoryPanel({ entries, onSelect, onToggleFavorite, onClear }: HistoryPanelProps) {
  const [search, setSearch] = useState("");
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (showFavoritesOnly && !e.favorite) return false;
      if (search && !e.query.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [entries, search, showFavoritesOnly]);

  return (
    <div className="history-panel">
      <div className="history-toolbar">
        <input
          className="history-search"
          type="text"
          placeholder="Search history..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="history-search"
        />
        <button
          className={`history-filter-btn ${showFavoritesOnly ? "active" : ""}`}
          onClick={() => setShowFavoritesOnly((v) => !v)}
          title="Show favorites only"
          data-testid="favorites-filter"
        >
          ★
        </button>
        <button
          className="history-clear-btn"
          onClick={onClear}
          title="Clear history"
          data-testid="clear-history"
        >
          ✕
        </button>
      </div>

      <div className="history-list">
        {filtered.length === 0 ? (
          <div className="history-empty">
            {search || showFavoritesOnly ? "No matching entries" : "No history yet"}
          </div>
        ) : (
          filtered.map((entry) => (
            <div
              key={entry.id}
              className="history-entry"
              onClick={() => onSelect(entry.query)}
              data-testid={`history-entry-${entry.id}`}
            >
              <div className="history-entry-query">{entry.query}</div>
              <div className="history-entry-meta">
                {entry.executionTime !== undefined && (
                  <span className="history-time">{entry.executionTime.toFixed(0)}ms</span>
                )}
                {entry.rowCount !== undefined && (
                  <span className="history-rows">{entry.rowCount} rows</span>
                )}
                <span className="history-date">
                  {new Date(entry.executedAt).toLocaleTimeString()}
                </span>
                <button
                  className={`history-fav-btn ${entry.favorite ? "active" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleFavorite(entry.id);
                  }}
                  title={entry.favorite ? "Remove from favorites" : "Add to favorites"}
                  data-testid={`fav-btn-${entry.id}`}
                >
                  {entry.favorite ? "★" : "☆"}
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default HistoryPanel;
