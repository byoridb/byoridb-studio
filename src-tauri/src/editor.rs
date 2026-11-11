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
}

pub fn number(v: &Value, key: &str, fallback: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(fallback)
}
pub fn string<'a>(v: &'a Value, key: &str, fallback: &'a str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or(fallback)
}

pub fn empty_project(name: &str, width: u64, height: u64, fps: f64) -> Value {
    json!({"id":media::id("project"),"name":name,"revision":0,"width":width,"height":height,
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

impl Editor {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        std::fs::create_dir_all(root.join("projects")).map_err(|e| e.to_string())?;
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let current = root.join("current.json");
        let project = if current.is_file() {
            let project: Value =
                serde_json::from_slice(&std::fs::read(&current).map_err(|e| e.to_string())?)
                    .map_err(|e| format!("저장된 프로젝트를 읽을 수 없습니다: {e}"))?;
            validate_project(&project)?;
            project
        } else {
            empty_project("새 프로젝트", 1920, 1080, 30.0)
        };
        let editor = Self {
            root,
            project,
            undo: vec![],
            redo: vec![],
            jobs: render::RenderJobs::default(),
            preview_assets: HashMap::new(),
        };
        editor.persist()?;
        Ok(editor)
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

    pub fn preview_is_current(&self, snapshot: &Value) -> Result<(), String> {
        if &self.project != snapshot {
            return Err("미리보기 중 프로젝트가 변경되었습니다. (PREVIEW_STALE)".into());
        }
        Ok(())
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
        self.undo.push(before);
        if self.undo.len() > 100 {
            self.undo.remove(0);
        }
        self.redo.clear();
        Ok(self.project.clone())
    }

    fn replace(&mut self, mut project: Value) -> Result<Value, String> {
        validate_project(&project)?;
        project["revision"] = json!(self.project["revision"].as_u64().unwrap_or(0) + 1);
        project["updatedAt"] = json!(media::now());
        let before = std::mem::replace(&mut self.project, project);
        if let Err(e) = self.persist() {
            self.project = before;
            return Err(e);
        }
        self.undo.clear();
        self.redo.clear();
        Ok(self.project.clone())
    }

    pub async fn dispatch(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.expected(&params)?;
        match method {
            "project.get" => Ok(self.project.clone()),
            "project.list" => {
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
                            list.push(
                                json!({"id":p["id"],"name":p["name"],"updatedAt":p["updatedAt"]}),
                            );
                        }
                    }
                }
                list.sort_by_key(|p| std::cmp::Reverse(p["updatedAt"].as_u64().unwrap_or(0)));
                Ok(json!(list))
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
                    self.root.join("projects").join(format!("{id}.json"))
                };
                let mut p: Value = serde_json::from_slice(
                    &std::fs::read(&path).map_err(|e| format!("프로젝트 열기 실패: {e}"))?,
                )
                .map_err(|e| e.to_string())?;
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
                self.replace(p)
            }
            "project.save" => {
                self.persist()?;
                let path = params["path"]
                    .as_str()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| {
                        self.root
                            .join("projects")
                            .join(format!("{}.json", self.project["id"].as_str().unwrap()))
                    });
                if self.project["media"].as_array().unwrap().iter().any(|m| {
                    m["path"]
                        .as_str()
                        .map(|p| media::same_path(Path::new(p), &path))
                        .unwrap_or(false)
                }) {
                    return Err("원본 미디어 위에 프로젝트를 저장할 수 없습니다.".into());
                }
                media::atomic_json(&path, &self.project)?;
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
                let mut patch = preset["patch"].clone();
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
                    let asset = media::probe(path, &self.root).await?;
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
                        media::probe(Path::new(required(&asset, "path")?), &self.root).await?;
                    refresh_media_metadata(&mut p, required(&asset, "id")?, refreshed)?;
                }
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
                let mut next = old.ok_or(if is_undo {
                    "실행 취소할 작업이 없습니다."
                } else {
                    "다시 실행할 작업이 없습니다."
                })?;
                let original = next.clone();
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
                if is_undo {
                    self.redo.push(before)
                } else {
                    self.undo.push(before)
                };
                Ok(self.project.clone())
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
                if self.project["media"].as_array().unwrap().iter().any(|m| {
                    m["path"]
                        .as_str()
                        .map(|p| media::same_path(Path::new(p), &path))
                        .unwrap_or(false)
                }) {
                    return Err("원본 미디어를 덮어쓸 수 없습니다.".into());
                }
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
                std::fs::write(&path, content).map_err(|e| e.to_string())?;
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
            let m = media::probe(&path, &self.root).await?;
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
            "fadeIn":0.0,"fadeOut":0.0,"transitionIn":null,"transitionOut":null,"keyframes":[]})
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
                json!({"type":"fade","duration":duration})
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
            if transition["type"] != "fade" {
                return Err("프리셋 전환은 fade만 지원합니다.".into());
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
        &json!({"id":"preset-validation","patch":preset["patch"]}),
    )
}

