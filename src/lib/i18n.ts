/**
 * Minimal i18n — Korean / English toggle.
 * Usage: import { t, setLocale, getLocale } from "../lib/i18n"
 */

type Locale = "en" | "ko";

const LOCALE_KEY = "byoridb-studio-locale";

const translations: Record<string, Record<Locale, string>> = {
  // App header
  "app.title": { en: "ByoriDB Studio", ko: "ByoriDB 스튜디오" },
  "app.connect": { en: "Connect", ko: "연결" },
  "app.disconnect": { en: "Disconnect", ko: "연결 해제" },
  "app.notConnected": { en: "Not connected", ko: "연결 안 됨" },

  // Sidebar tabs
  "sidebar.schema": { en: "Schema", ko: "스키마" },
  "sidebar.manage": { en: "Manage", ko: "관리" },
  "sidebar.data": { en: "Data", ko: "데이터" },
  "sidebar.monitor": { en: "Monitor", ko: "모니터" },
  "sidebar.history": { en: "History", ko: "히스토리" },
  "sidebar.settings": { en: "Settings", ko: "설정" },

  // Schema browser
  "schema.spaces": { en: "Spaces", ko: "스페이스" },
  "schema.tags": { en: "Tags", ko: "태그" },
  "schema.edges": { en: "Edges", ko: "엣지" },
  "schema.noSpaces": { en: "No spaces found", ko: "스페이스 없음" },
  "schema.noTags": { en: "No tags found", ko: "태그 없음" },
  "schema.noEdges": { en: "No edges found", ko: "엣지 없음" },

  // Query editor
  "editor.execute": { en: "Execute (⌘↵)", ko: "실행 (⌘↵)" },
  "editor.executing": { en: "Executing...", ko: "실행 중..." },
  "editor.clear": { en: "Clear", ko: "지우기" },
  "editor.snippets": { en: "Snippets ▾", ko: "스니펫 ▾" },
  "editor.placeholder": { en: "Enter nGQL query here...", ko: "nGQL 쿼리를 입력하세요..." },
  "editor.placeholderDisconnected": {
    en: "Connect to a server first...",
    ko: "먼저 서버에 연결하세요...",
  },
  "editor.history": { en: "History:", ko: "히스토리:" },
  "editor.hint": {
    en: "⌘↵ Execute | ⌘⇧↵ Execute Selection | ⌘↑/↓ History",
    ko: "⌘↵ 실행 | ⌘⇧↵ 선택 실행 | ⌘↑/↓ 히스토리",
  },

  // Result panel
  "result.empty": { en: "Execute a query to see results", ko: "쿼리를 실행하면 결과가 표시됩니다" },
  "result.rows": { en: "rows", ko: "행" },
  "result.noData": { en: "No data returned", ko: "데이터 없음" },
  "result.table": { en: "Table", ko: "테이블" },
  "result.json": { en: "JSON", ko: "JSON" },
  "result.graph": { en: "Graph", ko: "그래프" },
  "result.exportCsv": { en: "↓ CSV", ko: "↓ CSV" },
  "result.exportJson": { en: "↓ JSON", ko: "↓ JSON" },

  // Settings
  "settings.appearance": { en: "Appearance", ko: "외관" },
  "settings.theme": { en: "Theme", ko: "테마" },
  "settings.themeDark": { en: "🌙 Dark", ko: "🌙 다크" },
  "settings.themeLight": { en: "☀️ Light", ko: "☀️ 라이트" },
  "settings.fontSize": { en: "Font size", ko: "글자 크기" },
  "settings.language": { en: "Language", ko: "언어" },
  "settings.connections": { en: "Server Connections", ko: "서버 연결" },

  // Connection modal
  "conn.title": { en: "Connect to ByoriDB", ko: "ByoriDB 연결" },
  "conn.host": { en: "Host", ko: "호스트" },
  "conn.port": { en: "Port", ko: "포트" },
  "conn.username": { en: "Username", ko: "사용자명" },
  "conn.password": { en: "Password", ko: "비밀번호" },
  "conn.connect": { en: "Connect", ko: "연결" },
  "conn.cancel": { en: "Cancel", ko: "취소" },
  "conn.saved": { en: "Saved Connections", ko: "저장된 연결" },
};

let currentLocale: Locale = (localStorage.getItem(LOCALE_KEY) as Locale) ?? "en";

export function getLocale(): Locale {
  return currentLocale;
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  localStorage.setItem(LOCALE_KEY, locale);
  // Dispatch a custom event so components can re-render
  window.dispatchEvent(new CustomEvent("localechange", { detail: locale }));
}

export function t(key: string): string {
  return translations[key]?.[currentLocale] ?? translations[key]?.["en"] ?? key;
}
