import { defineConfig } from "vite";
import { createRendererViteConfig } from "./renderer.vite.config.mjs";

export default defineConfig(() => createRendererViteConfig());
