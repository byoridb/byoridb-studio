/**
 * Query tab state and snippet definitions for QueryEditor.
 */

export interface QueryTab {
  id: string;
  title: string;
  query: string;
}

export const SNIPPETS: { label: string; description: string; body: string }[] = [
  {
    label: "MATCH vertex",
    description: "Match vertices by tag",
    body: "MATCH (v:${1:tag}) RETURN v LIMIT ${2:100}",
  },
  {
    label: "MATCH edge",
    description: "Match edges by type",
    body: "MATCH (s)-[e:${1:edge}]->() RETURN e LIMIT ${2:100}",
  },
  {
    label: "GO traverse",
    description: "Traverse edges from a vertex",
    body: "GO FROM ${1:1} OVER ${2:follows} YIELD ${2:follows}._dst AS dst",
  },
  {
    label: "FETCH vertex",
    description: "Fetch vertex properties",
    body: "FETCH PROP ON ${1:tag} ${2:1}",
  },
  {
    label: "INSERT vertex",
    description: "Insert a vertex",
    body: "INSERT VERTEX ${1:tag} (${2:name}) VALUES ${3:1}:('${4:value}')",
  },
  {
    label: "INSERT edge",
    description: "Insert an edge",
    body: "INSERT EDGE ${1:follows} (${2:since}) VALUES ${3:1} -> ${4:2}:(${5:2020})",
  },
  {
    label: "SHOW SPACES",
    description: "List all spaces",
    body: "SHOW SPACES",
  },
  {
    label: "CREATE SPACE",
    description: "Create a new space",
    body: "CREATE SPACE ${1:my_space} (vid_type = INT64)",
  },
  {
    label: "CREATE TAG",
    description: "Create a tag",
    body: "CREATE TAG ${1:person} (${2:name} STRING, ${3:age} INT64)",
  },
  {
    label: "CREATE EDGE",
    description: "Create an edge type",
    body: "CREATE EDGE ${1:follows} (${2:since} INT64)",
  },
];

export function newTab(id?: string): QueryTab {
  return {
    id: id ?? `tab-${Date.now()}`,
    title: "Query",
    query: "",
  };
}
