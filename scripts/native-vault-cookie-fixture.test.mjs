import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { corruptGeneratedVaultCookie } from "./native-vault-cookie-fixture.mjs";

const Database = createRequire(new URL("../packages/database/package.json", import.meta.url))("better-sqlite3");
const name = `kestrel_canary_${"a".repeat(24)}`;
const ciphertext = () => Buffer.concat([Buffer.from("v99"), Buffer.alloc(80, 0x46)]);
function fixture() {
 const db = new Database(":memory:");
 db.exec("CREATE TABLE cookies(host_key TEXT,name TEXT,value TEXT,encrypted_value BLOB,is_persistent INTEGER,is_httponly INTEGER)");
 const insert = (host = "127.0.0.1", cookieName = name, bytes = ciphertext()) =>
  db.prepare("INSERT INTO cookies VALUES(?,?,?, ?,1,1)").run(host, cookieName, "", bytes);
 return { db, insert, rows: () => db.prepare("SELECT * FROM cookies ORDER BY rowid").all() };
}
describe("bounded generated cookie authentication fixture", () => {
 it("changes only the final authentication byte of the generated row and preserves other cookies", () => {
  const f = fixture();
  try {
   f.insert(); f.insert("example.test", name); f.insert("127.0.0.1", "different_cookie");
   const before = f.rows(); corruptGeneratedVaultCookie(f.db, name); const after = f.rows();
   expect(after.slice(1)).toEqual(before.slice(1));
   expect(after[0]).toEqual({ ...before[0], encrypted_value: expect.any(Buffer) });
   const changed = after[0].encrypted_value, original = before[0].encrypted_value;
   expect(changed.subarray(0, -1)).toEqual(original.subarray(0, -1));
   expect(changed.at(-1)).toBe(original.at(-1) ^ 1);
  } finally { f.db.close(); }
 });
 it.each([0, 2])("refuses %i matching rows without modifying the database", count => {
  const f = fixture();
  try {
   for (let i = 0; i < count; i++) f.insert();
   const before = f.rows(); expect(() => corruptGeneratedVaultCookie(f.db, name)).toThrow();
   expect(f.rows()).toEqual(before);
  } finally { f.db.close(); }
 });
 it.each([Buffer.from("v10legacy-encryption"), Buffer.from("v99short"), Buffer.alloc(4097)])("refuses a wrong or malformed ciphertext without touching it", bytes => {
  const f = fixture();
  try {
   f.insert("127.0.0.1", name, bytes); const before = f.rows();
   expect(() => corruptGeneratedVaultCookie(f.db, name)).toThrow(); expect(f.rows()).toEqual(before);
  } finally { f.db.close(); }
 });
 it.each(["value = 'plaintext'", "is_persistent = 0", "is_httponly = 0"])("refuses unexpected fixture metadata: %s", assignment => {
  const f = fixture();
  try {
   f.insert(); f.db.exec(`UPDATE cookies SET ${assignment}`); const before = f.rows();
   expect(() => corruptGeneratedVaultCookie(f.db, name)).toThrow(); expect(f.rows()).toEqual(before);
  } finally { f.db.close(); }
 });
 it("rejects a non-generated cookie name before any SQL access", () => {
  expect(() => corruptGeneratedVaultCookie({ transaction: () => { throw Error("SQL accessed"); } }, "user_cookie")).toThrow(/kestrel_canary/);
 });
});
