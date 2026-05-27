import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryResult } from "../types";

interface SpaceInfo {
  name: string;
  partitionNum: number;
  replicaFactor: number;
}

interface SchemaInfo {
  tags: string[];
  edges: string[];
}

export interface DescribeRow {
  Field: string;
  Type: string;
  Null: string;
  Default: unknown;
}

export type DescribeState =
  | { status: "loading" }
  | { status: "ready"; rows: DescribeRow[] }
  | { status: "error"; message: string };

export type DescribeKey = `tag:${string}` | `edge:${string}`;

export function useSchemaData({
  isConnected,
  currentSpace,
}: {
  isConnected: boolean;
  currentSpace: string | null;
}) {
  const [spaces, setSpaces] = useState<SpaceInfo[]>([]);
  const [schema, setSchema] = useState<SchemaInfo>({ tags: [], edges: [] });
  const [expandedItems, setExpandedItems] = useState<Set<DescribeKey>>(new Set());
  const [describeCache, setDescribeCache] = useState<Record<DescribeKey, DescribeState>>(
    {} as Record<DescribeKey, DescribeState>,
  );

  useEffect(() => {
    if (isConnected) {
      loadSpaces();
    }
  }, [isConnected]);

  useEffect(() => {
    if (currentSpace) {
      loadSchema();
    }
  }, [currentSpace]);

  useEffect(() => {
    setExpandedItems(new Set());
    setDescribeCache({} as Record<DescribeKey, DescribeState>);
  }, [currentSpace]);

  const loadSpaces = async () => {
    try {
      const result = await invoke<SpaceInfo[]>("get_spaces");
      setSpaces(result);
    } catch (error) {
      console.error("Failed to load spaces:", error);
    }
  };

  const loadSchema = async () => {
    try {
      const result = await invoke<SchemaInfo>("get_schema");
      setSchema(result);
    } catch (error) {
      console.error("Failed to load schema:", error);
    }
  };

  const describe = async (kind: "tag" | "edge", name: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    setDescribeCache((prev) => ({ ...prev, [key]: { status: "loading" } }));

    const statement = kind === "tag" ? `DESCRIBE TAG ${name}` : `DESCRIBE EDGE ${name}`;
    try {
      const result = await invoke<QueryResult>("execute_query", { query: statement });
      if (result.error) {
        setDescribeCache((prev) => ({
          ...prev,
          [key]: { status: "error", message: result.error! },
        }));
        return;
      }
      setDescribeCache((prev) => ({
        ...prev,
        [key]: { status: "ready", rows: result.rows as unknown as DescribeRow[] },
      }));
    } catch (error) {
      const message =
        error && typeof error === "object" && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      setDescribeCache((prev) => ({
        ...prev,
        [key]: { status: "error", message },
      }));
    }
  };

  const toggleDescribe = (kind: "tag" | "edge", name: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    const nextExpanded = new Set(expandedItems);
    if (nextExpanded.has(key)) {
      nextExpanded.delete(key);
    } else {
      nextExpanded.add(key);
      if (!describeCache[key]) {
        describe(kind, name);
      }
    }
    setExpandedItems(nextExpanded);
  };

  const refreshSchema = () => {
    setDescribeCache({} as Record<DescribeKey, DescribeState>);
    setExpandedItems(new Set());
    loadSchema();
  };

  return {
    spaces,
    schema,
    expandedItems,
    describeCache,
    loadSpaces,
    refreshSchema,
    toggleDescribe,
  };
}
