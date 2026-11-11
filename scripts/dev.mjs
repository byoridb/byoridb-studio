import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
function launch(command, args) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    detached: process.platform !== "win32",
  });
  children.push(child);
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code) => {
    if (!stopping) stop(code ?? 1);
  });
  return child;
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    try {
      if (process.platform !== "win32" && child.pid)
        process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {}
  }
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
launch("cargo", [
  "run",
  "--manifest-path",
  "src-tauri/Cargo.toml",
  "--bin",
  "studio-service",
]);
launch(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"]);
