use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::{io::AsyncReadExt, process::Command};

const PROBE_TIMEOUT: Duration = Duration::from_secs(20);
const THUMBNAIL_TIMEOUT: Duration = Duration::from_secs(30);
/// `probe` may run while the editor is locked, so its decoding is cut off early; the
/// part of a very long or slow file decoded by then is kept.
const WAVEFORM_TIMEOUT: Duration = Duration::from_secs(15);
/// `waveform` runs in the background, outside any lock, and may take its time.
const BACKGROUND_WAVEFORM_TIMEOUT: Duration = Duration::from_secs(600);
const FRAME_TIMEOUT: Duration = Duration::from_secs(30);
/// Proxies are at most this long on their longer side.
const PROXY_SIZE: u32 = 1280;
/// Codecs a browser plays smoothly from the original file.
const LIGHT_CODECS: [&str; 4] = ["h264", "vp8", "vp9", "av1"];
const WAVEFORM_RATE: usize = 8000;

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn id(prefix: &str) -> String {
    format!("{}-{}", prefix, uuid::Uuid::new_v4())
}

pub fn executable(name: &str) -> PathBuf {
    let custom = std::env::var(format!("BYORI_{}", name.to_uppercase())).ok();
    if let Some(path) = custom {
        return PathBuf::from(path);
    }
    for dir in std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect::<Vec<_>>())
        .unwrap_or_default()
        .into_iter()
        .chain([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            PathBuf::from("/usr/bin"),
        ])
    {
        let path = dir.join(name);
        if path.is_file() {
            return path;
        }
    }
    PathBuf::from(name)
}

fn numeric(value: Option<&Value>) -> f64 {
    value
        .and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .unwrap_or(0.0)
}

fn playable_video(stream: &Value) -> bool {
    stream["codec_type"] == "video"
        && !["attached_pic", "timed_thumbnails", "timed_thumbnail"]
            .iter()
            .any(|key| {
                stream["disposition"][*key] == true
                    || numeric(stream["disposition"].get(*key)) != 0.0
            })
}

/// Runs a helper process to completion, killing it when it exceeds `limit`.
async fn output_within(
    command: &mut Command,
    limit: Duration,
) -> std::io::Result<std::process::Output> {
    command
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    match tokio::time::timeout(limit, command.output()).await {
        Ok(result) => result,
        Err(_) => Err(std::io::Error::new(
            std::io::ErrorKind::TimedOut,
            format!("{}초 안에 응답하지 않았습니다", limit.as_secs_f64()),
        )),
    }
}

/// Peak buckets cover the whole file: 8 per second, between 128 and 1024.
fn waveform_buckets(duration: f64) -> usize {
    ((duration * 8.0).ceil() as usize).clamp(128, 1024)
}

/// Reads 16-bit mono samples until EOF or `limit` and keeps one peak per bucket, so
/// memory stays bounded regardless of the file length. Returns the peaks read so far
/// and whether the stream ended in time.
async fn read_peaks<R: tokio::io::AsyncRead + Unpin>(
    mut reader: R,
    duration: f64,
    limit: Duration,
) -> (Vec<u16>, bool) {
    let buckets = waveform_buckets(duration);
    let per_bucket = ((duration * WAVEFORM_RATE as f64 / buckets as f64).ceil() as usize).max(1);
    let mut peaks = Vec::with_capacity(buckets);
    let (mut peak, mut count) = (0u16, 0usize);
    let read = async {
        let mut buffer = vec![0u8; 64 * 1024];
        let mut pending: Option<u8> = None;
        loop {
            let n = match reader.read(&mut buffer).await {
                Ok(0) => return true,
                Ok(n) => n,
                Err(_) => return false,
            };
            let mut bytes = buffer[..n].iter().copied();
            while let Some(low) = pending.take().or_else(|| bytes.next()) {
                let Some(high) = bytes.next() else {
                    pending = Some(low);
                    break;
                };
                peak = peak.max(i16::from_le_bytes([low, high]).unsigned_abs());
                count += 1;
                if count == per_bucket && peaks.len() < buckets {
                    peaks.push(peak);
                    (peak, count) = (0, 0);
                }
            }
        }
    };
    let complete = tokio::time::timeout(limit, read).await.unwrap_or(false);
    // A trailing partial bucket is kept unless it is negligible rounding residue.
    if peaks.len() < buckets && count * 2 >= per_bucket {
        peaks.push(peak);
    }
    (peaks, complete)
}

