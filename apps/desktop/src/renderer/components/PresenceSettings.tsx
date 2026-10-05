import type {
	ChannelInteractionConfiguration,
	ChannelSummary,
	CoreResponse,
	PresenceEntry,
} from "@kestrel/shared-types";
import { useEffect, useRef, useState } from "react";

export function PresenceSettings() {
	const [entries, setEntries] = useState<PresenceEntry[]>([]);
	const [channels, setChannels] = useState<ChannelSummary[]>([]);
	const [configuration, setConfiguration] =
		useState<ChannelInteractionConfiguration | null>(null);
	const [busy, setBusy] = useState(false);
	const [notice, setNotice] = useState("");
	const [error, setError] = useState("");
	const [policyOpen, setPolicyOpen] = useState<boolean | null>(null);
	const draftDirtyRef = useRef(false);
	const savingRef = useRef(false);
	const interactionRevisionRef = useRef(0);

	useEffect(() => {
		let disposed = false;
		let latestLoad = 0;
		const load = async () => {
			const requestId = ++latestLoad;
			const interactionRevision = interactionRevisionRef.current;
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
				if (disposed || requestId !== latestLoad) return;
				setEntries(presence.presence ?? []);
				const nextChannels = channel.channels ?? [];
				setChannels(nextChannels);
				setPolicyOpen((current) => current ?? nextChannels.length > 0);
				// Presence still refreshes while a draft is open, but policy reads
				// started before an edit or around a save cannot replace that draft.
				if (
					!draftDirtyRef.current &&
					!savingRef.current &&
					interactionRevision === interactionRevisionRef.current
				) {
					setConfiguration(interaction.channelInteractionConfiguration ?? null);
				}
			} catch (cause) {
				if (
					!disposed &&
					requestId === latestLoad &&
					!savingRef.current &&
					interactionRevision === interactionRevisionRef.current
				)
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

	function editConfiguration(next: ChannelInteractionConfiguration) {
		if (savingRef.current) return;
		draftDirtyRef.current = true;
		interactionRevisionRef.current += 1;
		setConfiguration(next);
	}

	async function save() {
		if (!configuration || savingRef.current) return;
		savingRef.current = true;
		interactionRevisionRef.current += 1;
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
			draftDirtyRef.current = false;
			setConfiguration(response.channelInteractionConfiguration);
			setNotice("Channel interaction policy saved.");
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Channel interaction policy could not be saved.",
			);
		} finally {
			// Also invalidate reads started during the save, even if they finish
			// after its response has made the draft clean again.
			interactionRevisionRef.current += 1;
			savingRef.current = false;
			setBusy(false);
		}
	}

	return (
		<>
			<article className="setting-row presence-setting">
				<div>
					<strong>Connected instances</strong>
					{entries.length === 0 ? (
						<small>No instances are reporting right now.</small>
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
						<details
							className="settings-disclosure channel-interaction-setup"
							open={policyOpen ?? false}
							onToggle={(event) => setPolicyOpen(event.currentTarget.open)}
						>
							<summary>Channel policy settings</summary>
							<div className="channel-interaction-grid">
								<label>
									Progress drafts
									<select
										aria-label="Channel progress mode"
										value={configuration.progressMode}
										disabled={busy}
										onChange={(event) =>
											editConfiguration({
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
											editConfiguration({
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
											editConfiguration({
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
											editConfiguration({
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
							<button
								className="button secondary"
								disabled={busy || !configuration}
								onClick={() => void save()}
							>
								{busy ? "Saving…" : "Save channel policy"}
							</button>
						</details>
					)}
					{notice && <small role="status">{notice}</small>}
					{error && <small role="alert">{error}</small>}
				</div>
			</article>
		</>
	);
}
