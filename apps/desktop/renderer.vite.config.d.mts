import type { UserConfig } from "vite";

export interface RendererViteConfigOptions {
	base?: string;
	outDir?: string;
	nonce?: string;
}

export function createRendererViteConfig(options?: RendererViteConfigOptions): UserConfig;
