import { z } from "zod";

export const BuildIdentitySchema = z.object({
  format: z.literal(1), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), dirty: z.boolean(),
  buildId: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BuildIdentity = z.infer<typeof BuildIdentitySchema>;

declare const __KESTREL_BUILD_IDENTITY__: unknown;
export function embeddedBuildIdentity(): BuildIdentity | null {
  if (typeof __KESTREL_BUILD_IDENTITY__ === "undefined") return null;
  const result = BuildIdentitySchema.safeParse(__KESTREL_BUILD_IDENTITY__);
  return result.success ? result.data : null;
}

export interface DesktopBuildProvenance {
  main: BuildIdentity | null;
  preload: BuildIdentity | null;
  renderer: BuildIdentity | null;
  core: BuildIdentity | null;
  installed: BuildIdentity | null;
  executablePath: string;
  launchedAt: string;
  componentState: "matching" | "mismatched" | "unverified";
  installationState: "running-installed-build" | "installed-build-changed" | "packaged-artifact" | "development" | "unverified";
}
