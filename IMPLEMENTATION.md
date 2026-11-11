# Studio implementation contract

This describes the implemented local API as of 2026-11-11. Product direction lives in PRODUCT.md and ROADMAP.md; this document describes actual requests and responses rather than future scope.

## Service and transport

The Rust service binds to `127.0.0.1:43123`. `BYORI_STUDIO_PORT` overrides the port; `BYORI_STUDIO_HOME` overrides the default data root `~/.byori-studio`. One service owns one open project. UI and agents use the same Editor and undo history.

```json
POST /rpc
Authorization: Bearer <token>
Content-Type: application/json

{"method":"edit.update","params":{"id":"clip-id","patch":{"start":2},"expectedRevision":7},"projectId":"project-id"}
```

- `params` is an object; omitted/null becomes `{}`. RPC bodies are limited to 2 MB.
- Success is HTTP 200 with `{"result": ...}`. Dispatch/validation errors are HTTP 400 with `{"error":"..."}`. Missing/invalid authentication or untrusted Origin is HTTP 401. Oversized bodies return HTTP 413.
- Top-level `projectId` is optional for ordinary RPC, and is included by per-agent MCP connections. Editor requests check it against the open project under the same editor lock used for dispatch. A mismatch returns HTTP 409 before the command runs. `memory.record` and speech start requests also validate the bound project before recording/starting; other runtime status/job queries do not switch projects.
- `params.expectedRevision`, when supplied, must be a nonnegative integer equal to the current revision. Editor dispatch checks it before handling the method; mismatches currently return HTTP 400 with an error containing `REVISION_CONFLICT`. Supply it on writes that depend on a previously read state.
- Successful mutations increment revision and atomically persist `current.json` and `projects/<id>.json`. Undo/redo also increment revision. Undo history and job registries are in memory for the service lifetime.
- `project.get` polling updates the UI. There is **no `/events` endpoint**.

The private connection file is `{url,token}` in `connection.json` with mode `0600`; the data root has mode `0700`. `GET /session` exists only in the development service (`studio-service`) and returns that connection only to Origin `http://localhost:<BYORI_STUDIO_DEV_PORT>` or `http://127.0.0.1:<BYORI_STUDIO_DEV_PORT>` (default 1420); missing Origin is rejected. The browser UI reaches the service on `VITE_STUDIO_PORT` (default 43123). Other authenticated endpoints accept these development origins plus `tauri://localhost`, `http://tauri.localhost`, and `https://tauri.localhost`. Local nonbrowser clients may omit Origin.

`GET /assets/<assetId>` and `/assets/<assetId>/thumbnail` accept `?token=...` or the bearer header and support byte ranges. IDs resolve only to current-project media or registered generated previews. There is no arbitrary-path file-serving endpoint.

### Browser uploads

```text
POST /upload?name=<URL-encoded-filename>&projectId=<URL-encoded-project-id>
Authorization: Bearer <token>
<body: raw file bytes>
```

`projectId` is required. Before streaming, the service checks that ID and captures the current revision. The body is streamed into a unique sanitized filename under `imports/`, with a 2 GB per-file limit. After receiving the body, the service locks the Editor, verifies both the captured project ID and revision, then dispatches with `expectedRevision`:

- `.srt` filenames → `captions.import {path,expectedRevision}`.
- Other filenames → `media.import {paths:[path],expectedRevision}`.

Success returns `{"result":Project}`. Missing ID is HTTP 400; wrong ID or a project/revision change during upload is HTTP 409. Failed imports and conflicted uploads remove the staged file. Concurrent edits therefore cannot redirect an upload into another project. Sequentially upload multiple files and use each resulting Project to refresh the UI.

### Native commands

- `studio_connection()` → `{url,token}`.
- `studio_open_files({extensions?:string[]})` → `string[]` of selected local paths; cancellation returns `[]`. Defaults include media, SRT and LUT. Font/preset callers request `ttf|otf` or `json|cube|3dl` filters.
- `studio_save_file({name,extension?})` → local path or `null`.

