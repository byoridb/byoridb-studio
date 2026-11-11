// package.json holds the release version. tauri.conf.json reads it from there;
// Cargo.toml, Cargo.lock and the MCP tool definition cannot, so this fails when they drift.
// `node scripts/check-version.mjs --write` copies the version into them instead.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const version = JSON.parse(read("package.json")).version;
const write = process.argv.includes("--write");

// The crate's own version line: the first one in Cargo.toml, and the one that
// follows `name = "byori-studio"` in Cargo.lock.
const targets = [
  ["src-tauri/Cargo.toml", /^(version = ")([^"]+)(")/m],
  ["src-tauri/Cargo.lock", /(name = "byori-studio"\nversion = ")([^"]+)(")/],
  // Reported by the MCP bridge to the CLI agents.
  ["scripts/studio-tools.json", /^(  "version": ")([^"]+)(")/m],
];
const problems = [];
for (const [file, pattern] of targets) {
  const text = read(file);
  const found = text.match(pattern)?.[2];
  if (found === version) continue;
  if (write && found) {
    writeFileSync(resolve(root, file), text.replace(pattern, `$1${version}$3`));
    console.log(`${file}: ${found} -> ${version}`);
  } else {
    problems.push(`${file}: ${found ?? "version not found"} (package.json: ${version})`);
  }
}
const tauri = JSON.parse(read("src-tauri/tauri.conf.json")).version;
if (tauri !== "../package.json" && tauri !== version)
  problems.push(`src-tauri/tauri.conf.json: ${tauri} (expected "../package.json")`);

if (problems.length) {
  console.error("Version mismatch:\n  " + problems.join("\n  "));
  console.error("Run: node scripts/check-version.mjs --write");
  process.exit(1);
}
console.log(`version ${version}`);
