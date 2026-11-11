//! Exact still previews use immutable project snapshots and never hold the editor lock
//! while FFmpeg runs. A bounded cache and a single renderer keep scrubbing inexpensive.
use crate::{
    editor::{number, Editor},
    media, render,
};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    future::Future,
    hash::{DefaultHasher, Hash, Hasher},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};
use tokio::sync::{Mutex, Semaphore};

const CANCELLED: &str = "더 새로운 미리보기 요청으로 대체되었습니다. (PREVIEW_CANCELLED)";

type PendingRequest = (u64, String, u64, Arc<AtomicBool>);

pub struct PreviewFrames {
    cache: Mutex<VecDeque<(String, Value)>>,
    renderer: Mutex<()>,
    requests: Semaphore,
    /// Queued and rendering requests as (id, client, content hash, cancel flag). A
    /// request for different content cancels the earlier ones of the same client, so
    /// each client (the player, the export dialog, one agent job) renders only its
    /// newest frame and never stops another client's. Requests without a client are
    /// not listed.
    pending: std::sync::Mutex<Vec<PendingRequest>>,
    sequence: AtomicU64,
}
impl Default for PreviewFrames {
    fn default() -> Self {
        Self {
            cache: Mutex::new(VecDeque::new()),
            renderer: Mutex::new(()),
            requests: Semaphore::new(8),
            pending: std::sync::Mutex::new(Vec::new()),
            sequence: AtomicU64::new(0),
        }
    }
}
/// Removes the request from the pending list, also when its future is dropped.
struct Pending<'a>(&'a PreviewFrames, u64);
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.0.pending.lock().unwrap().retain(|(id, ..)| *id != self.1);
    }
}
impl PreviewFrames {
    pub async fn frame(
        &self,
        editor: &Arc<Mutex<Editor>>,
        params: Value,
        project_id: Option<&str>,
        agent: bool,
    ) -> Result<Value, String> {
        self.frame_with(
            editor,
            params,
            project_id,
            agent,
            |project, params, root, cancel| async move {
                render::preview_frame_cancellable(&project, &params, &root, cancel).await
            },
        )
        .await
    }

