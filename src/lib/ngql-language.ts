/**
 * nGQL language definition for Monaco Editor.
 *
 * Provides:
 * - Monarch tokenizer (syntax highlighting)
 * - Catppuccin Mocha theme
 * - registerNgqlLanguage() to wire everything into a Monaco instance
 * - NGQL_KEYWORDS and isNgqlKeyword() for testing and autocomplete
 */
import type * as Monaco from "monaco-editor";

export const LANGUAGE_ID = "ngql";

// ---------------------------------------------------------------------------
// Keyword sets
// ---------------------------------------------------------------------------

export const NGQL_KEYWORDS: readonly string[] = [
  // DDL
  "CREATE",
  "DROP",
  "ALTER",
  "SHOW",
  "DESCRIBE",
  // DML
  "INSERT",
  "UPDATE",
  "DELETE",
  // DQL
  "MATCH",
  "GO",
  "FETCH",
  "LOOKUP",
  "FIND",
  "RETURN",
  "YIELD",
  "WHERE",
  "FROM",
  "OVER",
  "STEPS",
  "PATH",
  "SHORTEST",
  // Common
  "USE",
  "ON",
  "AS",
  "IN",
  "NOT",
  "AND",
  "OR",
  "LIMIT",
  "OFFSET",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "VERTEX",
  "EDGE",
  "TAG",
  "SPACE",
  "PROP",
  "VALUES",
  "SET",
  "REVERSELY",
  "BIDIRECT",
  "UPTO",
  "STEP",
  "DISTINCT",
  "ALL",
  "ANY",
  "NONE",
  "SINGLE",
  "OPTIONAL",
  "WITH",
  "UNWIND",
  "UNION",
  "INTERSECT",
  "MINUS",
  "PIPE",
];

export const NGQL_TYPES: readonly string[] = [
  "BOOL",
  "INT8",
  "INT16",
  "INT32",
  "INT64",
  "FLOAT",
  "DOUBLE",
  "STRING",
  "TIMESTAMP",
  "DATE",
  "DATETIME",
  "NULL",
  "TRUE",
  "FALSE",
];

export const NGQL_DDL: readonly string[] = ["CREATE", "DROP", "ALTER", "SHOW", "DESCRIBE"];
export const NGQL_DML: readonly string[] = ["INSERT", "UPDATE", "DELETE"];
export const NGQL_DQL: readonly string[] = [
  "MATCH",
  "GO",
  "FETCH",
  "LOOKUP",
  "FIND",
  "RETURN",
  "YIELD",
];

/** Case-insensitive keyword check. */
export function isNgqlKeyword(word: string): boolean {
  return NGQL_KEYWORDS.includes(word.toUpperCase());
}

// ---------------------------------------------------------------------------
// Monarch tokenizer
// ---------------------------------------------------------------------------

