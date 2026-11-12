import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Project } from "./types";

export interface Connection {
  url: string;
  token: string;
}
let connection: Connection | null = null;
export async function connectStudio(force = false): Promise<Connection> {
  if (force) connection = null;
  if (connection) return connection;
  if (isTauri()) connection = await invoke<Connection>("studio_connection");
  else {
    const port = import.meta.env.VITE_STUDIO_PORT || "43123";
    const response = await fetch(`http://127.0.0.1:${port}/session`);
    if (!response.ok)
      throw new Error(
        "편집 서비스에 연결할 수 없습니다. npm run studio를 실행해 주세요.",
      );
    connection = (await response.json()) as Connection;
  }
  return connection;
}
/**
 * The methods the editor answers, whose reply may carry the project. This window
 * asks for it without the waveforms (`omitWaveforms`): each media item then says
 * how many peaks it has, and the timeline fetches them once with `media.waveform`.
 */
const editorMethod = (method: string) =>
  !/^(runtime|agent|memory|speech|preview|export|storage)\./.test(method) &&
  method !== "media.waveform";
export async function rpc<T = unknown>(
  method: string,
  given: Record<string, unknown> = {},
  projectId?: string,
): Promise<T> {
  const params = editorMethod(method) ? { ...given, omitWaveforms: true } : given;
  const c = await connectStudio();
  let response = await fetch(`${c.url}/rpc`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.token}`,
    },
    body: JSON.stringify({
      method,
      params,
      ...(projectId ? { projectId } : {}),
    }),
  });
  if (response.status === 401) {
    const renewed = await connectStudio(true);
    response = await fetch(`${renewed.url}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${renewed.token}`,
      },
      body: JSON.stringify({
        method,
        params,
        ...(projectId ? { projectId } : {}),
      }),
    });
  }
  const body = (await response.json()) as { result?: T; error?: string };
  if (!response.ok || body.error)
    throw new Error(body.error || `요청 실패 (${response.status})`);
  return body.result as T;
}
/** `true` serves the thumbnail, `"proxy"` the lighter playback copy (404 when none exists). */
export function assetUrl(id: string, variant: boolean | "proxy" = false): string {
  if (!connection) return "";
  const suffix = variant === "proxy" ? "/proxy" : variant ? "/thumbnail" : "";
  return `${connection.url}/assets/${encodeURIComponent(id)}${suffix}?token=${encodeURIComponent(connection.token)}`;
}
/** The cover of a stored project (open or not); `mediaId` is `thumbnail.mediaId` from project.list. */
export function projectThumbnailUrl(projectId: string, mediaId: string): string {
  if (!connection) return "";
  return `${connection.url}/projects/${encodeURIComponent(projectId)}/thumbnail?media=${encodeURIComponent(mediaId)}&token=${encodeURIComponent(connection.token)}`;
}
export async function uploadFile(
  file: File,
  projectId: string,
): Promise<Project> {
  const c = await connectStudio();
  const response = await fetch(
    `${c.url}/upload?name=${encodeURIComponent(file.name)}&projectId=${encodeURIComponent(projectId)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${c.token}`,
        "Content-Type": "application/octet-stream",
      },
      body: file,
    },
  );
  const body = (await response.json()) as { result?: Project; error?: string };
  if (!response.ok || body.error)
    throw new Error(body.error || "미디어를 가져오지 못했습니다.");
  return body.result!;
}
export async function pickFiles(extensions?: string[]): Promise<string[] | null> {
  return isTauri() ? invoke<string[]>("studio_open_files", { extensions: extensions ?? null }) : null;
}
export async function savePath(
  name: string,
  extension?: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke<string | null>("studio_save_file", {
    name,
    extension: extension ?? null,
  });
}
/** Shows an exported file in Finder; false in the browser, which has no way to. */
export async function revealFile(path: string): Promise<boolean> {
  if (!isTauri()) return false;
  await invoke("studio_reveal_file", { path });
  return true;
}
