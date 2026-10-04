import { Fragment, useState } from "react";
import { embeddedBuildIdentity, type DesktopBuildProvenance } from "@kestrel/shared-types";

export function BuildProvenance() {
  const [value, setValue] = useState<DesktopBuildProvenance | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function refresh() {
    setBusy(true); setError("");
    try {
      const response = await window.kestrel.request({ type: "build-provenance", rendererBuild: embeddedBuildIdentity() });
      if (!response.ok || !("buildProvenance" in response)) throw new Error("Build information is unavailable.");
      setValue(response.buildProvenance);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Build information is unavailable."); }
    finally { setBusy(false); }
  }
  return <details className="build-provenance" onToggle={event => {
    if (event.currentTarget.open && !value && !busy) void refresh();
  }}>
    <summary>Running build</summary>
    <p>Check which source and components this window is running. Build information stays local.</p>
    <button className="button secondary" type="button" disabled={busy} onClick={() => void refresh()}>{busy ? "Checking…" : "Refresh build information"}</button>
    {value && <div role="status">
      <p>Components: {value.componentState}. Installation: {value.installationState.replaceAll("-", " ")}.</p>
      <dl>
        <dt>Source commit</dt><dd>{value.main?.sourceCommit ?? "Unknown"}</dd>
        <dt>Source state</dt><dd>{value.main ? value.main.dirty ? "Uncommitted changes" : "Clean committed source" : "Unknown"}</dd>
        <dt>Source digest</dt><dd>{value.main?.sourceDigest ?? "Unknown"}</dd>
        <dt>Executable</dt><dd>{value.executablePath}</dd>
        <dt>Launched</dt><dd>{value.launchedAt}</dd>
        {(["main", "renderer", "preload", "core", "installed"] as const).map(component =>
          <Fragment key={component}><dt>{component} build</dt><dd>{value[component]?.buildId ?? "Unverified"}</dd></Fragment>)}
      </dl>
    </div>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
