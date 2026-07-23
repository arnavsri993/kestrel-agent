import { resolve } from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  poweredByHeader: false,
  reactStrictMode: true,
  turbopack: { root: resolve(__dirname, "../..") }
};

export default config;
