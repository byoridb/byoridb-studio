# Byori Studio

Byori Studio는 CapCut Desktop의 미디어 라이브러리·플레이어·속성 패널·멀티트랙 타임라인 배치를 따른 영상 편집기입니다. 영상의 컨셉, 편집 방향, 소구점과 피드백을 ByoriDB에 기록하고, Claude Code·Codex·Gemini CLI가 같은 편집 도구를 호출하도록 연결합니다.

현재 코드는 실제 미디어 가져오기, 편집, 합성 미리보기와 파일 내보내기가 가능한 첫 구현입니다. 아래의 구현 범위와 제한을 기준으로 사용해주세요. 제품의 전체 목표는 [PRODUCT.md](./PRODUCT.md), 다음 작업은 [NEXT.md](./NEXT.md)에 있습니다.

## 구현된 기능

| 영역 | 현재 기능 |
| --- | --- |
| 프로젝트 | 새 프로젝트, 저장·열기, 자동 저장, 화면 비율·해상도·FPS, 실행 취소·다시 실행, 실제 미디어를 사용하는 데모 프로젝트 |
| 미디어 | 영상·음성·이미지 가져오기, 앨범 커버가 있는 MP3의 오디오 분류, 기존 소재 분류 재검사, 썸네일·파형, 검색, 드래그 배치 |
| 타임라인 | 영상·오디오·자막 트랙 추가·선택·이름 변경, 레이어 간 이동·새 트랙 분리, 트림·분할, 리플 삭제, 다중 선택·복제·그룹, 스냅, 줌, 마커, 트랙 잠금·숨김·음소거 |
| 영상 | 위치·크기·회전·불투명도, 크롭·좌우/상하 반전, 일반 속도·역재생, 키프레임, 페이드, 원형·사각형 마스크, 크로마키 |
| 색상 | 밝기·대비·채도·색온도·색조, 6색 HSL, 커브 프리셋·RGB 점, `.cube`/`.3dl` LUT 가져오기·관리 복사 |
| 보정·오디오 | 단일 패스 deshake 안정화, 음량·페이드, 정규화·노이즈 감소·음성 강조·3밴드 EQ |
| 텍스트·자막 | TTF/OTF 글꼴 추가·적용, 텍스트·스티커 프리셋, 글꼴·크기·색·배경·정렬, SRT 가져오기·내보내기, 로컬 Whisper 자동 자막, macOS 시스템 음성 내레이션 |
| 추가 소재 | 필터·효과 설정 저장·재사용, Studio JSON 프리셋 가져오기·내보내기, 목록 관리 |
| 미리보기 | 즉시 시작하는 빠른 재생, 정밀 FFmpeg 재생·정지 프레임, 캐시, 슬라이더·텍스트·필터의 저장 전 미리보기 |
| 출력 | FFmpeg 합성 출력, MP4·MOV·WebM·MP3·WAV, 해상도·FPS·품질·구간 설정, 진행률·취소·오류 표시 |
| 창작 기억 | 컨셉·시청자·메시지·소구점 입력, ByoriDB 피드백 기록·검색, 프로젝트·클립 식별자 연결 |
| 에이전트 | 로컬 CLI 감지, 프로젝트별 MCP 연결, 실제 편집 명령, 진행 로그·완료·실패·중단, 수정 후 타임라인 갱신·실행 취소 |
| 외부 MCP | Higgsfield 추가·활성화·OAuth 연결 확인·취소·삭제, 인증된 연결의 모델·크레딧 조회 도구를 세 CLI에 전달 |
| ByoriDB | 기존 Byori 설치 감지·재사용, 설치/실행/연결 상태, 공식 최신 안정 버전 조회, 플랫폼별 설치·업데이트 작업·실패 복원 |

효과와 전환 라이브러리는 모션·색상·마스크·페이드 프리셋과 사용자가 저장한 설정을 사용합니다. 필터·효과 탭의 **내 필터/내 효과**에서 설정을 저장하거나 Studio 프리셋 JSON을 가져올 수 있고, 텍스트 탭과 텍스트 속성의 **글꼴 추가**에서 TTF/OTF 파일을 추가할 수 있습니다. 임의의 실행형 효과 플러그인을 설치하는 기능은 아닙니다.

