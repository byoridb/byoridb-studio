use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::process::Command;

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

pub async fn probe(path: &Path, root: &Path) -> Result<Value, String> {
    let path = path
        .canonicalize()
        .map_err(|e| format!("미디어 파일을 찾을 수 없습니다: {e}"))?;
    if !path.is_file() {
        return Err("미디어 파일을 선택해 주세요.".into());
    }
    let output = Command::new(executable("ffprobe"))
        .args([
            "-v",
            "error",
            "-show_streams",
            "-show_format",
            "-of",
            "json",
        ])
        .arg(&path)
        .output()
        .await
        .map_err(|e| format!("FFprobe를 실행할 수 없습니다. FFmpeg 설치를 확인해 주세요: {e}"))?;
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
    if video.is_some() {
        let mut cmd = Command::new(executable("ffmpeg"));
        cmd.args(["-y", "-v", "error"]);
        if !is_image {
            cmd.args(["-ss", &format!("{}", (duration * 0.1).min(1.0))]);
        }
        let result = cmd
            .arg("-i")
            .arg(&path)
            .args(["-map", &format!("0:{}", video.unwrap()["index"])])
            .args(["-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "3"])
            .arg(&thumbnail)
            .output()
            .await;
        if matches!(result, Ok(ref o) if o.status.success()) {
            thumbnail_path = Some(thumbnail.to_string_lossy().to_string());
        }
    }
    let mut waveform: Vec<f32> = Vec::new();
    if has_audio {
        let output = Command::new(executable("ffmpeg"))
            .args(["-v", "error", "-i"])
            .arg(&path)
            .args([
                "-t", "600", "-vn", "-ac", "1", "-ar", "100", "-f", "f32le", "pipe:1",
            ])
            .output()
            .await;
        if let Ok(output) = output {
            if output.status.success() {
                let samples: Vec<f32> = output
                    .stdout
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]).abs())
                    .collect();
                let bucket = (samples.len() / 128).max(1);
                waveform = samples
                    .chunks(bucket)
                    .take(128)
                    .map(|c| {
                        c.iter()
                            .copied()
                            .filter(|x| x.is_finite())
                            .fold(0.0, f32::max)
                            .min(1.0)
                    })
                    .collect();
            }
        }
    }
    Ok(
        json!({"id":media_id,"name":path.file_name().unwrap_or_default().to_string_lossy(),"path":path,
        "kind":kind,"duration":duration,"width":video.map(|s|numeric(s.get("width")) as u32).unwrap_or(0),
        "height":video.map(|s|numeric(s.get("height")) as u32).unwrap_or(0),"hasAudio":has_audio,
        "thumbnail":thumbnail_path,"waveform":waveform}),
    )
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
}
