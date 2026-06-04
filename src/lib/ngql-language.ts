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
  "EXPLAIN",
  "PROFILE",
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
  "EXPLAIN",
  "PROFILE",
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

export interface SchemaContext {
  tags: string[];
  edges: string[];
  spaces: string[];
  /** Property names keyed by tag/edge name (filled by background DESCRIBE). */
  properties: Record<string, string[]>;
}

// Mutable ref updated by Sidebar when schema changes
export const schemaContext: SchemaContext = {
  tags: [],
  edges: [],
  spaces: [],
  properties: {},
};

/**
 * If the text immediately before the cursor ends with `<entity>.`, return the
 * entity token (e.g. `person` in `person.`). Used to offer property
 * completions scoped to that tag/edge.
 */
export function entityBeforeDot(linePrefix: string): string | null {
  const m = linePrefix.match(/(\w+)\.$/);
  return m ? m[1] : null;
}

/** Look up an entity's already-cached properties case-insensitively. */
function propertiesFor(entity: string): string[] | null {
  const key = Object.keys(schemaContext.properties).find(
    (k) => k.toLowerCase() === entity.toLowerCase(),
  );
  return key ? schemaContext.properties[key] : null;
}

/**
 * On-demand property loader, injected by QueryEditor. Lazily fetches a tag/edge's
 * property names (via DESCRIBE) only when the user references it, matching the
 * codebase's lazy-schema philosophy. Returns [] for unknown entities.
 */
export type PropertyLoader = (entity: string) => Promise<string[]>;

let propertyLoader: PropertyLoader | null = null;

export function setPropertyLoader(loader: PropertyLoader | null): void {
  propertyLoader = loader;
}

/** Resolve an entity's properties from cache, else via the loader (cached). */
async function resolveProperties(entity: string): Promise<string[]> {
  const cached = propertiesFor(entity);
  if (cached) return cached;
  if (!propertyLoader) return [];
  const props = await propertyLoader(entity);
  if (props.length > 0) schemaContext.properties[entity] = props;
  return props;
}

export function registerNgqlLanguage(monaco: typeof Monaco): void {
  // Avoid double-registration
  const existing = monaco.languages.getLanguages().find((l) => l.id === LANGUAGE_ID);
  if (existing) return;

  monaco.languages.register({ id: LANGUAGE_ID });
  monaco.languages.setMonarchTokensProvider(LANGUAGE_ID, monarchTokens);
  monaco.editor.defineTheme("catppuccin-mocha", catppuccinMochaTheme);
  monaco.languages.registerCompletionItemProvider(LANGUAGE_ID, {
    // `.` triggers property completion after an entity (e.g. `person.`).
    triggerCharacters: ["."],
    async provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };

      const propItem = (name: string, owner: string) => ({
        label: name,
        kind: monaco.languages.CompletionItemKind.Field,
        insertText: name,
        detail: `${owner} property`,
        range,
      });

      // After `<entity>.`, offer only that entity's properties when known.
      const linePrefix = model.getValueInRange({
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: 1,
        endColumn: word.startColumn,
      });
      const entity = entityBeforeDot(linePrefix);
      if (entity) {
        const props = await resolveProperties(entity);
        // After a dot we only ever want properties — never keywords/tags.
        return { suggestions: props.map((p) => propItem(p, entity)) };
      }

      const keywordItems = [...NGQL_KEYWORDS, ...NGQL_TYPES].map((kw) => ({
        label: kw,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: kw,
        range,
      }));

      const tagItems = schemaContext.tags.map((t) => ({
        label: t,
        kind: monaco.languages.CompletionItemKind.Class,
        insertText: t,
        detail: "Tag",
        range,
      }));

      const edgeItems = schemaContext.edges.map((e) => ({
        label: e,
        kind: monaco.languages.CompletionItemKind.Interface,
        insertText: e,
        detail: "Edge",
        range,
      }));

      const spaceItems = schemaContext.spaces.map((s) => ({
        label: s,
        kind: monaco.languages.CompletionItemKind.Module,
        insertText: s,
        detail: "Space",
        range,
      }));

      // All known properties (deduped), so `name` is suggested even without an
      // explicit entity prefix. Detail names the owning tag/edge.
      const seen = new Set<string>();
      const propItems: ReturnType<typeof propItem>[] = [];
      for (const [owner, props] of Object.entries(schemaContext.properties)) {
        for (const p of props) {
          if (seen.has(p)) continue;
          seen.add(p);
          propItems.push(propItem(p, owner));
        }
      }

      return {
        suggestions: [...keywordItems, ...tagItems, ...edgeItems, ...spaceItems, ...propItems],
      };
    },
  });
}
