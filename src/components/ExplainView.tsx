import { useMemo } from "react";
import type { QueryResult } from "../types";
import {
  computePlanStats,
  detectExplainMode,
  formatCount,
  formatMicros,
  parsePlanNodes,
  type ExplainMode,
  type PlanNode,
} from "../lib/explainPlan";
import "../styles/ExplainView.css";

interface ExplainViewProps {
  result: QueryResult;
}

/** Green → red heatmap hue based on a 0..1 intensity. */
function heatColor(intensity: number): string {
  const clamped = Math.max(0, Math.min(1, intensity));
  const hue = 140 - 140 * clamped; // 140 (green) → 0 (red)
  return `hsl(${hue}, 70%, 45%)`;
}

/** Render the access-path cell as a styled badge. */
function AccessBadge({ access, isFullScan }: { access: string; isFullScan: boolean }) {
  if (access === "-") return <span className="access-none">—</span>;
  if (isFullScan) {
    return <span className="access-badge full-scan">{access}</span>;
  }
  const isIndex = access.startsWith("index:");
  return <span className={`access-badge ${isIndex ? "indexed" : "scan"}`}>{access}</span>;
}

function ModeBadge({ mode }: { mode: ExplainMode }) {
  return <span className={`explain-mode-badge ${mode}`}>{mode.toUpperCase()}</span>;
}

function ExplainView({ result }: ExplainViewProps) {
  const mode = detectExplainMode(result);
  const nodes = useMemo(() => parsePlanNodes(result), [result]);
  const stats = useMemo(() => computePlanStats(nodes), [nodes]);

  // Should never happen — ResultPanel only mounts this when mode is detected —
  // but guard so the component is safe to use standalone.
  if (!mode) {
    return <div className="no-data">Not an EXPLAIN/PROFILE result</div>;
  }

  const isProfile = mode === "profile";
  const rootNode = nodes.find((n) => n.depth === 0) ?? null;

  return (
    <div className="explain-view">
      <div className="explain-summary">
        <ModeBadge mode={mode} />
        {isProfile && rootNode?.timeUs != null && (
          <span className="explain-summary-item">
            total <strong>{formatMicros(rootNode.timeUs)}</strong>
          </span>
        )}
        {isProfile && rootNode?.rows != null && (
          <span className="explain-summary-item">
            <strong>{formatCount(rootNode.rows)}</strong> rows out
          </span>
        )}
        {stats.fullScanCount > 0 && (
          <span className="explain-summary-warning">
            ⚠ {stats.fullScanCount} full scan{stats.fullScanCount > 1 ? "s" : ""}
          </span>
        )}
        {!isProfile && (
          <span className="explain-summary-hint">
            run <code>PROFILE</code> for per-operator rows &amp; timing
          </span>
        )}
      </div>

      <div className={`explain-tree ${isProfile ? "mode-profile" : "mode-explain"}`} role="tree">
        {nodes.map((node) => (
          <PlanRow
            key={node.id}
            node={node}
            isProfile={isProfile}
            isBottleneck={node.id === stats.bottleneckId}
            maxRows={stats.maxRows}
            maxTimeUs={stats.maxTimeUs}
          />
        ))}
      </div>
    </div>
  );
}

interface PlanRowProps {
  node: PlanNode;
  isProfile: boolean;
  isBottleneck: boolean;
  maxRows: number;
  maxTimeUs: number;
}

function PlanRow({ node, isProfile, isBottleneck, maxRows, maxTimeUs }: PlanRowProps) {
  const rowIntensity = maxRows > 0 && node.rows !== null ? node.rows / maxRows : 0;
  const timeIntensity =
    maxTimeUs > 0 && node.timeUs !== null && node.depth > 0 ? node.timeUs / maxTimeUs : 0;

  return (
    <div
      className={`plan-row${node.isFullScan ? " is-fullscan" : ""}${
        isBottleneck ? " is-bottleneck" : ""
      }`}
      role="treeitem"
      aria-level={node.depth + 1}
      data-testid={`plan-row-${node.id}`}
    >
      <span className="plan-id">{node.id}</span>

      <span className="plan-operator" style={{ paddingLeft: `${node.depth * 18}px` }}>
        {node.depth > 0 && <span className="plan-guide">└─</span>}
        <span className="plan-op-name">{node.operator}</span>
        {isBottleneck && (
          <span className="bottleneck-badge" title="Slowest operator">
            🔥 bottleneck
          </span>
        )}
      </span>

      {isProfile && (
        <span className="plan-metric plan-rows" title={`${formatCount(node.rows)} rows`}>
          {node.rows !== null && (
            <>
              <span
                className="metric-bar"
                style={{ width: `${rowIntensity * 100}%`, background: heatColor(rowIntensity) }}
              />
              <span className="metric-label">{formatCount(node.rows)}</span>
            </>
          )}
        </span>
      )}

      {isProfile && (
        <span className="plan-metric plan-time" title={node.timeUs ? `${node.timeUs}µs` : ""}>
          {node.timeUs !== null && (
            <>
              <span
                className="metric-bar"
                style={{ width: `${timeIntensity * 100}%`, background: heatColor(timeIntensity) }}
              />
              <span className="metric-label">{formatMicros(node.timeUs)}</span>
            </>
          )}
        </span>
      )}

      <span className="plan-access">
        <AccessBadge access={node.access} isFullScan={node.isFullScan} />
      </span>

      <span className="plan-detail" title={node.detail}>
        {node.detail}
      </span>
    </div>
  );
}

export default ExplainView;