Tauri embeds the Python MCP/CLI scripts into the Rust binary, copies them to `tools/`, and bundles `public/demo/` as `demo/`. Native setup exposes the bundled demo directory through `BYORI_STUDIO_DEMO_DIR`.

## Rust API

```rust
Editor::new(root: PathBuf) -> Result<Editor, String>
Editor::dispatch(&mut self, method: &str, params: Value) -> Result<Value, String> // async
Editor::asset_path(&self, id: &str, thumbnail: bool) -> Option<PathBuf>
Runtime::dispatch(&self, method: &str, params: Value) -> Result<Value, String> // async
```

Editor handles `project.*`, `media.*`, `edit.*`, `history.*`, `color.*`, `captions.*`, `assets.*`, `fonts.*`, `presets.*`, `preview.start`, and `export.*`. HTTP `preview.frame` snapshots Editor state and delegates to PreviewFrames outside the editor lock. Runtime handles `runtime.*`, `agent.*`, `memory.*`, and forwards `speech.*` to Speech.

## Types and units

Keys are camelCase and IDs are strings. Timeline positions, source offsets, durations, keyframe times and fades are **seconds**. `updatedAt`, `createdAt`, `checkedAt`, `startedAt`, `finishedAt`, and job-log `at` values generated by Rust are numeric **Unix epoch milliseconds**. Do not parse these numbers as seconds or require ISO strings. SRT itself uses `HH:MM:SS,mmm`.

```text
Project {
  id, name, revision, width, height, fps, background,
  media: Media[], tracks: Track[], clips: Clip[], markers: Marker[],
  concept: {audience, message, appeal, direction}, notes: Note[], updatedAt
}
Media {
  id, name, path, kind: "video"|"audio"|"image", duration,
  width, height, hasAudio, thumbnail?: string|null, waveform?: number[]
}
Track {id, name, kind: "video"|"audio"|"text", muted, hidden, locked}
Marker {id, time, label}
Note {id, body, createdAt, kind, clipId?}
Clip {
  id, mediaId?, trackId, name, kind: "video"|"audio"|"image"|"text",
  start, duration, sourceIn, speed, reverse, volume, fadeIn, fadeOut,
  transform: {x, y, scale, rotation, opacity, flipX?, flipY?},
  color: ColorAdjustment, keyframes: Keyframe[],
  text?: {content, fontSize, color, fontFamily, fontId?, fontPath?, bold, align, background},
  crop?, mask?, chromaKey?, audio?, stabilize?, groupId?,
  filter?, transitionIn?, transitionOut?
}
```

Transform defaults: `x=0,y=0,scale=1,rotation=0,opacity=1`; x/y are project pixels, rotation is degrees, flips are booleans. Volume defaults to 1. Text align is `left|center|right`; background accepts `transparent` or a supported color. Captions are ordinary `kind:"text"` clips rather than a separate caption kind.

`Keyframe {property,time,value}` uses clip-relative timeline seconds. Supported properties are `transform.x`, `transform.y`, `transform.scale`, `transform.rotation`, `transform.opacity`, their short names, and `volume`. Values interpolate linearly. Split and duration changes preserve/trim keyframes according to clip boundaries.

Optional clip processing objects:

```text
crop: {x?,y?,width?,height?}                   // normalized source coordinates
mask: {type:"none"|"circle"|"rectangle",x?,y?,width?,height?,feather?}
chromaKey: {enabled?,color?,similarity?,blend?}
audio: {normalize?,denoise?,voiceEnhance?,eq?:{bass?,mid?,treble?}}
stabilize: {enabled:boolean,strength?:1|2|3}  // video only; single-pass FFmpeg deshake
```

Crop x/y are 0..1, width/height 0.01..1, and the rectangle must stay within the source. Mask x/y are normalized centers 0..1, width/height 0.01..2, feather 0..1. Chroma similarity is 0.01..1 and blend 0..1. Audio EQ values are -20..20 dB. Stabilization is not tracking, optical flow or a two-pass vidstab analysis.

### ColorAdjustment

