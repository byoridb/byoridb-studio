use crate::{
    editor::{number, string, valid_color, validate_project},
    media,
};
use fontdue::Font;
use image::{Rgba, RgbaImage};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command,
};

#[derive(Default)]
pub struct RenderJobs {
    states: Arc<Mutex<HashMap<String, Value>>>,
    cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl RenderJobs {
    pub async fn start(
        &self,
        project: Value,
        params: Value,
        root: PathBuf,
    ) -> Result<Value, String> {
        validate_project(&project)?;
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
        let id = media::id("export");
        let cancel = Arc::new(AtomicBool::new(false));
        self.states.lock().unwrap().insert(id.clone(),json!({"id":id,"state":"queued","progress":0.0,"path":output,"projectRevision":project["revision"]}));
        self.cancels
            .lock()
            .unwrap()
            .insert(id.clone(), cancel.clone());
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
    validate_project(project)?;
    let duration = project_duration(project);
    let requested_time = number(params, "time", 0.0);
    if duration <= 0.0
        || !requested_time.is_finite()
        || requested_time < 0.0
        || requested_time >= duration
    {
        return Err("타임라인 내부의 미리보기 위치를 선택해 주세요.".into());
    }
    let time =
        (requested_time * number(project, "fps", 30.0)).floor() / number(project, "fps", 30.0);
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
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    let _ = std::fs::remove_dir_all(temp);
    result?;
    Ok(
        json!({"path":output,"width":width,"height":height,"time":time,"revision":project["revision"]}),
    )
}

fn property_alias(property: &str) -> &str {
    property.strip_prefix("transform.").unwrap_or(property)
}

fn expression(c: &Value, property: &str, default: f64, time: &str) -> String {
    let mut frames: Vec<(f64, f64)> = c["keyframes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|k| property_alias(string(k, "property", "")) == property_alias(property))
        .map(|k| (number(k, "time", 0.0), number(k, "value", default)))
        .collect();
    frames.sort_by(|a, b| a.0.total_cmp(&b.0));
    frames.dedup_by(|a, b| a.0 == b.0);
    if frames.is_empty() {
        return format!("{default:.6}");
    }
    if frames[0].0 > 0.0 {
        frames.insert(0, (0.0, default));
    }
    let mut expr = format!("{:.6}", frames.last().unwrap().1);
    for pair in frames.windows(2).rev() {
        let (a, b) = (pair[0], pair[1]);
        let linear = format!(
            "{:.6}+({:.6})*(({time})-{:.6})/{:.6}",
            a.1,
            b.1 - a.1,
            a.0,
            (b.0 - a.0).max(0.00001)
        );
        expr = format!("if(lt({time},{:.6}),{linear},{expr})", b.0);
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
    let result = run_process(
        &project,
        &params,
        &temp_output,
        format,
        &temp_dir,
        id,
        states,
        cancel,
    )
    .await;
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

async fn run_process(
    p: &Value,
    params: &Value,
    output: &Path,
    format: &str,
    temp: &Path,
    id: &str,
    states: Arc<Mutex<HashMap<String, Value>>>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let duration = project_duration(p);
    let start = number(params, "start", 0.0);
    let end = number(params, "end", duration);
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
        "-filter_complex_threads",
        "1",
    ]);
    let mut graph = vec![
        format!(
            "color=c={}:s={}x{}:r={fps}:d={duration}[base]",
            string(p, "background", "#111111").replace('#', "0x"),
            pw as u32,
            ph as u32
        ),
        format!("anullsrc=r=48000:cl=stereo,atrim=duration={duration}[silence]"),
    ];
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
            let audible = track["muted"] != true
                && kind != "text"
                && kind != "image"
                && asset.is_some_and(|a| a["hasAudio"] == true)
                && (number(clip, "volume", 1.0) > 0.0 || has_keyframe(clip, "volume"));
            if !visible && !audible {
                continue;
            }
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
                    &length.to_string(),
                ]);
            } else {
                command.args([
                    "-ss",
                    &source.to_string(),
                    "-t",
                    &(length * speed).to_string(),
                ]);
            }
            command.arg("-i").arg(&path);
            let idx = input_index;
            input_index += 1;
            if visible {
                let rev = if clip["reverse"] == true && kind == "video" {
                    "reverse,"
                } else {
                    ""
                };
                let mut filters =
                    format!("[{idx}:v]{rev}setpts=(PTS-STARTPTS)/{speed},fps={fps},format=rgba");
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
                if kind != "text" {
                    if clip.get("crop").is_some() {
                        let crop = &clip["crop"];
                        filters.push_str(&format!(",crop=w='max(2,trunc(iw*{}/2)*2)':h='max(2,trunc(ih*{}/2)*2)':x='iw*{}':y='ih*{}'",number(crop,"width",1.0),number(crop,"height",1.0),number(crop,"x",0.0),number(crop,"y",0.0)));
                    }
                    filters.push_str(&format!(
                        ",scale=w={}:h={}:force_original_aspect_ratio=decrease",
                        pw as u32, ph as u32
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
                }
                append_color_filters(&mut filters, &clip["color"], temp, idx)?;
                let transform = &clip["transform"];
                if transform["flipX"] == true {
                    filters.push_str(",hflip");
                }
                if transform["flipY"] == true {
                    filters.push_str(",vflip");
                }
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
                    filters.push_str(&format!(",format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({factor})'"));
                }
                let scale = expression(clip, "scale", number(transform, "scale", 1.0), "t");
                filters.push_str(&format!(",scale=w='max(2,trunc(iw*({scale})/2)*2)':h='max(2,trunc(ih*({scale})/2)*2)':eval=frame,format=rgba"));
                let rotate = expression(clip, "rotation", number(transform, "rotation", 0.0), "t");
                if number(transform, "rotation", 0.0).abs() > 0.001
                    || has_keyframe(clip, "rotation")
                {
                    filters.push_str(&format!(",rotate=angle='({rotate})*PI/180':ow='hypot(iw,ih)':oh='hypot(iw,ih)':c=none"));
                }
                let opacity = expression(clip, "opacity", number(transform, "opacity", 1.0), "T");
                if has_keyframe(clip, "opacity") {
                    filters.push_str(&format!(
                        ",geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='alpha(X,Y)*({opacity})'"
                    ));
                } else if number(transform, "opacity", 1.0) < 0.9999 {
                    filters.push_str(&format!(
                        ",colorchannelmixer=aa={}",
                        number(transform, "opacity", 1.0)
                    ));
                }
                let fade_in = number(clip, "fadeIn", 0.0).min(length);
                let fade_out = number(clip, "fadeOut", 0.0).min(length);
                if fade_in > 0.0 {
                    filters.push_str(&format!(",fade=t=in:st=0:d={fade_in}:alpha=1"));
                }
                if fade_out > 0.0 {
                    filters.push_str(&format!(
                        ",fade=t=out:st={}:d={fade_out}:alpha=1",
                        length - fade_out
                    ));
                }
                filters.push_str(&format!(
                    ",trim=duration={length},setpts=PTS-STARTPTS+{position}/TB[v{idx}]"
                ));
                graph.push(filters);
                let x = expression(
                    clip,
                    "x",
                    number(transform, "x", 0.0),
                    &format!("t-{position}"),
                );
                let y = expression(
                    clip,
                    "y",
                    number(transform, "y", 0.0),
                    &format!("t-{position}"),
                );
                graph.push(format!("[{video_label}][v{idx}]overlay=x='(W-w)/2+({x})':y='(H-h)/2+({y})':eof_action=pass:repeatlast=0:enable='gte(t,{position})*lt(t,{})'[mix{idx}]",position+length));
                video_label = format!("mix{idx}");
            }
            if audible {
                let reverse = if clip["reverse"] == true {
                    "areverse,"
                } else {
                    ""
                };
                let volume = expression(clip, "volume", number(clip, "volume", 1.0), "t");
                let mut a=format!("[{idx}:a]{reverse}asetpts=PTS-STARTPTS,{},aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume='{volume}':eval=frame",tempo_chain(speed));
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
                    ",atrim=duration={length},adelay=delays={}:all=1[a{idx}]",
                    (position * 1000.0).round() as u64
                ));
                graph.push(a);
                audio_labels.push(format!("a{idx}"));
            }
        }
    }
    if audio_only {
        graph.push(format!("[{video_label}]nullsink"));
    } else {
        graph.push(format!("[{video_label}]trim=start={start}:end={end},setpts=PTS-STARTPTS,scale={width}:{height},setsar=1,format=yuv420p[vout]"));
    }
    graph.push(format!("{}amix=inputs={}:normalize=0:dropout_transition=0,alimiter=limit=0.98:latency=1,atrim=start={start}:end={end},asetpts=PTS-STARTPTS{}",audio_labels.iter().map(|s|format!("[{s}]")).collect::<String>(),audio_labels.len(),if still{",anullsink"}else{"[aout]"}));
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
            command.args([
                "-c:v",
                "libx264",
                "-preset",
                if params["preview"] == true {
                    "ultrafast"
                } else {
                    "fast"
                },
                "-crf",
                &number(params, "crf", 23.0).to_string(),
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-movflags",
                "+faststart",
            ]);
        }
        "webm" => {
            command.args([
                "-c:v",
                "libvpx-vp9",
                "-crf",
                &number(params, "crf", 28.0).to_string(),
                "-b:v",
                "0",
                "-c:a",
                "libopus",
                "-b:a",
                "160k",
            ]);
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
            &(end - start).to_string(),
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
    let stderr_task = tokio::spawn(async move {
        let mut bytes = vec![];
        let _ = stderr.take(65536).read_to_end(&mut bytes).await;
        String::from_utf8_lossy(&bytes).to_string()
    });
    let mut lines = BufReader::new(stdout).lines();
    let mut reading = true;
    let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
    let status = loop {
        tokio::select! {
            status=child.wait()=>break status.map_err(|e|e.to_string())?,
            line=lines.next_line(),if reading=>match line {Ok(Some(line))=>{if let Some(n)=line.strip_prefix("out_time_us=").and_then(|s|s.parse::<f64>().ok()){update(&states,id,"running",(n/1_000_000.0/(end-start)).clamp(0.0,0.99),None);}},_=>reading=false},
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
    filters.push_str(&format!(
        ",eq=brightness={}:contrast={}:saturation={}",
        number(color, "brightness", 0.0),
        number(color, "contrast", 1.0),
        number(color, "saturation", 1.0)
    ));
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
    for (i, part) in s[1..].as_bytes().chunks(2).enumerate() {
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

fn rasterize_text(clip: &Value, canvas_width: u32, path: &Path) -> Result<(), String> {
    let text = &clip["text"];
    let content = string(text, "content", "");
    let size = number(text, "fontSize", 64.0) as f32;
    let bold = text["bold"] == true;
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
    let max_width = canvas_width as f32 * 0.9;
    let mut lines: Vec<String> = vec![];
    for line in content.split('\n') {
        let mut current = String::new();
        let mut width = 0.0;
        for ch in line.chars() {
            let advance = select_font(ch).metrics(ch, size).advance_width;
            if width + advance > max_width && !current.is_empty() {
                lines.push(current);
                current = String::new();
                width = 0.0;
            }
            current.push(ch);
            width += advance;
        }
        lines.push(current);
    }
    let widths: Vec<f32> = lines
        .iter()
        .map(|line| {
            line.chars()
                .map(|ch| select_font(ch).metrics(ch, size).advance_width)
                .sum()
        })
        .collect();
    let metrics = font
        .horizontal_line_metrics(size)
        .ok_or("글꼴 높이를 읽을 수 없습니다.")?;
    let line_height = metrics.new_line_size.max(size * 1.2);
    let padding = 12 + synthetic_weight as u32;
    let width = (widths.iter().copied().fold(0.0, f32::max).ceil() as u32 + padding * 2).max(2);
    let height = (line_height * lines.len() as f32).ceil() as u32 + padding * 2;
    if height > 16384 {
        return Err("텍스트가 너무 길어 이미지로 만들 수 없습니다.".into());
    }
    let bg = rgba(string(text, "background", "transparent"), [0, 0, 0, 0]);
    let fg = rgba(string(text, "color", "#ffffff"), [255, 255, 255, 255]);
    let mut image = RgbaImage::from_pixel(width, height, Rgba(bg));
    for (i, line) in lines.iter().enumerate() {
        let mut pen = match string(text, "align", "center") {
            "left" => padding as f32,
            "right" => width as f32 - padding as f32 - widths[i],
            _ => (width as f32 - widths[i]) / 2.0,
        };
        let baseline = padding as f32 + metrics.ascent + i as f32 * line_height;
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
                for col in 0..bitmap_width {
                    let alpha = bitmap[row * bitmap_width + col];
                    if alpha == 0 {
                        continue;
                    }
                    let px = x + col as i32;
                    let py = y + row as i32;
                    blend_pixel(&mut image, px + 2, py + 2, [0, 0, 0, 160], alpha);
                }
            }
            for row in 0..m.height {
                for col in 0..bitmap_width {
                    blend_pixel(
                        &mut image,
                        x + col as i32,
                        y + row as i32,
                        fg,
                        bitmap[row * bitmap_width + col],
                    );
                }
            }
            pen += m.advance_width;
        }
    }
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
        assert!(imported["media"][0]["waveform"].as_array().unwrap().len() > 20);
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
}
