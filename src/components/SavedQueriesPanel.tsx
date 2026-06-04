import type { SavedQuery } from "../types";
import "../styles/SavedQueriesPanel.css";

interface SavedQueriesPanelProps {
  queries: SavedQuery[];
  onSelect: (query: string) => void;
  onDelete: (id: string) => void;
}

function SavedQueriesPanel({ queries, onSelect, onDelete }: SavedQueriesPanelProps) {
  if (queries.length === 0) return null;

  return (
    <div className="saved-queries">
      <div className="saved-queries-header">Saved Queries</div>
      <div className="saved-queries-list">
        {queries.map((q) => (
          <div
            key={q.id}
            className="saved-query"
            onClick={() => onSelect(q.query)}
            title={q.query}
            data-testid={`saved-query-${q.id}`}
          >
            <div className="saved-query-name">{q.name}</div>
            <div className="saved-query-preview">{q.query}</div>
            <button
              className="saved-query-delete"
              onClick={(e) => {
                e.stopPropagation();
                onDelete(q.id);
              }}
              title="Delete saved query"
              aria-label={`Delete ${q.name}`}
              data-testid={`saved-query-delete-${q.id}`}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

export default SavedQueriesPanel;
