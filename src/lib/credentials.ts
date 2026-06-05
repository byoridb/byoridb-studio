/**
 * Connection password storage via the OS keychain (Tauri `*_password` commands).
 *
 * Passwords never touch localStorage or git — only the saved-connection
 * *metadata* (host/port/user/name) is persisted to localStorage; the secret
 * lives in the OS-native secret store keyed by `host:port:username`.
 *
 * All operations are best-effort: a keychain miss or failure resolves to a safe
 * default ("" / no-op) rather than throwing, so connecting never hard-fails just
 * because the secret store is unavailable.
 */
import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig } from "../types";

type ConnIdentity = Pick<ConnectionConfig, "host" | "port" | "username">;

/** Stable keychain key for a connection. */
export function connectionKey(c: ConnIdentity): string {
  return `${c.host}:${c.port}:${c.username}`;
}

/** Persist a connection's password to the keychain (no-op if empty). */
export async function savePassword(c: ConnectionConfig): Promise<void> {
  if (!c.password) return;
  try {
    await invoke("save_password", { key: connectionKey(c), password: c.password });
  } catch (e) {
    console.warn("Failed to save password to keychain:", e);
  }
}

/** Load a connection's stored password, or "" if none / on failure. */
export async function loadPassword(c: ConnIdentity): Promise<string> {
  try {
    const p = await invoke<string | null>("get_password", { key: connectionKey(c) });
    return p ?? "";
  } catch (e) {
    console.warn("Failed to read password from keychain:", e);
    return "";
  }
}

/** Remove a connection's stored password (idempotent, best-effort). */
export async function deletePassword(c: ConnIdentity): Promise<void> {
  try {
    await invoke("delete_password", { key: connectionKey(c) });
  } catch (e) {
    console.warn("Failed to delete password from keychain:", e);
  }
}
