//! Exact still previews use immutable project snapshots and never hold the editor lock
//! while FFmpeg runs. A bounded cache and a single renderer keep scrubbing inexpensive.
use crate::{
    editor::{number, Editor},
    media, render,
};
use serde_json::{json, Value};
use std::{collections::VecDeque, future::Future, path::PathBuf, sync::Arc};
use tokio::sync::{Mutex, Semaphore};

pub struct PreviewFrames {
    cache: Mutex<VecDeque<(String, Value)>>,
    renderer: Mutex<()>,
    requests: Semaphore,
}
impl Default for PreviewFrames {
    fn default() -> Self {
        Self {
            cache: Mutex::new(VecDeque::new()),
            renderer: Mutex::new(()),
            requests: Semaphore::new(8),
        }
    }
}
impl PreviewFrames {
    pub async fn frame(
        &self,
        editor: &Arc<Mutex<Editor>>,
        params: Value,
        project_id: Option<&str>,
    ) -> Result<Value, String> {
        self.frame_with(editor, params, project_id, |project, params, root| async move {
            render::preview_frame(&project, &params, &root).await
        }).await
    }

    async fn frame_with<F, Fut>(
        &self,
        editor: &Arc<Mutex<Editor>>,
        params: Value,
        project_id: Option<&str>,
        render: F,
    ) -> Result<Value, String>
    where
        F: FnOnce(Value, Value, PathBuf) -> Fut,
        Fut: Future<Output = Result<Value, String>>,
    {
        let _queue = self
            .requests
            .try_acquire()
            .map_err(|_| "미리보기 요청이 많습니다. 잠시 후 다시 시도해 주세요.".to_string())?;
        let (project, root) = editor.lock().await.preview_snapshot(&params, project_id)?;
        let width = (number(&params, "width", 640.0).clamp(64.0, 1920.0) as u32 / 2) * 2;
        let frame = (number(&params, "time", 0.0) * number(&project, "fps", 30.0)).floor();
        let key = format!(
            "{}:{width}:{frame}",
            serde_json::to_string(&project).map_err(|e| e.to_string())?
        );
        // Waiting for another render also deduplicates identical in-flight requests.
        let _renderer = self.renderer.lock().await;
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
        let mut result = render(project.clone(), params, root).await?;
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
                    .frame_with(&editor, json!({"time":0}), None, |_, _, root| async move {
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
                    |_, _, root| output(root, count),
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
                |_, _, root| output(root, count),
            )
            .await;
        assert!(result.unwrap_err().contains("REVISION_CONFLICT"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