```text
{
  brightness: -1..1, contrast: 0..3, saturation: 0..3, temperature: -1..1,
  hue?: -180..180,
  hsl?: {
    red?, yellow?, green?, cyan?, blue?, magenta?
    // each {hue?:-180..180,saturation?:-1..1,lightness?:-1..1}
  },
  curves?: {
    preset?: string,
    master?: [number,number][], red?: [number,number][],
    green?: [number,number][], blue?: [number,number][]
  },
  lut?: {path?:string,name?:string,enabled:boolean}
}
```

Base color defaults are brightness 0, contrast 1, saturation 1, temperature 0. HSL channel adjustments default to zero; the lightness control maps to FFmpeg huesaturation intensity. Curve channels accept an empty array to clear custom points, or 2..16 `[x,y]` points in 0..1, with strictly increasing x and endpoints at x=0 and x=1. Presets are `none`, `color_negative`, `cross_process`, `darker`, `increase_contrast`, `lighter`, `linear_contrast`, `medium_contrast`, `negative`, `strong_contrast`, `vintage`.

Use `color.importLut` to validate and copy a `.cube` or `.3dl` into managed project assets, then attach it to the selected clip. LUTs are at most 10 MB; supported 3D cube dimensions are 2..65. Project save to another path copies managed LUT assets. `edit.update` can toggle the existing `color.lut.enabled`. Rendering and preview use the same color/stabilization composition path.

## Editor RPC

All Editor methods accept optional `expectedRevision` as described above. Mutating methods return the updated Project unless noted.

| Method | Parameters | Result / behavior |
| --- | --- | --- |
| `project.get` | `{ifProjectId?,ifRevision?}` | Project, or `{unchanged:true,id,revision,missing:string[]}` when both match and no `Media.missing` flag changed in this call; `missing` lists the ids of media whose file is absent |
| `project.list` | `{}` | `[{id,name,updatedAt}]` |
| `project.new` | `{name?,width?,height?,fps?}` | New Project; resets session undo history |
| `project.open` | `{id? ,path?}` | Opens saved Project; resets undo history |
| `project.save` | `{path?,overwrite?}` | `{path,project}`; agent tokens may not pass `path` |
| `project.update` | `{patch}` | Permitted project metadata, dimensions, concept, notes, markers |
| `project.demo` | `{}` | Creates explicit sample project using real bundled media |
| `media.import` | `{paths:string[]}` | Probes and imports 1..100 files |
| `media.importAndAdd` | `{paths,start?,trackId?,duration?}` | Imports and places sequential clips in one undoable commit; selects a suitable unlocked track if omitted |
| `media.reprobe` | `{ids:string[],expectedRevision?}` | Reprobes 1..100 distinct existing media IDs; repairs misclassified audio clips and returns Project in one undoable commit |
| `media.relink` | `{id,path,expectedRevision?}` | Points an existing media ID at another file and refreshes its metadata in one undoable commit; rejects a file of a different kind or one already in the project |
| `media.remove` | `{id}` | Rejects media still used by clips |
| `edit.add` | `{mediaId?,trackId?,start?,duration?,text?}` | Adds media or text; text may be string or text object |
| `edit.update` | `{id,patch}` | Deep-merges permitted clip fields; rejects locked target track |
| `edit.delete` | `{ids:string[],ripple?:boolean}` | Deletes selected clips; ripple closes their union of intervals on each affected track |
| `edit.split` | `{id,time}` | `time` is absolute timeline time |
| `edit.trim` | `{id,start?,end?,expectedRevision?}` | Retains absolute timeline bounds, with at least one boundary supplied; omitted bounds stay unchanged. Minimum one frame. Video/audio extension is source-bounded; still/text extension is unbounded. One commit/undo. |
| `edit.duplicate` | `{ids:string[]}` or legacy `{id}` | Preserves relative spacing; offsets the selection by its total time span; assigns new clip/group IDs |
| `edit.group` | `{ids:string[]}` | At least two clips; assigns common persistent groupId |
| `edit.ungroup` | `{ids:string[]}` | Removes groupId from selected clips |
| `edit.track` | `{id,patch}` or `{kind:"video"\|"audio"\|"text",name?,clipIds?:string[]}` | Updates name/muted/hidden/locked, or atomically creates a track and optionally moves compatible selected clips into it |
| `edit.marker` | `{time,label}` | Adds timeline marker |
| `edit.batch` | `{commands:[{method,params}],expectedRevision?}` | Atomic set of edit commands; one commit/undo entry; failures leave project unchanged |
| `color.importLut` | `{id:clipId,path}` | Validates/copies LUT and updates color.lut; rejects audio clips |
| `history.undo` / `history.redo` | `{}` | Updated Project |
| `history.status` | `{}` | `{canUndo,canRedo}` |
| `captions.import` | `{path}` | Parses SRT and adds editable text clips |
| `captions.export` | `{path,overwrite?}` | `{path}` containing exported SRT |