    async fn frame_with<F, Fut>(
        &self,
        editor: &Arc<Mutex<Editor>>,
        params: Value,
        project_id: Option<&str>,
        agent: bool,
        render: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(Value, Value, PathBuf, Arc<AtomicBool>) -> Fut,
        Fut: Future<Output = Result<Value, String>>,
    {
        let _queue = self
            .requests
            .try_acquire()
            .map_err(|_| "미리보기 요청이 많습니다. 잠시 후 다시 시도해 주세요.".to_string())?;
        let (project, root) = editor.lock().await.preview_snapshot(&params, project_id)?;
        let width = (number(&params, "width", 640.0).clamp(64.0, 1920.0) as u32 / 2) * 2;
        let frame = (number(&params, "time", 0.0) * number(&project, "fps", 30.0) + 1e-6).floor();
        let key = format!(
            "{}:{width}:{frame}",
            serde_json::to_string(&project).map_err(|e| e.to_string())?
        );
        let cancel = Arc::new(AtomicBool::new(false));
        let id = self.sequence.fetch_add(1, Ordering::Relaxed);
        // `params.client` names who asks: "player", "export", or what the service sets
        // for an agent token. The UI without a name is the player; an agent without
        // one stays on its own.
        let client = match params["client"].as_str().filter(|c| !c.is_empty()) {
            Some(client) => Some(client.chars().take(64).collect::<String>()),
            None if agent => None,
            None => Some("player".to_string()),
        };
        if let Some(client) = client {
            let mut hasher = DefaultHasher::new();
            key.hash(&mut hasher);
            let content = hasher.finish();
            let mut pending = self.pending.lock().unwrap();
            for (_, other, other_content, flag) in pending.iter() {
                if *other == client && *other_content != content {
                    flag.store(true, Ordering::Relaxed);
                }
            }
            pending.push((id, client, content, cancel.clone()));
        }
        let _pending = Pending(self, id);
        // Waiting for another render also deduplicates identical in-flight requests.
        let _renderer = self.renderer.lock().await;
        if cancel.load(Ordering::Relaxed) {
            return Err(CANCELLED.into());
        }
        editor.lock().await.preview_is_current(&project)?;
        {
            let mut cache = self.cache.lock().await;
            if let Some(index) = cache.iter().position(|(k, value)| {
                k == &key
                    && value["path"]
                        .as_str()
                        .map(|p| std::path::Path::new(p).is_file())
                        .unwrap_or(false)
            }) {
                let entry = cache.remove(index).unwrap();
                let mut value = entry.1.clone();
                value["cacheHit"] = json!(true);
                cache.push_back(entry);
                return Ok(value);
            }
        }
        let result = render(project.clone(), params, root, cancel.clone()).await;
        if cancel.load(Ordering::Relaxed) {
            if let Some(path) = result.as_ref().ok().and_then(|value| value["path"].as_str()) {
                let _ = std::fs::remove_file(path);
            }
            return Err(CANCELLED.into());
        }
        let mut result = result?;
        let path = PathBuf::from(result["path"].as_str().ok_or("미리보기 파일이 없습니다.")?);
        let mut guard = editor.lock().await;
        if let Err(error) = guard.preview_is_current(&project) {
            let _ = std::fs::remove_file(path);
            return Err(error);
        }
        let asset_id = media::id("preview-frame");
        guard.register_preview_asset(asset_id.clone(), path);
        result["assetId"] = json!(asset_id);
        result["projectId"] = project["id"].clone();
        result["revision"] = project["revision"].clone();
        result["cacheHit"] = json!(false);
        let mut cache = self.cache.lock().await;
        cache.push_back((key, result.clone()));
        while cache.len() > 32 {
            if let Some((_, old)) = cache.pop_front() {
                if let Some(id) = old["assetId"].as_str() {
                    guard.forget_preview_asset(id);
                }
                if let Some(path) = old["path"].as_str() {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicUsize, Ordering},
        time::Duration,
    };
    fn setup() -> (PathBuf, Arc<Mutex<Editor>>) {
        let root = std::env::temp_dir().join(media::id("preview-test"));
        (
            root.clone(),
            Arc::new(Mutex::new(Editor::new(root).unwrap())),
        )
    }
    async fn output(root: PathBuf, count: Arc<AtomicUsize>) -> Result<Value, String> {
        count.fetch_add(1, Ordering::SeqCst);
        let path = root.join(media::id("frame"));
        std::fs::write(&path, b"test").unwrap();
        Ok(json!({"path":path}))
    }
    #[tokio::test]
    async fn slow_frame_does_not_block_edit_and_stale_result_is_discarded() {
        let (root, editor) = setup();
        let frames = Arc::new(PreviewFrames::default());
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = tokio::sync::oneshot::channel();
        let task = {
            let editor = editor.clone();
            let frames = frames.clone();
            tokio::spawn(async move {
                frames
                    .frame_with(&editor, json!({"time":0}), None, false, |_, _, root, _| async move {
                        started_tx.send(()).unwrap();
                        finish_rx.await.unwrap();
                        output(root, Arc::new(AtomicUsize::new(0))).await
                    })
                    .await
            })
        };
        started_rx.await.unwrap();
        tokio::time::timeout(Duration::from_millis(100), async {
            editor
                .lock()
                .await
                .dispatch(
                    "project.update",
                    json!({"patch":{"name":"Edited while rendering"}}),
                )
                .await
                .unwrap();
        })
        .await
        .expect("preview must not hold the Editor mutex");
        finish_tx.send(()).unwrap();
        assert!(task.await.unwrap().unwrap_err().contains("PREVIEW_STALE"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn cache_reuses_content_and_size_but_not_changed_size_or_stale_revision() {
        let (root, editor) = setup();
        let frames = PreviewFrames::default();
        let count = Arc::new(AtomicUsize::new(0));
        for width in [640, 640, 960] {
            let count = count.clone();
            frames
                .frame_with(
                    &editor,
                    json!({"time":0,"width":width}),
                    None,
                    false,
                    |_, _, root, _| output(root, count),
                )
                .await
                .unwrap();
        }
        assert_eq!(count.load(Ordering::SeqCst), 2);
        editor
            .lock()
            .await
            .dispatch("project.update", json!({"patch":{"name":"New"}}))
            .await
            .unwrap();
        let result = frames
            .frame_with(
                &editor,
                json!({"time":0,"expectedRevision":0}),
                None,
                false,
                |_, _, root, _| output(root, count),
            )
            .await;
        assert!(result.unwrap_err().contains("REVISION_CONFLICT"));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn newer_request_cancels_running_and_queued_renders_but_identical_one_does_not() {
        let (root, editor) = setup();
        let frames = Arc::new(PreviewFrames::default());
        let count = Arc::new(AtomicUsize::new(0));
        // Stands in for FFmpeg: runs until its cancel flag is set, as run_process does.
        let slow = |time: f64, agent: bool| {
            let (editor, frames) = (editor.clone(), frames.clone());
            tokio::spawn(async move {
                frames
                    .frame_with(&editor, json!({"time":time}), None, agent, |_, _, _, cancel| async move {
                        while !cancel.load(Ordering::Relaxed) {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                        Err("stopped".to_string())
                    })
                    .await
            })
        };
        // Counts requests that have registered, not those still pending: a superseded
        // request may already have left the list by the time this is polled.
        let wait_pending = |n: u64| {
            let frames = frames.clone();
            async move {
                while frames.sequence.load(Ordering::Relaxed) < n {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        };
        let running = slow(0.0, false);
        wait_pending(1).await;
        let same = slow(0.0, false);
        wait_pending(2).await;
        assert!(!running.is_finished(), "an identical request must not cancel");
        let queued = slow(0.5, false);
        wait_pending(3).await;
        let newest = tokio::time::timeout(
            Duration::from_secs(5),
            frames.frame_with(&editor, json!({"time":0.9}), None, false, |_, _, root, _| {
                output(root, count.clone())
            }),
        )
        .await
        .expect("the newest request must not wait for superseded renders");
        assert_eq!(newest.unwrap()["cacheHit"], false);
        for task in [running, same, queued] {
            assert!(task.await.unwrap().unwrap_err().contains("PREVIEW_CANCELLED"));
        }
        assert_eq!(count.load(Ordering::SeqCst), 1);
        assert!(frames.pending.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn agent_and_ui_frames_do_not_cancel_each_other() {
        let (root, editor) = setup();
        let frames = Arc::new(PreviewFrames::default());
        // Finishes on its own unless cancelled, like a real render.
        let request = |time: f64, agent: bool| {
            let (editor, frames) = (editor.clone(), frames.clone());
            tokio::spawn(async move {
                frames
                    .frame_with(&editor, json!({"time":time}), None, agent, |_, _, root, cancel| async move {
                        for _ in 0..20 {
                            if cancel.load(Ordering::Relaxed) {
                                return Err("stopped".to_string());
                            }
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                        output(root, Arc::new(AtomicUsize::new(0))).await
                    })
                    .await
            })
        };
        // UI render running, then an agent asks for another time, then the reverse.
        let ui = request(0.0, false);
        tokio::time::sleep(Duration::from_millis(20)).await;
        let agent = request(1.0, true);
        ui.await.unwrap().expect("an agent request must not cancel the UI frame");
        tokio::time::sleep(Duration::from_millis(20)).await;
        let later_ui = request(2.0, false);
        agent.await.unwrap().expect("a UI request must not cancel the agent frame");
        later_ui.await.unwrap().unwrap();
        assert!(frames.pending.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn a_request_cancels_only_earlier_ones_of_its_own_client() {
        let (root, editor) = setup();
        let frames = Arc::new(PreviewFrames::default());
        // Runs until cancelled, like a long FFmpeg render.
        let endless = |time: f64, client: Option<&str>, agent: bool| {
            let (editor, frames) = (editor.clone(), frames.clone());
            let mut params = json!({"time":time});
            if let Some(client) = client {
                params["client"] = json!(client);
            }
            tokio::spawn(async move {
                frames
                    .frame_with(&editor, params, None, agent, |_, _, _, cancel| async move {
                        while !cancel.load(Ordering::Relaxed) {
                            tokio::time::sleep(Duration::from_millis(5)).await;
                        }
                        Err("stopped".to_string())
                    })
                    .await
            })
        };
        let registered = |n: u64| {
            let frames = frames.clone();
            async move {
                while frames.sequence.load(Ordering::Relaxed) < n {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            }
        };
        let player = endless(0.0, Some("player"), false);
        registered(1).await;
        let export = endless(0.2, Some("export"), false);
        registered(2).await;
        let agent = endless(0.4, Some("agent-1"), true);
        registered(3).await;
        let other_agent = endless(0.6, Some("agent-2"), true);
        registered(4).await;
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            [&player, &export, &agent, &other_agent].iter().all(|task| !task.is_finished()),
            "requests of different clients must not cancel each other"
        );
        // A request without a client is the player's: it replaces the player's frame only.
        let unnamed = endless(0.8, None, false);
        assert!(player.await.unwrap().unwrap_err().contains("PREVIEW_CANCELLED"));
        let export_again = endless(1.0, Some("export"), false);
        assert!(export.await.unwrap().unwrap_err().contains("PREVIEW_CANCELLED"));
        let agent_again = endless(1.2, Some("agent-1"), true);
        assert!(agent.await.unwrap().unwrap_err().contains("PREVIEW_CANCELLED"));
        tokio::time::sleep(Duration::from_millis(30)).await;
        let remaining = [unnamed, export_again, agent_again, other_agent];
        assert!(remaining.iter().all(|task| !task.is_finished()));
        // One newer request per client ends the rest. They are sent together because
        // all renders share one renderer and wait for each other's cancelled requests.
        let newest: Vec<_> = [
            (2.0, "player", false),
            (2.2, "export", false),
            (2.4, "agent-1", true),
            (2.6, "agent-2", true),
        ]
        .into_iter()
        .map(|(time, client, is_agent)| {
            let (editor, frames) = (editor.clone(), frames.clone());
            tokio::spawn(async move {
                frames
                    .frame_with(
                        &editor,
                        json!({"time":time,"client":client}),
                        None,
                        is_agent,
                        |_, _, root, _| output(root, Arc::new(AtomicUsize::new(0))),
                    )
                    .await
            })
        })
        .collect();
        for task in newest {
            tokio::time::timeout(Duration::from_secs(10), task)
                .await
                .expect("the newest request of each client must be rendered")
                .unwrap()
                .unwrap();
        }
        for task in remaining {
            assert!(task.await.unwrap().unwrap_err().contains("PREVIEW_CANCELLED"));
        }
        assert!(frames.pending.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }
}
