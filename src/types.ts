/**
 * Shared TypeScript types for ByoriDB Studio.
 * Single source of truth — import from here instead of declaring locally.
 */

export interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  password: string;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionTime: number;
  /** Server-reported row count; falls back to rows.length if absent. */
  rowCount?: number;
  error?: string;
}

export interface SpaceInfo {
  name: string;
  partitionNum: number;
  replicaFactor: number;
}

export interface SchemaInfo {
  tags: string[];
  edges: string[];
}

/** Error shape returned by every Tauri command (see src-tauri/src/main.rs::TauriError). */
export interface TauriError {
  code: string;
  message: string;
}

export interface SavedConnection {
  name: string;
  config: ConnectionConfig;
}

export interface HistoryEntry {
  id: string;
  query: string;
  executedAt: number; // Date.now()
  executionTime?: number; // ms
  rowCount?: number;
  favorite: boolean;
}

export const HISTORY_STORAGE_KEY = "byoridb-studio-query-history";
export const FAVORITES_STORAGE_KEY = "byoridb-studio-favorites";

export const DEFAULT_CONNECTION_CONFIG: ConnectionConfig = {
  host: "127.0.0.1",
  port: 19669,
  username: "root",
  password: "",
};