기본 **빠른 재생**은 소재를 즉시 재생합니다. LUT·마스크·오디오 효과·역재생 등 복잡한 처리는 근사 화면일 수 있으므로 최종 결과는 **정밀 재생** 또는 내보내기에서 확인해주세요. 정지 상태에서는 별도로 정확한 합성 프레임을 준비하며, 렌더 중에도 편집을 계속할 수 있습니다.

재생 시 오디오 요소를 유지하고, 메타데이터를 기다린 뒤 필요한 시점에만 재생 위치를 맞춥니다. 플레이어의 소리 버튼으로 전체 미리보기를 음소거할 수 있으며, 트랙 숨김은 화면에만 적용하고 소리는 해당 트랙의 음소거 버튼으로 제어합니다. 정밀 재생에서는 렌더된 소리만 재생합니다. 재생이 차단되면 오류를 표시하고 멈춥니다. 이 수정의 네이티브 앱 스피커 출력은 아직 직접 청취 검증하지 않았습니다.

기존 MP3가 영상으로 들어갔다면 미디어 또는 오디오 탭의 **오디오 분류 다시 확인**을 사용하세요. 원본을 다시 검사해 잘못 분류된 클립을 오디오 트랙으로 옮기며, 클립 ID·배치 시각·길이·음량 설정을 유지합니다. 한 번의 실행 취소로 되돌릴 수 있고, 해당 클립의 트랙이 잠겼다면 먼저 잠금을 해제해야 합니다.

타임라인의 **트랙 추가**에서 영상·오디오·자막/텍스트 레이어를 만들고 빈 행이나 트랙 아이콘을 선택하면, 라이브러리에서 추가하는 호환 소재와 텍스트가 그 트랙에 들어갑니다. 선택 클립은 **트랙 이동 → 새 트랙으로 분리**하거나 같은 종류의 행으로 위아래 드래그할 수 있습니다. 트랙 이름을 직접 편집할 수 있으며, 새 영상 레이어는 자막을 가리지 않도록 자막보다 아래에 합성됩니다.

클립을 선택하고 재생 헤드를 원하는 위치로 옮긴 뒤 **나누기 (⌘B / Ctrl+B)**, **앞부분 자르기 (Q)**, **뒷부분 자르기 (W)**를 사용하세요. 앞부분 자르기는 헤드 이전을, 뒷부분 자르기는 헤드 이후를 제거합니다. 여러 클립을 선택하면 해당 위치를 가로지르는 클립을 한 번에 편집하며, 한 번의 실행 취소로 되돌립니다. 선택 클립 양끝의 손잡이를 드래그해 길이를 줄이거나 원본 범위 안에서 늘릴 수 있고, 손잡이에 포커스한 뒤 좌우 방향키로 1프레임씩 조절할 수 있습니다. 이미지·자막은 원본 재생 길이 제한 없이 늘릴 수 있습니다. 트림은 빈 구간을 자동으로 당기지 않습니다.

 자동 자막은 **현재 타임라인의 전체 오디오**를 처리하며 한국어·영어·자동 감지, tiny/base/small 모델과 영어 번역을 지원합니다. 내레이션은 선택한 시스템 음성으로 생성해 지정한 시각의 오디오 트랙에 넣습니다. 두 음성 작업 모두 시작 이후 프로젝트가 변경되면 자동 적용을 중단하고 생성 파일을 보관합니다.

## 실행 요건

현재 종단 검증 환경은 Apple Silicon macOS입니다. 다른 운영체제의 패키징과 전체 기능은 아직 검증하지 않았습니다.

