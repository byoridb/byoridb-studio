use crate::{
    editor::{number, string, valid_color, validate_project},
    media,
};
use fontdue::Font;
use image::{Rgba, RgbaImage};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader},
    process::Command,
};

pub use crate::media::extract_frame;

const MAX_JOBS: usize = 64;
const MAX_PREVIEW_VIDEOS: usize = 2;
const STDERR_TAIL: usize = 64 * 1024;

#[derive(Default)]
pub struct RenderJobs {
    states: Arc<Mutex<HashMap<String, Value>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
    preview_videos: Mutex<VecDeque<PathBuf>>,
}

fn partial_outputs() -> &'static Mutex<HashSet<PathBuf>> {
    static PARTIAL: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    PARTIAL.get_or_init(Default::default)
}

/// Deletes the unfinished files of exports still running. Call at process exit,
/// after their FFmpeg processes were killed.
pub fn remove_partial_outputs() {
    for path in partial_outputs().lock().unwrap().drain() {
        let _ = std::fs::remove_file(path);
    }
}

/// `previews/` and `renders/` only hold scratch files of the running process, so
/// whatever an earlier run left behind is removed before this one creates its own.
fn clean_stale_once(root: &Path) {
    static CLEANED: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    if !CLEANED
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(root.to_path_buf())
    {
        return;
    }
    for name in ["previews", "renders"] {
        for entry in std::fs::read_dir(root.join(name)).into_iter().flatten().flatten() {
            let _ = if entry.file_type().is_ok_and(|t| t.is_dir()) {
                std::fs::remove_dir_all(entry.path())
            } else {
                std::fs::remove_file(entry.path())
            };
        }
    }
}

/// Makes room for one more job by forgetting the oldest finished ones.
fn prune_finished(states: &mut HashMap<String, Value>) {
    while states.len() >= MAX_JOBS {
        let oldest = states
            .values()
            .filter(|job| !["queued", "running"].contains(&string(job, "state", "")))
            .min_by_key(|job| job["startedAt"].as_u64().unwrap_or(0))
            .map(|job| string(job, "id", "").to_string());
        match oldest {
            Some(id) => states.remove(&id),
            None => break,
        };
    }
}

impl RenderJobs {
    pub async fn start(
        &self,
        project: Value,
        params: Value,
        root: PathBuf,
    ) -> Result<Value, String> {
        validate_project(&project)?;
        clean_stale_once(&root);
        if project["clips"].as_array().unwrap().is_empty() {
            return Err("타임라인에 클립을 추가한 뒤 내보내 주세요.".into());
        }
        let format = string(&params, "format", "mp4").to_lowercase();
        if !["mp4", "mov", "webm", "mp3", "wav"].contains(&format.as_str()) {
            return Err("내보내기 형식은 mp4, mov, webm, mp3, wav 중에서 선택해 주세요.".into());
        }
        let home = std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = match params["path"].as_str().filter(|p| !p.trim().is_empty()) {
            Some(p) if p.starts_with("~/") => home.join(&p[2..]),
            Some(p) => PathBuf::from(p),
            None => home.join("Movies/Byori Studio").join(format!(
                "{}.{}",
                string(&project, "name", "영상").replace(['/', '\\', ':'], "_"),
                format
            )),
        };
        if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase())
            != Some(format.clone())
        {
            return Err(format!("저장 파일의 확장자를 .{format}로 지정해 주세요."));
        }
        let output = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .map_err(|e| e.to_string())?
                .join(path)
        };
        if project["media"].as_array().unwrap().iter().any(|m| {
            m["path"]
                .as_str()
                .map(|p| media::same_path(Path::new(p), &output))
                .unwrap_or(false)
        }) {
            return Err("원본 미디어 파일을 덮어쓸 수 없습니다.".into());
        }
        if params["overwrite"] != true && output.exists() {
            return Err(format!(
                "같은 이름의 파일이 이미 있습니다: {} (FILE_EXISTS)",
                output.display()
            ));
        }
        for job in self.states.lock().unwrap().values() {
            if job["path"] == output.to_string_lossy().as_ref()
                && ["queued", "running"].contains(&string(job, "state", ""))
            {
                return Err("같은 경로로 내보내는 작업이 진행 중입니다.".into());
            }
        }
        let duration = project_duration(&project);
        let start = number(&params, "start", 0.0);
        let end = number(&params, "end", duration);
        if !start.is_finite()
            || !end.is_finite()
            || start < 0.0
            || end > duration + 0.001
            || end <= start
        {
            return Err("내보내기 구간이 올바르지 않습니다.".into());
        }
        let width = number(&params, "width", number(&project, "width", 1920.0));
        let height = number(&params, "height", number(&project, "height", 1080.0));
        let fps = number(&params, "fps", number(&project, "fps", 30.0));
        let crf = number(&params, "crf", 23.0);
        if ![width, height, fps, crf].iter().all(|n| n.is_finite())
            || !(16.0..=8192.0).contains(&width)
            || !(16.0..=8192.0).contains(&height)
            || !(1.0..=120.0).contains(&fps)
            || !(0.0..=51.0).contains(&crf)
        {
            return Err("내보내기 크기·프레임레이트·품질을 확인해 주세요.".into());
        }
        let codec = params.get("codec").filter(|v| !v.is_null());
        if let Some(codec) = codec {
            if !["h264", "hevc"].contains(&codec.as_str().unwrap_or("")) {
                return Err("코덱은 h264 또는 hevc 중에서 선택해 주세요.".into());
            }
            if codec == "hevc" && !["mp4", "mov"].contains(&format.as_str()) {
                return Err("HEVC 코덱은 mp4 또는 mov 형식에서만 사용할 수 있습니다.".into());
            }
        }
        if params.get("hardware").is_some_and(|v| !v.is_boolean() && !v.is_null()) {
            return Err("하드웨어 인코딩 설정은 true 또는 false여야 합니다.".into());
        }
        if let Some(bitrate) = params.get("bitrate").filter(|v| !v.is_null()) {
            if !bitrate.as_f64().is_some_and(|b| (100.0..=200_000.0).contains(&b)) {
                return Err("비트레이트는 100~200000 kbps 범위에서 지정해 주세요.".into());
            }
        }
        let id = media::id("export");
        let cancel = Arc::new(AtomicBool::new(false));
        {
            let mut states = self.states.lock().unwrap();
            prune_finished(&mut states);
            states.insert(id.clone(),json!({"id":id,"state":"queued","progress":0.0,"path":output,"projectRevision":project["revision"],"startedAt":media::now()}));
        }
        self.cancels
            .lock()
            .unwrap()
            .insert(id.clone(), cancel.clone());
        // Only the most recent precise-playback videos are kept on disk.
        if params["preview"] == true && output.starts_with(root.join("previews")) {
            let mut videos = self.preview_videos.lock().unwrap();
            videos.push_back(output.clone());
            while videos.len() > MAX_PREVIEW_VIDEOS {
                let old = videos.pop_front().unwrap();
                for job in self.states.lock().unwrap().values() {
                    if job["path"] == old.to_string_lossy().as_ref() {
                        if let Some(cancel) = self.cancels.lock().unwrap().get(string(job, "id", "")) {
                            cancel.store(true, Ordering::Relaxed);
                        }
                    }
                }
                let _ = std::fs::remove_file(old);
            }
        }
        let states = self.states.clone();
        let cancels = self.cancels.clone();
        let job_id = id.clone();
        tokio::spawn(async move {
            update(&states, &job_id, "running", 0.0, None);
            let result = run(
                project,
                params,
                &output,
                &format,
                &root,
                &job_id,
                states.clone(),
                cancel.clone(),
            )
            .await;
            match result {
                Ok(()) => update(&states, &job_id, "completed", 1.0, None),
                Err(e) if cancel.load(Ordering::Relaxed) => {
                    update(&states, &job_id, "cancelled", 0.0, Some(&e))
                }
                Err(e) => update(&states, &job_id, "failed", 0.0, Some(&e)),
            }
            cancels.lock().unwrap().remove(&job_id);
        });
        Ok(json!({"id":id}))
    }
    pub fn status(&self, id: &str) -> Result<Value, String> {
        self.states
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .ok_or("내보내기 작업을 찾을 수 없습니다.".into())
    }
    pub fn cancel(&self, id: &str) -> Result<Value, String> {
        let status = self.status(id)?;
        if let Some(cancel) = self.cancels.lock().unwrap().get(id) {
            cancel.store(true, Ordering::Relaxed);
            Ok(json!({"id":id,"state":"cancelling"}))
        } else {
            Ok(status)
        }
    }
}

fn update(
    states: &Arc<Mutex<HashMap<String, Value>>>,
    id: &str,
    state: &str,
    progress: f64,
    error: Option<&str>,
) {
    if let Some(job) = states.lock().unwrap().get_mut(id) {
        job["state"] = json!(state);
        job["progress"] = json!(progress);
        if let Some(e) = error {
            job["error"] = json!(e);
        }
    }
}
pub fn project_duration(p: &Value) -> f64 {
    p["clips"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| number(c, "start", 0.0) + number(c, "duration", 0.0))
        .fold(0.0, f64::max)
}

pub async fn preview_frame(project: &Value, params: &Value, root: &Path) -> Result<Value, String> {
    preview_frame_cancellable(project, params, root, Arc::new(AtomicBool::new(false))).await
}

/// Renders one exact frame; setting `cancel` stops the running FFmpeg process.
pub async fn preview_frame_cancellable(
    project: &Value,
    params: &Value,
    root: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    validate_project(project)?;
    render_frame(project, params, root, cancel).await
}