Selection is frontend state; groupId persists in Project. Multi-clip move uses an atomic batch of `edit.update`. Callers must send all intended selected IDs; one `edit.update` does not implicitly update every member of a group.

Clip editing uses the same `edit.trim` contract from handles, Q/W shortcuts and MCP. For old timeline `[s,e]`, new `[a,b]`, source lower bound `q` and speed `v`, forward trim uses `q+(a-s)*v`; reverse uses `q+(e-b)*v`. Keyframes rebase by `a-s`, interpolate retained boundaries, and hold endpoint values through extension. Fades clamp to the retained duration and transition metadata stays synchronized. Split requires at least one frame on each side; validation retains legacy 0.01-second clips while allowing a full frame at 120fps. Multi-selected playhead actions batch only clips crossing the cut, with expectedRevision on the outer batch. Pointer snapping preserves exact media edges; handle arrow nudges preserve a full-frame delta even from off-grid boundaries. Normal playback clocks and memoized timeline visuals are unchanged.

The selected target track is also frontend state. The library uses it for compatible media/text additions. The timeline supports explicit video/audio/text track creation, inline rename, existing-track moves, and new-track separation. Vertical dragging accepts only compatible unlocked destinations; horizontal dragging preserves the original tracks of a multi-layer selection. Creating a track with `clipIds` preserves clip identity, timing, settings and group membership, and is one undo entry. A stale revision, locked source or incompatible clip kind rejects the operation without a partial track or move.

Later entries in `Project.tracks` composite above earlier visual entries. New tracks are inserted after the last of their kind; new video tracks are additionally kept before the first text track, preserving captions above new footage. `edit.trackMove` and the track header's up/down buttons reorder tracks; `edit.trackDelete` removes an unlocked track with its clips.

Media probing ignores attached album artwork and timed thumbnails when deciding whether a file has playable video. An MP3 with only audio plus cover art is an audio asset. `media.reprobe` refreshes metadata without replacing the existing media ID, name or source path. If a former video asset proves to be audio, its video clips become audio clips on new audio tracks associated with their original layers; source-track mute/visibility and clip timing, source offset, volume and other settings are retained. Video stabilization is disabled on those repaired audio clips. Reimporting an existing source path uses the same repair without creating a duplicate asset. Locked referenced tracks, unknown/duplicate IDs or revision conflicts reject the whole project change. This is an explicit repair, not an automatic rewrite when opening a project.

### Reusable fonts and presets

Catalog data lives in `catalog/index.json`; changes to this application-wide catalog do not create project undo entries. Apply commands return an updated Project and make one validated, undoable commit. Send the top-level `projectId` and `expectedRevision` for project-dependent operations.

| Method | Params | Result / behavior |
| --- | --- | --- |
| `assets.list` | `{}` | `{fonts:Font[],presets:Preset[]}` |
| `fonts.import` | `{path,name?}` | Validates TTF/OTF (nonempty, at most 32MB), copies into `catalog/fonts/`, deduplicates by content hash; returns Font |
| `fonts.apply` | `{id,clipId,expectedRevision?}` | Sets a text clip's managed font references; rejects non-text clips and locked tracks |
| `fonts.remove` | `{id}` | Removes catalog entry; retains immutable files for existing projects/undo |
| `presets.save` | `{clipId,name,kind:"filter"|"effect",expectedRevision?}` | Captures supported settings from the current clip; returns Preset |
| `presets.import` | `{path}` | Validates Studio preset JSON v1 (at most 16MB); returns newly registered Preset |
| `presets.export` | `{id,path}` | `{path}`; exports portable JSON and embeds required LUT text |
| `presets.apply` | `{id,clipId,expectedRevision?}` | Deep-merges supported settings; scales keyframe/fade/transition timing to target duration |
| `presets.remove` | `{id}` | Removes catalog entry without deleting referenced managed dependencies |

