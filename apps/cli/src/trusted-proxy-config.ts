import { lstatSync, readFileSync, realpathSync } from "node:fs";
import type { TrustedProxyConfiguration } from "@kestrel/agent-core";

export function trustedProxyConfiguration(path: string): TrustedProxyConfiguration {
  const source = lstatSync(path);
  if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.size > 1_000_000 ||
    (source.mode & 0o077) !== 0
  )
    throw new Error(
      "Trusted proxy configuration must be an owner-only regular file no larger than 1 MB.",
    );
  const resolved = realpathSync(path);
  const metadata = lstatSync(resolved);
  if (!metadata.isFile())
    throw new Error(
      "Trusted proxy configuration must resolve to a regular file.",
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(resolved, "utf8")) as unknown;
  } catch {
    throw new Error("Trusted proxy configuration is invalid.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("Trusted proxy configuration is invalid.");
  const value = parsed as Partial<TrustedProxyConfiguration>;
  if (
    !Array.isArray(value.trustedSources) ||
    !Array.isArray(value.requiredHeaders) ||
    !Array.isArray(value.allowUsers) ||
    !Array.isArray(value.maximumScopes) ||
    typeof value.userHeader !== "string" ||
    typeof value.allowLoopback !== "boolean"
  )
    throw new Error("Trusted proxy configuration is invalid.");
  return value as TrustedProxyConfiguration;
}
