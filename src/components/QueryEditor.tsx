import { useState, useRef, useEffect } from "react";

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

    const newHistory = [query, ...history.filter((h) => h !== query)].slice(0, 50);
    setHistory(newHistory);
    setHistoryIndex(-1);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(newHistory));
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleExecute();
      return;
    }

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
    <div className="flex flex-col h-[250px] min-h-[150px] border-b border-surface1">
      <div className="flex justify-between items-center px-4 py-2 bg-mantle border-b border-surface1">
        <div className="flex items-center gap-4">
          <span className="text-xs font-semibold uppercase tracking-[0.5px] text-subtext">
            Query Editor
          </span>
          <div className="flex gap-1.5">
            {SAMPLE_QUERIES.map((sample) => (
              <button
                key={sample.label}
                className="px-2 py-1 text-[11px] bg-crust text-subtext border border-surface1 rounded hover:bg-surface1 hover:text-text hover:border-blue disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => handleSampleQuery(sample.query)}
                disabled={!isConnected}
              >
                {sample.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="bg-transparent text-subtext border border-surface1 hover:bg-surface1 hover:text-text"
            onClick={handleClear}
          >
            Clear
          </button>
          <button
            className="bg-blue text-app font-medium hover:bg-sapphire disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={handleExecute}
            disabled={!query.trim() || isExecuting || !isConnected}
          >
            {isExecuting ? "Executing..." : "Execute (⌘↵)"}
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden relative">
        <textarea
          ref={textareaRef}
          className="flex-1 p-3 pl-[50px] font-mono text-[13px] leading-[1.6] bg-app border-none rounded-none resize-none text-text outline-none disabled:bg-crust disabled:cursor-not-allowed"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isConnected ? "Enter nGQL query here..." : "Connect to a server first..."}
          disabled={!isConnected}
          spellCheck={false}
        />
        <div className="absolute inset-y-0 left-0 w-10 px-2 py-3 bg-mantle border-r border-surface1 font-mono text-[13px] leading-[1.6] text-overlay text-right select-none overflow-hidden">
          {query.split("\n").map((_, i) => (
            <div key={i} className="h-[20.8px]">
              {i + 1}
            </div>
          ))}
        </div>
      </div>

      <div className="flex justify-between px-4 py-1.5 bg-mantle border-t border-surface1 text-[11px] text-overlay">
        <span className="font-mono">⌘↵ Execute | ⌘↑/↓ History</span>
        {history.length > 0 && (
          <span className="text-sapphire">History: {history.length} queries</span>
        )}
      </div>
    </div>
  );
}

export default QueryEditor;
