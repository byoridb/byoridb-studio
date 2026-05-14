import { useState, useRef, useEffect } from "react";
import "../styles/QueryEditor.css";

interface QueryEditorProps {
  onExecute: (query: string) => void;
  isExecuting: boolean;
  isConnected: boolean;
}

const SAMPLE_QUERIES = [
  { label: "Show Spaces", query: "SHOW SPACES" },
  { label: "Show Tags", query: "SHOW TAGS" },
  { label: "Show Edges", query: "SHOW EDGES" },
  { label: "Show Parts", query: "SHOW PARTS" },
  { label: "Show Hosts", query: "SHOW HOSTS" },
];

const HISTORY_STORAGE_KEY = "byoridb-studio-query-history";

function QueryEditor({ onExecute, isExecuting, isConnected }: QueryEditorProps) {
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const savedHistory = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (savedHistory) {
      setHistory(JSON.parse(savedHistory));
    }
  }, []);

  const handleExecute = () => {
    if (!query.trim() || isExecuting || !isConnected) return;

    onExecute(query);

    // Add to history
    const newHistory = [query, ...history.filter((h) => h !== query)].slice(0, 50);
    setHistory(newHistory);
    setHistoryIndex(-1);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(newHistory));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Ctrl/Cmd + Enter to execute
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleExecute();
      return;
    }

    // Navigate history with Ctrl/Cmd + Up/Down
    if ((e.ctrlKey || e.metaKey) && history.length > 0) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        const newIndex = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(newIndex);
        setQuery(history[newIndex]);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        const newIndex = Math.max(historyIndex - 1, -1);
        setHistoryIndex(newIndex);
        setQuery(newIndex === -1 ? "" : history[newIndex]);
      }
    }
  };

  const handleSampleQuery = (sampleQuery: string) => {
    setQuery(sampleQuery);
    textareaRef.current?.focus();
  };

  const handleClear = () => {
    setQuery("");
    setHistoryIndex(-1);
    textareaRef.current?.focus();
  };

  return (
    <div className="query-editor">
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <span className="toolbar-title">Query Editor</span>
          <div className="sample-queries">
            {SAMPLE_QUERIES.map((sample) => (
              <button
                key={sample.label}
                className="sample-query-btn"
                onClick={() => handleSampleQuery(sample.query)}
                disabled={!isConnected}
              >
                {sample.label}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn-clear" onClick={handleClear}>
            Clear
          </button>
          <button
            className="btn-execute"
            onClick={handleExecute}
            disabled={!query.trim() || isExecuting || !isConnected}
          >
            {isExecuting ? "Executing..." : "Execute (⌘↵)"}
          </button>
        </div>
      </div>

      <div className="editor-container">
        <textarea
          ref={textareaRef}
          className="query-textarea"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? "Enter nGQL query here..." : "Connect to a server first..."}
          disabled={!isConnected}
          spellCheck={false}
        />
        <div className="line-numbers">
          {query.split("\n").map((_, i) => (
            <div key={i} className="line-number">
              {i + 1}
            </div>
          ))}
        </div>
      </div>

      <div className="editor-footer">
        <span className="hint">⌘↵ Execute | ⌘↑/↓ History</span>
        {history.length > 0 && (
          <span className="history-info">History: {history.length} queries</span>
        )}
      </div>
    </div>
  );
}

export default QueryEditor;
