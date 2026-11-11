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
