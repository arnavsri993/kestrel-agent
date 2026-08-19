import type {
	ChannelInteractionConfiguration,
	ChannelSummary,
	CoreResponse,
	PresenceEntry,
} from "@kestrel/shared-types";
import { useEffect, useState } from "react";

export function PresenceSettings() {
	const [entries, setEntries] = useState<PresenceEntry[]>([]);
	const [channels, setChannels] = useState<ChannelSummary[]>([]);
	const [configuration, setConfiguration] =
		useState<ChannelInteractionConfiguration | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");

	useEffect(() => {
		let disposed = false;
		const load = async () => {
			try {
				const [presenceRaw, channelRaw, interactionRaw] = await Promise.all([
					window.kestrel.request({ type: "presence-list" }),
					window.kestrel.request({ type: "channel-list" }),
					window.kestrel.request({ type: "channel-interaction-get" }),
				]);
				const presence = presenceRaw as CoreResponse;
				const channel = channelRaw as CoreResponse;
				const interaction = interactionRaw as CoreResponse;
				if (!presence.ok || !channel.ok || !interaction.ok)
					throw new Error(
						!presence.ok
							? presence.error
							: !channel.ok
								? channel.error
								: !interaction.ok
									? interaction.error
									: "Ambient settings failed.",
					);
				if (disposed) return;
				setEntries(presence.presence ?? []);
				setChannels(channel.channels ?? []);
				setConfiguration(interaction.channelInteractionConfiguration ?? null);
			} catch (cause) {
				if (!disposed)
					setError(
						cause instanceof Error
							? cause.message
							: "Presence could not be loaded.",
					);
			}
		};
		void load();
		const timer = window.setInterval(() => void load(), 15_000);
		return () => {
			disposed = true;
			window.clearInterval(timer);
		};
	}, []);

	async function save() {
		if (!configuration) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			const response = (await window.kestrel.request({
				type: "channel-interaction-set",
				configuration,
			})) as CoreResponse;
			if (!response.ok || !response.channelInteractionConfiguration)
				throw new Error(
					response.ok
						? "Channel interaction status was missing."
						: response.error,
				);
			setConfiguration(response.channelInteractionConfiguration);
			setNotice("Channel interaction policy saved.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Channel interaction policy could not be saved.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<>
			<article className="setting-row presence-setting">
				<div>
					<strong>Connected instances</strong>
					{entries.length === 0 ? (
						<small>No active instances.</small>
					) : (
						<ul className="presence-list">
							{entries.map((entry) => (
								<li key={entry.instanceId}>
									<span className={`presence-dot ${entry.status}`} />
									<span>
										<b>
											{entry.mode === "node"
												? "Local agent core"
												: entry.mode === "ui"
													? "Desktop window"
													: entry.mode}
										</b>
										<small>
											{entry.status} · last seen{" "}
											{new Date(entry.lastSeenAt).toLocaleTimeString([], {
												hour: "numeric",
												minute: "2-digit",
											})}
											{entry.reason ? ` · ${entry.reason}` : ""}
										</small>
									</span>
								</li>
							))}
						</ul>
					)}
					{error && <small role="alert">{error}</small>}
				</div>
				<span className="status">
					{entries.filter((entry) => entry.status === "active").length} active
				</span>
			</article>
			<article className="setting-row channel-interaction-setting">
				<div>
					<strong>Channel progress, typing, and reactions</strong>
					{channels.length > 0 ? (
						<small>
							{channels.filter((channel) => channel.editableProgress).length}{" "}
							editable ·{" "}
							{channels.filter((channel) => channel.typingSignals).length} with
							typing · {channels.filter((channel) => channel.reactions).length}{" "}
							with reactions · {channels.length} configured
						</small>
					) : (
						<small>
							No messaging channels configured yet. This policy will apply when
							you add one.
						</small>
					)}
					{configuration && (
						<div className="channel-interaction-grid">
							<label>
								Progress drafts
								<select
									aria-label="Channel progress mode"
									value={configuration.progressMode}
									disabled={busy}
									onChange={(event) =>
										setConfiguration({
											...configuration,
											progressMode: event.target
												.value as ChannelInteractionConfiguration["progressMode"],
										})
									}
								>
									<option value="off">Off</option>
									<option value="partial">Thinking + verify</option>
									<option value="block">Safe boundaries</option>
									<option value="progress">All phases</option>
								</select>
							</label>
							<label>
								Typing indicator
								<select
									aria-label="Channel typing mode"
									value={configuration.typingMode}
									disabled={busy}
									onChange={(event) =>
										setConfiguration({
											...configuration,
											typingMode: event.target
												.value as ChannelInteractionConfiguration["typingMode"],
										})
									}
								>
									<option value="never">Never</option>
									<option value="instant">Immediately</option>
									<option value="thinking">While thinking</option>
									<option value="message">After work starts</option>
								</select>
							</label>
							<label>
								Refresh interval
								<select
									aria-label="Typing refresh interval"
									value={configuration.typingIntervalSeconds}
									disabled={busy}
									onChange={(event) =>
										setConfiguration({
											...configuration,
											typingIntervalSeconds: Number(event.target.value),
										})
									}
								>
									{[4, 6, 8, 10, 15, 20].map((seconds) => (
										<option key={seconds} value={seconds}>
											{seconds} seconds
										</option>
									))}
								</select>
							</label>
							<label>
								Reaction level
								<select
									aria-label="Channel reaction level"
									value={configuration.reactionLevel}
									disabled={busy}
									onChange={(event) =>
										setConfiguration({
											...configuration,
											reactionLevel: event.target
												.value as ChannelInteractionConfiguration["reactionLevel"],
										})
									}
								>
									<option value="off">Off</option>
									<option value="ack">Acknowledgements</option>
									<option value="minimal">Minimal</option>
									<option value="extensive">Extensive</option>
								</select>
							</label>
						</div>
					)}
					{notice && <small role="status">{notice}</small>}
				</div>
				<button
					className="button secondary"
					disabled={busy || !configuration}
					onClick={() => void save()}
				>
					{busy ? "Saving…" : "Save channel policy"}
				</button>
			</article>
		</>
	);
}
