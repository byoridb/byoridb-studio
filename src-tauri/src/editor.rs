use crate::{catalog, media, render};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub struct Editor {
    root: PathBuf,
    project: Value,
    undo: Vec<Value>,
    redo: Vec<Value>,
    jobs: render::RenderJobs,
    preview_assets: HashMap<String, PathBuf>,
    notice: Option<String>,
    file_path: Option<PathBuf>,
    /// Waveforms by media path. History snapshots are stored without them.
    waveforms: HashMap<String, Value>,
    /// Derived media state (waveform, proxy, missing) changed without a revision.
    derived_changed: bool,
}

pub const SCHEMA_VERSION: u64 = 2;
const FILTERS: &[&str] = &["none", "cinematic", "warm", "cool", "mono", "vintage"];
pub const TRANSITIONS: &[&str] = &[
    "fade",
    "dissolve",
    "wipeLeft",
    "wipeRight",
    "wipeUp",
    "wipeDown",
    "slideLeft",
    "slideRight",
    "zoom",
];
pub const BLEND_MODES: &[&str] = &[
    "normal", "multiply", "screen", "overlay", "darken", "lighten", "add",
];
pub const EASINGS: &[&str] = &["linear", "easeIn", "easeOut", "easeInOut", "hold"];
const CLIP_FIELDS: &[&str] = &[
    "name",
    "trackId",
    "mediaId",
    "start",
    "duration",
    "sourceIn",
    "speed",
    "reverse",
    "volume",
    "fadeIn",
    "fadeOut",
    "transform",
    "color",
    "text",
    "filter",
    "transitionIn",
    "transitionOut",
    "keyframes",
    "crop",
    "mask",
    "chromaKey",
    "audio",
    "stabilize",
    "groupId",
    "blendMode",
];

pub fn number(v: &Value, key: &str, fallback: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}
pub fn string<'a>(v: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

pub fn empty_project(name: &str, width: u64, height: u64, fps: f64) -> Value {
    json!({"id":media::id("project"),"schemaVersion":SCHEMA_VERSION,"name":name,"revision":0,"width":width,"height":height,
        "fps":fps,"background":"#111111","media":[],"clips":[],"markers":[],"notes":[],
        "concept":{"audience":"","message":"","appeal":"","direction":""},
        "tracks":[{"id":"video-1","name":"영상 1","kind":"video","muted":false,"hidden":false,"locked":false},
          {"id":"audio-1","name":"오디오 1","kind":"audio","muted":false,"hidden":false,"locked":false},
          {"id":"text-1","name":"텍스트 1","kind":"text","muted":false,"hidden":false,"locked":false}],
        "updatedAt":media::now()})
}

fn safe_project_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 100
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn load_project(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mut project: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    migrate_project(&mut project)?;
    validate_project(&project)?;
    Ok(project)
}

fn recent_valid_project(root: &Path) -> Option<Value> {
    std::fs::read_dir(root.join("projects"))
        .ok()?
        .flatten()
        .filter(|entry| entry.path().extension().and_then(|s| s.to_str()) == Some("json"))
        .filter_map(|entry| load_project(&entry.path()).ok())
        .max_by_key(|p| p["updatedAt"].as_u64().unwrap_or(0))
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

// Deletes the freeze-frame stills in a project's asset folder whose name the
// given project text does not mention.
fn remove_unreferenced_frames(assets: &Path, references: &str) {
    for entry in std::fs::read_dir(assets.join("frames"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let path = entry.path();
        let stem = path.file_stem().unwrap_or_default().to_string_lossy();
        if path.extension().is_some_and(|e| e == "png") && !references.contains(&*stem) {
            let _ = std::fs::remove_file(&path);
        }
    }
}

// edit.freeze stills that no saved project mentions any more (the freeze was
// undone). For startup only, when there is no undo history that could bring one
// back. Like the service's cleanup, an unreadable autosave that was set aside
// still counts as a reference, and an unreadable file means nothing is deleted.
fn remove_orphaned_frames(root: &Path) {
    let listed = |folder: &Path| -> Vec<PathBuf> {
        std::fs::read_dir(folder)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .collect()
    };
    let stored = listed(&root.join("projects"));
    let mut references = String::new();
    for file in stored.iter().chain(&listed(root)).filter(|path| {
        path.is_file()
            && path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().contains(".json"))
    }) {
        match std::fs::read(file) {
            Ok(bytes) => references.push_str(&String::from_utf8_lossy(&bytes)),
            Err(_) => return,
        }
    }
    for assets in stored.iter().filter(|path| path.is_dir()) {
        remove_unreferenced_frames(assets, &references);
    }
}

// A waveform recorded as empty could not be decoded then (a slow disk, a
// timeout); opening the project lets the background work try once more.
fn retry_failed_waveforms(p: &mut Value) {
    for item in p["media"].as_array_mut().into_iter().flatten() {
        if item["waveform"].as_array().is_some_and(Vec::is_empty) {
            item.as_object_mut().unwrap().remove("waveform");
        }
    }
}

// Points LUT and still-frame paths inside one project's asset folder at another's.
fn move_assets(p: &mut Value, from: &Path, to: &Path) {
    for item in p["media"].as_array_mut().into_iter().flatten() {
        if let Some(rest) = item["path"]
            .as_str()
            .and_then(|s| Path::new(s).strip_prefix(from).ok())
        {
            item["path"] = json!(to.join(rest));
        }
    }
    for clip in p["clips"].as_array_mut().into_iter().flatten() {
        if let Some(path) = clip.pointer_mut("/color/lut/path") {
            if let Some(rest) = path
                .as_str()
                .and_then(|s| Path::new(s).strip_prefix(from).ok())
            {
                *path = json!(to.join(rest));
            }
        }
    }
}

// The same project apart from what is recomputed from disk for each media item.
fn same_content(a: &Value, b: &Value) -> bool {
    let strip = |p: &Value| {
        let mut p = p.clone();
        for item in p["media"].as_array_mut().into_iter().flatten() {
            if let Some(item) = item.as_object_mut() {
                for derived in ["missing", "proxy", "waveform"] {
                    item.remove(derived);
                }
            }
        }
        // Opening a project bumps these without changing its content.
        for stamp in ["revision", "updatedAt"] {
            p[stamp] = Value::Null;
        }
        p
    };
    strip(a) == strip(b)
}

/// Upgrades a stored project in place to the current schema. Files written
/// before schemaVersion existed are version 1.
pub fn migrate_project(p: &mut Value) -> Result<(), String> {
    if !p.is_object() {
        return Err("프로젝트 파일 형식이 올바르지 않습니다.".into());
    }
    let version = match p.get("schemaVersion") {
        None => 1,
        Some(v) => v
            .as_u64()
            .filter(|v| *v >= 1)
            .ok_or("프로젝트 버전 정보가 올바르지 않습니다.")?,
    };
    if version > SCHEMA_VERSION {
        return Err("더 새로운 버전의 Byori Studio에서 만든 프로젝트입니다. 앱을 업데이트한 뒤 열어 주세요.".into());
    }
    if version < 2 {
        migrate_v1(p);
    }
    p["schemaVersion"] = json!(SCHEMA_VERSION);
    Ok(())
}

// Older UI builds sent their own filter ids; map them to the built-in ones.
// `original`, `vivid` and `soft` carried their look in the colour values only.
pub(crate) fn legacy_filter(filter: &Value) -> &'static str {
    match filter.as_str().unwrap_or("") {
        "cinema" => "cinematic",
        id => FILTERS
            .iter()
            .find(|f| **f == id)
            .copied()
            .unwrap_or("none"),
    }
}

// Cuts a display name to the size short_text accepts, on a character boundary.
fn shorten(name: &mut Value) {
    if let Some(text) = name.as_str().filter(|s| s.len() > 1000) {
        let mut end = 1000;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        *name = json!(text[..end]);
    }
}

// v1 files were never checked for filter ids, transitions, markers or notes, and
// older builds omitted some clip defaults. Repair what has an obvious meaning.
fn migrate_v1(p: &mut Value) {
    for key in ["markers", "notes"] {
        if !p[key].is_array() {
            p[key] = json!([]);
        }
    }
    if !p["concept"].is_object() {
        p["concept"] = json!({"audience":"","message":"","appeal":"","direction":""});
    }
    let markers = p["markers"].as_array_mut().unwrap();
    markers.retain(|m| {
        m.is_object()
            && m["time"]
                .as_f64()
                .is_some_and(|t| (0.0..=86400.0).contains(&t))
    });
    for marker in markers {
        if marker["id"].as_str().is_none_or(|id| id.is_empty()) {
            marker["id"] = json!(media::id("marker"));
        }
        if !marker["label"].is_string() {
            marker["label"] = json!("마커");
        }
        shorten(&mut marker["label"]);
    }
    p["notes"]
        .as_array_mut()
        .unwrap()
        .retain(|note| note["body"].is_string());
    for track in p["tracks"].as_array_mut().into_iter().flatten() {
        if !track.is_object() {
            continue;
        }
        for flag in ["muted", "hidden", "locked"] {
            if !track[flag].is_boolean() {
                track[flag] = json!(false);
            }
        }
        if !track["name"].is_string() {
            track["name"] = track["kind"].clone();
        }
        shorten(&mut track["name"]);
    }
    for clip in p["clips"].as_array_mut().into_iter().flatten() {
        if !clip.is_object() {
            continue;
        }
        let defaults = default_clip("", "클립", "", 0.0, 0.0);
        for field in ["sourceIn", "speed", "volume", "fadeIn", "fadeOut"] {
            if !clip[field].is_number() {
                clip[field] = defaults[field].clone();
            }
        }
        if !clip["reverse"].is_boolean() {
            clip["reverse"] = json!(false);
        }
        if !clip["name"].is_string() {
            clip["name"] = defaults["name"].clone();
        }
        shorten(&mut clip["name"]);
        if !clip["keyframes"].is_array() {
            clip["keyframes"] = json!([]);
        }
        for group in ["transform", "color"] {
            if !clip[group].is_object() {
                clip[group] = json!({});
            }
            for (key, value) in defaults[group].as_object().unwrap() {
                if !clip[group][key].is_number() {
                    clip[group][key] = value.clone();
                }
            }
        }
        // The UI used to store its own filter ids next to the colour values.
        if let Some(filter) = clip.get_mut("filter") {
            *filter = json!(legacy_filter(filter));
        }
        for transition in ["transitionIn", "transitionOut"] {
            if clip.get(transition).is_some() && clip[transition]["type"] != "fade" {
                clip[transition] = Value::Null;
            }
        }
        fit_clip_fades(clip);
    }
}