async fn render_frame(
    project: &Value,
    params: &Value,
    root: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<Value, String> {
    clean_stale_once(root);
    let duration = project_duration(project);
    let requested_time = number(params, "time", 0.0);
    if duration <= 0.0
        || !requested_time.is_finite()
        || requested_time < 0.0
        || requested_time >= duration
    {
        return Err("타임라인 내부의 미리보기 위치를 선택해 주세요.".into());
    }
    // A playhead on a frame boundary can arrive a hair below it (123/30 * 30 is
    // 122.99999999999999): that is frame 123, not the one before.
    let time = (requested_time * number(project, "fps", 30.0) + 1e-6).floor()
        / number(project, "fps", 30.0);
    let width = number(params, "width", 640.0).clamp(64.0, 1920.0) as u32 / 2 * 2;
    let height = (width as f64 * number(project, "height", 1080.0)
        / number(project, "width", 1920.0)) as u32
        / 2
        * 2;
    let directory = root.join("previews");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let id = media::id("preview");
    let output = directory.join(format!("{id}.png"));
    let temp = directory.join(&id);
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    let args = json!({"width":width,"height":height,"start":time,"end":(time+1.0/number(project,"fps",30.0)).min(duration)});
    let result = run_process(
        project,
        &args,
        &output,
        "png",
        &temp,
        &id,
        Arc::new(Mutex::new(HashMap::new())),
        cancel,
        "",
    )
    .await;
    let _ = std::fs::remove_dir_all(temp);
    if result.is_err() {
        let _ = std::fs::remove_file(&output);
    }
    result?;
    Ok(
        json!({"path":output,"width":width,"height":height,"time":time,"revision":project["revision"]}),
    )
}

fn property_alias(property: &str) -> &str {
    property.strip_prefix("transform.").unwrap_or(property)
}

/// The value of a keyframed property as an FFmpeg expression of `time` (clip seconds).
/// Each keyframe's `easing` shapes the segment up to the next keyframe.
fn expression(c: &Value, property: &str, default: f64, time: &str) -> String {
    let mut frames: Vec<(f64, f64, &str)> = c["keyframes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|k| property_alias(string(k, "property", "")) == property_alias(property))
        .map(|k| {
            (
                number(k, "time", 0.0),
                number(k, "value", default),
                string(k, "easing", "linear"),
            )
        })
        .collect();
    frames.sort_by(|a, b| a.0.total_cmp(&b.0));
    frames.dedup_by(|a, b| a.0 == b.0);
    if frames.is_empty() {
        return format!("{default:.6}");
    }
    if frames[0].0 > 0.0 {
        frames.insert(0, (0.0, default, "linear"));
    }
    let mut expr = format!("{:.6}", frames.last().unwrap().1);
    for pair in frames.windows(2).rev() {
        let (a, b) = (pair[0], pair[1]);
        // Progress 0..1 through the segment.
        let u = format!("(({time})-{:.6})/{:.6}", a.0, (b.0 - a.0).max(0.00001));
        let eased = match a.2 {
            "hold" => "0".to_string(),
            "easeIn" => format!("pow({u},2)"),
            "easeOut" => format!("(1-pow(1-{u},2))"),
            "easeInOut" => format!("(pow({u},2)*(3-2*{u}))"),
            _ => u,
        };
        let segment = format!("{:.6}+({:.6})*{eased}", a.1, b.1 - a.1);
        expr = format!("if(lt({time},{:.6}),{segment},{expr})", b.0);
    }
    expr
}

fn has_keyframe(c: &Value, property: &str) -> bool {
    c["keyframes"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|k| property_alias(string(k, "property", "")) == property)
}

/// The clip's entrance (`enter`) or exit animation as (type, seconds). A clip with
/// only fadeIn/fadeOut, as older projects have, fades.
fn transition(clip: &Value, enter: bool, length: f64) -> Option<(&str, f64)> {
    let (field, fade) = if enter {
        ("transitionIn", "fadeIn")
    } else {
        ("transitionOut", "fadeOut")
    };
    let fade = number(clip, fade, 0.0);
    let value = &clip[field];
    let (kind, duration) = if value.is_object() {
        (string(value, "type", "fade"), number(value, "duration", fade))
    } else {
        ("fade", fade)
    };
    let duration = duration.min(length);
    (duration > 0.0).then_some((kind, duration))
}

/// How far the transition has come, 0 (clip absent) to 1 (clip fully there), as an
/// expression of the clip-local `time`.
fn transition_progress(enter: bool, duration: f64, length: f64, time: &str) -> String {
    if enter {
        format!("clip(({time})/{duration},0,1)")
    } else {
        format!("clip(({length}-({time}))/{duration},0,1)")
    }
}

/// Filters that make a wipe: a box that clears the hidden part of the clip, moved
/// every frame by a command. The edge moves in the named direction: entering reveals
/// the clip behind it, leaving hides it behind it. Costs a fill of the hidden pixels,
/// and only while the wipe lasts.
fn wipe_filters(kind: &str, enter: bool, duration: f64, length: f64, label: &str) -> Option<String> {
    let (option, size, forward) = match kind {
        "wipeRight" => ("x", "W", true),
        "wipeLeft" => ("x", "W", false),
        "wipeDown" => ("y", "H", true),
        "wipeUp" => ("y", "H", false),
        _ => return None,
    };
    // The box starts where the shown part ends: at progress p of the size when the
    // shown part is the near side, at -p (covering the near side) otherwise.
    let sign = if forward == enter { 1 } else { -1 };
    let (from, to, progress, during) = if enter {
        (0.0, duration, format!("T/{duration}"), format!("lt(t,{duration})"))
    } else {
        (
            length - duration,
            length + 1.0,
            format!("({length}-T)/{duration}"),
            format!("gte(t,{})", length - duration),
        )
    };
    Some(format!(
        ",sendcmd=c='{from}-{to} [expr] drawbox@{label} {option} ({sign})*{size}*{progress}',\
         drawbox@{label}=x=0:y=0:w=iw:h=ih:color=black@0:replace=1:t=fill:enable='{during}'"
    ))
}

/// The horizontal offset a slide adds to a layer whose offset from the centre is `x`:
/// at progress 0 the layer lies just outside the frame edge it enters from or leaves
/// through, wherever it rests. A layer already beyond that edge does not move.
fn slide_offset(
    kind: &str,
    enter: bool,
    duration: f64,
    length: f64,
    time: &str,
    x: &str,
) -> Option<String> {
    let leftwards = match kind {
        "slideLeft" => true,
        "slideRight" => false,
        _ => return None,
    };
    // Moving left, a clip enters from the right edge and leaves through the left one.
    let sign = if leftwards == enter { 1 } else { -1 };
    let p = transition_progress(enter, duration, length, time);
    Some(format!("+({sign})*(1-{p})*max(0,(W+w)/2-({sign})*({x}))"))
}

/// Filters that multiply a layer's alpha by `factor`, a per-pixel expression of
/// X, Y, W, H and the clip time T. Only the alpha plane is evaluated, which costs a
/// quarter of running the expression filter on the whole picture.
fn alpha_factor(label: &str, factor: &str) -> String {
    format!(
        ",split[{label}c][{label}a];[{label}a]alphaextract,geq=lum='p(X,Y)*({factor})':interpolation=nearest[{label}m];[{label}c][{label}m]alphamerge"
    )
}

fn blend_mode(clip: &Value) -> Option<&'static str> {
    match string(clip, "blendMode", "normal") {
        "multiply" => Some("multiply"),
        "screen" => Some("screen"),
        "overlay" => Some("overlay"),
        "darken" => Some("darken"),
        "lighten" => Some("lighten"),
        "add" => Some("addition"),
        _ => None,
    }
}

fn tempo_chain(mut speed: f64) -> String {
    let mut chain = vec![];
    while speed > 2.0 {
        chain.push("atempo=2".into());
        speed /= 2.0;
    }
    while speed < 0.5 {
        chain.push("atempo=0.5".into());
        speed /= 0.5;
    }
    chain.push(format!("atempo={speed:.6}"));
    chain.join(",")
}

/// Source seconds decoded ahead of a render window when the source's frame rate is
/// variable or unknown. Covers sources down to about 3 fps; slower material can still
/// differ from the full render there. Constant frame rate sources need two frames,
/// but never less than `STEADY_SEEK_MARGIN`.
/// Seconds by which a frame may precede a clip boundary and still count as on it.
const FRAME_TOLERANCE: f64 = 1e-4;
const SEEK_MARGIN: f64 = 0.5;
/// The least decoded ahead of a window for a source that reports a constant frame
/// rate. Phone and screen recordings report one and still skip a few frames here and
/// there; the frame held across such a gap has to be decoded to be shown.
const STEADY_SEEK_MARGIN: f64 = 0.25;

/// The part of a clip that a render window needs, in clip-local seconds.
#[derive(Debug, PartialEq)]
struct ClipWindow {
    /// Where decoding starts: the clip frame at or before `skip`, or 0 with pre-roll.
    from: f64,
    /// Where the visible part starts and how long it lasts.
    skip: f64,
    len: f64,
}

/// A time as FFmpeg stores seek points: rounded to the microsecond.
fn micros(seconds: f64) -> String {
    format!("{seconds:.6}")
}

/// Returns `None` when the clip lies outside `[start, end)`. Filters with memory
/// (stabilisation, loudness, denoise) need `preroll` so they see the clip from its start.
fn clip_window(
    position: f64,
    length: f64,
    start: f64,
    end: f64,
    fps: f64,
    preroll: bool,
) -> Option<ClipWindow> {
    let from = position.max(start);
    let to = (position + length).min(end);
    if to <= from {
        return None;
    }
    let skip = from - position;
    Some(ClipWindow {
        from: if preroll {
            0.0
        } else {
            (skip * fps + 1e-6).floor() / fps
        },
        skip,
        len: to - from,
    })
}

/// Fits the composition into the output size, letterboxing instead of stretching
/// when the aspect ratios differ by more than even-size rounding.
fn fit_filter(pw: f64, ph: f64, width: u32, height: u32) -> String {
    let scale = (width as f64 / pw).min(height as f64 / ph);
    let inner = |size: f64, limit: u32| (((size * scale / 2.0).round() as u32) * 2).clamp(2, limit);
    let (iw, ih) = (inner(pw, width), inner(ph, height));
    if width - iw <= 2 && height - ih <= 2 {
        format!("scale={width}:{height}")
    } else {
        format!("scale={iw}:{ih},pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black")
    }
}

/// Drains the stream to its end (so the writer never blocks) and keeps the last bytes,
/// where FFmpeg reports the error that actually stopped it.
async fn read_tail<R: AsyncRead + Unpin>(mut reader: R, limit: usize) -> String {
    let mut tail: Vec<u8> = Vec::new();
    let mut buffer = [0u8; 8192];
    while let Ok(n) = reader.read(&mut buffer).await {
        if n == 0 {
            break;
        }
        tail.extend_from_slice(&buffer[..n]);
        if tail.len() > limit * 2 {
            tail.drain(..tail.len() - limit);
        }
    }
    if tail.len() > limit {
        tail.drain(..tail.len() - limit);
    }
    String::from_utf8_lossy(&tail).to_string()
}

#[allow(clippy::too_many_arguments)]
async fn run(
    project: Value,
    params: Value,
    output: &Path,
    format: &str,
    root: &Path,
    id: &str,
    states: Arc<Mutex<HashMap<String, Value>>>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let temp_dir = root.join("renders").join(id);
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(output.parent().ok_or("저장 위치가 올바르지 않습니다.")?)
        .map_err(|e| e.to_string())?;
    let temp_output = output.with_file_name(format!(
        ".{}.{}.partial.{}",
        output.file_stem().unwrap_or_default().to_string_lossy(),
        id,
        format
    ));
    partial_outputs().lock().unwrap().insert(temp_output.clone());
    let encoders = video_encoders(&params, format).await;
    let result = run_encoders(
        &project,
        &params,
        &temp_output,
        format,
        &temp_dir,
        id,
        states,
        cancel,
        &encoders,
    )
    .await;
    partial_outputs().lock().unwrap().remove(&temp_output);
    match result {
        Ok(()) => {
            std::fs::rename(&temp_output, output).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_dir_all(temp_dir);
            Ok(())
        }
        Err(e) => {
            let _ = std::fs::remove_file(temp_output);
            let _ = std::fs::remove_dir_all(temp_dir);
            Err(e)
        }
    }
}

/// Whether this machine's FFmpeg can encode with `encoder` right now. Listing an
/// encoder is not enough (VideoToolbox is listed on Macs without a usable hardware
/// encoder), so a few frames are actually encoded once and the answer is remembered.
async fn encoder_works(encoder: &str) -> bool {
    static KNOWN: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();
    let known = KNOWN.get_or_init(Default::default);
    if let Some(works) = known.lock().unwrap().get(encoder) {
        return *works;
    }
    let mut command = Command::new(media::executable("ffmpeg"));
    command
        .args(["-v", "error", "-nostdin", "-f", "lavfi", "-i"])
        .arg("color=c=black:s=640x360:r=30:d=0.2")
        .args(["-c:v", encoder, "-pix_fmt", "yuv420p", "-f", "null", "-"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let works = matches!(
        tokio::time::timeout(std::time::Duration::from_secs(20), command.status()).await,
        Ok(Ok(status)) if status.success()
    );
    known.lock().unwrap().insert(encoder.to_string(), works);
    works
}

/// The video encoders to try for an export, in order: the hardware one when it is
/// wanted and works here, then the software one that always can.
async fn video_encoders(params: &Value, format: &str) -> Vec<&'static str> {
    if !matches!(format, "mp4" | "mov") {
        return vec![""];
    }
    let (hardware, software) = if params["codec"] == "hevc" {
        ("hevc_videotoolbox", "libx265")
    } else {
        ("h264_videotoolbox", "libx264")
    };
    // Precise-playback previews stay on the software encoder they are tuned for.
    if params["hardware"] != false && params["preview"] != true && encoder_works(hardware).await {
        vec![hardware, software]
    } else {
        vec![software]
    }
}

/// Renders with the first encoder; when that one fails for any reason but a cancel,
/// starts over with the next. The job state names the encoder in use.
#[allow(clippy::too_many_arguments)]
async fn run_encoders(
    p: &Value,
    params: &Value,
    output: &Path,
    format: &str,
    temp: &Path,
    id: &str,
    states: Arc<Mutex<HashMap<String, Value>>>,
    cancel: Arc<AtomicBool>,
    encoders: &[&str],
) -> Result<(), String> {
    let mut result = Err("사용할 수 있는 인코더가 없습니다.".to_string());
    for encoder in encoders {
        if !encoder.is_empty() {
            if let Some(job) = states.lock().unwrap().get_mut(id) {
                job["encoder"] = json!(encoder);
            }
        }
        result = run_process(
            p,
            params,
            output,
            format,
            temp,
            id,
            states.clone(),
            cancel.clone(),
            encoder,
        )
        .await;
        if result.is_ok() || cancel.load(Ordering::Relaxed) {
            break;
        }
        let _ = std::fs::remove_file(output);
        update(&states, id, "running", 0.0, None);
    }
    result
}

/// The FFmpeg arguments that select and tune a video encoder for mp4/mov.
fn video_encoder_args(encoder: &str, params: &Value, fps: f64) -> Vec<String> {
    let crf = number(params, "crf", 23.0);
    let bitrate = params["bitrate"].as_f64().map(|kbps| kbps.round() as u64);
    let preview = params["preview"] == true;
    let mut args: Vec<String> = vec!["-c:v".into(), encoder.into()];
    let mut push = |items: &[&str]| args.extend(items.iter().map(|s| s.to_string()));
    match encoder {
        "h264_videotoolbox" | "hevc_videotoolbox" => {
            match bitrate {
                Some(kbps) => push(&["-b:v", &format!("{kbps}k")]),
                // VideoToolbox has no CRF. Its 1..100 quality scale is mapped so the
                // quality presets land near the software encoder's file sizes.
                None => push(&[
                    "-q:v",
                    &((100.0 - crf * 1.9).round().clamp(1.0, 100.0) as u32).to_string(),
                ]),
            }
            // A keyframe at least every two seconds keeps the file seekable.
            push(&["-g", &((fps * 2.0).round().max(1.0) as u32).to_string()]);
        }
        _ => {
            push(&["-preset", if preview { "ultrafast" } else { "fast" }]);
            match bitrate {
                Some(kbps) => push(&[
                    "-b:v",
                    &format!("{kbps}k"),
                    "-maxrate",
                    &format!("{}k", kbps * 2),
                    "-bufsize",
                    &format!("{}k", kbps * 2),
                ]),
                None => push(&["-crf", &crf.to_string()]),
            }
            if encoder == "libx265" {
                push(&["-x265-params", "log-level=error"]);
            }
        }
    }
    if encoder.contains("hevc") || encoder == "libx265" {
        // Without this tag QuickTime and Safari refuse HEVC in mp4/mov.
        push(&["-tag:v", "hvc1"]);
    }
    push(&["-pix_fmt", "yuv420p"]);
    args
}

#[allow(clippy::too_many_arguments)]
async fn run_process(
    p: &Value,
    params: &Value,
    output: &Path,
    format: &str,
    temp: &Path,
    id: &str,
    states: Arc<Mutex<HashMap<String, Value>>>,
    cancel: Arc<AtomicBool>,
    encoder: &str,
) -> Result<(), String> {
    let duration = project_duration(p);
    let start = number(params, "start", 0.0);
    let end = number(params, "end", duration);
    let span = end - start;
    let pw = number(p, "width", 1920.0);
    let ph = number(p, "height", 1080.0);
    let width = (number(params, "width", pw) as u32 / 2) * 2;
    let height = (number(params, "height", ph) as u32 / 2) * 2;
    let fps = number(params, "fps", number(p, "fps", 30.0));
    let audio_only = matches!(format, "mp3" | "wav");
    let still = format == "png";
    let mut command = Command::new(media::executable("ffmpeg"));
    command.current_dir(temp);
    command.args([
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        // 0 lets FFmpeg use every core for the scale, blend and per-pixel filters.
        "-filter_complex_threads",
        "0",
    ]);
    // The graph covers only the requested window: its time 0 is `start`, and each clip
    // is decoded from where the window first needs it instead of from the timeline start.
    let mut graph = vec![];
    if !audio_only {
        graph.push(format!(
            "color=c={}:s={}x{}:r={fps}:d={span}[base]",
            string(p, "background", "#111111").replace('#', "0x"),
            pw as u32,
            ph as u32
        ));
    }
    if !still {
        graph.push(format!(
            "anullsrc=r=48000:cl=stereo,atrim=duration={span}[silence]"
        ));
    }
    let mut video_label = "base".to_string();
    let mut audio_labels = vec!["silence".to_string()];
    let mut input_index = 0;
    let assets = p["media"].as_array().unwrap();
    let tracks = p["tracks"].as_array().unwrap();
    for track in tracks {
        let mut clips: Vec<&Value> = p["clips"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["trackId"] == track["id"])
            .collect();
        clips.sort_by(|a, b| number(a, "start", 0.0).total_cmp(&number(b, "start", 0.0)));
        for clip in clips {
            if cancel.load(Ordering::Relaxed) {
                return Err("내보내기를 취소했습니다.".into());
            }
            let kind = string(clip, "kind", "video");
            let position = number(clip, "start", 0.0);
            let length = number(clip, "duration", 1.0);
            let source = number(clip, "sourceIn", 0.0);
            let speed = number(clip, "speed", 1.0);
            let visible = track["hidden"] != true && kind != "audio" && !audio_only;
            let asset = assets.iter().find(|m| m["id"] == clip["mediaId"]);
            let audible = !still
                && track["muted"] != true
                && kind != "text"
                && kind != "image"
                && asset.is_some_and(|a| a["hasAudio"] == true)
                && (number(clip, "volume", 1.0) > 0.0 || has_keyframe(clip, "volume"));
            if !visible && !audible {
                continue;
            }
            let preroll = (visible && clip["stabilize"]["enabled"] == true)
                || (audible
                    && (clip["audio"]["normalize"] == true || clip["audio"]["denoise"] == true));
            let Some(window) = clip_window(position, length, start, end, fps, preroll) else {
                continue;
            };
            let (from, until) = (window.from, window.skip + window.len);
            // `from` lies on the clip's frame grid. trim rounds its start to that grid, so
            // a quarter frame of margin keeps the frame at `from` despite float error,
            // while half a frame would be a tie that may keep the frame before it.
            let cut = (from - 0.25 / fps).max(0.0);
            let reversed = clip["reverse"] == true && matches!(kind, "video" | "audio");
            // Decoding starts `SEEK_MARGIN` of source before the window, so the frame
            // shown at `from` is the one the full render repeats there (the last source
            // frame at or before it), not the first one after the seek point.
            let margin = if visible && kind == "video" {
                match asset.and_then(|a| a["path"].as_str()) {
                    Some(path) => media::constant_frame_rate(Path::new(path))
                        .await
                        .map_or(SEEK_MARGIN, |rate| (2.0 / rate).clamp(STEADY_SEEK_MARGIN, SEEK_MARGIN)),
                    None => SEEK_MARGIN,
                }
            } else {
                SEEK_MARGIN
            };
            let lead = if reversed || matches!(kind, "image" | "text") {
                from
            } else {
                (from - margin / speed - 1.0 / fps).max(0.0)
            };
            let path = if kind == "text" {
                let path = temp.join(format!("text-{input_index}.png"));
                rasterize_text(clip, pw as u32, &path)?;
                path
            } else {
                PathBuf::from(
                    asset
                        .and_then(|a| a["path"].as_str())
                        .ok_or("클립의 미디어 경로가 없습니다.")?,
                )
            };
            if !path.is_file() {
                return Err(format!(
                    "원본 미디어를 찾을 수 없습니다: {}",
                    path.display()
                ));
            }
            if matches!(kind, "image" | "text") {
                command.args([
                    "-loop",
                    "1",
                    "-framerate",
                    &fps.to_string(),
                    "-t",
                    &((until - from) * speed).to_string(),
                ]);
            } else {
                // A reversed clip plays its source backwards, so the window maps to the
                // mirrored source range.
                let offset = if reversed { length - until } else { lead };
                // Reading a little past the window supplies the source frame after its
                // last output frame; without it the fps filter stops repeating a slow or
                // low-rate frame early. The trim at `until` drops the excess.
                let tail = if reversed { 0.0 } else { margin };
                command.args([
                    "-ss",
                    &micros(source + offset.max(0.0) * speed),
                    "-t",
                    &((until - lead) * speed + tail).to_string(),
                ]);
            }
            command.arg("-i").arg(&path);
            let idx = input_index;
            input_index += 1;
            if visible {
                let rev = if reversed && kind == "video" {
                    "reverse,"
                } else {
                    ""
                };
                let mut filters = if reversed || matches!(kind, "image" | "text") {
                    format!(
                        "[{idx}:v]{rev}setpts=(PTS-STARTPTS)/{speed}+{from}/TB,fps={fps},format=rgba"
                    )
                } else {
                    // Input timestamps are relative to the seek point, so every source
                    // frame keeps the same clip time whatever the window; the fps filter
                    // then picks the same frames as the full render. The margin frames are
                    // dropped before the expensive filters.
                    let pad = if lead > 0.0 {
                        format!(",trim=start={cut}")
                    } else {
                        ":start_time=0".to_string()
                    };
                    // FFmpeg subtracts the seek point rounded to a stream tick. Undoing
                    // that rounding and applying the one of the clip's own source start
                    // reproduces the full render's timestamps to the tick, so frames that
                    // fall exactly between two output frames round the same way.
                    format!(
                        "[{idx}:v]setpts=(PTS+round({}/TB)-round({}/TB))/{speed},fps={fps}{pad},format=rgba",
                        micros(source + lead * speed),
                        micros(source)
                    )
                };
                if clip["stabilize"]["enabled"] == true {
                    let radius = match clip["stabilize"]["strength"].as_u64().unwrap_or(1) {
                        1 => 16,
                        2 => 32,
                        _ => 64,
                    };
                    filters.push_str(&format!(
                        ",deshake=rx={radius}:ry={radius}:edge=mirror:search=1"
                    ));
                }
                let transform = &clip["transform"];
                let enter = transition(clip, true, length);
                let leave = transition(clip, false, length);
                let sides = [(true, enter), (false, leave)];
                let zooms = sides.iter().any(|(_, t)| t.is_some_and(|t| t.0 == "zoom"));
                let static_scale = number(transform, "scale", 1.0);
                // A scale that never changes is folded into the one resize every clip
                // needs; only keyframes and zoom transitions pay for a per-frame resize.
                let animated_scale = has_keyframe(clip, "scale") || zooms;
                if kind != "text" {
                    if clip.get("crop").is_some() {
                        let crop = &clip["crop"];
                        filters.push_str(&format!(",crop=w='max(2,trunc(iw*{}/2)*2)':h='max(2,trunc(ih*{}/2)*2)':x='iw*{}':y='ih*{}'",number(crop,"width",1.0),number(crop,"height",1.0),number(crop,"x",0.0),number(crop,"y",0.0)));
                    }
                    let fit = if animated_scale { 1.0 } else { static_scale };
                    let side = |size: f64| (((size * fit / 2.0).round() as u64) * 2).max(2);
                    filters.push_str(&format!(
                        ",scale=w={}:h={}:force_original_aspect_ratio=decrease:force_divisible_by=2",
                        side(pw),
                        side(ph)
                    ));
                    if clip["chromaKey"]["enabled"] == true {
                        let color = string(&clip["chromaKey"], "color", "#00ff00");
                        if valid_color(color) {
                            filters.push_str(&format!(
                                ",chromakey={}:{}:{}",
                                color.replace('#', "0x"),
                                number(&clip["chromaKey"], "similarity", 0.1).clamp(0.01, 1.0),
                                number(&clip["chromaKey"], "blend", 0.05).clamp(0.0, 1.0)
                            ));
                        }
                    }
                } else if !animated_scale && (static_scale - 1.0).abs() > 1e-6 {
                    filters.push_str(&format!(
                        ",scale=w='max(2,trunc(iw*{static_scale}/2)*2)':h='max(2,trunc(ih*{static_scale}/2)*2)'"
                    ));
                }
                append_color_filters(&mut filters, &clip["color"], temp, idx)?;
                if transform["flipX"] == true {
                    filters.push_str(",hflip");
                }
                if transform["flipY"] == true {
                    filters.push_str(",vflip");
                }
                // Everything below works on the alpha channel.
                filters.push_str(",format=rgba");
                let mask = &clip["mask"];
                let mask_type = string(mask, "type", "none");
                if mask_type != "none" {
                    let x = number(mask, "x", 0.5);
                    let y = number(mask, "y", 0.5);
                    let w = number(mask, "width", 1.0) / 2.0;
                    let h = number(mask, "height", 1.0) / 2.0;
                    let nx = format!("(X/W-{x})/{w}");
                    let ny = format!("(Y/H-{y})/{h}");
                    let distance = if mask_type == "circle" {
                        format!("sqrt(pow({nx},2)+pow({ny},2))")
                    } else {
                        format!("max(abs({nx}),abs({ny}))")
                    };
                    let feather = number(mask, "feather", 0.0);
                    let factor = if feather > 0.0 {
                        format!("clip((1-({distance}))/{feather},0,1)")
                    } else {
                        format!("lte({distance},1)")
                    };
                    filters.push_str(&alpha_factor(&format!("k{idx}"), &factor));
                }
                // Wipes crop the clip in its own box, so they follow its scale and rotation.
                for (enters, wipe) in sides {
                    let label = format!("w{}{idx}", if enters { "i" } else { "o" });
                    if let Some(filter) =
                        wipe.and_then(|(kind, d)| wipe_filters(kind, enters, d, length, &label))
                    {
                        filters.push_str(&filter);
                    }
                }
                let rotate = expression(clip, "rotation", number(transform, "rotation", 0.0), "t");
                if number(transform, "rotation", 0.0).abs() > 0.001
                    || has_keyframe(clip, "rotation")
                {
                    filters.push_str(&format!(",rotate=angle='({rotate})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none"));
                }
                let opacity = expression(clip, "opacity", number(transform, "opacity", 1.0), "T");
                if has_keyframe(clip, "opacity") {
                    // One alpha for the whole layer: a command sets it every frame, which
                    // avoids evaluating an expression per pixel. The command file sits in
                    // the working directory, as the expression may not appear in the graph.
                    let commands = format!("opacity-{idx}.cmd");
                    std::fs::write(
                        temp.join(&commands),
                        format!("0-1000000000 [expr] colorchannelmixer@o{idx} aa 'clip({opacity},0,1)';\n"),
                    )
                    .map_err(|e| e.to_string())?;
                    filters.push_str(&format!(
                        ",sendcmd=f={commands},colorchannelmixer@o{idx}=aa=1"
                    ));
                } else if number(transform, "opacity", 1.0) < 0.9999 {
                    filters.push_str(&format!(
                        ",colorchannelmixer=aa={}",
                        number(transform, "opacity", 1.0)
                    ));
                }
                // Fade, dissolve and zoom change the clip's alpha; wipes and slides do not.
                for (enters, fade) in sides {
                    let Some((_, d)) = fade.filter(|t| matches!(t.0, "fade" | "dissolve" | "zoom"))
                    else {
                        continue;
                    };
                    filters.push_str(&if enters {
                        format!(",fade=t=in:st=0:d={d}:alpha=1")
                    } else {
                        format!(",fade=t=out:st={}:d={d}:alpha=1", length - d)
                    });
                }
                // A per-frame resize changes the frame size mid-stream, which only the
                // final overlay copes with: it has to be the last filter that looks at
                // pixels. Uniform scaling commutes with everything placed before it.
                if animated_scale {
                    let mut scale = expression(clip, "scale", static_scale, "t");
                    for (enters, zoom) in sides {
                        if let Some((_, d)) = zoom.filter(|t| t.0 == "zoom") {
                            scale = format!(
                                "({scale})*(0.8+0.2*{})",
                                transition_progress(enters, d, length, "t")
                            );
                        }
                    }
                    filters.push_str(&format!(",scale=w='max(2,trunc(iw*({scale})/2)*2)':h='max(2,trunc(ih*({scale})/2)*2)':eval=frame"));
                }
                filters.push_str(&format!(
                    ",trim=start={cut}:end={until},setpts=PTS-STARTPTS+({})/TB[v{idx}]",
                    position + from - start
                ));
                graph.push(filters);
                let local = format!("t-({})", position - start);
                let rest = expression(clip, "x", number(transform, "x", 0.0), &local);
                let y = expression(clip, "y", number(transform, "y", 0.0), &local);
                let mut x = rest.clone();
                for (enters, slide) in sides {
                    if let Some(offset) = slide
                        .and_then(|(kind, d)| slide_offset(kind, enters, d, length, &local, &rest))
                    {
                        x.push_str(&offset);
                    }
                }
                // A frame's time and a clip boundary on that same frame can differ in
                // the last binary digit (7/30 is not 7 × 1/30), which dropped the first
                // frame of such a clip. The tolerance is far below one frame.
                let place = format!(
                    "overlay=x='(W-w)/2+({x})':y='(H-h)/2+({y})':eof_action=pass:repeatlast=0:enable='gte(t,{})*lt(t,{})'",
                    position - start - FRAME_TOLERANCE,
                    position + length - start - FRAME_TOLERANCE
                );
                match blend_mode(clip) {
                    None => graph.push(format!("[{video_label}][v{idx}]{place}[mix{idx}]")),
                    // The clip is placed on a transparent frame, blended with the picture
                    // below as a whole, and the result is laid over that picture through
                    // the clip's own alpha. The picture below is the blend's first input,
                    // which is what the overlay mode keys on (as CSS mix-blend-mode does).
                    Some(mode) => {
                        // Only the frames the clip is on (and one either side) take that
                        // path; the frames before and after pass untouched and the three
                        // parts are joined again, so a short blended clip does not slow
                        // down the rest of a long timeline. The picture below has one
                        // frame per 1/fps from time 0, so parts are cut by frame number
                        // and the joined frames get their numbers back as timestamps.
                        let first = ((position - start - FRAME_TOLERANCE) * fps).floor() - 1.0;
                        let last = ((position + length - start - FRAME_TOLERANCE) * fps).ceil() + 1.0;
                        let before = first >= 1.0;
                        let after = last < span * fps - 1.0;
                        let within = match (before, after) {
                            (false, false) => String::new(),
                            (true, false) => format!(",trim=start_frame={first}"),
                            (_, true) => format!(
                                ",trim=start_frame={}:end_frame={last}",
                                first.max(0.0)
                            ),
                        };
                        let mut parts = vec![];
                        let mut cut = format!(
                            "[{video_label}]format=yuv420p,split={}",
                            1 + before as u8 + after as u8
                        );
                        if before {
                            cut.push_str(&format!("[ps{idx}]"));
                            parts.push(format!("[ps{idx}]trim=end_frame={first}[pr{idx}]"));
                        }
                        cut.push_str(&format!("[ds{idx}]"));
                        if after {
                            cut.push_str(&format!("[ns{idx}]"));
                            parts.push(format!("[ns{idx}]trim=start_frame={last}[po{idx}]"));
                        }
                        let joined = if before || after {
                            format!(
                                "[du{idx}];{}{}[du{idx}]{}concat=n={}:v=1:a=0,settb=1/{fps},setpts=N",
                                parts.iter().map(|p| format!("{p};")).collect::<String>(),
                                if before { format!("[pr{idx}]") } else { String::new() },
                                if after { format!("[po{idx}]") } else { String::new() },
                                1 + parts.len()
                            )
                        } else {
                            String::new()
                        };
                        graph.push(format!(
                            "color=c=black@0:s={}x{}:r={fps}:d={span},format=rgba{within}[c{idx}];\
                             [c{idx}][v{idx}]{place},format=rgba,split[t{idx}][k{idx}];\
                             {cut};[ds{idx}]null{within},split[b{idx}][u{idx}];\
                             [u{idx}]format=gbrp[ub{idx}];[t{idx}]format=gbrp[tb{idx}];\
                             [ub{idx}][tb{idx}]blend=all_mode={mode}[bl{idx}];\
                             [k{idx}]alphaextract[al{idx}];\
                             [bl{idx}][al{idx}]alphamerge[bm{idx}];\
                             [b{idx}][bm{idx}]overlay=eof_action=pass:repeatlast=0{joined}[mix{idx}]",
                            pw as u32, ph as u32
                        ));
                    }
                }
                video_label = format!("mix{idx}");
            }
            if audible {
                let reverse = if reversed { "areverse," } else { "" };
                let volume = expression(clip, "volume", number(clip, "volume", 1.0), "t");
                let mut a=format!("[{idx}:a]{reverse}asetpts=PTS-STARTPTS,{},asetpts=PTS+{lead}/TB,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume='{volume}':eval=frame",tempo_chain(speed));
                if clip["audio"]["normalize"] == true {
                    a.push_str(",loudnorm=I=-16:TP=-1.5:LRA=11");
                }
                if clip["audio"]["denoise"] == true {
                    a.push_str(",afftdn=nf=-25");
                }
                if clip["audio"]["voiceEnhance"] == true {
                    a.push_str(",highpass=f=80,lowpass=f=12000,acompressor=threshold=0.125:ratio=2:attack=5:release=60:makeup=1.5");
                }
                for (band, frequency) in [("bass", 120), ("mid", 1000), ("treble", 8000)] {
                    let gain = number(&clip["audio"]["eq"], band, 0.0);
                    if gain.abs() > 0.0001 {
                        a.push_str(&format!(
                            ",equalizer=f={frequency}:width_type=o:width=1:g={gain}"
                        ));
                    }
                }
                let fi = number(clip, "fadeIn", 0.0).min(length);
                let fo = number(clip, "fadeOut", 0.0).min(length);
                if fi > 0.0 {
                    a.push_str(&format!(",afade=t=in:st=0:d={fi}"));
                }
                if fo > 0.0 {
                    a.push_str(&format!(",afade=t=out:st={}:d={fo}", length - fo));
                }
                a.push_str(&format!(
                    ",atrim=start={}:end={until},asetpts=PTS-STARTPTS,adelay=delays={}:all=1[a{idx}]",
                    window.skip,
                    ((position + window.skip - start) * 1000.0).round() as u64
                ));
                graph.push(a);
                audio_labels.push(format!("a{idx}"));
            }
        }
    }
    if !audio_only {
        graph.push(format!(
            "[{video_label}]{},setsar=1,format=yuv420p[vout]",
            fit_filter(pw, ph, width, height)
        ));
    }
    if !still {
        graph.push(format!("{}amix=inputs={}:normalize=0:dropout_transition=0,alimiter=limit=0.98:latency=1,atrim=duration={span}[aout]",audio_labels.iter().map(|s|format!("[{s}]")).collect::<String>(),audio_labels.len()));
    }
    // Retain the graph for diagnostics, and pass it as one argv (never through a shell).
    let script = temp.join("filters.ffgraph");
    std::fs::write(&script, graph.join(";\n")).map_err(|e| e.to_string())?;
    command.arg("-filter_complex").arg(graph.join(";"));
    if !audio_only {
        command.args(["-map", "[vout]"]);
    }
    if !still {
        command.args(["-map", "[aout]"]);
    }
    match format {
        "mp4" | "mov" => {
            command
                .args(video_encoder_args(encoder, params, fps))
                .args(["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"]);
        }
        "webm" => {
            command.args(["-c:v", "libvpx-vp9"]);
            match params["bitrate"].as_f64() {
                Some(kbps) => command.args(["-b:v", &format!("{}k", kbps.round() as u64)]),
                None => command.args([
                    "-crf",
                    &number(params, "crf", 28.0).to_string(),
                    "-b:v",
                    "0",
                ]),
            };
            command.args(["-c:a", "libopus", "-b:a", "160k"]);
        }
        "mp3" => {
            command.args(["-c:a", "libmp3lame", "-b:a", "192k"]);
        }
        "wav" => {
            command.args(["-c:a", "pcm_s16le"]);
        }
        "png" => {
            command.args(["-c:v", "png", "-frames:v", "1", "-update", "1"]);
        }
        _ => unreachable!(),
    }
    command
        .args([
            "-t",
            &span.to_string(),
            "-progress",
            "pipe:1",
            "-nostats",
        ])
        .arg(output)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("FFmpeg를 실행할 수 없습니다: {e}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("FFmpeg 진행 정보를 읽을 수 없습니다.")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("FFmpeg 오류를 읽을 수 없습니다.")?;
    let stderr_task = tokio::spawn(read_tail(stderr, STDERR_TAIL));
    let mut lines = BufReader::new(stdout).lines();
    let mut reading = true;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
    let status = loop {
        tokio::select! {
            status=child.wait()=>break status.map_err(|e|e.to_string())?,
            line=lines.next_line(),if reading=>match line {Ok(Some(line))=>{if let Some(n)=line.strip_prefix("out_time_us=").and_then(|s|s.parse::<f64>().ok()){update(&states,id,"running",(n/1_000_000.0/span).clamp(0.0,0.99),None);}},_=>reading=false},
            _=interval.tick()=>{if cancel.load(Ordering::Relaxed){let _=child.kill().await;let _=child.wait().await;let _=stderr_task.await;return Err("내보내기를 취소했습니다.".into());}}
        }
    };
    let error = stderr_task.await.unwrap_or_default();
    if !status.success() {
        return Err(format!("영상 내보내기에 실패했습니다: {}", error.trim()));
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("내보내기를 취소했습니다.".into());
    }
    if !output.is_file() || std::fs::metadata(output).map_err(|e| e.to_string())?.len() == 0 {
        return Err("출력 파일이 생성되지 않았습니다.".into());
    }
    Ok(())
}

fn append_color_filters(
    filters: &mut String,
    color: &Value,
    temp: &Path,
    index: usize,
) -> Result<(), String> {
    let (brightness, contrast, saturation) = (
        number(color, "brightness", 0.0),
        number(color, "contrast", 1.0),
        number(color, "saturation", 1.0),
    );
    // An ungraded clip skips the filter and the colour conversions around it.
    if brightness.abs() > 0.0001 || (contrast - 1.0).abs() > 0.0001 || (saturation - 1.0).abs() > 0.0001
    {
        filters.push_str(&format!(
            ",eq=brightness={brightness}:contrast={contrast}:saturation={saturation}"
        ));
    }
    let warmth = number(color, "temperature", 0.0);
    if warmth.abs() > 0.0001 {
        filters.push_str(&format!(
            ",colorbalance=rs={:.4}:bs={:.4}",
            warmth * 0.15,
            -warmth * 0.15
        ));
    }
    let hue = number(color, "hue", 0.0);
    if hue.abs() > 0.0001 {
        filters.push_str(&format!(",hue=h={hue}"));
    }
    for (channel, flag) in [
        ("red", "r"),
        ("yellow", "y"),
        ("green", "g"),
        ("cyan", "c"),
        ("blue", "b"),
        ("magenta", "m"),
    ] {
        let setting = &color["hsl"][channel];
        let h = number(setting, "hue", 0.0);
        let s = number(setting, "saturation", 0.0);
        let l = number(setting, "lightness", 0.0);
        if h.abs() + s.abs() + l.abs() > 0.0001 {
            filters.push_str(&format!(
                ",huesaturation=hue={h}:saturation={s}:intensity={l}:colors={flag}"
            ));
        }
    }
    if let Some(curves) = color.get("curves") {
        let mut options = vec![];
        let preset = string(curves, "preset", "none");
        if preset != "none" {
            options.push(format!("preset={preset}"));
        }
        for channel in ["master", "red", "green", "blue"] {
            if let Some(points) = curves[channel].as_array().filter(|p| !p.is_empty()) {
                let values = points
                    .iter()
                    .map(|p| {
                        format!(
                            "{:.6}/{:.6}",
                            p[0].as_f64().unwrap(),
                            p[1].as_f64().unwrap()
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" ");
                options.push(format!("{channel}='{values}'"));
            }
        }
        if !options.is_empty() {
            filters.push_str(&format!(",curves={}:interp=pchip", options.join(":")));
        }
    }
    if let Some(lut) = color.get("lut").filter(|v| v["enabled"] != false) {
        let source = Path::new(string(lut, "path", ""));
        let info =
            std::fs::metadata(source).map_err(|e| format!("LUT 파일을 읽을 수 없습니다: {e}"))?;
        if info.len() > 10 * 1024 * 1024 {
            return Err("LUT 파일이 10MB를 초과합니다.".into());
        }
        let extension = source
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("cube")
            .to_lowercase();
        let name = format!("lut-{index}.{extension}");
        std::fs::copy(source, temp.join(&name)).map_err(|e| e.to_string())?;
        filters.push_str(&format!(",lut3d=file={name}:interp=tetrahedral"));
    }
    Ok(())
}

fn rgba(s: &str, default: [u8; 4]) -> [u8; 4] {
    if !valid_color(s) {
        return default;
    }
    let mut c = [0, 0, 0, 255];
    for (i, part) in s.as_bytes()[1..].chunks(2).enumerate() {
        if i < 4 {
            c[i] = u8::from_str_radix(std::str::from_utf8(part).unwrap_or("ff"), 16).unwrap_or(255);
        }
    }
    c
}

fn font_path(family: &str, bold: bool) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("BYORI_STUDIO_FONT")
        .map(PathBuf::from)
        .filter(|p| p.is_file())
    {
        return Some(path);
    }
    let family = match family {
        "serif" => "Georgia",
        "monospace" => "Courier New",
        "sans-serif" => "Arial",
        other => other,
    };
    if family == "Helvetica" {
        let path = PathBuf::from("/System/Library/Fonts/Helvetica.ttc");
        if path.is_file() {
            return Some(path);
        }
    }
    if ["Arial", "Georgia", "Times New Roman", "Courier New"].contains(&family) {
        let path = PathBuf::from(format!(
            "/System/Library/Fonts/Supplemental/{family}{}.ttf",
            if bold { " Bold" } else { "" }
        ));
        if path.is_file() {
            return Some(path);
        }
    }
    let names = if bold {
        vec![
            "/System/Library/Fonts/AppleSDGothicNeo.ttc",
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "C:/Windows/Fonts/malgunbd.ttf",
        ]
    } else {
        vec![
            "/System/Library/Fonts/AppleSDGothicNeo.ttc",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:/Windows/Fonts/malgun.ttf",
        ]
    };
    names.into_iter().map(PathBuf::from).find(|p| p.is_file())
}

fn load_font(path: &Path, bold: bool) -> Result<Arc<Font>, String> {
    static FONTS: OnceLock<Mutex<HashMap<String, Arc<Font>>>> = OnceLock::new();
    let collection = match path.file_name().and_then(|n| n.to_str()) {
        Some("AppleSDGothicNeo.ttc") if bold => 6,
        Some("Helvetica.ttc") if bold => 1,
        _ => 0,
    };
    let key = format!("{}:{collection}", path.display());
    let mut cache = FONTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap();
    if let Some(font) = cache.get(&key) {
        return Ok(font.clone());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let font = Arc::new(
        Font::from_bytes(
            bytes,
            fontdue::FontSettings {
                collection_index: collection,
                ..Default::default()
            },
        )
        .map_err(|e| format!("자막 글꼴 로드 실패: {e}"))?,
    );
    cache.insert(key, font.clone());
    Ok(font)
}

/// Characters that may be followed by a line break anywhere, as browsers do for
/// Korean, Japanese and Chinese text.
fn breaks_anywhere(ch: char) -> bool {
    matches!(ch as u32,
        0x1100..=0x11FF | 0x2E80..=0x303F | 0x3040..=0x30FF | 0x3130..=0x318F
        | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xAC00..=0xD7AF | 0xF900..=0xFAFF
        | 0xFF00..=0xFFEF | 0x20000..=0x2FFFF)
}

/// Punctuation a line may not start with: it stays with the character before it.
fn closes(ch: char) -> bool {
    matches!(
        ch,
        '.' | ',' | '!' | '?' | ':' | ';' | ')' | ']' | '}' | '…' | '’' | '”' | '»'
            | '、' | '。' | '，' | '．' | '！' | '？' | '：' | '；' | '）' | '］' | '｝'
            | '」' | '』' | '】' | '〕' | '〉' | '》' | '〗' | '〙' | '〛' | '・' | '々'
    )
}

/// Punctuation a line may not end with: it stays with the character after it.
fn opens(ch: char) -> bool {
    matches!(
        ch,
        '(' | '[' | '{' | '‘' | '“' | '«' | '（' | '［' | '｛' | '「' | '『' | '【' | '〔'
            | '〈' | '《' | '〖' | '〘' | '〚'
    )
}

/// Breaks text into lines no wider than `max_width`. Explicit line breaks are kept.
/// Lines break at spaces; a word longer than a line, and CJK text, break between
/// characters. As in browsers, closing punctuation never starts a line, an opening
/// bracket never ends one, and a hyphen inside a word may end one.
/// Spaces at a soft break are dropped. The browser preview follows the
/// same rule (white-space: pre-wrap; overflow-wrap: anywhere) in a box 90% of the
/// project width.
fn wrap_text(content: &str, max_width: f32, advance: &dyn Fn(char) -> f32) -> Vec<String> {
    let width_of = |text: &str| text.chars().map(advance).sum::<f32>();
    let mut lines = vec![];
    for paragraph in content.split('\n') {
        // Words, single CJK characters and runs of spaces, in order.
        let mut units: Vec<String> = vec![];
        for ch in paragraph.chars() {
            let space = ch == ' ' || ch == '\t';
            let joins = units.last().is_some_and(|last: &String| {
                let end = last.chars().last().unwrap_or(' ');
                let after_space = end == ' ' || end == '\t';
                if space || after_space {
                    space && after_space
                } else if closes(ch) || opens(end) {
                    true
                } else if end == '-' && last.len() > 1 && !ch.is_ascii_digit() && ch != '-' {
                    false
                } else {
                    !breaks_anywhere(ch) && !last.chars().any(breaks_anywhere)
                }
            });
            match units.last_mut() {
                Some(last) if joins => last.push(ch),
                _ => units.push(ch.to_string()),
            }
        }
        let (mut line, mut width) = (String::new(), 0.0f32);
        let (mut spaces, mut soft_start) = (String::new(), false);
        for unit in units {
            if unit.starts_with([' ', '\t']) {
                // Kept only when a word follows on the same line.
                if !soft_start || !line.is_empty() {
                    spaces = unit;
                }
                continue;
            }
            let needed = width_of(&spaces) + width_of(&unit);
            if width + needed <= max_width {
                line.push_str(&spaces);
                line.push_str(&unit);
                width += needed;
                spaces.clear();
                continue;
            }
            if !line.is_empty() {
                lines.push(std::mem::take(&mut line));
                width = 0.0;
            } else if !soft_start && width_of(&spaces) < max_width {
                // Indentation at the start of a paragraph stays.
                line.push_str(&spaces);
                width = width_of(&spaces);
            }
            spaces.clear();
            soft_start = true;
            for ch in unit.chars() {
                let step = advance(ch);
                if width + step > max_width && !line.trim_start().is_empty() {
                    lines.push(std::mem::take(&mut line));
                    width = 0.0;
                }
                line.push(ch);
                width += step;
            }
        }
        lines.push(line);
    }
    lines
}

/// Grows coverage outwards by `radius` pixels with an antialiased round edge.
fn dilate(source: &[u8], width: usize, height: usize, radius: f32) -> Vec<u8> {
    let reach = radius.ceil() as i32;
    let mut disc = vec![];
    for dy in -reach..=reach {
        for dx in -reach..=reach {
            let weight = (radius + 0.5 - ((dx * dx + dy * dy) as f32).sqrt()).clamp(0.0, 1.0);
            if weight > 0.0 {
                disc.push((dx, dy, weight));
            }
        }
    }
    let mut grown = vec![0u8; source.len()];
    for y in 0..height {
        for x in 0..width {
            let coverage = source[y * width + x];
            if coverage == 0 {
                continue;
            }
            for &(dx, dy, weight) in &disc {
                let (px, py) = (x as i32 + dx, y as i32 + dy);
                if px < 0 || py < 0 || px >= width as i32 || py >= height as i32 {
                    continue;
                }
                let value = (coverage as f32 * weight).round() as u8;
                let target = &mut grown[py as usize * width + px as usize];
                *target = (*target).max(value);
            }
        }
    }
    grown
}

/// Three box blurs, which together are close to the Gaussian blur of a CSS
/// text-shadow (standard deviation = half the blur radius).
fn blur(plane: &mut [u8], width: usize, height: usize, radius: f32) {
    let r = (radius / 2.0).round() as usize;
    if r == 0 {
        return;
    }
    let window = (2 * r + 1) as u32;
    let mut line = vec![0u8; width.max(height)];
    let mut pass = |start: usize, step: usize, count: usize, plane: &mut [u8]| {
        for (i, value) in line[..count].iter_mut().enumerate() {
            *value = plane[start + i * step];
        }
        let mut sum: u32 = line[..count.min(r + 1)].iter().map(|v| *v as u32).sum();
        for i in 0..count {
            plane[start + i * step] = (sum / window) as u8;
            if i + r + 1 < count {
                sum += line[i + r + 1] as u32;
            }
            if i >= r {
                sum -= line[i - r] as u32;
            }
        }
    };
    for _ in 0..3 {
        for y in 0..height {
            pass(y * width, 1, width, plane);
        }
        for x in 0..width {
            pass(x, width, height, plane);
        }
    }
}

/// How far synthetic italics lean: horizontal pixels per pixel above the baseline.
const ITALIC_SLANT: f32 = 0.25;

fn rasterize_text(clip: &Value, canvas_width: u32, path: &Path) -> Result<(), String> {
    let text = &clip["text"];
    let content = string(text, "content", "");
    let size = number(text, "fontSize", 64.0) as f32;
    let bold = text["bold"] == true;
    let italic = text["italic"] == true;
    let spacing = number(text, "letterSpacing", 0.0).clamp(-5.0, 50.0) as f32;
    let line_height = size * number(text, "lineHeight", 1.2).clamp(0.8, 3.0) as f32;
    let outline = text.get("outline").filter(|v| v.is_object());
    let outline_width = outline.map_or(0.0, |o| number(o, "width", 0.0).clamp(0.0, 20.0)) as f32;
    // A shadow with no offset and no blur sits exactly under the glyphs: the
    // inspector stores that for "off", so it is not drawn.
    let shadow = text.get("shadow").filter(|v| {
        v.is_object() && ["x", "y", "blur"].iter().any(|k| number(v, k, 0.0) != 0.0)
    });
    let (shadow_x, shadow_y, shadow_blur) = shadow.map_or((0, 0, 0.0), |s| {
        (
            number(s, "x", 0.0).clamp(-200.0, 200.0).round() as i32,
            number(s, "y", 0.0).clamp(-200.0, 200.0).round() as i32,
            number(s, "blur", 0.0).clamp(0.0, 40.0) as f32,
        )
    });
    // Imported faces are registered as one normal CSS FontFace. Browsers synthesize
    // weight 700 for that face; give the export rasterizer the same visible Bold
    // behavior. Keep advances/baselines unchanged and reserve space for the ink.
    let synthetic_weight = if bold && text["fontPath"].is_string() {
        (size / 32.0).round().clamp(1.0, 16.0) as usize
    } else {
        0
    };
    let font_file = if let Some(custom) = text["fontPath"].as_str() {
        let path = PathBuf::from(custom);
        if !path.is_file() {
            return Err("추가한 글꼴 파일을 찾을 수 없습니다. 글꼴을 다시 가져오거나 다른 글꼴을 선택해 주세요.".into());
        }
        path
    } else {
        font_path(string(text, "fontFamily", "Arial"), bold).ok_or(
            "자막 글꼴을 찾을 수 없습니다. BYORI_STUDIO_FONT 환경변수로 TTF/TTC 글꼴을 지정해 주세요.",
        )?
    };
    let font = load_font(&font_file, bold)?;
    let fallback = font_path("korean", bold).and_then(|p| load_font(&p, bold).ok());
    let select_font = |ch: char| -> &Font {
        if font.lookup_glyph_index(ch) != 0 {
            &font
        } else {
            fallback.as_deref().unwrap_or(&font)
        }
    };
    // CSS letter-spacing follows every character, the last one of a line included.
    let advance = |ch: char| select_font(ch).metrics(ch, size).advance_width + spacing;
    let lines = wrap_text(content, canvas_width as f32 * 0.9, &advance);
    let widths: Vec<f32> = lines
        .iter()
        .map(|line| line.chars().map(advance).sum())
        .collect();
    let metrics = font
        .horizontal_line_metrics(size)
        .ok_or("글꼴 높이를 읽을 수 없습니다.")?;
    // The background box is the text block plus padding. Around it, a transparent
    // margin holds what reaches outside: outline, shadow, italic overhang and glyphs
    // taller than a tight line. It is equal on all sides, so the text stays centred.
    let padding = 12 + synthetic_weight as u32;
    let glyph_height = metrics.ascent - metrics.descent;
    let tall = ((glyph_height - line_height) / 2.0).max(0.0);
    let lean = if italic { size * ITALIC_SLANT } else { 0.0 };
    let shadow_reach = if shadow.is_some() {
        shadow_x.abs().max(shadow_y.abs()) as f32 + shadow_blur * 1.5
    } else {
        0.0
    };
    let margin = (outline_width + tall.max(lean) + shadow_reach).ceil() as u32;
    let block_width = widths.iter().copied().fold(0.0, f32::max).max(0.0).ceil() as u32;
    let width = (block_width + (padding + margin) * 2).max(2);
    let height = (line_height * lines.len() as f32).ceil() as u32 + (padding + margin) * 2;
    if height > 16384 || width > 16384 {
        return Err("텍스트가 너무 길어 이미지로 만들 수 없습니다.".into());
    }
    let (w, h) = (width as usize, height as usize);
    // Glyph coverage of the whole block; outline and shadow derive from it.
    let mut ink = vec![0u8; w * h];
    let inset = (padding + margin) as f32;
    for (i, line) in lines.iter().enumerate() {
        let mut pen = match string(text, "align", "center") {
            "left" => inset,
            "right" => width as f32 - inset - widths[i],
            _ => (width as f32 - widths[i]) / 2.0,
        };
        // As in CSS, the font's ascent and descent are centred in the line box.
        let baseline =
            inset + i as f32 * line_height + (line_height - glyph_height) / 2.0 + metrics.ascent;
        for ch in line.chars() {
            let (m, mut bitmap) = select_font(ch).rasterize(ch, size);
            let mut bitmap_width = m.width;
            // Missing glyphs use a real bold system fallback; do not embolden
            // them a second time. Whitespace has no ink and keeps its advance.
            if synthetic_weight > 0
                && font.lookup_glyph_index(ch) != 0
                && m.width > 0
                && m.height > 0
            {
                bitmap_width += synthetic_weight;
                let mut thickened = vec![0; bitmap_width * m.height];
                for row in 0..m.height {
                    for col in 0..m.width {
                        let coverage = bitmap[row * m.width + col];
                        for offset in 0..=synthetic_weight {
                            let destination = &mut thickened[row * bitmap_width + col + offset];
                            *destination = (*destination).max(coverage);
                        }
                    }
                }
                bitmap = thickened;
            }
            let x = pen as i32 + m.xmin;
            let y = baseline as i32 - m.height as i32 - m.ymin;
            for row in 0..m.height {
                let py = y + row as i32;
                // Rows above the baseline lean right, rows below it lean left.
                let shift = if italic {
                    ((baseline - py as f32) * ITALIC_SLANT).round() as i32
                } else {
                    0
                };
                for col in 0..bitmap_width {
                    let px = x + col as i32 + shift;
                    if px < 0 || py < 0 || px >= w as i32 || py >= h as i32 {
                        continue;
                    }
                    let target = &mut ink[py as usize * w + px as usize];
                    *target = (*target).max(bitmap[row * bitmap_width + col]);
                }
            }
            pen += m.advance_width + spacing;
        }
    }
    let stroke = (outline_width > 0.0).then(|| dilate(&ink, w, h, outline_width));
    let bg = rgba(string(text, "background", "transparent"), [0, 0, 0, 0]);
    let fg = rgba(string(text, "color", "#ffffff"), [255, 255, 255, 255]);
    let mut image = RgbaImage::new(width, height);
    if bg[3] > 0 {
        for y in margin..height - margin {
            for x in margin..width - margin {
                image.put_pixel(x, y, Rgba(bg));
            }
        }
    }
    let mut paint = |plane: &[u8], color: [u8; 4], dx: i32, dy: i32| {
        for y in 0..h {
            for x in 0..w {
                let coverage = plane[y * w + x];
                if coverage > 0 {
                    blend_pixel(&mut image, x as i32 + dx, y as i32 + dy, color, coverage);
                }
            }
        }
    };
    if let Some(shadow) = shadow {
        // The shadow is cast by everything that is drawn: glyphs and their outline.
        let mut shape = stroke.clone().unwrap_or_else(|| ink.clone());
        blur(&mut shape, w, h, shadow_blur);
        let color = rgba(string(shadow, "color", "#000000"), [0, 0, 0, 255]);
        paint(&shape, color, shadow_x, shadow_y);
    }
    if let (Some(stroke), Some(outline)) = (&stroke, outline) {
        let color = rgba(string(outline, "color", "#000000"), [0, 0, 0, 255]);
        paint(stroke, color, 0, 0);
    }
    paint(&ink, fg, 0, 0);
    image
        .save(path)
        .map_err(|e| format!("자막 이미지 저장 실패: {e}"))
}
fn blend_pixel(image: &mut RgbaImage, x: i32, y: i32, color: [u8; 4], coverage: u8) {
    if x < 0 || y < 0 || x >= image.width() as i32 || y >= image.height() as i32 || coverage == 0 {
        return;
    }
    let dst = image.get_pixel_mut(x as u32, y as u32);
    let alpha = color[3] as f32 / 255.0 * coverage as f32 / 255.0;
    let da = dst[3] as f32 / 255.0;
    let out = alpha + da * (1.0 - alpha);
    if out > 0.0 {
        for c in 0..3 {
            dst[c] = ((color[c] as f32 * alpha + dst[c] as f32 * da * (1.0 - alpha)) / out).round()
                as u8;
        }
        dst[3] = (out * 255.0).round() as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyframe_interpolation_and_tempo_are_bounded() {
        let c = json!({"keyframes":[{"property":"transform.x","time":0,"value":0},{"property":"x","time":2,"value":100}]});
        let expression = expression(&c, "x", 0.0, "t");
        assert!(expression.contains("if(lt(t,2.000000)"));
        assert_eq!(tempo_chain(0.125), "atempo=0.5,atempo=0.5,atempo=0.500000");
    }
    #[test]
    fn korean_text_produces_pixels() {
        let dir = std::env::temp_dir().join(media::id("studio-text-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("text.png");
        rasterize_text(
            &json!({"text":{"content":"한글 자막\nStudio","fontSize":48,"color":"#ffffff"}}),
            1280,
            &path,
        )
        .unwrap();
        let img = image::open(&path).unwrap().into_rgba8();
        assert!(img.pixels().filter(|p| p[3] > 0).count() > 100);
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn explicit_font_bytes_are_used_and_missing_font_never_silently_falls_back() {
        let Some(source) = font_path("Arial", false) else {
            return;
        };
        let dir = std::env::temp_dir().join(media::id("studio-custom-font-render"));
        std::fs::create_dir_all(&dir).unwrap();
        let copied = dir.join("custom.ttf");
        std::fs::copy(&source, &copied).unwrap();
        let baseline = dir.join("baseline.png");
        let custom = dir.join("custom.png");
        rasterize_text(
            &json!({"text":{"content":"Identical Font 123","fontFamily":"Arial","fontSize":48}}),
            1280,
            &baseline,
        )
        .unwrap();
        rasterize_text(&json!({"text":{"content":"Identical Font 123","fontFamily":"Imaginary Family","fontPath":copied,"fontSize":48}}),1280,&custom).unwrap();
        assert_eq!(
            std::fs::read(&baseline).unwrap(),
            std::fs::read(&custom).unwrap()
        );
        assert!(rasterize_text(
            &json!({"text":{"content":"must fail","fontPath":dir.join("missing.ttf")}}),
            1280,
            &custom
        )
        .is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn imported_regular_font_bold_increases_ink_and_regular_remains_reproducible() {
        let Some(source) = font_path("Arial", false) else {
            return;
        };
        let dir = std::env::temp_dir().join(media::id("studio-custom-font-bold"));
        std::fs::create_dir_all(&dir).unwrap();
        let font = dir.join("imported.ttf");
        std::fs::copy(source, &font).unwrap();
        let mut clip = json!({"text":{"content":"Bold Font 123\nSecond line","fontPath":font,"fontSize":64,"color":"#ffffff","bold":false}});
        let regular = dir.join("regular.png");
        let bold = dir.join("bold.png");
        let reverted = dir.join("reverted.png");
        rasterize_text(&clip, 1280, &regular).unwrap();
        clip["text"]["bold"] = json!(true);
        rasterize_text(&clip, 1280, &bold).unwrap();
        let original = image::open(&regular).unwrap().into_rgba8();
        let thick = image::open(&bold).unwrap().into_rgba8();
        let ink = |image: &RgbaImage| image.pixels().filter(|p| p[0] > 220 && p[3] > 128).count();
        assert!(
            ink(&thick) > ink(&original),
            "Bold must visibly thicken the imported regular face"
        );
        assert!(
            thick
                .enumerate_pixels()
                .filter(|(x, y, _)| *x == 0
                    || *y == 0
                    || *x == thick.width() - 1
                    || *y == thick.height() - 1)
                .all(|(_, _, p)| p[3] == 0),
            "Synthetic weight must not clip at the text image border"
        );
        clip["text"]["bold"] = json!(false);
        rasterize_text(&clip, 1280, &reverted).unwrap();
        assert_eq!(
            std::fs::read(&regular).unwrap(),
            std::fs::read(&reverted).unwrap()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn actual_media_edit_render_and_preview() {
        let dir = std::env::temp_dir().join(media::id("studio-render-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("original.mp4");
        let generated = Command::new(media::executable("ffmpeg"))
            .args([
                "-y",
                "-v",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=320x180:r=24:d=1.2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=1.2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&input)
            .output()
            .await
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":24}}),
        )
        .await
        .unwrap();
        let imported = e
            .dispatch("media.import", json!({"paths":[input]}))
            .await
            .unwrap();
        let p = e
            .dispatch(
                "edit.add",
                json!({"mediaId":imported["media"][0]["id"],"duration":1.0}),
            )
            .await
            .unwrap();
        e.dispatch("edit.update",json!({"id":p["clips"][0]["id"],"patch":{"fadeIn":0.1,"fadeOut":0.1,"transform":{"scale":0.8,"x":10,"rotation":5},"audio":{"normalize":true,"denoise":true,"voiceEnhance":true,"eq":{"bass":2,"mid":-1,"treble":1}},"keyframes":[{"property":"scale","time":0,"value":0.8},{"property":"scale","time":1,"value":0.9},{"property":"transform.opacity","time":0,"value":0.7},{"property":"transform.opacity","time":0.4,"value":1}]}})).await.unwrap();
        e.dispatch(
            "edit.add",
            json!({"text":{"content":"실제 출력","fontSize":24},"start":0.1,"duration":0.8}),
        )
        .await
        .unwrap();
        let output = dir.join("result.mp4");
        let job = e
            .dispatch(
                "export.start",
                json!({"path":output,"width":320,"height":180,"fps":24,"format":"mp4"}),
            )
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let status = e
                .dispatch("export.status", json!({"id":job["id"]}))
                .await
                .unwrap();
            if status["state"] == "completed" {
                break;
            }
            assert_ne!(status["state"], "failed", "{status}");
            assert!(
                std::time::Instant::now() < deadline,
                "render timeout: {status}"
            );
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let probe = media::probe(&output, &dir).await.unwrap();
        assert_eq!(probe["width"], 320);
        assert_eq!(probe["height"], 180);
        assert_eq!(probe["hasAudio"], true);
        assert!((number(&probe, "duration", 0.0) - 1.0).abs() < 0.1);
        let frame = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let png = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        assert_eq!(png.width(), 320);
        assert!(png.pixels().any(|p| p[0] > 200 && p[1] < 80));
        assert!(e
            .asset_path(frame["assetId"].as_str().unwrap(), false)
            .is_some());
        for format in ["mov", "webm", "mp3", "wav"] {
            let path = dir.join(format!("format-check.{format}"));
            let job=e.dispatch("export.start",json!({"path":path,"format":format,"width":320,"height":180,"start":0.2,"end":0.7})).await.unwrap();
            wait_for_job(&mut e, &job).await;
            let asset = media::probe(&path, &dir).await.unwrap();
            assert_eq!(asset["hasAudio"], true);
            assert!(
                (number(&asset, "duration", 0.0) - 0.5).abs() < 0.12,
                "{format}: {asset}"
            );
            assert_eq!(
                asset["kind"],
                if matches!(format, "mp3" | "wav") {
                    "audio"
                } else {
                    "video"
                }
            );
        }
        let preview = e
            .dispatch("preview.start", json!({"width":320}))
            .await
            .unwrap();
        wait_for_job(&mut e, &preview).await;
        assert!(e
            .asset_path(preview["assetId"].as_str().unwrap(), false)
            .is_some());
        let cancelled_path = dir.join("cancelled.mp4");
        let job = e
            .dispatch(
                "export.start",
                json!({"path":cancelled_path,"format":"mp4"}),
            )
            .await
            .unwrap();
        e.dispatch("export.cancel", json!({"id":job["id"]}))
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let status = e
                .dispatch("export.status", json!({"id":job["id"]}))
                .await
                .unwrap();
            if status["state"] == "cancelled" {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "{status}");
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(!cancelled_path.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
    async fn wait_for_job(e: &mut crate::editor::Editor, job: &Value) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let status = e
                .dispatch("export.status", json!({"id":job["id"]}))
                .await
                .unwrap();
            if status["state"] == "completed" {
                break;
            }
            assert_ne!(status["state"], "failed", "{status}");
            assert!(std::time::Instant::now() < deadline, "{status}");
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
    }
    #[tokio::test]
    async fn crop_mask_flip_and_export_match_rendered_preview() {
        let dir = std::env::temp_dir().join(media::id("studio-composition-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("two-colors.png");
        let mut image = RgbaImage::new(320, 180);
        for (x, _, pixel) in image.enumerate_pixels_mut() {
            *pixel = if x < 160 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 255, 0, 255])
            };
        }
        image.save(&input).unwrap();
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":24,"background":"#000000"}}),
        )
        .await
        .unwrap();
        let p = e
            .dispatch("media.import", json!({"paths":[input]}))
            .await
            .unwrap();
        let p = e
            .dispatch(
                "edit.add",
                json!({"mediaId":p["media"][0]["id"],"duration":1.0}),
            )
            .await
            .unwrap();
        let clip = p["clips"][0]["id"].clone();
        e.dispatch(
            "edit.update",
            json!({"id":clip,"patch":{"transform":{"flipX":true}}}),
        )
        .await
        .unwrap();
        let frame = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let flipped = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        assert!(flipped.get_pixel(40, 90)[1] > 220);
        assert!(flipped.get_pixel(280, 90)[0] > 220);
        e.dispatch("edit.update",json!({"id":clip,"patch":{"crop":{"x":0.5,"y":0,"width":0.5,"height":1},"mask":{"type":"circle","x":0.5,"y":0.5,"width":1,"height":1,"feather":0}}})).await.unwrap();
        let frame = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let expected = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        assert!(expected.get_pixel(160, 90)[1] > 220);
        assert!(expected.get_pixel(82, 2).0.iter().all(|v| *v < 10));
        assert!(expected.get_pixel(20, 90).0.iter().all(|v| *v < 10));
        let output = dir.join("masked.mp4");
        let job = e
            .dispatch(
                "export.start",
                json!({"path":output,"format":"mp4","crf":18}),
            )
            .await
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let status = e
                .dispatch("export.status", json!({"id":job["id"]}))
                .await
                .unwrap();
            if status["state"] == "completed" {
                break;
            }
            assert_ne!(status["state"], "failed", "{status}");
            assert!(std::time::Instant::now() < deadline);
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let decoded = Command::new(media::executable("ffmpeg"))
            .args(["-v", "error", "-ss", "0.5", "-i"])
            .arg(&output)
            .args([
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ])
            .output()
            .await
            .unwrap();
        assert!(decoded.status.success());
        assert_eq!(decoded.stdout.len(), expected.as_raw().len());
        let error = decoded
            .stdout
            .iter()
            .zip(expected.as_raw())
            .map(|(a, b)| (*a as f64 - *b as f64).abs())
            .sum::<f64>()
            / decoded.stdout.len() as f64;
        assert!(error < 4.0, "preview/export mean pixel difference: {error}");
        e.dispatch("edit.update",json!({"id":clip,"patch":{"mask":{"type":"none"},"chromaKey":{"enabled":true,"color":"#00ff00","similarity":0.2,"blend":0.05}}})).await.unwrap();
        let frame = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let keyed = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        assert!(keyed.get_pixel(160, 90).0.iter().all(|v| *v < 10));
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn hsl_curves_and_managed_lut_are_real_and_persistent() {
        let dir =
            std::env::temp_dir().join(format!("{}' quoted:root", media::id("studio-color-test")));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("red-green.png");
        let mut image = RgbaImage::new(320, 180);
        for (x, _, pixel) in image.enumerate_pixels_mut() {
            *pixel = if x < 160 {
                Rgba([255, 0, 0, 255])
            } else {
                Rgba([0, 255, 0, 255])
            };
        }
        image.save(&input).unwrap();
        let state = dir.join("state");
        let mut e = crate::editor::Editor::new(state.clone()).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":24}}),
        )
        .await
        .unwrap();
        let p = e
            .dispatch(
                "media.importAndAdd",
                json!({"paths":[input],"duration":1.0}),
            )
            .await
            .unwrap();
        let id = p["clips"][0]["id"].clone();
        e.dispatch(
            "edit.update",
            json!({"id":id,"patch":{"color":{"hsl":{"red":{"saturation":-1.0}}}}}),
        )
        .await
        .unwrap();
        let frame = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let image = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        let gray = image.get_pixel(40, 90);
        assert!(
            (gray[0] as i32 - gray[1] as i32).abs() < 8
                && (gray[1] as i32 - gray[2] as i32).abs() < 8,
            "red saturation: {gray:?}"
        );
        assert!(image.get_pixel(280, 90)[1] > 220);
        e.dispatch("edit.update",json!({"id":id,"patch":{"color":{"hsl":{"red":{"saturation":0}},"curves":{"master":[[0,0],[1,0.4]]}}}})).await.unwrap();
        let frame = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let image = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        assert!((85..120).contains(&image.get_pixel(40, 90)[0]));
        e.dispatch(
            "edit.update",
            json!({"id":id,"patch":{"color":{"curves":{"master":[],"preset":"none"}}}}),
        )
        .await
        .unwrap();
        let lut = dir.join("look's.cube");
        let mut cube = String::from("TITLE \"swap red and blue\"\nLUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    cube.push_str(&format!("{b} {g} {r}\n"));
                }
            }
        }
        std::fs::write(&lut, cube).unwrap();
        let p = e
            .dispatch("color.importLut", json!({"id":id,"path":lut}))
            .await
            .unwrap();
        let managed = PathBuf::from(p["clips"][0]["color"]["lut"]["path"].as_str().unwrap());
        assert!(managed.is_file());
        assert_ne!(managed, lut);
        std::fs::remove_file(lut).unwrap();
        drop(e);
        let mut e = crate::editor::Editor::new(state).unwrap();
        let frame = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let expected = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        assert!(
            expected.get_pixel(40, 90)[2] > 220 && expected.get_pixel(40, 90)[0] < 20,
            "LUT output: {:?}",
            expected.get_pixel(40, 90)
        );
        let output = dir.join("color.mp4");
        let job = e
            .dispatch(
                "export.start",
                json!({"path":output,"format":"mp4","crf":18}),
            )
            .await
            .unwrap();
        wait_for_job(&mut e, &job).await;
        assert_preview_matches_export(&expected, &output).await;
        std::fs::remove_dir_all(dir).unwrap();
    }
    async fn assert_preview_matches_export(expected: &image::RgbImage, path: &Path) {
        let decoded = Command::new(media::executable("ffmpeg"))
            .args(["-v", "error", "-ss", "0.5", "-i"])
            .arg(path)
            .args([
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ])
            .output()
            .await
            .unwrap();
        assert!(decoded.status.success());
        assert_eq!(decoded.stdout.len(), expected.as_raw().len());
        let error = decoded
            .stdout
            .iter()
            .zip(expected.as_raw())
            .map(|(a, b)| (*a as f64 - *b as f64).abs())
            .sum::<f64>()
            / decoded.stdout.len() as f64;
        assert!(error < 4.0, "preview/export mean pixel difference: {error}");
    }
    #[tokio::test]
    async fn single_pass_stabilization_matches_export() {
        let dir = std::env::temp_dir().join(media::id("studio-stabilize-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let pattern = dir.join("pattern.png");
        let mut image = RgbaImage::new(340, 200);
        for (x, y, pixel) in image.enumerate_pixels_mut() {
            let v = if (x / 17 + y / 13) % 2 == 0 { 230 } else { 20 };
            *pixel = Rgba([v, v, v, 255]);
        }
        image.save(&pattern).unwrap();
        let input = dir.join("shaky.mp4");
        let made = Command::new(media::executable("ffmpeg"))
            .args(["-v", "error", "-y", "-loop", "1", "-framerate", "24", "-i"])
            .arg(&pattern)
            .args([
                "-vf",
                "crop=320:180:x='10+8*sin(n/2)':y='10+5*cos(n/3)'",
                "-t",
                "1.5",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(&input)
            .output()
            .await
            .unwrap();
        assert!(
            made.status.success(),
            "{}",
            String::from_utf8_lossy(&made.stderr)
        );
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":24}}),
        )
        .await
        .unwrap();
        let p = e
            .dispatch("media.importAndAdd", json!({"paths":[input]}))
            .await
            .unwrap();
        let id = p["clips"][0]["id"].clone();
        let before = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let original = image::open(before["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        e.dispatch(
            "edit.update",
            json!({"id":id,"patch":{"stabilize":{"enabled":true,"strength":2}}}),
        )
        .await
        .unwrap();
        let after = e
            .dispatch("preview.frame", json!({"time":0.5,"width":320}))
            .await
            .unwrap();
        let stable = image::open(after["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        let delta = original
            .as_raw()
            .iter()
            .zip(stable.as_raw())
            .map(|(a, b)| (*a as f64 - *b as f64).abs())
            .sum::<f64>()
            / original.as_raw().len() as f64;
        assert!(delta > 0.1, "stabilization made no measurable pixel change");
        let output = dir.join("stable.mp4");
        let job = e
            .dispatch(
                "export.start",
                json!({"path":output,"format":"mp4","crf":18}),
            )
            .await
            .unwrap();
        wait_for_job(&mut e, &job).await;
        assert_preview_matches_export(&stable, &output).await;
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn clip_window_keeps_only_the_overlap_and_snaps_decoding_to_the_clip_frame_grid() {
        // Clips entirely before or after the window are not rendered at all.
        assert_eq!(clip_window(0.0, 5.0, 5.0, 6.0, 24.0, false), None);
        assert_eq!(clip_window(6.0, 5.0, 5.0, 6.0, 24.0, false), None);
        let inside = clip_window(10.0, 5.0, 12.0, 13.0, 24.0, false).unwrap();
        assert_eq!((inside.from, inside.skip, inside.len), (2.0, 2.0, 1.0));
        // A clip that is not frame aligned decodes from its own frame at or before the window.
        let unaligned = clip_window(0.26, 5.0, 1.0, 1.5, 24.0, false).unwrap();
        assert!((unaligned.skip - 0.74).abs() < 1e-9);
        assert!((unaligned.from - 17.0 / 24.0).abs() < 1e-9);
        // Stateful filters start at the clip start; the output is still clipped to the window.
        let preroll = clip_window(10.0, 5.0, 12.0, 20.0, 24.0, true).unwrap();
        assert_eq!((preroll.from, preroll.skip, preroll.len), (0.0, 2.0, 3.0));
        let whole = clip_window(1.0, 2.0, 0.0, 10.0, 24.0, false).unwrap();
        assert_eq!((whole.from, whole.skip, whole.len), (0.0, 0.0, 2.0));
    }
    #[test]
    fn output_with_a_different_aspect_is_letterboxed_not_stretched() {
        assert_eq!(fit_filter(1920.0, 1080.0, 1280, 720), "scale=1280:720");
        // Even-size rounding of a matching aspect must not add a one pixel bar.
        assert_eq!(fit_filter(1080.0, 1920.0, 640, 1136), "scale=640:1136");
        assert_eq!(
            fit_filter(1920.0, 1080.0, 1080, 1080),
            "scale=1080:608,pad=1080:1080:(ow-iw)/2:(oh-ih)/2:color=black"
        );
        assert_eq!(
            fit_filter(1080.0, 1920.0, 1920, 1080),
            "scale=608:1080,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black"
        );
    }
    #[tokio::test]
    async fn stderr_reader_drains_everything_and_keeps_the_final_error() {
        let mut noise = "decode warning\n".repeat(40_000).into_bytes();
        noise.extend_from_slice(b"Error opening output file: the real cause");
        assert!(noise.len() > STDERR_TAIL * 4);
        let tail = read_tail(noise.as_slice(), STDERR_TAIL).await;
        assert_eq!(tail.len(), STDERR_TAIL);
        assert!(tail.ends_with("the real cause"));
        assert_eq!(read_tail(&b"short"[..], STDERR_TAIL).await, "short");
    }
    #[test]
    fn finished_job_states_are_bounded_and_active_jobs_are_never_forgotten() {
        let mut states = HashMap::new();
        for i in 0..MAX_JOBS as u64 {
            let state = if i < 3 { "running" } else { "completed" };
            states.insert(
                format!("job-{i}"),
                json!({"id":format!("job-{i}"),"state":state,"startedAt":i}),
            );
        }
        prune_finished(&mut states);
        assert_eq!(states.len(), MAX_JOBS - 1);
        assert!(states.contains_key("job-0") && !states.contains_key("job-3"));
        let mut active: HashMap<String, Value> = (0..MAX_JOBS + 5)
            .map(|i| (i.to_string(), json!({"id":i.to_string(),"state":"running"})))
            .collect();
        prune_finished(&mut active);
        assert_eq!(active.len(), MAX_JOBS + 5);
    }
    #[test]
    fn stale_scratch_files_are_removed_once_and_user_files_are_left_alone() {
        let root = std::env::temp_dir().join(media::id("studio-clean-test"));
        for dir in ["previews/preview-old", "renders/export-old", "thumbnails", "imports"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        let stale = [
            "previews/preview-old.png",
            "previews/preview-video-old.mp4",
            "previews/preview-old/text-0.png",
            "renders/export-old/filters.ffgraph",
        ];
        let kept = ["thumbnails/media-1.jpg", "imports/clip.mp4", "current.json"];
        for file in stale.iter().chain(&kept) {
            std::fs::write(root.join(file), b"x").unwrap();
        }
        clean_stale_once(&root);
        assert!(stale.iter().all(|file| !root.join(file).exists()));
        assert!(!root.join("previews/preview-old").exists());
        assert!(kept.iter().all(|file| root.join(file).is_file()));
        // Files this process creates afterwards are in use and must survive later calls.
        std::fs::write(root.join("previews/current.png"), b"x").unwrap();
        clean_stale_once(&root);
        assert!(root.join("previews/current.png").is_file());
        std::fs::remove_dir_all(root).unwrap();
    }
    async fn finish(jobs: &RenderJobs, job: &Value) -> Value {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
        loop {
            let status = jobs.status(job["id"].as_str().unwrap()).unwrap();
            if !["queued", "running"].contains(&string(&status, "state", "")) {
                return status;
            }
            assert!(std::time::Instant::now() < deadline, "{status}");
            tokio::time::sleep(std::time::Duration::from_millis(30)).await;
        }
    }
    async fn frame_at(path: &Path, time: f64) -> Vec<u8> {
        let decoded = Command::new(media::executable("ffmpeg"))
            .args(["-v", "error", "-ss", &(time - 0.01).max(0.0).to_string(), "-i"])
            .arg(path)
            .args(["-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"])
            .output()
            .await
            .unwrap();
        assert!(decoded.status.success());
        decoded.stdout
    }
    fn mean_difference(a: &[u8], b: &[u8]) -> f64 {
        assert_eq!(a.len(), b.len());
        a.iter()
            .zip(b)
            .map(|(a, b)| (*a as f64 - *b as f64).abs())
            .sum::<f64>()
            / a.len() as f64
    }
    /// A project of three clips cut from one source whose colour changes every frame,
    /// so a frame that is off by one is far outside the comparison tolerance.
    async fn windowed_project(dir: &Path) -> Value {
        let input = dir.join("ramp.mp4");
        let generated = Command::new(media::executable("ffmpeg"))
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg("nullsrc=s=320x180:r=24:d=3,format=gbrp,geq=r='255*N/72':g='mod(N*20,256)':b=128")
            .args(["-f", "lavfi", "-i"])
            .arg("aevalsrc=0.5*sin(2*PI*440*t)*lt(t\\,1.5):s=48000:d=3")
            .args(["-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p"])
            .args(["-c:a", "aac", "-b:a", "192k"])
            .arg(&input)
            .output()
            .await
            .unwrap();
        assert!(
            generated.status.success(),
            "{}",
            String::from_utf8_lossy(&generated.stderr)
        );
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":24,"background":"#000000"}}),
        )
        .await
        .unwrap();
        let mut p = e
            .dispatch("media.import", json!({"paths":[input]}))
            .await
            .unwrap();
        let media_id = p["media"][0]["id"].clone();
        for start in [0.0, 1.0, 2.0] {
            p = e
                .dispatch(
                    "edit.add",
                    json!({"mediaId":media_id,"start":start,"duration":1.0}),
                )
                .await
                .unwrap();
        }
        let mut clips = p["clips"].as_array().unwrap().clone();
        clips.sort_by(|a, b| number(a, "start", 0.0).total_cmp(&number(b, "start", 0.0)));
        assert_eq!(clips.len(), 3);
        clips[0]["sourceIn"] = json!(0.5);
        clips[0]["fadeOut"] = json!(0.25);
        clips[0]["keyframes"] = json!([
            {"property":"x","time":0,"value":0},{"property":"x","time":1,"value":100},
            {"property":"volume","time":0,"value":1},{"property":"volume","time":1,"value":0.5}
        ]);
        clips[1]["sourceIn"] = json!(0.0);
        clips[1]["speed"] = json!(2.0);
        clips[2]["sourceIn"] = json!(1.0);
        clips[2]["reverse"] = json!(true);
        clips[2]["keyframes"] = json!([
            {"property":"scale","time":0,"value":1},{"property":"scale","time":1,"value":0.5},
            {"property":"opacity","time":0,"value":1},{"property":"opacity","time":1,"value":0.4}
        ]);
        p["clips"] = json!(clips);
        validate_project(&p).unwrap();
        p
    }
    #[tokio::test]
    async fn windowed_frames_and_ranges_match_the_full_timeline_render() {
        let dir = std::env::temp_dir().join(media::id("studio-window-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let project = windowed_project(&dir).await;
        let root = dir.join("state");
        let jobs = RenderJobs::default();
        let full = dir.join("full.mp4");
        let job = jobs
            .start(
                project.clone(),
                json!({"path":full,"format":"mp4","crf":8}),
                root.clone(),
            )
            .await
            .unwrap();
        assert_eq!(finish(&jobs, &job).await["state"], "completed");
        // Normal, faded and moving, double speed, reversed with keyframes, last frame.
        for time in [0.25, 0.875, 1.5, 2.5, 71.0 / 24.0] {
            let frame = preview_frame(&project, &json!({"time":time,"width":320}), &root)
                .await
                .unwrap();
            let preview = image::open(frame["path"].as_str().unwrap())
                .unwrap()
                .to_rgb8();
            let error = mean_difference(preview.as_raw(), &frame_at(&full, time).await);
            assert!(error < 2.5, "frame at {time}s differs from the export: {error}");
        }
        let range = dir.join("range.mp4");
        let job = jobs
            .start(
                project.clone(),
                json!({"path":range,"format":"mp4","crf":8,"start":1.25,"end":2.75}),
                root.clone(),
            )
            .await
            .unwrap();
        assert_eq!(finish(&jobs, &job).await["state"], "completed");
        let exported = media::probe(&range, &dir).await.unwrap();
        assert!((number(&exported, "duration", 0.0) - 1.5).abs() < 0.1);
        for offset in [0.0, 0.5, 1.25, 35.0 / 24.0] {
            let error = mean_difference(
                &frame_at(&range, offset).await,
                &frame_at(&full, 1.25 + offset).await,
            );
            assert!(error < 2.5, "range frame at +{offset}s differs: {error}");
        }
        // The source tone ends 1.5 s into the source: clip 2 (double speed) plays it until
        // 1.75 s, and the reversed clip 3 (source 2.0→1.0 s) reaches it again at 2.5 s.
        let audio = dir.join("range.wav");
        let job = jobs
            .start(
                project.clone(),
                json!({"path":audio,"format":"wav","start":1.25,"end":2.75}),
                root.clone(),
            )
            .await
            .unwrap();
        assert_eq!(finish(&jobs, &job).await["state"], "completed");
        let exported = media::probe(&audio, &dir).await.unwrap();
        assert!((number(&exported, "duration", 0.0) - 1.5).abs() < 0.05);
        let peaks: Vec<f64> = exported["waveform"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        let at = |seconds: f64| peaks[(seconds / 1.5 * peaks.len() as f64) as usize];
        assert!(at(0.1) > 0.3 && at(0.4) > 0.3, "tone expected: {peaks:?}");
        assert!(at(0.6) < 0.02 && at(1.15) < 0.02, "silence expected: {peaks:?}");
        assert!(at(1.35) > 0.3 && at(1.45) > 0.3, "reversed tone expected: {peaks:?}");
        std::fs::remove_dir_all(dir).unwrap();
    }
    /// Slow motion and a source frame rate other than the project's put window starts
    /// between source frames, where the full render repeats the previous frame.
    #[tokio::test]
    async fn windows_between_source_frames_match_the_full_timeline_render() {
        let dir = std::env::temp_dir().join(media::id("studio-window-fps-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let mut inputs = vec![];
        for rate in [25, 24] {
            let input = dir.join(format!("ramp{rate}.mp4"));
            let generated = Command::new(media::executable("ffmpeg"))
                .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("nullsrc=s=320x180:r={rate}:d=3,format=gbrp,geq=r='255*N/75':g='mod(N*40,256)':b=128"))
                .args(["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-shortest"])
                .args(["-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p", "-c:a", "aac"])
                .arg(&input)
                .output()
                .await
                .unwrap();
            assert!(generated.status.success());
            inputs.push(input);
        }
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":30,"background":"#000000"}}),
        )
        .await
        .unwrap();
        let mut p = e
            .dispatch("media.import", json!({"paths":inputs}))
            .await
            .unwrap();
        let media = p["media"].clone();
        // 25 and 24 fps in a 30 fps project, quarter and half speed, cuts between frames.
        let cuts = [
            (0, 0.0, 1.0, 0.0),
            (1, 1.0, 0.25, 0.0),
            (1, 2.0, 0.5, 0.31),
            (0, 3.0, 1.0, 0.33),
            (1, 4.0, 1.0, 0.0),
        ];
        for (index, start, ..) in cuts {
            p = e
                .dispatch(
                    "edit.add",
                    json!({"mediaId":media[index]["id"],"start":start,"duration":1.0}),
                )
                .await
                .unwrap();
        }
        for (_, start, speed, source_in) in cuts {
            let clip = p["clips"]
                .as_array_mut()
                .unwrap()
                .iter_mut()
                .find(|c| number(c, "start", -1.0) == start)
                .unwrap();
            clip["speed"] = json!(speed);
            clip["sourceIn"] = json!(source_in);
        }
        assert_eq!(p["clips"].as_array().unwrap().iter().filter(|c| c["speed"] != 1.0).count(), 2);
        validate_project(&p).unwrap();
        let root = dir.join("state");
        let jobs = RenderJobs::default();
        let full = dir.join("full.mp4");
        let job = jobs
            .start(p.clone(), json!({"path":full,"format":"mp4","crf":8}), root.clone())
            .await
            .unwrap();
        assert_eq!(finish(&jobs, &job).await["state"], "completed");
        for frame in (2..150).step_by(3).chain([4, 10, 34, 35, 36, 37, 61, 63, 65, 94, 100, 137]) {
            let time = frame as f64 / 30.0;
            let still = preview_frame(&p, &json!({"time":time,"width":320}), &root)
                .await
                .unwrap();
            let preview = image::open(still["path"].as_str().unwrap())
                .unwrap()
                .to_rgb8();
            let error = mean_difference(preview.as_raw(), &frame_at(&full, time).await);
            assert!(error < 2.5, "frame {frame} differs from the export: {error}");
        }
        for start in [35, 63, 100, 130] {
            let range = dir.join(format!("range{start}.mp4"));
            let from = start as f64 / 30.0;
            let job = jobs
                .start(
                    p.clone(),
                    json!({"path":range,"format":"mp4","crf":8,"start":from,"end":from + 0.5}),
                    root.clone(),
                )
                .await
                .unwrap();
            assert_eq!(finish(&jobs, &job).await["state"], "completed");
            for offset in 0..12 {
                let offset = offset as f64 / 30.0;
                let error = mean_difference(
                    &frame_at(&range, offset).await,
                    &frame_at(&full, from + offset).await,
                );
                assert!(error < 2.5, "range {start} frame at +{offset}s differs: {error}");
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn a_late_frame_reads_only_the_clips_under_it() {
        let dir = std::env::temp_dir().join(media::id("studio-late-frame-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let mut paths = vec![];
        for (name, color) in [("early.png", [255, 0, 0, 255]), ("late.png", [0, 0, 255, 255])] {
            let path = dir.join(name);
            RgbaImage::from_pixel(320, 180, Rgba(color)).save(&path).unwrap();
            paths.push(path);
        }
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":24}}),
        )
        .await
        .unwrap();
        let p = e
            .dispatch("media.import", json!({"paths":paths}))
            .await
            .unwrap();
        let mut project = Value::Null;
        for (index, start) in [(0, 0.0), (1, 600.0)] {
            project = e
                .dispatch(
                    "edit.add",
                    json!({"mediaId":p["media"][index]["id"],"start":start,"duration":5.0}),
                )
                .await
                .unwrap();
        }
        // The earlier clip's file is gone: a frame ten minutes later must not need it.
        std::fs::remove_file(&paths[0]).unwrap();
        let root = dir.join("state");
        let frame = preview_frame(&project, &json!({"time":602.5,"width":320}), &root)
            .await
            .unwrap();
        let png = image::open(frame["path"].as_str().unwrap())
            .unwrap()
            .to_rgb8();
        assert!(png.get_pixel(160, 90)[2] > 220 && png.get_pixel(160, 90)[0] < 30);
        let error = preview_frame(&project, &json!({"time":2.5,"width":320}), &root)
            .await
            .unwrap_err();
        assert!(error.contains("원본 미디어를 찾을 수 없습니다"), "{error}");
        // A cancelled frame render stops and leaves nothing behind.
        let before = std::fs::read_dir(root.join("previews")).unwrap().count();
        let cancelled = preview_frame_cancellable(
            &project,
            &json!({"time":601.0,"width":320}),
            &root,
            Arc::new(AtomicBool::new(true)),
        )
        .await;
        assert!(cancelled.is_err());
        assert_eq!(
            std::fs::read_dir(root.join("previews")).unwrap().count(),
            before
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn existing_output_needs_overwrite_and_other_aspect_is_letterboxed() {
        let dir = std::env::temp_dir().join(media::id("studio-overwrite-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("red.png");
        RgbaImage::from_pixel(320, 180, Rgba([255, 0, 0, 255]))
            .save(&input)
            .unwrap();
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        e.dispatch(
            "project.update",
            json!({"patch":{"width":320,"height":180,"fps":24,"background":"#00ff00"}}),
        )
        .await
        .unwrap();
        let project = e
            .dispatch("media.importAndAdd", json!({"paths":[input],"duration":0.5}))
            .await
            .unwrap();
        let root = dir.join("state");
        let jobs = RenderJobs::default();
        let output = dir.join("square.mp4");
        std::fs::write(&output, b"someone else's video").unwrap();
        let params = json!({"path":output,"format":"mp4","width":180,"height":180,"crf":12});
        let refused = jobs
            .start(project.clone(), params.clone(), root.clone())
            .await
            .unwrap_err();
        assert!(refused.contains("FILE_EXISTS"), "{refused}");
        assert_eq!(std::fs::read(&output).unwrap(), b"someone else's video");
        let mut allowed = params.clone();
        allowed["overwrite"] = json!(true);
        let job = jobs.start(project.clone(), allowed, root.clone()).await.unwrap();
        assert_eq!(finish(&jobs, &job).await["state"], "completed");
        let exported = media::probe(&output, &dir).await.unwrap();
        assert_eq!((exported["width"].as_u64(), exported["height"].as_u64()), (Some(180), Some(180)));
        let pixels = frame_at(&output, 0.25).await;
        let pixel = |x: usize, y: usize| &pixels[(y * 180 + x) * 3..(y * 180 + x) * 3 + 3];
        // 320x180 fits as 180x102 in the middle, with black bars above and below.
        assert!(pixel(90, 90)[0] > 200 && pixel(90, 90)[1] < 60);
        assert!(pixel(4, 90)[0] > 200, "the picture must span the full width");
        for y in [4, 30, 150, 175] {
            assert!(pixel(90, y).iter().all(|v| *v < 30), "bar at y={y}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn only_recent_precise_playback_videos_stay_on_disk() {
        let dir = std::env::temp_dir().join(media::id("studio-proxy-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("red.png");
        RgbaImage::from_pixel(64, 64, Rgba([255, 0, 0, 255]))
            .save(&input)
            .unwrap();
        let mut e = crate::editor::Editor::new(dir.join("state")).unwrap();
        let project = e
            .dispatch("media.importAndAdd", json!({"paths":[input],"duration":0.2}))
            .await
            .unwrap();
        let root = dir.join("state");
        let jobs = RenderJobs::default();
        let mut videos = vec![];
        for index in 0..=MAX_PREVIEW_VIDEOS {
            let path = root.join("previews").join(format!("preview-video-{index}.mp4"));
            let job = jobs
                .start(
                    project.clone(),
                    json!({"path":path,"format":"mp4","width":64,"height":36,"preview":true}),
                    root.clone(),
                )
                .await
                .unwrap();
            assert_eq!(finish(&jobs, &job).await["state"], "completed");
            videos.push(path);
        }
        assert!(!videos[0].exists());
        assert!(videos[1..].iter().all(|path| path.is_file()));
        // The preview flag never makes a user's export disposable.
        let user = dir.join("mine.mp4");
        for _ in 0..=MAX_PREVIEW_VIDEOS {
            let job = jobs
                .start(
                    project.clone(),
                    json!({"path":user,"format":"mp4","width":64,"height":36,"preview":true,"overwrite":true}),
                    root.clone(),
                )
                .await
                .unwrap();
            assert_eq!(finish(&jobs, &job).await["state"], "completed");
        }
        assert!(user.is_file() && videos[1..].iter().all(|path| path.is_file()));
        std::fs::remove_dir_all(dir).unwrap();
    }

    // ---- Hand-built projects: these go straight to the renderer, so they test what
    // it draws independently of which fields the editor accepts. ----
    fn solid(dir: &Path, name: &str, color: [u8; 3], size: (u32, u32)) -> Value {
        let path = dir.join(format!("{name}.png"));
        RgbaImage::from_pixel(size.0, size.1, Rgba([color[0], color[1], color[2], 255]))
            .save(&path)
            .unwrap();
        json!({"id":name,"name":name,"path":path,"kind":"image","duration":5.0,
            "width":size.0,"height":size.1,"hasAudio":false})
    }
    fn layer(media: &str, track: &str, start: f64, duration: f64) -> Value {
        json!({"id":format!("clip-{media}-{start}"),"name":media,"kind":"image","mediaId":media,
            "trackId":track,"start":start,"duration":duration,"sourceIn":0.0,"speed":1.0,
            "volume":1.0,"fadeIn":0.0,"fadeOut":0.0,
            "transform":{"x":0.0,"y":0.0,"scale":1.0,"rotation":0.0,"opacity":1.0},"keyframes":[]})
    }
    fn composition(media: Vec<Value>, clips: Vec<Value>) -> Value {
        json!({"id":"project-test","name":"test","revision":0,"width":320,"height":180,"fps":24,
            "background":"#000000","media":media,"clips":clips,
            "tracks":[{"id":"v1","kind":"video","name":"V1","muted":false,"hidden":false,"locked":false},
                {"id":"v2","kind":"video","name":"V2","muted":false,"hidden":false,"locked":false}]})
    }
    async fn still(project: &Value, root: &Path, time: f64) -> image::RgbImage {
        let frame = render_frame(
            project,
            &json!({"time":time,"width":320}),
            root,
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        image::open(frame["path"].as_str().unwrap()).unwrap().to_rgb8()
    }
    fn near(pixel: &image::Rgb<u8>, want: [u8; 3], tolerance: i32) -> bool {
        (0..3).all(|i| (pixel[i] as i32 - want[i] as i32).abs() <= tolerance)
    }

    #[tokio::test]
    async fn easing_shapes_each_segment_and_linear_is_pixel_identical_to_no_easing() {
        // Linear keeps the exact expression older projects rendered with.
        let frames = |easing: Option<&str>| {
            let mut first = json!({"property":"x","time":0,"value":-100});
            if let Some(easing) = easing {
                first["easing"] = json!(easing);
            }
            json!([first, {"property":"x","time":1,"value":100}])
        };
        let plain = expression(&json!({"keyframes":frames(None)}), "x", 0.0, "t");
        assert_eq!(
            plain,
            "if(lt(t,1.000000),-100.000000+(200.000000)*((t)-0.000000)/1.000000,100.000000)"
        );
        assert_eq!(expression(&json!({"keyframes":frames(Some("linear"))}), "x", 0.0, "t"), plain);
        assert_ne!(expression(&json!({"keyframes":frames(Some("easeIn"))}), "x", 0.0, "t"), plain);

        let dir = std::env::temp_dir().join(media::id("studio-easing-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let dot = solid(&dir, "dot", [255, 255, 255], (40, 40));
        // Where the 36 px wide dot is, a quarter of the way through its move.
        let mut rendered = vec![];
        for (easing, eased) in [
            (None, 0.25),
            (Some("linear"), 0.25),
            (Some("easeIn"), 0.0625),
            (Some("easeOut"), 0.4375),
            (Some("easeInOut"), 0.15625),
            (Some("hold"), 0.0),
        ] {
            let mut clip = layer("dot", "v1", 0.0, 2.0);
            clip["transform"]["scale"] = json!(0.2);
            clip["keyframes"] = frames(easing);
            let project = composition(vec![dot.clone()], vec![clip]);
            let frame = still(&project, &dir, 0.25).await;
            let lit: Vec<f64> = frame
                .enumerate_pixels()
                .filter(|(_, _, p)| p[0] > 128)
                .map(|(x, _, _)| x as f64 + 0.5)
                .collect();
            assert!(lit.len() > 800, "{easing:?}: the dot must be fully visible");
            let centre = lit.iter().sum::<f64>() / lit.len() as f64;
            let expected = 160.0 - 100.0 + 200.0 * eased;
            // The layer lands on whole (chroma: even) pixels.
            assert!(
                (centre - expected).abs() <= 2.0,
                "{easing:?}: dot at {centre}, expected {expected}"
            );
            rendered.push(frame);
        }
        assert_eq!(rendered[0].as_raw(), rendered[1].as_raw());
        // After the last keyframe every easing rests on its value.
        let mut clip = layer("dot", "v1", 0.0, 2.0);
        clip["transform"]["scale"] = json!(0.2);
        clip["keyframes"] = frames(Some("hold"));
        let frame = still(&composition(vec![dot], vec![clip]), &dir, 1.5).await;
        assert!(frame.get_pixel(260, 90)[0] > 200 && frame.get_pixel(60, 90)[0] < 30);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn clips_show_on_exactly_their_frames_when_boundaries_are_inexact_in_floating_point() {
        let dir = std::env::temp_dir().join(media::id("studio-boundary-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let white = solid(&dir, "white", [255, 255, 255], (320, 180));
        // Frame times a 30 fps playhead and clip edges land on; several are not
        // exactly n × 1/30 in floating point (123/30 × 30 is 122.99999999999999).
        let at_30_fps = |clips: Vec<Value>| {
            let mut project = composition(vec![white.clone()], clips);
            project["fps"] = json!(30);
            project
        };
        for n in [1u32, 7, 23, 50, 113, 123, 200, 301] {
            let project = at_30_fps(vec![layer("white", "v1", n as f64 / 30.0, 10.0 / 30.0)]);
            for (frame, lit) in [(n - 1, 0), (n, 255), (n + 9, 255)] {
                let pixel = *still(&project, &dir, frame as f64 / 30.0).await.get_pixel(160, 90);
                assert!(near(&pixel, [lit; 3], 8), "clip from frame {n}, frame {frame}: {pixel:?}");
            }
        }
        // The exported file shows each clip on exactly its ten frames.
        let starts = [7u32, 23, 50, 113];
        let mut project = at_30_fps(
            starts.iter().map(|n| layer("white", "v1", *n as f64 / 30.0, 10.0 / 30.0)).collect(),
        );
        // An export validates the project like the editor does.
        project["markers"] = json!([]);
        project["notes"] = json!([]);
        project["concept"] = json!({"audience":"","message":"","appeal":"","direction":""});
        for clip in project["clips"].as_array_mut().unwrap() {
            clip["reverse"] = json!(false);
            clip["color"] = json!({"brightness":0.0,"contrast":1.0,"saturation":1.0,"temperature":0.0});
        }
        let output = dir.join("cuts.mp4");
        let jobs = RenderJobs::default();
        let job = jobs
            .start(
                project,
                json!({"path":output,"format":"mp4","crf":8,"hardware":false}),
                dir.join("state"),
            )
            .await
            .unwrap();
        assert_eq!(finish(&jobs, &job).await["state"], "completed");
        for n in starts {
            for (frame, lit) in [(n - 1, 0), (n, 255), (n + 9, 255), (n + 10, 0)] {
                // The file ends with the last clip.
                if frame >= 123 {
                    continue;
                }
                let level = frame_at(&output, frame as f64 / 30.0).await[(90 * 320 + 160) * 3];
                assert!(
                    (level as i32 - lit).abs() <= 24,
                    "export, clip from frame {n}, frame {frame}: {level}"
                );
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn opacity_keyframes_set_the_alpha_of_the_whole_layer() {
        let dir = std::env::temp_dir().join(media::id("studio-opacity-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let white = solid(&dir, "white", [255, 255, 255], (320, 180));
        let project = |easing: &str, rotation: f64| {
            let mut clip = layer("white", "v1", 0.0, 2.0);
            clip["transform"]["rotation"] = json!(rotation);
            clip["keyframes"] = json!([
                {"property":"opacity","time":0,"value":1,"easing":easing},
                {"property":"transform.opacity","time":1,"value":0.2}
            ]);
            composition(vec![white.clone()], vec![clip])
        };
        // Linear from 1 to 0.2: 0.8 a quarter in, 0.6 halfway, 0.2 from the end on.
        for (time, alpha) in [(0.0, 1.0), (0.25, 0.8), (0.5, 0.6), (1.0, 0.2), (1.5, 0.2)] {
            let frame = still(&project("linear", 0.0), &dir, time).await;
            let level = (255.0 * alpha) as u8;
            for (x, y) in [(4, 4), (160, 90), (315, 175)] {
                let pixel = frame.get_pixel(x, y);
                assert!(near(pixel, [level; 3], 8), "{time}s: {pixel:?}, expected {level}");
            }
        }
        let held = still(&project("hold", 0.0), &dir, 0.75).await;
        assert!(near(held.get_pixel(160, 90), [255; 3], 8));
        let eased = still(&project("easeIn", 0.0), &dir, 0.5).await;
        assert!(near(eased.get_pixel(160, 90), [204; 3], 8), "{:?}", eased.get_pixel(160, 90));
        // Together with a rotation, and the same in the exported file.
        let rotated = project("linear", 90.0);
        let expected = still(&rotated, &dir, 0.5).await;
        assert!(near(expected.get_pixel(160, 90), [153; 3], 8));
        assert!(near(expected.get_pixel(20, 90), [0; 3], 8));
        let output = dir.join("opacity.mp4");
        run(
            rotated,
            json!({"crf":12,"hardware":false}),
            &output,
            "mp4",
            &dir,
            "export-opacity",
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        for time in [0.25, 0.5, 1.5] {
            let expected = still(&project("linear", 90.0), &dir, time).await;
            let error = mean_difference(expected.as_raw(), &frame_at(&output, time).await);
            assert!(error < 4.0, "export differs at {time}s: {error}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn animated_scale_works_together_with_rotation_mask_and_animated_opacity() {
        let dir = std::env::temp_dir().join(media::id("studio-scale-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let red = solid(&dir, "red", [255, 0, 0], (320, 180));
        let mut clip = layer("red", "v1", 0.0, 2.0);
        clip["transform"]["rotation"] = json!(90.0);
        clip["mask"] = json!({"type":"rect","x":0.5,"y":0.5,"width":0.5,"height":1.0,"feather":0});
        clip["keyframes"] = json!([
            {"property":"scale","time":0,"value":1},{"property":"scale","time":1,"value":0.5},
            {"property":"opacity","time":0,"value":1},{"property":"opacity","time":1,"value":0.5}
        ]);
        let project = composition(vec![red], vec![clip]);
        // Halfway: scale 0.75, opacity 0.75. The mask keeps the middle half of the
        // clip's width (160 of 320), which the quarter turn stands upright: a bar
        // 135 px wide (180 * 0.75) and 120 px tall (160 * 0.75) around the centre.
        let frame = still(&project, &dir, 0.5).await;
        let inside = [191, 0, 0];
        for (x, y) in [(160, 90), (100, 40), (220, 140)] {
            let pixel = frame.get_pixel(x, y);
            assert!(near(pixel, inside, 12), "inside at ({x},{y}): {pixel:?}");
        }
        for (x, y) in [(80, 90), (240, 90), (160, 20), (160, 160), (10, 10)] {
            let pixel = frame.get_pixel(x, y);
            assert!(near(pixel, [0, 0, 0], 12), "outside at ({x},{y}): {pixel:?}");
        }
        let output = dir.join("scale.mp4");
        run(
            project.clone(),
            json!({"crf":12,"hardware":false}),
            &output,
            "mp4",
            &dir,
            "export-scale",
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        for time in [0.0, 0.5, 1.0, 1.5] {
            let expected = still(&project, &dir, time).await;
            let error = mean_difference(expected.as_raw(), &frame_at(&output, time).await);
            assert!(error < 4.0, "export differs at {time}s: {error}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn every_transition_type_enters_and_leaves_as_specified() {
        let dir = std::env::temp_dir().join(media::id("studio-transition-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let red = solid(&dir, "red", [255, 0, 0], (320, 180));
        const RED: [u8; 3] = [255, 0, 0];
        const HALF: [u8; 3] = [127, 0, 0];
        const NONE: [u8; 3] = [0, 0, 0];
        // Left, right, top and bottom of the frame halfway through entering (0.5 s)
        // and halfway through leaving (1.5 s) a two second clip with 1 s transitions.
        type Samples = [[u8; 3]; 4];
        let cases: [(&str, Samples, Samples); 9] = [
            ("fade", [HALF; 4], [HALF; 4]),
            ("dissolve", [HALF; 4], [HALF; 4]),
            ("wipeRight", [RED, NONE, RED, RED], [NONE, RED, RED, RED]),
            ("wipeLeft", [NONE, RED, RED, RED], [RED, NONE, RED, RED]),
            ("wipeDown", [RED, RED, RED, NONE], [RED, RED, NONE, RED]),
            ("wipeUp", [RED, RED, NONE, RED], [RED, RED, RED, NONE]),
            ("slideLeft", [NONE, RED, RED, RED], [RED, NONE, RED, RED]),
            ("slideRight", [RED, NONE, RED, RED], [NONE, RED, RED, RED]),
            ("zoom", [HALF; 4], [HALF; 4]),
        ];
        // Sample points; top and bottom lie in the horizontal middle band so that the
        // horizontal wipes and slides, which split the frame at x = 160, are read on
        // the side that the column of the sample belongs to.
        let points = [(80, 90), (240, 90), (160, 45), (160, 135)];
        for (kind, entering, leaving) in cases {
            let mut clip = layer("red", "v1", 0.0, 2.0);
            // The editor keeps fadeIn/fadeOut in step with the transition length; that
            // must fade the picture only for the alpha transitions.
            clip["fadeIn"] = json!(1.0);
            clip["fadeOut"] = json!(1.0);
            clip["transitionIn"] = json!({"type":kind,"duration":1.0});
            clip["transitionOut"] = json!({"type":kind,"duration":1.0});
            let project = composition(vec![red.clone()], vec![clip]);
            for (time, expected) in [(0.5, entering), (1.5, leaving)] {
                let frame = still(&project, &dir, time).await;
                for (index, (x, y)) in points.iter().enumerate() {
                    // The vertical samples sit on the x = 160 split of horizontal moves.
                    if index >= 2 && (kind.ends_with("Left") || kind.ends_with("Right")) {
                        continue;
                    }
                    if index < 2 && (kind.ends_with("Up") || kind.ends_with("Down")) {
                        assert!(
                            near(frame.get_pixel(*x, 30), expected[2], 16)
                                && near(frame.get_pixel(*x, 150), expected[3], 16),
                            "{kind} at {time}s, column {x}"
                        );
                        continue;
                    }
                    let pixel = frame.get_pixel(*x, *y);
                    assert!(
                        near(pixel, expected[index], 16),
                        "{kind} at {time}s, ({x},{y}): {pixel:?}, expected {:?}",
                        expected[index]
                    );
                }
                if kind == "zoom" {
                    // Scaled to 0.9: a 16 px border of background shows.
                    assert!(near(frame.get_pixel(5, 90), NONE, 16), "zoom border at {time}s");
                    assert!(near(frame.get_pixel(160, 4), NONE, 16), "zoom border at {time}s");
                }
            }
            // The exported file moves through the transition as the frame preview does.
            let output = dir.join(format!("{kind}.mp4"));
            run(
                project.clone(),
                json!({"crf":12,"hardware":false}),
                &output,
                "mp4",
                &dir,
                &format!("export-{kind}"),
                Arc::new(Mutex::new(HashMap::new())),
                Arc::new(AtomicBool::new(false)),
            )
            .await
            .unwrap();
            for time in [0.25, 0.75, 1.0, 1.25, 1.875] {
                let expected = still(&project, &dir, time).await;
                let error = mean_difference(expected.as_raw(), &frame_at(&output, time).await);
                assert!(error < 4.0, "{kind} export differs at {time}s: {error}");
            }
            // Between the transitions the clip is untouched.
            let frame = still(&project, &dir, 1.0).await;
            for (x, y) in [(2, 2), (317, 177), (160, 90)] {
                assert!(near(frame.get_pixel(x, y), RED, 16), "{kind} at rest ({x},{y})");
            }
        }
        // Older projects: fadeIn/fadeOut without a transition object still fade.
        let mut clip = layer("red", "v1", 0.0, 2.0);
        clip["fadeIn"] = json!(1.0);
        clip["transitionIn"] = Value::Null;
        let project = composition(vec![red.clone()], vec![clip]);
        assert!(near(still(&project, &dir, 0.5).await.get_pixel(160, 90), HALF, 16));
        assert!(near(still(&project, &dir, 1.5).await.get_pixel(160, 90), RED, 16));
        // A wipe follows the clip's own box when it is scaled and moved.
        let mut clip = layer("red", "v1", 0.0, 2.0);
        clip["transform"]["scale"] = json!(0.5);
        clip["transform"]["x"] = json!(60.0);
        clip["transitionIn"] = json!({"type":"wipeRight","duration":1.0});
        let frame = still(&composition(vec![red], vec![clip]), &dir, 0.5).await;
        // The clip covers x 140..300; half of it (140..220) is revealed.
        assert!(near(frame.get_pixel(180, 90), RED, 16));
        assert!(near(frame.get_pixel(260, 90), NONE, 16));
        assert!(near(frame.get_pixel(100, 90), NONE, 16));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn overlapping_clips_on_one_track_cross_dissolve_with_the_later_one_on_top() {
        let dir = std::env::temp_dir().join(media::id("studio-dissolve-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let media = vec![
            solid(&dir, "red", [255, 0, 0], (320, 180)),
            solid(&dir, "blue", [0, 0, 255], (320, 180)),
            solid(&dir, "green", [0, 255, 0], (320, 180)),
        ];
        // Red plays 0..2 s; blue starts at 1.5 s, half a second into red's end, and
        // dissolves in. Blue is listed first: the start time decides, not the order.
        let mut blue = layer("blue", "v1", 1.5, 2.0);
        blue["fadeIn"] = json!(0.5);
        blue["transitionIn"] = json!({"type":"dissolve","duration":0.5});
        let red = layer("red", "v1", 0.0, 2.0);
        // Two clips starting together: the one listed later is on top.
        let under = layer("red", "v1", 4.0, 1.0);
        let over = layer("green", "v1", 4.0, 1.0);
        let project = composition(media, vec![blue, red, under, over]);
        assert!(near(still(&project, &dir, 1.0).await.get_pixel(160, 90), [255, 0, 0], 16));
        let middle = still(&project, &dir, 1.75).await;
        for (x, y) in [(20, 20), (160, 90), (300, 160)] {
            let pixel = middle.get_pixel(x, y);
            assert!(
                (100..156).contains(&pixel[0]) && pixel[1] < 30 && (100..156).contains(&pixel[2]),
                "the middle of the dissolve must mix both clips: {pixel:?}"
            );
        }
        // A quarter in, red still dominates; three quarters in, blue does.
        let early = still(&project, &dir, 1.625).await;
        assert!(early.get_pixel(160, 90)[0] > early.get_pixel(160, 90)[2] + 60);
        let late = still(&project, &dir, 1.875).await;
        assert!(late.get_pixel(160, 90)[2] > late.get_pixel(160, 90)[0] + 60);
        assert!(near(still(&project, &dir, 2.5).await.get_pixel(160, 90), [0, 0, 255], 16));
        assert!(near(still(&project, &dir, 4.5).await.get_pixel(160, 90), [0, 255, 0], 16));
        // The exported file shows the same mix.
        let output = dir.join("dissolve.mp4");
        run(
            project.clone(),
            json!({"crf":12,"hardware":false}),
            &output,
            "mp4",
            &dir,
            "export-dissolve",
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        let error = mean_difference(middle.as_raw(), &frame_at(&output, 1.75).await);
        assert!(error < 4.0, "export differs from the frame preview: {error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn blend_modes_combine_with_the_picture_below_also_for_moved_translucent_layers() {
        let dir = std::env::temp_dir().join(media::id("studio-blend-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let media = vec![
            solid(&dir, "below", [128, 128, 128], (320, 180)),
            solid(&dir, "above", [100, 200, 50], (320, 180)),
        ];
        let frame_with = |mode: Value, patch: Value| {
            let mut top = layer("above", "v2", 0.0, 1.0);
            if !mode.is_null() {
                top["blendMode"] = mode;
            }
            for (key, value) in patch.as_object().unwrap() {
                top["transform"][key] = value.clone();
            }
            composition(media.clone(), vec![layer("below", "v1", 0.0, 1.0), top])
        };
        for (mode, expected) in [
            ("normal", [100, 200, 50]),
            ("multiply", [50, 100, 25]),
            ("screen", [178, 228, 153]),
            // Over mid grey, overlay returns the layer nearly unchanged.
            ("overlay", [101, 200, 51]),
            ("darken", [100, 128, 50]),
            ("lighten", [128, 200, 128]),
            ("add", [228, 255, 178]),
        ] {
            let frame = still(&frame_with(json!(mode), json!({})), &dir, 0.5).await;
            for (x, y) in [(10, 10), (160, 90), (310, 170)] {
                let pixel = frame.get_pixel(x, y);
                assert!(near(pixel, expected, 8), "{mode}: {pixel:?}, expected {expected:?}");
            }
        }
        // Overlay keys on the picture below: dark below multiplies, bright below screens.
        let mut dark = frame_with(json!("overlay"), json!({}));
        dark["media"][0] = solid(&dir, "dark", [40, 40, 40], (320, 180));
        dark["media"][0]["id"] = json!("below");
        let pixel = *still(&dark, &dir, 0.5).await.get_pixel(160, 90);
        assert!(near(&pixel, [31, 63, 16], 8), "overlay over dark: {pixel:?}");
        // No mode, or one this version does not know, is a normal layer.
        for mode in [Value::Null, json!("future-mode")] {
            let frame = still(&frame_with(mode, json!({})), &dir, 0.5).await;
            assert!(near(frame.get_pixel(160, 90), [100, 200, 50], 8));
        }
        // Half size, moved right, half transparent: the layer covers x 120..280,
        // y 45..135 and mixes half of the multiply result with the picture below.
        let project = frame_with(
            json!("multiply"),
            json!({"scale":0.5,"x":40.0,"opacity":0.5}),
        );
        let frame = still(&project, &dir, 0.5).await;
        for (x, y) in [(130, 55), (200, 90), (270, 125)] {
            let pixel = frame.get_pixel(x, y);
            assert!(near(pixel, [89, 114, 77], 8), "inside the layer: {pixel:?}");
        }
        for (x, y) in [(60, 90), (200, 20), (300, 90), (200, 160)] {
            let pixel = frame.get_pixel(x, y);
            assert!(near(pixel, [128, 128, 128], 5), "outside the layer: {pixel:?}");
        }
        // Rotated: the corners of the layer's bounding box stay untouched.
        let project = frame_with(json!("multiply"), json!({"scale":0.5,"rotation":45.0}));
        let frame = still(&project, &dir, 0.5).await;
        assert!(near(frame.get_pixel(160, 90), [50, 100, 25], 8));
        assert!(near(frame.get_pixel(85, 20), [128, 128, 128], 5));
        // The export blends the same way as the frame preview.
        let project = frame_with(json!("screen"), json!({"scale":0.5,"x":40.0}));
        let expected = still(&project, &dir, 0.5).await;
        let output = dir.join("blend.mp4");
        run(
            project,
            json!({"crf":12,"hardware":false}),
            &output,
            "mp4",
            &dir,
            "export-blend",
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        let error = mean_difference(expected.as_raw(), &frame_at(&output, 0.5).await);
        assert!(error < 4.0, "export differs from the frame preview: {error}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    async fn export(project: &Value, params: Value, dir: &Path, name: &str) -> PathBuf {
        let output = dir.join(format!("{name}.mp4"));
        run(
            project.clone(),
            params,
            &output,
            "mp4",
            dir,
            &format!("export-{name}"),
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        output
    }

    async fn frame_count(path: &Path) -> u64 {
        let probed = Command::new(media::executable("ffprobe"))
            .args(["-v", "error", "-select_streams", "v:0", "-count_frames"])
            .args(["-show_entries", "stream=nb_read_frames", "-of", "csv=p=0"])
            .arg(path)
            .output()
            .await
            .unwrap();
        String::from_utf8_lossy(&probed.stdout).trim().parse().unwrap()
    }

    #[tokio::test]
    async fn a_blended_clip_changes_only_its_own_frames_of_a_longer_timeline() {
        let dir = std::env::temp_dir().join(media::id("studio-blend-span-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let media = vec![
            solid(&dir, "below", [128, 128, 128], (320, 180)),
            solid(&dir, "above", [100, 200, 50], (320, 180)),
            solid(&dir, "badge", [255, 255, 255], (40, 40)),
        ];
        const GREY: [u8; 3] = [128, 128, 128];
        const MULTIPLIED: [u8; 3] = [50, 100, 25];
        // Grey for 3 s; a multiplied layer from 1 s to 2 s; above both, a small white
        // badge from 2.5 s, which has to land on its own frames after the blend.
        let mut top = layer("above", "v2", 1.0, 1.0);
        top["blendMode"] = json!("multiply");
        let mut badge = layer("badge", "v2", 2.5, 0.5);
        badge["transform"]["x"] = json!(-120.0);
        let project = composition(media, vec![layer("below", "v1", 0.0, 3.0), top, badge]);
        let expected = |time: f64| if (1.0..2.0).contains(&time) { MULTIPLIED } else { GREY };
        let times = [0.0, 0.5, 23.0 / 24.0, 1.0, 1.5, 47.0 / 24.0, 2.0, 2.5, 71.0 / 24.0];
        for time in times {
            let frame = still(&project, &dir, time).await;
            let pixel = frame.get_pixel(160, 90);
            assert!(near(pixel, expected(time), 8), "frame at {time}s: {pixel:?}");
        }
        let centre = |raw: &[u8]| image::Rgb([0, 1, 2].map(|c| raw[(90 * 320 + 160) * 3 + c]));
        let badge_at = |raw: &[u8]| image::Rgb([0, 1, 2].map(|c| raw[(90 * 320 + 40) * 3 + c]));
        let output = export(&project, json!({"crf":12,"hardware":false}), &dir, "whole").await;
        assert_eq!(frame_count(&output).await, 72);
        for time in times {
            let raw = frame_at(&output, time).await;
            let pixel = centre(&raw);
            assert!(near(&pixel, expected(time), 10), "export at {time}s: {pixel:?}");
            let white = if time >= 2.5 { [255; 3] } else { expected(time) };
            assert!(near(&badge_at(&raw), white, 10), "badge at {time}s: {:?}", badge_at(&raw));
        }
        // Windows that start inside the clip, end inside it, or miss it altogether.
        for (start, end) in [(1.5, 3.0), (0.5, 1.5), (0.0, 0.75), (2.25, 3.0), (1.25, 1.75)] {
            let name = format!("range-{start}-{end}");
            let params = json!({"crf":12,"hardware":false,"start":start,"end":end});
            let output = export(&project, params, &dir, &name).await;
            let frames = ((end - start) * 24.0_f64).round() as u64;
            assert_eq!(frame_count(&output).await, frames, "{name}");
            for frame in 0..frames {
                let time = frame as f64 / 24.0;
                let pixel = centre(&frame_at(&output, time).await);
                assert!(
                    near(&pixel, expected(start + time), 10),
                    "{name} at {time}s: {pixel:?}"
                );
            }
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn slides_start_and_end_outside_the_frame_for_layers_away_from_the_centre() {
        let dir = std::env::temp_dir().join(media::id("studio-slide-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let red = solid(&dir, "red", [255, 0, 0], (320, 180));
        const RED: [u8; 3] = [255, 0, 0];
        const NONE: [u8; 3] = [0, 0, 0];
        // A quarter-size layer (80 wide) resting at x 220..300 comes in from the left.
        let mut clip = layer("red", "v1", 0.0, 2.0);
        clip["transform"]["scale"] = json!(0.25);
        clip["transform"]["x"] = json!(100.0);
        clip["transitionIn"] = json!({"type":"slideRight","duration":1.0});
        let project = composition(vec![red.clone()], vec![clip.clone()]);
        let frame = still(&project, &dir, 0.0).await;
        for x in [5, 40, 75, 110, 160, 260] {
            assert!(near(frame.get_pixel(x, 90), NONE, 16), "entering, start, x {x}");
        }
        // Halfway it has covered half of the 300 px from x -80..0: it is at 70..150.
        let frame = still(&project, &dir, 0.5).await;
        assert!(near(frame.get_pixel(110, 90), RED, 16));
        assert!(near(frame.get_pixel(40, 90), NONE, 16));
        assert!(near(frame.get_pixel(180, 90), NONE, 16));
        let frame = still(&project, &dir, 1.5).await;
        assert!(near(frame.get_pixel(260, 90), RED, 16));
        assert!(near(frame.get_pixel(200, 90), NONE, 16));
        // The same layer resting at x 20..100 leaves to the left: halfway through it
        // has covered half of the 100 px to x -80..0 and is at -30..50.
        clip["transform"]["x"] = json!(-100.0);
        clip["transitionIn"] = Value::Null;
        clip["transitionOut"] = json!({"type":"slideLeft","duration":1.0});
        let project = composition(vec![red.clone()], vec![clip.clone()]);
        let frame = still(&project, &dir, 1.5).await;
        assert!(near(frame.get_pixel(30, 90), RED, 16));
        assert!(near(frame.get_pixel(70, 90), NONE, 16));
        let frame = still(&project, &dir, 47.0 / 24.0).await;
        assert!(near(frame.get_pixel(20, 90), NONE, 16), "nearly gone");
        // An x keyframe moves the resting place; the slide still starts outside.
        clip["transitionOut"] = Value::Null;
        clip["transitionIn"] = json!({"type":"slideLeft","duration":1.0});
        clip["keyframes"] = json!([
            {"property":"x","time":0,"value":-100},{"property":"x","time":2,"value":100}
        ]);
        let project = composition(vec![red], vec![clip]);
        let frame = still(&project, &dir, 0.0).await;
        for x in [20, 60, 160, 300, 315] {
            assert!(near(frame.get_pixel(x, 90), NONE, 16), "keyframed, start, x {x}");
        }
        // Halfway: resting place -50 (70..150), plus half of the way from the right edge.
        let frame = still(&project, &dir, 0.5).await;
        assert!(near(frame.get_pixel(235, 90), RED, 16));
        assert!(near(frame.get_pixel(110, 90), NONE, 16));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_frame_held_across_dropped_source_frames_shows_in_a_precise_frame() {
        let dir = std::env::temp_dir().join(media::id("studio-dropped-frames-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("dropped.mp4");
        // 30 fps for 20 s without frames 300..304: the average rate is within 1% of
        // 30, and frame 299 stays on screen from 9.967 s to 10.167 s.
        let generated = Command::new(media::executable("ffmpeg"))
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg("nullsrc=s=320x180:r=30:d=20,format=gbrp,geq=r='255*N/600':g='mod(N*40,256)':b=128,select='not(between(n,300,304))'")
            .args(["-fps_mode", "passthrough", "-c:v", "libx264", "-crf", "8", "-pix_fmt", "yuv420p"])
            .arg(&input)
            .output()
            .await
            .unwrap();
        assert!(generated.status.success(), "{}", String::from_utf8_lossy(&generated.stderr));
        assert!(media::constant_frame_rate(&input).await.is_some());
        let source = json!({"id":"dropped","name":"dropped","path":input,"kind":"video",
            "duration":20.0,"width":320,"height":180,"hasAudio":false});
        let mut clip = layer("dropped", "v1", 0.0, 2.0);
        clip["kind"] = json!("video");
        clip["sourceIn"] = json!(9.0);
        let mut project = composition(vec![source], vec![clip]);
        project["fps"] = json!(30);
        let output = export(&project, json!({"crf":8,"hardware":false}), &dir, "whole").await;
        // Clip times 1.0..1.167 fall in the gap.
        for time in [0.9, 1.0, 1.1, 34.0 / 30.0, 1.2, 1.5] {
            let frame = still(&project, &dir, time).await;
            let pixel = frame.get_pixel(160, 90);
            assert!(pixel[0] > 100, "the clip is missing at {time}s: {pixel:?}");
            let error = mean_difference(frame.as_raw(), &frame_at(&output, time).await);
            assert!(error < 4.0, "frame at {time}s differs from the export: {error}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn text_wraps_at_spaces_and_between_cjk_characters_and_keeps_explicit_breaks() {
        // Every character is 10 wide.
        let wrap = |text: &str, width: f32| wrap_text(text, width, &|_| 10.0);
        assert_eq!(wrap("hello world foo", 110.0), ["hello world", "foo"]);
        assert_eq!(wrap("hello world", 60.0), ["hello", "world"]);
        assert_eq!(wrap("one  two", 100.0), ["one  two"]);
        // A word longer than a line breaks between characters.
        assert_eq!(wrap(&"a".repeat(25), 100.0), ["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
        assert_eq!(wrap("hi abcdefghijkl", 50.0), ["hi", "abcde", "fghij", "kl"]);
        // Korean has no spaces to break at: it breaks between characters.
        assert_eq!(wrap("한글은글자단위로줄바꿈", 50.0), ["한글은글자", "단위로줄바", "꿈"]);
        assert_eq!(wrap("가나 abc다라", 40.0), ["가나", "abc다", "라"]);
        assert_eq!(wrap("日本語のテキスト", 30.0), ["日本語", "のテキ", "スト"]);
        // Explicit breaks and empty lines stay; each paragraph wraps on its own.
        assert_eq!(wrap("a\n\nb", 100.0), ["a", "", "b"]);
        assert_eq!(wrap("aaa bbb\nccc ddd eee", 70.0), ["aaa bbb", "ccc ddd", "eee"]);
        assert_eq!(wrap("", 100.0), [""]);
        assert_eq!(wrap("  indented", 100.0), ["  indented"]);
        // Letter spacing counts towards the width, as it does in the browser.
        assert_eq!(wrap_text("abcd efgh", 100.0, &|_| 10.0 + 5.0), ["abcd", "efgh"]);
        // Closing punctuation never starts a line: it takes the character before it along.
        assert_eq!(wrap("안녕하세요, 여러분!", 50.0), ["안녕하세", "요, 여러", "분!"]);
        assert_eq!(wrap("日本語です。次", 50.0), ["日本語で", "す。次"]);
        assert_eq!(wrap("가나다라」마", 40.0), ["가나다", "라」마"]);
        // An opening bracket never ends a line.
        assert_eq!(wrap("가나다「라마", 40.0), ["가나다", "「라마"]);
        assert_eq!(wrap("가나다(라마)", 40.0), ["가나다", "(라마)"]);
        // A hyphen inside a word allows a break after it, but not before a digit.
        assert_eq!(wrap("a well-known fact", 70.0), ["a well-", "known", "fact"]);
        assert_eq!(wrap("well-known", 100.0), ["well-known"]);
        assert_eq!(wrap("abcd x-1 y", 60.0), ["abcd", "x-1 y"]);
        assert_eq!(wrap("abc -de", 60.0), ["abc", "-de"]);
    }

    fn rendered_text(dir: &Path, name: &str, text: Value) -> RgbaImage {
        let path = dir.join(format!("{name}.png"));
        rasterize_text(&json!({"text":text}), 1280, &path).unwrap();
        image::open(&path).unwrap().into_rgba8()
    }
    /// Number, mean x and mean y of the pixels that `pick` selects.
    fn pixels_where(image: &RgbaImage, pick: impl Fn(&Rgba<u8>) -> bool) -> (usize, f64, f64) {
        let found: Vec<(u32, u32)> = image
            .enumerate_pixels()
            .filter(|(_, _, p)| pick(p))
            .map(|(x, y, _)| (x, y))
            .collect();
        let n = found.len().max(1) as f64;
        (
            found.len(),
            found.iter().map(|p| p.0 as f64).sum::<f64>() / n,
            found.iter().map(|p| p.1 as f64).sum::<f64>() / n,
        )
    }

    #[test]
    fn korean_text_styles_are_rasterized() {
        let dir = std::env::temp_dir().join(media::id("studio-text-style-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let base = json!({"content":"한글 자막 Style","fontSize":64,"color":"#ffffff"});
        let with = |patch: Value| {
            let mut text = base.clone();
            for (key, value) in patch.as_object().unwrap() {
                text[key] = value.clone();
            }
            text
        };
        let white = |p: &Rgba<u8>| p[3] > 200 && p[0] > 200 && p[1] > 200 && p[2] > 200;
        let plain = rendered_text(&dir, "plain", base.clone());
        let (ink, ink_x, ink_y) = pixels_where(&plain, white);
        assert!(ink > 2000, "Korean and Latin glyphs must be drawn: {ink}");
        // Without a shadow nothing but the text colour is drawn.
        assert_eq!(pixels_where(&plain, |p| p[3] > 0 && p[0] < 128).0, 0);

        // Letter spacing: 11 characters, 10 px after each.
        let spaced = rendered_text(&dir, "spaced", with(json!({"letterSpacing":10})));
        assert_eq!(spaced.width(), plain.width() + 110);
        assert_eq!(spaced.height(), plain.height());
        let tight = rendered_text(&dir, "tight", with(json!({"letterSpacing":-4})));
        assert_eq!(tight.width(), plain.width() - 44);

        // Line height: the default is 1.2; each line of size 64 grows by 64 * 0.8 at 2.0.
        let two = |patch: Value| {
            let mut text = with(patch);
            text["content"] = json!("한글 첫 줄\n둘째 줄");
            text
        };
        let normal = rendered_text(&dir, "lines", two(json!({})));
        let explicit = rendered_text(&dir, "lines-default", two(json!({"lineHeight":1.2})));
        assert_eq!(normal.as_raw(), explicit.as_raw());
        let loose = rendered_text(&dir, "lines-loose", two(json!({"lineHeight":2.0})));
        let grown = loose.height() as i32 - normal.height() as i32;
        assert!((grown - 102).abs() <= 2, "two lines must grow by 2 * 51 px: {grown}");
        let squeezed = rendered_text(&dir, "lines-tight", two(json!({"lineHeight":0.8})));
        assert!(squeezed.height() < normal.height());
        assert!(
            (pixels_where(&squeezed, white).0 as f64 / pixels_where(&normal, white).0 as f64) > 0.9,
            "tight lines must not clip the glyphs"
        );

        // Italic: the top of the text leans right of its bottom.
        let lean = |image: &RgbaImage| {
            let (_, _, middle) = pixels_where(image, white);
            let top = pixels_where_rows(image, 0.0, middle);
            let bottom = pixels_where_rows(image, middle, f64::MAX);
            top - bottom
        };
        fn pixels_where_rows(image: &RgbaImage, from: f64, to: f64) -> f64 {
            let found: Vec<f64> = image
                .enumerate_pixels()
                .filter(|(_, y, p)| p[3] > 200 && p[0] > 200 && (*y as f64) >= from && (*y as f64) < to)
                .map(|(x, _, _)| x as f64)
                .collect();
            found.iter().sum::<f64>() / found.len().max(1) as f64
        }
        let bars = with(json!({"content":"||||||||"}));
        let mut slanted = bars.clone();
        slanted["italic"] = json!(true);
        let upright = rendered_text(&dir, "upright", bars);
        let italic = rendered_text(&dir, "italic", slanted);
        assert!(lean(&upright).abs() < 1.0, "upright bars lean by {}", lean(&upright));
        assert!(lean(&italic) > 4.0, "italic bars must lean right: {}", lean(&italic));
        assert_eq!(
            rendered_text(&dir, "italic-off", with(json!({"italic":false}))).as_raw(),
            plain.as_raw()
        );

        // Outline: a red ring of the given width around unchanged white glyphs.
        let outlined = rendered_text(
            &dir,
            "outlined",
            with(json!({"outline":{"color":"#ff0000","width":4}})),
        );
        let red = |p: &Rgba<u8>| p[3] > 200 && p[0] > 200 && p[1] < 60 && p[2] < 60;
        assert_eq!(outlined.width(), plain.width() + 8);
        assert_eq!(outlined.height(), plain.height() + 8);
        assert!(pixels_where(&outlined, red).0 > ink / 2);
        let (outlined_ink, x, y) = pixels_where(&outlined, white);
        assert!((outlined_ink as f64 / ink as f64 - 1.0).abs() < 0.02);
        assert!((x - ink_x - 4.0).abs() < 0.5 && (y - ink_y - 4.0).abs() < 0.5);
        // The ring reaches 4 px left of the leftmost glyph pixel and no further.
        let left_edge = |image: &RgbaImage, pick: &dyn Fn(&Rgba<u8>) -> bool| {
            image.enumerate_pixels().filter(|(_, _, p)| pick(p)).map(|(x, _, _)| x).min().unwrap()
        };
        let reach = left_edge(&outlined, &white) as i32 - left_edge(&outlined, &red) as i32;
        assert!((3..=5).contains(&reach), "outline reaches {reach} px");
        let thin = rendered_text(&dir, "thin", with(json!({"outline":{"color":"#ff0000","width":0}})));
        assert_eq!(thin.as_raw(), plain.as_raw());

        // Shadow: the text shape again in the shadow colour, offset; blur softens it.
        let shadow = |blur: u32| {
            rendered_text(
                &dir,
                &format!("shadow-{blur}"),
                with(json!({"shadow":{"color":"#0000ff","x":12,"y":8,"blur":blur}})),
            )
        };
        let blue = |p: &Rgba<u8>| p[3] > 0 && p[2] > 200 && p[0] < 60 && p[1] < 60;
        let hard = shadow(0);
        let (hard_ink, x, y) = pixels_where(&hard, white);
        assert!((hard_ink as f64 / ink as f64 - 1.0).abs() < 0.02, "the shadow lies under the text");
        // The glyph shape drawn in blue at (+12, +8), minus what the text covers.
        let (shadow_pixels, sx, sy) = pixels_where(&hard, blue);
        assert!(shadow_pixels > ink / 3);
        assert!(sx > x + 4.0 && sy > y + 2.0, "shadow at ({sx},{sy}), text at ({x},{y})");
        let offset_copy = hard
            .enumerate_pixels()
            .filter(|(x, y, p)| white(p) && blue_or_white(&hard, x + 12, y + 8))
            .count();
        fn blue_or_white(image: &RgbaImage, x: u32, y: u32) -> bool {
            image.get_pixel_checked(x, y).is_some_and(|p| p[3] > 100 && p[2] > 200)
        }
        assert!(offset_copy as f64 > hard_ink as f64 * 0.98);
        let soft = shadow(12);
        let faint = |p: &Rgba<u8>| p[3] > 8 && p[3] < 128 && p[2] > 200 && p[0] < 60;
        assert!(pixels_where(&soft, faint).0 > pixels_where(&hard, faint).0 * 3 + 500);
        // All sides get the same margin, so the text stays centred in its layer.
        // (Antialiased edges over the shadow are no longer pure white, which moves the
        // measured centre by a fraction of the offset.)
        let (_, x, y) = pixels_where(&soft, white);
        let (dx, dy) = (
            x - soft.width() as f64 / 2.0 - (ink_x - plain.width() as f64 / 2.0),
            y - soft.height() as f64 / 2.0 - (ink_y - plain.height() as f64 / 2.0),
        );
        assert!(dx.abs() < 2.5 && dy.abs() < 2.5, "text moved by ({dx},{dy})");
        assert_eq!((soft.width() - plain.width()) % 2, 0);

        // A background covers the text box, not the margin that holds the effects.
        let boxed = rendered_text(
            &dir,
            "boxed",
            with(json!({"background":"#00ff00","outline":{"color":"#ff0000","width":6}})),
        );
        assert_eq!(boxed.get_pixel(2, 2)[3], 0);
        assert_eq!(boxed.get_pixel(8, 8).0, [0, 255, 0, 255]);

        // A long Korean sentence and long English text wrap inside 90% of the frame.
        for content in ["가나다라마바사아자차카타파하 ".repeat(8), "wrapping words ".repeat(12)] {
            let long = rendered_text(&dir, "long", with(json!({"content":content})));
            assert!(long.width() <= (1280.0_f32 * 0.9) as u32 + 24, "{}", long.width());
            assert!(long.height() > plain.height() * 2);
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn styled_text_reaches_the_rendered_frame() {
        let dir = std::env::temp_dir().join(media::id("studio-text-frame-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let mut clip = layer("", "v1", 0.0, 1.0);
        clip["kind"] = json!("text");
        clip.as_object_mut().unwrap().remove("mediaId");
        clip["text"] = json!({"content":"한글 외곽선","fontSize":40,"color":"#ffffff",
            "italic":true,"letterSpacing":2,"lineHeight":1.5,
            "outline":{"color":"#ff0000","width":3},"shadow":{"color":"#0000ff","x":6,"y":6,"blur":2}});
        let project = composition(vec![], vec![clip]);
        let frame = still(&project, &dir, 0.5).await;
        let count = |pick: &dyn Fn(&image::Rgb<u8>) -> bool| frame.pixels().filter(|p| pick(p)).count();
        assert!(count(&|p| p[0] > 200 && p[1] > 200 && p[2] > 200) > 300, "white text");
        assert!(count(&|p| p[0] > 180 && p[1] < 70 && p[2] < 70) > 300, "red outline");
        assert!(count(&|p| p[2] > 150 && p[0] < 70 && p[1] < 70) > 50, "blue shadow");
        std::fs::remove_dir_all(dir).unwrap();
    }

    async fn stream_info(path: &Path) -> Value {
        let probed = Command::new(media::executable("ffprobe"))
            .args(["-v", "error", "-select_streams", "v:0", "-show_entries"])
            .arg("stream=codec_name,codec_tag_string,width,height,bit_rate,pix_fmt")
            .args(["-of", "json"])
            .arg(path)
            .output()
            .await
            .unwrap();
        assert!(probed.status.success());
        serde_json::from_slice::<Value>(&probed.stdout).unwrap()["streams"][0].clone()
    }

    #[tokio::test]
    async fn export_codec_hardware_and_bitrate_options_produce_the_requested_stream() {
        let dir = std::env::temp_dir().join(media::id("studio-encoder-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("moving.mp4");
        let generated = Command::new(media::executable("ffmpeg"))
            .args(["-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=640x360:r=30:d=3"])
            .args(["-c:v", "libx264", "-crf", "12", "-pix_fmt", "yuv420p"])
            .arg(&input)
            .output()
            .await
            .unwrap();
        assert!(generated.status.success());
        let root = dir.join("state");
        let mut e = crate::editor::Editor::new(root.clone()).unwrap();
        e.dispatch("project.update", json!({"patch":{"width":640,"height":360,"fps":30}}))
            .await
            .unwrap();
        let project = e
            .dispatch("media.importAndAdd", json!({"paths":[input]}))
            .await
            .unwrap();
        let jobs = RenderJobs::default();
        let export = async |name: &str, options: Value| -> (Value, Value, u64) {
            let path = dir.join(name);
            let mut params = json!({"path":path,"format":path.extension().unwrap().to_str().unwrap()});
            for (key, value) in options.as_object().unwrap() {
                params[key] = value.clone();
            }
            let job = jobs.start(project.clone(), params, root.clone()).await.unwrap();
            let status = finish(&jobs, &job).await;
            assert_eq!(status["state"], "completed", "{name}: {status}");
            let size = std::fs::metadata(&path).unwrap().len();
            (status, stream_info(&path).await, size)
        };
        // Default: hardware when this machine really has it, software otherwise.
        let hardware = encoder_works("h264_videotoolbox").await;
        let (status, stream, _) = export("default.mp4", json!({})).await;
        assert_eq!(
            status["encoder"],
            if hardware { "h264_videotoolbox" } else { "libx264" }
        );
        assert_eq!(stream["codec_name"], "h264");
        assert_eq!((stream["width"].as_u64(), stream["height"].as_u64()), (Some(640), Some(360)));
        assert_eq!(stream["pix_fmt"], "yuv420p");
        // The picture of the hardware file is the same picture.
        let (status, _, _) = export("software.mp4", json!({"hardware":false,"crf":14})).await;
        assert_eq!(status["encoder"], "libx264");
        let (_, _, _) = export("hardware.mp4", json!({"hardware":true,"crf":14})).await;
        for time in [0.5, 1.5, 2.5] {
            let error = mean_difference(
                &frame_at(&dir.join("software.mp4"), time).await,
                &frame_at(&dir.join("hardware.mp4"), time).await,
            );
            assert!(error < 6.0, "hardware and software exports differ at {time}s: {error}");
        }
        // HEVC, software and (where available) hardware, tagged for QuickTime.
        let (status, stream, _) = export("hevc.mp4", json!({"codec":"hevc","hardware":false})).await;
        assert_eq!(status["encoder"], "libx265");
        assert_eq!(stream["codec_name"], "hevc");
        assert_eq!(stream["codec_tag_string"], "hvc1");
        let (status, stream, _) = export("hevc.mov", json!({"codec":"hevc"})).await;
        assert_eq!(
            status["encoder"],
            if encoder_works("hevc_videotoolbox").await { "hevc_videotoolbox" } else { "libx265" }
        );
        assert_eq!(stream["codec_name"], "hevc");
        assert_eq!(stream["codec_tag_string"], "hvc1");
        let (_, stream, _) = export("h264.mov", json!({"codec":"h264","hardware":false})).await;
        assert_eq!(stream["codec_name"], "h264");
        // A bitrate replaces the quality setting.
        let rate = |stream: &Value| stream["bit_rate"].as_str().unwrap().parse::<f64>().unwrap() / 1000.0;
        let (_, low, low_size) = export("low.mp4", json!({"bitrate":400,"hardware":false})).await;
        let (_, high, high_size) = export("high.mp4", json!({"bitrate":3000,"hardware":false})).await;
        assert!((250.0..600.0).contains(&rate(&low)), "400 kbps asked, {} made", rate(&low));
        assert!((2000.0..4000.0).contains(&rate(&high)), "3000 kbps asked, {} made", rate(&high));
        assert!(high_size > low_size * 3);
        let (_, low, _) = export("low-hw.mp4", json!({"bitrate":400})).await;
        let (_, high, _) = export("high-hw.mp4", json!({"bitrate":3000})).await;
        assert!(rate(&high) > rate(&low) * 2.0, "{} vs {}", rate(&high), rate(&low));
        let (_, _, low_size) = export("low.webm", json!({"bitrate":300})).await;
        let (_, _, high_size) = export("high.webm", json!({"bitrate":3000})).await;
        assert!(high_size > low_size * 2);
        // Options that cannot be honoured are refused before any work starts.
        for (options, format) in [
            (json!({"codec":"av1"}), "mp4"),
            (json!({"codec":"hevc"}), "webm"),
            (json!({"bitrate":5}), "mp4"),
            (json!({"bitrate":"fast"}), "mp4"),
            (json!({"hardware":"yes"}), "mp4"),
        ] {
            let mut params = json!({"path":dir.join(format!("refused.{format}")),"format":format});
            for (key, value) in options.as_object().unwrap() {
                params[key] = value.clone();
            }
            assert!(
                jobs.start(project.clone(), params, root.clone()).await.is_err(),
                "{options} must be refused"
            );
        }
        assert!(!dir.join("refused.mp4").exists() && !dir.join("refused.webm").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[tokio::test]
    async fn a_failing_hardware_encoder_falls_back_to_software() {
        let dir = std::env::temp_dir().join(media::id("studio-fallback-test"));
        std::fs::create_dir_all(&dir).unwrap();
        let project = composition(
            vec![solid(&dir, "red", [255, 0, 0], (320, 180))],
            vec![layer("red", "v1", 0.0, 0.5)],
        );
        let states = Arc::new(Mutex::new(HashMap::from([(
            "job".to_string(),
            json!({"id":"job","state":"running","progress":0.0}),
        )])));
        let output = dir.join("fallback.mp4");
        let scratch = dir.join("scratch");
        std::fs::create_dir_all(&scratch).unwrap();
        // The first encoder does not exist, as a hardware encoder that stops working.
        run_encoders(
            &project,
            &json!({}),
            &output,
            "mp4",
            &scratch,
            "job",
            states.clone(),
            Arc::new(AtomicBool::new(false)),
            &["h264_missing_hardware", "libx264"],
        )
        .await
        .unwrap();
        assert_eq!(states.lock().unwrap()["job"]["encoder"], "libx264");
        assert_eq!(stream_info(&output).await["codec_name"], "h264");
        assert!(frame_at(&output, 0.25).await[0] > 200);
        // With nothing left to fall back to, the error is reported and no file stays.
        let failed = run_encoders(
            &project,
            &json!({}),
            &output,
            "mp4",
            &scratch,
            "job",
            states.clone(),
            Arc::new(AtomicBool::new(false)),
            &["h264_missing_hardware"],
        )
        .await;
        assert!(failed.is_err());
        assert!(!output.exists());
        // A cancelled export is not retried with another encoder.
        let cancelled = run_encoders(
            &project,
            &json!({}),
            &output,
            "mp4",
            &scratch,
            "job",
            states.clone(),
            Arc::new(AtomicBool::new(true)),
            &["h264_missing_hardware", "libx264"],
        )
        .await;
        assert!(cancelled.unwrap_err().contains("취소"));
        assert_eq!(states.lock().unwrap()["job"]["encoder"], "h264_missing_hardware");
        assert!(!encoder_works("h264_missing_hardware").await);
        assert!(encoder_works("libx264").await);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// Prints real timings; run with
    /// `cargo test --lib -- render::tests::performance_report --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn performance_report() {
        let dir = std::env::temp_dir().join(media::id("studio-perf"));
        std::fs::create_dir_all(&dir).unwrap();
        let make = |args: Vec<String>, output: PathBuf| async move {
            let made = Command::new(media::executable("ffmpeg"))
                .args(["-y", "-v", "error"])
                .args(args)
                .arg(&output)
                .output()
                .await
                .unwrap();
            assert!(made.status.success(), "{}", String::from_utf8_lossy(&made.stderr));
        };
        let source = |size: &str, seconds: u32| -> Vec<String> {
            format!("-f lavfi -i testsrc2=s={size}:r=30:d={seconds} -f lavfi -i sine=frequency=440:sample_rate=48000:duration={seconds} -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac -shortest")
                .split(' ')
                .map(String::from)
                .collect()
        };
        let hd = dir.join("hd.mp4");
        let uhd = dir.join("uhd.mp4");
        make(source("1920x1080", 60), hd.clone()).await;
        make(source("3840x2160", 10), uhd.clone()).await;
        let timed = |project: Value, params: Value, root: PathBuf| async move {
            let started = std::time::Instant::now();
            preview_frame(&project, &params, &root).await.unwrap();
            started.elapsed().as_secs_f64()
        };
        // Thirty 2 s cuts of a 1080p source plus a caption over the last ten seconds.
        let mut e = crate::editor::Editor::new(dir.join("hd-state")).unwrap();
        let p = e.dispatch("media.import", json!({"paths":[hd]})).await.unwrap();
        for index in 0..30 {
            e
                .dispatch("edit.add", json!({"mediaId":p["media"][0]["id"],"start":index as f64 * 2.0,"duration":2.0}))
                .await
                .unwrap();
        }
        let project = e
            .dispatch("edit.add", json!({"text":{"content":"성능 측정 자막","fontSize":64},"start":50.0,"duration":10.0}))
            .await
            .unwrap();
        let root = dir.join("hd-state");
        for width in [640, 1920] {
            let mut times = vec![];
            for time in [58.5, 57.25, 55.1] {
                times.push(timed(project.clone(), json!({"time":time,"width":width}), root.clone()).await);
            }
            println!("PERF 1080p 30-clip timeline, late frame, width {width}: {times:.3?} s");
        }
        let jobs = RenderJobs::default();
        for (label, extra) in [
            ("software h264", json!({"hardware":false})),
            ("hardware h264", json!({"hardware":true})),
            ("software hevc", json!({"hardware":false,"codec":"hevc"})),
            ("hardware hevc", json!({"hardware":true,"codec":"hevc"})),
        ] {
            let output = dir.join(format!("{}.mp4", label.replace(' ', "-")));
            let mut params = json!({"path":output,"format":"mp4","start":0.0,"end":30.0});
            for (key, value) in extra.as_object().unwrap() {
                params[key] = value.clone();
            }
            let started = std::time::Instant::now();
            let job = jobs.start(project.clone(), params, root.clone()).await.unwrap();
            let status = finish(&jobs, &job).await;
            println!(
                "PERF 30 s 1080p export, {label}: {:.2} s ({}, encoder {}, {} bytes)",
                started.elapsed().as_secs_f64(),
                status["state"],
                status["encoder"],
                std::fs::metadata(&output).map(|m| m.len()).unwrap_or(0)
            );
        }
        // The same half minute with a one second wipe into every clip.
        let mut wiped = project.clone();
        for clip in wiped["clips"].as_array_mut().unwrap() {
            if clip["kind"] == "video" {
                clip["transitionIn"] = json!({"type":"wipeRight","duration":1.0});
            }
        }
        let output = dir.join("wipes.mp4");
        let started = std::time::Instant::now();
        run(
            wiped,
            json!({"start":0.0,"end":30.0}),
            &output,
            "mp4",
            &root,
            "export-wipes",
            Arc::new(Mutex::new(HashMap::new())),
            Arc::new(AtomicBool::new(false)),
        )
        .await
        .unwrap();
        println!(
            "PERF 30 s 1080p export with 15 one-second wipes: {:.2} s",
            started.elapsed().as_secs_f64()
        );
        let mut e = crate::editor::Editor::new(dir.join("uhd-state")).unwrap();
        e.dispatch("project.update", json!({"patch":{"width":3840,"height":2160}})).await.unwrap();
        let project = e
            .dispatch("media.importAndAdd", json!({"paths":[uhd]}))
            .await
            .unwrap();
        let root = dir.join("uhd-state");
        let mut times = vec![];
        for time in [5.5, 8.2, 1.3] {
            times.push(timed(project.clone(), json!({"time":time,"width":1280}), root.clone()).await);
        }
        println!("PERF 4K source, one frame, width 1280: {times:.3?} s");
        let started = std::time::Instant::now();
        let proxy = media::build_proxy(&root, &project["media"][0], Arc::new(AtomicBool::new(false)))
            .await
            .unwrap();
        println!(
            "PERF proxy of a 10 s 4K source: {:.2} s ({} bytes)",
            started.elapsed().as_secs_f64(),
            std::fs::metadata(proxy).unwrap().len()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
