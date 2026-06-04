/**
 * Named saved queries — a small persistent library, distinct from the
 * auto-captured (and capped/deduped) execution history. Stored under
 * FAVORITES_STORAGE_KEY in localStorage.
 */
import { FAVORITES_STORAGE_KEY, type SavedQuery } from "../types";

/** Cap to keep the list (and localStorage) bounded. */
export const MAX_SAVED_QUERIES = 100;

export function loadSavedQueries(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SavedQuery[]) : [];
  } catch {
    return [];
  }
}

export function persistSavedQueries(list: SavedQuery[]): void {
  localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(list));
}

/**
 * Add (or replace by name) a saved query, newest first, capped. Replacing by
 * name keeps re-saving under the same name idempotent instead of piling up
 * duplicates.
 */
export function addSavedQuery(list: SavedQuery[], entry: SavedQuery): SavedQuery[] {
  const withoutDup = list.filter((q) => q.name.toLowerCase() !== entry.name.toLowerCase());
  return [entry, ...withoutDup].slice(0, MAX_SAVED_QUERIES);
}

export function removeSavedQuery(list: SavedQuery[], id: string): SavedQuery[] {
  return list.filter((q) => q.id !== id);
}
