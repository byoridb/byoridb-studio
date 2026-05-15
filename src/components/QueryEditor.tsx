import { useRef, useEffect, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { registerNgqlLanguage, LANGUAGE_ID } from "../lib/ngql-language";
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
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  // Refs to keep keybinding callbacks up-to-date without re-registering
  const queryRef = useRef(query);
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  const isExecutingRef = useRef(isExecuting);
  const isConnectedRef = useRef(isConnected);

  useEffect(() => {
    queryRef.current = query;
  }, [query]);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);
  useEffect(() => {
    historyIndexRef.current = historyIndex;
  }, [historyIndex]);
  useEffect(() => {
    isExecutingRef.current = isExecuting;
  }, [isExecuting]);
  useEffect(() => {
    isConnectedRef.current = isConnected;
  }, [isConnected]);

  useEffect(() => {
    const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (saved) setHistory(JSON.parse(saved));
  }, []);

  const handleExecute = (currentQuery: string) => {
    if (!currentQuery.trim() || isExecutingRef.current || !isConnectedRef.current) return;
    onExecute(currentQuery);
    const newHistory = [
      currentQuery,
      ...historyRef.current.filter((h) => h !== currentQuery),
    ].slice(0, 50);
    setHistory(newHistory);
    setHistoryIndex(-1);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(newHistory));
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerNgqlLanguage(monaco);

    // ⌘↵ / Ctrl+Enter — execute
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleExecute(editor.getValue());
    });

    // ⌘↑ / Ctrl+Up — older history
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.UpArrow, () => {
      const hist = historyRef.current;
      if (!hist.length) return;
      const newIndex = Math.min(historyIndexRef.current + 1, hist.length - 1);
      setHistoryIndex(newIndex);
      const val = hist[newIndex];
      setQuery(val);
      editor.setValue(val);
    });

    // ⌘↓ / Ctrl+Down — newer history
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.DownArrow, () => {
      const hist = historyRef.current;
      if (!hist.length) return;
      const newIndex = Math.max(historyIndexRef.current - 1, -1);
      setHistoryIndex(newIndex);
      const val = newIndex === -1 ? "" : hist[newIndex];
      setQuery(val);
      editor.setValue(val);
    });
  };

  const handleSampleQuery = (sampleQuery: string) => {
    setQuery(sampleQuery);
    setHistoryIndex(-1);
    if (editorRef.current) {
      editorRef.current.setValue(sampleQuery);
      editorRef.current.focus();
    }
  };

  const handleClear = () => {
    setQuery("");
    setHistoryIndex(-1);
    if (editorRef.current) {
      editorRef.current.setValue("");
      editorRef.current.focus();
    }
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
                data-testid={`sample-query-${sample.label.toLowerCase().replace(/\s+/g, "-")}`}
              >
                {sample.label}
              </button>
            ))}
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn-clear" onClick={handleClear} data-testid="clear-button">
            Clear
          </button>
          <button
            className="btn-execute"
            onClick={() => handleExecute(query)}
            disabled={!query.trim() || isExecuting || !isConnected}
            data-testid="execute-button"
          >
            {isExecuting ? "Executing..." : "Execute (⌘↵)"}
          </button>
        </div>
      </div>

      <div className="editor-container" data-testid="editor-container">
        <Editor
          height="100%"
          language={LANGUAGE_ID}
          theme="catppuccin-mocha"
          value={query}
          onChange={(val) => setQuery(val ?? "")}
          onMount={handleMount}
          options={{
            readOnly: !isConnected,
            minimap: { enabled: false },
            fontSize: 13,
            lineHeight: 20,
            fontFamily: '"SF Mono", "Monaco", "Inconsolata", "Fira Code", monospace',
            scrollBeyondLastLine: false,
            wordWrap: "on",
            automaticLayout: true,
            tabSize: 2,
            renderLineHighlight: "line",
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
          }}
        />
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
