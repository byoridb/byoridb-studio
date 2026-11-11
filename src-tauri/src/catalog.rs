//! User-installed fonts and declarative editing presets. Catalog changes are not edits.
//! Managed files are immutable and retained after removing a catalog entry so saved
//! projects and undo history keep rendering with their original dependencies.
use crate::{editor, media};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const MAX_FONT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PRESET_BYTES: u64 = 16 * 1024 * 1024;

fn directory(root: &Path) -> PathBuf {
    root.join("catalog")
}

fn read(root: &Path) -> Result<Value, String> {
    let path = directory(root).join("index.json");
    if !path.exists() {
        return Ok(json!({"version":1,"fonts":[],"presets":[]}));
    }
    let value: Value = serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| format!("추가 소재 목록을 읽을 수 없습니다: {e}"))?;
    if value["version"] != 1 || !value["fonts"].is_array() || !value["presets"].is_array() {
        return Err("추가 소재 목록의 형식이 올바르지 않습니다.".into());
    }
    Ok(value)
}

fn write(root: &Path, value: &Value) -> Result<(), String> {
    media::atomic_json(&directory(root).join("index.json"), value)
}

pub fn list(root: &Path) -> Result<Value, String> {
    let value = read(root)?;
    Ok(json!({"fonts":value["fonts"],"presets":value["presets"]}))
}

fn name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 120 || value.chars().any(char::is_control) {
        return Err("이름은 제어 문자 없이 1~120자로 입력해 주세요.".into());
    }
    Ok(value.into())
}

pub fn font_asset_path(root: &Path, id: &str) -> Option<PathBuf> {
    let hash = id.strip_prefix("font-")?;
    if hash.len() != 64 || !hash.bytes().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let fonts = directory(root).join("fonts").canonicalize().ok()?;
    ["ttf", "otf"].iter().find_map(|ext| {
        let path = fonts.join(format!("{id}.{ext}")).canonicalize().ok()?;
        (path.parent() == Some(fonts.as_path()) && path.is_file()).then_some(path)
    })
}

