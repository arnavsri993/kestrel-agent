#!/usr/bin/env node
import {
  MEMORY_RETRIEVAL_CASES,
  MEMORY_RETRIEVAL_CORPUS_VERSION,
  lexicalRank,
  meanReciprocalRank,
  precisionAtK,
  recallAtK,
} from "./corpus-v1.mjs";

const scores = MEMORY_RETRIEVAL_CASES.map((testCase) => {
  const ranked = lexicalRank(testCase.query, [...testCase.documents]);
  return {
    id: testCase.id,
    precision: precisionAtK(ranked, testCase.relevantIds, 3),
    recall: recallAtK(ranked, testCase.relevantIds, 3),
    mrr: meanReciprocalRank(ranked, testCase.relevantIds),
  };
});
const exact = scores.find((row) => row.id === "exact-recall");
if (!exact || exact.mrr !== 1) {
  console.error("exact-recall MRR failed", exact);
  process.exit(1);
}
const forgotten = scores.find((row) => row.id === "forgotten-memory");
if (!forgotten || forgotten.recall !== 1) {
  console.error("forgotten-memory recall failed", forgotten);
  process.exit(1);
}
console.log(
  JSON.stringify(
    {
      track: MEMORY_RETRIEVAL_CORPUS_VERSION,
      cases: scores.length,
      meanPrecision: scores.reduce((s, r) => s + r.precision, 0) / scores.length,
      meanRecall: scores.reduce((s, r) => s + r.recall, 0) / scores.length,
      meanMrr: scores.reduce((s, r) => s + r.mrr, 0) / scores.length,
    },
    null,
    2,
  ),
);
