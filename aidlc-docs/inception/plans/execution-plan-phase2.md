# Execution Plan — Phase 2: Monaco Editor + nGQL 구문 강조

## Detailed Analysis Summary

### Transformation Scope
- **Type**: Single-component enhancement + new language definition file
- **Primary Changes**: `QueryEditor.tsx` textarea → Monaco Editor; 새 `src/lib/ngql-language.ts`
- **Related Components**: `QueryEditor.tsx`, `QueryEditor.test.tsx`, `QueryEditor.css`, `package.json`

### Change Impact Assessment
- **User-facing changes**: Yes — 에디터 UI 개선 (구문 강조, Monaco 기능)
- **Structural changes**: No — 컴포넌트 인터페이스(`onExecute`, `isExecuting`, `isConnected`) 유지
- **Data model changes**: No
- **API changes**: No — Tauri 커맨드 변경 없음
- **NFR impact**: Yes — PBT 적용 대상(토크나이저) 추가

### Risk Assessment
- **Risk Level**: Low-Medium
- **Rollback Complexity**: Easy — 파일 단위 변경
- **Testing Complexity**: Moderate — Monaco는 jsdom에서 mock 필요

---

## Workflow Visualization

```mermaid
flowchart TD
    Start(["Phase 2 시작"])

    subgraph INCEPTION["🔵 INCEPTION PHASE"]
        WD["Workspace Detection\nCOMPLETED"]
        RE["Reverse Engineering\nCOMPLETED"]
        RA["Requirements Analysis\nCOMPLETED"]
        US["User Stories\nSKIP"]
        WP["Workflow Planning\nIN PROGRESS"]
        AD["Application Design\nSKIP"]
        UG["Units Generation\nSKIP"]
    end

    subgraph CONSTRUCTION["🟢 CONSTRUCTION PHASE"]
        FD["Functional Design\nSKIP"]
        NFRA["NFR Requirements\nEXECUTE"]
        NFRD["NFR Design\nEXECUTE"]
        ID["Infrastructure Design\nSKIP"]
        CG["Code Generation\nEXECUTE"]
        BT["Build and Test\nEXECUTE"]
    end

    subgraph OPERATIONS["🟡 OPERATIONS PHASE"]
        OPS["Operations\nPLACEHOLDER"]
    end

    Start --> WD --> RE --> RA --> WP
    WP --> NFRA --> NFRD --> CG --> BT
    BT --> End(["Complete"])

    style WD fill:#4CAF50,stroke:#1B5E20,stroke-width:3px,color:#fff
    style RE fill:#4CAF50,stroke:#1B5E20,stroke-width:3px,color:#fff
    style RA fill:#4CAF50,stroke:#1B5E20,stroke-width:3px,color:#fff
    style WP fill:#4CAF50,stroke:#1B5E20,stroke-width:3px,color:#fff
    style NFRA fill:#FFA726,stroke:#E65100,stroke-width:3px,stroke-dasharray: 5 5,color:#000
    style NFRD fill:#FFA726,stroke:#E65100,stroke-width:3px,stroke-dasharray: 5 5,color:#000
    style CG fill:#4CAF50,stroke:#1B5E20,stroke-width:3px,color:#fff
    style BT fill:#4CAF50,stroke:#1B5E20,stroke-width:3px,color:#fff
    style US fill:#BDBDBD,stroke:#424242,stroke-width:2px,stroke-dasharray: 5 5,color:#000
    style AD fill:#BDBDBD,stroke:#424242,stroke-width:2px,stroke-dasharray: 5 5,color:#000
    style UG fill:#BDBDBD,stroke:#424242,stroke-width:2px,stroke-dasharray: 5 5,color:#000
    style FD fill:#BDBDBD,stroke:#424242,stroke-width:2px,stroke-dasharray: 5 5,color:#000
    style ID fill:#BDBDBD,stroke:#424242,stroke-width:2px,stroke-dasharray: 5 5,color:#000
    style OPS fill:#BDBDBD,stroke:#424242,stroke-width:2px,stroke-dasharray: 5 5,color:#000
    style Start fill:#CE93D8,stroke:#6A1B9A,stroke-width:3px,color:#000
    style End fill:#CE93D8,stroke:#6A1B9A,stroke-width:3px,color:#000
    style INCEPTION fill:#BBDEFB,stroke:#1565C0,stroke-width:3px,color:#000
    style CONSTRUCTION fill:#C8E6C9,stroke:#2E7D32,stroke-width:3px,color:#000
    style OPERATIONS fill:#FFF59D,stroke:#F57F17,stroke-width:3px,color:#000

    linkStyle default stroke:#333,stroke-width:2px
```

---

## Phases to Execute

### 🔵 INCEPTION
- [x] Workspace Detection — COMPLETED (재사용)
- [x] Reverse Engineering — COMPLETED (재사용)
- [x] Requirements Analysis — COMPLETED
- [ ] User Stories — **SKIP** (단일 컴포넌트 교체, 팀 협업 불필요)
- [x] Workflow Planning — IN PROGRESS
- [ ] Application Design — **SKIP** (새 컴포넌트 없음, 파일 추가만)
- [ ] Units Generation — **SKIP** (단일 작업 단위)

### 🟢 CONSTRUCTION
- [ ] Functional Design — **SKIP** (새 비즈니스 로직 없음)
- [ ] NFR Requirements — **EXECUTE** (PBT 적용 대상 식별 필요)
- [ ] NFR Design — **EXECUTE** (NFR Requirements 실행이므로)
- [ ] Infrastructure Design — **SKIP** (인프라 변경 없음)
- [ ] Code Generation — **EXECUTE**
- [ ] Build and Test — **EXECUTE**

---

## Success Criteria
- Monaco 에디터 렌더링 + 기존 단축키/히스토리 동작 유지
- nGQL 구문 강조 동작
- 전체 테스트 통과 (QueryEditor 포함)
- lint/format/build green
