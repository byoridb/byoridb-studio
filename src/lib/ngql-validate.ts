/**
 * Lightweight pre-execution nGQL validation, surfaced as Monaco markers.
 *
 * This is a heuristic linter, not a parser: it catches the high-frequency
 * mistakes a user makes before hitting "run" — chiefly using a reserved word as
 * a tag/edge/space name or property name (e.g. `CREATE TAG tag (...)`), which
 * the server rejects with an opaque parse error. Backtick-quoted identifiers
 * are allowed.
 */
import { isNgqlKeyword } from "./ngql-language";

export type MarkerSeverity = "warning" | "error";

export interface NgqlMarker {
  message: string;
  severity: MarkerSeverity;
  /** 1-based line (Monaco convention). */
  line: number;
  /** 1-based inclusive start column. */
  startColumn: number;
  /** 1-based exclusive end column. */
  endColumn: number;
}

/** Convert a 0-based character offset into a 1-based {line, column}. */
function positionAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function reservedNameMarker(text: string, start: number, name: string, role: string): NgqlMarker {
  const from = positionAt(text, start);
  const to = positionAt(text, start + name.length);
  return {
    message: `"${name}" is a reserved nGQL keyword and cannot be used as a ${role} name. Quote it with backticks (\`${name}\`) or rename it.`,
    severity: "warning",
    line: from.line,
    startColumn: from.column,
    endColumn: to.column,
  };
}

/**
 * Validate a (possibly multi-statement) nGQL string and return markers for any
 * reserved-word identifier collisions.
 */
export function validateNgql(text: string): NgqlMarker[] {
  const markers: NgqlMarker[] = [];

  // 1) Reserved word used as a tag/edge/space (or index) name.
  const declRe =
    /\b(?:CREATE|ALTER|DROP)\s+(?:TAG|EDGE|SPACE)(?:\s+INDEX)?\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(`?)([A-Za-z_]\w*)\1/gi;
  for (let m = declRe.exec(text); m !== null; m = declRe.exec(text)) {
    const quoted = m[1] === "`";
    const name = m[2];
    if (quoted || !isNgqlKeyword(name)) continue;
    const matchEnd = m.index + m[0].length;
    const nameStart = (quoted ? matchEnd - 1 : matchEnd) - name.length;
    markers.push(reservedNameMarker(text, nameStart, name, "tag/edge/space"));
  }

  // 2) Reserved word used as a property name in a CREATE TAG/EDGE field list.
  //    (byoridb column types take no parenthesised args, so a simple
  //    paren-content capture is safe here.)
  const createRe =
    /\bCREATE\s+(?:TAG|EDGE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?`?[A-Za-z_]\w*`?\s*\(([^)]*)\)/gi;
  for (let m = createRe.exec(text); m !== null; m = createRe.exec(text)) {
    const body = m[1];
    const bodyStart = m.index + m[0].indexOf("(") + 1;
    // Each comma-separated field starts with its name. Capture the leading
    // (optionally backtick-quoted) identifier of each segment.
    const fieldRe = /(^|,)\s*(`?)([A-Za-z_]\w*)\2/g;
    for (let f = fieldRe.exec(body); f !== null; f = fieldRe.exec(body)) {
      const quoted = f[2] === "`";
      const name = f[3];
      if (quoted || !isNgqlKeyword(name)) continue;
      const nameStart = bodyStart + f.index + f[0].length - name.length - (quoted ? 1 : 0);
      markers.push(reservedNameMarker(text, nameStart, name, "property"));
    }
  }

  return markers;
}