/// Decodes the audio stream at 8 kHz mono into exactly `waveform_buckets(duration)`
/// peaks spanning the media duration. Audio shorter than the container, or decoding
/// stopped by the time limit, leaves the remaining buckets at zero so peaks never
/// stretch along the timeline.
async fn decode_waveform(path: &Path, duration: f64, limit: Duration) -> Option<Vec<f32>> {
    let mut child = Command::new(executable("ffmpeg"))
        .args(["-v", "error", "-nostdin", "-i"])
        .arg(path)
        .args([
            "-vn",
            "-sn",
            "-dn",
            "-ac",
            "1",
            "-ar",
            &WAVEFORM_RATE.to_string(),
        ])
        .args(["-f", "s16le", "pipe:1"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (mut peaks, complete) = read_peaks(stdout, duration, limit).await;
    if complete {
        if !child.wait().await.ok()?.success() {
            return None;
        }
    } else {
        let _ = child.kill().await;
        if peaks.is_empty() {
            return None;
        }
    }
    peaks.resize(waveform_buckets(duration), 0);
    Some(
        peaks
            .into_iter()
            .map(|p| ((p as f32 / 32768.0).min(1.0) * 1000.0).round() / 1000.0)
            .collect(),
    )
}

/// The peaks of a media file's sound, for filling `Media.waveform` in the background.
/// Touches no editor state. `None` when the file has no decodable audio.
pub async fn waveform(path: &Path, duration: f64) -> Option<Vec<f32>> {
    decode_waveform(path, duration, BACKGROUND_WAVEFORM_TIMEOUT).await
}

/// Probes a file, makes its thumbnail and decodes its waveform (bounded to 15 s of
/// work). Callers that hold a lock use `probe_info` and compute `waveform` later.
pub async fn probe(path: &Path, root: &Path) -> Result<Value, String> {
    let mut asset = probe_info(path, root).await?;
    let waveform = if asset["hasAudio"] == true {
        decode_waveform(
            Path::new(asset["path"].as_str().unwrap_or_default()),
            numeric(asset.get("duration")),
            WAVEFORM_TIMEOUT,
        )
        .await
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    asset["waveform"] = json!(waveform);
    Ok(asset)
}

/// Whether the stream is stored sideways: phones record portrait video as landscape
/// frames plus a 90° or 270° rotation, which FFmpeg applies when decoding.
fn stored_sideways(stream: &Value) -> bool {
    let rotation = stream["side_data_list"]
        .as_array()
        .into_iter()
        .flatten()
        .find_map(|data| data.get("rotation"))
        .or_else(|| stream["tags"].get("rotate"));
    (numeric(rotation).round() as i64).rem_euclid(180) == 90
}

/// "30000/1001" or "25" as frames per second.
fn frame_rate(value: Option<&Value>) -> Option<f64> {
    let text = value?.as_str()?;
    let (n, d) = text.split_once('/').unwrap_or((text, "1"));
    let rate = n.parse::<f64>().ok()? / d.parse::<f64>().ok()?;
    (rate.is_finite() && rate > 0.0 && rate <= 1000.0).then_some(rate)
}

/// The frame rate of a file's video when it is constant, for callers that need to
/// know how far apart its frames are. `None` for variable or unreadable material.
/// Remembered per file until the file changes.
pub async fn constant_frame_rate(path: &Path) -> Option<f64> {
    // Per file: its size and modification time when probed, and the rate found.
    type Known = std::collections::HashMap<PathBuf, ((u64, Option<SystemTime>), Option<f64>)>;
    static KNOWN: std::sync::OnceLock<std::sync::Mutex<Known>> = std::sync::OnceLock::new();
    let info = std::fs::metadata(path).ok()?;
    let stamp = (info.len(), info.modified().ok());
    let known = KNOWN.get_or_init(Default::default);
    if let Some((seen, rate)) = known.lock().unwrap().get(path) {
        if *seen == stamp {
            return *rate;
        }
    }
    let output = output_within(
        Command::new(executable("ffprobe"))
            .args(["-v", "error", "-select_streams", "v:0"])
            .args([
                "-show_entries",
                "stream=r_frame_rate,avg_frame_rate",
                "-of",
                "json",
            ])
            .arg(path),
        PROBE_TIMEOUT,
    )
    .await
    .ok()?;
    let info: Value = serde_json::from_slice(&output.stdout).ok()?;
    let stream = &info["streams"][0];
    let rate = match (
        frame_rate(stream.get("r_frame_rate")),
        frame_rate(stream.get("avg_frame_rate")),
    ) {
        // The two differ when frames are unevenly spaced.
        (Some(base), Some(average)) if (base - average).abs() <= base * 0.01 => Some(average),
        _ => None,
    };
    let mut known = known.lock().unwrap();
    if known.len() >= 512 {
        known.clear();
    }
    known.insert(path.to_path_buf(), (stamp, rate));
    rate
}

/// Probes a file and makes its thumbnail. The result has no `waveform` field.
pub async fn probe_info(path: &Path, root: &Path) -> Result<Value, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("미디어 파일을 찾을 수 없습니다: {e}"))?;
    if !path.is_file() {
        return Err("미디어 파일을 선택해 주세요.".into());
    }
    let output = output_within(
        Command::new(executable("ffprobe"))
            .args([
                "-v",
                "error",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
            ])
            .arg(&path),
        PROBE_TIMEOUT,
    )
    .await
    .map_err(|e| {
        if e.kind() == std::io::ErrorKind::TimedOut {
            format!("미디어 정보를 읽는 데 시간이 너무 오래 걸립니다: {e}")
        } else {
            format!("FFprobe를 실행할 수 없습니다. FFmpeg 설치를 확인해 주세요: {e}")
        }
    })?;
    if !output.status.success() {
        return Err(format!(
            "지원하지 않거나 손상된 미디어입니다: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    let info: Value = serde_json::from_slice(&output.stdout).map_err(|e| e.to_string())?;
    let streams = info["streams"]
        .as_array()
        .ok_or("미디어 스트림을 읽을 수 없습니다.")?;
    // Album covers in MP3/M4A files are video streams, but cannot be edited as video.
    let video = streams.iter().find(|s| playable_video(s));
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    if video.is_none() && !has_audio {
        return Err("영상 또는 오디오 스트림이 없습니다.".into());
    }
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    let is_image = matches!(
        extension.as_str(),
        "jpg" | "jpeg" | "png" | "webp" | "bmp" | "tif" | "tiff" | "heic" | "avif"
    );
    let kind = if is_image {
        "image"
    } else if video.is_some() {
        "video"
    } else {
        "audio"
    };
    let duration = if is_image {
        5.0
    } else {
        numeric(info["format"].get("duration")).max(
            streams
                .iter()
                .map(|s| numeric(s.get("duration")))
                .fold(0.0, f64::max),
        )
    };
    if !duration.is_finite() || duration <= 0.0 {
        return Err("미디어 재생 시간을 확인할 수 없습니다.".into());
    }
    let media_id = id("media");
    let thumbnail = root.join("thumbnails").join(format!("{media_id}.jpg"));
    std::fs::create_dir_all(thumbnail.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut thumbnail_path = None;
    if let Some(video) = video {
        let mut cmd = Command::new(executable("ffmpeg"));
        cmd.args(["-y", "-v", "error"]);
        if !is_image {
            cmd.args(["-ss", &format!("{}", (duration * 0.1).min(1.0))]);
        }
        cmd.arg("-i")
            .arg(&path)
            .args(["-map", &format!("0:{}", video["index"])])
            .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3"])
            .arg(&thumbnail);
        let result = output_within(&mut cmd, THUMBNAIL_TIMEOUT).await;
        if matches!(result, Ok(ref o) if o.status.success()) {
            thumbnail_path = Some(thumbnail.to_string_lossy().to_string());
        }
    }
    // The size as it is shown, after the stream's rotation.
    let (width, height) = video.map_or((0, 0), |stream| {
        let size = (
            numeric(stream.get("width")) as u32,
            numeric(stream.get("height")) as u32,
        );
        if stored_sideways(stream) {
            (size.1, size.0)
        } else {
            size
        }
    });
    let mut asset = json!({"id":media_id,"name":path.file_name().unwrap_or_default().to_string_lossy(),"path":path,
        "kind":kind,"duration":duration,"width":width,"height":height,"hasAudio":has_audio,
        "thumbnail":thumbnail_path});
    if let Some(video) = video.filter(|_| kind == "video") {
        if let Some(codec) = video["codec_name"].as_str() {
            asset["codec"] = json!(codec);
        }
    }
    Ok(asset)
}

/// Writes the video frame shown at `source_time` (seconds into the file) as a PNG.
/// A time at or past the last frame gives the last frame.
pub async fn extract_frame(
    media_path: &Path,
    source_time: f64,
    out_png: &Path,
) -> Result<(), String> {
    if !source_time.is_finite() || source_time < 0.0 {
        return Err("프레임 위치가 올바르지 않습니다.".into());
    }
    if !media_path.is_file() {
        return Err(format!(
            "원본 미디어를 찾을 수 없습니다: {}",
            media_path.display()
        ));
    }
    let parent = out_png.parent().ok_or("저장 위치가 올바르지 않습니다.")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = parent.join(format!(".{}.png", id("frame")));
    let mut failure = String::new();
    // The frame on screen at a time is the last one at or before it, as the renderer
    // shows it, not the first one after it, which is what seeking alone returns.
    // Decoding starts a little earlier and every frame up to the time overwrites the
    // picture, so the last one stays. The reach grows for sparse frames and for times
    // past the end of the file.
    for back in [0.1, 0.5, 2.0, 10.0, f64::INFINITY] {
        let time = (source_time - back).max(0.0);
        let _ = std::fs::remove_file(&temporary);
        let result = output_within(
            Command::new(executable("ffmpeg"))
                .args([
                    "-y",
                    "-v",
                    "error",
                    "-nostdin",
                    "-ss",
                    &format!("{time:.6}"),
                    "-i",
                ])
                .arg(media_path)
                // Timestamps count from the seek point; the millisecond absorbs its
                // rounding to a stream tick.
                .args([
                    "-map",
                    "0:v:0",
                    "-vf",
                    &format!("trim=end={:.6}", source_time - time + 0.001),
                ])
                .args(["-update", "1", "-c:v", "png", "-f", "image2"])
                .arg(&temporary),
            FRAME_TIMEOUT,
        )
        .await;
        match result {
            Ok(output) if output.status.success() => {
                if std::fs::metadata(&temporary).is_ok_and(|m| m.len() > 0) {
                    return std::fs::rename(&temporary, out_png).map_err(|e| {
                        let _ = std::fs::remove_file(&temporary);
                        e.to_string()
                    });
                }
            }
            Ok(output) => {
                failure = String::from_utf8_lossy(&output.stderr).trim().to_string();
                break;
            }
            Err(e) => {
                failure = e.to_string();
                break;
            }
        }
        if time == 0.0 {
            break;
        }
    }
    let _ = std::fs::remove_file(&temporary);
    Err(format!("프레임을 추출할 수 없습니다: {failure}"))
}

/// Whether a media item should get a proxy for fast playback: video that is larger
/// than 1920 on its longer side, or in a codec browsers decode slowly or not at all.
pub fn needs_proxy(media: &Value) -> bool {
    media["kind"] == "video"
        && (numeric(media.get("width")).max(numeric(media.get("height"))) > 1920.0
            || media["codec"]
                .as_str()
                .is_some_and(|codec| !LIGHT_CODECS.contains(&codec)))
}

/// `<root>/proxies/<mediaId>.mp4`, whether or not the proxy exists yet.
pub fn proxy_path(root: &Path, media_id: &str) -> PathBuf {
    root.join("proxies").join(format!("{media_id}.mp4"))
}

/// Next to each proxy, a note of the source file it was made from, written before
/// the proxy is built: `<root>/proxies/<mediaId>.source`.
pub fn proxy_source_note(proxy: &Path) -> PathBuf {
    proxy.with_extension("source")
}

/// Whether `proxy` exists and shows `source`. A proxy without its note, or noted as
/// made from another file (the media was relinked since), does not stand in for it.
/// The one place that decides this, for the service that builds proxies and for the
/// `proxy` flag of a media item.
pub fn proxy_is_of(proxy: &Path, source: &str) -> bool {
    proxy.is_file()
        && std::fs::read_to_string(proxy_source_note(proxy)).is_ok_and(|noted| noted == source)
}

/// Transcodes the media's source into its proxy (H.264, at most 1280 on the longer
/// side, a keyframe every half second, AAC sound). The source is only read. The proxy
/// appears under its final name once complete; setting `cancel` or a failure leaves
/// nothing behind. An existing proxy is returned as is.
pub async fn build_proxy(
    root: &Path,
    media: &Value,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf, String> {
    let media_id = media["id"].as_str().unwrap_or_default();
    if media_id.is_empty()
        || !media_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("소재 ID가 올바르지 않습니다.".into());
    }
    let target = proxy_path(root, media_id);
    if target.is_file() {
        return Ok(target);
    }
    let directory = target.parent().unwrap();
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temporary = directory.join(format!(".{media_id}.{}.partial.mp4", uuid::Uuid::new_v4()));
    let source = PathBuf::from(media["path"].as_str().unwrap_or_default());
    encode_proxy(&source, &temporary, cancel).await?;
    std::fs::rename(&temporary, &target).map_err(|e| {
        let _ = std::fs::remove_file(&temporary);
        e.to_string()
    })?;
    Ok(target)
}

/// The transcode behind `build_proxy`, for callers that manage the file names
/// themselves: writes the proxy of `source` to `output` (an .mp4 path). Cancelling,
/// failing or dropping the future removes `output`.
pub async fn encode_proxy(
    source: &Path,
    output: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!(
            "원본 미디어를 찾을 수 없습니다: {}",
            source.display()
        ));
    }
    let scale = format!(
        "scale=w='if(gte(iw,ih),min({PROXY_SIZE},iw),-2)':h='if(gte(iw,ih),-2,min({PROXY_SIZE},ih))',scale=w='trunc(iw/2)*2':h='trunc(ih/2)*2'"
    );
    // Removes the unfinished file on every way out but success.
    struct Partial(PathBuf, bool);
    impl Drop for Partial {
        fn drop(&mut self) {
            if !self.1 {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }
    let mut partial = Partial(output.to_path_buf(), false);
    let mut child = Command::new(executable("ffmpeg"))
        .args(["-y", "-v", "error", "-nostdin", "-i"])
        .arg(source)
        .args([
            "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", &scale,
        ])
        .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "26"])
        .args([
            "-pix_fmt",
            "yuv420p",
            "-force_key_frames",
            "expr:gte(t,n_forced*0.5)",
        ])
        .args(["-c:a", "aac", "-b:a", "128k", "-ac", "2"])
        .args(["-movflags", "+faststart", "-f", "mp4"])
        .arg(output)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("FFmpeg를 실행할 수 없습니다: {e}"))?;
    let mut stderr = child.stderr.take();
    let errors = tokio::spawn(async move {
        let mut text = Vec::new();
        if let Some(stderr) = stderr.as_mut() {
            let _ = stderr.take(64 * 1024).read_to_end(&mut text).await;
            let _ = tokio::io::copy(stderr, &mut tokio::io::sink()).await;
        }
        String::from_utf8_lossy(&text).trim().to_string()
    });
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let status = loop {
        tokio::select! {
            status = child.wait() => break status.map_err(|e| e.to_string())?,
            _ = interval.tick() => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = child.kill().await;
                    let _ = child.wait().await;
                    return Err("프록시 생성을 취소했습니다.".into());
                }
            }
        }
    };
    let errors = errors.await.unwrap_or_default();
    if cancel.load(Ordering::Relaxed) {
        return Err("프록시 생성을 취소했습니다.".into());
    }
    if !status.success() || !std::fs::metadata(output).is_ok_and(|m| m.len() > 0) {
        return Err(format!("프록시를 만들 수 없습니다: {errors}"));
    }
    partial.1 = true;
    Ok(())
}

