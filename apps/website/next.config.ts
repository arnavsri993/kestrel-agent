import { resolve } from "node:path";
import type { NextConfig } from "next";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH?.trim() ?? "";

const config: NextConfig = {
  output: "export",
  ...(basePath ? { basePath, assetPrefix: basePath } : {}),
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: resolve(__dirname, "../..") }
};

export default config;
