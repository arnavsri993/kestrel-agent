import {
	ComputerUseStatusSchema,
	type ComputerUsePermissionState,
	type ComputerUseStatus,
} from "@kestrel/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
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

type StatusPill = { label: string; className: string };

function statusPill(
	status: ComputerUseStatus | null,
	loadFailed: boolean,
): StatusPill {
	if (!status) {
		return loadFailed
			? { label: "Couldn\u2019t check", className: "" }
			: { label: "Checking", className: "" };
	}
	if (status.platform !== "darwin") return { label: "Unavailable", className: "" };
	if (!status.enabled) return { label: "Off", className: "" };
	if (status.captureReady && status.controlReady)
		return { label: "Ready", className: "status-executed" };
	return { label: "Needs permission", className: "status-pending" };
}

export function ComputerUseSettings() {
	const [status, setStatus] = useState<ComputerUseStatus | null>(null);
	const [busy, setBusy] = useState("");
	const [error, setError] = useState("");
	const [loadFailed, setLoadFailed] = useState(false);
	const busyRef = useRef("");
	const inFlightRef = useRef(false);
	const mountedRef = useRef(true);
	const statusRef = useRef<ComputerUseStatus | null>(null);
	statusRef.current = status;

	const updateBusy = useCallback((next: string) => {
		busyRef.current = next;
		setBusy(next);
	}, []);

	// `silent` refreshes (focus / visibility) never lock the controls and never
	// clobber an action error when a good status is already on screen.
	const refresh = useCallback(
		async (options: { silent?: boolean } = {}) => {
			const silent = options.silent === true;
			if (inFlightRef.current) return;
			if (silent && busyRef.current) return;
			inFlightRef.current = true;
			if (!silent) {
				updateBusy("status");
				setError("");
			}
			try {
				const next = parseStatus(
					await window.kestrel.request({ type: "computer-use-status" }),
				);
				if (!mountedRef.current) return;
				setStatus(next);
				setLoadFailed(false);
				if (silent) setError("");
			} catch (cause) {
				if (!mountedRef.current) return;
				setLoadFailed(true);
				if (!silent || !statusRef.current)
					setError(errorMessage(cause, "Could not read computer-use status."));
			} finally {
				inFlightRef.current = false;
				if (!silent && mountedRef.current) updateBusy("");
			}
		},
		[updateBusy],
	);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		return () => {
			mountedRef.current = false;
		};
	}, [refresh]);

	// Re-check (read-only, never requests permission) when the person returns
	// from System Settings.
	useEffect(() => {
		const onFocus = () => void refresh({ silent: true });
		const onVisibility = () => {
			if (document.visibilityState === "visible") void refresh({ silent: true });
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [refresh]);

	const pill = statusPill(status, loadFailed);

	async function toggle() {
		if (!status) return;
		updateBusy("toggle");
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
			updateBusy("");
		}
	}

	async function openPrivacySettings(
		surface: "screen-recording" | "accessibility",
	) {
		updateBusy(surface);
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
			updateBusy("");
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
					<span className={`status ${pill.className}`.trim()}>{pill.label}</span>
				</div>
				<p>
					Let Kestrel inspect and control Mac apps after you approve each action.
					It is off by default and separate from the Kestrel browser.
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
				) : loadFailed ? (
					<p className="computer-use-loading" role="status">
						Couldn’t check permissions. Use Retry to try again.
					</p>
				) : (
					<p className="computer-use-loading" role="status">
						Checking permissions…
					</p>
				)}
				<p className="computer-use-boundary">
					This check never requests permission. Even when enabled, approvals still
					pause consequential actions; Kestrel cannot purchase, create accounts, or
					bypass a CAPTCHA.
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
						{busy === "status"
							? "Refreshing…"
							: loadFailed && !status
								? "Retry"
								: "Refresh status"}
					</button>
				</div>
			</div>
		</article>
	);
}