- 개발: Node.js 22.12 이상(20.x는 20.19 이상), npm, 최신 stable Rust, [Tauri 2의 운영체제별 빌드 요건](https://v2.tauri.app/start/prerequisites/). 이 작업 환경에서는 Node 25와 Rust 1.94.1로 검증했습니다.
- 미디어 처리: `ffmpeg`, `ffprobe` 실행 파일이 필요합니다. macOS Homebrew에서는 `brew install ffmpeg`로 설치할 수 있습니다. 실제 지원 코덱·필터는 설치된 FFmpeg 빌드에 따릅니다.
- CLI 편집: Python 3, 사용하려는 `claude` / `codex` / `gemini` 실행 파일과 해당 CLI의 로그인 상태가 필요합니다. CLI 설치·로그인은 각 CLI에서 수행합니다.
- Higgsfield MCP: Node.js와 `npx`, Higgsfield 계정이 필요합니다. 첫 연결에서 고정 버전 `mcp-remote@0.15.2`를 준비합니다.
- 자동 자막: [OpenAI Whisper](https://github.com/openai/whisper)의 `whisper` CLI가 필요합니다. Python 가상환경 등으로 설치한 뒤 Studio 프로세스의 `PATH`에서 찾을 수 있게 설정해주세요. 모델은 첫 사용 시 공식 배포처에서 내려받고 이후 로컬 CPU에서 실행합니다.
- 내레이션: macOS의 `/usr/bin/say`와 설치된 시스템 음성을 사용합니다. 음성 목록은 실제 시스템에서 조회합니다.
- 창작 기억: 실행 중인 로컬 ByoriDB가 필요합니다. 설정 화면에서 기존 설치를 확인하거나 설치할 수 있습니다. DB가 없어도 기본 영상 편집·출력은 가능합니다.

런타임은 `PATH`와 `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`에서 외부 도구를 찾습니다. 가상환경에만 있는 Whisper는 해당 환경을 활성화한 터미널에서 Studio를 실행하거나 발견 가능한 경로에 실행 파일을 연결해주세요. FFmpeg, Whisper, CLI 에이전트 자체는 `.app`에 포함하지 않습니다.

## 개발 실행

```bash
npm install

# 브라우저 개발: Rust 편집 서비스와 Vite를 함께 실행
npm run studio
```

브라우저에서 `http://localhost:1420`을 엽니다. 기본 편집 서비스 주소는 `http://127.0.0.1:43123`입니다. `npm run dev`만 실행하면 Vite 화면만 시작되므로 별도의 편집 서비스가 필요합니다.

```bash
# 네이티브 창 개발: 서비스는 Tauri 앱에서 시작
npm run tauri dev

# 필요할 때 서비스만 실행
npm run service

# 프런트엔드 프로덕션 빌드
npm run build

# macOS 앱 번들 빌드
npm run tauri build -- --bundles app
```

macOS 앱 출력 경로는 `src-tauri/target/release/bundle/macos/Byori Studio.app`입니다. 앱에는 프런트엔드, Rust 편집 서비스, MCP/CLI 브리지와 데모 소재가 포함됩니다. 같은 데이터 폴더와 포트로 개발 서비스(`npm run service`)가 이미 실행 중이면 앱은 그 서비스에 연결합니다. 앱이 이미 실행 중이면 두 번째 앱이나 개발 서비스는 시작되지 않습니다. 외부 배포용 Developer ID 서명·공증은 별도 배포 작업입니다.

브라우저에서는 파일 선택·드롭 시 소재가 Studio 가져오기 폴더로 복사됩니다. 네이티브 앱에서는 파일 대화상자로 원본 경로를 가져옵니다. 내보내기 위치는 파일시스템 경로이며 네이티브 앱에서는 저장 대화상자도 사용할 수 있습니다.

## CLI에서 직접 편집

Studio가 실행 중일 때 같은 프로젝트를 조회하고 편집할 수 있습니다.

```bash
python3 scripts/studio-cli.py project.get
python3 scripts/studio-cli.py history.status
python3 scripts/studio-cli.py edit.add '{"trackId":"text-1","start":0,"duration":3,"text":"첫 장면"}'
python3 scripts/studio-cli.py history.undo
```

클립·트랙 ID는 현재 `project.get` 응답에서 확인합니다. 여러 변경을 한 번에 적용하려면 `edit.batch`에 `commands`와 조회한 `expectedRevision`을 전달합니다. 버전이 달라지면 충돌 오류를 반환합니다. API 계약은 [IMPLEMENTATION.md](./IMPLEMENTATION.md), MCP의 현재 허용 메서드는 [studio-tools.json](./scripts/studio-tools.json)에서 확인할 수 있습니다.

앱의 에이전트 패널은 각 작업에 전용 작업 폴더와 MCP 설정을 만들고, `studio_project`, `studio_edit`, `studio_export`, `studio_memory`, `studio_speech`, `studio_assets` 도구를 해당 CLI에 제공합니다. 사용자의 전역 CLI 설정을 수정하지 않습니다. 직접 외부 MCP 클라이언트에 연결하려면 Python 3으로 `scripts/studio-mcp.py`를 stdio 서버로 실행하면 됩니다. 기본 연결 파일은 아래 데이터 폴더에 있으며 `--connection <경로>`로 지정할 수 있습니다.

설정의 **Higgsfield MCP → Higgsfield 추가 → 로그인·연결 확인**을 사용하면 브라우저에서 로그인합니다. [공식 연결 안내](https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent)의 서버와 [mcp-remote](https://github.com/punkpeye/mcp-remote)를 사용하며 OAuth 캐시는 Studio 전용 폴더에 둡니다. 앱 재시작 후에는 연결 확인을 다시 누릅니다. 연결 변경은 다음 에이전트 작업부터 적용됩니다.

현재 Higgsfield 연결은 모델·크레딧 등 **조회 도구 6개**를 제공합니다. 유료 이미지·음악 생성의 비용 확인·승인·결과 가져오기 흐름은 아직 구현하지 않았습니다. 이 앱의 연결이 현재 대화에 연결된 Higgsfield 계정 인증을 자동으로 이어받지는 않습니다.

2026-11-01 실제 실행 검증:

- **Claude Code, Codex:** 각각 프로젝트를 조회하고 고유한 텍스트 클립을 추가했습니다. 실제 revision·클립 변경과 실행 취소를 확인했습니다.
- **Gemini CLI:** 설치 감지·실행 어댑터는 구현했으나 현재 환경에서 인증 단계가 `Authentication cancelled by user`로 종료되었습니다. 로그인 후 실제 편집 성공 검증이 남아 있습니다.
- **ByoriDB:** 실제 로컬 DB에서 별도 테스트 기록을 저장·검색했고 설치 버전과 공식 최신 릴리스를 조회했습니다. 사용 중인 DB를 설치·업데이트하는 테스트는 수행하지 않았습니다.
- **음성:** Samantha 음성으로 6.317초 테스트 내레이션을 만들고, Whisper tiny로 3개 SRT 구간을 생성해 타임라인에 넣었습니다. 작업 도중 변경된 프로젝트에 적용을 거부하고 SRT를 보관하는 동작, 취소 시 편집하지 않는 동작도 확인했습니다.

CLI 실행은 해당 제공자의 계정·사용량 정책을 따릅니다. 프롬프트, 프로젝트 정보, 조회한 기억이나 요청한 미리보기는 CLI의 모델 제공자에게 전달될 수 있습니다. 로컬 Whisper 음성 인식은 모델 다운로드 이후 사용자 오디오를 외부 음성 API로 업로드하지 않습니다.

## 데이터와 로컬 연결

기본 데이터 폴더는 `~/.byori-studio`입니다.

| 경로 | 내용 |
| --- | --- |
| `current.json`, `projects/` | 자동 저장된 현재 프로젝트와 프로젝트 JSON |
| `imports/`, `thumbnails/`, `previews/` | 브라우저 가져오기 파일, 썸네일·합성 미리보기 |
| `speech/`, `models/whisper/` | 생성 음성·SRT·작업 파일, 다운로드한 Whisper 모델 |
| `catalog/index.json`, `catalog/fonts/` | 사용자 필터·효과 프리셋 목록과 관리 복사한 글꼴 |
| `mcp/higgsfield/` | Higgsfield 연결 설정, Studio 전용 OAuth·npm 캐시 |
| `agent-workspaces/`, `tools/` | 작업별 CLI/MCP 설정, 앱에 포함된 Python 브리지 |
| `connection.json` | 로컬 서비스 주소와 인증 토큰 |
| `byoridb/` | 기존 설치가 없을 때 Studio가 관리하는 ByoriDB 설치·데이터 |

프로젝트는 원본 미디어의 로컬 경로를 참조합니다. 외부로 프로젝트 JSON만 옮기면 원본 영상까지 함께 이동하지 않습니다. 실행 취소 이력과 실행 작업 상태는 현재 서비스 실행 중에 유지됩니다. 창작 기억은 발견한 ByoriDB의 `studio_creative` 공간에 저장됩니다.

격리된 개발·테스트에는 `BYORI_STUDIO_HOME`으로 데이터 폴더를, `BYORI_STUDIO_PORT`로 서비스 포트를 지정할 수 있습니다. `npm run studio`는 `BYORI_STUDIO_PORT`(서비스, 기본 43123)와 `BYORI_STUDIO_DEV_PORT`(Vite, 기본 1420)를 두 프로세스에 전달하고 브라우저 화면은 `VITE_STUDIO_PORT`로 서비스에 연결합니다. `scripts/studio-cli.py`와 MCP도 `BYORI_STUDIO_HOME`의 연결 파일을 사용합니다. 전체 검증은 `npm run verify`입니다. `BYORIDB_HOME`은 명시적인 DB 설치 위치를 지정합니다.

서비스는 IPv4 loopback에만 바인딩하며 RPC에 bearer 토큰을 요구합니다. 브라우저 업로드는 시작한 프로젝트와 revision을 고정하고, 업로드 중 편집·프로젝트 전환이 생기면 적용을 거부합니다. 데이터 폴더는 사용자 전용 권한, 연결 파일은 `0600`으로 저장합니다. 브라우저 Origin은 개발 서버와 Tauri origin으로 제한하고, 미디어 HTTP 응답은 프로젝트에 등록된 파일·관리된 글꼴·생성한 미리보기만 제공합니다. 토큰이 있는 로컬 클라이언트에는 가져오기·내보내기 파일 접근 권한이 있으므로 연결 파일을 공개하지 마세요. 작업별 CLI 폴더는 설정 분리 목적이며 별도의 운영체제 보안 격리 공간은 아닙니다.

ByoriDB 설치는 공식 GitHub 안정 릴리스를 조회하고 플랫폼에 맞는 파일만 사용합니다. 기존 Byori의 알려진 실행 설정을 재사용하고 인증 정보와 데이터 폴더를 유지합니다. 바이너리 교체 실패 시 이전 실행 파일·manifest 복원 경로를 갖추고 있으며, 외부 프로세스가 점유한 DB 포트나 관리되지 않는 실행 중 서비스를 임의 교체하지 않습니다.

## 검증

```bash
npm test
npm run test:core
python3 scripts/test_studio_mcp.py
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
```

Rust 테스트에는 편집 명령과 원자적 실행 취소, 실제 FFmpeg 출력·미리보기, SRT, 앨범 커버 MP3 분류·기존 클립 복구, 레이어 생성·이동, revision 충돌, 토큰·Origin, 설치 압축 추출·실패 복원, 음성 작업 취소 등이 포함됩니다. 프런트엔드에서는 오디오 재생 상태·버퍼링 중 동기화·중복 소리 방지와 트랙 선택·이동·잠금을 검사합니다. 실제 렌더 테스트에는 FFmpeg가 필요합니다. MCP 테스트는 도구 경계와 실패가 성공으로 보고되지 않는 동작을 확인합니다.

## 남은 범위

현재 구현이 CapCut 전체 기능과 동일한 것은 아닙니다. 모션 트래킹, AI 인물 분리·배경 제거, 속도 곡선·광학 흐름, 2패스 vidstab, 멀티캠·중첩 시퀀스, 대규모 효과·전환·상업용 소재 라이브러리, 클라우드 동기화·공동 편집·게시 기능은 남아 있습니다. 고해상도·장편 작업의 프록시 관리와 GPU 중심 재생 최적화도 추가 작업입니다.

ByoriDB 기억은 실제 기록·검색과 CLI의 재사용까지 연결됩니다. 성과 데이터 자동 수집, 평가 기반 추천 고도화, 자동 학습이나 지속적인 성과 개선을 보장하는 기능은 구현하지 않았습니다. Gemini 인증 후 편집, DB의 새 설치·실제 업데이트, 배포용 서명·공증 및 다른 컴퓨터에서의 설치 검증도 후속 검증 대상입니다.

## 구조

- `src/studio/`: 편집 UI, 타임라인, 속성·기억·에이전트·설정 패널
- `src-tauri/src/editor.rs`, `media.rs`, `render.rs`: 프로젝트 명령·미디어 검사·합성 출력
- `src-tauri/src/catalog.rs`, `preview.rs`, `mcp_connections.rs`: 사용자 소재, 잠금과 분리한 정밀 프레임, Higgsfield 연결
- `src-tauri/src/service.rs`, `runtime.rs`, `speech.rs`: 인증된 로컬 API, CLI·ByoriDB, 음성 작업
- `scripts/`: 개발 서비스 실행기, Python MCP·CLI 브리지와 테스트
- `public/demo/`: 앱과 함께 제공되는 실제 데모 소재

React 19·TypeScript·Vite, Rust·Tauri 2·Axum, FFmpeg를 사용합니다. 라이선스는 Apache-2.0입니다.
