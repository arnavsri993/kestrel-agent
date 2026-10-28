import { createRequire } from "node:module";
import { resolve } from "node:path";
const require = createRequire(import.meta.url);
const { verifyNativeBrowserSidecar } = require("../apps/desktop/build/native-browser-sidecar.cjs");
if (process.platform !== "darwin") throw new Error("Native browser verification requires macOS.");
if (!process.argv[2]) throw new Error("Pass the packaged desktop .app path to verify.");
const app = resolve(process.argv[2]);
verifyNativeBrowserSidecar(app);
console.log(`Verified bundled native extension browser: ${app}`);