pub fn import_font(
    root: &Path,
    path: &Path,
    requested_name: Option<&str>,
) -> Result<Value, String> {
    let source = path
        .canonicalize()
        .map_err(|e| format!("글꼴 파일을 찾을 수 없습니다: {e}"))?;
    let ext = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["ttf", "otf"].contains(&ext.as_str()) {
        return Err(".ttf 또는 .otf 글꼴 파일을 선택해 주세요.".into());
    }
    let size = std::fs::metadata(&source).map_err(|e| e.to_string())?.len();
    if size == 0 || size > MAX_FONT_BYTES {
        return Err("글꼴은 비어 있지 않은 32MB 이하의 파일이어야 합니다.".into());
    }
    let bytes = std::fs::read(&source).map_err(|e| e.to_string())?;
    let parsed = std::panic::catch_unwind(|| {
        fontdue::Font::from_bytes(bytes.as_slice(), Default::default())
    })
    .map_err(|_| "이 글꼴은 읽을 수 없습니다.")?
    .map_err(|e| format!("미리보기와 내보내기에 사용할 수 없는 글꼴입니다: {e}"))?;
    if parsed.horizontal_line_metrics(32.0).is_none() {
        return Err("글꼴의 글자 높이를 읽을 수 없습니다.".into());
    }
    let id = format!("font-{:x}", Sha256::digest(&bytes));
    let mut value = read(root)?;
    let existing = value["fonts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["id"] == id)
        .cloned();
    let font_name = name(requested_name.unwrap_or_else(|| {
        source
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("추가 글꼴")
    }))?;
    let fonts = directory(root).join("fonts");
    std::fs::create_dir_all(&fonts).map_err(|e| e.to_string())?;
    let target = font_asset_path(root, &id).unwrap_or_else(|| fonts.join(format!("{id}.{ext}")));
    if !target.exists() {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
    }
    let mut font = existing.unwrap_or_else(|| json!({"id":id,"name":font_name,"family":format!("Byori-{id}"),"createdAt":media::now()}));
    font["path"] = json!(target);
    value["fonts"]
        .as_array_mut()
        .unwrap()
        .retain(|f| f["id"] != id);
    value["fonts"].as_array_mut().unwrap().push(font.clone());
    write(root, &value)?;
    Ok(font)
}

pub fn find(root: &Path, collection: &str, id: &str) -> Result<Value, String> {
    read(root)?[collection]
        .as_array()
        .ok_or("추가 소재 종류가 올바르지 않습니다.")?
        .iter()
        .find(|p| p["id"] == id)
        .cloned()
        .ok_or("추가 소재를 찾을 수 없습니다.".into())
}

pub fn remove(root: &Path, collection: &str, id: &str) -> Result<Value, String> {
    let mut value = read(root)?;
    let entries = value[collection]
        .as_array_mut()
        .ok_or("추가 소재 종류가 올바르지 않습니다.")?;
    if !entries.iter().any(|p| p["id"] == id) {
        return Err("추가 소재를 찾을 수 없습니다.".into());
    }
    entries.retain(|p| p["id"] != id);
    write(root, &value)?;
    Ok(json!({"removed":true}))
}

pub async fn save_preset(
    root: &Path,
    clip: &Value,
    requested_name: &str,
    kind: &str,
) -> Result<Value, String> {
    let mut preset = editor::capture_preset(clip, kind)?;
    preset["name"] = json!(name(requested_name)?);
    if let Some(path) = preset["patch"]["color"]["lut"]["path"]
        .as_str()
        .map(PathBuf::from)
    {
        preset["patch"]["color"]["lut"] =
            media::import_lut(&path, &directory(root).join("luts")).await?;
        // Import validation enables a LUT; preserve the selected clip's switch.
        preset["patch"]["color"]["lut"]["enabled"] =
            json!(clip["color"]["lut"]["enabled"] != false);
    }
    insert_preset(root, preset)
}

fn insert_preset(root: &Path, mut preset: Value) -> Result<Value, String> {
    editor::validate_preset(&preset)?;
    preset["version"] = json!(1);
    preset["id"] = json!(media::id("preset"));
    preset["createdAt"] = json!(media::now());
    let mut value = read(root)?;
    value["presets"]
        .as_array_mut()
        .unwrap()
        .push(preset.clone());
    write(root, &value)?;
    Ok(preset)
}

pub async fn import_preset(root: &Path, path: &Path) -> Result<Value, String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("프리셋을 읽을 수 없습니다: {e}"))?
        .len();
    if size == 0 || size > MAX_PRESET_BYTES {
        return Err("프리셋은 비어 있지 않은 16MB 이하의 JSON 파일이어야 합니다.".into());
    }
    let mut preset: Value =
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| format!("프리셋 JSON 형식이 올바르지 않습니다: {e}"))?;
    if preset["version"] != 1 {
        return Err(
            "지원하지 않는 프리셋 버전입니다. Byori Studio 프리셋 v1 파일을 선택해 주세요.".into(),
        );
    }
    let fields = [
        "version",
        "id",
        "createdAt",
        "name",
        "kind",
        "target",
        "sourceDuration",
        "patch",
        "lutData",
    ];
    if preset
        .as_object()
        .is_none_or(|p| p.keys().any(|k| !fields.contains(&k.as_str())))
    {
        return Err("프리셋에 지원하지 않는 속성이 있습니다.".into());
    }
    preset["name"] = json!(name(preset["name"].as_str().unwrap_or(""))?);
    // A portable preset may embed LUT text, but cannot instruct Studio to read
    // an arbitrary local path supplied by a downloaded JSON file.
    if preset["patch"]["color"]["lut"].get("path").is_some() {
        return Err("프리셋의 LUT는 로컬 경로 대신 내보내기로 포함한 lutData가 필요합니다.".into());
    }
    if let Some(lut) = preset.get("lutData").cloned() {
        let ext = lut["extension"].as_str().unwrap_or("");
        if !["cube", "3dl"].contains(&ext)
            || preset["kind"] != "filter"
            || lut.as_object().is_none_or(|object| {
                object
                    .keys()
                    .any(|key| !["extension", "name", "content"].contains(&key.as_str()))
            })
            || !preset["patch"]["color"]["lut"].is_object()
        {
            return Err("프리셋의 LUT 형식이 올바르지 않습니다.".into());
        }
        let mut candidate = preset.clone();
        candidate["patch"]["color"]["lut"]["path"] = json!(format!("managed.{ext}"));
        editor::validate_preset(&candidate)?;
        let content = lut["content"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 10 * 1024 * 1024)
            .ok_or("프리셋의 LUT 내용이 올바르지 않습니다.")?;
        let folder = directory(root).join("luts");
        std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let temporary = folder.join(format!("{}.{}", media::id("incoming"), ext));
        std::fs::write(&temporary, content).map_err(|e| e.to_string())?;
        let result = media::import_lut(&temporary, &folder).await;
        let _ = std::fs::remove_file(&temporary);
        let mut imported = result?;
        imported["name"] = json!(name(lut["name"].as_str().unwrap_or("추가 LUT"))?);
        imported["enabled"] = json!(preset["patch"]["color"]["lut"]["enabled"] != false);
        preset["patch"]["color"]["lut"] = imported;
        preset.as_object_mut().unwrap().remove("lutData");
    }
    insert_preset(root, preset)
}

