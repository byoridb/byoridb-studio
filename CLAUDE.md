# CLAUDE.md

## Current Work

Byori Studio is now a local video editor using CapCut Desktop's workspace pattern.
Preserve the name and the broad target in ROADMAP.md; do not represent remaining
advanced, cloud or generative features as implemented. NEXT.md is the active backlog.

## Development

```bash
npm install
npm run studio                       # Vite + standalone local Rust service
npm run tauri dev                    # native macOS window + service
npm run build                        # TypeScript + Vite
npm test
npm run test:core
python3 -m unittest discover -s scripts -p 'test_*.py'
BYORI_STUDIO_HOME="$(mktemp -d)" npm run verify   # all of the above + integration + build
npm run tauri build -- --bundles app
```

FFmpeg/ffprobe and Python 3 are required for media/MCP. Whisper is optional for
automatic captions; macOS say supplies TTS. Reuse installed CLI authentication;
never replace a user's global Claude/Codex/Gemini settings. See README.md.

## Active Architecture

- `src/App.tsx`, `src/studio/`: home screen, workspace, library, player, inspector,
  timeline, assistant drawer, export and settings (runtime, MCP, storage).
  `clipEditing.ts`/`clipPresets.ts` build edit commands, `playbackClock.ts` holds the
  playhead, `fastPreview.ts` approximates playback, `errorText.ts` words errors in Korean.
- `src/styles/index.css`: DESIGN.md tokens; `studio.css` and `src/studio/*.css` use them.
- `src-tauri/src/editor.rs`: authoritative project, validated commands, revision,
  frame grid, transactional batches, undo/redo, schema version and persistent autosave.
- `media.rs`, `render.rs`: probing, thumbnails, waveforms, proxies and FFmpeg rendering
  (one path for preview frames and exports).
- `service.rs`: loopback RPC/upload/assets, origin and bearer-token checks, scoped agent
  tokens, background media worker, storage usage/cleanup, single instance.
- `runtime.rs`: ByoriDB setup/memory and CLI provider processes.
- `speech.rs`: cancellable Whisper and system TTS jobs.
- `catalog.rs`, `preview.rs`, `mcp_connections.rs`: font/preset catalog, exact preview
  frames outside the editor lock, Higgsfield MCP connection.
- `main.rs`: native shell/file dialogs; `bin/studio-service.rs`: browser dev service.
- `scripts/studio-mcp.py`, `scripts/studio-tools.json`: project-scoped tools shared by the
  three CLI providers; the JSON is also the service's agent allowlist. Both are compiled
  into the binaries and written to `<data root>/tools/` at start.
- `scripts/test_integration.py`: end-to-end tests against the real `studio-service`.

UI, CLI and MCP must share the same editor state and validated command path.
Pass expectedRevision for edits; reject stale asynchronous results. A patch carries
only the fields it changes (the service merges; this window's queued edits follow its
own revisions). Saves are deferred up to a second: flush before a slow command. Keep user
media untouched, cancellation explicit, and preview/export output consistent.
The app stores projects in `~/.byori-studio`; automated integration tests must use
isolated BYORI_STUDIO_HOME/port, never a user's current project. The packaged app
honours the same variables. See IMPLEMENTATION.md; NEXT.md lists what only the user can verify.
