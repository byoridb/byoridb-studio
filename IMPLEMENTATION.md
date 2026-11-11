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
  width, height, hasAudio, thumbnail?: string|null, waveform?: number[],
  missing?: true, proxy?: true, codec?: string, fps?: number
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
| `project.open` | `{id? ,path?}` | Opens saved Project; resets undo history. A file whose id belongs to a different stored project gets a new id |
| `project.save` | `{path?,overwrite?}` | `{path,project}`; agent tokens may not pass `path` |
| `project.update` | `{patch}` | Permitted project metadata, dimensions, concept, notes, markers |
| `project.demo` | `{}` | Creates explicit sample project using real bundled media |
| `media.import` | `{paths:string[]}` | Probes and imports 1..100 files |
| `media.importAndAdd` | `{paths,start?,trackId?,duration?}` | Imports and places sequential clips in one undoable commit; selects a suitable unlocked track if omitted |
| `media.reprobe` | `{ids:string[],expectedRevision?}` | Reprobes 1..100 distinct existing media IDs; repairs misclassified audio clips and returns Project in one undoable commit |
| `media.relink` | `{id,path,expectedRevision?}` | Points an existing media ID at another file and refreshes its metadata in one undoable commit; rejects a file of a different kind or one already in the project |
| `media.remove` | `{id}` | Rejects media still used by clips |
| `edit.add` | `{mediaId?,trackId?,start?,duration?,text?,name?,transform?}` | Adds media or text; text may be string or text object; `name`/`transform` place an overlay already named and sized |
| `edit.update` | `{id,patch}` | Deep-merges permitted clip fields; rejects locked target track |
| `edit.delete` | `{ids:string[],ripple?:boolean}` | Deletes selected clips; ripple closes only the time the deleted clips occupied alone (time still covered by a surviving, overlapping clip stays) |
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
- Filter ids are `none|cinematic|warm|cool|mono|vintage`; setting only `filter` merges brightness/contrast/saturation/temperature and keeps hsl/curves/lut/hue. `transitionIn/Out` is `null` or `{type,duration}` (types: see the second-phase contract below).
- `export.start`, `project.save {path}`, `captions.export` and (with `overwrite:false`) `presets.export` fail with `FILE_EXISTS` when the target exists unless `overwrite:true`. `project.save`/`captions.export` never write into the data root except its `exports` folder.
- `preview.frame {time,width?,client?}`: a newer request for different content ends older requests of the same `client` with `PREVIEW_CANCELLED` (the player sends `"player"`, the export dialog `"export"`; a UI request without one counts as the player). The service names each agent job's requests `agent-<hash of its token>`, so agents neither cancel the UI nor each other. A time within 1e-6 frames below a frame boundary is that frame.
- `Media.waveform` holds 128–1024 peaks (by duration) spanning the whole file, decoded from 8 kHz mono audio. Audio shorter than the container, or anything not decoded within 15 seconds, stays zero rather than stretching. Import/reprobe/relink run only FFprobe and the thumbnail under the editor lock; the waveform is computed afterwards by the service's background worker (10-minute limit) and stored without a revision or an undo entry.
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

## Second-phase contract

Added on top of everything above. The editor validates and stores, `render.rs` outputs, the frontend edits and approximates in the fast preview; the names below are identical in `src/studio/types.ts`, `editor.rs` (`EASINGS`, `TRANSITIONS`, `BLEND_MODES`) and `render.rs`.

