import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const defaultMatrixPath = resolve(root, "docs/settings-parity-matrix.json");
const defaultCatalogPath = resolve(
  root,
  "apps/desktop/src/renderer/settings-catalog.ts",
);

function uniqueValues(values, label, errors) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) errors.push(`duplicate ${label}: ${value}`);
    seen.add(value);
  }
  return seen;
}

/**
 * Validate the parity ledger against the renderer catalog. This is exported so
 * tests can prove that duplicate and unmapped entries fail without changing the
 * checked-in matrix.
 */
export function auditSettingsParity({
  matrixPath = defaultMatrixPath,
  catalogPath = defaultCatalogPath,
} = {}) {
  const errors = [];
  let matrix;
  try {
    matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  } catch (error) {
    errors.push(
      `could not read ${matrixPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { errors, entries: 0, catalogSettings: 0, sourceSnapshots: 0 };
  }

  if (matrix.schemaVersion !== 1) errors.push("matrix schemaVersion must be 1");
  if (!Array.isArray(matrix.sections) || matrix.sections.length === 0)
    errors.push("matrix must declare at least one settings section");
  if (!Array.isArray(matrix.entries) || matrix.entries.length === 0)
    errors.push("matrix must declare at least one parity entry");
  if (!matrix.sources || typeof matrix.sources !== "object")
    errors.push("matrix must declare source snapshots");

  let catalogSource = "";
  try {
    catalogSource = readFileSync(catalogPath, "utf8");
  } catch (error) {
    errors.push(
      `could not read ${catalogPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const catalogStart = catalogSource.indexOf("export const SETTINGS_CATALOG");
  const catalogEnd = catalogSource.indexOf(
    "export const LEGACY_SETTINGS_SECTION_ALIASES",
  );
  if (catalogStart < 0 || catalogEnd < 0 || catalogEnd <= catalogStart) {
    errors.push("could not locate SETTINGS_CATALOG in the renderer catalog");
  }
  const catalogBlock = catalogSource.slice(
    Math.max(0, catalogStart),
    catalogEnd > catalogStart ? catalogEnd : undefined,
  );
  const catalogIds = [
    ...catalogBlock.matchAll(/^\s*id:\s*"([^"]+)"/gm),
  ].map((match) => match[1]);
  const catalogSections = [
    ...catalogBlock.matchAll(/^\s*section:\s*"([^"]+)"/gm),
  ].map((match) => match[1]);
  const catalogAnchors = [
    ...catalogBlock.matchAll(/^\s*anchor:\s*"([^"]+)"/gm),
  ].map((match) => match[1]);
  const catalogIdSet = uniqueValues(catalogIds, "catalog id", errors);
  const sectionIdSet = new Set(
    (Array.isArray(matrix.sections) ? matrix.sections : []).map(
      (section) => section.id,
    ),
  );
  for (const section of catalogSections) {
    if (!sectionIdSet.has(section))
      errors.push(`catalog section is absent from matrix sections: ${section}`);
  }
  // Anchors may intentionally be shared by several search entries in one
  // panel; only ids and parity reference keys must be unique.
  if (catalogAnchors.some((anchor) => !/^setting-[a-z0-9-]+$/.test(anchor)))
    errors.push("catalog anchors must use setting-* ids");

  const entries = Array.isArray(matrix.entries) ? matrix.entries : [];
  const entryIds = entries
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => entry.id)
    .filter((id) => typeof id === "string");
  uniqueValues(entryIds, "entry id", errors);
  uniqueValues(
    entries
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => `${entry.product}:${entry.referenceId}`),
    "product/reference pair",
    errors,
  );
  const mappedCatalogIds = new Set();
  const knownProducts = new Set(Object.keys(matrix.sources ?? {}));
  const allowedReasons = new Set([
    "vendor-account",
    "shopping",
    "wallet",
    "family",
    "enterprise-policy",
    "os-only",
    "internal-flag",
    "unsupported-capability",
  ]);

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      errors.push("every parity entry must be an object");
      continue;
    }
    if (!knownProducts.has(entry.product))
      errors.push(
        `${entry.id ?? "<unknown>"} uses an undeclared source product: ${entry.product}`,
      );
    const source = matrix.sources?.[entry.product];
    const referenceIds = Array.isArray(source?.references)
      ? new Set(
          source.references.map(
            (reference) => `${entry.product}.${reference.id}`,
          ),
        )
      : new Set();
    if (!referenceIds.has(entry.sourceRef))
      errors.push(
        `${entry.id} uses an undeclared source reference: ${entry.sourceRef}`,
      );
    if (entry.status === "implemented") {
      if (entry.relevance !== "relevant")
        errors.push(`${entry.id} implemented entries must be relevant`);
      if (
        typeof entry.section !== "string" ||
        !sectionIdSet.has(entry.section)
      )
        errors.push(
          `${entry.id} implemented entries must map to a declared section`,
        );
      if (
        typeof entry.catalogEntryId !== "string" ||
        !catalogIdSet.has(entry.catalogEntryId)
      )
        errors.push(
          `${entry.id} is unmapped: catalogEntryId is missing or unknown`,
        );
      else mappedCatalogIds.add(entry.catalogEntryId);
      if (entry.kestrel?.coverage !== "implemented")
        errors.push(
          `${entry.id} implemented entries need kestrel.coverage=implemented`,
        );
    } else if (entry.status === "not_applicable") {
      if (entry.relevance !== "excluded")
        errors.push(`${entry.id} not_applicable entries must be excluded`);
      if (entry.section !== null)
        errors.push(`${entry.id} not_applicable entries must have section=null`);
      if (entry.catalogEntryId !== undefined)
        errors.push(
          `${entry.id} not_applicable entries must not map to the UI catalog`,
        );
      if (!allowedReasons.has(entry.reasonCategory))
        errors.push(
          `${entry.id} has an unsupported reasonCategory: ${entry.reasonCategory}`,
        );
      if (typeof entry.reason !== "string" || entry.reason.trim() === "")
        errors.push(`${entry.id} needs an explicit not-applicable reason`);
    } else {
      errors.push(`${entry.id} has an unsupported status: ${entry.status}`);
    }
  }

  for (const catalogId of catalogIdSet) {
    if (!mappedCatalogIds.has(catalogId))
      errors.push(`catalog setting is unmapped in the parity ledger: ${catalogId}`);
  }

  return {
    errors,
    entries: entries.length,
    catalogSettings: catalogIds.length,
    sourceSnapshots: knownProducts.size,
  };
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const result = auditSettingsParity();
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`settings parity: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(
      `Settings parity audit passed: ${result.entries} entries, ${result.catalogSettings} catalog settings, ${result.sourceSnapshots} source snapshots.`,
    );
  }
}
