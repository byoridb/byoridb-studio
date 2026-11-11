import { useEffect, useState } from "react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ChevronDown,
  Circle,
  Diamond,
  Film,
  FlipHorizontal2,
  FlipVertical2,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Square,
  Trash2,
  Plus,
} from "lucide-react";
import type {
  Clip,
  Command,
  CurveChannel,
  HslChannel,
  Keyframe,
  Project,
} from "./types";
import { isTauri } from "@tauri-apps/api/core";
import { pickFiles, rpc } from "./api";
import { notifyAssetsChanged, registerFont, useAssetCatalog, type StudioFont } from "./assetCatalog";
import { usePreviewDraft } from "./previewDraft";
import CurveEditor from "./CurveEditor";
import { durationOf, timecode } from "./types";
import "./panels.css";
import "./custom-assets.css";

export interface InspectorProps {
  project: Project;
  selected: Clip | null;
  onCommand: Command;
  playhead: number;
}

interface NumberFieldProps {
  label: string;
  value: number;
  onCommit: (value: number) => void;
  onPreview?: (value: number) => void;
  onCancelPreview?: () => void;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onKeyframe?: () => void;
  range?: boolean;
}
function NumberField({
  label,
  value,
  onCommit,
  onPreview,
  onCancelPreview,
  min,
  max,
  step = 1,
  unit,
  onKeyframe,
  range,
}: NumberFieldProps) {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  const change = (next: string) => {
    setDraft(next);
    const n = Number(next);
    if (next !== "" && Number.isFinite(n)) onPreview?.(Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n)));
  };
  const commit = () => {
    const n = Number(draft);
    if (draft !== "" && Number.isFinite(n)) {
      const bounded = Math.max(min ?? -Infinity, Math.min(max ?? Infinity, n));
      setDraft(String(bounded));
      if (Math.abs(bounded - value) > 0.00001) onCommit(bounded);
      else onCancelPreview?.();
    } else { setDraft(String(value)); onCancelPreview?.(); }
  };
  return (
    <div className={`inspector-number-field ${range ? "with-range" : ""}`}>
      <label>
        <span>{label}</span>
        <span className="inspector-number-controls">
          <span className="number-input-wrap">
            <input
              type="number"
              aria-label={label}
              value={draft}
              min={min}
              max={max}
              step={step}
              onChange={(e) => change(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") { setDraft(String(value)); onCancelPreview?.(); }
              }}
            />
            {unit && <small>{unit}</small>}
          </span>
          {onKeyframe && (
            <button
              className="keyframe-button"
              aria-label={`${label} 키프레임 추가`}
              title="현재 위치에 키프레임 추가"
              onClick={onKeyframe}
            >
              <Diamond size={12} />
            </button>
          )}
        </span>
      </label>
      {range && (
        <input
          aria-label={`${label} 슬라이더`}
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(draft) || 0}
          onChange={(e) => change(e.target.value)}
          onPointerUp={commit}
          onPointerCancel={() => { setDraft(String(value)); onCancelPreview?.(); }}
          onKeyUp={(e) => {
            if (
              [
                "ArrowLeft",
                "ArrowRight",
                "Home",
                "End",
                "PageUp",
                "PageDown",
              ].includes(e.key)
            )
              commit();
          }}
        />
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onCommit,
  onPreview,
  multiline = false,
}: {
  label: string;
  value: string;
  onCommit: (v: string) => void;
  onPreview?: (v: string) => void;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <label className="inspector-text-field">
      <span>{label}</span>
      {multiline ? (
        <textarea
          value={draft}
          onChange={(e) => { setDraft(e.target.value); onPreview?.(e.target.value); }}
          onBlur={() => {
            if (draft !== value) onCommit(draft);
          }}
          rows={4}
        />
      ) : (
        <input
          value={draft}
          onChange={(e) => { setDraft(e.target.value); onPreview?.(e.target.value); }}
          onBlur={() => {
            if (draft !== value) onCommit(draft);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
      )}
    </label>
  );
}

function Section({
  title,
  children,
  onReset,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  onReset?: () => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="inspector-section">
      <div className="inspector-section-heading">
        <button onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          <ChevronDown size={14} className={open ? "" : "collapsed"} />
          <span>{title}</span>
        </button>
        {onReset && (
          <button
            aria-label={`${title} 초기화`}
            title="초기화"
            onClick={onReset}
          >
            <RotateCcw size={13} />
          </button>
        )}
      </div>
      {open && <div className="inspector-section-body">{children}</div>}
    </section>
  );
}

export function Inspector({
  project,
  selected,
  onCommand,
  playhead,
}: InspectorProps) {
  const preview = usePreviewDraft();
  const { catalog } = useAssetCatalog(selected?.kind === "text");
  const [tab, setTab] = useState("basic");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [hslChannel, setHslChannel] = useState<HslChannel>("red");
  const [curveChannel, setCurveChannel] = useState<CurveChannel>("master");
  const [lutPath, setLutPath] = useState("");
  useEffect(() => {
    setTab("basic");
    setError("");
    setLutPath("");
  }, [selected?.id]);
  const run = async (method: string, params: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      await onCommand(method, params);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      if (selected) preview(selected.id, null);
    } finally {
      setBusy(false);
    }
  };
  const patch = (changes: Record<string, unknown>) =>
    selected &&
    void run("edit.update", {
      id: selected.id,
      patch: changes,
      expectedRevision: project.revision,
    });
  const patchTransform = (key: string, value: number | boolean) =>
    selected && patch({ transform: { ...selected.transform, [key]: value } });
  const patchColor = (key: string, value: number) =>
    selected && patch({ color: { ...selected.color, [key]: value } });
  const patchText = (key: string, value: unknown) =>
    selected && patch({ text: { ...selected.text, [key]: value } });
  const draft = (changes: Record<string, unknown>) => selected && preview(selected.id, changes);
  const clearDraft = () => selected && preview(selected.id, null);
  const draftTransform = (key: string, value: number) => selected && draft({ transform: { ...selected.transform, [key]: value } });
  const draftColor = (key: string, value: number) => selected && draft({ color: { ...selected.color, [key]: value } });
  const draftText = (key: string, value: unknown) => selected && draft({ text: { ...selected.text, [key]: value } });
  const chooseFont = (value: string) => {
    const imported = catalog.fonts.find((font) => font.id === value);
    if (imported && selected) void run("fonts.apply", { id: imported.id, clipId: selected.id, expectedRevision: project.revision });
    else patch({ text: { fontFamily: value } });
  };
  const addFont = async () => {
    setBusy(true); setError("");
    try {
      const files = await pickFiles(["ttf", "otf"]);
      if (!files?.[0]) return;
      const font = await rpc<StudioFont>("fonts.import", { path: files[0] });
      notifyAssetsChanged(); await registerFont(font);
      if (selected) await onCommand("fonts.apply", { id: font.id, clipId: selected.id, expectedRevision: project.revision });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const addKeyframe = (property: string, value: number) => {
    if (!selected) return;
    const time = Math.max(
      0,
      Math.min(selected.duration, playhead - selected.start),
    );
    const others = selected.keyframes.filter(
      (k) =>
        k.property !== property ||
        Math.abs(k.time - time) > 1 / project.fps / 2,
    );
    patch({
      keyframes: [...others, { property, time, value }].sort(
        (a, b) => a.time - b.time,
      ),
    });
  };
  const isAudio = selected?.kind === "audio";
  const isText = selected?.kind === "text";
  const visual = selected && !isAudio;
  const selectedMedia = project.media.find((m) => m.id === selected?.mediaId);
  const hasAudio = selected && (isAudio || selectedMedia?.hasAudio);
  const tabs = selected
    ? isAudio
      ? [
          { id: "basic", label: "오디오" },
          { id: "speed", label: "속도" },
        ]
      : [
          { id: "basic", label: isText ? "텍스트" : "영상" },
          ...(!isText ? [{ id: "speed", label: "속도" }] : []),
          { id: "animation", label: "애니메이션" },
          ...(!isText ? [{ id: "adjust", label: "조정" }] : []),
        ]
    : [{ id: "basic", label: "프로젝트" }];
  const transform = selected?.transform || {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
  };
  const color = selected?.color || {
    brightness: 0,
    contrast: 1,
    saturation: 1,
    temperature: 0,
  };
  const hsl = {
    hue: 0,
    saturation: 0,
    lightness: 0,
    ...color.hsl?.[hslChannel],
  };
  const curves = color.curves || {};
  const stabilize = { enabled: false, strength: 1, ...selected?.stabilize };
  const patchHsl = (key: string, value: number) =>
    patch({
      color: {
        ...color,
        hsl: { ...color.hsl, [hslChannel]: { ...hsl, [key]: value } },
      },
    });
  const importLut = async (path: string) => {
    if (!selected || !path.trim()) return;
    await run("color.importLut", {
      id: selected.id,
      path: path.trim(),
      expectedRevision: project.revision,
    });
  };
  const browseLut = async () => {
    try {
      const paths = await pickFiles();
      if (paths?.[0]) {
        setLutPath(paths[0]);
        await importLut(paths[0]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const text = selected?.text || {
    content: "",
    fontSize: 64,
    color: "#ffffff",
    fontFamily: "Arial",
    bold: false,
    align: "center",
    background: "transparent",
  };
  const crop = { x: 0, y: 0, width: 1, height: 1, ...selected?.crop };
  const mask = {
    type: "none",
    x: 0.5,
    y: 0.5,
    width: 1,
    height: 1,
    feather: 0,
    ...selected?.mask,
  };
  const chromaKey = {
    enabled: false,
    color: "#00ff00",
    similarity: 0.1,
    blend: 0.05,
    ...selected?.chromaKey,
  };
  const audio = {
    normalize: false,
    denoise: false,
    voiceEnhance: false,
    ...selected?.audio,
  };
  const eq = { bass: 0, mid: 0, treble: 0, ...audio.eq };
  const patchCrop = (key: string, value: number) =>
    patch({ crop: { ...crop, [key]: value } });
  const patchMask = (key: string, value: number | string) =>
    patch({ mask: { ...mask, [key]: value } });
  const patchChroma = (key: string, value: number | string | boolean) =>
    patch({ chromaKey: { ...chromaKey, [key]: value } });
  const patchAudio = (key: string, value: boolean) =>
    patch({ audio: { ...audio, [key]: value } });
  const cropToRatio = (ratio: number) => {
    const sourceRatio =
      selectedMedia?.width && selectedMedia.height
        ? selectedMedia.width / selectedMedia.height
        : project.width / project.height;
    const width = Math.min(1, ratio / sourceRatio);
    const height = Math.min(1, sourceRatio / ratio);
    patch({ crop: { x: (1 - width) / 2, y: (1 - height) / 2, width, height } });
  };

  return (
    <section
      className="studio-inspector"
      aria-label="속성 패널"
      aria-busy={busy}
    >
      <nav className="inspector-tabs" aria-label="클립 속성">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? "active" : ""}
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="inspector-scroll">
        {!selected ? (
          <>
            <div className="project-inspector-title">
              <Settings2 size={18} />
              <h2>프로젝트 설정</h2>
            </div>
            <Section title="프로젝트">
              <TextField
                label="이름"
                value={project.name}
                onCommit={(name) =>
                  void run("project.update", { patch: { name } })
                }
              />
              <div className="project-stat-row">
                <span>전체 길이</span>
                <strong>{timecode(durationOf(project), project.fps)}</strong>
              </div>
              <div className="project-stat-row">
                <span>클립 / 소재</span>
                <strong>
                  {project.clips.length} / {project.media.length}
                </strong>
              </div>
            </Section>
            <Section title="화면 설정">
              <div className="aspect-ratios">
                {[
                  { label: "16:9", width: 1920, height: 1080 },
                  { label: "9:16", width: 1080, height: 1920 },
                  { label: "1:1", width: 1080, height: 1080 },
                  { label: "4:3", width: 1440, height: 1080 },
                ].map((r) => (
                  <button
                    key={r.label}
                    className={
                      Math.abs(
                        project.width / project.height - r.width / r.height,
                      ) < 0.01
                        ? "active"
                        : ""
                    }
                    onClick={() =>
                      void run("project.update", {
                        patch: { width: r.width, height: r.height },
                      })
                    }
                  >
                    {r.label}
                  </button>
                ))}
              </div>
              <NumberField
                label="가로"
                value={project.width}
                min={16}
                max={7680}
                step={2}
                unit="px"
                onCommit={(width) =>
                  void run("project.update", { patch: { width } })
                }
              />
              <NumberField
                label="세로"
                value={project.height}
                min={16}
                max={7680}
                step={2}
                unit="px"
                onCommit={(height) =>
                  void run("project.update", { patch: { height } })
                }
              />
              <label className="inspector-select-field">
                <span>프레임 속도</span>
                <select
                  value={project.fps}
                  onChange={(e) =>
                    void run("project.update", {
                      patch: { fps: Number(e.target.value) },
                    })
                  }
                >
                  {[24, 25, 30, 50, 60].map((f) => (
                    <option key={f} value={f}>
                      {f} fps
                    </option>
                  ))}
                </select>
              </label>
              <label className="inspector-color-field">
                <span>배경</span>
                <input
                  aria-label="프로젝트 배경 색상"
                  type="color"
                  value={project.background || "#000000"}
                  onChange={(e) =>
                    void run("project.update", {
                      patch: { background: e.target.value },
                    })
                  }
                />
                <code>{project.background}</code>
              </label>
            </Section>
            <div className="inspector-empty-hint">
              <Film size={25} />
              <p>
                타임라인에서 클립을 선택하면
                <br />
                세부 속성을 편집할 수 있습니다.
              </p>
            </div>
          </>
        ) : (
          <>
            <div className="selected-clip-name">
              <span title={selected.name}>{selected.name}</span>
              <small>
                {selected.kind === "text"
                  ? "텍스트"
                  : selected.kind === "audio"
                    ? "오디오"
                    : selected.kind === "image"
                      ? "이미지"
                      : "동영상"}
              </small>
            </div>
            {tab === "basic" && (
              <>
                {isText && (
                  <Section title="텍스트">
                    <TextField
                      label="내용"
                      value={text.content}
                      multiline
                      onPreview={(v) => draftText("content", v)}
                      onCommit={(v) => patchText("content", v)}
                    />
                    <label className="inspector-select-field">
                      <span>글꼴</span>
                      <select
                        value={text.fontId || text.fontFamily}
                        onChange={(e) => chooseFont(e.target.value)}
                      >
                        {[
                          "Arial",
                          "Helvetica",
                          "Georgia",
                          "Times New Roman",
                          "Courier New",
                        ].map((font) => (
                          <option key={font}>{font}</option>
                        ))}
                        {text.fontId && !catalog.fonts.some((font) => font.id === text.fontId) && <option value={text.fontId}>저장된 사용자 글꼴</option>}
                        {catalog.fonts.length > 0 && <optgroup label="내 글꼴">{catalog.fonts.map((font) => <option value={font.id} key={font.id}>{font.name}</option>)}</optgroup>}
                      </select>
                    </label>
                    <button className="panel-action-button inspector-font-add" disabled={busy} onClick={() => void addFont()}><Plus size={13} />글꼴 추가</button>
                    <NumberField
                      label="글자 크기"
                      value={text.fontSize}
                      min={8}
                      max={300}
                      unit="px"
                      onCommit={(v) => patchText("fontSize", v)}
                      onPreview={(v) => draftText("fontSize", v)} onCancelPreview={clearDraft}
                    />
                    <div className="text-format-controls">
                      <button
                        className={text.bold ? "active" : ""}
                        aria-label="굵게"
                        aria-pressed={text.bold}
                        onClick={() => patchText("bold", !text.bold)}
                      >
                        <strong>B</strong>
                      </button>
                      {[
                        { align: "left", Icon: AlignLeft, label: "왼쪽 정렬" },
                        {
                          align: "center",
                          Icon: AlignCenter,
                          label: "가운데 정렬",
                        },
                        {
                          align: "right",
                          Icon: AlignRight,
                          label: "오른쪽 정렬",
                        },
                      ].map(({ align, Icon, label }) => (
                        <button
                          key={align}
                          aria-label={label}
                          aria-pressed={text.align === align}
                          className={text.align === align ? "active" : ""}
                          onClick={() => patchText("align", align)}
                        >
                          <Icon size={15} />
                        </button>
                      ))}
                    </div>
                    <label className="inspector-color-field">
                      <span>텍스트 색상</span>
                      <input
                        aria-label="텍스트 색상"
                        type="color"
                        value={text.color}
                        onChange={(e) => patchText("color", e.target.value)}
                      />
                      <code>{text.color}</code>
                    </label>
                    <label className="inspector-check">
                      <input
                        type="checkbox"
                        checked={text.background !== "transparent"}
                        onChange={(e) =>
                          patchText(
                            "background",
                            e.target.checked ? "#18191d" : "transparent",
                          )
                        }
                      />
                      <span>배경 표시</span>
                    </label>
                    {text.background !== "transparent" && (
                      <label className="inspector-color-field">
                        <span>텍스트 배경</span>
                        <input
                          aria-label="텍스트 배경 색상"
                          type="color"
                          value={text.background.slice(0, 7)}
                          onChange={(e) =>
                            patchText("background", e.target.value)
                          }
                        />
                      </label>
                    )}
                  </Section>
                )}
                {visual && (
                  <Section
                    title="변형"
                    onReset={() =>
                      patch({
                        transform: {
                          x: 0,
                          y: 0,
                          scale: 1,
                          rotation: 0,
                          opacity: 1,
                          flipX: false,
                          flipY: false,
                        },
                      })
                    }
                  >
                    <NumberField
                      label="크기"
                      value={transform.scale * 100}
                      min={1}
                      max={500}
                      unit="%"
                      onCommit={(v) => patchTransform("scale", v / 100)}
                      onPreview={(v) => draftTransform("scale", v / 100)} onCancelPreview={clearDraft}
                      onKeyframe={() =>
                        addKeyframe("transform.scale", transform.scale)
                      }
                    />
                    <div className="number-pair">
                      <NumberField
                        label="위치 X"
                        value={transform.x}
                        step={1}
                        unit="px"
                        onCommit={(v) => patchTransform("x", v)}
                      onPreview={(v) => draftTransform("x", v)} onCancelPreview={clearDraft}
                        onKeyframe={() =>
                          addKeyframe("transform.x", transform.x)
                        }
                      />
                      <NumberField
                        label="위치 Y"
                        value={transform.y}
                        step={1}
                        unit="px"
                        onCommit={(v) => patchTransform("y", v)}
                      onPreview={(v) => draftTransform("y", v)} onCancelPreview={clearDraft}
                        onKeyframe={() =>
                          addKeyframe("transform.y", transform.y)
                        }
                      />
                    </div>
                    <NumberField
                      label="회전"
                      value={transform.rotation}
                      min={-360}
                      max={360}
                      unit="°"
                      onCommit={(v) => patchTransform("rotation", v)}
                      onPreview={(v) => draftTransform("rotation", v)} onCancelPreview={clearDraft}
                      onKeyframe={() =>
                        addKeyframe("transform.rotation", transform.rotation)
                      }
                    />
                    <NumberField
                      label="불투명도"
                      value={transform.opacity * 100}
                      min={0}
                      max={100}
                      unit="%"
                      range
                      onCommit={(v) => patchTransform("opacity", v / 100)}
                      onPreview={(v) => draftTransform("opacity", v / 100)} onCancelPreview={clearDraft}
                      onKeyframe={() =>
                        addKeyframe("transform.opacity", transform.opacity)
                      }
                    />
                    <div className="inspector-flips">
                      <span>뒤집기</span>
                      <button
                        aria-label="좌우 뒤집기"
                        aria-pressed={!!transform.flipX}
                        className={transform.flipX ? "active" : ""}
                        onClick={() =>
                          patchTransform("flipX", !transform.flipX)
                        }
                      >
                        <FlipHorizontal2 size={16} />
                        <span>좌우</span>
                      </button>
                      <button
                        aria-label="상하 뒤집기"
                        aria-pressed={!!transform.flipY}
                        className={transform.flipY ? "active" : ""}
                        onClick={() =>
                          patchTransform("flipY", !transform.flipY)
                        }
                      >
                        <FlipVertical2 size={16} />
                        <span>상하</span>
                      </button>
                    </div>
                  </Section>
                )}
                {visual && !isText && (
                  <Section
                    title="자르기"
                    defaultOpen={false}
                    onReset={() =>
                      patch({ crop: { x: 0, y: 0, width: 1, height: 1 } })
                    }
                  >
                    <div className="crop-ratios">
                      <button
                        aria-label="원본 비율"
                        onClick={() =>
                          patch({ crop: { x: 0, y: 0, width: 1, height: 1 } })
                        }
                      >
                        원본
                      </button>
                      {[
                        { label: "1:1", value: 1 },
                        { label: "9:16", value: 9 / 16 },
                        { label: "16:9", value: 16 / 9 },
                      ].map((r) => (
                        <button
                          key={r.label}
                          aria-label={`${r.label} 크롭`}
                          onClick={() => cropToRatio(r.value)}
                        >
                          {r.label}
                        </button>
                      ))}
                    </div>
                    <div className="number-pair">
                      <NumberField
                        label="크롭 X"
                        value={crop.x * 100}
                        min={0}
                        max={(1 - crop.width) * 100}
                        step={0.1}
                        unit="%"
                        onCommit={(v) => patchCrop("x", v / 100)}
                      />
                      <NumberField
                        label="크롭 Y"
                        value={crop.y * 100}
                        min={0}
                        max={(1 - crop.height) * 100}
                        step={0.1}
                        unit="%"
                        onCommit={(v) => patchCrop("y", v / 100)}
                      />
                    </div>
                    <div className="number-pair">
                      <NumberField
                        label="크롭 너비"
                        value={crop.width * 100}
                        min={1}
                        max={(1 - crop.x) * 100}
                        step={0.1}
                        unit="%"
                        onCommit={(v) => patchCrop("width", v / 100)}
                      />
                      <NumberField
                        label="크롭 높이"
                        value={crop.height * 100}
                        min={1}
                        max={(1 - crop.y) * 100}
                        step={0.1}
                        unit="%"
                        onCommit={(v) => patchCrop("height", v / 100)}
                      />
                    </div>
                    <p className="panel-help">
                      원본 안에서 사용할 영역을 지정합니다. 비율 프리셋은 중앙을
                      기준으로 자릅니다.
                    </p>
                  </Section>
                )}
                {visual && (
                  <Section
                    title="마스크"
                    defaultOpen={false}
                    onReset={() =>
                      patch({
                        mask: {
                          type: "none",
                          x: 0.5,
                          y: 0.5,
                          width: 1,
                          height: 1,
                          feather: 0,
                        },
                      })
                    }
                  >
                    <div className="mask-shapes">
                      {[
                        { value: "none", label: "없음", Icon: Square },
                        { value: "circle", label: "원형", Icon: Circle },
                        { value: "rectangle", label: "사각형", Icon: Square },
                      ].map(({ value, label, Icon }) => (
                        <button
                          key={value}
                          aria-label={`${label} 마스크`}
                          aria-pressed={mask.type === value}
                          className={mask.type === value ? "active" : ""}
                          onClick={() => patchMask("type", value)}
                        >
                          <Icon
                            size={19}
                            strokeWidth={value === "none" ? 1 : 1.5}
                          />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                    {mask.type !== "none" && (
                      <>
                        <div className="number-pair">
                          <NumberField
                            label="마스크 X"
                            value={mask.x * 100}
                            min={0}
                            max={100}
                            unit="%"
                            onCommit={(v) => patchMask("x", v / 100)}
                          />
                          <NumberField
                            label="마스크 Y"
                            value={mask.y * 100}
                            min={0}
                            max={100}
                            unit="%"
                            onCommit={(v) => patchMask("y", v / 100)}
                          />
                        </div>
                        <div className="number-pair">
                          <NumberField
                            label="마스크 너비"
                            value={mask.width * 100}
                            min={1}
                            max={200}
                            unit="%"
                            onCommit={(v) => patchMask("width", v / 100)}
                          />
                          <NumberField
                            label="마스크 높이"
                            value={mask.height * 100}
                            min={1}
                            max={200}
                            unit="%"
                            onCommit={(v) => patchMask("height", v / 100)}
                          />
                        </div>
                        <NumberField
                          label="가장자리 부드럽게"
                          value={mask.feather * 100}
                          min={0}
                          max={100}
                          unit="%"
                          range
                          onCommit={(v) => patchMask("feather", v / 100)}
                        />
                      </>
                    )}
                  </Section>
                )}
                {visual && !isText && (
                  <Section
                    title="크로마키"
                    defaultOpen={false}
                    onReset={() =>
                      patch({
                        chromaKey: {
                          enabled: false,
                          color: "#00ff00",
                          similarity: 0.1,
                          blend: 0.05,
                        },
                      })
                    }
                  >
                    <label className="inspector-check">
                      <input
                        type="checkbox"
                        checked={chromaKey.enabled}
                        onChange={(e) =>
                          patchChroma("enabled", e.target.checked)
                        }
                      />
                      <span>크로마키 사용</span>
                    </label>
                    {chromaKey.enabled && (
                      <>
                        <label className="inspector-color-field">
                          <span>제거할 색상</span>
                          <input
                            aria-label="크로마키 색상"
                            type="color"
                            value={chromaKey.color}
                            onChange={(e) =>
                              patchChroma("color", e.target.value)
                            }
                          />
                          <code>{chromaKey.color}</code>
                        </label>
                        <div className="chroma-colors">
                          <button
                            aria-label="그린 스크린 색상 선택"
                            style={{ background: "#00ff00" }}
                            onClick={() => patchChroma("color", "#00ff00")}
                          />
                          <button
                            aria-label="블루 스크린 색상 선택"
                            style={{ background: "#0000ff" }}
                            onClick={() => patchChroma("color", "#0000ff")}
                          />
                        </div>
                        <NumberField
                          label="색상 허용 범위"
                          value={chromaKey.similarity * 100}
                          min={1}
                          max={100}
                          step={1}
                          unit="%"
                          range
                          onCommit={(v) => patchChroma("similarity", v / 100)}
                        />
                        <NumberField
                          label="가장자리 혼합"
                          value={chromaKey.blend * 100}
                          min={0}
                          max={100}
                          step={1}
                          unit="%"
                          range
                          onCommit={(v) => patchChroma("blend", v / 100)}
                        />
                      </>
                    )}
                  </Section>
                )}
                {selected.kind === "video" && (
                  <Section
                    title="흔들림 보정"
                    defaultOpen={false}
                    onReset={() =>
                      patch({ stabilize: { enabled: false, strength: 1 } })
                    }
                  >
                    <label className="inspector-check">
                      <input
                        type="checkbox"
                        checked={stabilize.enabled}
                        onChange={(event) =>
                          patch({
                            stabilize: {
                              ...stabilize,
                              enabled: event.target.checked,
                            },
                          })
                        }
                      />
                      <span>흔들림 보정 사용</span>
                    </label>
                    {stabilize.enabled && (
                      <label className="inspector-select-field">
                        <span>보정 강도</span>
                        <select
                          value={stabilize.strength}
                          onChange={(event) =>
                            patch({
                              stabilize: {
                                ...stabilize,
                                strength: Number(event.target.value),
                              },
                            })
                          }
                        >
                          <option value={1}>낮음</option>
                          <option value={2}>보통</option>
                          <option value={3}>높음</option>
                        </select>
                      </label>
                    )}
                    <p className="panel-help">
                      작은 카메라 흔들림을 줄입니다. 재생 미리보기와 내보낸
                      영상에서 확인하세요.
                    </p>
                  </Section>
                )}
                {hasAudio && (
                  <Section
                    title="오디오"
                    onReset={() =>
                      patch({
                        volume: 1,
                        fadeIn: 0,
                        fadeOut: 0,
                        audio: {
                          normalize: false,
                          denoise: false,
                          voiceEnhance: false,
                          eq: { bass: 0, mid: 0, treble: 0 },
                        },
                      })
                    }
                  >
                    <NumberField
                      label="볼륨"
                      value={selected.volume * 100}
                      min={0}
                      max={200}
                      unit="%"
                      range
                      onCommit={(v) => patch({ volume: v / 100 })}
                    />
                    <label className="inspector-check">
                      <input
                        type="checkbox"
                        checked={selected.volume === 0}
                        onChange={(e) =>
                          patch({ volume: e.target.checked ? 0 : 1 })
                        }
                      />
                      <span>음소거</span>
                    </label>
                    <label className="inspector-check">
                      <input
                        type="checkbox"
                        checked={audio.normalize}
                        onChange={(e) =>
                          patchAudio("normalize", e.target.checked)
                        }
                      />
                      <span>음량 정규화</span>
                    </label>
                    <label className="inspector-check">
                      <input
                        type="checkbox"
                        checked={audio.denoise}
                        onChange={(e) =>
                          patchAudio("denoise", e.target.checked)
                        }
                      />
                      <span>노이즈 줄이기</span>
                    </label>
                    <label className="inspector-check">
                      <input
                        type="checkbox"
                        checked={audio.voiceEnhance}
                        onChange={(e) =>
                          patchAudio("voiceEnhance", e.target.checked)
                        }
                      />
                      <span>음성 선명하게</span>
                    </label>
                  </Section>
                )}
                {hasAudio && (
                  <Section
                    title="이퀄라이저"
                    defaultOpen={false}
                    onReset={() =>
                      patch({
                        audio: { ...audio, eq: { bass: 0, mid: 0, treble: 0 } },
                      })
                    }
                  >
                    {(
                      [
                        { key: "bass", label: "저음" },
                        { key: "mid", label: "중음" },
                        { key: "treble", label: "고음" },
                      ] as const
                    ).map(({ key, label }) => (
                      <NumberField
                        key={key}
                        label={label}
                        value={eq[key]}
                        min={-20}
                        max={20}
                        step={0.5}
                        unit="dB"
                        range
                        onCommit={(v) =>
                          patch({
                            audio: { ...audio, eq: { ...eq, [key]: v } },
                          })
                        }
                      />
                    ))}
                  </Section>
                )}
                <Section
                  title={isAudio ? "페이드" : "페이드 전환"}
                  onReset={() => patch({ fadeIn: 0, fadeOut: 0 })}
                >
                  <NumberField
                    label="페이드 인"
                    value={selected.fadeIn}
                    min={0}
                    max={selected.duration}
                    step={0.1}
                    unit="s"
                    onCommit={(v) => patch({ fadeIn: v })}
                  />
                  <NumberField
                    label="페이드 아웃"
                    value={selected.fadeOut}
                    min={0}
                    max={selected.duration}
                    step={0.1}
                    unit="s"
                    onCommit={(v) => patch({ fadeOut: v })}
                  />
                </Section>
                <Section title="타이밍">
                  <NumberField
                    label="시작 시간"
                    value={selected.start}
                    min={0}
                    step={1 / project.fps}
                    unit="s"
                    onCommit={(v) => patch({ start: v })}
                  />
                  <NumberField
                    label="길이"
                    value={selected.duration}
                    min={1 / project.fps}
                    step={1 / project.fps}
                    unit="s"
                    onCommit={(v) => patch({ duration: v })}
                  />
                  {selected.kind !== "text" && selected.kind !== "image" && (
                    <NumberField
                      label="소스 시작"
                      value={selected.sourceIn}
                      min={0}
                      max={selectedMedia?.duration}
                      step={1 / project.fps}
                      unit="s"
                      onCommit={(v) => patch({ sourceIn: v })}
                    />
                  )}
                  <TextField
                    label="클립 이름"
                    value={selected.name}
                    onCommit={(v) => patch({ name: v })}
                  />
                </Section>
              </>
            )}
            {tab === "speed" && (
              <>
                <Section
                  title="일반 속도"
                  onReset={() =>
                    patch({
                      speed: 1,
                      duration: selected.duration * selected.speed,
                      reverse: false,
                    })
                  }
                >
                  <NumberField
                    label="재생 속도"
                    value={selected.speed}
                    min={0.1}
                    max={8}
                    step={0.1}
                    unit="×"
                    range
                    onCommit={(v) =>
                      patch({
                        speed: v,
                        duration: (selected.duration * selected.speed) / v,
                      })
                    }
                  />
                  <div className="speed-presets">
                    {[0.5, 1, 1.5, 2, 4].map((speed) => (
                      <button
                        className={selected.speed === speed ? "active" : ""}
                        key={speed}
                        onClick={() =>
                          patch({
                            speed,
                            duration:
                              (selected.duration * selected.speed) / speed,
                          })
                        }
                      >
                        {speed}×
                      </button>
                    ))}
                  </div>
                  <label className="inspector-check">
                    <input
                      type="checkbox"
                      checked={selected.reverse}
                      onChange={(e) => patch({ reverse: e.target.checked })}
                    />
                    <span>역재생</span>
                  </label>
                  <div className="project-stat-row">
                    <span>변경 후 길이</span>
                    <strong>{selected.duration.toFixed(2)}초</strong>
                  </div>
                </Section>
                <p className="panel-help">
                  속도를 바꾸면 사용한 원본 구간을 유지하며 클립 길이를
                  조절합니다.
                </p>
              </>
            )}
            {tab === "adjust" && (
              <>
                <Section
                  title="기본 색보정"
                  onReset={() =>
                    patch({
                      color: {
                        ...color,
                        brightness: 0,
                        contrast: 1,
                        saturation: 1,
                        temperature: 0,
                        hue: 0,
                      },
                      filter: "original",
                    })
                  }
                >
                  <NumberField
                    label="밝기"
                    value={color.brightness * 100}
                    min={-100}
                    max={100}
                    range
                    onCommit={(v) => patchColor("brightness", v / 100)}
                      onPreview={(v) => draftColor("brightness", v / 100)} onCancelPreview={clearDraft}
                  />
                  <NumberField
                    label="대비"
                    value={(color.contrast - 1) * 100}
                    min={-100}
                    max={200}
                    range
                    onCommit={(v) => patchColor("contrast", 1 + v / 100)}
                      onPreview={(v) => draftColor("contrast", 1 + v / 100)} onCancelPreview={clearDraft}
                  />
                  <NumberField
                    label="채도"
                    value={(color.saturation - 1) * 100}
                    min={-100}
                    max={200}
                    range
                    onCommit={(v) => patchColor("saturation", 1 + v / 100)}
                      onPreview={(v) => draftColor("saturation", 1 + v / 100)} onCancelPreview={clearDraft}
                  />
                  <NumberField
                    label="색온도"
                    value={color.temperature * 100}
                    min={-100}
                    max={100}
                    range
                    onCommit={(v) => patchColor("temperature", v / 100)}
                      onPreview={(v) => draftColor("temperature", v / 100)} onCancelPreview={clearDraft}
                  />
                  <div className="color-guide">
                    <span>차갑게</span>
                    <span>따뜻하게</span>
                  </div>
                  <NumberField
                    label="색조"
                    value={color.hue || 0}
                    min={-180}
                    max={180}
                    unit="°"
                    range
                    onCommit={(v) => patchColor("hue", v)}
                      onPreview={(v) => draftColor("hue", v)} onCancelPreview={clearDraft}
                  />
                </Section>
                <Section
                  title="HSL"
                  defaultOpen={false}
                  onReset={() =>
                    patch({
                      color: {
                        ...color,
                        hsl: {
                          ...color.hsl,
                          [hslChannel]: { hue: 0, saturation: 0, lightness: 0 },
                        },
                      },
                    })
                  }
                >
                  <div
                    className="hsl-channels"
                    role="group"
                    aria-label="HSL 색상 범위"
                  >
                    {(
                      [
                        { id: "red", label: "빨강", color: "#ef5b62" },
                        { id: "yellow", label: "노랑", color: "#e2c34a" },
                        { id: "green", label: "초록", color: "#63c777" },
                        { id: "cyan", label: "청록", color: "#5dc7d3" },
                        { id: "blue", label: "파랑", color: "#658eea" },
                        { id: "magenta", label: "자홍", color: "#d46fd6" },
                      ] as const
                    ).map((channel) => (
                      <button
                        key={channel.id}
                        aria-label={channel.label}
                        aria-pressed={hslChannel === channel.id}
                        className={hslChannel === channel.id ? "active" : ""}
                        style={{ backgroundColor: channel.color }}
                        onClick={() => setHslChannel(channel.id)}
                      />
                    ))}
                  </div>
                  <NumberField
                    label="HSL 색조"
                    value={hsl.hue}
                    min={-180}
                    max={180}
                    unit="°"
                    range
                    onCommit={(value) => patchHsl("hue", value)}
                  />
                  <NumberField
                    label="HSL 채도"
                    value={hsl.saturation * 100}
                    min={-100}
                    max={100}
                    unit="%"
                    range
                    onCommit={(value) => patchHsl("saturation", value / 100)}
                  />
                  <NumberField
                    label="HSL 밝기"
                    value={hsl.lightness * 100}
                    min={-100}
                    max={100}
                    unit="%"
                    range
                    onCommit={(value) => patchHsl("lightness", value / 100)}
                  />
                </Section>
                <Section
                  title="곡선"
                  defaultOpen={false}
                  onReset={() =>
                    patch({
                      color: {
                        ...color,
                        curves: {
                          preset: "none",
                          master: [],
                          red: [],
                          green: [],
                          blue: [],
                        },
                      },
                    })
                  }
                >
                  <label className="inspector-select-field">
                    <span>곡선 프리셋</span>
                    <select
                      value={curves.preset || "none"}
                      onChange={(event) =>
                        patch({
                          color: {
                            ...color,
                            curves: {
                              preset: event.target.value,
                              master: [],
                              red: [],
                              green: [],
                              blue: [],
                            },
                          },
                        })
                      }
                    >
                      {[
                        { id: "none", label: "사용자 지정" },
                        { id: "lighter", label: "밝게" },
                        { id: "darker", label: "어둡게" },
                        { id: "medium_contrast", label: "중간 대비" },
                        { id: "strong_contrast", label: "강한 대비" },
                        { id: "linear_contrast", label: "선형 대비" },
                        { id: "increase_contrast", label: "대비 증가" },
                        { id: "vintage", label: "빈티지" },
                        { id: "cross_process", label: "크로스 프로세스" },
                        { id: "color_negative", label: "컬러 네거티브" },
                        { id: "negative", label: "네거티브" },
                      ].map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {preset.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div
                    className="curve-channels"
                    role="group"
                    aria-label="곡선 채널"
                  >
                    {(
                      [
                        { id: "master", label: "RGB", color: "#edf0f4" },
                        { id: "red", label: "R", color: "#f07178" },
                        { id: "green", label: "G", color: "#7bd68c" },
                        { id: "blue", label: "B", color: "#7fa0f1" },
                      ] as const
                    ).map((channel) => (
                      <button
                        key={channel.id}
                        aria-label={`${channel.label} 곡선`}
                        aria-pressed={curveChannel === channel.id}
                        className={curveChannel === channel.id ? "active" : ""}
                        style={{ color: channel.color }}
                        onClick={() => setCurveChannel(channel.id)}
                      >
                        {channel.label}
                      </button>
                    ))}
                  </div>
                  {curves.preset && curves.preset !== "none" && (
                    <p className="panel-help">
                      현재 프리셋이 적용되어 있습니다. 제어점을 바꾸면 사용자
                      지정 곡선으로 전환됩니다.
                    </p>
                  )}
                  <CurveEditor
                    key={`${selected.id}-${curveChannel}`}
                    points={curves[curveChannel]}
                    color={
                      {
                        master: "#edf0f4",
                        red: "#f07178",
                        green: "#7bd68c",
                        blue: "#7fa0f1",
                      }[curveChannel]
                    }
                    onCommit={(points) =>
                      patch({
                        color: {
                          ...color,
                          curves: {
                            ...curves,
                            preset: "none",
                            [curveChannel]: points,
                          },
                        },
                      })
                    }
                  />
                </Section>
                <Section title="LUT" defaultOpen={false}>
                  {color.lut?.path && (
                    <>
                      <div className="lut-current">
                        <span>{color.lut.name || "가져온 LUT"}</span>
                        <label className="inspector-check">
                          <input
                            aria-label="LUT 사용"
                            type="checkbox"
                            checked={color.lut.enabled}
                            onChange={(event) =>
                              patch({
                                color: {
                                  ...color,
                                  lut: {
                                    ...color.lut,
                                    enabled: event.target.checked,
                                  },
                                },
                              })
                            }
                          />
                        </label>
                      </div>
                      <button
                        className="panel-wide-button secondary"
                        disabled={!color.lut.enabled}
                        onClick={() =>
                          patch({
                            color: {
                              ...color,
                              lut: { ...color.lut, enabled: false },
                            },
                          })
                        }
                      >
                        <Trash2 size={13} />
                        LUT 효과 해제
                      </button>
                    </>
                  )}
                  <label className="inspector-text-field">
                    <span>LUT 파일 경로</span>
                    <input
                      aria-label="LUT 파일 경로"
                      value={lutPath}
                      placeholder="/Users/…/look.cube"
                      onChange={(event) => setLutPath(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void importLut(lutPath);
                      }}
                    />
                  </label>
                  <div className="lut-import-actions">
                    {isTauri() && (
                      <button
                        className="panel-wide-button secondary"
                        disabled={busy}
                        onClick={() => void browseLut()}
                      >
                        파일 선택
                      </button>
                    )}
                    <button
                      className="panel-wide-button secondary"
                      disabled={busy || !lutPath.trim()}
                      onClick={() => void importLut(lutPath)}
                    >
                      LUT 가져오기
                    </button>
                  </div>
                  <p className="panel-help">
                    .cube · .3dl 파일을 가져옵니다. LUT는 프로젝트에 복사해
                    보관합니다.
                  </p>
                </Section>
              </>
            )}
            {tab === "animation" && (
              <>
                <Section title="키프레임">
                  <p className="panel-help">
                    속성 옆 다이아몬드를 눌러 현재 재생 위치의 값을 기록하세요.
                    키프레임 사이의 값은 자동으로 연결됩니다.
                  </p>
                  <div className="project-stat-row">
                    <span>클립 내 현재 위치</span>
                    <strong>
                      {Math.max(
                        0,
                        Math.min(selected.duration, playhead - selected.start),
                      ).toFixed(2)}
                      초
                    </strong>
                  </div>
                  <button
                    className="panel-wide-button secondary"
                    onClick={() =>
                      addKeyframe("transform.scale", transform.scale)
                    }
                  >
                    <Diamond size={13} />
                    크기 키프레임 추가
                  </button>
                  {selected.keyframes.length ? (
                    <div className="keyframe-list">
                      {selected.keyframes.map(
                        (frame: Keyframe, index: number) => (
                          <div
                            className="keyframe-row"
                            key={`${frame.property}-${frame.time}-${index}`}
                          >
                            <Diamond size={11} />
                            <span>
                              <strong>
                                {{
                                  "transform.x": "위치 X",
                                  "transform.y": "위치 Y",
                                  "transform.scale": "크기",
                                  "transform.rotation": "회전",
                                  "transform.opacity": "불투명도",
                                }[frame.property] || frame.property}
                              </strong>
                              <small>
                                {frame.time.toFixed(2)}초 ·{" "}
                                {Number(frame.value.toFixed(3))}
                              </small>
                            </span>
                            <button
                              aria-label={`${frame.time}초 ${frame.property} 키프레임 삭제`}
                              onClick={() =>
                                patch({
                                  keyframes: selected.keyframes.filter(
                                    (_, i) => i !== index,
                                  ),
                                })
                              }
                            >
                              <Trash2 size={12} />
                            </button>
                          </div>
                        ),
                      )}
                    </div>
                  ) : (
                    <div className="keyframe-empty">
                      <Diamond size={24} />
                      <span>아직 키프레임이 없습니다</span>
                    </div>
                  )}
                </Section>
              </>
            )}
          </>
        )}
        {error && (
          <p className="panel-inline-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <footer className="inspector-footer">
        <SlidersHorizontal size={12} />
        <span>
          {busy
            ? "변경 사항 적용 중…"
            : selected
              ? "변경 사항은 자동 저장됩니다"
              : "프로젝트 설정"}
        </span>
      </footer>
    </section>
  );
}

export default Inspector;
