import { executionRequested, generateApprovedAsset } from "./fal-client";

const onlyIndex = process.argv.indexOf("--only");
const requested = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
const ids = ["context-flow-wide", "transition-verify-wide", "cta-resolution-wide"];
if (requested && !ids.includes(requested)) throw new Error(`Unknown background asset: ${requested}`);
for (const id of requested ? [requested] : ids) await generateApprovedAsset(id, executionRequested());
