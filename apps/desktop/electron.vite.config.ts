import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const workspacePackages = ["@kestrel/agent-core", "@kestrel/database", "@kestrel/encryption", "@kestrel/policy-engine", "@kestrel/shared-types"];

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: [...workspacePackages, "zod"] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/main/index.ts"),
          utility: resolve(__dirname, "src/utility/index.ts")
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: [...workspacePackages, "zod"] })],
    build: { rollupOptions: { input: resolve(__dirname, "src/preload/index.ts"), output: { format: "cjs", entryFileNames: "index.cjs" } } }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react()]
  }
});
