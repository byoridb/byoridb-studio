import { useCallback, useEffect, useState } from "react";
import { assetUrl, rpc } from "./api";
import type { Project } from "./types";

export interface StudioFont { id: string; name: string; family: string; path: string }
export interface StudioPreset {
  id: string;
  name: string;
  kind: "filter" | "effect";
  target: "visual" | "audio";
  sourceDuration: number;
  patch: Record<string, unknown>;
  createdAt: number;
}
export interface AssetCatalog { fonts: StudioFont[]; presets: StudioPreset[] }
const changedEvent = "byori-assets-changed";
const loadedFonts = new Map<string, Promise<void>>();

export function registerFont(font: Pick<StudioFont, "id" | "family">): Promise<void> {
  if (typeof FontFace === "undefined" || !document.fonts) return Promise.resolve();
  const key = `${font.id}:${font.family}`;
  let request = loadedFonts.get(key);
  if (!request) {
    request = (async () => {
      const face = new FontFace(font.family, `url(${JSON.stringify(assetUrl(font.id))})`);
      await face.load();
      document.fonts.add(face);
    })().catch((error: unknown) => { loadedFonts.delete(key); throw error; });
    loadedFonts.set(key, request);
  }
  return request;
}

export function notifyAssetsChanged() {
  window.dispatchEvent(new Event(changedEvent));
}

export function useAssetCatalog(enabled = true) {
  const [catalog, setCatalog] = useState<AssetCatalog>({ fonts: [], presets: [] });
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      const value = await rpc<AssetCatalog>("assets.list");
      const fonts = value?.fonts || [];
      setCatalog({ fonts, presets: value?.presets || [] });
      setError("");
      await Promise.all(fonts.map(registerFont));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const listener = () => void refresh();
    window.addEventListener(changedEvent, listener);
    return () => window.removeEventListener(changedEvent, listener);
  }, [refresh, enabled]);
  return { catalog, error, refresh };
}

export function useProjectFonts(project: Project) {
  const key = JSON.stringify(project.clips.flatMap((clip) => clip.text?.fontId
    ? [{ id: clip.text.fontId, family: clip.text.fontFamily }] : []));
  useEffect(() => {
    const fonts = JSON.parse(key) as Pick<StudioFont, "id" | "family">[];
    for (const font of fonts) void registerFont(font).catch(() => {});
  }, [key]);
}
