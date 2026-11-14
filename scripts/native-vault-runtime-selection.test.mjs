import { describe, expect, it } from "vitest";
import { selectNativeVaultRuntime, VAULT_CEF_RUNTIME_ENV } from "./native-vault-runtime-selection.mjs";

const selected = (options = {}) => selectNativeVaultRuntime({ argv: [], env: {}, ...options });
const environment = { [VAULT_CEF_RUNTIME_ENV]: "/reviewed/environment-distribution" };

describe("shared native vault runtime selection", () => {
 it("leaves the stock fixture choice available only when no vault input is selected", () => {
  expect(selected()).toBeUndefined();
  expect(selected({ argv: ["--output", "/owned/output", "--release"] })).toBeUndefined();
 });
 it("carries an explicit environment choice through imported desktop, package and install builders", () => {
  expect(selected({ env: environment })).toBe(environment[VAULT_CEF_RUNTIME_ENV]);
 });
 it.each([
  ["--vault-cef-runtime", "/reviewed/command-line-distribution"],
  ["--vault-cef-runtime=/reviewed/command-line-distribution"],
 ])("gives the command-line selection priority over the environment: %j", (...argv) => {
  expect(selected({ argv, env: environment })).toBe("/reviewed/command-line-distribution");
 });
 it("gives the function's explicit option priority without consuming an unrelated caller command line", () => {
  expect(selected({ explicit: "/reviewed/api-distribution", argv: ["--vault-cef-runtime"], env: environment })).toBe("/reviewed/api-distribution");
 });
 it.each([
  ["--vault-cef-runtime"], ["--vault-cef-runtime", "--output", "/owned/output"],
  ["--vault-cef-runtime", ""], ["--vault-cef-runtime="],
  ["--vault-cef-runtime=/first", "--vault-cef-runtime", "/second"],
 ])("rejects malformed or ambiguous CLI input rather than falling back to the environment: %j", (...argv) => {
  expect(() => selected({ argv, env: environment })).toThrow();
 });
 it.each(["", null, false, 1])("rejects an invalid explicit API choice: %j", explicit => {
  expect(() => selected({ explicit, env: environment })).toThrow();
 });
 it.each(["", null, false, 1])("rejects an invalid environment choice rather than silently building stock CEF: %j", value => {
  expect(() => selected({ env: { [VAULT_CEF_RUNTIME_ENV]: value } })).toThrow();
 });
 it("preserves spaces and equals signs in a distribution path for the read-only path validator", () => {
  expect(selected({ argv: ["--vault-cef-runtime=/reviewed/My CEF=1"] })).toBe("/reviewed/My CEF=1");
 });
});