`Font {id,name,family,path}` uses a hash-based ID and a unique CSS family. Managed fonts are available through authenticated `/assets/<fontId>` even after removal from the catalog. Browser FontFace registration and the exact raster renderer use the managed font bytes. Imported-font bold uses synthetic glyph emboldening; a missing imported file produces a render error. Choosing a system family sends only the new `fontFamily`, allowing Editor to clear managed references.

`Preset {id,name,version:1,kind,target:"visual"|"audio",sourceDuration,patch,createdAt}` stores declarative editing settings. Filters capture color/LUT settings; visual effects capture transform/crop/mask/chroma/stabilization/fades/keyframes; audio effects capture volume/fades/keyframes/audio processing. Unsupported fields, executable expressions and incompatible target types are rejected. Exported LUTs use `lutData:{extension,name,content}` instead of local paths; imported JSON may not instruct the app to read an arbitrary LUT path. These presets are not arbitrary third-party effect plugins. Project packaging and transferring managed font/media dependencies remain separate work.

### Rendering and previews

- `export.start {path?,width?,height?,fps?,format?,crf?,start?,end?,overwrite?}` → `{id}`. Formats are `mp4|mov|webm|mp3|wav`; the extension must match. MP3/WAV render the timeline audio mix. Range is absolute seconds. Output may not overwrite current source media or a path used by a running export.
- `export.status {id}` → `{id,state,progress,path,projectRevision,error?}`. `progress` is 0..1; states are `queued|running|completed|failed|cancelled`. Exports render a captured Project snapshot, not later edits.
- `export.cancel {id}` → `{id,state:"cancelling"}` for an active job, otherwise its current status. Poll until terminal.
- `preview.frame {time,width?,expectedRevision?}` → `{path,assetId,width,height,time,revision,projectId,cacheHit}`. Actual PNG composed by the render pipeline. Width defaults to 640, clamped to 64..1920 and even pixels.
- `preview.start {width?}` → `{id,assetId,revision}`. Starts an MP4 preview export; poll `export.status`. Width defaults to 960, capped at 960. Once completed, use `/assets/<assetId>` with authentication. Preserve revision to avoid presenting old previews as current.

HTTP frame rendering captures immutable project state under the Editor lock, releases it while FFmpeg runs, and rejects changed project/revision results before registering assets. A single renderer and bounded request admission deduplicate work; a 32-entry content/time/size cache retains recent frames. Assets are registered for the current service lifetime and removed on cache eviction. They are not arbitrary filesystem URLs.

The UI defaults to immediate local-media playback (`빠른 재생`) with a visible approximate-preview label; complex LUT/mask/audio/reverse processing may differ from final output. `정밀 재생` still uses the full FFmpeg proxy. Paused exact frames use 120ms debounce, one in-flight request, latest-request replacement and a client cache. Transient slider/text/filter-hover drafts deep-merge into a Player-only project and suppress stale exact overlays; they never enter persistence/export. A committed edit still uses the shared revision-checked command path.

Local media elements stay mounted across clip boundaries and are primed silently from the playback gesture. Audio within three seconds of the playhead requests automatic preloading; distant clips request metadata. The playback controller waits for metadata before seeking. Explicit timeline/player/keyboard seeks increment a frontend-only `seekEpoch`, including replay from the end. A delayed animation frame is not a seek request. Continuous forward playback does not periodically rewrite `currentTime` to correct clock drift; initial activation, explicit seeking and source mapping changes remain seek boundaries. A ready layer held for another layer's buffering pauses without seeking itself and creating another buffering cycle. Native rate, mute and volume properties are assigned only when their values change. Timeline waveform/thumbnail/text visuals and ruler ticks are memoized separately from live editing handlers and the playhead.