const monarchTokens: Monaco.languages.IMonarchLanguage = {
  ignoreCase: true,
  keywords: [...NGQL_KEYWORDS],
  typeKeywords: [...NGQL_TYPES],
  ddlKeywords: [...NGQL_DDL],
  dmlKeywords: [...NGQL_DML],
  dqlKeywords: [...NGQL_DQL],

  operators: ["->", "<-", "|", "==", "!=", ">=", "<=", ">", "<", "=", "+", "-", "*", "/", "%"],

  tokenizer: {
    root: [
      // Whitespace
      [/\s+/, "white"],

      // Comments
      [/#.*$/, "comment"],
      [/\/\/.*$/, "comment"],

      // Special variables: $var, $^, $$
      [/\$\^|\$\$/, "variable.special"],
      [/\$[a-zA-Z_]\w*/, "variable"],

      // Strings
      [/"([^"\\]|\\.)*$/, "string.invalid"],
      [/"/, { token: "string.quote", bracket: "@open", next: "@stringDouble" }],
      [/'([^'\\]|\\.)*$/, "string.invalid"],
      [/'/, { token: "string.quote", bracket: "@open", next: "@stringSingle" }],

      // Numbers
      [/\d+\.\d*([eE][-+]?\d+)?/, "number.float"],
      [/\d+[eE][-+]?\d+/, "number.float"],
      [/\d+/, "number"],

      // Identifiers and keywords
      [
        /[a-zA-Z_]\w*/,
        {
          cases: {
            "@ddlKeywords": "keyword.ddl",
            "@dmlKeywords": "keyword.dml",
            "@dqlKeywords": "keyword.dql",
            "@typeKeywords": "keyword.type",
            "@keywords": "keyword",
            "@default": "identifier",
          },
        },
      ],

      // Operators
      [/->|<-/, "operator.arrow"],
      [/[|]/, "operator.pipe"],
      [/==|!=|>=|<=|>|</, "operator.comparison"],
      [/[=+\-*/%]/, "operator"],

      // Delimiters
      [/[{}()[\]]/, "@brackets"],
      [/[,;:]/, "delimiter"],
      [/\./, "delimiter.dot"],
    ],

    stringDouble: [
      [/[^\\"]+/, "string"],
      [/\\./, "string.escape"],
      [/"/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],

    stringSingle: [
      [/[^\\']+/, "string"],
      [/\\./, "string.escape"],
      [/'/, { token: "string.quote", bracket: "@close", next: "@pop" }],
    ],
  },
};

// ---------------------------------------------------------------------------
// Catppuccin Mocha theme
// ---------------------------------------------------------------------------

const catppuccinMochaTheme: Monaco.editor.IStandaloneThemeData = {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "6c7086", fontStyle: "italic" },
    { token: "keyword.ddl", foreground: "cba6f7", fontStyle: "bold" }, // Mauve
    { token: "keyword.dml", foreground: "f38ba8", fontStyle: "bold" }, // Red
    { token: "keyword.dql", foreground: "89b4fa", fontStyle: "bold" }, // Blue
    { token: "keyword.type", foreground: "fab387" }, // Peach
    { token: "keyword", foreground: "cba6f7" }, // Mauve
    { token: "string", foreground: "a6e3a1" }, // Green
    { token: "string.quote", foreground: "a6e3a1" },
    { token: "string.escape", foreground: "fab387" },
    { token: "string.invalid", foreground: "f38ba8" },
    { token: "number", foreground: "fab387" }, // Peach
    { token: "number.float", foreground: "fab387" },
    { token: "operator.arrow", foreground: "89dceb" }, // Sky
    { token: "operator.pipe", foreground: "89dceb" },
    { token: "operator.comparison", foreground: "89dceb" },
    { token: "operator", foreground: "89dceb" },
    { token: "variable.special", foreground: "f5c2e7" }, // Pink
    { token: "variable", foreground: "f5c2e7" },
    { token: "identifier", foreground: "cdd6f4" }, // Text
    { token: "delimiter", foreground: "6c7086" },
    { token: "delimiter.dot", foreground: "6c7086" },
  ],
  colors: {
    "editor.background": "#1e1e2e",
    "editor.foreground": "#cdd6f4",
    "editor.lineHighlightBackground": "#181825",
    "editor.selectionBackground": "#45475a",
    "editor.inactiveSelectionBackground": "#313244",
    "editorLineNumber.foreground": "#6c7086",
    "editorLineNumber.activeForeground": "#cdd6f4",
    "editorCursor.foreground": "#f5c2e7",
    "editorWhitespace.foreground": "#313244",
    "editorIndentGuide.background1": "#313244",
    "editorIndentGuide.activeBackground1": "#45475a",
    "editor.findMatchBackground": "#45475a",
    "editor.findMatchHighlightBackground": "#313244",
    "editorWidget.background": "#181825",
    "editorWidget.border": "#313244",
    "editorSuggestWidget.background": "#181825",
    "editorSuggestWidget.border": "#313244",
    "editorSuggestWidget.selectedBackground": "#313244",
    "scrollbarSlider.background": "#31324480",
    "scrollbarSlider.hoverBackground": "#45475a80",
    "scrollbarSlider.activeBackground": "#45475a",
  },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerNgqlLanguage(monaco: typeof Monaco): void {
  // Avoid double-registration
  const existing = monaco.languages.getLanguages().find((l) => l.id === LANGUAGE_ID);
  if (existing) return;

  monaco.languages.register({ id: LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarchTokens);
  monaco.editor.defineTheme("catppuccin-mocha", catppuccinMochaTheme);
}