pub fn atomic_json(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path.parent().ok_or("저장 위치가 올바르지 않습니다.")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", uuid::Uuid::new_v4()));
    let data = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    use std::io::Write;
    let result = (|| {
        let mut file = std::fs::File::create(&temporary).map_err(|e| e.to_string())?;
        file.write_all(&data).map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        std::fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub fn same_path(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

pub async fn import_lut(path: &Path, directory: &Path) -> Result<Value, String> {
    let source = path
        .canonicalize()
        .map_err(|e| format!("LUT 파일을 찾을 수 없습니다: {e}"))?;
    let extension = source
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["cube", "3dl"].contains(&extension.as_str()) {
        return Err(".cube 또는 .3dl LUT 파일을 선택해 주세요.".into());
    }
    let size = std::fs::metadata(&source).map_err(|e| e.to_string())?.len();
    if size == 0 || size > 10 * 1024 * 1024 {
        return Err("LUT 파일은 비어 있지 않은 10MB 이하의 텍스트 파일이어야 합니다.".into());
    }
    let content =
        std::fs::read_to_string(&source).map_err(|_| "LUT 파일을 텍스트로 읽을 수 없습니다.")?;
    if extension == "cube" {
        let dimension = content
            .lines()
            .find_map(|line| {
                line.trim()
                    .strip_prefix("LUT_3D_SIZE")
                    .and_then(|v| v.trim().parse::<usize>().ok())
            })
            .ok_or("LUT_3D_SIZE를 가진 3D .cube 파일이 필요합니다.")?;
        if !(2..=65).contains(&dimension) {
            return Err("3D LUT 격자 크기는 2~65를 지원합니다.".into());
        }
    }
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let filename = format!("{}.{}", id("lut"), extension);
    let target = directory.join(&filename);
    std::fs::write(&target, content).map_err(|e| e.to_string())?;
    // A generated basename and cwd avoid interpolating user paths into filter syntax.
    let checked = Command::new(executable("ffmpeg"))
        .current_dir(directory)
        .args([
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=gray:s=16x16:r=1:d=1",
            "-vf",
            &format!("lut3d=file={filename}:interp=tetrahedral"),
            "-frames:v",
            "1",
            "-f",
            "null",
            "-",
        ])
        .output()
        .await;
    match checked {
        Ok(result) if result.status.success() => Ok(
            json!({"path":target,"name":source.file_name().unwrap_or_default().to_string_lossy(),"enabled":true}),
        ),
        result => {
            let _ = std::fs::remove_file(&target);
            Err(match result {
                Ok(output) => format!(
                    "LUT 형식을 확인할 수 없습니다: {}",
                    String::from_utf8_lossy(&output.stderr)
                ),
                Err(e) => format!("LUT 확인에 FFmpeg가 필요합니다: {e}"),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn ffmpeg(args: &[&str], output: &Path) {
        let result = Command::new(executable("ffmpeg"))
            .args(["-y", "-v", "error"])
            .args(args)
            .arg(output)
            .output()
            .await
            .expect("FFmpeg is required for media regression tests");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
    }

    #[test]
    fn album_covers_and_timed_thumbnails_are_not_playable_video() {
        for disposition in ["attached_pic", "timed_thumbnails", "timed_thumbnail"] {
            let mut stream = json!({"codec_type":"video","disposition":{}});
            stream["disposition"][disposition] = json!(1);
            assert!(!playable_video(&stream));
        }
        assert!(playable_video(
            &json!({"codec_type":"video","disposition":{"attached_pic":0}})
        ));
    }

    #[tokio::test]
    async fn mp3_album_cover_is_audio_but_real_video_with_audio_stays_video() {
        let root = std::env::temp_dir().join(id("studio-probe-test"));
        std::fs::create_dir_all(&root).unwrap();
        let mp3 = root.join("album.mp3");
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-f",
                "lavfi",
                "-i",
                "color=blue:size=64x64:rate=1:duration=1",
                "-map",
                "0:a",
                "-map",
                "1:v",
                "-c:a",
                "libmp3lame",
                "-c:v",
                "mjpeg",
                "-frames:v",
                "1",
                "-id3v2_version",
                "3",
                "-disposition:v",
                "attached_pic",
            ],
            &mp3,
        )
        .await;
        let audio = probe(&mp3, &root).await.unwrap();
        assert_eq!(audio["kind"], "audio");
        assert_eq!(audio["hasAudio"], true);
        assert_eq!(audio["width"], 0);
        assert_eq!(audio["height"], 0);
        assert!(audio["duration"].as_f64().unwrap() >= 1.0);
        assert!(!audio["waveform"].as_array().unwrap().is_empty());

        let mp4 = root.join("footage.mp4");
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=10:duration=1",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ],
            &mp4,
        )
        .await;
        let video = probe(&mp4, &root).await.unwrap();
        assert_eq!(video["kind"], "video");
        assert_eq!(video["hasAudio"], true);
        assert_eq!(video["width"], 64);
        assert_eq!(video["height"], 64);
        assert!(Path::new(video["thumbnail"].as_str().unwrap()).is_file());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn waveform_reports_real_levels_over_the_whole_file() {
        let root = std::env::temp_dir().join(id("studio-waveform-test"));
        std::fs::create_dir_all(&root).unwrap();
        let wav = root.join("tone-then-silence.wav");
        // 2 s of a 440 Hz sine at amplitude 0.5, then 2 s of silence.
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*440*t)*lt(t\\,2):s=44100:d=4",
                "-c:a",
                "pcm_s16le",
            ],
            &wav,
        )
        .await;
        let asset = probe(&wav, &root).await.unwrap();
        let peaks: Vec<f64> = asset["waveform"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert_eq!(peaks.len(), 128);
        let (tone, silence) = peaks.split_at(peaks.len() / 2);
        assert!(
            tone[2..62].iter().all(|p| (0.42..=0.56).contains(p)),
            "tone peaks must follow the real amplitude: {tone:?}"
        );
        assert!(
            silence[2..].iter().all(|p| *p < 0.01),
            "silence must stay flat: {silence:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn waveform_covers_audio_beyond_ten_minutes() {
        let root = std::env::temp_dir().join(id("studio-long-waveform-test"));
        std::fs::create_dir_all(&root).unwrap();
        let wav = root.join("long.wav");
        // Silent for 11 minutes, then a tone in the last minute.
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.8*sin(2*PI*300*t)*gte(t\\,660):s=8000:d=720",
                "-c:a",
                "pcm_s16le",
            ],
            &wav,
        )
        .await;
        let asset = probe(&wav, &root).await.unwrap();
        let peaks = asset["waveform"].as_array().unwrap();
        assert_eq!(peaks.len(), 1024);
        let at = |seconds: f64| peaks[(seconds / 720.0 * 1024.0) as usize].as_f64().unwrap();
        assert!(at(300.0) < 0.01 && at(650.0) < 0.01);
        assert!(at(670.0) > 0.7 && at(715.0) > 0.7);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn audio_shorter_than_the_container_is_padded_not_stretched() {
        let root = std::env::temp_dir().join(id("studio-short-audio-test"));
        std::fs::create_dir_all(&root).unwrap();
        let mp4 = root.join("short-audio.mp4");
        // 4 s of video with a tone in the first 2 s only.
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=10:duration=4",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=2",
                "-map",
                "0:v",
                "-map",
                "1:a",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ],
            &mp4,
        )
        .await;
        let asset = probe(&mp4, &root).await.unwrap();
        let peaks: Vec<f64> = asset["waveform"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_f64().unwrap())
            .collect();
        assert_eq!(
            peaks.len(),
            waveform_buckets(asset["duration"].as_f64().unwrap())
        );
        assert!(
            peaks[4..60].iter().all(|p| *p > 0.05),
            "tone expected: {peaks:?}"
        );
        assert!(
            peaks[70..].iter().all(|p| *p == 0.0),
            "silence expected: {peaks:?}"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn stalled_waveform_decode_stops_at_the_limit_and_keeps_what_it_read() {
        use tokio::io::AsyncWriteExt;
        // 16 s of media: 128 buckets of 1000 samples. 8 s arrive, then the decoder stalls.
        let (mut writer, reader) = tokio::io::duplex(1 << 20);
        let sample = 16384i16.to_le_bytes();
        writer.write_all(&sample.repeat(64_000)).await.unwrap();
        let started = std::time::Instant::now();
        let (peaks, complete) = read_peaks(reader, 16.0, Duration::from_millis(200)).await;
        assert!(!complete);
        assert!(started.elapsed() < Duration::from_secs(5));
        assert_eq!(peaks, vec![16384u16; 64]);
        drop(writer);
        assert!(WAVEFORM_TIMEOUT <= Duration::from_secs(20));
    }

    #[test]
    fn waveform_resolution_scales_with_duration_and_is_bounded() {
        assert_eq!(waveform_buckets(1.0), 128);
        assert_eq!(waveform_buckets(60.0), 480);
        assert_eq!(waveform_buckets(36_000.0), 1024);
    }

    #[tokio::test]
    async fn unresponsive_helper_process_is_stopped_by_the_timeout() {
        let started = std::time::Instant::now();
        let error = output_within(Command::new("sleep").arg("30"), Duration::from_millis(200))
            .await
            .unwrap_err();
        assert_eq!(error.kind(), std::io::ErrorKind::TimedOut);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[tokio::test]
    async fn probe_info_skips_the_waveform_which_is_computed_separately() {
        let root = std::env::temp_dir().join(id("studio-probe-info-test"));
        std::fs::create_dir_all(&root).unwrap();
        let mp4 = root.join("tone.mp4");
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=25:duration=2",
                "-f",
                "lavfi",
                "-i",
                "aevalsrc=0.5*sin(2*PI*440*t):s=44100:d=2",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
            ],
            &mp4,
        )
        .await;
        let asset = probe_info(&mp4, &root).await.unwrap();
        assert!(asset.get("waveform").is_none(), "{asset}");
        assert_eq!(asset["kind"], "video");
        assert_eq!(asset["codec"], "h264");
        assert_eq!(constant_frame_rate(&mp4).await, Some(25.0));
        assert_eq!(constant_frame_rate(&root.join("missing.mp4")).await, None);
        assert!(Path::new(asset["thumbnail"].as_str().unwrap()).is_file());
        let path = Path::new(asset["path"].as_str().unwrap());
        let peaks = waveform(path, asset["duration"].as_f64().unwrap())
            .await
            .unwrap();
        assert_eq!(peaks.len(), 128);
        assert!(
            peaks[4..120].iter().all(|p| (0.35..=0.6).contains(p)),
            "{peaks:?}"
        );
        // The combined probe still returns the same peaks.
        let full = probe(&mp4, &root).await.unwrap();
        assert_eq!(full["waveform"], json!(peaks));
        assert!(waveform(&root.join("missing.mp4"), 2.0).await.is_none());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn extract_frame_returns_the_frame_at_the_source_time() {
        let root = std::env::temp_dir().join(id("studio-frame-test"));
        std::fs::create_dir_all(&root).unwrap();
        let mp4 = root.join("red-then-blue.mp4");
        // Red for the first second, blue for the second one.
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "color=red:size=64x64:rate=24:duration=1",
                "-f",
                "lavfi",
                "-i",
                "color=blue:size=64x64:rate=24:duration=1",
                "-filter_complex",
                "[0:v][1:v]concat=n=2:v=1:a=0",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ],
            &mp4,
        )
        .await;
        let before = std::fs::read(&mp4).unwrap();
        let png = root.join("frames/frame.png");
        let pixel = |path: &Path| image::open(path).unwrap().to_rgb8().get_pixel(32, 32).0;
        extract_frame(&mp4, 0.5, &png).await.unwrap();
        let red = pixel(&png);
        assert!(red[0] > 200 && red[2] < 60, "{red:?}");
        extract_frame(&mp4, 1.5, &png).await.unwrap();
        let blue = pixel(&png);
        assert!(blue[2] > 200 && blue[0] < 60, "{blue:?}");
        // The exact end of the file still gives its last frame.
        std::fs::remove_file(&png).unwrap();
        extract_frame(&mp4, 2.0, &png).await.unwrap();
        assert!(pixel(&png)[2] > 200);
        assert_eq!(image::open(&png).unwrap().width(), 64);
        assert!(extract_frame(&root.join("missing.mp4"), 0.0, &png)
            .await
            .is_err());
        assert!(extract_frame(&mp4, -1.0, &png).await.is_err());
        assert!(extract_frame(&mp4, f64::NAN, &png).await.is_err());
        let wav = root.join("tone.wav");
        ffmpeg(
            &["-f", "lavfi", "-i", "sine=frequency=440:duration=1"],
            &wav,
        )
        .await;
        let failed = root.join("frames/none.png");
        assert!(extract_frame(&wav, 0.5, &failed).await.is_err());
        assert!(!failed.exists());
        // Nothing but the requested PNG is left, and the source is untouched.
        let left: Vec<_> = std::fs::read_dir(root.join("frames"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("frame.png")]);
        assert_eq!(std::fs::read(&mp4).unwrap(), before);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn extract_frame_returns_the_frame_on_screen_between_source_frames() {
        let root = std::env::temp_dir().join(id("studio-frame-grid-test"));
        std::fs::create_dir_all(&root).unwrap();
        // Frame N has luma 16 + 6N, so the picture tells which frame it is.
        for (rate, time, frame) in [
            // 24 fps: frame 2 (0.0833 s) is on screen at 0.1 s; frame 3 comes at 0.125 s.
            ("24", 0.1, 2),
            ("24", 0.125, 3),
            ("24", 0.0, 0),
            // 29.97 fps: frame 29 (0.9676 s) is on screen at 1 s; frame 30 comes at 1.001 s.
            ("30000/1001", 1.0, 29),
            // Two frames per second: the frame on screen is more than 0.1 s back.
            ("2", 0.95, 1),
        ] {
            let mp4 = root.join(format!("ramp-{}.mp4", rate.replace('/', "-")));
            if !mp4.exists() {
                ffmpeg(
                    &[
                        "-f", "lavfi", "-i",
                        &format!("color=black:size=64x64:rate={rate}:duration=1.5,format=gray,geq=lum='16+6*N'"),
                        "-c:v", "libx264", "-crf", "4", "-pix_fmt", "yuv420p",
                    ],
                    &mp4,
                )
                .await;
            }
            let png = root.join("frame.png");
            extract_frame(&mp4, time, &png).await.unwrap();
            let value = image::open(&png).unwrap().to_rgb8().get_pixel(32, 32).0[0] as f64;
            let found = ((value - 16.0) / 6.0).round() as i64;
            assert_eq!(found, frame, "{rate} fps at {time}s (value {value})");
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn portrait_video_stored_sideways_reports_its_displayed_size() {
        for (rotation, sideways) in [
            (90, true),
            (-90, true),
            (270, true),
            (180, false),
            (0, false),
        ] {
            let stream =
                json!({"side_data_list":[{"side_data_type":"Display Matrix","rotation":rotation}]});
            assert_eq!(stored_sideways(&stream), sideways, "{rotation}");
        }
        assert!(stored_sideways(&json!({"tags":{"rotate":"90"}})));
        assert!(!stored_sideways(&json!({"codec_type":"video"})));
        let root = std::env::temp_dir().join(id("studio-rotation-test"));
        std::fs::create_dir_all(&root).unwrap();
        let landscape = root.join("landscape.mp4");
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=128x64:rate=10:duration=1",
                "-c:v",
                "libx264",
                "-pix_fmt",
                "yuv420p",
            ],
            &landscape,
        )
        .await;
        // The same frames with a quarter turn recorded in the file, as phones write it.
        let portrait = root.join("portrait.mp4");
        ffmpeg(
            &[
                "-display_rotation",
                "90",
                "-i",
                landscape.to_str().unwrap(),
                "-c",
                "copy",
            ],
            &portrait,
        )
        .await;
        let plain = probe_info(&landscape, &root).await.unwrap();
        assert_eq!(
            (plain["width"].as_u64(), plain["height"].as_u64()),
            (Some(128), Some(64))
        );
        let turned = probe_info(&portrait, &root).await.unwrap();
        assert_eq!(
            (turned["width"].as_u64(), turned["height"].as_u64()),
            (Some(64), Some(128))
        );
        // The decoded picture has that size too: the thumbnail and an extracted frame.
        let thumbnail = probe_info(Path::new(turned["thumbnail"].as_str().unwrap()), &root)
            .await
            .unwrap();
        assert!(
            thumbnail["height"].as_u64() > thumbnail["width"].as_u64(),
            "{thumbnail}"
        );
        let png = root.join("frame.png");
        extract_frame(&portrait, 0.5, &png).await.unwrap();
        let frame = image::open(&png).unwrap();
        assert_eq!((frame.width(), frame.height()), (64, 128));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn proxies_are_for_large_or_heavy_video_only() {
        let media = |kind: &str, width: u32, height: u32, codec: Value| json!({"id":"m","kind":kind,"width":width,"height":height,"codec":codec});
        assert!(needs_proxy(&media("video", 3840, 2160, json!("h264"))));
        assert!(needs_proxy(&media("video", 1080, 2560, json!("h264"))));
        assert!(needs_proxy(&media("video", 1920, 1080, json!("hevc"))));
        assert!(needs_proxy(&media("video", 1280, 720, json!("prores"))));
        assert!(!needs_proxy(&media("video", 1920, 1080, json!("h264"))));
        assert!(!needs_proxy(&media("video", 1080, 1920, json!("vp9"))));
        // Media imported before the codec was recorded: size alone decides.
        assert!(!needs_proxy(&media("video", 1920, 1080, Value::Null)));
        assert!(needs_proxy(&media("video", 2560, 1440, Value::Null)));
        assert!(!needs_proxy(&media("image", 6000, 4000, Value::Null)));
        assert!(!needs_proxy(&media("audio", 0, 0, Value::Null)));
        let folder = std::env::temp_dir().join(id("studio-proxy-note-test"));
        std::fs::create_dir_all(&folder).unwrap();
        let proxy = proxy_path(&folder, "media-1");
        assert_eq!(
            proxy_source_note(&proxy),
            folder.join("proxies/media-1.source")
        );
        std::fs::create_dir_all(proxy.parent().unwrap()).unwrap();
        // The note alone, or the file alone, is not a proxy of the source.
        std::fs::write(proxy_source_note(&proxy), "/films/a.mp4").unwrap();
        assert!(!proxy_is_of(&proxy, "/films/a.mp4"));
        std::fs::remove_file(proxy_source_note(&proxy)).unwrap();
        std::fs::write(&proxy, b"proxy").unwrap();
        assert!(!proxy_is_of(&proxy, "/films/a.mp4"));
        std::fs::write(proxy_source_note(&proxy), "/films/a.mp4").unwrap();
        assert!(proxy_is_of(&proxy, "/films/a.mp4"));
        assert!(!proxy_is_of(&proxy, "/films/b.mp4"), "relinked since");
        std::fs::remove_dir_all(folder).unwrap();
        assert_eq!(
            proxy_path(Path::new("/data"), "media-1"),
            PathBuf::from("/data/proxies/media-1.mp4")
        );
    }

    #[tokio::test]
    async fn proxy_of_a_real_4k_hevc_source_is_small_h264_and_leaves_no_partial_files() {
        let root = std::env::temp_dir().join(id("studio-proxy-test"));
        std::fs::create_dir_all(&root).unwrap();
        let source = root.join("uhd.mp4");
        ffmpeg(
            &[
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=3840x2160:rate=30:duration=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
                "-c:v",
                "libx265",
                "-preset",
                "ultrafast",
                "-tag:v",
                "hvc1",
                "-pix_fmt",
                "yuv420p",
                "-c:a",
                "aac",
                "-shortest",
            ],
            &source,
        )
        .await;
        let original = std::fs::read(&source).unwrap();
        let asset = probe_info(&source, &root).await.unwrap();
        assert_eq!(asset["codec"], "hevc");
        assert!(needs_proxy(&asset));
        let media_id = asset["id"].as_str().unwrap();
        let files = |root: &Path| -> Vec<String> {
            std::fs::read_dir(root.join("proxies"))
                .into_iter()
                .flatten()
                .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        };
        // A cancelled build stops and removes its temporary file.
        let cancelled = build_proxy(&root, &asset, Arc::new(AtomicBool::new(true))).await;
        assert!(cancelled.unwrap_err().contains("취소"));
        assert!(files(&root).is_empty(), "{:?}", files(&root));
        let cancel = Arc::new(AtomicBool::new(false));
        let proxy = build_proxy(&root, &asset, cancel.clone()).await.unwrap();
        assert_eq!(proxy, proxy_path(&root, media_id));
        assert_eq!(files(&root), vec![format!("{media_id}.mp4")]);
        let made = probe_info(&proxy, &root).await.unwrap();
        assert_eq!(made["codec"], "h264");
        assert_eq!(
            (made["width"].as_u64(), made["height"].as_u64()),
            (Some(1280), Some(720))
        );
        assert_eq!(made["hasAudio"], true);
        assert!(!needs_proxy(&made));
        let (a, b) = (
            asset["duration"].as_f64().unwrap(),
            made["duration"].as_f64().unwrap(),
        );
        assert!((a - b).abs() < 0.1, "source {a}s, proxy {b}s");
        // Keyframes at most half a second apart keep seeking in the browser fast.
        let keyframes = Command::new(executable("ffprobe"))
            .args([
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-skip_frame",
                "nokey",
            ])
            .args(["-show_entries", "frame=pts_time", "-of", "csv=p=0"])
            .arg(&proxy)
            .output()
            .await
            .unwrap();
        let times: Vec<f64> = String::from_utf8_lossy(&keyframes.stdout)
            .lines()
            .filter_map(|line| line.trim().trim_end_matches(',').parse().ok())
            .collect();
        assert!(times.len() >= 4, "{times:?}");
        assert!(times.windows(2).all(|w| w[1] - w[0] <= 0.51), "{times:?}");
        // Building again reuses the finished proxy; the source is never written.
        let modified = std::fs::metadata(&proxy).unwrap().modified().unwrap();
        build_proxy(&root, &asset, cancel.clone()).await.unwrap();
        assert_eq!(
            std::fs::metadata(&proxy).unwrap().modified().unwrap(),
            modified
        );
        assert_eq!(std::fs::read(&source).unwrap(), original);
        // A source that cannot be decoded fails without leaving anything behind.
        let broken = root.join("broken.mp4");
        std::fs::write(&broken, b"not a video").unwrap();
        let failed = build_proxy(
            &root,
            &json!({"id":"media-broken","path":broken,"kind":"video"}),
            cancel.clone(),
        )
        .await;
        assert!(failed.is_err());
        assert!(
            build_proxy(&root, &json!({"id":"../escape","path":source}), cancel)
                .await
                .is_err()
        );
        assert_eq!(files(&root), vec![format!("{media_id}.mp4")]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
