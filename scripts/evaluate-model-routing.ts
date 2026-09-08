import { evaluateRoutingFixtures } from "../packages/agent-core/src/routing/evaluation";

/** Print deterministic, metadata-only routing evaluation evidence for review. */
process.stdout.write(`${JSON.stringify(evaluateRoutingFixtures(), null, 2)}\n`);
