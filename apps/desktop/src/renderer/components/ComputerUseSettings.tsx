import {
	ComputerUseStatusSchema,
	type ComputerUsePermissionState,
	type ComputerUseStatus,
} from "@kestrel/shared-types";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./Icon";

const PERMISSION_LABELS: Record<ComputerUsePermissionState, string> = {
	granted: "Granted",
	"not-determined": "Not set",
	denied: "Denied",
	restricted: "Restricted",
	"not-granted": "Not granted",
	unavailable: "Unavailable",
	unknown: "Unknown",
};

function errorMessage(cause: unknown, fallback: string): string {
	return cause instanceof Error ? cause.message : fallback;
}

function parseStatus(
	response: Awaited<ReturnType<typeof window.kestrel.request>>,
): ComputerUseStatus {
	if (!response.ok) throw new Error(response.error);
	if (!("computerUseStatus" in response))
		throw new Error("Whole-desktop computer-use status was not returned.");
	return ComputerUseStatusSchema.parse(response.computerUseStatus);
}

function permissionTone(state: ComputerUsePermissionState): string {
	return state === "granted" ? "granted" : "attention";
}

function PermissionStatus({
	icon,
	label,
	state,
	ready,
}: {
	icon: string;
	label: string;
	state: ComputerUsePermissionState;
	ready: boolean;
}) {
	return (
		<div className={`computer-use-permission ${permissionTone(state)}`}>
			<Icon name={icon} />
			<span>
				<strong>{label}</strong>
				<small>
					{ready ? "Ready" : PERMISSION_LABELS[state]}
				</small>
			</span>
		</div>
	);
}

export function ComputerUseSettings() {
	const [status, setStatus] = useState<ComputerUseStatus | null>(null);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");

	const refresh = useCallback(async () => {
		setBusy("status");
		setError("");
		try {
			setStatus(
				parseStatus(
					await window.kestrel.request({ type: "computer-use-status" }),
				),
			);
		} catch (cause) {
			setError(errorMessage(cause, "Could not read computer-use status."));
		} finally {
			setBusy("");
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	async function toggle() {
		if (!status) return;
		setBusy("toggle");
		setError("");
		try {
			setStatus(
				parseStatus(
					await window.kestrel.request({
						type: "computer-use-update",
						enabled: !status.enabled,
					}),
				),
			);
		} catch (cause) {
			setError(errorMessage(cause, "Computer-use preference could not be saved."));
		} finally {
			setBusy("");
		}
	}

	async function openPrivacySettings(
		surface: "screen-recording" | "accessibility",
	) {
		setBusy(surface);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "computer-use-open-settings",
				surface,
			});
			if (!response.ok) throw new Error(response.error);
		} catch (cause) {
			setError(errorMessage(cause, "System Settings could not be opened."));
		} finally {
			setBusy("");
		}
	}

	return (
		<article
			className="setting-row computer-use-setting"
			id="setting-agent-computer-use"
			aria-labelledby="computer-use-title"
		>
			<div className="computer-use-content">
				<div className="computer-use-heading">
					<strong id="computer-use-title">Whole-desktop computer use</strong>
					<span className={`status ${status?.enabled ? "status-pending" : ""}`}>
						{status
							? status.platform !== "darwin"
								? "Unavailable"
								: status.enabled
									? "Enabled"
									: "Off"
							: "Loading"}
					</span>
				</div>
				<p>
					Let Kestrel inspect and control other Mac apps with explicit approval. This
					powerful surface is off by default and stays separate from the isolated and
					visible Kestrel browser.
				</p>
				{status ? (
					<div className="computer-use-permissions" aria-label="macOS permission status">
						<PermissionStatus
							icon="screenshot"
							label="Screen Recording"
							state={status.screenRecording}
							ready={status.captureReady}
						/>
						<PermissionStatus
							icon="safety"
							label="Accessibility"
							state={status.accessibility}
							ready={status.controlReady}
						/>
					</div>
				) : (
					<p className="computer-use-loading" role="status">
						Checking the native permission state…
					</p>
				)}
				<p className="computer-use-boundary">
					Kestrel never requests these permissions from this status check. Even when
					enabled, approvals still pause consequential actions; this does not purchase,
					create accounts, or bypass a CAPTCHA.
				</p>
				{error && <small className="computer-use-error" role="alert">{error}</small>}
			</div>
			<div className="computer-use-actions">
				<button
					className={`switch ${status?.enabled ? "on" : ""}`}
					type="button"
					role="switch"
					aria-label="Enable whole-desktop computer use"
					aria-checked={status?.enabled ?? false}
					disabled={!status || status.platform !== "darwin" || Boolean(busy)}
					onClick={() => void toggle()}
				>
					<span />
				</button>
				<div className="computer-use-button-row">
					<button
						className="button secondary"
						type="button"
						disabled={!status || status.platform !== "darwin" || Boolean(busy)}
						onClick={() => void openPrivacySettings("screen-recording")}
					>
						{busy === "screen-recording" ? "Opening…" : "Open Screen Recording"}
					</button>
					<button
						className="button secondary"
						type="button"
						disabled={!status || status.platform !== "darwin" || Boolean(busy)}
						onClick={() => void openPrivacySettings("accessibility")}
					>
						{busy === "accessibility" ? "Opening…" : "Open Accessibility"}
					</button>
					<button
						className="quiet-link computer-use-refresh"
						type="button"
						disabled={Boolean(busy)}
						onClick={() => void refresh()}
					>
						{busy === "status" ? "Refreshing…" : "Refresh status"}
					</button>
				</div>
			</div>
		</article>
	);
}
