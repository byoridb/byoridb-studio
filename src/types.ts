export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  executionTime: number;
  rowCount?: number;
  error?: string;
}

export interface TauriError {
  code: string;
  message: string;
}

export function normalizeError(err: unknown): TauriError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as TauriError;
  }
  return { code: "UNKNOWN", message: String(err) };
}
