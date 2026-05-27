import { useRef, useEffect, useState, useCallback } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { registerNgqlLanguage, LANGUAGE_ID } from "../lib/ngql-language";
import { type QueryTab, SNIPPETS, newTab } from "../lib/query-tabs";
import { HISTORY_STORAGE_KEY } from "../types";
import "../styles/QueryEditor.css";

interface QueryEditorProps {
  onExecute: (query: string) => void;
  onCancel?: () => void;
  isExecuting: boolean;
  isConnected: boolean;
}

const TABS_STORAGE_KEY = "byoridb-studio-tabs";

function loadTabs(): QueryTab[] {
  try {
    const saved = localStorage.getItem(TABS_STORAGE_KEY);
    if (saved) return JSON.parse(saved) as QueryTab[];
  } catch {
    // ignore
  }
  return [newTab("tab-1")];
}

function saveTabs(tabs: QueryTab[]) {
  localStorage.setItem(TABS_STORAGE_KEY, JSON.stringify(tabs));
}

function QueryEditor({ onExecute, onCancel, isExecuting, isConnected }: QueryEditorProps) {
  const [tabs, setTabs] = useState<QueryTab[]>(loadTabs);
  const [activeTabId, setActiveTabId] = useState<string>(() => loadTabs()[0].id);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showSnippets, setShowSnippets] = useState(false);
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // Refs for keybinding callbacks
  const historyRef = useRef(history);
  const historyIndexRef = useRef(historyIndex);
  const isExecutingRef = useRef(isExecuting);
  const isConnectedRef = useRef(isConnected);
  const activeTabRef = useRef(activeTab);

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
    activeTabRef.current = activeTab;
  }, [activeTab]);

  useEffect(() => {
    const saved = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (saved) setHistory(JSON.parse(saved));
  }, []);

  const updateTabQuery = useCallback((id: string, query: string) => {
    setTabs((prev) => {
      const next = prev.map((t) => (t.id === id ? { ...t, query } : t));
      saveTabs(next);
      return next;
    });
  }, []);

  const handleExecute = useCallback(
    (query: string) => {
      if (!query.trim() || isExecutingRef.current || !isConnectedRef.current) return;
      onExecute(query);
      const newHistory = [query, ...historyRef.current.filter((h) => h !== query)].slice(0, 50);
      setHistory(newHistory);
      setHistoryIndex(-1);
      localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(newHistory));
    },
    [onExecute],
  );

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    registerNgqlLanguage(monaco);

    // ⌘↵ — execute full query
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
      handleExecute(editor.getValue());
    });

    // ⌘⇧↵ — execute selected text (or full if no selection)
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
      const selection = editor.getSelection();
      const selected =
        selection && !selection.isEmpty()
          ? (editor.getModel()?.getValueInRange(selection) ?? "")
          : editor.getValue();
      handleExecute(selected);
    });

    // ⌘↑ — older history
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.UpArrow, () => {
      const hist = historyRef.current;
      if (!hist.length) return;
      const newIndex = Math.min(historyIndexRef.current + 1, hist.length - 1);
      setHistoryIndex(newIndex);
      const val = hist[newIndex];
      updateTabQuery(activeTabRef.current.id, val);
      editor.setValue(val);
    });

    // ⌘↓ — newer history
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.DownArrow, () => {
      const hist = historyRef.current;
      if (!hist.length) return;
      const newIndex = Math.max(historyIndexRef.current - 1, -1);
      setHistoryIndex(newIndex);
      const val = newIndex === -1 ? "" : hist[newIndex];
      updateTabQuery(activeTabRef.current.id, val);
      editor.setValue(val);
    });
  };

  const setEditorValue = (val: string) => {
    updateTabQuery(activeTab.id, val);
    if (editorRef.current) {
      editorRef.current.setValue(val);
      editorRef.current.focus();
    }
  };

  const handleClear = () => {
    setHistoryIndex(-1);
    setEditorValue("");
  };

  // Tab management
  const addTab = () => {
    const tab = newTab();
    setTabs((prev) => {
      const next = [...prev, tab];
      saveTabs(next);
      return next;
    });
    setActiveTabId(tab.id);
    setTimeout(() => editorRef.current?.setValue(""), 0);
  };

  const closeTab = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setTabs((prev) => {
      if (prev.length === 1) return prev; // keep at least one tab
      const next = prev.filter((t) => t.id !== id);
      saveTabs(next);
      if (activeTabId === id) {
        const idx = prev.findIndex((t) => t.id === id);
        const newActive = next[Math.min(idx, next.length - 1)];
        setActiveTabId(newActive.id);
        setTimeout(() => editorRef.current?.setValue(newActive.query), 0);
      }
      return next;
    });
  };

  const switchTab = (tab: QueryTab) => {
    setActiveTabId(tab.id);
    setHistoryIndex(-1);
    setTimeout(() => editorRef.current?.setValue(tab.query), 0);
  };

  const insertSnippet = (body: string) => {
    setShowSnippets(false);
    // Strip snippet placeholders for simple insertion
    const plain = body.replace(/\$\{\d+:([^}]+)\}/g, "$1").replace(/\$\d+/g, "");
    setEditorValue(plain);
  };

  return (
    <div className="query-editor">
      {/* Tab bar */}
      <div className="tab-bar">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab ${tab.id === activeTabId ? "active" : ""}`}
            onClick={() => switchTab(tab)}
            data-testid={`tab-${tab.id}`}
          >
            <span className="tab-title">{tab.title}</span>
            {tabs.length > 1 && (
              <button
                className="tab-close"
                onClick={(e) => closeTab(tab.id, e)}
                aria-label={`Close ${tab.title}`}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button className="tab-add" onClick={addTab} aria-label="New tab" data-testid="add-tab">
          +
        </button>
      </div>

      {/* Toolbar */}
      <div className="editor-toolbar">
        <div className="toolbar-left">
          <span className="toolbar-title">Query Editor</span>
          <div className="snippet-wrapper">
            <button
              className="snippet-btn"
              onClick={() => setShowSnippets((v) => !v)}
              disabled={!isConnected}
              data-testid="snippets-button"
            >
              Snippets ▾
            </button>
            {showSnippets && (
              <div className="snippet-dropdown" data-testid="snippet-dropdown">
                {SNIPPETS.map((s) => (
                  <button
                    key={s.label}
                    className="snippet-item"
                    onClick={() => insertSnippet(s.body)}
                    title={s.description}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn-clear" onClick={handleClear} data-testid="clear-button">
            Clear
          </button>
          {isExecuting && onCancel && (
            <button
              className="btn-cancel"
              onClick={onCancel}
              data-testid="cancel-button"
              aria-label="Cancel query"
            >
              ✕ Cancel
            </button>
          )}
          <button
            className="btn-execute-selection"
            onClick={() => {
              const editor = editorRef.current;
              if (!editor) return;
              const sel = editor.getSelection();
              const text =
                sel && !sel.isEmpty()
                  ? (editor.getModel()?.getValueInRange(sel) ?? "")
                  : editor.getValue();
              handleExecute(text);
            }}
            disabled={!activeTab.query.trim() || isExecuting || !isConnected}
            title="Execute selection (⌘⇧↵) or full query"
            data-testid="execute-selection-button"
          >
            ▶ Selection
          </button>
          <button
            className="btn-execute"
            onClick={() => handleExecute(activeTab.query)}
            disabled={!activeTab.query.trim() || isExecuting || !isConnected}
            data-testid="execute-button"
          >
            {isExecuting ? "Executing..." : "Execute (⌘↵)"}
          </button>
        </div>
      </div>

      {/* Editor */}
      <div className="editor-container" data-testid="editor-container">
        <Editor
          height="100%"
          language={LANGUAGE_ID}
          theme="catppuccin-mocha"
          value={activeTab.query}
          onChange={(val) => updateTabQuery(activeTab.id, val ?? "")}
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
        <span className="hint">⌘↵ Execute | ⌘⇧↵ Execute Selection | ⌘↑/↓ History</span>
        {history.length > 0 && (
          <span className="history-info">History: {history.length} queries</span>
        )}
      </div>
    </div>
  );
}

export default QueryEditor;