- `Keyframe.easing?: "linear"|"easeIn"|"easeOut"|"easeInOut"|"hold"` (absent = linear) applies from that keyframe to the next: t², 1-(1-t)², 3t²-2t³, or the value held until the next keyframe.
- `Clip.transitionIn/Out: null | {type,duration}`, `type` one of `fade|dissolve|wipeLeft|wipeRight|wipeUp|wipeDown|slideLeft|slideRight|zoom` (audio clips: `fade` only). It is the clip's own entrance/exit with linear progress p (0 absent → 1 present). fade/dissolve: alpha p. wipe: a crop of the clip's own box whose edge travels in the named direction (entering reveals behind the edge, leaving hides behind it). slide: x offset `sign·(1-p)·max(0, (frame width + layer width)/2 − sign·x)`, where x is the layer's own x at that time (keyframes included) and sign is +1 towards the right edge, −1 towards the left, so at p=0 the layer lies just outside the edge wherever it rests; `slideLeft` enters from the right and leaves to the left. The fast preview uses the same expression, except that a text clip's width is taken as the frame width. zoom: scale 0.8+0.2p with alpha p. `fadeIn/fadeOut` always equal the transition duration and always drive the audio fade; the picture's alpha fades only for fade/dissolve/zoom, or for an old clip with `fadeIn/fadeOut` and no transition object. `edit.update` and `presets.apply` clamp each fade and transition to the clip's duration (a zero-length transition becomes `null`); the sum of the in and out lengths is not limited. A video clip reclassified as audio by `media.reprobe` keeps its transition lengths as `fade` and loses `blendMode`.
- Clips of one track may overlap; the one that starts later is composited on top (array order on a tie). "Transition between clips" is one `edit.batch`: the later clip and every clip after it on the track move earlier by the duration, and the later clip gets `transitionIn`. Removing it moves them back. The timeline, Library and Inspector build that batch with `clipEditing.junctionTransitionCommands` and limit the duration to half of the shorter clip, in whole frames. Because every later clip of the track is one `edit.update`, a junction followed by more than 499 clips on its track exceeds the 500-command batch limit: the timeline disables that junction with the reason, the panels show the server's error.
- `Clip.blendMode?: "normal"|"multiply"|"screen"|"overlay"|"darken"|"lighten"|"add"` (video, image and text clips; `overlay` is relative to the picture below, as in CSS).
- `Clip.text` also accepts `italic`, `letterSpacing` (px, -5..50), `lineHeight` (0.8..3, default 1.2), `outline {color,width 0..20}` and `shadow {color,x,y,blur 0..40}` (`null` clears either; `width:0` and `x=y=blur=0` mean "off" and are not drawn). Layout is the same in the browser and the export: the text wraps at 90% of the project width (words at spaces; CJK and words longer than a line by character; explicit newlines kept; closing punctuation stays with the character before it, opening brackets with the one after, and a hyphen inside a word allows a break after it — not the full UAX #14 rules, so the browser can differ on small kana, quotation marks and punctuation directly followed by Latin letters), the line box is `fontSize × lineHeight`, the background adds 12 px of padding, the outline grows outwards by `width`, a shadow's blur is the CSS text-shadow radius. There is no default shadow.
- `edit.freeze {id,time,duration?,expectedRevision?}` → Project. Video clips only: extracts the frame at timeline `time` as a managed image in `<root>/projects/<id>-assets/frames/`, splits the clip there, inserts an image clip of `duration` (default 2 s) and pushes the later clips of the track. One undo. Not available inside `edit.batch`. The frame is the last source frame at or before that time (`media::extract_frame`); the renderer rounds source frames to the nearest output slot, so the still can differ by one frame when a source frame arrives less than half an output frame late. Stills that no saved project (or archived `current.json.corrupt-*`) names are deleted at startup — nothing is deleted if any project file is unreadable — and are left out of `project.duplicate` and id-collision copies.
- `Media.proxy?: true` while `<root>/proxies/<mediaId>.mp4` exists and its `.source` note names the media's current path; like `Media.missing` it changes without a revision. Proxies (long side ≤ 1280, H.264, short keyframe interval, with audio) are built for video whose long side exceeds 1920 or whose codec is not h264/vp8/vp9/av1. `GET /assets/<id>/proxy` serves it (Range → 206, absent → 404, same authentication as `/assets/<id>`). Fast playback uses the proxy when there is one; precise frames and exports always read the original, which is never modified.
- Background media work: one worker in the service fills missing waveforms, then builds one proxy at a time. It wakes after imports, uploads, relinks, undo/redo, batches, freezes and project switches, checks every 5 s otherwise, and stops at shutdown. A relinked media's proxy is rebuilt. `media.reprobe` and `media.relink` clear that media's waveform (a re-import of the same path only when its duration or `hasAudio` changed), and the worker computes it again in the same run. A waveform that could not be decoded is stored as `[]` and retried at the next start or `project.open/new`; one whose save failed is retried only after a restart. At startup the service deletes only `proxies/` files that no saved project mentions (nothing if any project file is unreadable). `imports/` copies and `speech/<id>` results are never deleted automatically, because a project saved outside the store may be their only reference; there is no cleanup screen yet.
- Conditional `project.get {ifProjectId,ifRevision}` returns the full Project once after a waveform, proxy or missing flag changed; otherwise `{unchanged:true,id,revision,missing:[ids],proxy?:[ids]}`. The frontend accepts a same-revision Project when that derived state differs.
- `export.start` also accepts `codec?: "h264"|"hevc"` (mp4/mov), `hardware?: boolean` (default true: VideoToolbox when it works, with an automatic software retry — progress restarts from 0) and `bitrate?: number` (kbps, 100..200000, replaces CRF). `export.status` reports `encoder`.
- Old preset filter ids (`cinema`, `original`, `vivid`, `soft`) are normalised when the catalog is loaded or imported.
- `memory.search {text?,limit?,projectId?}` filters by project on the server when `projectId` is given. `runtime.mcpStatus.allowedTools` lists the Higgsfield tools actually passed to agents.

Frontend structure: the app opens on a home screen (new project by frame preset, recent projects with open/rename/duplicate/delete, demo, settings) when the open project is empty and still has the default name. The playhead lives in `src/studio/playbackClock.ts` (`useSyncExternalStore`), so playback re-renders only the player, the playhead and the timecode; a paused or explicitly sought playhead is snapped to a whole frame. Library and Inspector receive the paused playhead plus a `now()` getter for actions taken during playback. The timeline renders only clips near the visible time range and the player mounts media elements only near the playhead.

Wipes and opacity keyframes rely on FFmpeg's `sendcmd` and filter commands; this was verified with FFmpeg 9.0.2 only. A clip is drawn on the frames whose time is at or after its start and before its end, with a 0.1 ms tolerance so that boundaries such as 7/30 s, which differ from the frame time in the last binary digit, land on the intended frame.

### Verification

`npm run verify` runs the version check (`scripts/check-version.mjs`; `package.json` is the single version source, `--write` syncs the others), Vitest, `cargo test --lib`, a `studio-service` build, the Python tests including `scripts/test_integration.py` against the real binary (temporary `BYORI_STUDIO_HOME`, free port, never 43123) and the production build. `.github/workflows/ci.yml` runs the same on macOS plus `cargo clippy --all-targets -- -D warnings`.
