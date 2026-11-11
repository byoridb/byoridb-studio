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
npm run tauri build -- --bundles app
```

FFmpeg/ffprobe and Python 3 are required for media/MCP. Whisper is optional for
automatic captions; macOS say supplies TTS. Reuse installed CLI authentication;
never replace a user's global Claude/Codex/Gemini settings. See README.md.

## Active Architecture

- `src/App.tsx`, `src/studio/`: workspace, library, player, inspector, timeline,
  agent/memory panel, export and runtime settings.
- `src-tauri/src/editor.rs`: authoritative project, validated commands, revision,
  transactional batches, undo/redo and persistent autosave.
- `media.rs`, `render.rs`: probing, thumbnails, waveforms and FFmpeg rendering.
- `service.rs`: loopback RPC/upload/assets, origin and bearer-token checks.
- `runtime.rs`: ByoriDB setup/memory and CLI provider processes.
- `speech.rs`: cancellable Whisper and system TTS jobs.
- `catalog.rs`, `preview.rs`, `mcp_connections.rs`: font/preset catalog, exact preview
  frames outside the editor lock, Higgsfield MCP connection.
- `main.rs`: native shell/file dialogs; `bin/studio-service.rs`: browser dev service.
- `scripts/studio-mcp.py`, `scripts/studio-tools.json`: project-scoped tools shared by the
  three CLI providers; the JSON is also the service's agent allowlist.

UI, CLI and MCP must share the same editor state and validated command path.
Pass expectedRevision for edits; reject stale asynchronous results. Keep user
media untouched, cancellation explicit, and preview/export output consistent.
The app stores projects in `~/.byori-studio`; automated integration tests must use
isolated BYORI_STUDIO_HOME/port, never a user's current project. See IMPLEMENTATION.md.