Track visibility controls the visual layer; track mute and the player's master mute control sound. Precise proxy playback silences local sources to avoid duplicate audio. A rejected playback start is surfaced and stops the transport instead of silently advancing. Media readiness still gates timeline progress and has a bounded error timeout. Regression tests cover these control paths; the isolated browser harness in `scripts/preview-playback-check.html` additionally counts native media seeks, rate writes and playback events. Neither mocked tests nor timeline progression alone establish smooth or audible output from the native macOS app; that remains a separate foreground playback and listening check.

## Local speech RPC

- `speech.status {}` → `{whisperAvailable,ttsAvailable,voices:[{id,name,language}],models:["tiny","base","small"],modelDirectory}`. `language` in voices is a language tag such as `en-US`; voice `id` is accepted unchanged by synthesize.
- `speech.transcribe {language?:"ko"|"en"|"auto",model?:"tiny"|"base"|"small",translate?:boolean}` → `{id,state:"running"}`. Defaults are auto/base/false. Renders full timeline audio to WAV, runs local Whisper on CPU, creates SRT, then imports captions. `translate:true` requests English translation. First use downloads the chosen model into `models/whisper/`.
- `speech.synthesize {text,voice?,rate?,start?}` → `{id,state:"running"}`. Uses installed macOS system voices to generate AIFF, then `media.importAndAdd`. Text is nonempty and at most 10,000 characters; rate defaults to 175 and is clamped to 80..400; start defaults to 0 and must be nonnegative seconds.
- `speech.job {id}` → `{id,kind:"transcribe"|"synthesize",state,progress,projectId,revision,startedAt,finishedAt?,logs:[{at,text}],message?,output?,result?:Project,error?}`.
- `speech.cancel {id}` → current job; requests cancellation. Poll until `cancelled` or another terminal state.

Speech states are `running|completed|failed|cancelled`; progress is 0..1. Each job captures project ID and revision, and checks both under the Editor lock before committing. A changed project is not overwritten: job fails explicitly, keeps any generated output path, and leaves the project unchanged. Cancellation also cancels its preparatory audio render or speech subprocess. Successful insertion is one undoable commit.

## Runtime, CLI agents and ByoriDB

`runtime.status {}` returns:

```text
{
  ffmpeg:{available,path?,version?},
  providers:[{id:"claude"|"codex"|"gemini",name,available,path?,version?,authStatus}],
  byoridb:{installed,home,version?,running,connected,url,error?,managed},
  connection:{url}
}
```

An installed CLI is not proof of authentication. Status uses the provider's available local probe; an actual login failure remains a failed agent job.

- `runtime.checkUpdate {}` → `{installedVersion,latestVersion,tag,url,updateAvailable,checkedAt}`. Queries official GitHub stable release metadata; absent/unknown installed version can produce `updateAvailable:null`.
- `runtime.install {tag}` → `{id,state:"running"}`. Validates a stable semantic version and platform asset, prevents downgrade, downloads/validates the release, preserves existing data and credentials, and replaces the binary with rollback on failure. Existing known Byori installations are reused. Live unmanaged external DB processes are not replaced.
- `runtime.installStatus {id}` → `{id,kind:"install",state,progress,logs:[{at,stream,text}],tag,error?}`. Installation does not currently offer mid-transaction cancellation.
- `runtime.start {}` → RuntimeStatus after attempting to start the detected local DB.
- `agent.list {}` → up to 50 recent jobs `[{id,provider,state,projectId,startedAt,finishedAt?}]`, newest first.
- `agent.start {provider:"claude"|"codex"|"gemini",prompt,clipId?}` → `{id}`. The job gets its own token; the service limits that token to the methods in `scripts/studio-tools.json` (403 otherwise), to the project open at start (409 after a switch) and to the job's lifetime (401 afterwards). Agent file output is new files only, in `<data root>/exports` or the user's Movies/Videos/Documents/Desktop/Downloads/Music folders. Uses the locally installed CLI, a per-job working directory and MCP configuration, and a connection file bound to the original project ID. Prompts are nonempty and limited to 64 KB.
- `agent.status {id}` → `{id,provider,state,projectId,startedAt,finishedAt?,logs:[{at,stream,text}],result?:string,error?,authRequired?}`. States are `running|cancelling|completed|failed|cancelled`; completion describes the CLI session, and actual edits must be confirmed by tool results/Project state.
- `agent.cancel {id}` → current job; requests process-group termination. Agent runtime is limited to 15 minutes. `runtime.cancel` is an alias for this job-cancellation handler; an install without a cancellation channel is unchanged.
- `memory.search {text?,limit?}` → `{items:MemoryNote[],source:"byoridb"}`. Defaults: empty search and limit 30, clamped 1..100. Searches persisted creative records across projects.
- `memory.record {body,kind?,clipId?}` → MemoryNote `{id,body,kind,createdAt,projectId,clipId,source:"byoridb"}`. Body is nonempty, at most 64 KB; kind defaults to `feedback`. Uses the open/bound project ID. Success means an actual DB insert.

