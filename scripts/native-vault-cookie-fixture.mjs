import assert from "node:assert/strict";

// Test-fixture mutation only. The caller owns the new private profile, verifies
// its app has stopped and opens that generated SQLite database exclusively.
// Change only the authentication tag of one exact fixture row. Never rekey,
// reseed or export the ciphertext/key in the receipt.
export function corruptGeneratedVaultCookie(db, name) {
 assert.match(name, /^kestrel_canary_[a-f0-9]{24}$/);
 db.transaction(() => {
  const rows = db.prepare("SELECT value, encrypted_value, is_persistent, is_httponly FROM cookies WHERE host_key = ? AND name = ?").all("127.0.0.1", name);
  assert.equal(rows.length, 1, "Expected one generated cookie before authentication test.");
  const row = rows[0], original = row.encrypted_value;
  assert.equal(row.value, ""); assert.equal(row.is_persistent, 1); assert.equal(row.is_httponly, 1);
  assert(Buffer.isBuffer(original) && original.length > 3 + 12 + 16 && original.length <= 4096 &&
   original.subarray(0, 3).toString("ascii") === "v99", "Expected bounded custom-provider ciphertext.");
  const corrupted = Buffer.from(original); corrupted[corrupted.length - 1] ^= 1;
  const result = db.prepare("UPDATE cookies SET encrypted_value = ? WHERE host_key = ? AND name = ? AND encrypted_value = ?")
   .run(corrupted, "127.0.0.1", name, original);
  assert.equal(result.changes, 1, "Generated cookie changed during authentication test.");
 })();
}