pub fn export_preset(root: &Path, id: &str, path: &Path) -> Result<Value, String> {
    if path
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_lowercase())
        != Some("json".into())
    {
        return Err("프리셋은 .json 파일로 저장해 주세요.".into());
    }
    let mut preset = find(root, "presets", id)?;
    if let Some(lut_path) = preset["patch"]["color"]["lut"]["path"]
        .as_str()
        .map(PathBuf::from)
    {
        let content = std::fs::read_to_string(&lut_path)
            .map_err(|e| format!("프리셋 LUT 파일을 읽을 수 없습니다: {e}"))?;
        preset["lutData"] = json!({"extension":lut_path.extension().and_then(|s| s.to_str()).unwrap_or("cube"),"name":preset["patch"]["color"]["lut"]["name"],"content":content});
        preset["patch"]["color"]["lut"]
            .as_object_mut()
            .unwrap()
            .remove("path");
    }
    media::atomic_json(path, &preset)?;
    Ok(json!({"path":path}))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn root() -> PathBuf {
        std::env::temp_dir().join(media::id("studio-catalog-test"))
    }

    #[test]
    fn invalid_fonts_never_enter_catalog_and_asset_ids_cannot_escape() {
        let dir = root();
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("invalid.ttf");
        std::fs::write(&path, b"not a font").unwrap();
        assert!(import_font(&dir, &path, None).is_err());
        assert!(list(&dir).unwrap()["fonts"].as_array().unwrap().is_empty());
        assert!(font_asset_path(&dir, "../current.json").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn lut_preset_export_and_import_are_portable_without_source_path() {
        let dir = root();
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.cube");
        std::fs::write(
            &source,
            "LUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n",
        )
        .unwrap();
        let clip = json!({"kind":"image","duration":3.0,"color":{"brightness":0.1,"contrast":1.0,"saturation":1.0,"temperature":0.0,"lut":{"enabled":true,"path":source,"name":"source.cube"}}});
        let saved = save_preset(&dir, &clip, "LUT preset", "filter")
            .await
            .unwrap();
        std::fs::remove_file(&source).unwrap();
        let exported = dir.join("portable.json");
        export_preset(&dir, saved["id"].as_str().unwrap(), &exported).unwrap();
        let json: Value = serde_json::from_slice(&std::fs::read(&exported).unwrap()).unwrap();
        assert!(json["patch"]["color"]["lut"].get("path").is_none());
        assert!(json["lutData"]["content"]
            .as_str()
            .unwrap()
            .contains("LUT_3D_SIZE"));
        let destination = root();
        let imported = import_preset(&destination, &exported).await.unwrap();
        let path = PathBuf::from(imported["patch"]["color"]["lut"]["path"].as_str().unwrap());
        assert!(path.starts_with(&destination) && path.is_file());
        assert_eq!(imported["patch"]["color"]["lut"]["enabled"], true);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(destination).unwrap();
    }

    #[test]
    fn font_import_is_deduplicated_and_removal_retains_saved_project_bytes() {
        let Some(source) = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file()) else {
            return;
        };
        let dir = root();
        let font = import_font(&dir, &source, Some("Test Font")).unwrap();
        let duplicate = import_font(&dir, &source, Some("Duplicate")).unwrap();
        assert_eq!(font["id"], duplicate["id"]);
        assert_eq!(list(&dir).unwrap()["fonts"].as_array().unwrap().len(), 1);
        let id = font["id"].as_str().unwrap();
        let managed = font_asset_path(&dir, id).unwrap();
        assert_eq!(
            std::fs::read(&managed).unwrap(),
            std::fs::read(source).unwrap()
        );
        remove(&dir, "fonts", id).unwrap();
        assert!(font_asset_path(&dir, id).is_some());
        assert!(list(&dir).unwrap()["fonts"].as_array().unwrap().is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn imported_presets_reject_commands_invalid_values_and_external_lut_paths() {
        let dir = root();
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("preset.json");
        for patch in [
            json!({"command":"rm -rf"}),
            json!({"color":{"brightness":10}}),
            json!({"color":{"lut":{"path":"/tmp/a.cube","enabled":true}}}),
        ] {
            let data = json!({"version":1,"name":"bad","kind":"filter","target":"visual","sourceDuration":3,"patch":patch});
            media::atomic_json(&file, &data).unwrap();
            assert!(import_preset(&dir, &file).await.is_err());
        }
        assert!(list(&dir).unwrap()["presets"]
            .as_array()
            .unwrap()
            .is_empty());
        let malformed = json!({"version":1,"name":"bad nested data","kind":"filter","target":"visual","sourceDuration":3,"patch":{"color":"invalid"},"lutData":{"extension":"cube","content":"LUT_3D_SIZE 2"}});
        media::atomic_json(&file, &malformed).unwrap();
        assert!(import_preset(&dir, &file).await.is_err());
        let saved = save_preset(&dir,&json!({"kind":"image","duration":3,"color":{"lut":{"enabled":false,"path":"/missing/disabled.cube"}}}),"Disabled LUT","filter").await.unwrap();
        assert_eq!(saved["patch"]["color"]["lut"], json!({"enabled":false}));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