Memory uses the local ByoriDB HTTP session/query API, space `studio_creative`, tag `studio_note(id,body,kind,project_id,clip_id,ts)`. The server's session ID may be a decimal string or integer; Rust normalizes it internally. Credentials are read from the detected installation/environment and are not included in RPC responses or child-agent environment overrides.

### Higgsfield connection

- `runtime.mcpGet {}` / `runtime.mcpStatus {}` → `{id,name,url,added,enabled,phase,toolCount,checkedAt,error,bridgeAvailable,bridgePackage}`.
- `runtime.mcpSave {enabled:boolean}` adds/updates the Studio-owned connection.
- `runtime.mcpConnect {}` starts asynchronous OAuth/connection verification; poll status. Only `initialize` and `tools/list` are used for verification.
- `runtime.mcpCancel {}` requests cancellation of connection verification.
- `runtime.mcpRemove {}` removes Studio's connection/auth cache. Active verification or agent use prevents removal until that activity ends.

Phases are `unchecked|connecting|cancelling|connected|failed|cancelled`. The fixed server is `https://mcp.higgsfield.ai/mcp`, reached with `mcp-remote@0.15.2` through `npx`. Config, OAuth and npm cache live under `mcp/higgsfield/`; credentials are not returned by RPC or copied into projects/ByoriDB. The user's global CLI configuration remains untouched. After service restart, connection verification must be repeated; the bridge can reuse Studio's saved OAuth cache.

Enabled, verified connections are leased to subsequent Claude Code/Codex/Gemini jobs. All three adapters currently expose only `models_list`, `models_get`, `models_search`, `models_recommend`, `balance`, and `get_preferences`. `toolCount` reports discovered server tools, not the size of this client allowlist. Paid generation and other mutating tools are unavailable until the cost/approval/application flow is implemented. A missing/unverified optional connection does not block local editing.

