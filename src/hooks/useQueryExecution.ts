import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { normalizeError, type QueryResult } from "../types";

export function useQueryExecution({
  isConnected,
  onConnectionLost,
}: {
  isConnected: boolean;
  onConnectionLost: (reason: "session" | "health") => void;
}) {
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);

  const handleExecuteQuery = async (query: string) => {
    if (!isConnected) {
      alert("Not connected to server");
      return;
    }

    setIsExecuting(true);
    try {
      const startTime = performance.now();
      const result = await invoke<QueryResult>("execute_query", { query });
      const endTime = performance.now();

      setQueryResult({
        ...result,
        executionTime: endTime - startTime,
      });
    } catch (error) {
      const e = normalizeError(error);

      if (e.code === "SESSION_EXPIRED") {
        setQueryResult({
          columns: [],
          rows: [],
          executionTime: 0,
          error: "Session expired. Please reconnect.",
        });
        onConnectionLost("session");
        return;
      }

      setQueryResult({
        columns: [],
        rows: [],
        executionTime: 0,
        error: e.message,
      });
    } finally {
      setIsExecuting(false);
    }
  };

  return { queryResult, setQueryResult, isExecuting, handleExecuteQuery };
}
