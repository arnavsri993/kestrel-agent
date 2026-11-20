import { createHash } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

export async function hashPackagedVaultFramework(app) {
 const path = join(app, "Contents/Frameworks/Chromium Embedded Framework.framework/Chromium Embedded Framework");
 const file = await open(path, constants.O_RDONLY);
 try {
  const before = await file.stat();
  if (!before.isFile()) throw Error("Packaged CEF binary is not a regular file.");
  const hash = createHash("sha256");
  for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
  const after = await file.stat();
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
   throw Error("Packaged CEF binary changed while hashing.");
  return hash.digest("hex");
 } finally { await file.close(); }
}

// The initial nested signing can change Mach-O bytes. Bind the record to those
// final framework bytes, then reseal only the outer app so nested code stays put.
export async function sealPackagedVaultRecord({ app, record, signOuter }) {
 const frameworkSha256 = await hashPackagedVaultFramework(app);
 const final = { ...record, sourceFrameworkSha256: record.sourceFrameworkSha256 ?? record.frameworkSha256, frameworkSha256 };
 await writeFile(join(app, "Contents/Resources/native-vault-engine.json"), `${JSON.stringify(final, null, 2)}\n`, { mode: 0o644 });
 await signOuter();
 if (await hashPackagedVaultFramework(app) !== frameworkSha256)
  throw Error("Outer app signing unexpectedly changed the recorded framework.");
 return final;
}
