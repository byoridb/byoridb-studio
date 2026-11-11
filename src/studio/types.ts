export type MediaKind = "video" | "audio" | "image";
export interface Media {
  id: string;
  name: string;
  path: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumbnail?: string;
  waveform?: number[];
}
export interface Track {
  id: string;
  name: string;
  kind: "video" | "audio" | "text";
  muted: boolean;
  hidden: boolean;
  locked: boolean;
}
export interface Keyframe {
  property: string;
  time: number;
  value: number;
}
export type CurvePoint = [number, number];
export type CurveChannel = "master" | "red" | "green" | "blue";
export type HslChannel =
  "red" | "yellow" | "green" | "cyan" | "blue" | "magenta";
export interface ColorAdjustment {
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number;
  hue?: number;
  hsl?: Partial<
    Record<
      HslChannel,
      { hue?: number; saturation?: number; lightness?: number }
    >
  >;
  curves?: {
    preset?: string;
    master?: CurvePoint[];
    red?: CurvePoint[];
    green?: CurvePoint[];
    blue?: CurvePoint[];
  };
  lut?: { path?: string; name?: string; enabled: boolean };
}
export interface Clip {
  id: string;
  mediaId?: string;
  trackId: string;
  name: string;
  kind: MediaKind | "text";
  start: number;
  duration: number;
  sourceIn: number;
  speed: number;
  reverse: boolean;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  transform: {
    x: number;
    y: number;
    scale: number;
    rotation: number;
    opacity: number;
    flipX?: boolean;
    flipY?: boolean;
  };
  color: ColorAdjustment;
  text?: {
    content: string;
    fontSize: number;
    color: string;
    fontFamily: string;
    fontId?: string;
    fontPath?: string;
    bold: boolean;
    align: string;
    background: string;
  };
  filter?: string;
  transitionIn?: string;
  transitionOut?: string;
  keyframes: Keyframe[];
  crop?: { x: number; y: number; width: number; height: number };
  mask?: {
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    feather: number;
  };
  chromaKey?: {
    enabled: boolean;
    color: string;
    similarity: number;
    blend: number;
  };
  audio?: {
    normalize: boolean;
    denoise: boolean;
    voiceEnhance: boolean;
    eq?: { bass: number; mid: number; treble: number };
  };
  stabilize?: { enabled: boolean; strength: number };
  groupId?: string;
  [key: string]: unknown;
}
export interface Note {
  id: string;
  body: string;
  createdAt: number | string;
  kind: string;
  clipId?: string;
}
export interface Project {
  id: string;
  name: string;
  revision: number;
  width: number;
  height: number;
  fps: number;
  background: string;
  media: Media[];
  tracks: Track[];
  clips: Clip[];
  markers: { id: string; time: number; label: string }[];
  concept: {
    audience: string;
    message: string;
    appeal: string;
    direction: string;
  };
  notes: Note[];
  updatedAt: number | string;
}
export type Command = (
  method: string,
  params?: Record<string, unknown>,
) => Promise<unknown>;
export interface Job {
  id: string;
  state: string;
  progress?: number;
  path?: string;
  logs?: { at: string; stream: string; text: string }[] | string[];
  result?: string;
  error?: string;
}
export interface RuntimeStatus {
  ffmpeg: { available: boolean; path?: string; version?: string };
  providers: {
    id: string;
    name: string;
    available: boolean;
    path?: string;
    version?: string;
    authStatus?: string;
  }[];
  byoridb: {
    installed: boolean;
    home?: string;
    version?: string;
    running: boolean;
    connected: boolean;
    url?: string;
    error?: string;
  };
}
export const durationOf = (project: Project) =>
  Math.max(0, ...project.clips.map((c) => c.start + c.duration));
export const timecode = (seconds: number, fps = 30) => {
  const f = Math.max(0, Math.round(seconds * fps));
  return [
    Math.floor(f / fps / 3600),
    Math.floor(f / fps / 60) % 60,
    Math.floor(f / fps) % 60,
    f % fps,
  ]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
};
