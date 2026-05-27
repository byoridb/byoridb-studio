import { useState } from "react";
import ServerSettings, { ConnectionConfig } from "./ServerSettings";
import { useSchemaData, type DescribeKey, type DescribeState } from "../hooks/useSchemaData";

type TabType = "schema" | "settings";

interface SidebarProps {
  isConnected: boolean;
  currentSpace: string | null;
  onSelectSpace: (spaceName: string) => void;
  onExecuteQuery: (query: string) => void;
  onConnect: (config: ConnectionConfig) => void;
}

function Sidebar({ isConnected, currentSpace, onSelectSpace, onExecuteQuery, onConnect }: SidebarProps) {
  const [activeTab, setActiveTab] = useState<TabType>("schema");
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    spaces: true,
    tags: true,
    edges: true,
  });

  const { spaces, schema, expandedItems, describeCache, loadSpaces, refreshSchema, toggleDescribe } =
    useSchemaData({ isConnected, currentSpace });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const renderDescribePanel = (kind: "tag" | "edge", name: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    const state: DescribeState | undefined = describeCache[key];

    if (!state || state.status === "loading") {
      return (
        <div className="mx-4 mb-2 ml-[42px] p-2 bg-crust rounded text-[11px] text-overlay italic">
          Loading schema…
        </div>
      );
    }
    if (state.status === "error") {
      return (
        <div className="mx-4 mb-2 ml-[42px] p-2 bg-red/8 rounded text-[11px] text-red">
          Error: {state.message}
        </div>
      );
    }
    if (state.rows.length === 0) {
      return (
        <div className="mx-4 mb-2 ml-[42px] p-2 bg-crust rounded text-[11px] text-overlay italic">
          No properties.
        </div>
      );
    }

    return (
      <div className="mx-4 mb-2 ml-[42px] p-2 bg-crust rounded text-[11px] text-subtext">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {["Field", "Type", "Null", "Default"].map((h) => (
                <th
                  key={h}
                  className="text-left px-1.5 py-0.5 border-b border-surface1 text-[10px] font-semibold uppercase tracking-[0.4px] text-overlay"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {state.rows.map((row, i) => (
              <tr key={`${row.Field}-${i}`}>
                <td className="px-1.5 py-0.5 border-b border-surface1 last:border-b-0">{row.Field}</td>
                <td className="px-1.5 py-0.5 border-b border-surface1 last:border-b-0">{row.Type}</td>
                <td className="px-1.5 py-0.5 border-b border-surface1 last:border-b-0">{row.Null}</td>
                <td className="px-1.5 py-0.5 border-b border-surface1 last:border-b-0">
                  {row.Default === null ? "—" : String(row.Default)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const renderSchemaItem = (kind: "tag" | "edge", name: string, icon: string) => {
    const key: DescribeKey = `${kind}:${name}`;
    const isOpen = expandedItems.has(key);
    const onNameClick =
      kind === "tag"
        ? () => onExecuteQuery(`MATCH (v:${name}) RETURN v LIMIT 100`)
        : () => onExecuteQuery(`MATCH ()-[e:${name}]->() RETURN e LIMIT 100`);

    return (
      <div key={name}>
        <div className="flex items-center gap-2 px-4 py-2 pl-6 cursor-pointer hover:bg-surface1 transition-colors duration-200">
          <button
            className={`w-[14px] h-[14px] p-0 text-[9px] leading-none bg-transparent text-overlay border-none rounded-sm cursor-pointer transition-transform duration-150 hover:text-text ${isOpen ? "rotate-90" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              toggleDescribe(kind, name);
            }}
            aria-label={isOpen ? `Collapse ${name}` : `Expand ${name}`}
            aria-expanded={isOpen}
          >
            ▶
          </button>
          <span className="text-sm">{icon}</span>
          <span className="flex-1 text-[13px] text-text truncate" onClick={onNameClick}>
            {name}
          </span>
        </div>
        {isOpen && renderDescribePanel(kind, name)}
      </div>
    );
  };

  const sectionHeader = (
    label: string,
    sectionKey: string,
    onRefresh?: () => void,
  ) => (
    <div
      className="flex items-center gap-2 px-4 py-3 cursor-pointer select-none hover:bg-surface1 transition-colors duration-200"
      onClick={() => toggleSection(sectionKey)}
    >
      <span
        className={`text-[10px] text-overlay transition-transform duration-200 ${
          expandedSections[sectionKey] ? "rotate-90" : ""
        }`}
      >
        ▶
      </span>
      <span className="flex-1 text-xs font-semibold uppercase tracking-[0.5px] text-subtext">
        {label}
      </span>
      {onRefresh && (
        <button
          className="p-0 px-1.5 text-sm bg-transparent text-overlay rounded hover:bg-surface1 hover:text-text"
          onClick={(e) => {
            e.stopPropagation();
            onRefresh();
          }}
          title="Refresh"
        >
          ↻
        </button>
      )}
    </div>
  );

  const renderSchemaContent = () => (
    <>
      <div className="border-b border-surface1">
        {sectionHeader("Spaces", "spaces", loadSpaces)}
        {expandedSections.spaces && (
          <div className="py-1">
            {spaces.length === 0 ? (
              <div className="px-6 py-3 text-xs text-overlay italic">No spaces found</div>
            ) : (
              spaces.map((space) => (
                <div
                  key={space.name}
                  className={`flex items-center gap-2 px-4 py-2 pl-6 cursor-pointer transition-colors duration-200 ${
                    currentSpace === space.name ? "bg-surface2" : "hover:bg-surface1"
                  }`}
                  onClick={() => onSelectSpace(space.name)}
                >
                  <span className="text-sm">📦</span>
                  <span className="flex-1 text-[13px] text-text truncate">{space.name}</span>
                  <span className="text-[11px] text-overlay px-1.5 py-0.5 bg-crust rounded">
                    P:{space.partitionNum}
                  </span>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {currentSpace && (
        <>
          <div className="border-b border-surface1">
            {sectionHeader("Tags", "tags", refreshSchema)}
            {expandedSections.tags && (
              <div className="py-1">
                {schema.tags.length === 0 ? (
                  <div className="px-6 py-3 text-xs text-overlay italic">No tags found</div>
                ) : (
                  schema.tags.map((tag) => renderSchemaItem("tag", tag, "🏷️"))
                )}
              </div>
            )}
          </div>

          <div className="border-b border-surface1">
            {sectionHeader("Edges", "edges")}
            {expandedSections.edges && (
              <div className="py-1">
                {schema.edges.length === 0 ? (
                  <div className="px-6 py-3 text-xs text-overlay italic">No edges found</div>
                ) : (
                  schema.edges.map((edge) => renderSchemaItem("edge", edge, "↔️"))
                )}
              </div>
            )}
          </div>
        </>
      )}
    </>
  );

  return (
    <div className="w-[250px] min-w-[250px] bg-mantle border-r border-surface1 flex flex-col">
      <div className="flex border-b border-surface1 shrink-0">
        {(["schema", "settings"] as const).map((tab) => (
          <button
            key={tab}
            className={`flex-1 py-3 px-4 text-xs font-semibold uppercase tracking-[0.5px] bg-transparent border-none border-b-2 cursor-pointer transition-all duration-200 ${
              activeTab === tab
                ? "text-blue border-b-blue"
                : "text-overlay border-b-transparent hover:text-subtext hover:bg-surface1"
            }`}
            onClick={() => setActiveTab(tab)}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {activeTab === "schema" ? renderSchemaContent() : <ServerSettings onConnect={onConnect} />}
      </div>
    </div>
  );
}

export default Sidebar;
