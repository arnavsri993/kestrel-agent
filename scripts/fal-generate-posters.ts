import { executionRequested, generateApprovedAsset } from "./fal-client";

for (const id of ["poster-signal-wide", "social-signal-wide"]) await generateApprovedAsset(id, executionRequested());
