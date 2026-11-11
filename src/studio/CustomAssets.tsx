import { useState } from "react";
import { Download, FilePlus2, FolderOpen, Plus, Save, Trash2, Type } from "lucide-react";
import { pickFiles, rpc, savePath } from "./api";
import { notifyAssetsChanged, registerFont, useAssetCatalog, type StudioFont } from "./assetCatalog";
import { usePreviewDraft } from "./previewDraft";
import type { Clip, Command, Project } from "./types";
import "./custom-assets.css";

interface Props { project: Project; selected: Clip | null; onCommand: Command }

export function FontLibrary({ project, selected, onCommand }: Props) {
  const { catalog, error: catalogError } = useAssetCatalog();
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function importFont(value: string) {
    const font = await rpc<StudioFont>("fonts.import", { path: value });
    notifyAssetsChanged();
    await registerFont(font);
    setPath(""); setNotice(`${font.name} 글꼴을 추가했습니다.`);
  }
  return <section className="custom-assets" aria-label="내 글꼴">
    <div className="custom-assets-heading"><h3>내 글꼴 <span>{catalog.fonts.length}</span></h3>
      <button className="panel-action-button" disabled={busy} onClick={() => void action(async () => {
        const files = await pickFiles(["ttf", "otf"]);
        if (files?.[0]) await importFont(files[0]);
      })}><Plus size={13} />글꼴 추가</button>
    </div>
    <p className="panel-help">TTF·OTF 파일을 추가하면 텍스트에서 선택할 수 있습니다.</p>
    <details className="asset-path-details"><summary>파일 경로로 추가</summary>
      <form onSubmit={(e) => { e.preventDefault(); void action(() => importFont(path.trim())); }}>
        <input aria-label="글꼴 파일 경로" placeholder="/…/MyFont.ttf" value={path} onChange={(e) => setPath(e.target.value)} />
        <button disabled={busy || !path.trim()} aria-label="경로의 글꼴 추가"><Plus size={14} /></button>
      </form>
    </details>
    {catalog.fonts.map((font) => <div className="custom-asset-row" key={font.id}>
      <button className="custom-asset-apply font-sample" style={{ fontFamily: font.family }}
        aria-label={`${font.name} 글꼴 적용`}
        disabled={busy || selected?.kind !== "text"} title="선택한 텍스트에 적용"
        onClick={() => void action(() => onCommand("fonts.apply", { id: font.id, clipId: selected!.id, expectedRevision: project.revision }))}>
        <Type size={15} /><span>{font.name}<small>가나다 Aa 123</small></span>
      </button>
      <button className="asset-icon-button" aria-label={`${font.name} 글꼴 목록에서 제거`} title="목록에서 제거 · 기존 프로젝트는 유지"
        disabled={busy} onClick={() => void action(async () => { await rpc("fonts.remove", { id: font.id }); notifyAssetsChanged(); })}><Trash2 size={13} /></button>
    </div>)}
    {notice && <p role="status" className="asset-notice">{notice}</p>}
    {(error || catalogError) && <p role="alert" className="panel-error">{error || catalogError}</p>}
  </section>;
}

export function PresetLibrary({ kind, project, selected, onCommand }: Props & { kind: "filter" | "effect" }) {
  const { catalog, error: catalogError } = useAssetCatalog();
  const preview = usePreviewDraft();
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const label = kind === "filter" ? "필터" : "효과";
  const presets = catalog.presets.filter((p) => p.kind === kind);
  const applicable = selected && (kind === "effect" || (selected.kind !== "audio" && selected.kind !== "text"));
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError(""); setNotice("");
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  async function importPreset(value: string) {
    if (/\.(cube|3dl)$/i.test(value)) {
      if (!applicable) throw new Error("LUT를 적용할 영상이나 이미지를 선택하세요.");
      await onCommand("color.importLut", { id: selected!.id, path: value, expectedRevision: project.revision });
      setNotice("LUT를 적용했습니다. 현재 설정을 내 필터로 저장할 수 있습니다.");
    } else {
      await rpc("presets.import", { path: value });
      notifyAssetsChanged(); setNotice("프리셋을 추가했습니다.");
    }
    setPath("");
  }
  return <section className="custom-assets" aria-label={`내 ${label}`}>
    <div className="custom-assets-heading"><h3>내 {label} <span>{presets.length}</span></h3>
      <button className="panel-action-button" disabled={busy} onClick={() => void action(async () => {
        const files = await pickFiles(kind === "filter" ? ["json", "cube", "3dl"] : ["json"]);
        if (files?.[0]) await importPreset(files[0]);
      })}><FolderOpen size={13} />가져오기</button>
    </div>
    <p className="panel-help">{kind === "filter" ? "LUT(.cube·.3dl) 또는 Studio 프리셋(.json)을 추가하세요." : "Studio 효과 프리셋(.json)을 추가하거나 현재 설정을 저장하세요."}</p>
    <form className="save-preset-form" onSubmit={(e) => { e.preventDefault(); void action(async () => {
      await rpc("presets.save", { clipId: selected!.id, name: name.trim(), kind, expectedRevision: project.revision }, project.id);
      notifyAssetsChanged(); setName(""); setNotice(`내 ${label}에 저장했습니다.`);
    }); }}>
      <input aria-label={`${label} 프리셋 이름`} placeholder="현재 설정을 저장할 이름" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
      <button disabled={busy || !applicable || !name.trim()} title="현재 클립 설정 저장" aria-label={`현재 ${label} 저장`}><Save size={14} /></button>
    </form>
    <details className="asset-path-details"><summary>파일 경로로 가져오기</summary>
      <form onSubmit={(e) => { e.preventDefault(); void action(() => importPreset(path.trim())); }}>
        <input aria-label={`${label} 파일 경로`} placeholder="/…/preset.json" value={path} onChange={(e) => setPath(e.target.value)} />
        <button disabled={busy || !path.trim()} aria-label={`경로의 ${label} 가져오기`}><FilePlus2 size={14} /></button>
      </form>
    </details>
    {presets.map((preset) => <div className="custom-asset-row" key={preset.id}>
      <button className="custom-asset-apply" disabled={busy || !applicable || (preset.target === "audio") !== (selected?.kind === "audio")}
        onMouseEnter={() => applicable && kind === "filter" && preview(selected!.id, preset.patch)} onMouseLeave={() => selected && preview(selected.id, null)}
        onFocus={() => applicable && kind === "filter" && preview(selected!.id, preset.patch)} onBlur={() => selected && preview(selected.id, null)}
        onClick={() => void action(() => onCommand("presets.apply", { id: preset.id, clipId: selected!.id, expectedRevision: project.revision }))}>{preset.name}</button>
      <button className="asset-icon-button" aria-label={`${preset.name} 프리셋 내보내기`} disabled={busy} onClick={() => void action(async () => {
        const destination = await savePath(`${preset.name}.json`, "json");
        if (destination) { await rpc("presets.export", { id: preset.id, path: destination }); setNotice("프리셋을 내보냈습니다."); }
      })}><Download size={13} /></button>
      <button className="asset-icon-button" aria-label={`${preset.name} 프리셋 제거`} disabled={busy} onClick={() => void action(async () => {
        await rpc("presets.remove", { id: preset.id }); notifyAssetsChanged();
      })}><Trash2 size={13} /></button>
    </div>)}
    {notice && <p role="status" className="asset-notice">{notice}</p>}
    {(error || catalogError) && <p role="alert" className="panel-error">{error || catalogError}</p>}
  </section>;
}