impl Editor {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(root.join("projects")).map_err(|e| e.to_string())?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let current = root.join("current.json");
        let mut notice = None;
        let project = match load_project(&current) {
            Ok(project) => project,
            Err(_) if std::fs::symlink_metadata(&current).is_err() => {
                empty_project("새 프로젝트", 1920, 1080, 30.0)
            }
            Err(error) => {
                // Never start from, or silently discard, an unreadable autosave.
                let kept = format!("current.json.corrupt-{}", media::now());
                let kept = match std::fs::rename(&current, root.join(&kept)) {
                    Ok(()) => format!("읽지 못한 파일은 {kept}(으)로 보관했습니다."),
                    Err(e) => format!("읽지 못한 파일을 보관하지 못했습니다: {e}"),
                };
                let recovered = recent_valid_project(&root);
                notice = Some(match &recovered {
                    Some(p) => format!(
                        "저장된 작업을 읽지 못해 가장 최근 프로젝트 '{}'(으)로 복구했습니다. {kept} ({error})",
                        string(p, "name", "")
                    ),
                    None => format!(
                        "저장된 작업을 읽지 못해 새 프로젝트로 시작했습니다. {kept} ({error})"
                    ),
                });
                recovered.unwrap_or_else(|| empty_project("새 프로젝트", 1920, 1080, 30.0))
            }
        };
        let mut project = project;
        retry_failed_waveforms(&mut project);
        let mut editor = Self {
            root,
            project,
            undo: vec![],
            redo: vec![],
            jobs: render::RenderJobs::default(),
            preview_assets: HashMap::new(),
            notice,
            file_path: None,
            waveforms: HashMap::new(),
            derived_changed: false,
        };
        editor.persist()?;
        remove_orphaned_frames(&editor.root);
        editor.refresh_missing();
        Ok(editor)
    }

    /// Flags media whose source file is gone and media that have a proxy file.
    /// Derived state: no revision change.
    fn refresh_missing(&mut self) -> bool {
        let mut changed = false;
        for item in self.project["media"].as_array_mut().into_iter().flatten() {
            let missing = !Path::new(string(item, "path", "")).is_file();
            let id = string(item, "id", "");
            // The service notes beside a proxy which file it shows; after a relink
            // the old proxy does not count until it has been rebuilt. Without the
            // note it does not count either: the service deletes such a proxy.
            let proxy_file = media::proxy_path(&self.root, id);
            let proxy =
                safe_project_id(id) && media::proxy_is_of(&proxy_file, string(item, "path", ""));
            let Some(object) = item.as_object_mut() else {
                continue;
            };
            for (flag, on) in [("missing", missing), ("proxy", proxy)] {
                if on != (object.get(flag) == Some(&json!(true))) {
                    changed = true;
                }
                if on {
                    object.insert(flag.into(), json!(true));
                } else {
                    object.remove(flag);
                }
            }
        }
        self.derived_changed |= changed;
        changed
    }

    /// Where the proxy of a media item of the open project lives, whether or not
    /// it has been made yet. Write it under another name and rename it into place.
    pub fn proxy_path(&self, media_id: &str) -> Option<PathBuf> {
        let known = self.project["media"]
            .as_array()?
            .iter()
            .any(|m| m["id"] == media_id);
        (known && safe_project_id(media_id)).then(|| media::proxy_path(&self.root, media_id))
    }

    /// Media with sound whose waveform has not been computed: (id, path, duration).
    /// Compute it outside the editor lock and hand it to `set_waveform`.
    pub fn pending_waveforms(&self) -> Vec<(String, PathBuf, f64)> {
        self.project["media"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|m| m["hasAudio"] == true && !m["waveform"].is_array() && m["missing"] != true)
            .map(|m| {
                (
                    string(m, "id", "").to_owned(),
                    PathBuf::from(string(m, "path", "")),
                    number(m, "duration", 0.0),
                )
            })
            .collect()
    }

    /// Fills in a waveform computed in the background: no revision, no undo entry.
    /// `None` (nothing could be decoded) is recorded as empty so it is not retried.
    /// Returns false when that media item is gone or now points at another file.
    pub fn set_waveform(
        &mut self,
        media_id: &str,
        path: &Path,
        waveform: impl Into<Option<Vec<f32>>>,
    ) -> Result<bool, String> {
        let waveform = waveform.into().unwrap_or_default();
        let Some(item) = self.project["media"]
            .as_array_mut()
            .into_iter()
            .flatten()
            .find(|m| m["id"] == media_id && Path::new(string(m, "path", "")) == path)
        else {
            return Ok(false);
        };
        let previous = std::mem::replace(&mut item["waveform"], json!(waveform));
        if let Err(error) = self.persist() {
            let item = self.project["media"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|m| m["id"] == media_id)
                .unwrap();
            if previous.is_null() {
                item.as_object_mut().unwrap().remove("waveform");
            } else {
                item["waveform"] = previous;
            }
            return Err(error);
        }
        // History snapshots take their waveforms from here when they are restored.
        self.waveforms
            .insert(path.to_string_lossy().into_owned(), json!(waveform));
        self.derived_changed = true;
        Ok(true)
    }

    // Undo/redo snapshots would otherwise each hold a copy of every waveform.
    fn without_waveforms(&mut self, mut snapshot: Value) -> Value {
        for item in snapshot["media"].as_array_mut().into_iter().flatten() {
            let path = string(item, "path", "").to_owned();
            if let Some(waveform) = item.as_object_mut().and_then(|m| m.remove("waveform")) {
                self.waveforms.insert(path, waveform);
            }
        }
        snapshot
    }

    fn with_waveforms(&self, mut snapshot: Value) -> Value {
        for item in snapshot["media"].as_array_mut().into_iter().flatten() {
            if let Some(waveform) = self.waveforms.get(string(item, "path", "")) {
                item["waveform"] = waveform.clone();
            }
        }
        snapshot
    }

    fn project_file(&self, id: &str) -> PathBuf {
        self.root.join("projects").join(format!("{id}.json"))
    }

    fn assets_dir(&self, id: &str) -> PathBuf {
        self.root.join("projects").join(format!("{id}-assets"))
    }

    fn stored_project(&self, params: &Value) -> Result<(String, Value), String> {
        let id = string(params, "id", "");
        if !safe_project_id(id) {
            return Err("프로젝트를 선택해 주세요.".into());
        }
        if self.project["id"] == id {
            return Ok((id.to_owned(), self.project.clone()));
        }
        let bytes = std::fs::read(self.project_file(id))
            .map_err(|_| "프로젝트를 찾을 수 없습니다.".to_string())?;
        let mut project: Value = serde_json::from_slice(&bytes)
            .map_err(|e| format!("프로젝트 파일을 읽을 수 없습니다: {e}"))?;
        migrate_project(&mut project)?;
        Ok((id.to_owned(), project))
    }

    fn list_projects(&self) -> Result<Value, String> {
        let mut list = vec![];
        for entry in std::fs::read_dir(self.root.join("projects"))
            .map_err(|e| e.to_string())?
            .flatten()
        {
            if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            if let Ok(bytes) = std::fs::read(entry.path()) {
                if let Ok(p) = serde_json::from_slice::<Value>(&bytes) {
                    let mut item =
                        json!({"id":p["id"],"name":p["name"],"updatedAt":p["updatedAt"]});
                    if let Some((media_id, path)) = self.cover(&p) {
                        item["thumbnail"] = json!({"mediaId":media_id,"path":path});
                    }
                    // Nothing in it yet: the home screen leaves out the unnamed ones.
                    let none = |key: &str| p[key].as_array().is_none_or(|list| list.is_empty());
                    if none("clips") && none("media") {
                        item["empty"] = json!(true);
                    }
                    list.push(item);
                }
            }
        }
        list.sort_by_key(|p| std::cmp::Reverse(p["updatedAt"].as_u64().unwrap_or(0)));
        Ok(json!(list))
    }

    /// A thumbnail this app made: only files in the store's thumbnail folder are
    /// offered for a project that is not open.
    fn stored_thumbnail(&self, item: &Value) -> Option<PathBuf> {
        let path = PathBuf::from(item["thumbnail"].as_str()?);
        let ours = path.starts_with(self.root.join("thumbnails"))
            && !path
                .components()
                .any(|part| part == std::path::Component::ParentDir);
        (ours && path.is_file()).then_some(path)
    }

    /// The picture that stands for a project: the earliest video or image clip whose
    /// media already has a thumbnail. Nothing is generated here.
    fn cover(&self, p: &Value) -> Option<(String, PathBuf)> {
        let mut clips: Vec<&Value> = p["clips"]
            .as_array()?
            .iter()
            .filter(|c| matches!(string(c, "kind", ""), "video" | "image"))
            .collect();
        clips.sort_by(|a, b| number(a, "start", 0.0).total_cmp(&number(b, "start", 0.0)));
        let media = p["media"].as_array()?;
        clips.iter().find_map(|clip| {
            let item = media.iter().find(|m| m["id"] == clip["mediaId"])?;
            Some((
                item["id"].as_str()?.to_owned(),
                self.stored_thumbnail(item)?,
            ))
        })
    }

    /// The thumbnail of a media item of any stored project, open or not, so a
    /// project list can show the covers `project.list` names.
    pub fn project_thumbnail(&self, project_id: &str, media_id: &str) -> Option<PathBuf> {
        if !safe_project_id(project_id) {
            return None;
        }
        let stored;
        let project = if self.project["id"] == project_id {
            &self.project
        } else {
            stored = serde_json::from_slice::<Value>(
                &std::fs::read(self.project_file(project_id)).ok()?,
            )
            .ok()?;
            &stored
        };
        let item = project["media"]
            .as_array()?
            .iter()
            .find(|m| m["id"] == media_id)?;
        self.stored_thumbnail(item)
    }

    /// App state lives in the store; its `exports` folder is ordinary output space
    /// (it is where agents are told to write).
    fn in_store(&self, path: &Path) -> bool {
        // The target and some of its folders may not exist yet.
        let path = path
            .ancestors()
            .find_map(|base| {
                let resolved = base.canonicalize().ok()?;
                Some(resolved.join(path.strip_prefix(base).ok()?))
            })
            .unwrap_or_else(|| path.to_path_buf());
        path.starts_with(&self.root) && !path.starts_with(self.root.join("exports"))
    }

    /// Files written on request must never replace app state or source assets.
    fn guard_output(&self, path: &Path, params: &Value, known: bool) -> Result<(), String> {
        if self.in_store(path) {
            return Err("앱 저장소 안에는 저장할 수 없습니다. 다른 위치를 선택해 주세요.".into());
        }
        let media = self.project["media"].as_array().into_iter().flatten();
        let clips = self.project["clips"].as_array().into_iter().flatten();
        let mut sources = media.filter_map(|m| m["path"].as_str()).chain(
            clips
                .flat_map(|c| {
                    [
                        c["text"]["fontPath"].as_str(),
                        c["color"]["lut"]["path"].as_str(),
                    ]
                })
                .flatten(),
        );
        if sources.any(|source| media::same_path(Path::new(source), path)) {
            return Err("원본 미디어·글꼴·LUT 파일은 덮어쓸 수 없습니다.".into());
        }
        if !known && params["overwrite"] != true && std::fs::symlink_metadata(path).is_ok() {
            return Err(
                "같은 이름의 파일이 이미 있습니다. 덮어쓰려면 확인이 필요합니다. (FILE_EXISTS)"
                    .into(),
            );
        }
        Ok(())
    }

    pub fn asset_path(&self, id: &str, thumbnail: bool) -> Option<PathBuf> {
        if !thumbnail {
            if let Some(path) = catalog::font_asset_path(&self.root, id) {
                return Some(path);
            }
        }
        if let Some(path) = self.preview_assets.get(id) {
            return path.is_file().then(|| path.clone());
        }
        self.project["media"]
            .as_array()?
            .iter()
            .find(|m| m["id"] == id)?
            .get(if thumbnail { "thumbnail" } else { "path" })?
            .as_str()
            .map(PathBuf::from)
            .filter(|p| p.is_file())
    }

    pub fn preview_snapshot(
        &self,
        params: &Value,
        project_id: Option<&str>,
    ) -> Result<(Value, PathBuf), String> {
        self.expected(params)?;
        if project_id.is_some_and(|id| self.project["id"].as_str() != Some(id)) {
            return Err("미리보기 중 프로젝트가 변경되었습니다. (PREVIEW_STALE)".into());
        }
        Ok((self.project.clone(), self.root.clone()))
    }

    /// Files the editor is serving as preview assets (frames and precise-playback
    /// videos); the storage cleaner leaves them alone.
    pub fn preview_asset_paths(&self) -> Vec<PathBuf> {
        self.preview_assets.values().cloned().collect()
    }

    pub fn register_preview_asset(&mut self, id: String, path: PathBuf) {
        self.preview_assets.insert(id, path);
    }

    pub fn forget_preview_asset(&mut self, id: &str) {
        self.preview_assets.remove(id);
    }

    fn persist(&self) -> Result<(), String> {
        let id = string(&self.project, "id", "");
        if !safe_project_id(id) {
            return Err("프로젝트 ID가 올바르지 않습니다.".into());
        }
        media::atomic_json(
            &self.root.join("projects").join(format!("{id}.json")),
            &self.project,
        )?;
        media::atomic_json(&self.root.join("current.json"), &self.project)
    }

    fn expected(&self, params: &Value) -> Result<(), String> {
        if params.get("expectedRevision").is_some() && params["expectedRevision"].as_u64().is_none()
        {
            return Err("expectedRevision 값은 0 이상의 정수여야 합니다.".into());
        }
        if let Some(expected) = params.get("expectedRevision").and_then(Value::as_u64) {
            if self.project["revision"].as_u64() != Some(expected) {
                return Err("프로젝트가 다른 작업에 의해 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도해 주세요. (REVISION_CONFLICT)".into());
            }
        }
        Ok(())
    }

    fn commit(&mut self, mut next: Value) -> Result<Value, String> {
        validate_project(&next)?;
        next["revision"] = json!(self.project["revision"].as_u64().unwrap_or(0) + 1);
        next["updatedAt"] = json!(media::now());
        let before = std::mem::replace(&mut self.project, next);
        if let Err(error) = self.persist() {
            self.project = before;
            return Err(error);
        }
        let before = self.without_waveforms(before);
        // A waveform this edit dropped (reprobe, relink) is stale: history must not
        // bring it back for that file.
        for item in self.project["media"].as_array().into_iter().flatten() {
            if !item["waveform"].is_array() {
                self.waveforms.remove(string(item, "path", ""));
            }
        }
        self.undo.push(before);
        if self.undo.len() > 100 {
            self.undo.remove(0);
        }
        self.redo.clear();
        self.refresh_missing();
        Ok(self.project.clone())
    }

    fn replace(&mut self, mut project: Value) -> Result<Value, String> {
        validate_project(&project)?;
        retry_failed_waveforms(&mut project);
        project["revision"] = json!(self.project["revision"].as_u64().unwrap_or(0) + 1);
        project["updatedAt"] = json!(media::now());
        let before = std::mem::replace(&mut self.project, project);
        if let Err(e) = self.persist() {
            self.project = before;
            return Err(e);
        }
        self.undo.clear();
        self.redo.clear();
        self.waveforms.clear();
        self.file_path = None;
        self.derived_changed = false;
        self.refresh_missing();
        Ok(self.project.clone())
    }

    pub async fn dispatch(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.expected(&params)?;
        match method {
            "project.get" => {
                self.refresh_missing();
                // Only a polling client's read counts as having seen derived changes.
                let conditional = params.get("ifRevision").is_some();
                if !self.derived_changed
                    && params["ifProjectId"].as_str() == self.project["id"].as_str()
                    && conditional
                    && params["ifRevision"].as_u64() == self.project["revision"].as_u64()
                {
                    let flagged = |flag: &str| -> Vec<&Value> {
                        self.project["media"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .filter(|m| m[flag] == true)
                            .map(|m| &m["id"])
                            .collect()
                    };
                    let mut reply = json!({"unchanged":true,"id":self.project["id"],"revision":self.project["revision"],"missing":flagged("missing")});
                    let proxy = flagged("proxy");
                    if !proxy.is_empty() {
                        reply["proxy"] = json!(proxy);
                    }
                    return Ok(reply);
                }
                if conditional {
                    self.derived_changed = false;
                }
                Ok(self.project.clone())
            }
            "project.list" => self.list_projects(),
            "project.notice" => Ok(json!({"notice":self.notice})),
            "project.noticeDismiss" => {
                self.notice = None;
                Ok(json!({"notice":null}))
            }
            "project.delete" => {
                let id = string(&params, "id", "");
                if !safe_project_id(id) {
                    return Err("프로젝트를 선택해 주세요.".into());
                }
                if self.project["id"] == id {
                    return Err("열려 있는 프로젝트는 삭제할 수 없습니다. 다른 프로젝트를 연 뒤 삭제해 주세요.".into());
                }
                std::fs::remove_file(self.project_file(id))
                    .map_err(|_| "프로젝트를 찾을 수 없습니다.".to_string())?;
                let _ = std::fs::remove_dir_all(self.assets_dir(id));
                self.list_projects()
            }
            "project.duplicate" => {
                let (id, mut p) = self.stored_project(&params)?;
                let new_id = media::id("project");
                p["id"] = json!(new_id);
                p["name"] = json!(format!("{} 사본", string(&p, "name", "프로젝트")));
                p["revision"] = json!(0);
                p["updatedAt"] = json!(media::now());
                let (from, to) = (self.assets_dir(&id), self.assets_dir(&new_id));
                move_assets(&mut p, &from, &to);
                validate_project(&p)?;
                if from.is_dir() {
                    copy_dir(&from, &to)?;
                    remove_unreferenced_frames(&to, &p.to_string());
                }
                media::atomic_json(&self.project_file(&new_id), &p)?;
                Ok(json!({"id":p["id"],"name":p["name"],"updatedAt":p["updatedAt"]}))
            }
            "project.rename" => {
                let (id, mut p) = self.stored_project(&params)?;
                p["name"] = json!(required(&params, "name")?.trim());
                if self.project["id"] == id.as_str() {
                    self.commit(p)?;
                } else {
                    validate_project(&p)?;
                    media::atomic_json(&self.project_file(&id), &p)?;
                }
                self.list_projects()
            }
            "project.new" => {
                let p = empty_project(
                    string(&params, "name", "새 프로젝트"),
                    params["width"].as_u64().unwrap_or(1920),
                    params["height"].as_u64().unwrap_or(1080),
                    number(&params, "fps", 30.0),
                );
                self.replace(p)
            }
            "project.open" => {
                let path = if let Some(path) = params["path"].as_str() {
                    PathBuf::from(path)
                } else {
                    let id = string(&params, "id", "");
                    if !safe_project_id(id) {
                        return Err("프로젝트를 선택해 주세요.".into());
                    }
                    self.project_file(id)
                };
                let mut p: Value = serde_json::from_slice(
                    &std::fs::read(&path).map_err(|e| format!("프로젝트 열기 실패: {e}"))?,
                )
                .map_err(|e| format!("프로젝트 파일을 읽을 수 없습니다: {e}"))?;
                migrate_project(&mut p)?;
                // Portable project files may keep paths relative to themselves.
                if let Some(items) = p["media"].as_array_mut() {
                    for item in items {
                        for field in ["path", "thumbnail"] {
                            if let Some(s) = item[field].as_str() {
                                let asset = PathBuf::from(s);
                                if asset.is_relative() {
                                    item[field] =
                                        json!(path.parent().unwrap_or(Path::new(".")).join(asset));
                                }
                            }
                        }
                    }
                }
                if let Some(clips) = p["clips"].as_array_mut() {
                    for clip in clips {
                        for pointer in ["/text/fontPath", "/color/lut/path"] {
                            if let Some(value) = clip.pointer_mut(pointer) {
                                if let Some(relative) = value
                                    .as_str()
                                    .map(PathBuf::from)
                                    .filter(|p| p.is_relative())
                                {
                                    *value = json!(path
                                        .parent()
                                        .unwrap_or(Path::new("."))
                                        .join(relative));
                                }
                            }
                        }
                    }
                }
                // A file from elsewhere must not replace a different stored project
                // that happens to have the same id (a copy, or an older export).
                if params["path"].is_string() && !self.in_store(&path) {
                    let id = string(&p, "id", "").to_owned();
                    let stored = if self.project["id"] == id.as_str() {
                        Some(self.project.clone())
                    } else if safe_project_id(&id) {
                        std::fs::read(self.project_file(&id))
                            .ok()
                            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                            .map(|mut stored| {
                                let _ = migrate_project(&mut stored);
                                stored
                            })
                    } else {
                        None
                    };
                    if stored.is_some_and(|stored| !same_content(&stored, &p)) {
                        let new_id = media::id("project");
                        let (from, to) = (self.assets_dir(&id), self.assets_dir(&new_id));
                        move_assets(&mut p, &from, &to);
                        validate_project(&p)?;
                        if from.is_dir() {
                            copy_dir(&from, &to)?;
                            remove_unreferenced_frames(&to, &p.to_string());
                        }
                        p["id"] = json!(new_id);
                    }
                }
                let opened = self.replace(p)?;
                if params["path"].is_string() && !self.in_store(&path) {
                    self.file_path = Some(path);
                }
                Ok(opened)
            }
            "project.save" => {
                self.persist()?;
                let explicit = params["path"].as_str().map(PathBuf::from);
                let Some(path) = explicit.or_else(|| self.file_path.clone()) else {
                    let path = self.project_file(string(&self.project, "id", ""));
                    return Ok(json!({"path":path,"project":self.project}));
                };
                // The file this project was opened from or last saved to is ours to update.
                let known = self.file_path.as_deref() == Some(path.as_path());
                self.guard_output(&path, &params, known)?;
                media::atomic_json(&path, &self.project)?;
                self.file_path = Some(path.clone());
                Ok(json!({"path":path,"project":self.project}))
            }
            "project.update" => {
                let patch = params["patch"]
                    .as_object()
                    .ok_or("프로젝트 변경 내용이 없습니다.")?;
                let mut p = self.project.clone();
                for (key, value) in patch {
                    if ![
                        "name",
                        "width",
                        "height",
                        "fps",
                        "background",
                        "concept",
                        "notes",
                        "markers",
                    ]
                    .contains(&key.as_str())
                    {
                        return Err(format!("프로젝트 속성을 변경할 수 없습니다: {key}"));
                    }
                    merge(&mut p[key], value);
                }
                self.commit(p)
            }
            "project.demo" => self.demo().await,
            "assets.list" => catalog::list(&self.root),
            "fonts.import" => catalog::import_font(
                &self.root,
                Path::new(required(&params, "path")?),
                params["name"].as_str(),
            ),
            "fonts.remove" => catalog::remove(&self.root, "fonts", required(&params, "id")?),
            "fonts.apply" => {
                let font = catalog::find(&self.root, "fonts", required(&params, "id")?)?;
                let id = required(&params, "clipId")?;
                let clip = self.project["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["id"] == id)
                    .ok_or("텍스트 클립을 선택해 주세요.")?;
                if clip["kind"] != "text" {
                    return Err("글꼴은 텍스트 클립에 적용할 수 있습니다.".into());
                }
                if catalog::font_asset_path(&self.root, required(&font, "id")?).is_none() {
                    return Err("추가한 글꼴 파일이 없습니다. 다시 가져와 주세요.".into());
                }
                let mut p = self.project.clone();
                mutate(
                    &mut p,
                    "edit.update",
                    &json!({"id":id,"patch":{"text":{"fontId":font["id"],"fontPath":font["path"],"fontFamily":font["family"]}}}),
                )?;
                self.commit(p)
            }
            "presets.save" => {
                let clip = self.project["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["id"] == params["clipId"])
                    .ok_or("프리셋으로 저장할 클립을 선택해 주세요.")?;
                catalog::save_preset(
                    &self.root,
                    clip,
                    required(&params, "name")?,
                    required(&params, "kind")?,
                )
                .await
            }
            "presets.import" => {
                catalog::import_preset(&self.root, Path::new(required(&params, "path")?)).await
            }
            "presets.remove" => catalog::remove(&self.root, "presets", required(&params, "id")?),
            "presets.export" => {
                let path = Path::new(required(&params, "path")?);
                if self.project["media"].as_array().unwrap().iter().any(|m| {
                    m["path"]
                        .as_str()
                        .is_some_and(|p| media::same_path(Path::new(p), path))
                }) || media::same_path(&self.root.join("current.json"), path)
                    || media::same_path(
                        &self
                            .root
                            .join("projects")
                            .join(format!("{}.json", string(&self.project, "id", ""))),
                        path,
                    )
                    || media::same_path(&self.root.join("catalog/index.json"), path)
                {
                    return Err("프로젝트·목록·원본 파일을 프리셋으로 덮어쓸 수 없습니다.".into());
                }
                // Agents always send overwrite:false; the UI picks the path in a save dialog.
                if params["overwrite"] == false && std::fs::symlink_metadata(path).is_ok() {
                    return Err("같은 이름의 파일이 이미 있습니다. (FILE_EXISTS)".into());
                }
                catalog::export_preset(&self.root, required(&params, "id")?, path)
            }
            "presets.apply" => {
                let preset = catalog::find(&self.root, "presets", required(&params, "id")?)?;
                let id = required(&params, "clipId")?;
                let clip = self.project["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["id"] == id)
                    .ok_or("프리셋을 적용할 클립을 선택해 주세요.")?;
                validate_preset(&preset)?;
                if (clip["kind"] == "audio") != (preset["target"] == "audio") {
                    return Err("프리셋과 클립 종류가 맞지 않습니다. 영상용 또는 오디오용 프리셋을 선택해 주세요.".into());
                }
                let mut patch = preset_patch(&preset);
                let ratio = number(clip, "duration", 1.0) / number(&preset, "sourceDuration", 1.0);
                if let Some(frames) = patch.get_mut("keyframes").and_then(Value::as_array_mut) {
                    for frame in frames {
                        frame["time"] = json!(number(frame, "time", 0.0) * ratio);
                    }
                }
                for field in ["fadeIn", "fadeOut"] {
                    if let Some(value) = patch[field].as_f64() {
                        patch[field] = json!(value * ratio);
                    }
                }
                for field in ["transitionIn", "transitionOut"] {
                    if let Some(transition) = patch.get_mut(field).filter(|v| v.is_object()) {
                        transition["duration"] = json!(number(transition, "duration", 0.0) * ratio);
                    }
                }
                let mut p = self.project.clone();
                mutate(&mut p, "edit.update", &json!({"id":id,"patch":patch}))?;
                self.commit(p)
            }
            "color.importLut" => {
                let id = required(&params, "id")?;
                let index = self.project["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .position(|c| c["id"] == id)
                    .ok_or("클립을 선택해 주세요.")?;
                ensure_unlocked(
                    &self.project,
                    string(&self.project["clips"][index], "trackId", ""),
                )?;
                if self.project["clips"][index]["kind"] == "audio" {
                    return Err("LUT는 영상·이미지·텍스트 클립에 적용할 수 있습니다.".into());
                }
                let directory = self
                    .root
                    .join("projects")
                    .join(format!("{}-assets", string(&self.project, "id", "")))
                    .join("luts");
                let lut =
                    media::import_lut(Path::new(required(&params, "path")?), &directory).await?;
                let mut p = self.project.clone();
                p["clips"][index]["color"]["lut"] = lut;
                self.commit(p)
            }
            "media.import" | "media.importAndAdd" => {
                let paths = params["paths"]
                    .as_array()
                    .ok_or("가져올 파일이 없습니다.")?;
                if paths.is_empty() || paths.len() > 100 {
                    return Err("한 번에 1~100개 파일을 가져올 수 있습니다.".into());
                }
                let mut p = self.project.clone();
                let mut insertion = params.get("start").and_then(Value::as_f64);
                for path in paths {
                    let path = Path::new(path.as_str().ok_or("파일 경로가 올바르지 않습니다.")?);
                    let mut asset = media::probe_info(path, &self.root).await?;
                    if let Some(name) = uploaded_name(path, &self.root) {
                        asset["name"] = json!(name);
                    }
                    let existing = p["media"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|m| {
                            media::same_path(
                                Path::new(string(m, "path", "")),
                                Path::new(string(&asset, "path", "")),
                            )
                        })
                        .cloned();
                    let item = if let Some(existing) = existing {
                        refresh_media_metadata(&mut p, required(&existing, "id")?, asset)?
                    } else {
                        p["media"].as_array_mut().unwrap().push(asset.clone());
                        asset
                    };
                    if method == "media.importAndAdd" {
                        let mut args = json!({"mediaId":item["id"]});
                        if let Some(start) = insertion {
                            args["start"] = json!(start);
                        }
                        if let Some(track) = params.get("trackId") {
                            args["trackId"] = track.clone();
                        }
                        if let Some(duration) = params.get("duration") {
                            args["duration"] = duration.clone();
                        }
                        mutate(&mut p, "edit.add", &args)?;
                        let added = p["clips"].as_array().unwrap().last().unwrap();
                        insertion =
                            Some(number(added, "start", 0.0) + number(added, "duration", 0.0));
                    }
                }
                self.commit(p)
            }
            "media.reprobe" => {
                let ids = params["ids"]
                    .as_array()
                    .ok_or("다시 확인할 소재 ID 목록이 필요합니다.")?;
                if ids.is_empty()
                    || ids.len() > 100
                    || ids.iter().any(|id| id.as_str().is_none())
                    || ids.iter().collect::<HashSet<_>>().len() != ids.len()
                {
                    return Err("중복되지 않는 소재 ID 1~100개가 필요합니다.".into());
                }
                let assets: Vec<Value> = ids
                    .iter()
                    .map(|id| {
                        self.project["media"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|asset| asset["id"] == *id)
                            .cloned()
                            .ok_or_else(|| "소재를 찾을 수 없습니다.".to_string())
                    })
                    .collect::<Result<_, _>>()?;
                let mut p = self.project.clone();
                for asset in assets {
                    let refreshed =
                        media::probe_info(Path::new(required(&asset, "path")?), &self.root).await?;
                    let id = required(&asset, "id")?;
                    refresh_media_metadata(&mut p, id, refreshed)?;
                    // The file may have changed in place: compute its waveform again.
                    drop_waveform(&mut p, id);
                }
                self.commit(p)
            }
            "media.relink" => {
                let id = required(&params, "id")?;
                let asset =
                    media::probe_info(Path::new(required(&params, "path")?), &self.root).await?;
                let mut p = self.project.clone();
                if p["media"].as_array().unwrap().iter().any(|m| {
                    m["id"] != id
                        && media::same_path(
                            Path::new(string(m, "path", "")),
                            Path::new(string(&asset, "path", "")),
                        )
                }) {
                    return Err("이미 프로젝트에 있는 소재 파일입니다.".into());
                }
                // Only media.reprobe may turn a mislabelled video into audio.
                if p["media"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["id"] == id && m["kind"] != asset["kind"])
                {
                    return Err("소재 종류가 다릅니다. 같은 종류의 파일을 선택해 주세요.".into());
                }
                let path = asset["path"].clone();
                refresh_media_metadata(&mut p, id, asset)?;
                let item = p["media"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|m| m["id"] == id)
                    .unwrap();
                item["path"] = path;
                item.as_object_mut().unwrap().remove("missing");
                // Also for the same path: the file there may have been replaced.
                drop_waveform(&mut p, id);
                self.commit(p)
            }
            "media.remove" => {
                let id = required(&params, "id")?;
                if self.project["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|c| c["mediaId"] == id)
                {
                    return Err(
                        "타임라인에서 사용 중인 소재입니다. 클립을 먼저 삭제해 주세요.".into(),
                    );
                }
                let mut p = self.project.clone();
                let media = p["media"].as_array_mut().unwrap();
                if !media.iter().any(|m| m["id"] == id) {
                    return Err("소재를 찾을 수 없습니다.".into());
                }
                media.retain(|m| m["id"] != id);
                self.commit(p)
            }
            "history.status" => {
                Ok(json!({"canUndo":!self.undo.is_empty(),"canRedo":!self.redo.is_empty()}))
            }
            "history.undo" | "history.redo" => {
                let is_undo = method == "history.undo";
                let old = if is_undo {
                    self.undo.pop()
                } else {
                    self.redo.pop()
                };
                let original = old.ok_or(if is_undo {
                    "실행 취소할 작업이 없습니다."
                } else {
                    "다시 실행할 작업이 없습니다."
                })?;
                let mut next = self.with_waveforms(original.clone());
                next["revision"] = json!(self.project["revision"].as_u64().unwrap_or(0) + 1);
                next["updatedAt"] = json!(media::now());
                let before = std::mem::replace(&mut self.project, next);
                if let Err(e) = self.persist() {
                    self.project = before;
                    if is_undo {
                        self.undo.push(original)
                    } else {
                        self.redo.push(original)
                    };
                    return Err(e);
                }
                let before = self.without_waveforms(before);
                if is_undo {
                    self.redo.push(before)
                } else {
                    self.undo.push(before)
                };
                self.refresh_missing();
                Ok(self.project.clone())
            }
            "edit.freeze" => {
                let id = required(&params, "id")?;
                let time = params["time"]
                    .as_f64()
                    .ok_or("정지 프레임 위치가 필요합니다.")?;
                let fps = number(&self.project, "fps", 30.0);
                let hold = match params.get("duration") {
                    None => 2.0,
                    Some(value) => value
                        .as_f64()
                        .filter(|d| (1.0 / fps..=3600.0).contains(d))
                        .ok_or("정지 프레임 길이는 1프레임 이상 1시간 이하여야 합니다.")?,
                };
                let hold = snap_length(hold, fps);
                let clip = self.project["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|c| c["id"] == id)
                    .cloned()
                    .ok_or("클립을 찾을 수 없습니다.")?;
                if clip["kind"] != "video" {
                    return Err("정지 프레임은 동영상 클립에서 만들 수 있습니다.".into());
                }
                // Splitting first checks the position and the lock before any file work.
                let mut p = self.project.clone();
                mutate(&mut p, "edit.split", &json!({"id":id,"time":time}))?;
                // The frame the split really landed on.
                let time = split_time(&self.project, &clip, time)?;
                let source = p["media"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| m["id"] == clip["mediaId"])
                    .cloned()
                    .ok_or("클립 원본을 찾을 수 없습니다.")?;
                let relative = time - number(&clip, "start", 0.0);
                let offset = if clip["reverse"] == true {
                    number(&clip, "duration", 0.0) - relative
                } else {
                    relative
                };
                let last_frame = number(&source, "duration", 0.0) - 1.0 / number(&p, "fps", 30.0);
                let source_time = (number(&clip, "sourceIn", 0.0)
                    + offset * number(&clip, "speed", 1.0))
                .min(last_frame)
                .max(0.0);
                let frames = self
                    .assets_dir(string(&self.project, "id", ""))
                    .join("frames");
                std::fs::create_dir_all(&frames).map_err(|e| e.to_string())?;
                let png = frames.join(format!("{}.png", media::id("freeze")));
                media::extract_frame(Path::new(required(&source, "path")?), source_time, &png)
                    .await?;
                // Probing only reads the still and makes its thumbnail.
                let result = match media::probe_info(&png, &self.root).await {
                    Ok(still) => {
                        insert_freeze(p, still, &clip, time, hold).and_then(|p| self.commit(p))
                    }
                    Err(error) => Err(error),
                };
                if result.is_err() {
                    let _ = std::fs::remove_file(&png);
                }
                result
            }
            "edit.batch" => {
                let commands = params["commands"]
                    .as_array()
                    .ok_or("편집 명령 목록이 없습니다.")?;
                if commands.is_empty() || commands.len() > 500 {
                    return Err("배치 명령은 1~500개여야 합니다.".into());
                }
                let mut p = self.project.clone();
                for command in commands {
                    mutate(&mut p, required(command, "method")?, &command["params"])?;
                }
                self.commit(p)
            }
            m if m.starts_with("edit.") => {
                let mut p = self.project.clone();
                mutate(&mut p, m, &params)?;
                self.commit(p)
            }
            "export.start" => {
                self.jobs
                    .start(self.project.clone(), params, self.root.clone())
                    .await
            }
            "export.status" => self.jobs.status(required(&params, "id")?),
            "export.cancel" => self.jobs.cancel(required(&params, "id")?),
            "preview.frame" => {
                let mut result = render::preview_frame(&self.project, &params, &self.root).await?;
                let asset_id = media::id("preview-frame");
                self.preview_assets
                    .insert(asset_id.clone(), PathBuf::from(required(&result, "path")?));
                result["assetId"] = json!(asset_id);
                Ok(result)
            }
            "preview.start" => {
                let width = (number(&params, "width", 960.0).clamp(64.0, 960.0) as u32 / 2) * 2;
                let height = ((width as f64 * number(&self.project, "height", 1080.0)
                    / number(&self.project, "width", 1920.0)) as u32
                    / 2)
                    * 2;
                let asset_id = media::id("preview-video");
                let path = self.root.join("previews").join(format!("{asset_id}.mp4"));
                let mut result=self.jobs.start(self.project.clone(),json!({"path":path,"format":"mp4","width":width,"height":height.max(16),"fps":self.project["fps"],"crf":23,"preview":true}),self.root.clone()).await?;
                self.preview_assets.insert(asset_id.clone(), path);
                result["assetId"] = json!(asset_id);
                result["revision"] = self.project["revision"].clone();
                Ok(result)
            }
            "captions.import" => {
                let path = required(&params, "path")?;
                let content = std::fs::read_to_string(path)
                    .map_err(|e| format!("자막 파일 읽기 실패: {e}"))?;
                let captions = parse_srt(&content)?;
                let mut p = self.project.clone();
                for (start, end, text) in captions {
                    mutate(
                        &mut p,
                        "edit.add",
                        &json!({"start":start,"duration":end-start,"text":{"content":text}}),
                    )?;
                }
                self.commit(p)
            }
            "captions.export" => {
                let path = PathBuf::from(required(&params, "path")?);
                self.guard_output(&path, &params, false)?;
                let mut clips: Vec<&Value> = self.project["clips"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter(|c| c["kind"] == "text")
                    .collect();
                clips.sort_by(|a, b| number(a, "start", 0.0).total_cmp(&number(b, "start", 0.0)));
                if clips.is_empty() {
                    return Err("내보낼 자막이 없습니다.".into());
                }
                let content = clips
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        format!(
                            "{}\n{} --> {}\n{}\n",
                            i + 1,
                            srt_time(number(c, "start", 0.0)),
                            srt_time(number(c, "start", 0.0) + number(c, "duration", 0.0)),
                            string(&c["text"], "content", "")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                let temporary = path.with_extension(format!("tmp-{}", media::id("srt")));
                std::fs::write(&temporary, content)
                    .and_then(|_| std::fs::rename(&temporary, &path))
                    .map_err(|e| {
                        let _ = std::fs::remove_file(&temporary);
                        format!("자막 파일 저장 실패: {e}")
                    })?;
                Ok(json!({"path":path}))
            }
            _ => Err(format!("지원하지 않는 편집 명령입니다: {method}")),
        }
    }

    async fn demo(&mut self) -> Result<Value, String> {
        let path = std::env::var_os("BYORI_STUDIO_DEMO_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../public/demo"));
        if !path.is_dir() {
            return Err("예제 미디어를 찾을 수 없습니다. 미디어를 직접 가져와 주세요.".into());
        }
        let mut paths: Vec<_> = std::fs::read_dir(&path)
            .map_err(|e| e.to_string())?
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                matches!(
                    p.extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase()
                        .as_str(),
                    "jpg" | "jpeg" | "png" | "mp4" | "mov" | "wav" | "mp3" | "webm"
                )
            })
            .collect();
        paths.sort();
        let mut p = empty_project("잠시, 멈추는 여행 · 예제", 1920, 1080, 30.0);
        p["concept"] = json!({"audience":"여행과 일상의 여유를 좋아하는 사람","message":"잠시 속도를 늦추면 보이는 것들","appeal":"공간의 분위기와 자연스러운 호흡","direction":"차분한 색감, 여유 있는 컷, 간결한 자막"});
        let mut cursor = 0.0;
        for path in paths.into_iter().take(8) {
            let m = media::probe_info(&path, &self.root).await?;
            let audio = m["kind"] == "audio";
            let id = m["id"].clone();
            let duration = if audio {
                number(&m, "duration", 12.0).min(12.0)
            } else {
                number(&m, "duration", 5.0).min(4.0)
            };
            p["media"].as_array_mut().unwrap().push(m);
            mutate(
                &mut p,
                "edit.add",
                &json!({"mediaId":id,"start":if audio{0.0}else{cursor},"duration":duration,"trackId":if audio{"audio-1"}else{"video-1"}}),
            )?;
            if !audio {
                cursor += duration;
            }
        }
        if p["media"].as_array().unwrap().is_empty() {
            return Err("예제 폴더에 미디어가 없습니다.".into());
        }
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":{"content":"잠시, 멈춰도 괜찮아","fontSize":72,"color":"#ffffff","bold":true},"start":0.0,"duration":4.0}),
        )?;
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":{"content":"A little room to breathe","fontSize":44,"color":"#ffffff"},"start":4.0,"duration":4.0}),
        )?;
        p["notes"] = json!([{"id":media::id("note"),"body":"직접 편집하거나 에이전트에게 컷 순서와 자막 수정을 요청해 보세요. 이 프로젝트는 예제입니다.","kind":"context","createdAt":media::now()}]);
        self.replace(p)
    }
}

fn required<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} 값이 필요합니다."))
}

fn merge(target: &mut Value, patch: &Value) {
    if let (Some(t), Some(p)) = (target.as_object_mut(), patch.as_object()) {
        for (k, v) in p {
            merge(t.entry(k).or_insert(Value::Null), v);
        }
    } else {
        *target = patch.clone();
    }
}

fn ensure_unlocked(project: &Value, track_id: &str) -> Result<(), String> {
    let track = project["tracks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["id"] == track_id)
        .ok_or("트랙을 찾을 수 없습니다.")?;
    if track["locked"].as_bool().unwrap_or(false) {
        return Err("잠긴 트랙입니다. 잠금을 해제한 뒤 편집해 주세요.".into());
    }
    Ok(())
}

fn default_clip(kind: &str, name: &str, track: &str, start: f64, duration: f64) -> Value {
    json!({"id":media::id("clip"),"name":name,"kind":kind,"trackId":track,"start":start,"duration":duration,
        "sourceIn":0.0,"speed":1.0,"reverse":false,"volume":1.0,"fadeIn":0.0,"fadeOut":0.0,
        "transform":{"x":0.0,"y":0.0,"scale":1.0,"rotation":0.0,"opacity":1.0},
        "color":{"brightness":0.0,"contrast":1.0,"saturation":1.0,"temperature":0.0},"keyframes":[]})
}

/// Portable presets contain only supported editing values, never scripts or
/// FFmpeg expressions. Relative keyframe/fade timing is retained via sourceDuration.
pub(crate) fn capture_preset(clip: &Value, kind: &str) -> Result<Value, String> {
    let audio = clip["kind"] == "audio";
    if !["filter", "effect"].contains(&kind) || (kind == "filter" && audio) {
        return Err("영상·이미지·텍스트의 필터 또는 클립 효과를 선택해 주세요.".into());
    }
    let mut patch = if kind == "filter" {
        json!({"filter":"none","color":{"brightness":0.0,"contrast":1.0,"saturation":1.0,"temperature":0.0,"hue":0.0,
            "hsl":{"red":{"hue":0.0,"saturation":0.0,"lightness":0.0},"yellow":{"hue":0.0,"saturation":0.0,"lightness":0.0},"green":{"hue":0.0,"saturation":0.0,"lightness":0.0},"cyan":{"hue":0.0,"saturation":0.0,"lightness":0.0},"blue":{"hue":0.0,"saturation":0.0,"lightness":0.0},"magenta":{"hue":0.0,"saturation":0.0,"lightness":0.0}},
            "curves":{"preset":"none","master":[],"red":[],"green":[],"blue":[]},"lut":{"enabled":false}}})
    } else if audio {
        json!({"volume":1.0,"fadeIn":0.0,"fadeOut":0.0,"keyframes":[],"audio":{"normalize":false,"denoise":false,"voiceEnhance":false,"eq":{"bass":0.0,"mid":0.0,"treble":0.0}}})
    } else {
        json!({"transform":{"x":0.0,"y":0.0,"scale":1.0,"rotation":0.0,"opacity":1.0,"flipX":false,"flipY":false},
            "crop":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"mask":{"type":"none","x":0.5,"y":0.5,"width":1.0,"height":1.0,"feather":0.0},
            "chromaKey":{"enabled":false,"color":"#00ff00","similarity":0.1,"blend":0.1},"stabilize":{"enabled":false,"strength":1},
            "fadeIn":0.0,"fadeOut":0.0,"transitionIn":null,"transitionOut":null,"blendMode":"normal","keyframes":[]})
    };
    for (field, value) in patch.as_object_mut().unwrap() {
        if let Some(selected) = clip.get(field) {
            merge(value, selected);
        }
    }
    if kind == "filter" && patch["color"]["lut"]["enabled"] == false {
        patch["color"]["lut"] = json!({"enabled":false});
    }
    if kind == "effect" && !audio {
        for (transition, fade) in [("transitionIn", "fadeIn"), ("transitionOut", "fadeOut")] {
            let duration = number(&patch, fade, 0.0);
            patch[transition] = if duration > 0.0 {
                json!({"type":string(&patch[transition], "type", "fade"),"duration":duration})
            } else {
                Value::Null
            };
        }
    }
    Ok(
        json!({"version":1,"name":"프리셋","kind":kind,"target":if audio {"audio"} else {"visual"},"sourceDuration":number(clip,"duration",1.0),"patch":patch}),
    )
}

pub(crate) fn validate_preset(preset: &Value) -> Result<(), String> {
    let kind = string(preset, "kind", "");
    let target = string(preset, "target", "");
    if !["filter", "effect"].contains(&kind)
        || !["visual", "audio"].contains(&target)
        || (kind == "filter" && target != "visual")
    {
        return Err("프리셋 종류 또는 적용 대상이 올바르지 않습니다.".into());
    }
    bounded(preset, "sourceDuration", 0.01, 86400.0)?;
    let allowed: &[&str] = if kind == "filter" {
        &["color", "filter"]
    } else if target == "audio" {
        &["volume", "fadeIn", "fadeOut", "keyframes", "audio"]
    } else {
        &[
            "transform",
            "crop",
            "mask",
            "chromaKey",
            "stabilize",
            "fadeIn",
            "fadeOut",
            "transitionIn",
            "transitionOut",
            "blendMode",
            "keyframes",
        ]
    };
    optional_fields(&preset["patch"], allowed, "preset patch")?;
    if preset["patch"].as_object().unwrap().is_empty() {
        return Err("프리셋의 편집 값이 비어 있습니다.".into());
    }
    for field in ["transitionIn", "transitionOut"] {
        if let Some(transition) = preset["patch"].get(field).filter(|v| !v.is_null()) {
            optional_fields(transition, &["type", "duration"], "preset transition")?;
            if !TRANSITIONS.contains(&string(transition, "type", "")) {
                return Err("프리셋에 지원하지 않는 전환 종류가 있습니다.".into());
            }
            bounded(transition, "duration", 0.0, 86400.0)?;
        }
    }
    if preset["patch"]["keyframes"]
        .as_array()
        .is_some_and(|frames| frames.len() > 1000)
    {
        return Err("프리셋 키프레임은 1,000개까지 지원합니다.".into());
    }
    let mut project = empty_project("preset validation", 1920, 1080, 30.0);
    let clip_kind = if target == "audio" { "audio" } else { "video" };
    let track = if target == "audio" {
        "audio-1"
    } else {
        "video-1"
    };
    let mut clip = default_clip(
        clip_kind,
        "preset",
        track,
        0.0,
        number(preset, "sourceDuration", 1.0),
    );
    clip["id"] = json!("preset-validation");
    clip["mediaId"] = json!("preset-media");
    project["media"] = json!([{"id":"preset-media","path":"preset-validation.mp4","kind":"video","duration":86400.0,"hasAudio":true}]);
    project["clips"] = json!([clip]);
    mutate(
        &mut project,
        "edit.update",
        &json!({"id":"preset-validation","patch":preset_patch(preset)}),
    )
}

// Presets saved by older builds may carry a legacy filter id.
fn preset_patch(preset: &Value) -> Value {
    let mut patch = preset["patch"].clone();
    if let Some(filter) = patch.get_mut("filter") {
        *filter = json!(legacy_filter(filter));
    }
    patch
}

pub fn keyframe_property(property: &str) -> &str {
    property.strip_prefix("transform.").unwrap_or(property)
}

/// Progress 0..1 between two keyframes, shaped by the first one's easing.
pub fn ease(easing: &str, t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    match easing {
        "easeIn" => t * t,
        "easeOut" => 1.0 - (1.0 - t) * (1.0 - t),
        "easeInOut" => t * t * (3.0 - 2.0 * t),
        "hold" => {
            if t >= 1.0 {
                1.0
            } else {
                0.0
            }
        }
        _ => t,
    }
}

/// Keyframes of one property as (time, value, easing towards the next one),
/// sorted, starting at time 0 with the clip's static value when none is there.
pub fn keyframe_frames(clip: &Value, property: &str) -> Vec<(f64, f64, String)> {
    let property = keyframe_property(property);
    let base = if property == "volume" {
        number(clip, "volume", 1.0)
    } else {
        number(
            &clip["transform"],
            property,
            if property == "opacity" || property == "scale" {
                1.0
            } else {
                0.0
            },
        )
    };
    let mut points: Vec<_> = clip["keyframes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|k| keyframe_property(string(k, "property", "")) == property)
        .map(|k| {
            (
                number(k, "time", 0.0),
                number(k, "value", base),
                string(k, "easing", "linear").to_owned(),
            )
        })
        .collect();
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    if points.first().is_none_or(|p| p.0 > 0.0) {
        points.insert(0, (0.0, base, "linear".into()));
    }
    points
}

pub fn keyframe_points(clip: &Value, property: &str) -> Vec<(f64, f64)> {
    keyframe_frames(clip, property)
        .into_iter()
        .map(|(time, value, _)| (time, value))
        .collect()
}

pub fn keyframe_value(clip: &Value, property: &str, time: f64) -> f64 {
    let points = keyframe_frames(clip, property);
    if time <= points[0].0 {
        return points[0].1;
    }
    for pair in points.windows(2) {
        if time <= pair[1].0 {
            let ratio = (time - pair[0].0) / (pair[1].0 - pair[0].0).max(f64::EPSILON);
            return pair[0].1 + (pair[1].1 - pair[0].1) * ease(&pair[0].2, ratio);
        }
    }
    points.last().unwrap().1
}

fn keyframe(property: &str, time: f64, value: f64, easing: &str) -> Value {
    let mut frame = json!({"property":property,"time":time,"value":value});
    if easing != "linear" {
        frame["easing"] = json!(easing);
    }
    frame
}

// Easing of the segment that contains `time`: a keyframe added there continues it.
fn easing_at(frames: &[(f64, f64, String)], time: f64) -> &str {
    frames
        .iter()
        .rev()
        .find(|frame| frame.0 <= time)
        .map_or("linear", |frame| frame.2.as_str())
}

fn keyframe_properties(clip: &Value) -> std::collections::BTreeSet<String> {
    clip["keyframes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|k| keyframe_property(string(k, "property", "")).to_owned())
        .collect()
}

fn split_keyframes(clip: &Value, time: f64) -> (Value, Value) {
    let mut left = vec![];
    let mut right = vec![];
    for property in keyframe_properties(clip) {
        let frames = keyframe_frames(clip, &property);
        let value = keyframe_value(clip, &property, time);
        right.push(keyframe(&property, 0.0, value, easing_at(&frames, time)));
        for (t, v, easing) in &frames {
            if *t < time {
                left.push(keyframe(&property, *t, *v, easing));
            }
            if *t > time {
                right.push(keyframe(&property, t - time, *v, easing));
            }
        }
        left.push(keyframe(&property, time, value, "linear"));
    }
    (json!(left), json!(right))
}

// Keep animation tied to its original timeline positions, including eased
// values at the new edges. Extending an edge holds the nearest original value.
fn trim_keyframes(clip: &Value, start: f64, duration: f64) -> Value {
    let end = start + duration;
    let mut result = vec![];
    for property in keyframe_properties(clip) {
        let frames = keyframe_frames(clip, &property);
        result.push(keyframe(
            &property,
            0.0,
            keyframe_value(clip, &property, start),
            easing_at(&frames, start),
        ));
        for (time, value, easing) in &frames {
            if *time > start && *time < end {
                result.push(keyframe(&property, time - start, *value, easing));
            }
        }
        result.push(keyframe(
            &property,
            duration,
            keyframe_value(clip, &property, end),
            "linear",
        ));
    }
    json!(result)
}

// No fade or transition outlasts its clip, and the two never overlap: each is
// first limited to the clip's length, and if together they are still longer than
// the clip, both shrink by the same ratio so that they meet.
fn fit_clip_fades(clip: &mut Value) {
    let duration = number(clip, "duration", 0.0);
    // Anything but a number is left for validation to refuse.
    for fade in ["fadeIn", "fadeOut"] {
        if clip[fade].as_f64().is_some_and(|length| length > duration) {
            clip[fade] = json!(duration);
        }
    }
    if let (Some(fade_in), Some(fade_out)) = (clip["fadeIn"].as_f64(), clip["fadeOut"].as_f64()) {
        if fade_in >= 0.0 && fade_out >= 0.0 && fade_in + fade_out > duration {
            let fade_in = fade_in * duration / (fade_in + fade_out);
            clip["fadeIn"] = json!(fade_in);
            clip["fadeOut"] = json!(duration - fade_in);
        }
    }
    sync_transition(clip, "fadeIn", "transitionIn");
    sync_transition(clip, "fadeOut", "transitionOut");
}

// New edits place clips on the project's frame grid. Stored projects are never
// migrated, so every helper below tolerates clips that are off the grid.
fn snap(time: f64, fps: f64) -> f64 {
    (time * fps).round() / fps
}

/// A whole number of frames, at least one.
fn snap_length(length: f64, fps: f64) -> f64 {
    (length * fps).round().max(1.0) / fps
}

/// Removes float noise from arithmetic on grid values; off-grid values are kept.
fn settle(time: f64, fps: f64) -> f64 {
    let snapped = snap(time, fps);
    if (snapped - time).abs() < 1e-6 {
        snapped
    } else {
        time
    }
}

/// Snaps a clip's length to whole frames. A media clip that rounding pushed past
/// the end of its source gives the partial frame back; keyframes that rounding
/// left just past the end move to it.
fn snap_clip_length(p: &Value, clip: &mut Value) {
    if let Some(length) = clip["duration"].as_f64().filter(|d| d.is_finite()) {
        let snapped = snap_length(length, number(p, "fps", 30.0));
        set_clip_length(p, clip, length, snapped);
    }
}

/// Gives a clip the whole-frame length `snapped`, chosen for a requested `length`.
fn set_clip_length(p: &Value, clip: &mut Value, length: f64, mut snapped: f64) {
    let fps = number(p, "fps", 30.0);
    if snapped > length
        && snapped > 1.5 / fps
        && matches!(string(clip, "kind", ""), "video" | "audio")
    {
        let available = p["media"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| m["id"] == clip["mediaId"])
            .map(|m| number(m, "duration", 0.0) - number(clip, "sourceIn", 0.0));
        if available.is_some_and(|a| snapped * number(clip, "speed", 1.0) > a + 1e-6) {
            snapped -= 1.0 / fps;
            snapped = snap(snapped, fps);
        }
    }
    clip["duration"] = json!(snapped);
    if let Some(frames) = clip["keyframes"].as_array_mut() {
        for frame in frames {
            let time = number(frame, "time", 0.0);
            if time > snapped && time < snapped + 1.0 / fps {
                frame["time"] = json!(snapped);
            }
        }
    }
}

/// A negative start is left as it is, for validation to refuse: rounding must not
/// turn a position before the timeline into frame 0 (or into -0.0).
fn snap_clip_start(p: &Value, clip: &mut Value) {
    if let Some(start) = clip["start"]
        .as_f64()
        .filter(|s| s.is_finite() && *s >= 0.0)
    {
        clip["start"] = json!(snap(start, number(p, "fps", 30.0)) + 0.0);
    }
}

/// Snaps a clip given by start and length: both ends go to their nearest frame,
/// so clips that touched before rounding still touch after it. Rounding the
/// length on its own could move the end one frame away from where it was asked.
fn snap_clip_span(p: &Value, clip: &mut Value) {
    let fps = number(p, "fps", 30.0);
    let finite = |key: &str| clip[key].as_f64().filter(|value| value.is_finite());
    let (Some(start), Some(length)) = (finite("start").filter(|s| *s >= 0.0), finite("duration"))
    else {
        snap_clip_start(p, clip);
        snap_clip_length(p, clip);
        return;
    };
    let first = (start * fps).round();
    let frames = (((start + length) * fps).round() - first).max(1.0);
    clip["start"] = json!(first / fps + 0.0);
    set_clip_length(p, clip, length, frames / fps);
}

/// The stretch of source a speed change keeps. A clip remembers it (`sourceSpan`)
/// from its last speed change, because its whole-frame length no longer tells it
/// exactly; the memory counts only while it still accounts for the clip's length,
/// so any later trim, split or resize makes the length the reference again.
fn source_span(p: &Value, clip: &Value) -> f64 {
    let length = number(clip, "duration", 1.0);
    let speed = number(clip, "speed", 1.0);
    clip["sourceSpan"]
        .as_f64()
        .filter(|span| span.is_finite() && *span > 0.0)
        .filter(|span| {
            let mut probe = clip.clone();
            probe["duration"] = json!(span / speed);
            snap_clip_length(p, &mut probe);
            (number(&probe, "duration", 0.0) - length).abs() < 1e-6
        })
        .unwrap_or(length * speed)
}

/// Where a split of `clip` at `time` lands: the nearest frame that leaves both
/// halves at least one frame long (an off-grid legacy clip may keep `time` itself).
fn split_time(p: &Value, clip: &Value, time: f64) -> Result<f64, String> {
    let fps = number(p, "fps", 30.0);
    let start = number(clip, "start", 0.0);
    let duration = number(clip, "duration", 0.0);
    let fits = |time: &f64| {
        let relative = time - start;
        relative + 1e-8 >= 1.0 / fps && duration - relative + 1e-8 >= 1.0 / fps
    };
    if !time.is_finite() || !fits(&time) {
        return Err(
            "분할한 두 클립의 길이가 각각 최소 1프레임이 되도록 위치를 선택해 주세요.".into(),
        );
    }
    Ok(Some(snap(time, fps)).filter(fits).unwrap_or(time))
}

/// Moves every clip on `track` that starts at or after `from` by `delta` seconds.
/// Grouped clips on other tracks follow, so a group is not pulled apart: all of
/// them when the whole group moves, and those at or after `from` when the group
/// has a clip that stays on `track`. A locked track with such a clip refuses.
fn shift_track(p: &mut Value, track: &Value, from: f64, delta: f64) -> Result<(), String> {
    let fps = number(p, "fps", 30.0);
    let clips = p["clips"].as_array().unwrap();
    let after = |clip: &Value| number(clip, "start", 0.0) >= from - 1e-6;
    let (mut moving, mut staying) = (HashSet::new(), HashSet::new());
    for clip in clips.iter().filter(|clip| clip["trackId"] == *track) {
        if let Some(group) = clip["groupId"].as_str() {
            let side = if after(clip) {
                &mut moving
            } else {
                &mut staying
            };
            side.insert(group);
        }
    }
    let mut moved = Vec::new();
    for (index, clip) in clips.iter().enumerate() {
        if clip["trackId"] == *track {
            if after(clip) {
                moved.push(index);
            }
        } else if clip["groupId"].as_str().is_some_and(|group| {
            moving.contains(group) && (after(clip) || !staying.contains(group))
        }) {
            ensure_unlocked(p, string(clip, "trackId", ""))?;
            moved.push(index);
        }
    }
    for index in moved {
        let clip = &mut p["clips"][index];
        let start = settle(number(clip, "start", 0.0) + delta, fps);
        if start < -1e-6 {
            return Err("클립을 타임라인 시작보다 앞으로 옮길 수 없습니다.".into());
        }
        clip["start"] = json!(start.max(0.0));
    }
    Ok(())
}

// fadeIn/fadeOut time the audio fade (and the picture's too for fade/dissolve);
// a transition object keeps its type and always has the same length.
fn sync_transition(clip: &mut Value, fade: &str, transition: &str) {
    if clip.get(transition).is_some_and(Value::is_object) {
        let length = number(clip, fade, 0.0);
        if length > 0.0 {
            clip[transition]["duration"] = json!(length);
        } else {
            clip[transition] = Value::Null;
        }
    }
}

fn filter_color(filter: &str) -> Option<Value> {
    let (brightness, contrast, saturation, temperature) = match filter {
        "none" => (0.0, 1.0, 1.0, 0.0),
        "cinematic" => (-0.02, 1.15, 0.85, 0.0),
        "warm" => (0.02, 1.03, 1.05, 0.5),
        "cool" => (0.0, 1.05, 0.95, -0.5),
        "mono" => (0.0, 1.1, 0.0, 0.0),
        "vintage" => (0.03, 0.9, 0.75, 0.3),
        _ => return None,
    };
    Some(
        json!({"brightness":brightness,"contrast":contrast,"saturation":saturation,"temperature":temperature}),
    )
}

fn mutate(p: &mut Value, method: &str, args: &Value) -> Result<(), String> {
    match method {
        "edit.add" => {
            let is_text = args.get("text").is_some();
            let media = if is_text {
                None
            } else {
                Some(
                    p["media"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|m| m["id"] == args["mediaId"])
                        .cloned()
                        .ok_or("소재를 찾을 수 없습니다.")?,
                )
            };
            let mut kind = if is_text {
                "text"
            } else {
                string(media.as_ref().unwrap(), "kind", "video")
            };
            let wanted = if kind == "text" {
                "text"
            } else if kind == "audio" {
                "audio"
            } else {
                "video"
            };
            // `newTrack` (its name) puts the clip on a track made for it, so that the
            // track and the clip are one undo step.
            let new_track = match args.get("newTrack") {
                None | Some(Value::Null) => None,
                Some(Value::String(name)) if !name.trim().is_empty() => {
                    if args.get("trackId").is_some_and(|id| !id.is_null()) {
                        return Err("trackId와 newTrack은 함께 쓸 수 없습니다.".into());
                    }
                    Some(insert_track(p, wanted, name.trim()))
                }
                Some(_) => return Err("새 트랙 이름이 올바르지 않습니다.".into()),
            };
            let track = if let Some(id) = new_track.as_deref().or(args["trackId"].as_str()) {
                p["tracks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["id"] == id)
            } else {
                p["tracks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|t| t["kind"] == wanted && !t["locked"].as_bool().unwrap_or(false))
            }
            .cloned()
            .ok_or("사용할 수 있는 트랙이 없습니다.")?;
            let track_id = required(&track, "id")?;
            ensure_unlocked(p, track_id)?;
            if track["kind"] == "audio" && media.as_ref().is_some_and(|m| m["hasAudio"] == true) {
                kind = "audio";
            }
            if (kind == "text" && track["kind"] != "text")
                || (kind == "audio" && track["kind"] != "audio")
                || (matches!(kind, "video" | "image") && track["kind"] != "video")
            {
                return Err("소재와 트랙 종류가 맞지 않습니다.".into());
            }
            let fps = number(p, "fps", 30.0);
            let default_start = p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["trackId"] == track_id)
                .map(|c| number(c, "start", 0.0) + number(c, "duration", 0.0))
                .fold(0.0, f64::max);
            // After an off-grid legacy clip, the next frame rather than an overlap.
            let default_start = (default_start * fps - 1e-6).ceil().max(0.0) / fps;
            let duration = number(
                args,
                "duration",
                media
                    .as_ref()
                    .map(|m| number(m, "duration", 5.0))
                    .unwrap_or(3.0),
            );
            let mut clip = default_clip(
                kind,
                if is_text {
                    "텍스트"
                } else {
                    string(media.as_ref().unwrap(), "name", "클립")
                },
                track_id,
                number(args, "start", default_start),
                duration,
            );
            if let Some(m) = media.as_ref() {
                clip["mediaId"] = m["id"].clone();
            }
            if is_text {
                clip["text"] = json!({"content":"텍스트를 입력하세요","fontSize":64,"color":"#ffffff","fontFamily":"sans-serif","bold":false,"align":"center","background":"transparent"});
                if args["text"].is_string() {
                    clip["text"]["content"] = args["text"].clone();
                } else {
                    merge(&mut clip["text"], &args["text"]);
                }
                clip["name"] = clip["text"]["content"].clone();
                shorten(&mut clip["name"]);
                clip["transform"]["y"] = json!(number(p, "height", 1080.0) * 0.32);
            }
            if let Some(source) = args.get("sourceIn") {
                clip["sourceIn"] = source.clone();
            }
            // Lets one command place an overlay (a sticker) already named and sized.
            if args["name"].is_string() {
                clip["name"] = args["name"].clone();
                shorten(&mut clip["name"]);
            }
            if args["transform"].is_object() {
                merge(&mut clip["transform"], &args["transform"]);
            }
            snap_clip_span(p, &mut clip);
            p["clips"].as_array_mut().unwrap().push(clip);
        }
        "edit.update" => {
            let id = required(args, "id")?;
            let index = p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .position(|c| c["id"] == id)
                .ok_or("클립을 찾을 수 없습니다.")?;
            ensure_unlocked(p, string(&p["clips"][index], "trackId", ""))?;
            let patch = args["patch"]
                .as_object()
                .ok_or("클립 변경 내용이 없습니다.")?;
            let original = p["clips"][index].clone();
            if let Some(track) = patch.get("trackId").and_then(Value::as_str) {
                ensure_unlocked(p, track)?;
            }
            for (key, value) in patch {
                if !CLIP_FIELDS.contains(&key.as_str()) {
                    return Err(format!("클립 속성을 변경할 수 없습니다: {key}"));
                }
                merge(&mut p["clips"][index][key], value);
            }
            // Choosing a system family must release a previously installed font.
            if let Some(text) = patch.get("text") {
                if text.get("fontFamily").is_some()
                    && text["fontFamily"] != original["text"]["fontFamily"]
                    && text.get("fontPath").is_none()
                {
                    if let Some(style) = p["clips"][index]["text"].as_object_mut() {
                        style.remove("fontId");
                        style.remove("fontPath");
                    }
                }
            }
            // A filter sets only the basic grade; hue, HSL, curves and LUT stay.
            if patch.contains_key("filter") && !patch.contains_key("color") {
                let color = filter_color(string(&p["clips"][index], "filter", "none"))
                    .ok_or("지원하지 않는 필터 프리셋입니다.")?;
                merge(&mut p["clips"][index]["color"], &color);
            }
            for (transition, fade) in [("transitionIn", "fadeIn"), ("transitionOut", "fadeOut")] {
                if patch.contains_key(transition) {
                    let clip = &mut p["clips"][index];
                    clip[fade] = if clip[transition].is_null() {
                        json!(0.0)
                    } else {
                        clip[transition]["duration"].clone()
                    };
                }
                sync_transition(&mut p["clips"][index], fade, transition);
            }
            // A speed change keeps the clip's source span. It comes either alone or
            // with the length that follows from it (what the inspector sends); any
            // other length given with a speed is a resize and is taken as given.
            let speed = number(&p["clips"][index], "speed", 1.0);
            let length = number(&original, "duration", 1.0);
            let retimed = patch.contains_key("speed")
                && speed.is_finite()
                && speed > 0.0
                && patch.get("duration").is_none_or(|wanted| {
                    wanted.as_f64().is_some_and(|wanted| {
                        (wanted - length * number(&original, "speed", 1.0) / speed).abs() < 1e-6
                    })
                });
            let mut clip = p["clips"][index].take();
            match (
                patch.contains_key("start"),
                patch.contains_key("duration") && !retimed,
            ) {
                (true, true) => snap_clip_span(p, &mut clip),
                (true, false) => snap_clip_start(p, &mut clip),
                (false, true) => snap_clip_length(p, &mut clip),
                (false, false) => {}
            }
            p["clips"][index] = clip;
            if retimed {
                let span = source_span(p, &original);
                let mut clip = p["clips"][index].take();
                clip["duration"] = json!(span / speed);
                snap_clip_length(p, &mut clip);
                clip["sourceSpan"] = json!(span);
                p["clips"][index] = clip;
                // Keyframes follow the length the clip really got.
                let ratio = number(&p["clips"][index], "duration", length) / length;
                if !patch.contains_key("duration") && !patch.contains_key("keyframes") {
                    if let Some(frames) = p["clips"][index]["keyframes"].as_array_mut() {
                        for frame in frames {
                            frame["time"] = json!(number(frame, "time", 0.0) * ratio);
                        }
                    }
                }
            }
            if patch.contains_key("duration") && !patch.contains_key("keyframes") {
                let length = number(&p["clips"][index], "duration", 0.0);
                if length > 0.0 && length < number(&original, "duration", 0.0) {
                    let (left, _) = split_keyframes(&original, length);
                    p["clips"][index]["keyframes"] = left;
                }
            }
            if [
                "speed",
                "duration",
                "fadeIn",
                "fadeOut",
                "transitionIn",
                "transitionOut",
            ]
            .iter()
            .any(|key| patch.contains_key(*key))
            {
                fit_clip_fades(&mut p["clips"][index]);
            }
            if patch.contains_key("text")
                && p["clips"][index]["kind"] == "text"
                && !patch.contains_key("name")
            {
                p["clips"][index]["name"] = p["clips"][index]["text"]["content"].clone();
                shorten(&mut p["clips"][index]["name"]);
            }
        }
        "edit.trim" => {
            let id = required(args, "id")?;
            let index = p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .position(|c| c["id"] == id)
                .ok_or("클립을 찾을 수 없습니다.")?;
            let original = p["clips"][index].clone();
            ensure_unlocked(p, string(&original, "trackId", ""))?;
            if args.get("start").is_none() && args.get("end").is_none() {
                return Err("트림할 시작 또는 끝 위치가 필요합니다.".into());
            }
            let old_start = number(&original, "start", 0.0);
            let old_end = old_start + number(&original, "duration", 0.0);
            let boundary = |key: &str, fallback: f64| -> Result<f64, String> {
                match args.get(key) {
                    None => Ok(fallback),
                    Some(value) => value
                        .as_f64()
                        .filter(|value| value.is_finite())
                        .ok_or_else(|| format!("트림 {key} 위치는 유효한 숫자여야 합니다.")),
                }
            };
            let raw = (boundary("start", old_start)?, boundary("end", old_end)?);
            const TIME_EPSILON: f64 = 1e-8;
            let fps = number(p, "fps", 30.0);
            let long_enough =
                |(start, end): (f64, f64)| start >= 0.0 && end - start + TIME_EPSILON >= 1.0 / fps;
            if !long_enough(raw) {
                return Err(
                    "트림 시작 위치는 0 이상이고 클립 길이는 최소 1프레임이어야 합니다.".into(),
                );
            }
            let media_duration = if matches!(string(&original, "kind", ""), "video" | "audio") {
                Some(
                    p["media"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .find(|m| m["id"] == original["mediaId"])
                        .map(|m| number(m, "duration", 0.0))
                        .ok_or("클립 원본을 찾을 수 없습니다.")?,
                )
            } else {
                None
            };
            let speed = number(&original, "speed", 1.0);
            let source_in = |(start, end): (f64, f64)| {
                let offset = if original["reverse"] == true {
                    old_end - end
                } else {
                    start - old_start
                };
                number(&original, "sourceIn", 0.0) + offset * speed
            };
            let in_source = |range: (f64, f64)| {
                media_duration.is_none_or(|media_duration| {
                    let source = source_in(range);
                    source >= -TIME_EPSILON
                        && source + (range.1 - range.0) * speed <= media_duration + TIME_EPSILON
                })
            };
            if !in_source(raw) {
                return Err("트림 범위가 원본 미디어 길이를 벗어납니다.".into());
            }
            // A given boundary goes to the nearest frame, or to the frame inside the
            // requested range when the nearest one is past the source. A boundary that
            // was not given stays where it is.
            let pick = |key: &str, value: f64, snapped: f64| {
                if args.get(key).is_some() {
                    snapped
                } else {
                    value
                }
            };
            let nearest = (
                pick("start", raw.0, snap(raw.0, fps)),
                pick("end", raw.1, snap(raw.1, fps)),
            );
            let inward = (
                pick("start", raw.0, (raw.0 * fps - 1e-6).ceil() / fps),
                pick("end", raw.1, (raw.1 * fps + 1e-6).floor() / fps),
            );
            let (start, end) = [nearest, inward]
                .into_iter()
                .find(|range| long_enough(*range) && in_source(*range))
                .unwrap_or(raw);
            let duration = settle(end - start, fps);
            let mut trimmed = original.clone();
            if media_duration.is_some() {
                trimmed["sourceIn"] = json!(source_in((start, end)).max(0.0));
            }
            trimmed["start"] = json!(start);
            trimmed["duration"] = json!(duration);
            trimmed["keyframes"] = trim_keyframes(&original, start - old_start, duration);
            fit_clip_fades(&mut trimmed);
            p["clips"][index] = trimmed;
        }
        "edit.split" => {
            let id = required(args, "id")?;
            let i = p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .position(|c| c["id"] == id)
                .ok_or("클립을 찾을 수 없습니다.")?;
            let clip = p["clips"][i].clone();
            ensure_unlocked(p, string(&clip, "trackId", ""))?;
            let time = args["time"].as_f64().ok_or("분할 위치가 필요합니다.")?;
            let time = split_time(p, &clip, time)?;
            let fps = number(p, "fps", 30.0);
            let start = number(&clip, "start", 0.0);
            let duration = number(&clip, "duration", 0.0);
            let relative = settle(time - start, fps);
            let mut right = clip.clone();
            right["id"] = json!(media::id("clip"));
            right["start"] = json!(time);
            right["duration"] = json!(settle(duration - relative, fps));
            let speed = number(&clip, "speed", 1.0);
            let source = number(&clip, "sourceIn", 0.0);
            if matches!(string(&clip, "kind", ""), "video" | "audio") {
                if clip["reverse"] == true {
                    p["clips"][i]["sourceIn"] = json!(source + (duration - relative) * speed);
                } else {
                    right["sourceIn"] = json!(source + relative * speed);
                }
            }
            p["clips"][i]["duration"] = json!(relative);
            p["clips"][i]["fadeOut"] = json!(0.0);
            right["fadeIn"] = json!(0.0);
            fit_clip_fades(&mut p["clips"][i]);
            fit_clip_fades(&mut right);
            let (left_keys, right_keys) = split_keyframes(&clip, relative);
            p["clips"][i]["keyframes"] = left_keys;
            right["keyframes"] = right_keys;
            p["clips"].as_array_mut().unwrap().insert(i + 1, right);
        }
        "edit.duplicate" => {
            let selected = selected_clips(p, args)?;
            let start = selected
                .iter()
                .map(|c| number(c, "start", 0.0))
                .fold(f64::INFINITY, f64::min);
            let end = selected
                .iter()
                .map(|c| number(c, "start", 0.0) + number(c, "duration", 0.0))
                .fold(0.0, f64::max);
            let mut groups = HashMap::new();
            for mut c in selected {
                c["id"] = json!(media::id("clip"));
                c["start"] = json!(settle(
                    number(&c, "start", 0.0) + end - start,
                    number(p, "fps", 30.0)
                ));
                if let Some(group) = c["groupId"].as_str() {
                    let new = groups
                        .entry(group.to_owned())
                        .or_insert_with(|| media::id("group"))
                        .clone();
                    c["groupId"] = json!(new);
                }
                p["clips"].as_array_mut().unwrap().push(c);
            }
        }
        "edit.group" | "edit.ungroup" => {
            let selected = selected_clips(p, args)?;
            if method == "edit.group" && selected.len() < 2 {
                return Err("그룹으로 묶을 클립을 두 개 이상 선택해 주세요.".into());
            }
            let ids: HashSet<_> = selected.iter().map(|c| string(c, "id", "")).collect();
            let group = media::id("group");
            for c in p["clips"].as_array_mut().unwrap() {
                if ids.contains(string(c, "id", "")) {
                    if method == "edit.group" {
                        c["groupId"] = json!(group);
                    } else {
                        c.as_object_mut().unwrap().remove("groupId");
                    }
                }
            }
        }
        "edit.delete" => {
            let ids = args["ids"]
                .as_array()
                .ok_or("삭제할 클립 목록이 필요합니다.")?;
            if ids.is_empty() {
                return Err("삭제할 클립을 선택해 주세요.".into());
            }
            let removed: Vec<Value> = p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| ids.contains(&c["id"]))
                .cloned()
                .collect();
            if removed.len() != ids.iter().collect::<HashSet<_>>().len() {
                return Err("삭제할 클립을 찾을 수 없습니다.".into());
            }
            for c in &removed {
                ensure_unlocked(p, string(c, "trackId", ""))?;
            }
            let ripple = args["ripple"].as_bool().unwrap_or(false);
            let fps = number(p, "fps", 30.0);
            let clips = p["clips"].as_array_mut().unwrap();
            clips.retain(|c| !ids.contains(&c["id"]));
            if ripple {
                // Close only the time the removed clips held alone: a clip that
                // overlapped one (a transition) keeps its place relative to the rest.
                let range = |c: &Value| {
                    let start = number(c, "start", 0.0);
                    (start, start + number(c, "duration", 0.0))
                };
                let tracks: HashSet<&str> =
                    removed.iter().map(|r| string(r, "trackId", "")).collect();
                let mut freed: HashMap<&str, Vec<(f64, f64)>> = HashMap::new();
                for track in tracks {
                    let on_track = |c: &&Value| c["trackId"] == track;
                    let mut gaps: Vec<(f64, f64)> =
                        removed.iter().filter(on_track).map(range).collect();
                    for (from, to) in clips.iter().filter(on_track).map(range) {
                        gaps = gaps
                            .into_iter()
                            .flat_map(|(a, b)| [(a, b.min(from)), (a.max(to), b)])
                            .filter(|(a, b)| b > a)
                            .collect();
                    }
                    // Removed clips may overlap each other; count shared time once.
                    gaps.sort_by(|a, b| a.0.total_cmp(&b.0));
                    let mut merged: Vec<(f64, f64)> = vec![];
                    for (a, b) in gaps {
                        match merged.last_mut() {
                            Some(last) if a <= last.1 => last.1 = last.1.max(b),
                            _ => merged.push((a, b)),
                        }
                    }
                    freed.insert(track, merged);
                }
                for c in clips {
                    let start = number(c, "start", 0.0);
                    let shift: f64 = freed
                        .get(string(c, "trackId", ""))
                        .into_iter()
                        .flatten()
                        .map(|(a, b)| (b.min(start + 0.0001) - a).max(0.0))
                        .sum();
                    if shift > 0.0 {
                        c["start"] = json!(settle(start - shift, fps).max(0.0));
                    }
                }
            }
        }
        "edit.track" => {
            if let Some(id) = args["id"].as_str() {
                let track = p["tracks"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|t| t["id"] == id)
                    .ok_or("트랙을 찾을 수 없습니다.")?;
                let patch = args["patch"]
                    .as_object()
                    .ok_or("트랙 변경 내용이 없습니다.")?;
                for (key, value) in patch {
                    if !["name", "muted", "hidden", "locked"].contains(&key.as_str()) {
                        return Err(format!("트랙 속성을 변경할 수 없습니다: {key}"));
                    }
                    track[key] = value.clone();
                }
            } else {
                let kind = string(args, "kind", "video");
                if !["video", "audio", "text"].contains(&kind) {
                    return Err("트랙 종류가 올바르지 않습니다.".into());
                }
                let clips = if args.get("clipIds").is_some() {
                    selected_clips(p, &json!({"ids":args["clipIds"]}))?
                } else {
                    Vec::new()
                };
                if clips.iter().any(|clip| match kind {
                    "video" => !matches!(string(clip, "kind", ""), "video" | "image"),
                    _ => clip["kind"] != kind,
                }) {
                    return Err("선택한 클립과 새 트랙 종류가 맞지 않습니다.".into());
                }
                let track_id = insert_track(p, kind, string(args, "name", kind));
                for clip in p["clips"].as_array_mut().unwrap() {
                    if clips.iter().any(|selected| selected["id"] == clip["id"]) {
                        clip["trackId"] = json!(track_id);
                    }
                }
            }
        }
        "edit.marker" => {
            let time = args["time"].as_f64().ok_or("마커 위치가 필요합니다.")?;
            if !time.is_finite() || time < 0.0 {
                return Err("마커 위치가 올바르지 않습니다.".into());
            }
            p["markers"].as_array_mut().unwrap().push(
                json!({"id":media::id("marker"),"time":time,"label":string(args,"label","마커")}),
            );
        }
        "edit.markerUpdate" => {
            let id = required(args, "id")?;
            let marker = p["markers"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|m| m["id"] == id)
                .ok_or("마커를 찾을 수 없습니다.")?;
            for key in ["time", "label"] {
                if let Some(value) = args.get(key) {
                    marker[key] = value.clone();
                }
            }
        }
        "edit.markerDelete" => {
            let id = required(args, "id")?;
            let markers = p["markers"].as_array_mut().unwrap();
            let count = markers.len();
            markers.retain(|m| m["id"] != id);
            if markers.len() == count {
                return Err("마커를 찾을 수 없습니다.".into());
            }
        }
        "edit.trackDelete" => {
            let id = required(args, "id")?;
            ensure_unlocked(p, id)?;
            p["tracks"]
                .as_array_mut()
                .unwrap()
                .retain(|t| t["id"] != id);
            p["clips"]
                .as_array_mut()
                .unwrap()
                .retain(|c| c["trackId"] != id);
        }
        "edit.trackMove" => {
            let id = required(args, "id")?;
            let tracks = p["tracks"].as_array_mut().unwrap();
            let from = tracks
                .iter()
                .position(|t| t["id"] == id)
                .ok_or("트랙을 찾을 수 없습니다.")?;
            let index = args["index"]
                .as_u64()
                .filter(|index| (*index as usize) < tracks.len())
                .ok_or("트랙을 옮길 위치가 올바르지 않습니다.")? as usize;
            let track = tracks.remove(from);
            tracks.insert(index, track);
        }
        "edit.paste" => {
            let clips = args["clips"]
                .as_array()
                .filter(|clips| !clips.is_empty() && clips.len() <= 1000)
                .ok_or("붙여넣을 클립 1~1,000개가 필요합니다.")?;
            let at = args["at"]
                .as_f64()
                .filter(|at| at.is_finite() && *at >= 0.0)
                .ok_or("붙여넣을 위치가 올바르지 않습니다.")?;
            let earliest = clips
                .iter()
                .map(|c| number(c, "start", 0.0))
                .fold(f64::INFINITY, f64::min);
            let mut groups = HashMap::new();
            for source in clips {
                let fields = source
                    .as_object()
                    .ok_or("붙여넣을 클립 형식이 올바르지 않습니다.")?;
                let mut clip = json!({});
                for (key, value) in fields {
                    if key == "kind" || CLIP_FIELDS.contains(&key.as_str()) {
                        clip[key] = value.clone();
                    }
                }
                let wanted = match string(&clip, "kind", "") {
                    "text" => "text",
                    "audio" => "audio",
                    "video" | "image" => "video",
                    _ => return Err("붙여넣을 클립 종류가 올바르지 않습니다.".into()),
                };
                let usable = |t: &&Value| t["kind"] == wanted && t["locked"] != true;
                let tracks = p["tracks"].as_array().unwrap();
                let track = tracks
                    .iter()
                    .filter(usable)
                    .find(|t| t["id"] == clip["trackId"])
                    .or_else(|| tracks.iter().find(usable))
                    .ok_or(
                        "붙여넣을 수 있는 트랙이 없습니다. 트랙을 추가하거나 잠금을 해제해 주세요.",
                    )?;
                clip["trackId"] = track["id"].clone();
                clip["id"] = json!(media::id("clip"));
                clip["start"] = json!(at + number(&clip, "start", 0.0) - earliest);
                snap_clip_span(p, &mut clip);
                fit_clip_fades(&mut clip);
                if let Some(group) = clip["groupId"].as_str() {
                    let new = groups
                        .entry(group.to_owned())
                        .or_insert_with(|| media::id("group"))
                        .clone();
                    clip["groupId"] = json!(new);
                }
                p["clips"].as_array_mut().unwrap().push(clip);
            }
        }
        // One command for a ripple: every clip on the track that starts at or after
        // `from` moves by `delta` (whole frames), however many clips that is.
        "edit.shift" => {
            let track = required(args, "trackId")?;
            ensure_unlocked(p, track)?;
            let finite = |key: &str| args[key].as_f64().filter(|value| value.is_finite());
            let from = finite("from").ok_or("이동을 시작할 위치(from)가 필요합니다.")?;
            let delta = snap(
                finite("delta").ok_or("이동할 길이(delta)가 필요합니다.")?,
                number(p, "fps", 30.0),
            );
            if delta == 0.0 {
                return Err("이동할 길이는 최소 1프레임이어야 합니다.".into());
            }
            shift_track(p, &json!(track), from, delta)?;
        }
        _ => return Err(format!("배치에서 지원하지 않는 편집 명령입니다: {method}")),
    }
    validate_project(p)
}

// `p` already has `clip` split at `time`: open a gap there and hold `still` in it.
fn insert_freeze(
    mut p: Value,
    mut still: Value,
    clip: &Value,
    time: f64,
    hold: f64,
) -> Result<Value, String> {
    still["name"] = json!(format!("{} 정지 프레임", string(clip, "name", "클립")));
    shorten(&mut still["name"]);
    let media_id = still["id"].clone();
    p["media"].as_array_mut().unwrap().push(still);
    shift_track(&mut p, &clip["trackId"], time, hold)?;
    mutate(
        &mut p,
        "edit.add",
        &json!({"mediaId":media_id,"trackId":clip["trackId"],"start":time,"duration":hold}),
    )?;
    // The held frame keeps the look the clip had at that moment.
    let relative = time - number(clip, "start", 0.0);
    let frozen = p["clips"].as_array_mut().unwrap().last_mut().unwrap();
    for field in [
        "transform",
        "color",
        "filter",
        "crop",
        "mask",
        "chromaKey",
        "blendMode",
    ] {
        if let Some(value) = clip.get(field) {
            frozen[field] = value.clone();
        }
    }
    for property in keyframe_properties(clip) {
        if property != "volume" {
            frozen["transform"][&property] = json!(keyframe_value(clip, &property, relative));
        }
    }
    validate_project(&p)?;
    Ok(p)
}

/// The service stores an uploaded file in its imports folder as `<uuid>-<name>`;
/// the library shows the name the file came with.
fn uploaded_name(path: &Path, root: &Path) -> Option<String> {
    let file = path.file_name()?.to_str()?;
    let (prefix, name) = (file.get(..36)?, file.get(37..)?);
    let stored = media::same_path(path.parent()?, &root.join("imports"));
    (stored
        && file.as_bytes()[36] == b'-'
        && !name.is_empty()
        && uuid::Uuid::parse_str(prefix).is_ok())
    .then(|| name.to_string())
}

fn insert_track(p: &mut Value, kind: &str, name: &str) -> String {
    let id = media::id("track");
    let tracks = p["tracks"].as_array_mut().unwrap();
    let after_same_kind = tracks
        .iter()
        .rposition(|track| track["kind"] == kind)
        .map(|index| index + 1)
        .unwrap_or(tracks.len());
    let index = if kind == "video" {
        // Later visual tracks composite on top. Keep newly added footage below captions.
        after_same_kind.min(
            tracks
                .iter()
                .position(|track| track["kind"] == "text")
                .unwrap_or(tracks.len()),
        )
    } else {
        after_same_kind
    };
    tracks.insert(
        index,
        json!({"id":id,"kind":kind,"name":name,"muted":false,"hidden":false,"locked":false}),
    );
    id
}

fn drop_waveform(p: &mut Value, media_id: &str) {
    for item in p["media"].as_array_mut().into_iter().flatten() {
        if item["id"] == media_id {
            item.as_object_mut().unwrap().remove("waveform");
        }
    }
}

fn refresh_media_metadata(p: &mut Value, id: &str, asset: Value) -> Result<Value, String> {
    let index = p["media"]
        .as_array()
        .unwrap()
        .iter()
        .position(|item| item["id"] == id)
        .ok_or("소재를 찾을 수 없습니다.")?;
    let referencing: Vec<Value> = p["clips"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|clip| clip["mediaId"] == id)
        .cloned()
        .collect();
    for clip in &referencing {
        ensure_unlocked(p, string(clip, "trackId", ""))?;
    }
    if p["media"][index]["kind"] == "video" && asset["kind"] == "audio" {
        let mut audio_tracks: HashMap<String, String> = HashMap::new();
        for clip in referencing.iter().filter(|clip| clip["kind"] == "video") {
            let old_track_id = required(clip, "trackId")?;
            if !audio_tracks.contains_key(old_track_id) {
                let source_track = p["tracks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|track| track["id"] == old_track_id)
                    .cloned()
                    .ok_or("클립의 트랙을 찾을 수 없습니다.")?;
                let track_id = insert_track(
                    p,
                    "audio",
                    &format!("{} 오디오", string(&source_track, "name", "복구된")),
                );
                let track = p["tracks"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|track| track["id"] == track_id)
                    .unwrap();
                track["muted"] = source_track["muted"].clone();
                track["hidden"] = source_track["hidden"].clone();
                audio_tracks.insert(old_track_id.to_owned(), track_id);
            }
        }
        for clip in p["clips"].as_array_mut().unwrap() {
            if clip["mediaId"] == id && clip["kind"] == "video" {
                clip["trackId"] = json!(audio_tracks[required(clip, "trackId")?]);
                clip["kind"] = json!("audio");
                if clip["stabilize"]["enabled"] == true {
                    clip["stabilize"]["enabled"] = json!(false);
                }
                // Audio clips only fade and have no blend mode.
                for transition in ["transitionIn", "transitionOut"] {
                    if clip[transition].is_object() {
                        clip[transition]["type"] = json!("fade");
                    }
                }
                clip.as_object_mut().unwrap().remove("blendMode");
            }
        }
    }
    // The known waveform stays only for what still looks like the same file.
    let same_file = ["path", "duration", "hasAudio"]
        .iter()
        .all(|field| p["media"][index].get(*field) == asset.get(*field));
    // Preserve identity, the user's name, paths, and any future/custom metadata.
    for field in [
        "kind",
        "duration",
        "width",
        "height",
        "hasAudio",
        "thumbnail",
    ] {
        p["media"][index][field] = asset[field].clone();
    }
    // A probe without a waveform leaves it to be computed in the background.
    let item = p["media"][index].as_object_mut().unwrap();
    for field in ["codec", "fps"] {
        match asset.get(field) {
            Some(value) => item.insert(field.into(), value.clone()),
            None => item.remove(field),
        };
    }
    if asset["waveform"].is_array() {
        item.insert("waveform".into(), asset["waveform"].clone());
    } else if !same_file {
        item.remove("waveform");
    }
    Ok(p["media"][index].clone())
}

fn selected_clips(p: &Value, args: &Value) -> Result<Vec<Value>, String> {
    let ids = if let Some(ids) = args["ids"].as_array() {
        ids.clone()
    } else {
        vec![json!(required(args, "id")?)]
    };
    if ids.is_empty()
        || ids.iter().any(|v| v.as_str().is_none())
        || ids.iter().collect::<HashSet<_>>().len() != ids.len()
    {
        return Err("중복되지 않는 클립 ID 목록이 필요합니다.".into());
    }
    let selected: Vec<_> = p["clips"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| ids.contains(&c["id"]))
        .cloned()
        .collect();
    if selected.len() != ids.len() {
        return Err("선택한 클립을 찾을 수 없습니다.".into());
    }
    for c in &selected {
        ensure_unlocked(p, string(c, "trackId", ""))?;
    }
    Ok(selected)
}

fn bounded(v: &Value, key: &str, min: f64, max: f64) -> Result<(), String> {
    let n = v[key]
        .as_f64()
        .ok_or_else(|| format!("{key} 값은 숫자여야 합니다."))?;
    if !n.is_finite() || n < min || n > max {
        return Err(format!("{key} 값은 {min}~{max} 범위여야 합니다."));
    }
    Ok(())
}

pub fn validate_project(p: &Value) -> Result<(), String> {
    if !safe_project_id(required(p, "id")?) {
        return Err("프로젝트 ID가 올바르지 않습니다.".into());
    }
    let name = required(p, "name")?;
    if name.len() > 1000 {
        return Err("프로젝트 이름이 너무 깁니다.".into());
    }
    if p.get("schemaVersion").is_some_and(|v| {
        !v.as_u64()
            .is_some_and(|v| (1..=SCHEMA_VERSION).contains(&v))
    }) {
        return Err("지원하지 않는 프로젝트 버전입니다.".into());
    }
    bounded(p, "width", 16.0, 8192.0)?;
    bounded(p, "height", 16.0, 8192.0)?;
    bounded(p, "fps", 1.0, 120.0)?;
    if p["width"].as_u64().is_none() || p["height"].as_u64().is_none() {
        return Err("화면 크기는 정수여야 합니다.".into());
    }
    if !valid_color(string(p, "background", "")) {
        return Err("배경 색상 형식이 올바르지 않습니다.".into());
    }
    let tracks = p["tracks"].as_array().ok_or("트랙 목록이 없습니다.")?;
    let clips = p["clips"].as_array().ok_or("클립 목록이 없습니다.")?;
    let assets = p["media"].as_array().ok_or("소재 목록이 없습니다.")?;
    if tracks.len() > 128 || clips.len() > 10000 || assets.len() > 10000 {
        return Err("프로젝트 크기 제한을 초과했습니다.".into());
    }
    for list in [tracks, clips, assets] {
        let mut ids = HashSet::new();
        for item in list {
            if !ids.insert(required(item, "id")?) {
                return Err("중복된 항목 ID가 있습니다.".into());
            }
        }
    }
    for t in tracks {
        if !["video", "audio", "text"].contains(&string(t, "kind", "")) {
            return Err("트랙 종류가 올바르지 않습니다.".into());
        }
        for field in ["muted", "hidden", "locked"] {
            if !t[field].is_boolean() {
                return Err(format!("트랙 {field} 값이 올바르지 않습니다."));
            }
        }
        if !short_text(t.get("name")) {
            return Err("트랙 이름이 올바르지 않습니다.".into());
        }
    }
    for asset in assets {
        for flag in ["missing", "proxy"] {
            if asset.get(flag).is_some_and(|v| !v.is_boolean()) {
                return Err(format!("소재 {flag} 표시 값이 올바르지 않습니다."));
            }
        }
        required(asset, "path")?;
        bounded(asset, "duration", 0.001, 86400.0)?;
        if !["video", "audio", "image"].contains(&string(asset, "kind", "")) {
            return Err("소재 종류가 올바르지 않습니다.".into());
        }
    }
    for c in clips {
        let track = tracks
            .iter()
            .find(|t| t["id"] == c["trackId"])
            .ok_or("클립의 트랙을 찾을 수 없습니다.")?;
        let kind = string(c, "kind", "");
        if !["video", "audio", "image", "text"].contains(&kind) {
            return Err("클립 종류가 올바르지 않습니다.".into());
        }
        if (kind == "text" && track["kind"] != "text")
            || (kind == "audio" && track["kind"] != "audio")
            || (matches!(kind, "video" | "image") && track["kind"] != "video")
        {
            return Err("클립과 트랙 종류가 맞지 않습니다.".into());
        }
        bounded(c, "start", 0.0, 86400.0)?;
        // Preserve legacy sub-frame clips while allowing a full frame at 120fps.
        bounded(
            c,
            "duration",
            (1.0 / number(p, "fps", 30.0)).min(0.01) - 1e-8,
            86400.0,
        )?;
        bounded(c, "sourceIn", 0.0, 86400.0)?;
        bounded(c, "speed", 0.1, 16.0)?;
        bounded(c, "volume", 0.0, 4.0)?;
        bounded(c, "fadeIn", 0.0, 86400.0)?;
        bounded(c, "fadeOut", 0.0, 86400.0)?;
        if !short_text(c.get("name")) {
            return Err("클립 이름이 올바르지 않습니다.".into());
        }
        if c.get("reverse").is_some_and(|v| !v.is_boolean()) {
            return Err("역재생 값은 true 또는 false여야 합니다.".into());
        }
        if let Some(filter) = c.get("filter").filter(|v| !v.is_null()) {
            if !filter.as_str().is_some_and(|id| FILTERS.contains(&id)) {
                return Err("지원하지 않는 필터 프리셋입니다.".into());
            }
        }
        for field in ["transitionIn", "transitionOut"] {
            if let Some(transition) = c.get(field).filter(|v| !v.is_null()) {
                optional_fields(transition, &["type", "duration"], "transition")?;
                let name = string(transition, "type", "");
                if !TRANSITIONS.contains(&name) {
                    return Err("지원하지 않는 전환 종류입니다.".into());
                }
                if kind == "audio" && name != "fade" {
                    return Err("오디오 클립의 전환은 fade만 지원합니다.".into());
                }
                bounded(transition, "duration", 0.0, 86400.0)?;
            }
        }
        if let Some(mode) = c.get("blendMode").filter(|v| !v.is_null()) {
            if !mode.as_str().is_some_and(|m| BLEND_MODES.contains(&m)) {
                return Err("지원하지 않는 블렌드 모드입니다.".into());
            }
            if kind == "audio" && mode != "normal" {
                return Err("블렌드 모드는 영상·이미지·텍스트 클립에 적용할 수 있습니다.".into());
            }
        }
        if kind != "text" {
            let m = assets
                .iter()
                .find(|m| m["id"] == c["mediaId"])
                .ok_or("클립 원본을 찾을 수 없습니다.")?;
            if kind == "audio" && m["hasAudio"] != true {
                return Err("이 소재에는 오디오가 없습니다.".into());
            }
            if (kind == "video" && m["kind"] != "video")
                || (kind == "image" && m["kind"] != "image")
            {
                return Err("클립과 원본 소재 종류가 맞지 않습니다.".into());
            }
            if matches!(kind, "video" | "audio")
                && number(c, "sourceIn", 0.0) + number(c, "duration", 0.0) * number(c, "speed", 1.0)
                    > number(m, "duration", 0.0) + 0.05
            {
                return Err(
                    "클립이 원본 미디어 길이를 초과합니다. 길이 또는 속도를 조정해 주세요.".into(),
                );
            }
        } else {
            optional_fields(
                &c["text"],
                &[
                    "content",
                    "fontSize",
                    "color",
                    "fontFamily",
                    "fontId",
                    "fontPath",
                    "bold",
                    "align",
                    "background",
                    "italic",
                    "letterSpacing",
                    "lineHeight",
                    "outline",
                    "shadow",
                ],
                "text",
            )?;
            let text = c["text"]["content"]
                .as_str()
                .ok_or("텍스트 내용은 문자열이어야 합니다.")?;
            if text.len() > 20000 {
                return Err("텍스트가 너무 깁니다.".into());
            }
            bounded(&c["text"], "fontSize", 8.0, 500.0)?;
            if let Some(path) = c["text"].get("fontPath") {
                let path = path
                    .as_str()
                    .filter(|s| !s.is_empty() && s.len() < 4096 && !s.chars().any(char::is_control))
                    .ok_or("추가 글꼴 경로가 올바르지 않습니다.")?;
                if !["ttf", "otf"].contains(
                    &Path::new(path)
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("")
                        .to_lowercase()
                        .as_str(),
                ) {
                    return Err("추가 글꼴 경로는 .ttf 또는 .otf 파일이어야 합니다.".into());
                }
                if !c["text"]["fontId"].as_str().is_some_and(safe_project_id) {
                    return Err("추가 글꼴 ID가 올바르지 않습니다.".into());
                }
            }
            if !valid_color(string(&c["text"], "color", "")) {
                return Err("텍스트 색상 형식이 올바르지 않습니다.".into());
            }
            if !["left", "center", "right"].contains(&string(&c["text"], "align", "center")) {
                return Err("텍스트 정렬이 올바르지 않습니다.".into());
            }
            for flag in ["bold", "italic"] {
                if c["text"].get(flag).is_some() && !c["text"][flag].is_boolean() {
                    return Err(format!("텍스트 {flag} 값은 true 또는 false여야 합니다."));
                }
            }
            for (field, min, max) in [("letterSpacing", -5.0, 50.0), ("lineHeight", 0.8, 3.0)] {
                if c["text"].get(field).is_some() {
                    bounded(&c["text"], field, min, max)?;
                }
            }
            // null clears an outline or shadow.
            for (field, numbers) in [
                ("outline", &[("width", 0.0, 20.0)][..]),
                (
                    "shadow",
                    &[
                        ("x", -200.0, 200.0),
                        ("y", -200.0, 200.0),
                        ("blur", 0.0, 40.0),
                    ][..],
                ),
            ] {
                let Some(style) = c["text"].get(field).filter(|v| !v.is_null()) else {
                    continue;
                };
                let mut allowed = vec!["color"];
                allowed.extend(numbers.iter().map(|n| n.0));
                optional_fields(style, &allowed, field)?;
                if !valid_color(string(style, "color", "")) {
                    return Err(format!("텍스트 {field} 색상 형식이 올바르지 않습니다."));
                }
                for (key, min, max) in numbers {
                    bounded(style, key, *min, *max)?;
                }
            }
            let background = string(&c["text"], "background", "transparent");
            if background != "transparent" && !valid_color(background) {
                return Err("텍스트 배경 색상이 올바르지 않습니다.".into());
            }
        }
        optional_fields(
            &c["transform"],
            &["x", "y", "scale", "rotation", "opacity", "flipX", "flipY"],
            "transform",
        )?;
        optional_fields(
            &c["color"],
            &[
                "brightness",
                "contrast",
                "saturation",
                "temperature",
                "hue",
                "hsl",
                "curves",
                "lut",
            ],
            "color",
        )?;
        for (field, min, max) in [
            ("x", -20000.0, 20000.0),
            ("y", -20000.0, 20000.0),
            ("scale", 0.01, 20.0),
            ("rotation", -3600.0, 3600.0),
            ("opacity", 0.0, 1.0),
        ] {
            bounded(&c["transform"], field, min, max)?;
        }
        for flag in ["flipX", "flipY"] {
            if c["transform"].get(flag).is_some() && !c["transform"][flag].is_boolean() {
                return Err(format!("{flag} 값은 true 또는 false여야 합니다."));
            }
        }
        validate_options(c)?;
        validate_color(&c["color"])?;
        if c.get("sourceSpan").is_some_and(|v| !v.is_null()) {
            bounded(c, "sourceSpan", 0.0, 86400.0 * 16.0)?;
        }
        if let Some(group) = c.get("groupId").filter(|v| !v.is_null()) {
            if !group.as_str().is_some_and(safe_project_id) {
                return Err("그룹 ID가 올바르지 않습니다.".into());
            }
        }
        for (field, min, max) in [
            ("brightness", -1.0, 1.0),
            ("contrast", 0.0, 3.0),
            ("saturation", 0.0, 3.0),
            ("temperature", -1.0, 1.0),
        ] {
            bounded(&c["color"], field, min, max)?;
        }
        let kfs = c["keyframes"]
            .as_array()
            .ok_or("키프레임 목록이 올바르지 않습니다.")?;
        for k in kfs {
            let property = required(k, "property")?;
            let bounds = match property {
                "transform.x" | "transform.y" | "x" | "y" => (-20000.0, 20000.0),
                "transform.scale" | "scale" => (0.01, 20.0),
                "transform.rotation" | "rotation" => (-3600.0, 3600.0),
                "transform.opacity" | "opacity" => (0.0, 1.0),
                "volume" => (0.0, 4.0),
                _ => return Err(format!("지원하지 않는 키프레임 속성입니다: {property}")),
            };
            bounded(k, "time", 0.0, number(c, "duration", 1.0))?;
            bounded(k, "value", bounds.0, bounds.1)?;
            if let Some(easing) = k.get("easing") {
                if !easing.as_str().is_some_and(|e| EASINGS.contains(&e)) {
                    return Err("지원하지 않는 키프레임 보간 방식입니다.".into());
                }
            }
        }
    }
    let (Some(notes), Some(markers), true) = (
        p["notes"].as_array(),
        p["markers"].as_array(),
        p["concept"].is_object(),
    ) else {
        return Err("프로젝트 메모/마커/컨셉 형식이 올바르지 않습니다.".into());
    };
    if notes.len() > 10000 || markers.len() > 10000 {
        return Err("프로젝트 크기 제한을 초과했습니다.".into());
    }
    let mut marker_ids = HashSet::new();
    for marker in markers {
        if !marker.is_object()
            || !marker_ids.insert(required(marker, "id")?)
            || !short_text(marker.get("label"))
        {
            return Err("마커 형식이 올바르지 않습니다.".into());
        }
        bounded(marker, "time", 0.0, 86400.0)?;
    }
    for note in notes {
        if note["body"].as_str().is_none_or(|body| body.len() > 20000)
            || note.get("id").is_some_and(|id| !id.is_string())
        {
            return Err("메모 형식이 올바르지 않습니다.".into());
        }
    }
    Ok(())
}

// An optional display name: absent, or a string of bounded size.
fn short_text(value: Option<&Value>) -> bool {
    value.is_none_or(|v| v.as_str().is_some_and(|s| s.len() <= 1000))
}

fn optional_fields(value: &Value, allowed: &[&str], name: &str) -> Result<(), String> {
    let object = value
        .as_object()
        .ok_or_else(|| format!("{name} 값은 객체여야 합니다."))?;
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(format!("지원하지 않는 {name} 속성입니다: {key}"));
        }
    }
    Ok(())
}

fn validate_options(c: &Value) -> Result<(), String> {
    if let Some(stabilize) = c.get("stabilize") {
        optional_fields(stabilize, &["enabled", "strength"], "stabilize")?;
        if stabilize.get("enabled").is_some() && !stabilize["enabled"].is_boolean() {
            return Err("안정화 사용 여부가 올바르지 않습니다.".into());
        }
        if stabilize["enabled"] == true && c["kind"] != "video" {
            return Err("안정화는 동영상 클립에 적용할 수 있습니다.".into());
        }
        if let Some(strength) = stabilize.get("strength") {
            if !strength.as_u64().is_some_and(|s| (1..=3).contains(&s)) {
                return Err("안정화 강도는 1, 2, 3 중에서 선택해 주세요.".into());
            }
        }
    }
    if let Some(crop) = c.get("crop") {
        optional_fields(crop, &["x", "y", "width", "height"], "crop")?;
        for (key, default, min) in [
            ("x", 0.0, 0.0),
            ("y", 0.0, 0.0),
            ("width", 1.0, 0.01),
            ("height", 1.0, 0.01),
        ] {
            if crop.get(key).is_some() {
                bounded(crop, key, min, 1.0)?;
            } else if default < min {
                return Err("크롭 범위가 올바르지 않습니다.".into());
            }
        }
        if number(crop, "x", 0.0) + number(crop, "width", 1.0) > 1.00001
            || number(crop, "y", 0.0) + number(crop, "height", 1.0) > 1.00001
        {
            return Err("크롭 영역이 원본 범위를 벗어납니다.".into());
        }
    }
    if let Some(mask) = c.get("mask") {
        optional_fields(
            mask,
            &["type", "x", "y", "width", "height", "feather"],
            "mask",
        )?;
        if !["none", "circle", "rectangle"].contains(&string(mask, "type", "none")) {
            return Err("지원하지 않는 마스크 종류입니다.".into());
        }
        for (key, min, max) in [
            ("x", 0.0, 1.0),
            ("y", 0.0, 1.0),
            ("width", 0.01, 2.0),
            ("height", 0.01, 2.0),
            ("feather", 0.0, 1.0),
        ] {
            if mask.get(key).is_some() {
                bounded(mask, key, min, max)?;
            }
        }
    }
    if let Some(chroma) = c.get("chromaKey") {
        optional_fields(
            chroma,
            &["enabled", "color", "similarity", "blend"],
            "chromaKey",
        )?;
        if chroma.get("enabled").is_some() && !chroma["enabled"].is_boolean() {
            return Err("크로마키 사용 여부가 올바르지 않습니다.".into());
        }
        if chroma.get("color").is_some() && !valid_color(string(chroma, "color", "")) {
            return Err("크로마키 색상이 올바르지 않습니다.".into());
        }
        for (key, min) in [("similarity", 0.01), ("blend", 0.0)] {
            if chroma.get(key).is_some() {
                bounded(chroma, key, min, 1.0)?;
            }
        }
    }
    if let Some(audio) = c.get("audio") {
        optional_fields(
            audio,
            &["normalize", "denoise", "voiceEnhance", "eq"],
            "audio",
        )?;
        for key in ["normalize", "denoise", "voiceEnhance"] {
            if audio.get(key).is_some() && !audio[key].is_boolean() {
                return Err(format!("오디오 {key} 값이 올바르지 않습니다."));
            }
        }
        if let Some(eq) = audio.get("eq") {
            optional_fields(eq, &["bass", "mid", "treble"], "eq")?;
            for band in ["bass", "mid", "treble"] {
                if eq.get(band).is_some() {
                    bounded(eq, band, -20.0, 20.0)?;
                }
            }
        }
    }
    Ok(())
}

pub const CURVE_PRESETS: &[&str] = &[
    "none",
    "color_negative",
    "cross_process",
    "darker",
    "increase_contrast",
    "lighter",
    "linear_contrast",
    "medium_contrast",
    "negative",
    "strong_contrast",
    "vintage",
];

fn validate_color(color: &Value) -> Result<(), String> {
    if color.get("hue").is_some() {
        bounded(color, "hue", -180.0, 180.0)?;
    }
    if let Some(hsl) = color.get("hsl") {
        optional_fields(
            hsl,
            &["red", "yellow", "green", "cyan", "blue", "magenta"],
            "hsl",
        )?;
        for channel in hsl.as_object().unwrap().values() {
            optional_fields(channel, &["hue", "saturation", "lightness"], "hsl channel")?;
            for (key, min, max) in [
                ("hue", -180.0, 180.0),
                ("saturation", -1.0, 1.0),
                ("lightness", -1.0, 1.0),
            ] {
                if channel.get(key).is_some() {
                    bounded(channel, key, min, max)?;
                }
            }
        }
    }
    if let Some(curves) = color.get("curves") {
        optional_fields(
            curves,
            &["preset", "master", "red", "green", "blue"],
            "curves",
        )?;
        if !CURVE_PRESETS.contains(&string(curves, "preset", "none")) {
            return Err("지원하지 않는 곡선 프리셋입니다.".into());
        }
        for channel in ["master", "red", "green", "blue"] {
            if let Some(points) = curves.get(channel) {
                let points = points
                    .as_array()
                    .ok_or("곡선 제어점은 [x,y] 배열이어야 합니다.")?;
                if points.is_empty() {
                    continue;
                }
                if !(2..=16).contains(&points.len()) {
                    return Err("곡선은 2~16개의 제어점을 지원합니다.".into());
                }
                let mut previous = -1.0;
                for point in points {
                    let pair = point
                        .as_array()
                        .filter(|v| v.len() == 2)
                        .ok_or("곡선 제어점은 [x,y] 형식이어야 합니다.")?;
                    let x = pair[0]
                        .as_f64()
                        .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
                        .ok_or("곡선 x 범위는 0~1입니다.")?;
                    let _y = pair[1]
                        .as_f64()
                        .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
                        .ok_or("곡선 y 범위는 0~1입니다.")?;
                    if x <= previous {
                        return Err("곡선 x 값은 중복 없이 오름차순이어야 합니다.".into());
                    }
                    previous = x;
                }
                if points[0][0].as_f64() != Some(0.0)
                    || points.last().unwrap()[0].as_f64() != Some(1.0)
                {
                    return Err("곡선의 처음과 마지막 x 값은 0과 1이어야 합니다.".into());
                }
            }
        }
    }
    if let Some(lut) = color.get("lut") {
        optional_fields(lut, &["path", "name", "enabled"], "lut")?;
        if lut.get("enabled").is_some() && !lut["enabled"].is_boolean() {
            return Err("LUT 사용 여부가 올바르지 않습니다.".into());
        }
        if lut["enabled"] != false {
            let path = Path::new(required(lut, "path")?);
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !["cube", "3dl"].contains(&ext.as_str()) {
                return Err("LUT 경로는 .cube 또는 .3dl 파일이어야 합니다.".into());
            }
        }
    }
    Ok(())
}

pub fn valid_color(s: &str) -> bool {
    (s.len() == 7 || s.len() == 9)
        && s.starts_with('#')
        && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

fn parse_timestamp(s: &str) -> Option<f64> {
    let s = s.trim().replace(',', ".");
    let parts: Vec<_> = s.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h = parts[0].parse::<u32>().ok()?;
    let m = parts[1].parse::<u32>().ok()?;
    let sec = parts[2].parse::<f64>().ok()?;
    if m >= 60 || !(0.0..60.0).contains(&sec) {
        return None;
    }
    Some(h as f64 * 3600.0 + m as f64 * 60.0 + sec)
}
fn parse_srt(content: &str) -> Result<Vec<(f64, f64, String)>, String> {
    // Lines holding only spaces still separate captions.
    let normalized = content
        .trim_start_matches('\u{feff}')
        .lines()
        .map(|line| if line.trim().is_empty() { "" } else { line })
        .collect::<Vec<_>>()
        .join("\n");
    let mut result = vec![];
    for block in normalized.split("\n\n") {
        let lines: Vec<_> = block.lines().collect();
        let Some(i) = lines.iter().position(|l| l.contains("-->")) else {
            continue;
        };
        let parts: Vec<_> = lines[i].split("-->").collect();
        if parts.len() != 2 {
            return Err("자막 시간 형식이 올바르지 않습니다.".into());
        }
        let start = parse_timestamp(parts[0]).ok_or("자막 시작 시간이 올바르지 않습니다.")?;
        let end = parse_timestamp(parts[1].split_whitespace().next().unwrap_or(""))
            .ok_or("자막 종료 시간이 올바르지 않습니다.")?;
        let text = lines[i + 1..].join("\n");
        if end <= start || text.trim().is_empty() {
            return Err("빈 자막이나 잘못된 시간 범위가 있습니다.".into());
        }
        result.push((start, end, text));
    }
    if result.is_empty() {
        return Err("SRT 자막을 찾을 수 없습니다.".into());
    }
    Ok(result)
}
fn srt_time(seconds: f64) -> String {
    let millis = (seconds * 1000.0).round() as u64;
    format!(
        "{:02}:{:02}:{:02},{:03}",
        millis / 3600000,
        (millis / 60000) % 60,
        (millis / 1000) % 60,
        millis % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn temp() -> PathBuf {
        std::env::temp_dir().join(media::id("studio-editor-test"))
    }

    fn write_wav(path: &Path, samples: u32) {
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36 + samples * 2).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8_000u32.to_le_bytes());
        wav.extend_from_slice(&16_000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples * 2).to_le_bytes());
        wav.resize(wav.len() + samples as usize * 2, 0);
        std::fs::write(path, wav).unwrap();
    }

    fn misclassified_audio_editor() -> (Editor, PathBuf) {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let path = dir.join("music.wav");
        write_wav(&path, 16_000);
        e.project["media"] = json!([{"id":"old-audio","name":"내 음악","path":path,"kind":"video","duration":2.0,"width":720,"height":720,"hasAudio":true}]);
        let mut clip = default_clip("video", "음악 클립", "video-1", 3.0, 0.75);
        clip["mediaId"] = json!("old-audio");
        clip["sourceIn"] = json!(0.25);
        clip["speed"] = json!(1.5);
        clip["volume"] = json!(0.65);
        clip["keyframes"] = json!([{"property":"volume","time":0.5,"value":0.4}]);
        e.project["clips"] = json!([clip]);
        validate_project(&e.project).unwrap();
        e.persist().unwrap();
        (e, dir)
    }

    #[tokio::test]
    async fn reprobe_repairs_audio_without_changing_identity_or_timing_and_is_one_undo() {
        let (mut e, dir) = misclassified_audio_editor();
        let mut unused_asset = e.project["media"][0].clone();
        let unused_path = dir.join("unused.wav");
        std::fs::copy(required(&unused_asset, "path").unwrap(), &unused_path).unwrap();
        unused_asset["id"] = json!("unused-audio");
        unused_asset["path"] = json!(unused_path);
        e.project["media"]
            .as_array_mut()
            .unwrap()
            .push(unused_asset);
        let before = e.project.clone();
        let updated = e
            .dispatch(
                "media.reprobe",
                json!({"ids":["old-audio","unused-audio"],"expectedRevision":0}),
            )
            .await
            .unwrap();
        for field in ["id", "name", "path"] {
            assert_eq!(updated["media"][0][field], before["media"][0][field]);
        }
        assert_eq!(updated["media"][0]["kind"], "audio");
        assert_eq!(updated["media"][1]["id"], "unused-audio");
        assert_eq!(updated["media"][1]["kind"], "audio");
        assert_eq!(updated["media"][0]["width"], 0);
        assert_eq!(updated["media"][0]["height"], 0);
        let mut expected_clip = before["clips"][0].clone();
        expected_clip["kind"] = json!("audio");
        expected_clip["trackId"] = updated["clips"][0]["trackId"].clone();
        assert_eq!(updated["clips"][0], expected_clip);
        let track = updated["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|track| track["id"] == expected_clip["trackId"])
            .unwrap();
        assert_eq!(track["kind"], "audio");
        assert_ne!(track["id"], "audio-1");
        assert_eq!(updated["revision"], 1);
        assert_eq!(e.undo.len(), 1);
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        for field in ["media", "clips", "tracks"] {
            assert_eq!(undone[field], before[field]);
        }
        assert!(e.undo.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn reprobe_rejects_stale_duplicate_unknown_and_locked_media_atomically() {
        let (mut e, dir) = misclassified_audio_editor();
        let before = e.project.clone();
        for params in [
            json!({"ids":["old-audio"],"expectedRevision":1}),
            json!({"ids":["old-audio","old-audio"]}),
            json!({"ids":["old-audio","missing"]}),
            json!({"ids":[]}),
        ] {
            assert!(e.dispatch("media.reprobe", params).await.is_err());
            assert_eq!(e.project, before);
            assert!(e.undo.is_empty());
        }
        e.project["tracks"][0]["locked"] = json!(true);
        let before = e.project.clone();
        assert!(e
            .dispatch("media.reprobe", json!({"ids":["old-audio"]}))
            .await
            .is_err());
        assert_eq!(e.project, before);
        assert!(e.undo.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn reimport_existing_path_repairs_misclassification_without_duplicate_asset() {
        let (mut e, dir) = misclassified_audio_editor();
        let path = e.project["media"][0]["path"].clone();
        let updated = e
            .dispatch("media.import", json!({"paths":[path]}))
            .await
            .unwrap();
        assert_eq!(updated["media"].as_array().unwrap().len(), 1);
        assert_eq!(updated["media"][0]["id"], "old-audio");
        assert_eq!(updated["media"][0]["name"], "내 음악");
        assert_eq!(updated["media"][0]["kind"], "audio");
        assert_eq!(updated["clips"][0]["kind"], "audio");
        assert_eq!(e.undo.len(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn layer_creation_moves_captions_atomically_and_preserves_font_and_animation() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        e.dispatch("edit.add", json!({"text":{"content":"자막","fontFamily":"Custom","fontId":"font-test","fontPath":"/tmp/font.ttf"},"start":2.0,"duration":4.0})).await.unwrap();
        let id = e.project["clips"][0]["id"].clone();
        e.dispatch(
            "edit.update",
            json!({"id":id,"patch":{"keyframes":[{"property":"opacity","time":1.0,"value":0.8}]}}),
        )
        .await
        .unwrap();
        let before = e.project.clone();
        let undo_count = e.undo.len();
        let result = e.dispatch("edit.track", json!({"kind":"text","name":"자막 2","clipIds":[id],"expectedRevision":before["revision"]})).await.unwrap();
        assert_eq!(e.undo.len(), undo_count + 1);
        let mut expected_clip = before["clips"][0].clone();
        expected_clip["trackId"] = result["tracks"][3]["id"].clone();
        assert_eq!(result["clips"][0], expected_clip);
        assert_eq!(result["tracks"][3]["name"], "자막 2");
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["tracks"], before["tracks"]);
        assert_eq!(undone["clips"], before["clips"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn layer_creation_rejects_invalid_selection_and_locked_tracks_without_committing() {
        let (mut e, dir) = misclassified_audio_editor();
        e.dispatch("edit.add", json!({"text":{"content":"자막"}}))
            .await
            .unwrap();
        let video_id = e.project["clips"][0]["id"].clone();
        let text_id = e.project["clips"][1]["id"].clone();
        let before = e.project.clone();
        let undo_count = e.undo.len();
        for params in [
            json!({"kind":"video","clipIds":[video_id,"missing"]}),
            json!({"kind":"video","clipIds":[video_id,video_id]}),
            json!({"kind":"video","clipIds":[video_id,text_id]}),
            json!({"kind":"text","clipIds":[video_id]}),
            json!({"kind":"video","clipIds":[]}),
        ] {
            assert!(e.dispatch("edit.track", params).await.is_err());
            assert_eq!(e.project, before);
            assert_eq!(e.undo.len(), undo_count);
        }
        e.project["tracks"][0]["locked"] = json!(true);
        let before = e.project.clone();
        assert!(e
            .dispatch("edit.track", json!({"kind":"video","clipIds":[video_id]}))
            .await
            .is_err());
        assert_eq!(e.project, before);
        assert_eq!(e.undo.len(), undo_count);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn layer_creation_keeps_new_video_below_caption_layers() {
        let (mut e, dir) = misclassified_audio_editor();
        let id = e.project["clips"][0]["id"].clone();
        let before = e.project.clone();
        let result = e
            .dispatch("edit.track", json!({"kind":"video","clipIds":[id]}))
            .await
            .unwrap();
        assert_eq!(result["tracks"][0]["id"], "video-1");
        assert_eq!(result["tracks"][1]["kind"], "video");
        assert_eq!(result["tracks"][3]["id"], "text-1");
        let mut expected_clip = before["clips"][0].clone();
        expected_clip["trackId"] = result["tracks"][1]["id"].clone();
        assert_eq!(result["clips"][0], expected_clip);
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["tracks"], before["tracks"]);
        assert_eq!(undone["clips"], before["clips"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn preset_catalog_survives_restart_and_apply_is_one_revision_guarded_undo() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let p = e
            .dispatch(
                "edit.add",
                json!({"text":{"content":"preset"},"duration":4.0}),
            )
            .await
            .unwrap();
        let id = p["clips"][0]["id"].clone();
        let p = e
            .dispatch(
                "edit.update",
                json!({"id":id,"patch":{"color":{"brightness":0.3,"saturation":0.7}}}),
            )
            .await
            .unwrap();
        let preset = e
            .dispatch(
                "presets.save",
                json!({"clipId":id,"name":"My color","kind":"filter"}),
            )
            .await
            .unwrap();
        assert_eq!(
            p, e.project,
            "saving catalog must not edit project or history"
        );
        let before = e
            .dispatch(
                "edit.update",
                json!({"id":id,"patch":{"color":{"brightness":-0.2,"hsl":{"red":{"hue":60}}}}}),
            )
            .await
            .unwrap();
        assert!(e
            .dispatch(
                "presets.apply",
                json!({"id":preset["id"],"clipId":id,"expectedRevision":0})
            )
            .await
            .is_err());
        let applied = e
            .dispatch(
                "presets.apply",
                json!({"id":preset["id"],"clipId":id,"expectedRevision":before["revision"]}),
            )
            .await
            .unwrap();
        assert_eq!(applied["clips"][0]["color"]["brightness"], 0.3);
        assert_eq!(applied["clips"][0]["color"]["hsl"]["red"]["hue"], 0.0);
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["clips"], before["clips"]);
        let exported = dir.join("my-filter.json");
        e.dispatch("presets.export", json!({"id":preset["id"],"path":exported}))
            .await
            .unwrap();
        let imported = e
            .dispatch("presets.import", json!({"path":exported}))
            .await
            .unwrap();
        assert_eq!(imported["patch"], preset["patch"]);
        assert_ne!(imported["id"], preset["id"]);
        drop(e);
        let mut reopened = Editor::new(dir.clone()).unwrap();
        assert_eq!(
            reopened.dispatch("assets.list", json!({})).await.unwrap()["presets"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn effect_presets_scale_timing_and_respect_locks() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let p = e
            .dispatch(
                "edit.add",
                json!({"text":{"content":"effect"},"duration":4.0}),
            )
            .await
            .unwrap();
        let id = p["clips"][0]["id"].clone();
        e.dispatch("edit.update",json!({"id":id,"patch":{"fadeIn":1.0,"keyframes":[{"property":"scale","time":4.0,"value":1.5}]}})).await.unwrap();
        let preset = e
            .dispatch(
                "presets.save",
                json!({"clipId":id,"name":"Slow zoom","kind":"effect"}),
            )
            .await
            .unwrap();
        e.dispatch("edit.update", json!({"id":id,"patch":{"duration":8.0}}))
            .await
            .unwrap();
        let p = e
            .dispatch("presets.apply", json!({"clipId":id,"id":preset["id"]}))
            .await
            .unwrap();
        assert_eq!(p["clips"][0]["keyframes"][0]["time"], 8.0);
        assert_eq!(p["clips"][0]["fadeIn"], 2.0);
        e.dispatch("edit.track", json!({"id":"text-1","patch":{"locked":true}}))
            .await
            .unwrap();
        assert!(e
            .dispatch("presets.apply", json!({"clipId":id,"id":preset["id"]}))
            .await
            .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn font_apply_persists_managed_path_and_system_family_releases_it() {
        let Some(source) = [
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_file()) else {
            return;
        };
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let p = e
            .dispatch("edit.add", json!({"text":{"content":"Custom font"}}))
            .await
            .unwrap();
        let id = p["clips"][0]["id"].clone();
        let font = e
            .dispatch("fonts.import", json!({"path":source}))
            .await
            .unwrap();
        let p = e
            .dispatch("fonts.apply", json!({"id":font["id"],"clipId":id}))
            .await
            .unwrap();
        assert_eq!(p["clips"][0]["text"]["fontPath"], font["path"]);
        e.dispatch("fonts.remove", json!({"id":font["id"]}))
            .await
            .unwrap();
        assert!(e.asset_path(font["id"].as_str().unwrap(), false).is_some());
        drop(e);
        let mut e = Editor::new(dir.clone()).unwrap();
        assert_eq!(e.project["clips"][0]["text"]["fontId"], font["id"]);
        let p = e
            .dispatch(
                "edit.update",
                json!({"id":id,"patch":{"text":{"fontFamily":"Arial"}}}),
            )
            .await
            .unwrap();
        assert!(p["clips"][0]["text"].get("fontPath").is_none());
        let p = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(p["clips"][0]["text"]["fontId"], font["id"]);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn batch_is_atomic_and_undo_revision_is_monotonic() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let p = e
            .dispatch("edit.add", json!({"text":{"content":"한글 자막"}}))
            .await
            .unwrap();
        let id = p["clips"][0]["id"].clone();
        let rev = p["revision"].as_u64().unwrap();
        let fail=e.dispatch("edit.batch",json!({"commands":[{"method":"edit.update","params":{"id":id,"patch":{"start":2}}},{"method":"edit.update","params":{"id":"missing","patch":{"start":3}}}]})).await;
        assert!(fail.is_err());
        assert_eq!(e.project, p);
        let undo = e.dispatch("history.undo", json!({})).await.unwrap();
        assert!(undo["clips"].as_array().unwrap().is_empty());
        assert!(undo["revision"].as_u64().unwrap() > rev);
        let redo = e.dispatch("history.redo", json!({})).await.unwrap();
        assert_eq!(redo["clips"][0]["text"]["content"], "한글 자막");
        drop(e);
        let reopened = Editor::new(dir.clone()).unwrap();
        assert_eq!(reopened.project, redo);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn locking_and_stale_writes_are_rejected() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        e.dispatch("edit.track", json!({"id":"text-1","patch":{"locked":true}}))
            .await
            .unwrap();
        assert!(e
            .dispatch(
                "edit.add",
                json!({"trackId":"text-1","text":{"content":"x"}})
            )
            .await
            .is_err());
        assert!(e
            .dispatch(
                "project.update",
                json!({"expectedRevision":0,"patch":{"name":"stale"}})
            )
            .await
            .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn subtitles_round_trip_and_invalid_timestamp() {
        let s = "1\n00:00:01,200 --> 00:00:03,450\n첫 줄\n둘째 줄\n";
        let v = parse_srt(s).unwrap();
        assert_eq!(v[0], (1.2, 3.45, "첫 줄\n둘째 줄".into()));
        assert_eq!(srt_time(v[0].1), "00:00:03,450");
        assert!(parse_srt("1\n00:00:05,000 --> 00:00:01,000\nno").is_err());
        let spaced =
            "1\n00:00:01,000 --> 00:00:02,000\n하나\n \t\n2\n00:00:03,000 --> 00:00:04,000\n둘\n";
        let v = parse_srt(spaced).unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].2, "하나");
    }

    fn trim_project(kind: &str, reverse: bool, speed: f64) -> Value {
        let mut p = empty_project("trim", 1920, 1080, 30.0);
        p["media"] = json!([{"id":"trim-media","path":"/tmp/trim-test.mp4","kind":kind,"duration":30.0,"hasAudio":true}]);
        let track = if kind == "audio" {
            "audio-1"
        } else {
            "video-1"
        };
        let mut clip = default_clip(kind, "source", track, 10.0, 4.0);
        clip["id"] = json!("trim-clip");
        clip["mediaId"] = json!("trim-media");
        clip["sourceIn"] = json!(8.0);
        clip["speed"] = json!(speed);
        clip["reverse"] = json!(reverse);
        clip["groupId"] = json!("keep-group");
        p["clips"] = json!([clip]);
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":"neighbour","start":16.0,"duration":2.0}),
        )
        .unwrap();
        p
    }

    fn assert_close(actual: f64, expected: f64) {
        assert!((actual - expected).abs() < 1e-8, "{actual} != {expected}");
    }

    fn source_at(clip: &Value, timeline: f64) -> f64 {
        let local = timeline - number(clip, "start", 0.0);
        let source_time = if clip["reverse"] == true {
            number(clip, "duration", 0.0) - local
        } else {
            local
        };
        number(clip, "sourceIn", 0.0) + source_time * number(clip, "speed", 1.0)
    }

    #[test]
    fn trim_and_extend_preserve_forward_reverse_source_positions_at_speed() {
        for kind in ["video", "audio"] {
            for reverse in [false, true] {
                for speed in [0.5, 2.0] {
                    let original = trim_project(kind, reverse, speed);
                    for bounds in [
                        json!({"start":11.0}),
                        json!({"end":13.0}),
                        json!({"start":11.0,"end":13.0}),
                        json!({"start":9.0}),
                        json!({"end":15.0}),
                        json!({"start":9.0,"end":15.0}),
                    ] {
                        let mut p = original.clone();
                        let mut args = bounds;
                        args["id"] = json!("trim-clip");
                        mutate(&mut p, "edit.trim", &args).unwrap();
                        let trimmed = &p["clips"][0];
                        let start = number(trimmed, "start", 0.0);
                        let end = start + number(trimmed, "duration", 0.0);
                        for timeline in [start, (start + end) / 2.0, end] {
                            assert_close(
                                source_at(trimmed, timeline),
                                source_at(&original["clips"][0], timeline),
                            );
                        }
                        for field in [
                            "id",
                            "trackId",
                            "mediaId",
                            "groupId",
                            "speed",
                            "reverse",
                            "name",
                            "transform",
                            "color",
                        ] {
                            assert_eq!(trimmed[field], original["clips"][0][field]);
                        }
                        assert_eq!(p["clips"][1], original["clips"][1]);
                        assert_eq!(p["tracks"], original["tracks"]);
                        assert_eq!(p["media"], original["media"]);
                    }
                }
            }
        }
    }

    #[test]
    fn trim_can_extend_to_both_exact_media_boundaries() {
        for reverse in [false, true] {
            let mut p = trim_project("video", reverse, 2.0);
            let original = p["clips"][0].clone();
            let (start, end) = if reverse { (3.0, 18.0) } else { (6.0, 21.0) };
            mutate(
                &mut p,
                "edit.trim",
                &json!({"id":"trim-clip","start":start,"end":end}),
            )
            .unwrap();
            let trimmed = &p["clips"][0];
            assert_eq!(trimmed["sourceIn"], 0.0);
            assert_eq!(trimmed["duration"], 15.0);
            for time in [start, 10.0, 14.0, end] {
                assert_close(source_at(trimmed, time), source_at(&original, time));
            }
        }
    }

    #[test]
    fn trim_keyframes_preserve_retained_animation_and_hold_extended_edges() {
        let mut original = empty_project("animation", 1920, 1080, 30.0);
        mutate(
            &mut original,
            "edit.add",
            &json!({"text":"animated","start":5.0,"duration":8.0}),
        )
        .unwrap();
        let id = original["clips"][0]["id"].clone();
        mutate(
            &mut original,
            "edit.update",
            &json!({"id":id,"patch":{"keyframes":[
                {"property":"transform.scale","time":4.0,"value":2.0},
                {"property":"scale","time":8.0,"value":1.0},
                {"property":"x","time":0.0,"value":0.0},
                {"property":"x","time":6.0,"value":120.0},
                {"property":"volume","time":2.0,"value":0.2},
                {"property":"volume","time":8.0,"value":0.8}
            ]}}),
        )
        .unwrap();
        for (start, end) in [(7.0, 11.0), (3.0, 15.0), (3.0, 11.0), (7.0, 15.0)] {
            let mut p = original.clone();
            mutate(
                &mut p,
                "edit.trim",
                &json!({"id":id,"start":start,"end":end}),
            )
            .unwrap();
            let trimmed = &p["clips"][0];
            let duration = end - start;
            for time in [0.0, 0.5, 2.0, duration / 2.0, duration - 0.1, duration] {
                for property in ["scale", "x", "volume"] {
                    assert_close(
                        keyframe_value(trimmed, property, time),
                        keyframe_value(&original["clips"][0], property, time + start - 5.0),
                    );
                }
            }
            for keyframe in trimmed["keyframes"].as_array().unwrap() {
                assert!((0.0..=duration).contains(&number(keyframe, "time", -1.0)));
            }
        }
    }

    #[test]
    fn static_clips_extend_without_source_limits_and_trim_fades_with_metadata() {
        let mut p = trim_project("image", true, 2.0);
        let text_id = p["clips"][1]["id"].clone();
        for id in [json!("trim-clip"), text_id] {
            mutate(
                &mut p,
                "edit.trim",
                &json!({"id":id,"start":0.0,"end":100.0}),
            )
            .unwrap();
        }
        assert_eq!(p["clips"][0]["sourceIn"], 8.0);
        assert_eq!(p["clips"][1]["sourceIn"], 0.0);
        mutate(
            &mut p,
            "edit.update",
            &json!({"id":"trim-clip","patch":{
                "transitionIn":{"type":"fade","duration":4.0},
                "transitionOut":{"type":"fade","duration":3.0}
            }}),
        )
        .unwrap();
        mutate(
            &mut p,
            "edit.trim",
            &json!({"id":"trim-clip","start":10.0,"end":11.0}),
        )
        .unwrap();
        // Each fade is limited to the 1 s clip, then the two share it.
        for (fade, transition) in [("fadeIn", "transitionIn"), ("fadeOut", "transitionOut")] {
            assert_eq!(p["clips"][0][fade], 0.5);
            assert_eq!(p["clips"][0][transition]["duration"], 0.5);
        }
        assert_eq!(p["clips"][0]["sourceIn"], 8.0);
    }

    #[tokio::test]
    async fn trim_is_one_persisted_revision_and_one_undo_with_redo() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        e.project = trim_project("video", true, 2.0);
        e.persist().unwrap();
        let before = e.project.clone();
        let trimmed = e
            .dispatch(
                "edit.trim",
                json!({"id":"trim-clip","start":11.0,"end":13.0,"expectedRevision":0}),
            )
            .await
            .unwrap();
        assert_eq!(trimmed["revision"], 1);
        assert_eq!(e.undo.len(), 1);
        assert_eq!(Editor::new(dir.clone()).unwrap().project, trimmed);
        let undone = e
            .dispatch("history.undo", json!({"expectedRevision":1}))
            .await
            .unwrap();
        assert_eq!(undone["clips"], before["clips"]);
        assert_eq!(undone["revision"], 2);
        assert!(e.undo.is_empty());
        let redone = e
            .dispatch("history.redo", json!({"expectedRevision":2}))
            .await
            .unwrap();
        assert_eq!(redone["clips"], trimmed["clips"]);
        assert_eq!(redone["revision"], 3);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn invalid_trim_ranges_stale_revisions_and_locks_are_atomic() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        for reverse in [false, true] {
            e.project = trim_project("video", reverse, 2.0);
            e.persist().unwrap();
            e.refresh_missing();
            let before = e.project.clone();
            let invalid = [
                json!({}),
                json!({"start":null}),
                json!({"end":"12"}),
                json!({"start":-1.0}),
                json!({"start":14.0}),
                json!({"end":10.0}),
                json!({"start":13.99}),
                json!({"start":12.0,"end":11.0}),
                json!({"start":if reverse {2.0} else {5.0}}),
                json!({"end":if reverse {19.0} else {22.0}}),
                json!({"start":11.0,"expectedRevision":99}),
                json!({"start":11.0,"expectedRevision":"0"}),
            ];
            for mut args in invalid {
                args["id"] = json!("trim-clip");
                assert!(
                    e.dispatch("edit.trim", args.clone()).await.is_err(),
                    "accepted {args}"
                );
                assert_eq!(e.project, before);
                assert!(e.undo.is_empty());
                assert_eq!(Editor::new(dir.clone()).unwrap().project, before);
            }
            e.project["tracks"][0]["locked"] = json!(true);
            let locked = e.project.clone();
            assert!(e
                .dispatch("edit.trim", json!({"id":"trim-clip","start":11.0}))
                .await
                .is_err());
            assert_eq!(e.project, locked);
            assert!(e.undo.is_empty());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn trim_batch_is_atomic_and_multi_clip_split_is_one_undo() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        e.project = trim_project("video", false, 1.0);
        let other_id = e.project["clips"][1]["id"].clone();
        e.project["clips"][1]["start"] = json!(10.0);
        e.project["clips"][1]["duration"] = json!(4.0);
        e.persist().unwrap();
        let before = e.project.clone();
        assert!(e
            .dispatch(
                "edit.batch",
                json!({"expectedRevision":0,"commands":[
                    {"method":"edit.trim","params":{"id":"trim-clip","start":11.0}},
                    {"method":"edit.trim","params":{"id":other_id,"end":9.0}}
                ]})
            )
            .await
            .is_err());
        assert_eq!(e.project, before);
        assert!(e.undo.is_empty());
        let split = e
            .dispatch(
                "edit.batch",
                json!({"expectedRevision":0,"commands":[
                    {"method":"edit.split","params":{"id":"trim-clip","time":12.0}},
                    {"method":"edit.split","params":{"id":other_id,"time":12.0}}
                ]}),
            )
            .await
            .unwrap();
        assert_eq!(split["clips"].as_array().unwrap().len(), 4);
        assert_eq!(split["revision"], 1);
        assert_eq!(e.undo.len(), 1);
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["clips"], before["clips"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn split_reverse_source_ranges_fades_and_static_sources() {
        let mut p = trim_project("video", true, 2.0);
        mutate(
            &mut p,
            "edit.update",
            &json!({"id":"trim-clip","patch":{
                "transitionIn":{"type":"fade","duration":1.5},
                "transitionOut":{"type":"fade","duration":2.5}
            }}),
        )
        .unwrap();
        let original = p["clips"][0].clone();
        mutate(&mut p, "edit.split", &json!({"id":"trim-clip","time":11.0})).unwrap();
        assert_eq!(p["clips"][0]["sourceIn"], 14.0);
        assert_eq!(p["clips"][1]["sourceIn"], 8.0);
        for (index, times) in [(0, [10.0, 10.5, 11.0]), (1, [11.0, 12.5, 14.0])] {
            for time in times {
                assert_close(
                    source_at(&p["clips"][index], time),
                    source_at(&original, time),
                );
            }
        }
        assert_eq!(p["clips"][0]["fadeIn"], 1.0);
        assert_eq!(p["clips"][0]["fadeOut"], 0.0);
        assert_eq!(p["clips"][1]["fadeIn"], 0.0);
        assert_eq!(p["clips"][1]["fadeOut"], 2.5);
        assert!(p["clips"][0]["transitionOut"].is_null());
        assert!(p["clips"][1]["transitionIn"].is_null());
        let mut image = trim_project("image", false, 2.0);
        mutate(
            &mut image,
            "edit.split",
            &json!({"id":"trim-clip","time":11.0}),
        )
        .unwrap();
        assert_eq!(image["clips"][0]["sourceIn"], 8.0);
        assert_eq!(image["clips"][1]["sourceIn"], 8.0);
    }

    #[test]
    fn trim_and_split_allow_exactly_one_frame_including_120fps() {
        for fps in [24.0, 30.0, 60.0, 120.0] {
            let mut original = trim_project("video", false, 1.0);
            original["fps"] = json!(fps);
            let frame = 1.0 / fps;
            let mut trimmed = original.clone();
            mutate(
                &mut trimmed,
                "edit.trim",
                &json!({"id":"trim-clip","end":10.0+frame}),
            )
            .unwrap();
            assert_close(number(&trimmed["clips"][0], "duration", 0.0), frame);
            let mut split = original.clone();
            split["clips"][0]["duration"] = json!(2.0 * frame);
            mutate(
                &mut split,
                "edit.split",
                &json!({"id":"trim-clip","time":10.0+frame}),
            )
            .unwrap();
            for clip in split["clips"].as_array().unwrap().iter().take(2) {
                assert_close(number(clip, "duration", 0.0), frame);
            }
            for time in [10.0 + frame * 0.9, 14.0 - frame * 0.9] {
                let mut invalid = original.clone();
                assert!(mutate(
                    &mut invalid,
                    "edit.split",
                    &json!({"id":"trim-clip","time":time})
                )
                .is_err());
            }
        }
    }

    #[tokio::test]
    async fn one_frame_120fps_trim_survives_persistence_and_reopen() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        e.project = trim_project("video", true, 2.0);
        e.project["fps"] = json!(120.0);
        e.persist().unwrap();
        let trimmed = e
            .dispatch(
                "edit.trim",
                json!({"id":"trim-clip","end":10.0+1.0/120.0,"expectedRevision":0}),
            )
            .await
            .unwrap();
        assert_close(number(&trimmed["clips"][0], "duration", 0.0), 1.0 / 120.0);
        drop(e);
        assert_eq!(Editor::new(dir.clone()).unwrap().project, trimmed);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn split_keeps_source_ranges() {
        let mut p = empty_project("test", 1920, 1080, 30.0);
        p["media"] = json!([{"id":"m","path":"/tmp/test.mp4","kind":"video","duration":20.0,"hasAudio":true}]);
        mutate(
            &mut p,
            "edit.add",
            &json!({"mediaId":"m","start":2.0,"duration":8.0}),
        )
        .unwrap();
        let id = p["clips"][0]["id"].clone();
        mutate(&mut p, "edit.split", &json!({"id":id,"time":5.0})).unwrap();
        assert_eq!(p["clips"][0]["duration"], 3.0);
        assert_eq!(p["clips"][1]["sourceIn"], 3.0);
        assert_eq!(p["clips"][1]["duration"], 5.0);
    }
    #[test]
    fn split_preserves_animation_at_boundary_and_after() {
        let mut p = empty_project("test", 1920, 1080, 30.0);
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":{"content":"animated"},"start":1.0,"duration":8.0}),
        )
        .unwrap();
        let id = p["clips"][0]["id"].clone();
        mutate(&mut p,"edit.update",&json!({"id":id,"patch":{"keyframes":[{"property":"transform.scale","time":4.0,"value":2.0},{"property":"scale","time":8.0,"value":1.0},{"property":"x","time":0.0,"value":0.0},{"property":"x","time":6.0,"value":120.0}]}})).unwrap();
        let original = p["clips"][0].clone();
        mutate(&mut p, "edit.split", &json!({"id":id,"time":3.0})).unwrap();
        assert!((keyframe_value(&p["clips"][0], "scale", 2.0) - 1.5).abs() < 0.00001);
        assert!((keyframe_value(&p["clips"][1], "scale", 0.0) - 1.5).abs() < 0.00001);
        for time in [0.0, 0.5, 2.0, 3.5, 5.0] {
            for property in ["scale", "x"] {
                assert!(
                    (keyframe_value(&p["clips"][1], property, time)
                        - keyframe_value(&original, property, time + 2.0))
                    .abs()
                        < 0.00001
                );
            }
        }
        let right_id = p["clips"][1]["id"].clone();
        assert!(mutate(
            &mut p,
            "edit.update",
            &json!({"id":right_id,"patch":{"crop":{"x":0.9,"width":0.5}}})
        )
        .is_err());
    }
    #[test]
    fn groups_bulk_duplicates_and_ripple_union() {
        let mut p = empty_project("groups", 320, 180, 24.0);
        for start in [0.0, 2.0] {
            mutate(
                &mut p,
                "edit.add",
                &json!({"text":{"content":"clip"},"start":start,"duration":1.0}),
            )
            .unwrap();
        }
        let ids: Vec<_> = p["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].clone())
            .collect();
        mutate(&mut p, "edit.group", &json!({"ids":ids})).unwrap();
        let original_group = p["clips"][0]["groupId"].clone();
        assert_eq!(original_group, p["clips"][1]["groupId"]);
        mutate(&mut p, "edit.duplicate", &json!({"ids":ids})).unwrap();
        assert_eq!(p["clips"][2]["start"], 3.0);
        assert_eq!(p["clips"][3]["start"], 5.0);
        assert_eq!(p["clips"][2]["groupId"], p["clips"][3]["groupId"]);
        assert_ne!(original_group, p["clips"][2]["groupId"]);
        let copies = vec![p["clips"][2]["id"].clone(), p["clips"][3]["id"].clone()];
        mutate(&mut p, "edit.ungroup", &json!({"ids":copies})).unwrap();
        assert!(p["clips"][2].get("groupId").is_none());
        assert_eq!(p["clips"][0]["groupId"], original_group);
        let mut p = empty_project("ripple", 320, 180, 24.0);
        for (start, duration) in [(0.0, 2.0), (1.0, 2.0), (4.0, 1.0)] {
            mutate(
                &mut p,
                "edit.add",
                &json!({"text":{"content":"clip"},"start":start,"duration":duration}),
            )
            .unwrap();
        }
        let removed = vec![p["clips"][0]["id"].clone(), p["clips"][1]["id"].clone()];
        mutate(&mut p, "edit.delete", &json!({"ids":removed,"ripple":true})).unwrap();
        assert_eq!(p["clips"][0]["start"], 1.0);
    }
    #[test]
    fn invalid_color_curves_and_stabilization_are_rejected() {
        let mut p = empty_project("invalid", 320, 180, 24.0);
        mutate(&mut p, "edit.add", &json!({"text":{"content":"text"}})).unwrap();
        let id = p["clips"][0]["id"].clone();
        for patch in [
            json!({"color":{"curves":{"master":[[0,0],[0.5,0.5],[0.4,0.8],[1,1]]}}}),
            json!({"color":{"hsl":{"red":{"hue":181}}}}),
            json!({"stabilize":{"enabled":true,"strength":2}}),
        ] {
            let mut candidate = p.clone();
            assert!(mutate(
                &mut candidate,
                "edit.update",
                &json!({"id":id,"patch":patch})
            )
            .is_err());
        }
    }

    // The exact shape written by builds that predate schemaVersion, including
    // the filter ids the UI stored and a zero-length fade transition.
    fn v1_project() -> Value {
        json!({"id":"project-legacy","name":"여행 브이로그","revision":41,"width":1080,"height":1920,
            "fps":30.0,"background":"#111111","updatedAt":1700000000000u64,
            "concept":{"audience":"친구","message":"쉼","appeal":"","direction":""},
            "media":[{"id":"media-1","name":"clip.mp4","path":"/nonexistent/clip.mp4","kind":"video",
                "duration":12.5,"width":1920,"height":1080,"hasAudio":true,"thumbnail":"/nonexistent/t.jpg","waveform":[0.1,0.4]}],
            "tracks":[{"id":"video-1","name":"영상 1","kind":"video","muted":false,"hidden":false,"locked":false},
                {"id":"audio-1","name":"오디오 1","kind":"audio","muted":false,"hidden":false,"locked":false},
                {"id":"text-1","name":"텍스트 1","kind":"text","muted":false,"hidden":false,"locked":true}],
            "clips":[{"id":"clip-1","name":"clip.mp4","kind":"video","trackId":"video-1","mediaId":"media-1",
                "start":0.0,"duration":4.0,"sourceIn":1.0,"speed":1.0,"reverse":false,"volume":0.8,
                "fadeIn":0.5,"fadeOut":0.0,"filter":"cinema","transitionIn":{"type":"fade","duration":0.2},
                "transitionOut":{"type":"fade","duration":0.0},
                "transform":{"x":0.0,"y":0.0,"scale":1.2,"rotation":0.0,"opacity":1.0,"flipX":true},
                "color":{"brightness":-0.02,"contrast":1.15,"saturation":0.85,"temperature":0.0,"hue":12.0},
                "keyframes":[{"property":"opacity","time":1.0,"value":0.5}],"groupId":"group-1"},
              {"id":"clip-2","name":"자막","kind":"text","trackId":"text-1","start":1.0,"duration":2.0,
                "sourceIn":0.0,"speed":1.0,"reverse":false,"volume":1.0,"fadeIn":0.0,"fadeOut":0.0,"filter":"original",
                "transform":{"x":0.0,"y":614.4,"scale":1.0,"rotation":0.0,"opacity":1.0},
                "color":{"brightness":0.0,"contrast":1.0,"saturation":1.0,"temperature":0.0},"keyframes":[],
                "text":{"content":"자막","fontSize":64,"color":"#ffffff","fontFamily":"sans-serif","bold":false,"align":"center","background":"transparent"}}],
            "markers":[{"id":"marker-1","time":2.0,"label":"컷"}],
            "notes":[{"id":"note-1","body":"메모","kind":"context","createdAt":1700000000000u64}]})
    }

    fn write_json(path: &Path, value: &Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn corrupt_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("current.json.corrupt-")
            })
            .collect()
    }

    #[tokio::test]
    async fn existing_v1_project_opens_unchanged_apart_from_documented_repairs() {
        let dir = temp();
        let legacy = v1_project();
        write_json(&dir.join("current.json"), &legacy);
        let mut e = Editor::new(dir.clone()).unwrap();
        assert_eq!(
            e.dispatch("project.notice", json!({})).await.unwrap()["notice"],
            Value::Null
        );
        assert!(corrupt_files(&dir).is_empty());
        let p = e.dispatch("project.get", json!({})).await.unwrap();
        assert_eq!(p["schemaVersion"], 2);
        let mut expected = legacy.clone();
        expected["schemaVersion"] = json!(2);
        expected["media"][0]["missing"] = json!(true);
        expected["clips"][0]["filter"] = json!("cinematic");
        expected["clips"][0]["transitionIn"]["duration"] = json!(0.5);
        expected["clips"][0]["transitionOut"] = Value::Null;
        expected["clips"][1]["filter"] = json!("none");
        assert_eq!(p, expected);
        // Editing and reopening keeps working on the migrated file.
        let edited = e
            .dispatch(
                "edit.update",
                json!({"id":"clip-1","patch":{"start":1.0},"expectedRevision":41}),
            )
            .await
            .unwrap();
        assert_eq!(edited["revision"], 42);
        drop(e);
        assert_eq!(Editor::new(dir.clone()).unwrap().project, edited);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn long_caption_text_is_editable_and_opens_from_v1_with_a_shortened_name() {
        let dir = temp();
        let long = "가".repeat(2000); // 6000 bytes: valid content, too long for a name
        let mut legacy = v1_project();
        legacy["clips"][1]["text"]["content"] = json!(long);
        legacy["clips"][1]["name"] = json!(long);
        legacy["tracks"][0]["name"] = json!(long);
        legacy["tracks"][2]["locked"] = json!(false);
        legacy["markers"][0]["label"] = json!(long);
        write_json(&dir.join("current.json"), &legacy);
        let mut e = Editor::new(dir.clone()).unwrap();
        assert!(corrupt_files(&dir).is_empty());
        assert_eq!(e.project["id"], legacy["id"]);
        let short = "가".repeat(333);
        assert_eq!(e.project["clips"][1]["text"]["content"], long.as_str());
        assert_eq!(e.project["clips"][1]["name"], short.as_str());
        assert_eq!(e.project["tracks"][0]["name"], short.as_str());
        assert_eq!(e.project["markers"][0]["label"], short.as_str());

        let p = e
            .dispatch("edit.add", json!({"text":{"content":long},"start":10.0}))
            .await
            .unwrap();
        let added = p["clips"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(added["text"]["content"], long.as_str());
        assert_eq!(added["name"], short.as_str());
        let longer = format!("a{long}");
        let p = e
            .dispatch(
                "edit.update",
                json!({"id":"clip-2","patch":{"text":{"content":longer}}}),
            )
            .await
            .unwrap();
        assert_eq!(p["clips"][1]["text"]["content"], longer.as_str());
        assert_eq!(
            p["clips"][1]["name"],
            format!("a{}", "가".repeat(333)).as_str()
        );
        drop(e);
        assert_eq!(Editor::new(dir.clone()).unwrap().project, p);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn presets_with_legacy_filter_ids_still_apply_and_import() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let p = e
            .dispatch("edit.add", json!({"text":{"content":"preset"}}))
            .await
            .unwrap();
        let id = p["clips"][0]["id"].clone();
        e.dispatch(
            "edit.update",
            json!({"id":id,"patch":{"color":{"hue":12.0}}}),
        )
        .await
        .unwrap();
        // A catalog written by the previous build, and a file exported from it.
        let preset = |filter: &str| {
            json!({"version":1,"id":format!("preset-{filter}"),"name":filter,"kind":"filter","target":"visual",
            "sourceDuration":4.0,"patch":{"filter":filter,"color":{"brightness":0.1,"contrast":1.2,"saturation":0.9,"temperature":0.0}}})
        };
        write_json(
            &dir.join("catalog/index.json"),
            &json!({"version":1,"presets":[preset("cinema"), preset("vivid")],"fonts":[],"luts":[]}),
        );
        for (filter, expected) in [("cinema", "cinematic"), ("vivid", "none")] {
            let p = e
                .dispatch(
                    "presets.apply",
                    json!({"id":format!("preset-{filter}"),"clipId":id}),
                )
                .await
                .unwrap();
            assert_eq!(p["clips"][0]["filter"], expected);
            assert_eq!(p["clips"][0]["color"]["contrast"], 1.2);
            assert_eq!(p["clips"][0]["color"]["hue"], 12.0);
        }
        let file = dir.join("old-preset.json");
        write_json(&file, &preset("soft"));
        let imported = e
            .dispatch("presets.import", json!({"path":file}))
            .await
            .unwrap();
        let p = e
            .dispatch("presets.apply", json!({"id":imported["id"],"clipId":id}))
            .await
            .unwrap();
        assert_eq!(p["clips"][0]["filter"], "none");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn migration_repairs_sloppy_v1_fields_and_rejects_newer_files() {
        let mut p = v1_project();
        for field in [
            "sourceIn",
            "speed",
            "volume",
            "fadeOut",
            "reverse",
            "keyframes",
            "color",
        ] {
            p["clips"][0].as_object_mut().unwrap().remove(field);
        }
        p["clips"][0]["fadeIn"] = json!(9.0);
        p["clips"][0]["transitionOut"] = json!("dissolve");
        p["clips"][0]["filter"] = json!(3);
        p["clips"][1]["name"] = json!(7);
        p["tracks"][0].as_object_mut().unwrap().remove("muted");
        p["markers"] = json!([{"time":1.0},{"id":"m","time":-4,"label":"x"},"junk",{"id":"keep","time":3.0,"label":5}]);
        p["notes"] = json!([{"body":"ok"}, 3, {"id":"n"}]);
        p.as_object_mut().unwrap().remove("concept");
        assert!(validate_project(&p).is_err());
        migrate_project(&mut p).unwrap();
        validate_project(&p).unwrap();
        let clip = &p["clips"][0];
        assert_eq!(clip["speed"], 1.0);
        assert_eq!(clip["fadeIn"], 4.0);
        assert_eq!(clip["transitionIn"], json!({"type":"fade","duration":4.0}));
        assert!(clip["transitionOut"].is_null());
        assert_eq!(clip["filter"], "none");
        assert_eq!(clip["color"]["contrast"], 1.0);
        assert_eq!(p["markers"].as_array().unwrap().len(), 2);
        assert_eq!(
            p["markers"][1],
            json!({"id":"keep","time":3.0,"label":"마커"})
        );
        assert_eq!(p["notes"], json!([{"body":"ok"}]));
        let migrated = p.clone();
        migrate_project(&mut p).unwrap();
        assert_eq!(p, migrated, "v2 files are left alone");
        p["schemaVersion"] = json!(3);
        assert!(migrate_project(&mut p.clone()).is_err());
        assert!(validate_project(&p).is_err());
        assert!(migrate_project(&mut json!([])).is_err());
    }

    #[tokio::test]
    async fn unreadable_current_file_is_kept_and_startup_recovers() {
        // Broken JSON: fall back to the newest valid stored project.
        let dir = temp();
        let mut older = v1_project();
        older["id"] = json!("project-older");
        older["updatedAt"] = json!(5);
        write_json(&dir.join("projects/project-older.json"), &older);
        write_json(&dir.join("projects/project-legacy.json"), &v1_project());
        std::fs::write(dir.join("projects/broken.json"), "{").unwrap();
        std::fs::write(dir.join("current.json"), "{\"id\":\"project-legacy\",").unwrap();
        let mut e = Editor::new(dir.clone()).unwrap();
        assert_eq!(e.project["id"], "project-legacy");
        let kept = corrupt_files(&dir);
        assert_eq!(kept.len(), 1);
        assert_eq!(
            std::fs::read_to_string(&kept[0]).unwrap(),
            "{\"id\":\"project-legacy\","
        );
        let notice = e.dispatch("project.notice", json!({})).await.unwrap();
        assert!(notice["notice"].as_str().unwrap().contains("여행 브이로그"));
        assert_eq!(
            e.dispatch("project.noticeDismiss", json!({}))
                .await
                .unwrap(),
            json!({"notice":null})
        );
        assert!(e.dispatch("project.notice", json!({})).await.unwrap()["notice"].is_null());
        drop(e);
        let mut e = Editor::new(dir.clone()).unwrap();
        assert!(e.dispatch("project.notice", json!({})).await.unwrap()["notice"].is_null());
        assert_eq!(corrupt_files(&dir).len(), 1);
        std::fs::remove_dir_all(dir).unwrap();

        // Valid JSON that fails validation, or a newer schema, and nothing to fall back to.
        for broken in [json!({"id":"project-x","name":"x"}), {
            let mut p = v1_project();
            p["schemaVersion"] = json!(99);
            p
        }] {
            let dir = temp();
            write_json(&dir.join("current.json"), &broken);
            let mut e = Editor::new(dir.clone()).unwrap();
            assert!(e.project["clips"].as_array().unwrap().is_empty());
            assert_ne!(e.project["id"], broken["id"]);
            assert!(e.dispatch("project.notice", json!({})).await.unwrap()["notice"].is_string());
            assert_eq!(corrupt_files(&dir).len(), 1);
            e.dispatch("edit.add", json!({"text":{"content":"계속 작업"}}))
                .await
                .unwrap();
            std::fs::remove_dir_all(dir).unwrap();
        }
    }

    #[tokio::test]
    async fn project_lifecycle_new_list_open_rename_duplicate_delete() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let first = e.project["id"].as_str().unwrap().to_owned();
        e.dispatch("edit.add", json!({"text":{"content":"첫 프로젝트"}}))
            .await
            .unwrap();
        let second = e
            .dispatch(
                "project.new",
                json!({"name":"두 번째","width":1080,"height":1920,"fps":24}),
            )
            .await
            .unwrap();
        assert_eq!(
            (second["width"].clone(), second["fps"].clone()),
            (json!(1080), json!(24.0))
        );
        assert_eq!(second["schemaVersion"], 2);
        assert!(e.undo.is_empty());
        let second_id = second["id"].as_str().unwrap().to_owned();
        let list = e.dispatch("project.list", json!({})).await.unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert_eq!(list[0]["id"], second_id.as_str());

        // Conditional get.
        let revision = second["revision"].clone();
        assert_eq!(
            e.dispatch(
                "project.get",
                json!({"ifProjectId":second_id,"ifRevision":revision})
            )
            .await
            .unwrap(),
            json!({"unchanged":true,"id":second_id,"revision":revision,"missing":[]})
        );
        for params in [
            json!({"ifProjectId":first,"ifRevision":revision}),
            json!({"ifProjectId":second_id,"ifRevision":0}),
            json!({"ifProjectId":second_id}),
            json!({"ifRevision":revision}),
            json!({}),
        ] {
            assert_eq!(e.dispatch("project.get", params).await.unwrap(), e.project);
        }

        // Rename: a stored project, then the open one.
        let list = e
            .dispatch("project.rename", json!({"id":first,"name":"  이름 바꿈 "}))
            .await
            .unwrap();
        assert!(list
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["id"] == first.as_str() && p["name"] == "이름 바꿈"));
        assert_eq!(e.project["revision"], revision);
        e.dispatch(
            "project.rename",
            json!({"id":second_id,"name":"열린 프로젝트"}),
        )
        .await
        .unwrap();
        assert_eq!(e.project["name"], "열린 프로젝트");
        assert_eq!(
            e.project["revision"].as_u64(),
            revision.as_u64().map(|r| r + 1)
        );
        for params in [
            json!({"id":first,"name":""}),
            json!({"id":"nope","name":"x"}),
            json!({"id":"../x","name":"x"}),
        ] {
            assert!(e.dispatch("project.rename", params).await.is_err());
        }

        // Duplicate does not switch projects and copies project-owned LUTs.
        let lut = e.assets_dir(&first).join("luts/look.cube");
        std::fs::create_dir_all(lut.parent().unwrap()).unwrap();
        std::fs::write(&lut, "LUT_3D_SIZE 2\n").unwrap();
        let mut stored: Value =
            serde_json::from_slice(&std::fs::read(e.project_file(&first)).unwrap()).unwrap();
        stored["clips"][0]["color"]["lut"] = json!({"path":lut,"name":"look","enabled":true});
        write_json(&e.project_file(&first), &stored);
        let copy = e
            .dispatch("project.duplicate", json!({"id":first}))
            .await
            .unwrap();
        assert_eq!(copy["name"], "이름 바꿈 사본");
        assert_eq!(e.project["id"], second_id.as_str());
        let copy_id = copy["id"].as_str().unwrap().to_owned();
        let opened = e
            .dispatch("project.open", json!({"id":copy_id}))
            .await
            .unwrap();
        assert_eq!(opened["clips"][0]["text"]["content"], "첫 프로젝트");
        let copied_lut =
            PathBuf::from(opened["clips"][0]["color"]["lut"]["path"].as_str().unwrap());
        assert_eq!(copied_lut, e.assets_dir(&copy_id).join("luts/look.cube"));
        assert!(copied_lut.is_file());

        // Delete: never the open project; removes the file and its assets only.
        assert!(e
            .dispatch("project.delete", json!({"id":copy_id}))
            .await
            .is_err());
        assert!(e
            .dispatch("project.delete", json!({"id":"missing"}))
            .await
            .is_err());
        assert!(e.dispatch("project.delete", json!({})).await.is_err());
        let list = e
            .dispatch("project.delete", json!({"id":first}))
            .await
            .unwrap();
        assert_eq!(list.as_array().unwrap().len(), 2);
        assert!(!e.project_file(&first).exists() && !e.assets_dir(&first).exists());
        assert!(copied_lut.is_file());
        assert!(e
            .dispatch("project.open", json!({"id":first}))
            .await
            .is_err());
        assert_eq!(e.project["id"], copy_id.as_str());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn save_requires_overwrite_remembers_the_file_and_protects_store_and_sources() {
        let dir = temp();
        let out = temp();
        std::fs::create_dir_all(&out).unwrap();
        let mut e = Editor::new(dir.join("state")).unwrap();
        let source = out.join("source.wav");
        write_wav(&source, 8_000);
        e.dispatch("media.import", json!({"paths":[source]}))
            .await
            .unwrap();

        // Without a path the store copy is the target.
        let saved = e.dispatch("project.save", json!({})).await.unwrap();
        assert_eq!(
            PathBuf::from(saved["path"].as_str().unwrap()),
            e.project_file(e.project["id"].as_str().unwrap())
        );

        let file = out.join("my.byori.json");
        let saved = e
            .dispatch("project.save", json!({"path":file}))
            .await
            .unwrap();
        assert_eq!(saved["project"], e.project);
        // Later plain saves go to the remembered file, including new edits.
        e.dispatch("project.update", json!({"patch":{"name":"저장됨"}}))
            .await
            .unwrap();
        let saved = e.dispatch("project.save", json!({})).await.unwrap();
        assert_eq!(PathBuf::from(saved["path"].as_str().unwrap()), file);
        assert_eq!(load_project(&file).unwrap()["name"], "저장됨");

        let other = out.join("other.json");
        std::fs::write(&other, "keep").unwrap();
        let error = e
            .dispatch("project.save", json!({"path":other}))
            .await
            .unwrap_err();
        assert!(error.contains("FILE_EXISTS"), "{error}");
        assert!(e
            .dispatch("project.save", json!({"path":other,"overwrite":false}))
            .await
            .is_err());
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "keep");
        e.dispatch("project.save", json!({"path":other,"overwrite":true}))
            .await
            .unwrap();
        assert_eq!(load_project(&other).unwrap()["id"], e.project["id"]);

        let source_bytes = std::fs::read(&source).unwrap();
        for target in [
            json!(source),
            json!(dir.join("state/current.json")),
            json!(dir.join("state/projects/another.json")),
            json!(dir.join("state/catalog/index.json")),
        ] {
            for method in ["project.save", "captions.export"] {
                let error = e
                    .dispatch(method, json!({"path":target,"overwrite":true}))
                    .await
                    .unwrap_err();
                assert!(!error.contains("FILE_EXISTS"), "{error}");
            }
        }
        assert_eq!(std::fs::read(&source).unwrap(), source_bytes);
        // The store's exports folder is output space: new files only, like any other folder.
        let exported = dir.join("state/exports/captions.srt");
        std::fs::create_dir_all(exported.parent().unwrap()).unwrap();
        std::fs::write(&exported, "keep").unwrap();
        let error = e
            .dispatch(
                "captions.export",
                json!({"path":exported,"overwrite":false}),
            )
            .await
            .unwrap_err();
        assert!(error.contains("FILE_EXISTS"), "{error}");
        let copy = dir.join("state/exports/copy.json");
        e.dispatch("project.save", json!({"path":copy,"overwrite":false}))
            .await
            .unwrap();
        assert_eq!(load_project(&copy).unwrap()["id"], e.project["id"]);

        // Opening by path remembers that file; switching projects forgets it.
        let id = e.project["id"].clone();
        e.dispatch("project.new", json!({})).await.unwrap();
        assert!(e.file_path.is_none());
        let opened = e
            .dispatch("project.open", json!({"path":file}))
            .await
            .unwrap();
        assert_eq!(opened["id"], id);
        e.dispatch("edit.marker", json!({"time":1.0}))
            .await
            .unwrap();
        e.dispatch("project.save", json!({})).await.unwrap();
        assert_eq!(
            load_project(&file).unwrap()["markers"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(out).unwrap();
    }

    #[tokio::test]
    async fn captions_import_and_export_through_dispatch() {
        let dir = temp();
        let out = temp();
        std::fs::create_dir_all(&out).unwrap();
        let mut e = Editor::new(dir.clone()).unwrap();
        assert!(e
            .dispatch("captions.export", json!({"path":out.join("empty.srt")}))
            .await
            .is_err());
        let input = out.join("in.srt");
        std::fs::write(&input, "\u{feff}1\r\n00:00:01,000 --> 00:00:02,500\r\n첫 자막\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n둘째\r\n줄\r\n").unwrap();
        assert!(e
            .dispatch(
                "captions.import",
                json!({"path":input,"expectedRevision":7})
            )
            .await
            .is_err());
        let p = e
            .dispatch(
                "captions.import",
                json!({"path":input,"expectedRevision":0}),
            )
            .await
            .unwrap();
        assert_eq!(p["revision"], 1);
        assert_eq!(e.undo.len(), 1, "one undo for the whole file");
        assert_eq!(p["clips"].as_array().unwrap().len(), 2);
        assert_eq!(
            (
                p["clips"][0]["start"].clone(),
                p["clips"][0]["duration"].clone()
            ),
            (json!(1.0), json!(1.5))
        );
        assert_eq!(p["clips"][1]["text"]["content"], "둘째\n줄");
        assert_eq!(p["clips"][1]["trackId"], "text-1");

        let exported = out.join("out.srt");
        e.dispatch("captions.export", json!({"path":exported}))
            .await
            .unwrap();
        let text = std::fs::read_to_string(&exported).unwrap();
        assert_eq!(text, "1\n00:00:01,000 --> 00:00:02,500\n첫 자막\n\n2\n00:00:03,000 --> 00:00:04,000\n둘째\n줄\n");
        let error = e
            .dispatch("captions.export", json!({"path":exported}))
            .await
            .unwrap_err();
        assert!(error.contains("FILE_EXISTS"), "{error}");
        e.dispatch("captions.export", json!({"path":exported,"overwrite":true}))
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_dir(&out).unwrap().count(),
            2,
            "no temporary files left"
        );
        assert_eq!(e.project["revision"], 1);

        std::fs::write(&input, "1\n00:00:05,000 --> 00:00:01,000\n거꾸로\n").unwrap();
        let before = e.project.clone();
        assert!(e
            .dispatch("captions.import", json!({"path":input}))
            .await
            .is_err());
        assert!(e
            .dispatch("captions.import", json!({"path":out.join("none.srt")}))
            .await
            .is_err());
        assert_eq!(e.project, before);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(out).unwrap();
    }

    #[tokio::test]
    async fn markers_add_update_delete_and_are_validated() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let p = e
            .dispatch("edit.marker", json!({"time":2.5,"label":"인트로"}))
            .await
            .unwrap();
        let id = p["markers"][0]["id"].clone();
        let p = e
            .dispatch("edit.marker", json!({"time":4.0}))
            .await
            .unwrap();
        assert_eq!(p["markers"][1]["label"], "마커");
        let p = e
            .dispatch(
                "edit.markerUpdate",
                json!({"id":id,"time":3.0,"expectedRevision":2}),
            )
            .await
            .unwrap();
        assert_eq!(
            p["markers"][0],
            json!({"id":id,"time":3.0,"label":"인트로"})
        );
        let p = e
            .dispatch("edit.markerUpdate", json!({"id":id,"label":"본편"}))
            .await
            .unwrap();
        assert_eq!(p["markers"][0], json!({"id":id,"time":3.0,"label":"본편"}));
        let before = e.project.clone();
        for (method, params) in [
            ("edit.marker", json!({"time":-1.0})),
            ("edit.marker", json!({"label":"x"})),
            ("edit.markerUpdate", json!({"id":id,"time":-1})),
            ("edit.markerUpdate", json!({"id":id,"time":"3"})),
            ("edit.markerUpdate", json!({"id":id,"label":4})),
            ("edit.markerUpdate", json!({"id":"missing","time":1})),
            (
                "edit.markerUpdate",
                json!({"id":id,"time":1,"expectedRevision":0}),
            ),
            ("edit.markerDelete", json!({"id":"missing"})),
            ("edit.markerDelete", json!({})),
            (
                "project.update",
                json!({"patch":{"markers":[{"id":"a","time":"soon","label":"x"}]}}),
            ),
            (
                "project.update",
                json!({"patch":{"markers":[{"id":"a","time":1},{"id":"a","time":2}]}}),
            ),
            ("project.update", json!({"patch":{"markers":["x"]}})),
            ("project.update", json!({"patch":{"notes":[{"id":"n"}]}})),
            ("project.update", json!({"patch":{"notes":[3]}})),
        ] {
            assert!(
                e.dispatch(method, params.clone()).await.is_err(),
                "accepted {method} {params}"
            );
            assert_eq!(e.project, before);
        }
        e.dispatch(
            "project.update",
            json!({"patch":{"notes":[{"id":"n","body":"메모","kind":"context","createdAt":1}]}}),
        )
        .await
        .unwrap();
        let second = e.project["markers"][1]["id"].clone();
        let p = e
            .dispatch(
                "edit.batch",
                json!({"commands":[
                {"method":"edit.markerDelete","params":{"id":id}},
                {"method":"edit.markerUpdate","params":{"id":second,"label":"끝"}}]}),
            )
            .await
            .unwrap();
        assert_eq!(p["markers"], json!([{"id":second,"time":4.0,"label":"끝"}]));
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["markers"], before["markers"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn track_delete_and_move_are_single_undo_and_respect_locks() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        e.dispatch("edit.add", json!({"text":{"content":"남는 자막"}}))
            .await
            .unwrap();
        let p = e
            .dispatch("edit.track", json!({"kind":"text","name":"자막 2"}))
            .await
            .unwrap();
        let extra = p["tracks"][3]["id"].clone();
        for content in ["지울 자막 1", "지울 자막 2"] {
            e.dispatch(
                "edit.add",
                json!({"text":{"content":content},"trackId":extra}),
            )
            .await
            .unwrap();
        }
        let before = e.project.clone();
        let undo_count = e.undo.len();

        e.dispatch("edit.track", json!({"id":extra,"patch":{"locked":true}}))
            .await
            .unwrap();
        assert!(e
            .dispatch("edit.trackDelete", json!({"id":extra}))
            .await
            .is_err());
        e.dispatch("history.undo", json!({})).await.unwrap();
        for params in [
            json!({"id":"missing"}),
            json!({}),
            json!({"id":extra,"expectedRevision":0}),
        ] {
            assert!(e.dispatch("edit.trackDelete", params).await.is_err());
        }
        assert_eq!(e.project["clips"], before["clips"]);

        let p = e
            .dispatch("edit.trackDelete", json!({"id":extra}))
            .await
            .unwrap();
        assert_eq!(p["tracks"].as_array().unwrap().len(), 3);
        assert_eq!(p["clips"].as_array().unwrap().len(), 1);
        assert_eq!(p["clips"][0]["text"]["content"], "남는 자막");
        assert_eq!(e.undo.len(), undo_count + 1);
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(
            (&undone["tracks"], &undone["clips"]),
            (&before["tracks"], &before["clips"])
        );

        let order = |p: &Value| -> Vec<Value> {
            p["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["id"].clone())
                .collect()
        };
        let p = e
            .dispatch("edit.trackMove", json!({"id":extra,"index":0}))
            .await
            .unwrap();
        assert_eq!(
            order(&p),
            vec![
                extra.clone(),
                json!("video-1"),
                json!("audio-1"),
                json!("text-1")
            ]
        );
        assert_eq!(p["clips"], before["clips"]);
        let p = e
            .dispatch(
                "edit.batch",
                json!({"commands":[
                {"method":"edit.trackMove","params":{"id":"video-1","index":3}},
                {"method":"edit.trackDelete","params":{"id":"audio-1"}}]}),
            )
            .await
            .unwrap();
        assert_eq!(
            order(&p),
            vec![extra.clone(), json!("text-1"), json!("video-1")]
        );
        let current = e.project.clone();
        for params in [
            json!({"id":extra,"index":3}),
            json!({"id":extra,"index":-1}),
            json!({"id":extra}),
            json!({"id":"missing","index":0}),
        ] {
            assert!(e.dispatch("edit.trackMove", params).await.is_err());
            assert_eq!(e.project, current);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn paste_inserts_copies_with_new_ids_groups_spacing_and_track_fallback() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        for start in [2.0, 5.0] {
            e.dispatch(
                "edit.add",
                json!({"text":{"content":"복사"},"start":start,"duration":1.0}),
            )
            .await
            .unwrap();
        }
        let ids: Vec<Value> = e.project["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].clone())
            .collect();
        let p = e.dispatch("edit.group", json!({"ids":ids})).await.unwrap();
        let copied = p["clips"].clone();
        let undo_count = e.undo.len();
        let p = e
            .dispatch(
                "edit.paste",
                json!({"clips":copied,"at":10.0,"expectedRevision":p["revision"]}),
            )
            .await
            .unwrap();
        assert_eq!(e.undo.len(), undo_count + 1);
        let clips = p["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 4);
        assert_eq!(
            (clips[2]["start"].clone(), clips[3]["start"].clone()),
            (json!(10.0), json!(13.0))
        );
        assert_eq!(clips[2]["groupId"], clips[3]["groupId"]);
        assert_ne!(clips[2]["groupId"], clips[0]["groupId"]);
        assert_eq!(
            clips
                .iter()
                .map(|c| c["id"].as_str().unwrap())
                .collect::<HashSet<_>>()
                .len(),
            4
        );
        let mut expected = copied[0].clone();
        for field in ["id", "start", "groupId"] {
            expected[field] = clips[2][field].clone();
        }
        assert_eq!(clips[2], expected);

        // Source track gone, then locked: use the first compatible unlocked track.
        let p = e
            .dispatch("edit.track", json!({"kind":"text","name":"자막 2"}))
            .await
            .unwrap();
        let second = p["tracks"][3]["id"].clone();
        let mut foreign = copied[0].clone();
        foreign["trackId"] = json!("track-from-another-project");
        foreign["unknownField"] = json!({"x":1});
        let p = e
            .dispatch("edit.paste", json!({"clips":[foreign],"at":0.0}))
            .await
            .unwrap();
        let pasted = p["clips"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(
            (pasted["trackId"].clone(), pasted["start"].clone()),
            (json!("text-1"), json!(0.0))
        );
        assert!(pasted.get("unknownField").is_none());
        e.dispatch("edit.track", json!({"id":"text-1","patch":{"locked":true}}))
            .await
            .unwrap();
        let p = e
            .dispatch("edit.batch", json!({"commands":[{"method":"edit.paste","params":{"clips":[copied[1]],"at":1.0}}]}))
            .await
            .unwrap();
        assert_eq!(
            p["clips"].as_array().unwrap().last().unwrap()["trackId"],
            second
        );
        e.dispatch("edit.track", json!({"id":second,"patch":{"locked":true}}))
            .await
            .unwrap();

        let before = e.project.clone();
        let mut no_media = copied[0].clone();
        no_media["kind"] = json!("video");
        no_media["mediaId"] = json!("media-from-another-project");
        for params in [
            json!({"clips":copied,"at":1.0}),
            json!({"clips":[],"at":1.0}),
            json!({"clips":["x"],"at":1.0}),
            json!({"clips":[no_media],"at":1.0}),
            json!({"clips":[copied[0]],"at":-1.0}),
            json!({"clips":[copied[0]]}),
            json!({"at":1.0}),
        ] {
            assert!(
                e.dispatch("edit.paste", params.clone()).await.is_err(),
                "accepted {params}"
            );
            assert_eq!(e.project, before);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn filter_merges_basic_grade_and_fades_stay_in_sync_with_transitions() {
        let mut p = empty_project("filter", 320, 180, 24.0);
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":{"content":"text"},"duration":4.0}),
        )
        .unwrap();
        let id = p["clips"][0]["id"].clone();
        let update =
            |p: &mut Value, patch: Value| mutate(p, "edit.update", &json!({"id":id,"patch":patch}));
        let lut = json!({"path":"/tmp/look.cube","name":"look","enabled":true});
        update(&mut p, json!({"color":{"hue":20.0,"hsl":{"red":{"hue":30.0}},"curves":{"preset":"vintage"},"lut":lut}})).unwrap();
        update(&mut p, json!({"filter":"warm"})).unwrap();
        assert_eq!(
            p["clips"][0]["color"],
            json!({"brightness":0.02,"contrast":1.03,"saturation":1.05,"temperature":0.5,
                "hue":20.0,"hsl":{"red":{"hue":30.0}},"curves":{"preset":"vintage"},"lut":lut})
        );
        // With explicit colour values the filter id is still checked.
        update(&mut p, json!({"filter":"mono","color":{"saturation":0.2}})).unwrap();
        assert_eq!(p["clips"][0]["color"]["saturation"], 0.2);
        assert_eq!(p["clips"][0]["color"]["hue"], 20.0);
        for patch in [
            json!({"filter":"cinema"}),
            json!({"filter":"original","color":{"saturation":1.0}}),
            json!({"filter":3,"color":{"saturation":1.0}}),
            json!({"reverse":"yes"}),
            json!({"name":5}),
            json!({"transitionIn":{"type":"wipe","duration":1.0}}),
            json!({"transitionOut":"fade"}),
        ] {
            assert!(
                update(&mut p.clone(), patch.clone()).is_err(),
                "accepted {patch}"
            );
        }
        let mut invalid = p.clone();
        invalid["clips"][0]["transitionOut"] = json!({"type":"wipe","duration":1.0});
        assert!(validate_project(&invalid).is_err());
        let mut invalid = p.clone();
        invalid["tracks"][0]["name"] = json!(1);
        assert!(validate_project(&invalid).is_err());

        update(
            &mut p,
            json!({"transitionIn":{"type":"fade","duration":1.0},"fadeOut":0.5}),
        )
        .unwrap();
        assert_eq!(p["clips"][0]["fadeIn"], 1.0);
        assert!(
            p["clips"][0].get("transitionOut").is_none(),
            "a plain fade needs no transition object"
        );
        update(&mut p, json!({"fadeIn":2.0})).unwrap();
        assert_eq!(
            p["clips"][0]["transitionIn"],
            json!({"type":"fade","duration":2.0})
        );
        // 1.5 s + 0.5 s of fades no longer fit: both shrink by the same ratio.
        update(&mut p, json!({"duration":1.5})).unwrap();
        assert_eq!(p["clips"][0]["fadeIn"], 1.125);
        assert_eq!(p["clips"][0]["transitionIn"]["duration"], 1.125);
        assert_eq!(p["clips"][0]["fadeOut"], 0.375);
        update(&mut p, json!({"fadeIn":0.0})).unwrap();
        assert!(p["clips"][0]["transitionIn"].is_null());
        update(
            &mut p,
            json!({"transitionOut":{"type":"fade","duration":0.0}}),
        )
        .unwrap();
        assert_eq!(p["clips"][0]["fadeOut"], 0.0);
        assert!(p["clips"][0]["transitionOut"].is_null());
    }

    #[tokio::test]
    async fn media_import_and_add_remove_missing_flag_and_relink() {
        let dir = temp();
        let out = temp();
        std::fs::create_dir_all(&out).unwrap();
        let mut e = Editor::new(dir.clone()).unwrap();
        let (first, second, moved) = (out.join("a.wav"), out.join("b.wav"), out.join("moved.wav"));
        write_wav(&first, 16_000);
        write_wav(&second, 8_000);
        let p = e
            .dispatch(
                "media.importAndAdd",
                json!({"paths":[first, second],"start":3.0,"expectedRevision":0}),
            )
            .await
            .unwrap();
        assert_eq!(p["revision"], 1);
        assert_eq!(e.undo.len(), 1);
        assert_eq!(p["media"].as_array().unwrap().len(), 2);
        let clips = p["clips"].as_array().unwrap();
        assert_eq!(clips.len(), 2);
        assert_eq!(clips[0]["trackId"], "audio-1");
        assert_eq!(
            (clips[0]["start"].clone(), clips[1]["start"].clone()),
            (json!(3.0), json!(5.0))
        );
        assert!(p["media"][0].get("missing").is_none());
        let (a, b) = (p["media"][0]["id"].clone(), p["media"][1]["id"].clone());
        assert!(e
            .dispatch("media.importAndAdd", json!({"paths":[]}))
            .await
            .is_err());
        assert!(e
            .dispatch(
                "media.importAndAdd",
                json!({"paths":[out.join("none.wav")]})
            )
            .await
            .is_err());

        // media.remove: refused while used, one undo otherwise.
        assert!(e.dispatch("media.remove", json!({"id":b})).await.is_err());
        assert!(e
            .dispatch("media.remove", json!({"id":"missing"}))
            .await
            .is_err());
        e.dispatch("edit.delete", json!({"ids":[clips[1]["id"]]}))
            .await
            .unwrap();
        let p = e.dispatch("media.remove", json!({"id":b})).await.unwrap();
        assert_eq!(p["media"].as_array().unwrap().len(), 1);
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["media"].as_array().unwrap().len(), 2);

        // A moved source is flagged without a new revision, even on a conditional get.
        std::fs::rename(&first, &moved).unwrap();
        let revision = e.project["revision"].clone();
        let p = e
            .dispatch(
                "project.get",
                json!({"ifProjectId":e.project["id"],"ifRevision":revision}),
            )
            .await
            .unwrap();
        assert_eq!(p["media"][0]["missing"], true);
        assert!(p["media"][1].get("missing").is_none());
        assert_eq!(p["revision"], revision);
        assert_eq!(
            e.dispatch(
                "project.get",
                json!({"ifProjectId":e.project["id"],"ifRevision":revision})
            )
            .await
            .unwrap(),
            json!({"unchanged":true,"id":e.project["id"],"revision":revision,"missing":[a]})
        );

        let before = e.project.clone();
        let undo_count = e.undo.len();
        for params in [
            json!({"id":a,"path":out.join("none.wav")}),
            json!({"id":a,"path":second}),
            json!({"id":"missing","path":moved}),
            json!({"id":a,"path":moved,"expectedRevision":0}),
            json!({"id":a}),
        ] {
            assert!(
                e.dispatch("media.relink", params.clone()).await.is_err(),
                "accepted {params}"
            );
            assert_eq!(e.project, before);
        }
        let p = e
            .dispatch(
                "media.relink",
                json!({"id":a,"path":moved,"expectedRevision":revision}),
            )
            .await
            .unwrap();
        assert_eq!(e.undo.len(), undo_count + 1);
        assert!(p["media"][0].get("missing").is_none());
        assert!(media::same_path(
            Path::new(p["media"][0]["path"].as_str().unwrap()),
            &moved
        ));
        assert_eq!(
            (&p["media"][0]["id"], &p["media"][0]["name"]),
            (&a, &before["media"][0]["name"])
        );
        assert_eq!(p["clips"], before["clips"]);
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["media"], before["media"]);

        // A replacement too short for the clips that use it is refused.
        e.dispatch("history.redo", json!({})).await.unwrap();

        // Relinking a video source to an audio file is refused, not converted.
        let mut as_video = e.project.clone();
        as_video["media"][0]["kind"] = json!("video");
        as_video["media"][0]["width"] = json!(720);
        as_video["media"][0]["height"] = json!(720);
        as_video["clips"][0]["kind"] = json!("video");
        as_video["clips"][0]["trackId"] = json!("video-1");
        validate_project(&as_video).unwrap();
        let other = out.join("other.wav");
        write_wav(&other, 16_000);
        let audio_project = std::mem::replace(&mut e.project, as_video.clone());
        let error = e
            .dispatch("media.relink", json!({"id":a,"path":other}))
            .await
            .unwrap_err();
        assert!(error.contains("소재 종류가 다릅니다"), "{error}");
        assert_eq!(e.project, as_video);
        e.project = audio_project;

        std::fs::remove_file(&moved).unwrap();
        let short = out.join("short.wav");
        write_wav(&short, 800);
        let before = e.project.clone();
        assert!(e
            .dispatch("media.relink", json!({"id":a,"path":short}))
            .await
            .is_err());
        assert_eq!(e.project["clips"], before["clips"]);
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(out).unwrap();
    }

    #[tokio::test]
    async fn demo_project_replaces_current_and_history_is_bounded() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let first = e.project["id"].clone();
        e.dispatch("edit.marker", json!({"time":1.0}))
            .await
            .unwrap();
        let demo = e.dispatch("project.demo", json!({})).await.unwrap();
        assert_ne!(demo["id"], first);
        assert!(e.undo.is_empty());
        assert!(!demo["media"].as_array().unwrap().is_empty());
        assert!(demo["media"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m.get("missing").is_none()));
        assert!(demo["clips"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["kind"] == "text"));
        assert_eq!(
            e.dispatch("project.list", json!({}))
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(Editor::new(dir.clone()).unwrap().project, demo);

        for i in 0..103 {
            e.dispatch("edit.marker", json!({"time":i as f64}))
                .await
                .unwrap();
        }
        assert_eq!(e.undo.len(), 100);
        e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(
            e.dispatch("history.status", json!({})).await.unwrap(),
            json!({"canUndo":true,"canRedo":true})
        );
        e.dispatch("edit.marker", json!({"time":500.0}))
            .await
            .unwrap();
        assert!(e.redo.is_empty(), "a new edit discards redo");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keyframe_easing_shapes_values_and_survives_split_and_trim() {
        for (easing, half) in [
            ("linear", 0.5),
            ("easeIn", 0.25),
            ("easeOut", 0.75),
            ("easeInOut", 0.5),
            ("hold", 0.0),
        ] {
            assert_close(ease(easing, 0.0), 0.0);
            assert_close(ease(easing, 0.5), half);
            assert_close(ease(easing, 1.0), 1.0);
        }
        assert_close(ease("easeInOut", 0.25), 0.15625);
        assert_close(ease("unknown", 0.3), 0.3);

        let mut p = trim_project("video", false, 1.0);
        mutate(
            &mut p,
            "edit.update",
            &json!({"id":"trim-clip","patch":{"keyframes":[
                {"property":"x","time":0.0,"value":0.0,"easing":"easeIn"},
                {"property":"x","time":2.0,"value":100.0,"easing":"hold"},
                {"property":"x","time":4.0,"value":300.0},
                {"property":"opacity","time":0.0,"value":0.0},
                {"property":"opacity","time":4.0,"value":1.0}]}}),
        )
        .unwrap();
        let clip = p["clips"][0].clone();
        assert_close(keyframe_value(&clip, "x", 1.0), 25.0);
        assert_close(keyframe_value(&clip, "transform.x", 3.9), 100.0);
        assert_close(keyframe_value(&clip, "x", 4.0), 300.0);
        assert_close(keyframe_value(&clip, "opacity", 1.0), 0.25);
        assert_eq!(
            keyframe_points(&clip, "x"),
            vec![(0.0, 0.0), (2.0, 100.0), (4.0, 300.0)]
        );

        // Split inside the eased segment and inside the held one.
        let mut split = p.clone();
        mutate(
            &mut split,
            "edit.split",
            &json!({"id":"trim-clip","time":11.0}),
        )
        .unwrap();
        let (left, right) = (&split["clips"][0], &split["clips"][1]);
        assert_close(keyframe_value(left, "x", 1.0), 25.0);
        assert_close(keyframe_value(right, "x", 0.0), 25.0);
        assert_eq!(
            right["keyframes"][0],
            json!({"property":"opacity","time":0.0,"value":0.25})
        );
        let right_x: Vec<&Value> = right["keyframes"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|k| k["property"] == "x")
            .collect();
        assert_eq!(right_x[0]["easing"], "easeIn");
        assert_eq!(right_x[1]["easing"], "hold");
        assert!(right_x[2].get("easing").is_none());
        assert_close(keyframe_value(right, "x", 2.5), 100.0);
        assert_close(keyframe_value(right, "x", 3.0), 300.0);
        let mut held = p.clone();
        mutate(
            &mut held,
            "edit.split",
            &json!({"id":"trim-clip","time":13.0}),
        )
        .unwrap();
        assert_close(keyframe_value(&held["clips"][0], "x", 3.0), 100.0);
        assert_close(keyframe_value(&held["clips"][1], "x", 0.5), 100.0);
        assert_close(keyframe_value(&held["clips"][1], "x", 1.0), 300.0);

        let mut trimmed = p.clone();
        mutate(
            &mut trimmed,
            "edit.trim",
            &json!({"id":"trim-clip","start":11.0,"end":13.5}),
        )
        .unwrap();
        let clip = &trimmed["clips"][0];
        assert_close(keyframe_value(clip, "x", 0.0), 25.0);
        assert_close(keyframe_value(clip, "x", 1.0), 100.0);
        assert_close(keyframe_value(clip, "x", 2.4), 100.0);
        assert_close(keyframe_value(clip, "x", 2.5), 100.0);
        validate_project(&trimmed).unwrap();

        let mut invalid = p.clone();
        invalid["clips"][0]["keyframes"][0]["easing"] = json!("bounce");
        assert!(validate_project(&invalid).is_err());
        invalid["clips"][0]["keyframes"][0]["easing"] = json!(1);
        assert!(validate_project(&invalid).is_err());
    }

    #[test]
    fn transition_types_blend_modes_and_text_styles_are_validated_and_fades_stay_synced() {
        let mut p = trim_project("video", false, 1.0);
        let update = |p: &mut Value, id: &Value, patch: Value| {
            mutate(p, "edit.update", &json!({"id":id,"patch":patch}))
        };
        let video = json!("trim-clip");
        let text = p["clips"][1]["id"].clone();
        for kind in TRANSITIONS {
            update(
                &mut p,
                &video,
                json!({"transitionIn":{"type":kind,"duration":1.0}}),
            )
            .unwrap();
            assert_eq!(
                p["clips"][0]["transitionIn"],
                json!({"type":kind,"duration":1.0})
            );
            assert_eq!(p["clips"][0]["fadeIn"], 1.0, "audio fade follows {kind}");
        }
        update(
            &mut p,
            &text,
            json!({"transitionOut":{"type":"slideRight","duration":0.5}}),
        )
        .unwrap();
        assert_eq!(p["clips"][1]["fadeOut"], 0.5);
        // Changing the fade keeps the type; zero removes the transition.
        update(
            &mut p,
            &video,
            json!({"transitionIn":{"type":"wipeLeft","duration":1.0}}),
        )
        .unwrap();
        update(&mut p, &video, json!({"fadeIn":0.4})).unwrap();
        assert_eq!(
            p["clips"][0]["transitionIn"],
            json!({"type":"wipeLeft","duration":0.4})
        );
        update(&mut p, &video, json!({"transitionIn":{"type":"zoom"}})).unwrap();
        assert_eq!(
            p["clips"][0]["transitionIn"],
            json!({"type":"zoom","duration":0.4})
        );
        update(&mut p, &video, json!({"duration":0.2})).unwrap();
        assert_eq!(p["clips"][0]["transitionIn"]["duration"], 0.2);
        assert_eq!(p["clips"][0]["fadeIn"], 0.2);
        update(&mut p, &video, json!({"duration":4.0,"transitionIn":{"type":"zoom","duration":1.0},"transitionOut":{"type":"dissolve","duration":1.0}})).unwrap();
        let mut split = p.clone();
        mutate(
            &mut split,
            "edit.split",
            &json!({"id":"trim-clip","time":12.0}),
        )
        .unwrap();
        assert_eq!(split["clips"][0]["transitionIn"]["type"], "zoom");
        assert!(split["clips"][0]["transitionOut"].is_null());
        assert!(split["clips"][1]["transitionIn"].is_null());
        assert_eq!(split["clips"][1]["transitionOut"]["type"], "dissolve");
        update(&mut p, &video, json!({"fadeIn":0.0})).unwrap();
        assert!(p["clips"][0]["transitionIn"].is_null());
        update(&mut p, &video, json!({"transitionOut":null})).unwrap();
        assert_eq!(p["clips"][0]["fadeOut"], 0.0);
        for patch in [
            json!({"transitionIn":{"type":"wipe","duration":1.0}}),
            json!({"transitionIn":{"type":"zoom"}}),
            json!({"transitionIn":{"type":"zoom","duration":1.0,"angle":3}}),
            json!({"blendMode":"difference"}),
            json!({"blendMode":1}),
        ] {
            assert!(
                update(&mut p.clone(), &video, patch.clone()).is_err(),
                "accepted {patch}"
            );
        }

        // Effect presets keep the transition type.
        update(
            &mut p,
            &video,
            json!({"transitionIn":{"type":"slideLeft","duration":1.0},"blendMode":"screen"}),
        )
        .unwrap();
        let preset = capture_preset(&p["clips"][0], "effect").unwrap();
        assert_eq!(
            preset["patch"]["transitionIn"],
            json!({"type":"slideLeft","duration":1.0})
        );
        assert_eq!(preset["patch"]["blendMode"], "screen");
        validate_preset(&preset).unwrap();

        for mode in BLEND_MODES {
            update(&mut p, &video, json!({"blendMode":mode})).unwrap();
            update(&mut p, &text, json!({"blendMode":mode})).unwrap();
        }
        let mut audio = trim_project("audio", false, 1.0);
        update(
            &mut audio,
            &video,
            json!({"transitionIn":{"type":"fade","duration":1.0},"blendMode":"normal"}),
        )
        .unwrap();
        assert_eq!(audio["clips"][0]["fadeIn"], 1.0);
        for patch in [
            json!({"transitionIn":{"type":"dissolve","duration":1.0}}),
            json!({"blendMode":"screen"}),
        ] {
            assert!(
                update(&mut audio.clone(), &video, patch.clone()).is_err(),
                "accepted {patch}"
            );
        }

        update(
            &mut p,
            &text,
            json!({"text":{"italic":true,"letterSpacing":-5.0,"lineHeight":3.0,
                "outline":{"color":"#000000","width":20.0},
                "shadow":{"color":"#00000080","x":4.0,"y":-4.0,"blur":40.0}}}),
        )
        .unwrap();
        assert_eq!(p["clips"][1]["text"]["shadow"]["blur"], 40.0);
        assert_eq!(p["clips"][1]["name"], "neighbour");
        update(
            &mut p,
            &text,
            json!({"text":{"outline":null,"shadow":null}}),
        )
        .unwrap();
        for style in [
            json!({"italic":"yes"}),
            json!({"letterSpacing":-5.1}),
            json!({"letterSpacing":51.0}),
            json!({"lineHeight":0.7}),
            json!({"lineHeight":3.1}),
            json!({"outline":{"color":"#000000","width":21.0}}),
            json!({"outline":{"color":"black","width":2.0}}),
            json!({"outline":{"width":2.0}}),
            json!({"outline":{"color":"#000000"}}),
            json!({"outline":{"color":"#000000","width":2.0,"join":"round"}}),
            json!({"shadow":{"color":"#000000","x":0.0,"y":0.0,"blur":41.0}}),
            json!({"shadow":{"color":"#000000","x":0.0,"blur":1.0}}),
            json!({"underline":true}),
        ] {
            assert!(
                update(&mut p.clone(), &text, json!({"text":style.clone()})).is_err(),
                "accepted {style}"
            );
        }
    }

    #[test]
    fn overlapping_clips_keep_default_placement_and_ripple_never_goes_negative() {
        let mut p = empty_project("overlap", 320, 180, 24.0);
        let add = |p: &mut Value, args: Value| {
            mutate(p, "edit.add", &args).unwrap();
            p["clips"].as_array().unwrap().last().unwrap()["id"].clone()
        };
        // b overlaps a by one second (a transition), c follows b, d sits later.
        let a = add(&mut p, json!({"text":"a","start":2.0,"duration":3.0}));
        let b = add(&mut p, json!({"text":"b","start":4.0,"duration":3.0}));
        mutate(
            &mut p,
            "edit.update",
            &json!({"id":b,"patch":{"transitionIn":{"type":"dissolve","duration":1.0}}}),
        )
        .unwrap();
        // Without a start the next clip goes to the end of the track.
        let c = add(&mut p, json!({"text":"c","duration":1.0}));
        assert_eq!(p["clips"][2]["start"], 7.0);
        let d = add(&mut p, json!({"text":"d","start":10.0,"duration":1.0}));
        let other = add(&mut p, json!({"text":"other","start":0.5,"duration":1.0}));
        let starts = |p: &Value| -> Vec<f64> {
            p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c["start"].as_f64().unwrap())
                .collect()
        };

        // Removing a frees only the two seconds it held alone.
        let mut one = p.clone();
        mutate(&mut one, "edit.delete", &json!({"ids":[a],"ripple":true})).unwrap();
        assert_eq!(starts(&one), [2.0, 5.0, 8.0, 0.5]);
        // Removing b frees the time after a; nothing moves before a's end.
        let mut two = p.clone();
        mutate(&mut two, "edit.delete", &json!({"ids":[b],"ripple":true})).unwrap();
        assert_eq!(starts(&two), [2.0, 5.0, 8.0, 0.5]);
        // Removing both overlapped clips counts their shared second once.
        let mut both = p.clone();
        mutate(
            &mut both,
            "edit.delete",
            &json!({"ids":[a, b],"ripple":true}),
        )
        .unwrap();
        assert_eq!(starts(&both), [2.0, 5.0, 0.5]);
        // A clip that starts inside a removed one lands on its start, not below zero.
        let mut early = empty_project("early", 320, 180, 24.0);
        let first = add(
            &mut early,
            json!({"text":"first","start":0.0,"duration":3.0}),
        );
        add(
            &mut early,
            json!({"text":"second","start":0.5,"duration":3.0}),
        );
        add(
            &mut early,
            json!({"text":"third","start":3.5,"duration":1.0}),
        );
        mutate(
            &mut early,
            "edit.delete",
            &json!({"ids":[first],"ripple":true}),
        )
        .unwrap();
        assert_eq!(starts(&early), [0.0, 3.0]);
        validate_project(&early).unwrap();
        let _ = (c, d, other);
    }

    #[tokio::test]
    async fn background_waveform_and_proxy_flags_change_no_revision_and_history_shares_waveforms() {
        let dir = temp();
        let out = temp();
        std::fs::create_dir_all(&out).unwrap();
        let mut e = Editor::new(dir.clone()).unwrap();
        let wav = out.join("a.wav");
        write_wav(&wav, 16_000);
        let p = e
            .dispatch("media.importAndAdd", json!({"paths":[wav]}))
            .await
            .unwrap();
        let id = p["media"][0]["id"].as_str().unwrap().to_owned();
        let path = PathBuf::from(p["media"][0]["path"].as_str().unwrap());
        // As imported by a probe that leaves the waveform for later.
        e.project["media"][0]
            .as_object_mut()
            .unwrap()
            .remove("waveform");
        e.waveforms.clear();
        validate_project(&e.project).unwrap();
        assert_eq!(e.pending_waveforms(), vec![(id.clone(), path.clone(), 2.0)]);
        let poll =
            |e: &Editor| json!({"ifProjectId":e.project["id"],"ifRevision":e.project["revision"]});
        let conditional = poll(&e);
        assert_eq!(
            e.dispatch("project.get", conditional.clone())
                .await
                .unwrap()["unchanged"],
            true
        );

        // An edit made while the waveform is still being computed.
        e.dispatch("edit.marker", json!({"time":1.0}))
            .await
            .unwrap();
        let conditional = poll(&e);
        let revision = e.project["revision"].clone();
        assert!(!e
            .set_waveform(&id, &out.join("other.wav"), vec![1.0])
            .unwrap());
        assert!(!e.set_waveform("missing", &path, vec![1.0]).unwrap());
        assert!(e.set_waveform(&id, &path, None).unwrap());
        assert_eq!(e.project["media"][0]["waveform"], json!([]));
        assert!(e.set_waveform(&id, &path, vec![0.25, 0.5]).unwrap());
        assert_eq!(e.project["revision"], revision);
        assert_eq!(e.undo.len(), 2);
        assert!(e.pending_waveforms().is_empty());
        // An unconditional read (the service's own) does not hide it from the poller.
        e.dispatch("project.get", json!({})).await.unwrap();
        let full = e
            .dispatch("project.get", conditional.clone())
            .await
            .unwrap();
        assert_eq!(full["media"][0]["waveform"], json!([0.25, 0.5]));
        assert_eq!(
            e.dispatch("project.get", conditional.clone())
                .await
                .unwrap(),
            json!({"unchanged":true,"id":e.project["id"],"revision":revision,"missing":[]})
        );
        assert_eq!(
            Editor::new(dir.clone()).unwrap().project["media"][0]["waveform"],
            json!([0.25, 0.5])
        );

        // Undo to the state before the waveform arrived still shows it, and no
        // history entry carries its own copy.
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert!(undone["markers"].as_array().unwrap().is_empty());
        assert_eq!(undone["media"][0]["waveform"], json!([0.25, 0.5]));
        let redone = e.dispatch("history.redo", json!({})).await.unwrap();
        assert_eq!(redone["media"][0]["waveform"], json!([0.25, 0.5]));
        e.dispatch("edit.marker", json!({"time":2.0}))
            .await
            .unwrap();
        for snapshot in e.undo.iter().chain(e.redo.iter()) {
            assert!(snapshot["media"]
                .as_array()
                .unwrap()
                .iter()
                .all(|m| m.get("waveform").is_none()));
        }
        // Removing the media and undoing brings the waveform back.
        let clip = e.project["clips"][0]["id"].clone();
        e.dispatch("edit.delete", json!({"ids":[clip]}))
            .await
            .unwrap();
        e.dispatch("media.remove", json!({"id":id})).await.unwrap();
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["media"][0]["waveform"], json!([0.25, 0.5]));

        // A proxy file flags the media, again without a revision.
        let revision = e.project["revision"].clone();
        let conditional = poll(&e);
        e.dispatch("project.get", conditional.clone())
            .await
            .unwrap();
        let proxy = e.proxy_path(&id).unwrap();
        assert_eq!(proxy, e.root.join("proxies").join(format!("{id}.mp4")));
        assert!(e.proxy_path("missing").is_none());
        std::fs::create_dir_all(proxy.parent().unwrap()).unwrap();
        std::fs::write(&proxy, b"proxy").unwrap();
        // Without the service's note of its source a proxy file does not count.
        assert!(
            e.dispatch("project.get", json!({})).await.unwrap()["media"][0]
                .get("proxy")
                .is_none()
        );
        std::fs::write(
            proxy.with_extension("source"),
            e.project["media"][0]["path"].as_str().unwrap(),
        )
        .unwrap();
        let full = e
            .dispatch("project.get", conditional.clone())
            .await
            .unwrap();
        assert_eq!(full["media"][0]["proxy"], true);
        assert_eq!(full["revision"], revision);
        assert_eq!(
            e.dispatch("project.get", conditional.clone())
                .await
                .unwrap(),
            json!({"unchanged":true,"id":e.project["id"],"revision":revision,"missing":[],"proxy":[id]})
        );
        // A proxy noted as made from another file (relinked since) does not count.
        std::fs::write(proxy.with_extension("source"), "/another/file.mp4").unwrap();
        assert!(
            e.dispatch("project.get", json!({})).await.unwrap()["media"][0]
                .get("proxy")
                .is_none()
        );
        let path = e.project["media"][0]["path"].as_str().unwrap().to_owned();
        std::fs::write(proxy.with_extension("source"), path).unwrap();
        assert_eq!(
            e.dispatch("project.get", json!({})).await.unwrap()["media"][0]["proxy"],
            true
        );
        std::fs::remove_file(&proxy).unwrap();
        let full = e.dispatch("project.get", conditional).await.unwrap();
        assert!(full["media"][0].get("proxy").is_none());
        let mut invalid = e.project.clone();
        invalid["media"][0]["proxy"] = json!("yes");
        assert!(validate_project(&invalid).is_err());
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(out).unwrap();
    }

    #[test]
    fn relink_drops_a_waveform_the_probe_did_not_supply_and_reimport_keeps_it() {
        let mut p = trim_project("audio", false, 1.0);
        p["media"][0]["waveform"] = json!([0.5]);
        let same =
            json!({"path":"/tmp/trim-test.mp4","kind":"audio","duration":30.0,"hasAudio":true});
        refresh_media_metadata(&mut p, "trim-media", same).unwrap();
        assert_eq!(p["media"][0]["waveform"], json!([0.5]));
        let moved = json!({"path":"/tmp/moved.mp4","kind":"audio","duration":30.0,"hasAudio":true});
        refresh_media_metadata(&mut p, "trim-media", moved.clone()).unwrap();
        assert!(p["media"][0].get("waveform").is_none());
        let mut probed = moved;
        probed["waveform"] = json!([0.1, 0.2]);
        refresh_media_metadata(&mut p, "trim-media", probed).unwrap();
        assert_eq!(p["media"][0]["waveform"], json!([0.1, 0.2]));
    }

    #[tokio::test]
    async fn opening_a_file_whose_id_belongs_to_another_stored_project_gets_a_new_id() {
        let dir = temp();
        let out = temp();
        std::fs::create_dir_all(&out).unwrap();
        let mut e = Editor::new(dir.clone()).unwrap();
        e.dispatch("edit.add", json!({"text":"kept"}))
            .await
            .unwrap();
        let id = e.project["id"].as_str().unwrap().to_owned();
        let file = out.join("export.json");
        e.dispatch("project.save", json!({"path":file}))
            .await
            .unwrap();

        // The same content reopens as the same project.
        for _ in 0..2 {
            let reopened = e
                .dispatch("project.open", json!({"path":file}))
                .await
                .unwrap();
            assert_eq!(reopened["id"], id.as_str());
        }
        assert_eq!(
            e.dispatch("project.list", json!({}))
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );

        // The stored project moves on; the old export no longer matches it.
        e.dispatch("edit.add", json!({"text":"newer work"}))
            .await
            .unwrap();
        let stored = e.project.clone();
        let opened = e
            .dispatch("project.open", json!({"path":file}))
            .await
            .unwrap();
        assert_ne!(opened["id"], id.as_str());
        assert_eq!(opened["clips"].as_array().unwrap().len(), 1);
        let kept: Value =
            serde_json::from_slice(&std::fs::read(e.project_file(&id)).unwrap()).unwrap();
        assert_eq!(kept["clips"], stored["clips"]);
        assert_eq!(
            e.dispatch("project.list", json!({}))
                .await
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        // Saving goes back to the opened file, not to the other project.
        let saved = e.dispatch("project.save", json!({})).await.unwrap();
        assert!(media::same_path(
            Path::new(saved["path"].as_str().unwrap()),
            &file
        ));

        // The same holds when the other project is not the open one.
        e.dispatch("project.new", json!({})).await.unwrap();
        let mut copy = stored.clone();
        copy["name"] = json!("someone else's copy");
        let other = out.join("copy.json");
        write_json(&other, &copy);
        let opened = e
            .dispatch("project.open", json!({"path":other}))
            .await
            .unwrap();
        assert_ne!(opened["id"], id.as_str());
        assert_eq!(opened["name"], "someone else's copy");
        let kept: Value =
            serde_json::from_slice(&std::fs::read(e.project_file(&id)).unwrap()).unwrap();
        assert_eq!(kept["name"], stored["name"]);
        // Opening a stored project by id is untouched.
        assert_eq!(
            e.dispatch("project.open", json!({"id":id})).await.unwrap()["id"],
            id.as_str()
        );
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(out).unwrap();
    }

    #[tokio::test]
    async fn freeze_frame_splits_inserts_a_managed_still_shifts_the_track_and_is_one_undo() {
        let dir = temp();
        let out = temp();
        std::fs::create_dir_all(&out).unwrap();
        let video = out.join("clip.mp4");
        let made = std::process::Command::new(media::executable("ffmpeg"))
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg("testsrc=size=320x180:rate=30:duration=4")
            .args(["-pix_fmt", "yuv420p"])
            .arg(&video)
            .status()
            .unwrap();
        assert!(made.success());
        let mut e = Editor::new(dir.clone()).unwrap();
        e.dispatch("media.importAndAdd", json!({"paths":[video, video]}))
            .await
            .unwrap();
        let p = e
            .dispatch(
                "edit.add",
                json!({"text":"caption","start":3.0,"duration":2.0}),
            )
            .await
            .unwrap();
        assert_eq!(p["media"].as_array().unwrap().len(), 1);
        let (first, second) = (p["clips"][0]["id"].clone(), p["clips"][1]["id"].clone());
        let p = e
            .dispatch(
                "edit.update",
                json!({"id":first,"patch":{"blendMode":"screen","filter":"mono","keyframes":[
                    {"property":"x","time":0.0,"value":0.0},{"property":"x","time":4.0,"value":400.0}]}}),
            )
            .await
            .unwrap();
        let (revision, undo) = (p["revision"].as_u64().unwrap(), e.undo.len());

        let before = e.project.clone();
        for params in [
            json!({"id":first,"time":1.0,"expectedRevision":0}),
            json!({"id":first,"time":0.0}),
            json!({"id":first,"time":9.0}),
            json!({"id":first}),
            json!({"id":first,"time":1.0,"duration":0.0}),
            json!({"id":p["clips"][2]["id"],"time":3.5}),
            json!({"id":"missing","time":1.0}),
        ] {
            assert!(
                e.dispatch("edit.freeze", params.clone()).await.is_err(),
                "accepted {params}"
            );
            assert_eq!(e.project, before);
        }
        let frames = e
            .assets_dir(e.project["id"].as_str().unwrap())
            .join("frames");
        assert!(std::fs::read_dir(&frames).map_or(true, |mut d| d.next().is_none()));

        let p = e
            .dispatch(
                "edit.freeze",
                // Off-grid requests land on the 30 fps frame grid: 1.0 s and 2.0 s.
                json!({"id":first,"time":1.01,"duration":2.01,"expectedRevision":revision}),
            )
            .await
            .unwrap();
        assert_eq!(p["revision"], revision + 1);
        assert_eq!(e.undo.len(), undo + 1);
        let clips = p["clips"].as_array().unwrap();
        let by_start = |start: f64| {
            clips
                .iter()
                .find(|c| c["trackId"] == "video-1" && c["start"] == start)
                .unwrap()
        };
        let (left, still, right, next) =
            (by_start(0.0), by_start(1.0), by_start(3.0), by_start(6.0));
        assert_eq!(left["id"], first);
        assert_eq!(
            (&left["duration"], &right["duration"]),
            (&json!(1.0), &json!(3.0))
        );
        assert_eq!(right["sourceIn"], 1.0);
        assert_eq!(next["id"], second);
        assert_eq!(
            (&still["kind"], &still["duration"]),
            (&json!("image"), &json!(2.0))
        );
        assert_eq!(still["blendMode"], "screen");
        assert_eq!(still["filter"], "mono");
        assert_eq!(still["transform"]["x"], 100.0);
        assert!(still["keyframes"].as_array().unwrap().is_empty());
        // Other tracks stay where they were.
        assert_eq!(
            clips.iter().find(|c| c["kind"] == "text").unwrap()["start"],
            3.0
        );
        let image = p["media"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == still["mediaId"])
            .unwrap();
        assert_eq!(image["kind"], "image");
        assert_eq!(
            (&image["width"], &image["height"]),
            (&json!(320), &json!(180))
        );
        let png = PathBuf::from(image["path"].as_str().unwrap());
        assert!(png.starts_with(&frames) && png.is_file());
        assert_eq!(Editor::new(dir.clone()).unwrap().project, p);

        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["clips"], before["clips"]);
        assert_eq!(undone["media"], before["media"]);
        let redone = e.dispatch("history.redo", json!({})).await.unwrap();
        assert_eq!(redone["clips"], p["clips"]);

        // A custom length, on a reversed clip: the frame comes from the mirrored position.
        e.dispatch("edit.update", json!({"id":second,"patch":{"reverse":true}}))
            .await
            .unwrap();
        let p = e
            .dispatch(
                "edit.freeze",
                json!({"id":second,"time":7.0,"duration":0.5}),
            )
            .await
            .unwrap();
        let held = p["clips"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["start"] == 7.0 && c["kind"] == "image")
            .unwrap();
        assert_eq!(held["duration"], 0.5);
        // A freeze that was undone leaves its still for redo, but only this session.
        e.dispatch("edit.freeze", json!({"id":second,"time":6.5}))
            .await
            .unwrap();
        e.dispatch("history.undo", json!({})).await.unwrap();
        let count = |folder: &Path| std::fs::read_dir(folder).unwrap().count();
        assert_eq!(count(&frames), 3);
        // A duplicated project owns its own copy of the stills it uses.
        let copy = e
            .dispatch("project.duplicate", json!({"id":p["id"]}))
            .await
            .unwrap();
        let copied = e
            .dispatch("project.open", json!({"id":copy["id"]}))
            .await
            .unwrap();
        let copied_frames = e.assets_dir(copy["id"].as_str().unwrap()).join("frames");
        let stills: Vec<&Value> = copied["media"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["kind"] == "image")
            .collect();
        assert_eq!(stills.len(), 2);
        for still in stills {
            let path = PathBuf::from(still["path"].as_str().unwrap());
            assert!(path.starts_with(&copied_frames) && path.is_file());
            assert!(still.get("missing").is_none());
        }
        assert_eq!(count(&copied_frames), 2);
        // The next start removes the stills no saved project mentions.
        assert_eq!(count(&frames), 3);
        std::fs::write(frames.join("notes.txt"), b"not a still").unwrap();
        let restarted = Editor::new(dir.clone()).unwrap();
        assert_eq!(count(&frames), 3); // two stills and the unrelated file
        assert_eq!(count(&copied_frames), 2);
        for still in restarted.project["media"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|m| m["kind"] == "image")
        {
            assert!(Path::new(still["path"].as_str().unwrap()).is_file());
        }
        std::fs::remove_dir_all(dir).unwrap();
        std::fs::remove_dir_all(out).unwrap();
    }

    #[tokio::test]
    async fn reprobe_and_relink_make_the_waveform_pending_again_and_history_forgets_it() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let wav = dir.join("a.wav");
        write_wav(&wav, 16_000);
        let p = e
            .dispatch("media.import", json!({"paths":[wav]}))
            .await
            .unwrap();
        let id = p["media"][0]["id"].as_str().unwrap().to_owned();
        let path = PathBuf::from(p["media"][0]["path"].as_str().unwrap());
        let pending = |duration: f64| vec![(id.clone(), path.clone(), duration)];
        assert!(e.set_waveform(&id, &path, vec![0.5]).unwrap());
        e.dispatch("edit.marker", json!({"time":1.0}))
            .await
            .unwrap();

        // Importing the unchanged file again keeps what is known.
        let p = e
            .dispatch("media.import", json!({"paths":[path]}))
            .await
            .unwrap();
        assert_eq!(p["media"][0]["waveform"], json!([0.5]));

        // The file is replaced in place by a longer one.
        write_wav(&path, 32_000);
        let p = e
            .dispatch("media.reprobe", json!({"ids":[id]}))
            .await
            .unwrap();
        assert_eq!(p["media"][0]["duration"], 4.0);
        assert!(p["media"][0].get("waveform").is_none());
        assert_eq!(e.pending_waveforms(), pending(4.0));
        // Undo must not bring the old file's waveform back either.
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert!(undone["media"][0].get("waveform").is_none());
        assert_eq!(e.pending_waveforms(), pending(2.0));
        assert!(e.set_waveform(&id, &path, vec![0.25, 0.75]).unwrap());
        let redone = e.dispatch("history.redo", json!({})).await.unwrap();
        assert_eq!(redone["media"][0]["waveform"], json!([0.25, 0.75]));

        // A failed attempt (recorded as empty) is retried by a reprobe, by relinking
        // the same path, and by the next start.
        assert!(e.set_waveform(&id, &path, None).unwrap());
        assert!(e.pending_waveforms().is_empty());
        e.dispatch("media.reprobe", json!({"ids":[id]}))
            .await
            .unwrap();
        assert_eq!(e.pending_waveforms(), pending(4.0));
        assert!(e.set_waveform(&id, &path, None).unwrap());
        e.dispatch("media.relink", json!({"id":id,"path":path}))
            .await
            .unwrap();
        assert_eq!(e.pending_waveforms(), pending(4.0));
        assert!(e.set_waveform(&id, &path, None).unwrap());
        assert_eq!(
            Editor::new(dir.clone()).unwrap().pending_waveforms(),
            pending(4.0)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn reprobe_to_audio_keeps_only_what_an_audio_clip_may_have() {
        let (mut e, dir) = misclassified_audio_editor();
        let clip = e.project["clips"][0]["id"].clone();
        e.dispatch(
            "edit.update",
            json!({"id":clip,"patch":{"blendMode":"screen",
                "transitionIn":{"type":"wipeLeft","duration":0.25},
                "transitionOut":{"type":"zoom","duration":0.5}}}),
        )
        .await
        .unwrap();
        let p = e
            .dispatch("media.reprobe", json!({"ids":["old-audio"]}))
            .await
            .unwrap();
        let clip = &p["clips"][0];
        assert_eq!(clip["kind"], "audio");
        assert_eq!(clip["transitionIn"], json!({"type":"fade","duration":0.25}));
        assert_eq!(clip["transitionOut"], json!({"type":"fade","duration":0.5}));
        assert_eq!(
            (&clip["fadeIn"], &clip["fadeOut"]),
            (&json!(0.25), &json!(0.5))
        );
        assert!(clip.get("blendMode").is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn transitions_and_fades_set_on_a_clip_never_outlast_it() {
        let mut p = trim_project("video", false, 1.0); // a 4 s clip
        let mut update = |patch: Value| {
            mutate(
                &mut p,
                "edit.update",
                &json!({"id":"trim-clip","patch":patch}),
            )
            .unwrap();
            validate_project(&p).unwrap();
            p["clips"][0].clone()
        };
        let clip = update(json!({"transitionIn":{"type":"wipeLeft","duration":10.0}}));
        assert_eq!(
            clip["transitionIn"],
            json!({"type":"wipeLeft","duration":4.0})
        );
        assert_eq!(clip["fadeIn"], 4.0);
        // Together they may not be longer than the clip either: they share it.
        let clip = update(json!({"fadeOut":9.0}));
        assert_eq!(
            (&clip["fadeIn"], &clip["fadeOut"]),
            (&json!(2.0), &json!(2.0))
        );
        assert_eq!(
            clip["transitionIn"],
            json!({"type":"wipeLeft","duration":2.0})
        );
        // A transition of no length is no transition.
        let clip = update(json!({"transitionIn":{"type":"slideLeft","duration":0.0}}));
        assert!(clip["transitionIn"].is_null());
        assert_eq!(clip["fadeIn"], 0.0);
        let clip = update(json!({"transitionOut":{"type":"zoom","duration":86400.0}}));
        assert_eq!(clip["transitionOut"], json!({"type":"zoom","duration":4.0}));
        let clip = update(json!({"fadeIn":1.0,"fadeOut":5.0}));
        assert_eq!(
            (&clip["fadeIn"], &clip["fadeOut"]),
            (&json!(0.8), &json!(3.2))
        );
        assert_eq!(clip["transitionOut"], json!({"type":"zoom","duration":3.2}));
        let clip = update(json!({"transitionOut":{"type":"zoom","duration":1.0}}));
        assert_eq!(clip["transitionOut"], json!({"type":"zoom","duration":1.0}));
    }

    #[test]
    fn add_can_make_its_own_track_in_the_same_step() {
        let mut p = trim_project("video", false, 1.0);
        let tracks = p["tracks"].as_array().unwrap().len();
        let clips = p["clips"].as_array().unwrap().len();
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":{"content":"제목"},"start":0.0,"duration":2.0,"newTrack":"자막·텍스트 2"}),
        )
        .unwrap();
        validate_project(&p).unwrap();
        let track = p["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|track| track["name"] == "자막·텍스트 2")
            .expect("the new track")
            .clone();
        assert_eq!(track["kind"], "text");
        assert_eq!(p["tracks"].as_array().unwrap().len(), tracks + 1);
        let added = p["clips"].as_array().unwrap().last().unwrap();
        assert_eq!(p["clips"].as_array().unwrap().len(), clips + 1);
        assert_eq!(added["trackId"], track["id"]);
        // A refused add leaves no track behind, and the two ways to name a track exclude each other.
        let mut refused = p.clone();
        for params in [
            json!({"text":{"content":"x"},"newTrack":"t","trackId":track["id"]}),
            json!({"text":{"content":"x"},"newTrack":""}),
            json!({"text":{"content":"x"},"newTrack":3}),
            json!({"mediaId":"none","newTrack":"t"}),
        ] {
            assert!(
                mutate(&mut refused, "edit.add", &params).is_err(),
                "{params}"
            );
        }
        assert_eq!(refused["tracks"], p["tracks"]);
    }

    #[tokio::test]
    async fn shift_moves_every_later_clip_on_one_track_in_one_command() {
        let mut p = trim_project("video", false, 1.0);
        let template = p["clips"][0].clone();
        // 700 one-second clips from 0 s: more than a batch of updates could carry.
        let clips: Vec<Value> = (0..700)
            .map(|i| {
                let mut clip = template.clone();
                clip["id"] = json!(format!("clip-{i}"));
                clip["start"] = json!(i as f64);
                clip["duration"] = json!(1.0);
                clip
            })
            .chain([p["clips"][1].clone()])
            .collect();
        p["clips"] = json!(clips);
        validate_project(&p).unwrap();
        let before = p.clone();
        // 0.51 s is 15.3 frames at 30 fps: the shift is 15 whole frames.
        mutate(
            &mut p,
            "edit.shift",
            &json!({"trackId":"video-1","from":100.0,"delta":-0.51}),
        )
        .unwrap();
        for (i, clip) in p["clips"].as_array().unwrap().iter().enumerate() {
            let was = number(&before["clips"][i], "start", -1.0);
            let moved = clip["trackId"] == "video-1" && was >= 100.0;
            assert_eq!(
                clip["start"],
                if moved { was - 0.5 } else { was },
                "clip {i}"
            );
            assert_eq!(clip["duration"], before["clips"][i]["duration"]);
        }
        // Repeated shifts leave no float noise behind.
        for _ in 0..7 {
            mutate(
                &mut p,
                "edit.shift",
                &json!({"trackId":"video-1","from":50.0,"delta":0.1}),
            )
            .unwrap();
        }
        assert_eq!(p["clips"][49]["start"], 49.0);
        assert_eq!(p["clips"][50]["start"], 50.7);
        assert_eq!(p["clips"][100]["start"], 100.2);

        let unchanged = p.clone();
        for params in [
            json!({"trackId":"video-1","from":0.0,"delta":-0.5}), // start below zero
            json!({"trackId":"video-1","from":0.0,"delta":0.01}), // under one frame
            json!({"trackId":"video-1","from":0.0}),
            json!({"trackId":"video-1","delta":1.0}),
            json!({"trackId":"video-1","from":"0","delta":1.0}),
            json!({"trackId":"missing","from":0.0,"delta":1.0}),
            json!({"from":0.0,"delta":1.0}),
        ] {
            let mut attempt = p.clone();
            assert!(
                mutate(&mut attempt, "edit.shift", &params).is_err(),
                "accepted {params}"
            );
        }
        p["tracks"][0]["locked"] = json!(true);
        assert!(mutate(
            &mut p,
            "edit.shift",
            &json!({"trackId":"video-1","from":0.0,"delta":1.0})
        )
        .is_err());
        p["tracks"][0]["locked"] = json!(false);
        assert_eq!(p, unchanged);

        // Through dispatch: usable in a batch, revision-guarded, atomic, one undo.
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        for start in [0.0, 2.0, 4.0] {
            e.dispatch("edit.add", json!({"text":"t","start":start,"duration":2.0}))
                .await
                .unwrap();
        }
        let track = e.project["clips"][0]["trackId"].clone();
        let before = e.project.clone();
        let undo = e.undo.len();
        assert!(e
            .dispatch(
                "edit.shift",
                json!({"trackId":track,"from":2.0,"delta":1.0,"expectedRevision":0})
            )
            .await
            .unwrap_err()
            .contains("REVISION_CONFLICT"));
        assert!(e
            .dispatch(
                "edit.batch",
                json!({"expectedRevision":3,"commands":[
                    {"method":"edit.shift","params":{"trackId":track,"from":2.0,"delta":1.0}},
                    {"method":"edit.shift","params":{"trackId":track,"from":0.0,"delta":-5.0}}
                ]})
            )
            .await
            .is_err());
        assert_eq!(e.project, before);
        let p = e
            .dispatch(
                "edit.batch",
                json!({"expectedRevision":3,"commands":[
                    {"method":"edit.shift","params":{"trackId":track,"from":2.0,"delta":-0.5}},
                    {"method":"edit.update","params":{"id":p_id(&before, 1),"patch":{"transitionIn":{"type":"fade","duration":0.5}}}}
                ]}),
            )
            .await
            .unwrap();
        let starts: Vec<&Value> = p["clips"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| &c["start"])
            .collect();
        assert_eq!(starts, [&json!(0.0), &json!(1.5), &json!(3.5)]);
        assert_eq!((p["revision"].clone(), e.undo.len()), (json!(4), undo + 1));
        let undone = e.dispatch("history.undo", json!({})).await.unwrap();
        assert_eq!(undone["clips"], before["clips"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn p_id(p: &Value, index: usize) -> Value {
        p["clips"][index]["id"].clone()
    }

    fn frames(value: &Value) -> f64 {
        value.as_f64().unwrap() * 30.0
    }

    #[test]
    fn new_edits_land_on_the_frame_grid_and_stored_off_grid_clips_are_left_alone() {
        let mut p = trim_project("video", false, 1.0); // 30 fps
        let text_track = p["clips"][1]["trackId"].clone();
        // add: nearest frame, at least one frame long.
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":"a","start":1.01,"duration":0.99}),
        )
        .unwrap();
        let added = p["clips"][2].clone();
        assert_eq!(
            (&added["start"], &added["duration"]),
            (&json!(1.0), &json!(1.0))
        );
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":"b","start":20.0,"duration":0.001}),
        )
        .unwrap();
        assert_eq!(p["clips"][3]["duration"], 1.0 / 30.0);

        // update: start, duration and a duration derived from speed.
        let update = |p: &mut Value, patch: Value| {
            mutate(p, "edit.update", &json!({"id":"trim-clip","patch":patch})).unwrap();
            p["clips"][0].clone()
        };
        let clip = update(
            &mut p,
            json!({"start":2.02,"duration":0.51,"volume":0.333,"sourceIn":8.011}),
        );
        assert_eq!(
            (&clip["start"], &clip["duration"]),
            (&json!(61.0 / 30.0), &json!(0.5))
        );
        // Values that are not timeline positions are not touched.
        assert_eq!(
            (&clip["volume"], &clip["sourceIn"]),
            (&json!(0.333), &json!(8.011))
        );
        update(
            &mut p,
            json!({"start":10.0,"duration":4.0,"sourceIn":8.0,"keyframes":[
            {"property":"x","time":0.0,"value":0.0},{"property":"x","time":4.0,"value":100.0}]}),
        );
        let clip = update(&mut p, json!({"speed":1.7})); // 4 / 1.7 s = 70.59 frames
        assert_eq!(clip["duration"], 71.0 / 30.0);
        assert_eq!(clip["keyframes"][1]["time"], clip["duration"]);
        let clip = update(&mut p, json!({"speed":1.0,"keyframes":[]}));
        assert_eq!(frames(&clip["duration"]).fract(), 0.0);
        update(&mut p, json!({"duration":4.0}));

        // trim: given boundaries go to the nearest frame.
        mutate(
            &mut p,
            "edit.trim",
            &json!({"id":"trim-clip","start":10.26,"end":13.49}),
        )
        .unwrap();
        let clip = p["clips"][0].clone();
        assert_eq!(clip["start"], 308.0 / 30.0);
        assert_eq!(frames(&clip["duration"]).round(), 97.0);
        assert_close(frames(&clip["duration"]), 97.0);
        assert_close(number(&clip, "sourceIn", 0.0), 8.0 + 8.0 / 30.0);
        // A source that ends between frames: the last partial frame is not used,
        // and the request is still accepted.
        p["media"][0]["duration"] = json!(30.02);
        let source_end = number(&clip, "start", 0.0) + 30.02 - number(&clip, "sourceIn", 0.0);
        mutate(
            &mut p,
            "edit.trim",
            &json!({"id":"trim-clip","end":source_end}),
        )
        .unwrap();
        let clip = p["clips"][0].clone();
        let end = number(&clip, "start", 0.0) + number(&clip, "duration", 0.0);
        assert_close(end * 30.0, (source_end * 30.0).floor());
        assert!(number(&clip, "sourceIn", 0.0) + number(&clip, "duration", 0.0) <= 30.02);
        assert!(mutate(
            &mut p.clone(),
            "edit.trim",
            &json!({"id":"trim-clip","end":source_end + 0.05})
        )
        .is_err());

        // split: the cut is on a frame and both halves are whole frames.
        mutate(
            &mut p,
            "edit.trim",
            &json!({"id":"trim-clip","start":10.0,"end":14.0}),
        )
        .unwrap();
        mutate(
            &mut p,
            "edit.split",
            &json!({"id":"trim-clip","time":11.51}),
        )
        .unwrap();
        let (left, right) = (p["clips"][0].clone(), p["clips"][1].clone());
        assert_eq!(
            (&left["duration"], &right["start"]),
            (&json!(1.5), &json!(11.5))
        );
        assert_eq!(right["duration"], 2.5);

        // paste: position and length.
        let mut copy = added.clone();
        copy["start"] = json!(0.013);
        copy["duration"] = json!(1.26);
        copy["fadeIn"] = json!(1.0);
        copy["fadeOut"] = json!(1.0);
        mutate(&mut p, "edit.paste", &json!({"clips":[copy],"at":5.01})).unwrap();
        let pasted = p["clips"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(pasted["start"], 5.0);
        assert_eq!(pasted["duration"], 38.0 / 30.0);
        assert_close(
            number(&pasted, "fadeIn", 0.0) + number(&pasted, "fadeOut", 0.0),
            38.0 / 30.0,
        );

        // A stored project with off-grid clips still validates, an unrelated edit
        // does not move them, and the next clip starts on the frame after them.
        let mut legacy = trim_project("video", false, 1.0);
        legacy["clips"][0]["start"] = json!(10.013);
        legacy["clips"][0]["duration"] = json!(4.021);
        legacy["clips"][1]["start"] = json!(16.004);
        legacy["clips"][1]["duration"] = json!(2.003);
        validate_project(&legacy).unwrap();
        mutate(
            &mut legacy,
            "edit.update",
            &json!({"id":"trim-clip","patch":{"volume":0.5,"trackId":"video-1"}}),
        )
        .unwrap();
        assert_eq!(
            (
                &legacy["clips"][0]["start"],
                &legacy["clips"][0]["duration"]
            ),
            (&json!(10.013), &json!(4.021))
        );
        // Shifting keeps the spacing of off-grid clips exactly.
        mutate(
            &mut legacy,
            "edit.shift",
            &json!({"trackId":"video-1","from":0.0,"delta":1.0}),
        )
        .unwrap();
        assert_close(number(&legacy["clips"][0], "start", 0.0), 11.013);
        mutate(
            &mut legacy,
            "edit.add",
            &json!({"text":"next","trackId":text_track}),
        )
        .unwrap();
        let next = legacy["clips"].as_array().unwrap().last().unwrap();
        assert_eq!(next["start"], 541.0 / 30.0); // the track ends at 18.007 s, in frame 540
                                                 // Only one boundary of an off-grid clip was asked to move.
        mutate(
            &mut legacy,
            "edit.trim",
            &json!({"id":"trim-clip","end":13.01}),
        )
        .unwrap();
        assert_close(number(&legacy["clips"][0], "start", 0.0), 11.013);
        assert_close(number(&legacy["clips"][0], "duration", 0.0), 13.0 - 11.013);

        // A source shorter than the rounded length gives the partial frame back.
        let mut short = trim_project("video", false, 1.0);
        short["media"][0]["duration"] = json!(10.02); // 300.6 frames
        short["clips"] = json!([]);
        mutate(&mut short, "edit.add", &json!({"mediaId":"trim-media"})).unwrap();
        assert_eq!(short["clips"][0]["duration"], 10.0);
    }

    #[tokio::test]
    async fn project_list_names_a_cover_thumbnail_that_is_served_for_closed_projects() {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let thumbnails = e.root.join("thumbnails");
        std::fs::create_dir_all(&thumbnails).unwrap();
        let (late, early) = (thumbnails.join("late.jpg"), thumbnails.join("early.jpg"));
        std::fs::write(&late, b"late").unwrap();
        std::fs::write(&early, b"early").unwrap();
        let outside = e.root.join("outside.jpg");
        std::fs::write(&outside, b"outside").unwrap();
        let first = e.project["id"].as_str().unwrap().to_owned();
        assert_eq!(
            e.dispatch("project.list", json!({})).await.unwrap()[0]["empty"],
            true
        );
        assert!(e.dispatch("project.list", json!({})).await.unwrap()[0]
            .get("thumbnail")
            .is_none());

        let mut p = e.project.clone();
        p["media"] = json!([
            {"id":"sound","path":"/tmp/a.wav","kind":"audio","duration":9.0,"hasAudio":true,"thumbnail":late},
            {"id":"bare","path":"/tmp/bare.png","kind":"image","duration":5.0},
            {"id":"foreign","path":"/tmp/foreign.png","kind":"image","duration":5.0,"thumbnail":outside},
            {"id":"late","path":"/tmp/late.mp4","kind":"video","duration":9.0,"hasAudio":true,"thumbnail":late},
            {"id":"early","path":"/tmp/early.png","kind":"image","duration":5.0,"thumbnail":early},
            {"id":"gone","path":"/tmp/gone.png","kind":"image","duration":5.0,"thumbnail":thumbnails.join("gone.jpg")}
        ]);
        let clip = |kind: &str, media: &str, track: &str, start: f64| {
            let mut clip = default_clip(kind, media, track, start, 1.0);
            clip["mediaId"] = json!(media);
            clip
        };
        // The earliest picture clips have no usable thumbnail; "early" is the first that has.
        p["clips"] = json!([
            clip("audio", "sound", "audio-1", 0.0),
            clip("video", "late", "video-1", 6.0),
            clip("image", "bare", "video-1", 0.0),
            clip("image", "foreign", "video-1", 1.0),
            clip("image", "gone", "video-1", 2.0),
            clip("image", "early", "video-1", 3.0)
        ]);
        e.commit(p).unwrap();
        let cover = json!({"mediaId":"early","path":early});
        let list = e.dispatch("project.list", json!({})).await.unwrap();
        assert_eq!(list[0]["thumbnail"], cover);
        assert_eq!(e.project_thumbnail(&first, "early"), Some(early.clone()));

        // Still there, and still served, once another project is open.
        e.dispatch("project.new", json!({"name":"둘째"}))
            .await
            .unwrap();
        let list = e.dispatch("project.list", json!({})).await.unwrap();
        let listed = |id: &str| {
            list.as_array()
                .unwrap()
                .iter()
                .find(|item| item["id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(listed(&first)["thumbnail"], cover);
        assert!(listed(e.project["id"].as_str().unwrap())
            .get("thumbnail")
            .is_none());
        assert_eq!(e.asset_path("early", true), None);
        assert_eq!(e.project_thumbnail(&first, "early"), Some(early));
        assert_eq!(e.project_thumbnail(&first, "late"), Some(late));
        // Nothing outside the thumbnail folder, missing, unknown or with an unsafe id.
        for (project, media) in [
            (first.as_str(), "foreign"),
            (first.as_str(), "gone"),
            (first.as_str(), "bare"),
            (first.as_str(), "missing"),
            ("missing", "early"),
            ("../current", "early"),
        ] {
            assert_eq!(
                e.project_thumbnail(project, media),
                None,
                "{project} {media}"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn span(clip: &Value) -> (f64, f64) {
        // Frame numbers; anything off the grid stays visibly fractional.
        let frame = |seconds: f64| (seconds * 30.0 * 1e6).round() / 1e6;
        let start = number(clip, "start", -1.0);
        (frame(start), frame(start + number(clip, "duration", -1.0)))
    }

    #[tokio::test]
    async fn clips_that_touch_before_frame_rounding_still_touch_after_it() {
        // 1.017 s = 30.51 frames, 2.534 s = 76.02 frames: rounding start and length
        // separately would end the first clip on frame 77 and start the second on 76.
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let srt = dir.join("touching.srt");
        std::fs::write(
            &srt,
            "1\n00:00:01,017 --> 00:00:02,534\nfirst\n\n2\n00:00:02,534 --> 00:00:04,000\nsecond\n",
        )
        .unwrap();
        let p = e
            .dispatch("captions.import", json!({"path":srt}))
            .await
            .unwrap();
        assert_eq!(span(&p["clips"][0]), (31.0, 76.0));
        assert_eq!(span(&p["clips"][1]), (76.0, 120.0));
        std::fs::remove_dir_all(dir).unwrap();

        let mut p = trim_project("video", false, 1.0);
        for (start, duration) in [(1.017, 1.517), (2.534, 1.466)] {
            mutate(
                &mut p,
                "edit.add",
                &json!({"text":"t","start":start,"duration":duration}),
            )
            .unwrap();
        }
        assert_eq!(span(&p["clips"][2]), (31.0, 76.0));
        assert_eq!(span(&p["clips"][3]), (76.0, 120.0));
        // update with both values: the same ends as add.
        let neighbour = p_id(&p, 1);
        mutate(
            &mut p,
            "edit.update",
            &json!({"id":neighbour,"patch":{"start":1.017,"duration":1.517}}),
        )
        .unwrap();
        assert_eq!(span(&p["clips"][1]), (31.0, 76.0));
        // paste: a touching pair pasted at an off-grid time stays touching.
        let copies = json!([p["clips"][2], p["clips"][3]]);
        mutate(&mut p, "edit.paste", &json!({"clips":copies,"at":10.017})).unwrap();
        let (first, second) = (span(&p["clips"][4]), span(&p["clips"][5]));
        assert_eq!(first.0, 301.0);
        assert_eq!(first.1, second.0);
        assert_eq!(second.1 - second.0, 44.0);
        // A length under half a frame is still one frame.
        mutate(
            &mut p,
            "edit.add",
            &json!({"text":"t","start":1.017,"duration":0.001}),
        )
        .unwrap();
        assert_eq!(span(&p["clips"][6]), (31.0, 32.0));
    }

    #[test]
    fn a_speed_change_and_back_restores_the_length() {
        // Frames 60..180 of the timeline, 4 s of a 30 s source.
        let project = || {
            let mut p = trim_project("video", false, 1.0);
            p["clips"][0]["start"] = json!(2.0);
            p
        };
        let update = |p: &mut Value, patch: Value| {
            mutate(p, "edit.update", &json!({"id":"trim-clip","patch":patch})).unwrap();
            p["clips"][0].clone()
        };
        let mut p = project();
        let clip = update(&mut p, json!({"speed":1.7})); // 70.59 frames
        assert_eq!(frames(&clip["duration"]), 71.0);
        let clip = update(&mut p, json!({"speed":1.0}));
        assert_eq!(span(&clip), (60.0, 180.0));
        // Several steps away and back.
        for speed in [0.3, 2.9, 1.1, 1.0] {
            update(&mut p, json!({"speed":speed}));
        }
        assert_eq!(span(&p["clips"][0]), (60.0, 180.0));

        // The inspector sends the length it derived along with the speed.
        let mut p = project();
        let clip = update(&mut p, json!({"speed":1.7,"duration":4.0 / 1.7}));
        assert_eq!(frames(&clip["duration"]), 71.0);
        let length = number(&clip, "duration", 0.0) * 1.7;
        let clip = update(&mut p, json!({"speed":1.0,"duration":length}));
        assert_eq!(span(&clip), (60.0, 180.0));

        // A clip that ends with its source gives the partial frame back while
        // faster, and still returns to its length.
        let mut p = project();
        p["media"][0]["duration"] = json!(12.0);
        let clip = update(&mut p, json!({"speed":1.7}));
        assert_eq!(frames(&clip["duration"]), 70.0);
        let clip = update(&mut p, json!({"speed":1.0}));
        assert_eq!(span(&clip), (60.0, 180.0));

        // A resize after the speed change makes the new length the reference.
        let mut p = project();
        update(&mut p, json!({"speed":1.7}));
        update(&mut p, json!({"duration":2.0}));
        let clip = update(&mut p, json!({"speed":1.0}));
        assert_eq!(frames(&clip["duration"]), 102.0);
        // A length given with a speed that is not the derived one is a resize.
        let clip = update(&mut p, json!({"speed":2.0,"duration":1.0}));
        assert_eq!(frames(&clip["duration"]), 30.0);
        validate_project(&p).unwrap();
        p["clips"][0]["sourceSpan"] = json!("4");
        assert!(validate_project(&p).is_err());
    }

    #[test]
    fn shift_keeps_grouped_clips_on_other_tracks_together() {
        let mut p = trim_project("video", false, 1.0);
        let text_track = p["clips"][1]["trackId"].clone();
        let mut clips = Vec::new();
        for (id, start, group) in [("a", 0.0, "one"), ("b", 2.0, "two"), ("c", 4.0, "three")] {
            let mut clip = p["clips"][0].clone();
            clip["id"] = json!(id);
            clip["start"] = json!(start);
            clip["duration"] = json!(2.0);
            clip["groupId"] = json!(group);
            clips.push(clip);
        }
        // Captions: one before `from` grouped with a moving clip, one loose, and
        // two in a group that also has a clip staying on the shifted track.
        for (id, start, group) in [
            ("cap-b", 1.9, Some("two")),
            ("cap-loose", 3.0, None),
            ("cap-a-early", 0.5, Some("one")),
            ("cap-a-late", 2.5, Some("one")),
        ] {
            let mut clip = p["clips"][1].clone();
            clip["id"] = json!(id);
            clip["start"] = json!(start);
            clip["duration"] = json!(0.5);
            if let Some(group) = group {
                clip["groupId"] = json!(group);
            }
            clips.push(clip);
        }
        p["clips"] = json!(clips);
        p["clips"][2]["groupId"] = json!("one"); // a stays, c moves: group one is split
        validate_project(&p).unwrap();
        let starts = |p: &Value| -> Vec<f64> {
            p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| number(c, "start", -1.0))
                .collect()
        };
        let before = p.clone();
        let shift = json!({"trackId":"video-1","from":2.0,"delta":-0.5});
        mutate(&mut p, "edit.shift", &shift).unwrap();
        assert_eq!(starts(&p), [0.0, 1.5, 3.5, 1.4, 3.0, 0.5, 2.0]);

        // A grouped clip on a locked track, or one that would start before 0,
        // refuses the whole shift.
        let mut locked = before.clone();
        for track in locked["tracks"].as_array_mut().unwrap() {
            if track["id"] == text_track {
                track["locked"] = json!(true);
            }
        }
        let unchanged = locked.clone();
        assert!(mutate(&mut locked, "edit.shift", &shift).is_err());
        assert_eq!(locked, unchanged);
        let mut early = before.clone();
        early["clips"][3]["start"] = json!(0.2);
        assert!(mutate(&mut early, "edit.shift", &shift).is_err());
    }

    #[test]
    fn a_start_before_the_timeline_is_refused_not_rounded_to_zero() {
        let mut p = trim_project("video", false, 1.0);
        let before = p.clone();
        for (method, params) in [
            ("edit.add", json!({"text":"t","start":-0.01,"duration":1.0})),
            (
                "edit.update",
                json!({"id":"trim-clip","patch":{"start":-0.01}}),
            ),
            (
                "edit.update",
                json!({"id":"trim-clip","patch":{"start":-0.01,"duration":1.0}}),
            ),
        ] {
            let mut attempt = p.clone();
            assert!(
                mutate(&mut attempt, method, &params).is_err(),
                "accepted {params}"
            );
        }
        assert_eq!(p, before);
        // Under half a frame after 0 is frame 0, stored as a plain zero.
        for start in [0.01, -0.0] {
            mutate(
                &mut p,
                "edit.update",
                &json!({"id":"trim-clip","patch":{"start":start}}),
            )
            .unwrap();
            let stored = p["clips"][0]["start"].as_f64().unwrap();
            assert!(stored == 0.0 && stored.is_sign_positive());
        }
    }
}
