//! Local speech tools: timeline audio -> Whisper -> editable captions, and macOS
//! system voices -> imported audio. A job commits only to its original revision.
use crate::{
    editor::Editor,
    runtime::{find_executable, now_ms, prune_finished, signal_group, stop_child, ProcessGroups},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{watch, Mutex},
};
use uuid::Uuid;

#[derive(Clone)]
struct Job {
    value: Value,
    cancel: watch::Sender<bool>,
}
type Jobs = Arc<Mutex<HashMap<String, Job>>>;
pub struct Speech {
    root: PathBuf,
    editor: Arc<Mutex<Editor>>,
    jobs: Jobs,
    children: ProcessGroups,
}
impl Speech {
    pub fn new(root: PathBuf, editor: Arc<Mutex<Editor>>, children: ProcessGroups) -> Self {
        Self {
            root,
            editor,
            jobs: Arc::new(Mutex::new(HashMap::new())),
            children,
        }
    }
    pub async fn dispatch(&self, method: &str, params: Value) -> Result<Value, String> {
        match method {
            "speech.status" => Ok(
                json!({"whisperAvailable":find_executable("whisper").is_some(),"ttsAvailable":find_executable("say").is_some(),"voices":voices().await,"models":["tiny","base","small"],"modelDirectory":self.root.join("models/whisper")}),
            ),
            "speech.transcribe" => self.start(params, false).await,
            "speech.synthesize" => self.start(params, true).await,
            "speech.job" => {
                let id = params["id"].as_str().ok_or("작업 ID가 필요합니다")?;
                self.jobs
                    .lock()
                    .await
                    .get(id)
                    .map(|j| j.value.clone())
                    .ok_or_else(|| "음성 작업을 찾을 수 없습니다".into())
            }
            "speech.cancel" => {
                let id = params["id"].as_str().ok_or("작업 ID가 필요합니다")?;
                let mut all = self.jobs.lock().await;
                let job = all.get_mut(id).ok_or("음성 작업을 찾을 수 없습니다")?;
                if job.value["state"] == "running" {
                    let _ = job.cancel.send(true);
                    job.value["state"] = json!("cancelling");
                }
                Ok(job.value.clone())
            }
            _ => Err(format!("지원하지 않는 음성 명령: {method}")),
        }
    }
    async fn start(&self, params: Value, synthesize: bool) -> Result<Value, String> {
        if synthesize {
            if find_executable("say").is_none() {
                return Err("이 컴퓨터에서 시스템 음성 합성을 사용할 수 없습니다".into());
            }
            let text = params["text"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or("읽을 내용을 입력해주세요")?;
            if text.chars().count() > 10000 {
                return Err("한 번에 10,000자까지 음성으로 만들 수 있습니다".into());
            }
            if let Some(voice) = params["voice"].as_str().filter(|s| !s.is_empty()) {
                if !voices().await.iter().any(|v| v["id"] == voice) {
                    return Err("선택한 시스템 음성을 찾을 수 없습니다".into());
                }
            }
        } else {
            if find_executable("whisper").is_none() {
                return Err("자동 자막에는 로컬 Whisper가 필요합니다. Python 환경에 openai-whisper를 설치해주세요.".into());
            }
            let model = params["model"].as_str().unwrap_or("base");
            if !["tiny", "base", "small"].contains(&model) {
                return Err("지원하지 않는 자막 모델입니다".into());
            }
            let language = params["language"].as_str().unwrap_or("auto");
            if !["ko", "en", "auto"].contains(&language) {
                return Err("지원하지 않는 언어입니다".into());
            }
        }
        let project = self
            .editor
            .lock()
            .await
            .dispatch("project.get", json!({}))
            .await?;
        if params["_projectId"]
            .as_str()
            .is_some_and(|id| project["id"].as_str() != Some(id))
        {
            return Err("프로젝트가 변경되어 음성 작업을 시작하지 않았습니다".into());
        }
        if !synthesize && project["clips"].as_array().is_none_or(|v| v.is_empty()) {
            return Err("먼저 타임라인에 영상을 추가해주세요".into());
        }
        let id = Uuid::new_v4().to_string();
        let (cancel, receiver) = watch::channel(false);
        self.jobs.lock().await.insert(id.clone(),Job{value:json!({"id":id,"kind":if synthesize{"synthesize"}else{"transcribe"},"state":"running","progress":0.0,"logs":[],"projectId":project["id"],"revision":project["revision"],"startedAt":now_ms()}),cancel});
        let root = self.root.clone();
        let jobs = self.jobs.clone();
        let editor = self.editor.clone();
        let children = self.children.clone();
        let run_id = id.clone();
        tokio::spawn(async move {
            let result = if synthesize {
                synthesize_audio(
                    &root,
                    &editor,
                    &jobs,
                    &run_id,
                    params,
                    &project,
                    receiver.clone(),
                    &children,
                )
                .await
            } else {
                transcribe_audio(
                    &root,
                    &editor,
                    &jobs,
                    &run_id,
                    params,
                    &project,
                    receiver.clone(),
                    &children,
                )
                .await
            };
            // The rendered timeline audio is only an input to recognition. Applied
            // captions live in the project, so a finished transcription keeps nothing;
            // an unapplied result (failure or changed project) keeps its SRT.
            let directory = root.join("speech").join(&run_id);
            let _ = tokio::fs::remove_file(directory.join("timeline.wav")).await;
            let applied = !synthesize && result.is_ok();
            if applied {
                let _ = tokio::fs::remove_dir_all(&directory).await;
            }
            let mut all = jobs.lock().await;
            if let Some(job) = all.get_mut(&run_id) {
                if applied {
                    forget_output(&mut job.value);
                }
                match result {
                    Ok(value) => {
                        job.value["state"] = json!("completed");
                        job.value["progress"] = json!(1.0);
                        job.value["result"] = value;
                    }
                    Err(error) => {
                        job.value["state"] = json!(if *receiver.borrow() {
                            "cancelled"
                        } else {
                            "failed"
                        });
                        job.value["error"] = json!(error);
                    }
                }
                job.value["finishedAt"] = json!(now_ms());
            }
            let finished = all
                .iter()
                .filter_map(|(id, job)| Some((id.clone(), job.value["finishedAt"].as_u64()?)))
                .collect();
            for id in prune_finished(finished) {
                all.remove(&id);
            }
        });
        Ok(json!({"id":id,"state":"running"}))
    }
}

async fn voices() -> Vec<Value> {
    let Some(say) = find_executable("say") else {
        return vec![];
    };
    let mut command = Command::new(say);
    command.args(["-v", "?"]).kill_on_drop(true);
    let Ok(Ok(out)) = tokio::time::timeout(Duration::from_secs(8), command.output()).await else {
        return vec![];
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let info = line.split('#').next()?.trim();
            let mut parts: Vec<_> = info.split_whitespace().collect();
            let language = parts.pop()?;
            if !language.contains('_') {
                return None;
            }
            let name = parts.join(" ");
            if name.is_empty() {
                return None;
            }
            Some(json!({"id":name,"name":name,"language":language.replace('_',"-")}))
        })
        .collect()
}
async fn update(jobs: &Jobs, id: &str, progress: f64, message: &str) {
    let mut all = jobs.lock().await;
    if let Some(j) = all.get_mut(id) {
        j.value["progress"] = json!(progress);
        j.value["message"] = json!(message);
        j.value["logs"]
            .as_array_mut()
            .unwrap()
            .push(json!({"at":now_ms(),"text":message}));
    }
}
/// A job must not point at a result file that has been removed.
fn forget_output(job: &mut Value) {
    if let Some(job) = job.as_object_mut() {
        job.remove("output");
    }
}
async fn save_output(jobs: &Jobs, id: &str, path: &Path) {
    let mut all = jobs.lock().await;
    if let Some(j) = all.get_mut(id) {
        j.value["output"] = json!(path);
    }
}
fn check_cancel(cancel: &watch::Receiver<bool>) -> Result<(), String> {
    if *cancel.borrow() {
        Err("작업을 취소했습니다".into())
    } else {
        Ok(())
    }
}
fn check_project(current: &Value, original: &Value) -> Result<(), String> {
    if current["id"] != original["id"] || current["revision"] != original["revision"] {
        Err("작업 중 프로젝트가 변경되어 자동 적용하지 않았습니다. 생성 파일은 보관되어 있으니 가져오기로 적용할 수 있습니다.".into())
    } else {
        Ok(())
    }
}
#[allow(clippy::too_many_arguments)]
async fn transcribe_audio(
    root: &Path,
    editor: &Arc<Mutex<Editor>>,
    jobs: &Jobs,
    id: &str,
    params: Value,
    project: &Value,
    cancel: watch::Receiver<bool>,
    children: &ProcessGroups,
) -> Result<Value, String> {
    let directory = root.join("speech").join(id);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|e| e.to_string())?;
    let audio = directory.join("timeline.wav");
    update(jobs, id, 0.05, "타임라인 오디오를 준비하고 있습니다").await;
    let render = {
        let mut editor = editor.lock().await;
        let current = editor.dispatch("project.get", json!({})).await?;
        check_project(&current, project)?;
        editor
            .dispatch("export.start", json!({"path":audio,"format":"wav"}))
            .await?
    };
    let render_id = render["id"]
        .as_str()
        .ok_or("오디오 출력 작업을 시작하지 못했습니다")?
        .to_owned();
    loop {
        if check_cancel(&cancel).is_err() {
            let _ = editor
                .lock()
                .await
                .dispatch("export.cancel", json!({"id":render_id}))
                .await;
            return Err("작업을 취소했습니다".into());
        }
        let status = editor
            .lock()
            .await
            .dispatch("export.status", json!({"id":render_id}))
            .await?;
        match status["state"].as_str().unwrap_or("") {
            "completed" => break,
            "failed" | "cancelled" => {
                return Err(status["error"]
                    .as_str()
                    .unwrap_or("오디오 준비에 실패했습니다")
                    .into())
            }
            _ => {
                update(
                    jobs,
                    id,
                    0.05 + 0.2 * status["progress"].as_f64().unwrap_or(0.0),
                    "타임라인 오디오를 준비하고 있습니다",
                )
                .await;
                tokio::time::sleep(Duration::from_millis(350)).await;
            }
        }
    }
    check_cancel(&cancel)?;
    let model = params["model"].as_str().unwrap_or("base");
    let model_dir = root.join("models/whisper");
    tokio::fs::create_dir_all(&model_dir)
        .await
        .map_err(|e| e.to_string())?;
    let message = if model_dir.join(format!("{model}.pt")).is_file() {
        "로컬 모델로 음성을 인식하고 있습니다"
    } else {
        "처음 사용하는 음성 모델을 내려받고 있습니다. 다운로드 후 로컬에서 인식합니다"
    };
    update(jobs, id, 0.28, message).await;
    let mut command = Command::new(find_executable("whisper").ok_or("Whisper를 찾을 수 없습니다")?);
    command
        .arg(&audio)
        .args(["--model", model, "--model_dir"])
        .arg(&model_dir)
        .args([
            "--device",
            "cpu",
            "--fp16",
            "False",
            "--output_format",
            "srt",
            "--output_dir",
        ])
        .arg(&directory)
        .args([
            "--verbose",
            "False",
            "--threads",
            "4",
            "--task",
            if params["translate"] == true {
                "translate"
            } else {
                "transcribe"
            },
        ]);
    if let Some(language) = params["language"].as_str().filter(|v| *v != "auto") {
        command.args(["--language", language]);
    }
    run(command, jobs, id, cancel.clone(), children).await?;
    let srt = directory.join("timeline.srt");
    save_output(jobs, id, &srt).await;
    let text = tokio::fs::read_to_string(&srt)
        .await
        .map_err(|e| format!("자막 파일을 읽을 수 없습니다: {e}"))?;
    if text.trim().is_empty() {
        return Err(
            "인식 가능한 음성을 찾지 못했습니다. 오디오 트랙과 음량을 확인해주세요.".into(),
        );
    }
    check_cancel(&cancel)?;
    update(jobs, id, 0.95, "인식한 자막을 타임라인에 적용하고 있습니다").await;
    let mut editor = editor.lock().await;
    let current = editor.dispatch("project.get", json!({})).await?;
    check_project(&current, project)?;
    editor
        .dispatch(
            "captions.import",
            json!({"path":srt,"expectedRevision":project["revision"]}),
        )
        .await
}
#[allow(clippy::too_many_arguments)]
async fn synthesize_audio(
    root: &Path,
    editor: &Arc<Mutex<Editor>>,
    jobs: &Jobs,
    id: &str,
    params: Value,
    project: &Value,
    cancel: watch::Receiver<bool>,
    children: &ProcessGroups,
) -> Result<Value, String> {
    let directory = root.join("speech").join(id);
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|e| e.to_string())?;
    let path = directory.join("voice.aiff");
    let script = directory.join("script.txt");
    tokio::fs::write(&script, params["text"].as_str().unwrap_or(""))
        .await
        .map_err(|e| e.to_string())?;
    update(jobs, id, 0.15, "시스템 음성으로 내레이션을 만들고 있습니다").await;
    let mut command =
        Command::new(find_executable("say").ok_or("시스템 음성 합성을 사용할 수 없습니다")?);
    command
        .arg("-f")
        .arg(&script)
        .arg("-o")
        .arg(&path)
        .arg("-r")
        .arg(
            params["rate"]
                .as_u64()
                .unwrap_or(175)
                .clamp(80, 400)
                .to_string(),
        );
    if let Some(voice) = params["voice"].as_str().filter(|v| !v.is_empty()) {
        command.arg("-v").arg(voice);
    }
    run(command, jobs, id, cancel.clone(), children).await?;
    save_output(jobs, id, &path).await;
    check_cancel(&cancel)?;
    update(jobs, id, 0.9, "내레이션을 오디오 트랙에 추가하고 있습니다").await;
    let mut editor = editor.lock().await;
    let current = editor.dispatch("project.get", json!({})).await?;
    check_project(&current, project)?;
    let start = params["start"].as_f64().unwrap_or(0.0);
    if !start.is_finite() || start < 0.0 {
        return Err("시작 시간은 0 이상이어야 합니다".into());
    }
    editor
        .dispatch(
            "media.importAndAdd",
            json!({"paths":[path],"start":start,"expectedRevision":project["revision"]}),
        )
        .await
}
async fn run(
    mut command: Command,
    jobs: &Jobs,
    id: &str,
    mut cancel: watch::Receiver<bool>,
    children: &ProcessGroups,
) -> Result<(), String> {
    check_cancel(&cancel)?;
    command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .env("PYTHONUNBUFFERED", "1");
    // Whisper shells out to ffmpeg, which a Finder-launched app would not find.
    if let Ok(path) = std::env::join_paths(crate::runtime::search_paths()) {
        command.env("PATH", path);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.as_std_mut().process_group(0);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let pid = child.id();
    children.add(pid);
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let jobs = jobs.clone();
        let id = id.to_owned();
        readers.push(tokio::spawn(async move {
            log_lines(stdout, jobs, id).await;
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let jobs = jobs.clone();
        let id = id.to_owned();
        readers.push(tokio::spawn(async move {
            log_lines(stderr, jobs, id).await;
        }));
    }
    let result = tokio::select! {
        status=child.wait()=>match status{Ok(s) if s.success()=>Ok(()),Ok(s)=>Err(format!("음성 처리 도구가 종료했습니다 ({:?}). 작업 로그를 확인해주세요.",s.code())),Err(e)=>Err(e.to_string())},
        _=cancel.changed()=>{stop_child(&mut child).await;Err("작업을 취소했습니다".into())},
        _=tokio::time::sleep(Duration::from_secs(3600))=>{stop_child(&mut child).await;Err("음성 처리 제한 시간(1시간)을 초과했습니다".into())}
    };
    signal_group(pid, "-KILL").await; // whatever the tool left running in its group
    children.remove(pid);
    for reader in readers {
        let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
    }
    result
}
async fn log_lines<R: tokio::io::AsyncRead + Unpin>(reader: R, jobs: Jobs, id: String) {
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let mut all = jobs.lock().await;
        if let Some(job) = all.get_mut(&id) {
            let logs = job.value["logs"].as_array_mut().unwrap();
            logs.push(json!({"at":now_ms(),"text":line.chars().take(4096).collect::<String>()}));
            if logs.len() > 200 {
                logs.remove(0);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn revision_conflict_retains_output_without_applying() {
        let a = json!({"id":"a","revision":5});
        assert!(check_project(&a, &a).is_ok());
        assert!(check_project(&json!({"id":"a","revision":6}), &a).is_err());
        assert!(check_project(&json!({"id":"b","revision":5}), &a).is_err());
    }
    #[test]
    fn applied_transcription_does_not_report_its_removed_file() {
        let mut job = json!({"id":"a","output":"/gone/timeline.srt","state":"running"});
        forget_output(&mut job);
        assert_eq!(job, json!({"id":"a","state":"running"}));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn a_finished_tool_leaves_nothing_running_in_its_group() {
        let jobs = Arc::new(Mutex::new(HashMap::new()));
        let (_tx, rx) = watch::channel(false);
        let pid_file = std::env::temp_dir().join(format!("studio-speech-{}", Uuid::new_v4()));
        let mut command = Command::new("/bin/sh");
        // The tool exits at once but leaves a helper behind.
        command.args([
            "-c",
            &format!(
                "sleep 30 </dev/null >/dev/null 2>&1 & echo $! > '{}'",
                pid_file.display()
            ),
        ]);
        run(command, &jobs, "id", rx, &ProcessGroups::default())
            .await
            .unwrap();
        let helper = std::fs::read_to_string(&pid_file).unwrap();
        std::fs::remove_file(&pid_file).unwrap();
        assert!(
            crate::runtime::exits_soon(helper.trim()).await,
            "helper survived"
        );
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn cancelling_a_running_tool_stops_its_process_group() {
        let (tx, rx) = watch::channel(false);
        let jobs = Arc::new(Mutex::new(HashMap::new()));
        let children = ProcessGroups::default();
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 30 & wait"]);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(200)).await;
            tx.send(true).unwrap();
        });
        let started = std::time::Instant::now();
        let error = run(command, &jobs, "id", rx, &children).await.unwrap_err();
        assert!(error.contains("취소"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10));
        children.kill_all(); // nothing left to stop
    }
    #[tokio::test]
    async fn cancelled_jobs_do_not_spawn() {
        let (tx, rx) = watch::channel(false);
        tx.send(true).unwrap();
        let jobs = Arc::new(Mutex::new(HashMap::new()));
        assert!(run(
            Command::new("does-not-exist"),
            &jobs,
            "id",
            rx,
            &ProcessGroups::default()
        )
        .await
        .unwrap_err()
        .contains("취소"));
    }
}