pub fn keyframe_property(property: &str) -> &str {
    property.strip_prefix("transform.").unwrap_or(property)
}

pub fn keyframe_points(clip: &Value, property: &str) -> Vec<(f64, f64)> {
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
        .map(|k| (number(k, "time", 0.0), number(k, "value", base)))
        .collect();
    points.sort_by(|a, b| a.0.total_cmp(&b.0));
    if points.first().is_none_or(|p| p.0 > 0.0) {
        points.insert(0, (0.0, base));
    }
    points
}

pub fn keyframe_value(clip: &Value, property: &str, time: f64) -> f64 {
    let points = keyframe_points(clip, property);
    if time <= points[0].0 {
        return points[0].1;
    }
    for pair in points.windows(2) {
        if time <= pair[1].0 {
            let ratio = (time - pair[0].0) / (pair[1].0 - pair[0].0).max(f64::EPSILON);
            return pair[0].1 + (pair[1].1 - pair[0].1) * ratio;
        }
    }
    points.last().unwrap().1
}

fn split_keyframes(clip: &Value, time: f64) -> (Value, Value) {
    let properties: std::collections::BTreeSet<_> = clip["keyframes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|k| keyframe_property(string(k, "property", "")).to_owned())
        .collect();
    let mut left = vec![];
    let mut right = vec![];
    for property in properties {
        let value = keyframe_value(clip, &property, time);
        for (t, v) in keyframe_points(clip, &property) {
            if t < time {
                left.push(json!({"property":property,"time":t,"value":v}));
            }
            if t > time {
                right.push(json!({"property":property,"time":t-time,"value":v}));
            }
        }
        left.push(json!({"property":property,"time":time,"value":value}));
        right.insert(0, json!({"property":property,"time":0.0,"value":value}));
    }
    (json!(left), json!(right))
}

// Keep animation tied to its original timeline positions, including interpolated
// values at the new edges. Extending an edge holds the nearest original value.
fn trim_keyframes(clip: &Value, start: f64, duration: f64) -> Value {
    let end = start + duration;
    let properties: std::collections::BTreeSet<_> = clip["keyframes"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|k| keyframe_property(string(k, "property", "")).to_owned())
        .collect();
    let mut frames = vec![];
    for property in properties {
        frames.push(
            json!({"property":property,"time":0.0,"value":keyframe_value(clip,&property,start)}),
        );
        for (time, value) in keyframe_points(clip, &property) {
            if time > start && time < end {
                frames.push(json!({"property":property,"time":time-start,"value":value}));
            }
        }
        frames.push(
            json!({"property":property,"time":duration,"value":keyframe_value(clip,&property,end)}),
        );
    }
    json!(frames)
}

fn fit_clip_fades(clip: &mut Value) {
    let duration = number(clip, "duration", 0.0);
    for (fade, transition) in [("fadeIn", "transitionIn"), ("fadeOut", "transitionOut")] {
        let length = number(clip, fade, 0.0).min(duration);
        clip[fade] = json!(length);
        if clip[transition]["type"] == "fade" {
            clip[transition]["duration"] = json!(length);
        }
    }
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
            let track = if let Some(id) = args["trackId"].as_str() {
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
            let default_start = p["clips"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| c["trackId"] == track_id)
                .map(|c| number(c, "start", 0.0) + number(c, "duration", 0.0))
                .fold(0.0, f64::max);
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
                clip["transform"]["y"] = json!(number(p, "height", 1080.0) * 0.32);
            }
            if let Some(source) = args.get("sourceIn") {
                clip["sourceIn"] = source.clone();
            }
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
                if ![
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
                ]
                .contains(&key.as_str())
                {
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
            if patch.contains_key("filter") && !patch.contains_key("color") {
                let color = match string(&p["clips"][index], "filter", "none") {
                    "none" => {
                        json!({"brightness":0.0,"contrast":1.0,"saturation":1.0,"temperature":0.0})
                    }
                    "cinematic" => {
                        json!({"brightness":-0.02,"contrast":1.15,"saturation":0.85,"temperature":0.0})
                    }
                    "warm" => {
                        json!({"brightness":0.02,"contrast":1.03,"saturation":1.05,"temperature":0.5})
                    }
                    "cool" => {
                        json!({"brightness":0.0,"contrast":1.05,"saturation":0.95,"temperature":-0.5})
                    }
                    "mono" => {
                        json!({"brightness":0.0,"contrast":1.1,"saturation":0.0,"temperature":0.0})
                    }
                    "vintage" => {
                        json!({"brightness":0.03,"contrast":0.9,"saturation":0.75,"temperature":0.3})
                    }
                    _ => return Err("지원하지 않는 필터 프리셋입니다.".into()),
                };
                p["clips"][index]["color"] = color;
            }
            for (transition, fade) in [("transitionIn", "fadeIn"), ("transitionOut", "fadeOut")] {
                if let Some(value) = patch.get(transition) {
                    if value.is_null() {
                        p["clips"][index][fade] = json!(0.0);
                    } else if value["type"] == "fade" {
                        p["clips"][index][fade] = value["duration"].clone();
                    } else {
                        return Err("현재 전환은 fade 형식만 지원합니다. fadeIn/fadeOut으로 길이를 지정할 수도 있습니다.".into());
                    }
                }
            }
            if patch.contains_key("speed") && !patch.contains_key("duration") {
                let speed = number(&p["clips"][index], "speed", 1.0);
                if speed.is_finite() && speed > 0.0 {
                    let ratio = number(&original, "speed", 1.0) / speed;
                    p["clips"][index]["duration"] =
                        json!(number(&original, "duration", 1.0) * ratio);
                    if !patch.contains_key("keyframes") {
                        if let Some(frames) = p["clips"][index]["keyframes"].as_array_mut() {
                            for frame in frames {
                                frame["time"] = json!(number(frame, "time", 0.0) * ratio);
                            }
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
            if patch.contains_key("text")
                && p["clips"][index]["kind"] == "text"
                && !patch.contains_key("name")
            {
                p["clips"][index]["name"] = p["clips"][index]["text"]["content"].clone();
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
            let start = boundary("start", old_start)?;
            let end = boundary("end", old_end)?;
            let duration = end - start;
            const TIME_EPSILON: f64 = 1e-8;
            if start < 0.0 || duration + TIME_EPSILON < 1.0 / number(p, "fps", 30.0) {
                return Err(
                    "트림 시작 위치는 0 이상이고 클립 길이는 최소 1프레임이어야 합니다.".into(),
                );
            }
            let mut trimmed = original.clone();
            if matches!(string(&original, "kind", ""), "video" | "audio") {
                let speed = number(&original, "speed", 1.0);
                let offset = if original["reverse"] == true {
                    old_end - end
                } else {
                    start - old_start
                };
                let source = number(&original, "sourceIn", 0.0) + offset * speed;
                let media_duration = p["media"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|m| m["id"] == original["mediaId"])
                    .map(|m| number(m, "duration", 0.0))
                    .ok_or("클립 원본을 찾을 수 없습니다.")?;
                if source < -TIME_EPSILON
                    || source + duration * speed > media_duration + TIME_EPSILON
                {
                    return Err("트림 범위가 원본 미디어 길이를 벗어납니다.".into());
                }
                trimmed["sourceIn"] = json!(source.max(0.0));
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
            let start = number(&clip, "start", 0.0);
            let duration = number(&clip, "duration", 0.0);
            let relative = time - start;
            let frame = 1.0 / number(p, "fps", 30.0);
            if !time.is_finite() || relative + 1e-8 < frame || duration - relative + 1e-8 < frame {
                return Err(
                    "분할한 두 클립의 길이가 각각 최소 1프레임이 되도록 위치를 선택해 주세요."
                        .into(),
                );
            }
            let mut right = clip.clone();
            right["id"] = json!(media::id("clip"));
            right["start"] = json!(time);
            right["duration"] = json!(duration - relative);
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
                c["start"] = json!(number(&c, "start", 0.0) + end - start);
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
            let clips = p["clips"].as_array_mut().unwrap();
            clips.retain(|c| !ids.contains(&c["id"]));
            if ripple {
                for c in clips {
                    let start = number(c, "start", 0.0);
                    let mut ranges: Vec<(f64, f64)> = removed
                        .iter()
                        .filter(|r| {
                            r["trackId"] == c["trackId"]
                                && number(r, "start", 0.0) + number(r, "duration", 0.0)
                                    <= start + 0.0001
                        })
                        .map(|r| {
                            (
                                number(r, "start", 0.0),
                                number(r, "start", 0.0) + number(r, "duration", 0.0),
                            )
                        })
                        .collect();
                    ranges.sort_by(|a, b| a.0.total_cmp(&b.0));
                    let mut shift = 0.0;
                    let mut previous: Option<(f64, f64)> = None;
                    for (a, b) in ranges {
                        match previous {
                            Some((x, y)) if a <= y => previous = Some((x, y.max(b))),
                            Some((x, y)) => {
                                shift += y - x;
                                previous = Some((a, b));
                            }
                            None => previous = Some((a, b)),
                        }
                    }
                    if let Some((a, b)) = previous {
                        shift += b - a;
                    }
                    c["start"] = json!((start - shift).max(0.0));
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
        _ => return Err(format!("배치에서 지원하지 않는 편집 명령입니다: {method}")),
    }
    validate_project(p)
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
            }
        }
    }
    // Preserve identity, the user's name, paths, and any future/custom metadata.
    for field in [
        "kind",
        "duration",
        "width",
        "height",
        "hasAudio",
        "thumbnail",
        "waveform",
    ] {
        p["media"][index][field] = asset[field].clone();
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
    }
    for asset in assets {
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
            if c["text"].get("bold").is_some() && !c["text"]["bold"].is_boolean() {
                return Err("텍스트 굵기 값이 올바르지 않습니다.".into());
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
        }
    }
    if !p["notes"].is_array() || !p["markers"].is_array() || !p["concept"].is_object() {
        return Err("프로젝트 메모/마커/컨셉 형식이 올바르지 않습니다.".into());
    }
    Ok(())
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
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
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

    fn misclassified_audio_editor() -> (Editor, PathBuf) {
        let dir = temp();
        let mut e = Editor::new(dir.clone()).unwrap();
        let path = dir.join("music.wav");
        let samples = 16_000u32;
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
        std::fs::write(&path, wav).unwrap();
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
        for (fade, transition) in [("fadeIn", "transitionIn"), ("fadeOut", "transitionOut")] {
            assert_eq!(p["clips"][0][fade], 1.0);
            assert_eq!(p["clips"][0][transition]["duration"], 1.0);
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
                "transitionIn":{"type":"fade","duration":3.0},
                "transitionOut":{"type":"fade","duration":4.0}
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
        assert_eq!(p["clips"][1]["fadeOut"], 3.0);
        assert_eq!(p["clips"][0]["transitionOut"]["duration"], 0.0);
        assert_eq!(p["clips"][1]["transitionIn"]["duration"], 0.0);
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
}
