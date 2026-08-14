import type {
	CoreResponse,
	PluginMutation,
	PluginSummary,
	RendererRequest,
	TrustedPluginPublisher,
} from "@kestrel/shared-types";
import { useEffect, useState } from "react";

export function PluginSettings() {
	const [plugins, setPlugins] = useState<PluginSummary[]>([]);
	const [publishers, setPublishers] = useState<TrustedPluginPublisher[]>([]);
	const [pluginError, setPluginError] = useState("");
	const [pluginNotice, setPluginNotice] = useState("");
	const [pluginRecoveryPath, setPluginRecoveryPath] = useState("");
	const [pluginBusy, setPluginBusy] = useState(false);
	useEffect(() => {
		void window.kestrel.request({ type: "plugin-list" }).then((raw) => {
			const response = raw as CoreResponse;
			if (response.ok) setPlugins(response.plugins ?? []);
			else setPluginError(response.error);
		});
		void window.kestrel
			.request({ type: "plugin-get-publishers" })
			.then((response) => {
				if (response.ok && "pluginPublishers" in response)
					setPublishers(response.pluginPublishers);
			});
	}, []);
	async function togglePlugin(plugin: PluginSummary) {
		setPluginError("");
		const response = (await window.kestrel.request({
			type: "plugin-set-enabled",
			name: plugin.name,
			enabled: !plugin.enabled,
		})) as CoreResponse;
		if (response.ok) setPlugins(response.plugins ?? []);
		else setPluginError(response.error);
	}
	async function togglePluginMcp(plugin: PluginSummary) {
		setPluginError("");
		const response = (await window.kestrel.request({
			type: plugin.mcpConnected
				? "plugin-disconnect-mcp"
				: "plugin-connect-mcp",
			name: plugin.name,
		})) as CoreResponse;
		if (response.ok) setPlugins(response.plugins ?? []);
		else setPluginError(response.error);
	}
	async function importPublisher() {
		setPluginBusy(true);
		setPluginError("");
		setPluginNotice("");
		try {
			const response = await window.kestrel.request({
				type: "plugin-import-publisher",
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Publisher import failed.",
				);
			if ("pluginPublishers" in response)
				setPublishers(response.pluginPublishers);
		} catch (error) {
			setPluginError(
				error instanceof Error ? error.message : "Publisher import failed.",
			);
		} finally {
			setPluginBusy(false);
		}
	}
	async function removePublisher(keyId: string) {
		setPluginBusy(true);
		setPluginError("");
		setPluginNotice("");
		try {
			const response = await window.kestrel.request({
				type: "plugin-remove-publisher",
				keyId,
			});
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Publisher removal failed.",
				);
			if ("pluginPublishers" in response)
				setPublishers(response.pluginPublishers);
		} catch (error) {
			setPluginError(
				error instanceof Error ? error.message : "Publisher removal failed.",
			);
		} finally {
			setPluginBusy(false);
		}
	}
	async function mutatePlugin(
		request: Extract<
			RendererRequest,
			{
				type:
					| "plugin-install-bundle"
					| "plugin-update-bundle"
					| "plugin-remove-installed"
					| "plugin-restore-removed";
			}
		>,
	) {
		setPluginBusy(true);
		setPluginError("");
		setPluginNotice("");
		try {
			const response = await window.kestrel.request(request);
			if (!response.ok)
				throw new Error(
					"error" in response ? response.error : "Plugin operation failed.",
				);
			if ("plugins" in response) setPlugins(response.plugins ?? []);
			if ("pluginMutation" in response) {
				const mutation: PluginMutation = response.pluginMutation;
				setPluginNotice(
					`${mutation.name} ${mutation.version}: ${mutation.action} complete.`,
				);
				setPluginRecoveryPath(mutation.recoveryPath ?? "");
			}
		} catch (error) {
			setPluginError(
				error instanceof Error ? error.message : "Plugin operation failed.",
			);
		} finally {
			setPluginBusy(false);
		}
	}

	return (
		<>
			<article className="setting-row">
				<div>
					<strong>Plugin supply chain</strong>
					<p>
						Only Ed25519-signed bundles from publishers you explicitly trust can
						be installed or updated.
					</p>
					{publishers.length > 0 ? (
						<ul className="workspace-grants">
							{publishers.map((publisher) => (
								<li key={publisher.keyId}>
									<span title={publisher.fingerprint}>
										{publisher.keyId} · {publisher.fingerprint.slice(0, 12)}…
									</span>
									<button
										className="quiet-link"
										disabled={pluginBusy}
										onClick={() => void removePublisher(publisher.keyId)}
									>
										Untrust
									</button>
								</li>
							))}
						</ul>
					) : (
						<small>No plugin publishers are trusted yet.</small>
					)}
					{pluginNotice && <small role="status">{pluginNotice}</small>}
					{pluginError && <small role="alert">{pluginError}</small>}
				</div>
				<div>
					<button
						className="button secondary"
						disabled={pluginBusy}
						onClick={() => void importPublisher()}
					>
						Trust publisher key
					</button>
					<button
						className="button secondary"
						disabled={pluginBusy || publishers.length === 0}
						onClick={() => void mutatePlugin({ type: "plugin-install-bundle" })}
					>
						Install signed plugin
					</button>
					<button
						className="button secondary"
						disabled={pluginBusy || publishers.length === 0}
						onClick={() => void mutatePlugin({ type: "plugin-update-bundle" })}
					>
						Update plugin
					</button>
					{pluginRecoveryPath && (
						<button
							className="button secondary"
							disabled={pluginBusy}
							onClick={() =>
								void mutatePlugin({
									type: "plugin-restore-removed",
									recoveryPath: pluginRecoveryPath,
								})
							}
						>
							Restore removed plugin
						</button>
					)}
				</div>
			</article>
			{plugins.map((plugin) => (
				<article className="setting-row" key={plugin.name}>
					<div>
						<strong>
							{plugin.interface?.displayName ?? plugin.name}{" "}
							<small>v{plugin.version}</small>
						</strong>
						<p>{plugin.interface?.shortDescription ?? plugin.description}</p>
						<small>
							{plugin.managed
								? "Managed signed bundle"
								: "External discovered bundle"}{" "}
							· {plugin.hasSkills ? "Skills" : "No skills"} ·{" "}
							{plugin.hasMcpServers
								? plugin.mcpConnected
									? "MCP connected"
									: "MCP available"
								: "No MCP"}{" "}
							·{" "}
							{plugin.hasDashboard
								? plugin.enabled
									? "Dashboard panels active"
									: "Dashboard panels available"
								: "No dashboard"}{" "}
							· permissions:{" "}
							{plugin.interface?.capabilities.join(", ") || "none declared"}
						</small>
					</div>
					<div>
						<button
							className="button secondary"
							aria-pressed={plugin.enabled}
							onClick={() => void togglePlugin(plugin)}
						>
							{plugin.enabled ? "Disable" : "Enable"}
						</button>
						{plugin.enabled && plugin.hasMcpServers && (
							<button
								className="button secondary"
								aria-pressed={plugin.mcpConnected}
								onClick={() => void togglePluginMcp(plugin)}
							>
								{plugin.mcpConnected ? "Disconnect MCP" : "Connect MCP"}
							</button>
						)}
						{plugin.managed && (
							<button
								className="button secondary"
								disabled={pluginBusy}
								onClick={() =>
									void mutatePlugin({
										type: "plugin-remove-installed",
										name: plugin.name,
									})
								}
							>
								Remove
							</button>
						)}
					</div>
				</article>
			))}
		</>
	);
}
