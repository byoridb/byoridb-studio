/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

declare const process: { env: Record<string, string | undefined> };
// The service allows this dev origin; scripts/dev.mjs passes the same port to both.
const devPort = Number(process.env.BYORI_STUDIO_DEV_PORT) || 1420;

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    // A test that renders the whole app takes well under a second, and many seconds
    // when every core is busy (a build or another test run beside it): the limits
    // leave room for that instead of failing on a starved processor.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/vite-env.d.ts"],
    },
  },
  // Vite options tailored for Tauri development
  clearScreen: false,
  server: {
    port: devPort,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