References: [Higgsfield connection guide](https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent), [mcp-remote](https://github.com/punkpeye/mcp-remote).

## MCP / direct CLI

`scripts/studio-mcp.py` is a dependency-free Python stdio MCP server. `scripts/studio-cli.py` calls the same authenticated RPC methods. Both default to `~/.byori-studio/connection.json` and honor `BYORI_STUDIO_HOME`; `--connection <path>` selects a connection file. The agent-facing methods are defined once in `scripts/studio-tools.json`, which the MCP server, the CLI and the service's server-side agent allowlist all read. Per-agent files include `projectId`, which the bridge forwards as the top-level RPC field.

Six tools expose explicit allowlists: `studio_project`, `studio_edit`, `studio_export`, `studio_memory`, `studio_speech`, `studio_assets`. They accept `{method,params?}`. The assets tool exposes the font/preset catalog and validated application commands. The editing tool includes group/ungroup, multi-duplicate, managed LUT import and atomic media import/place. The export tool includes both preview methods; `preview.frame` additionally returns a PNG image block when its generated file is below 10 MB. Unsupported methods and backend errors produce `isError:true`.

The allowlists are narrower than the full service: they do not expose runtime software installation, spawning other agents, or arbitrary shell execution. See `scripts/studio-tools.json` for the authoritative lists. Each CLI receives workspace-local Studio configuration rather than a mutation of the user's global CLI settings.

## Schema version 2 additions

Projects carry `schemaVersion` (currently 2); older files are migrated when opened and newer ones are refused. An unreadable `current.json` is kept as `current.json.corrupt-<ms>` and the most recent valid project (or an empty one) is opened; `project.notice {}` → `{notice}` reports it and `project.noticeDismiss {}` clears it.

- `project.delete {id}` → list (the open project is refused), `project.duplicate {id}` → `{id,name,updatedAt}` (not opened), `project.rename {id,name}` → list.
- `Media.missing` is `true` while the source file is absent (refreshed without a revision bump); `media.relink {id,path,expectedRevision?}` → Project.
- `edit.trackDelete {id}`, `edit.trackMove {id,index}`, `edit.markerUpdate {id,time?,label?}`, `edit.markerDelete {id}`, `edit.paste {clips,at}` → Project; all accept `expectedRevision` and undo in one step.
- Filter ids are `none|cinematic|warm|cool|mono|vintage`; setting only `filter` merges brightness/contrast/saturation/temperature and keeps hsl/curves/lut/hue. `transitionIn/Out` is `null` or `{type:"fade",duration}`.
- `export.start`, `project.save {path}`, `captions.export` and (with `overwrite:false`) `presets.export` fail with `FILE_EXISTS` when the target exists unless `overwrite:true`. `project.save`/`captions.export` never write into the data root except its `exports` folder.
- `preview.frame`: a newer UI request for different content ends older UI requests with `PREVIEW_CANCELLED`. Agent requests neither cancel nor are cancelled.
- `Media.waveform` holds 128–1024 peaks (by duration) spanning the whole file, decoded from 8 kHz mono audio. Audio shorter than the container, or anything not decoded within 15 seconds, stays zero rather than stretching. Probing (FFprobe, thumbnail, waveform) runs inside the import/reprobe/relink command under the editor lock.
- Text clips name themselves after at most the first 1000 bytes of their content. `presets.apply`/`presets.import` accept old filter ids (`cinema` → `cinematic`, unknown → `none`).
- A successfully applied transcription removes its work folder, so its `speech.job` has no `output`.

### Windowed rendering

Frames, preview ranges and export ranges use the same filter graph as a full export. For a window that starts inside a forward video/audio clip, FFmpeg seeks the input to 0.5 s of source before the window, decodes 0.5 s past its end, restores full-timeline timestamps with `setpts` (compensating the seek's rounding to stream ticks) and trims to the window, so a windowed frame equals the same frame of the full render. Reversed clips decode only their window and are re-timed from zero. A slow-motion or low-fps clip holds its last source frame to the clip end.

### Agent tokens

`agent.start` issues a token for that job only. The service accepts it only for methods listed in `scripts/studio-tools.json` (HTTP 403 otherwise), only while the project open at start is still open (409) and only while the job runs (401). With it, `project.save` takes no `path`, and export/caption/preset output must be a new file in `<data root>/exports` or the user's Movies/Videos/Documents/Desktop/Downloads/Music folders. The UI token in `connection.json` is unrestricted.

### Process lifetime

Agents, speech tools, MCP probes and a Studio-started ByoriDB run in their own process groups, which are terminated and then killed on cancel and on shutdown. At exit the app and `studio-service` also kill their remaining direct children (a running FFmpeg export) and delete the `.<name>.<id>.partial.<ext>` files of unfinished exports. `previews/` and `renders/` are emptied at the next start. `studio-service` refuses to start while the desktop app's service owns the port; the app attaches to a compatible running `studio-service` and refuses a second app instance.

### Removed

The earlier database-explorer UI (`src/components/` and its stylesheets) and `src-tauri/src/client.rs` are deleted. ByoriDB is reached only through `runtime.rs`.
