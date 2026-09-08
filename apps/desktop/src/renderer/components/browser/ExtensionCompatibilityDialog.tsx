import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type {
	ChromeWebStoreExtensionInspection,
	ExtensionCapabilityStatus,
	ExtensionCompatibilityState,
} from "@kestrel/shared-types";
import { Icon } from "../Icon";
import { KESTREL_STATE_TRANSITION } from "../../motion-contract";
import { chromeWebStoreInstallErrorMessage } from "./chrome-web-store-install";
import "./extension-compatibility-dialog.css";

const STATE_LABELS: Record<ExtensionCompatibilityState, string> = {
	verified: "Verified",
	expected_compatible: "Expected compatible",
	partial: "Partial support",
	unsupported: "Unsupported",
	unknown: "Not yet verified",
};

const CAPABILITY_LABELS: Record<ExtensionCapabilityStatus, string> = {
	full: "Supported",
	partial: "Partial",
	emulated: "Emulated",
	unsupported: "Unsupported",
	unknown: "Unverified",
};

export function ExtensionCompatibilityDialog({
	inspection,
	onCancel,
	onInstall,
}: {
	inspection: ChromeWebStoreExtensionInspection;
	onCancel(): void;
	onInstall(inspectionId: string): Promise<void>;
}) {
	const reducedMotion = useReducedMotion() ?? false;
	const dialogRef = useRef<HTMLDivElement | null>(null);
	const installRef = useRef<HTMLButtonElement | null>(null);
	const closeRef = useRef<HTMLButtonElement | null>(null);
	const busyRef = useRef(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	busyRef.current = busy;
	const compatibility = inspection.compatibility;
	const blocked = compatibility.state === "unsupported";
	const findings = useMemo(
		() =>
			compatibility.findings.filter(
				(finding) => finding.status !== "full" || finding.evidence !== "manifest",
			),
		[compatibility.findings],
	);

	useEffect(() => {
		const returnFocus =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const frame = window.requestAnimationFrame(() =>
			(installRef.current ?? closeRef.current)?.focus(),
		);
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				if (event.defaultPrevented || busyRef.current) return;
				event.preventDefault();
				onCancel();
				return;
			}
			if (event.key !== "Tab" || !dialogRef.current) return;
			const focusable = Array.from(
				dialogRef.current.querySelectorAll<HTMLElement>(
					"button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])",
				),
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable.at(-1);
			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last?.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first?.focus();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => {
			window.cancelAnimationFrame(frame);
			document.removeEventListener("keydown", onKeyDown);
			returnFocus?.focus();
		};
	}, [onCancel]);

	async function install() {
		if (busy || blocked) return;
		setBusy(true);
		setError("");
		try {
			await onInstall(inspection.inspectionId);
		} catch (cause) {
			setError(chromeWebStoreInstallErrorMessage(cause));
			setBusy(false);
		}
	}

	return (
		<motion.div
			className="extension-compatibility-overlay"
			role="presentation"
			initial={reducedMotion ? false : { opacity: 0 }}
			animate={{ opacity: 1 }}
			exit={
				reducedMotion
					? { opacity: 1, pointerEvents: "none" }
					: { opacity: 0, pointerEvents: "none" }
			}
			transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			onMouseDown={(event: MouseEvent<HTMLDivElement>) => {
				if (event.target === event.currentTarget && !busy) onCancel();
			}}
		>
			<motion.div
				ref={dialogRef}
				className="extension-compatibility-dialog"
				role="dialog"
				aria-modal="true"
				aria-labelledby="extension-compatibility-title"
				aria-describedby="extension-compatibility-description"
				aria-busy={busy}
				initial={reducedMotion ? false : { opacity: 0, y: 8, scale: 0.985 }}
				animate={{ opacity: 1, y: 0, scale: 1 }}
				exit={
					reducedMotion
						? { opacity: 1, y: 0, scale: 1 }
						: { opacity: 0, y: 8, scale: 0.985 }
				}
				transition={reducedMotion ? { duration: 0 } : KESTREL_STATE_TRANSITION}
			>
				<header className="extension-compatibility-header">
					<div className="extension-compatibility-heading">
						<span className="extension-compatibility-mark" aria-hidden="true">
							<Icon name={blocked ? "warning" : "extensions"} />
						</span>
						<span>
							<strong id="extension-compatibility-title">
								{blocked ? "Extension cannot be installed" : "Review extension"}
							</strong>
							<small>
								{inspection.name} · version {inspection.version}
							</small>
						</span>
					</div>
					<button
						ref={closeRef}
						type="button"
						className="extension-compatibility-close"
						aria-label="Close extension review"
						onClick={onCancel}
						disabled={busy}
					>
						<Icon name="close" />
					</button>
				</header>

				<div className="extension-compatibility-body">
					<div className="extension-compatibility-state-row">
						<span
							className={`extension-compatibility-state is-${compatibility.state}`}
						>
							{STATE_LABELS[compatibility.state]}
						</span>
						<span className="extension-compatibility-source">Verified Chrome Web Store package</span>
					</div>
					<p id="extension-compatibility-description" className="extension-compatibility-summary">
						{compatibility.summary}
					</p>

					<section className="extension-compatibility-section" aria-labelledby="extension-permissions-title">
						<div className="extension-compatibility-section-heading">
							<h3 id="extension-permissions-title">Declared access</h3>
							<small>Read from the signed package before installation.</small>
						</div>
						{compatibility.declaredRequirements.length === 0 ? (
							<p className="extension-compatibility-empty">No declared permissions or host access.</p>
						) : (
							<ul className="extension-compatibility-chips">
								{compatibility.declaredRequirements.map((requirement) => (
									<li key={requirement}>{requirement}</li>
								))}
							</ul>
						)}
					</section>

					<section className="extension-compatibility-section" aria-labelledby="extension-capabilities-title">
						<div className="extension-compatibility-section-heading">
							<h3 id="extension-capabilities-title">Compatibility evidence</h3>
							<small>Electron support is not the same as Chrome support.</small>
						</div>
						{findings.length === 0 ? (
							<p className="extension-compatibility-empty">No incompatible Chrome API use was detected in the scanned package.</p>
						) : (
							<ul className="extension-compatibility-findings">
								{findings.map((finding) => (
									<li key={`${finding.capability}-${finding.evidence}`}>
										<span className={`extension-capability-label is-${finding.status}`}>
											{CAPABILITY_LABELS[finding.status]}
										</span>
										<span>
											<strong>{finding.capability}</strong>
											<small>{finding.reason}</small>
										</span>
									</li>
								))}
							</ul>
						)}
					</section>

					{(compatibility.staticAnalysis.truncated ||
						compatibility.staticAnalysis.dynamicApiAccessDetected) && (
						<p className="extension-compatibility-analysis-note">
							<Icon name="info" />
							Static analysis scanned {compatibility.staticAnalysis.filesScanned} source file
							{compatibility.staticAnalysis.filesScanned === 1 ? "" : "s"}
							{compatibility.staticAnalysis.dynamicApiAccessDetected
								? " and found dynamic API access."
								: "."}
						</p>
					)}
					{error && (
						<p className="extension-compatibility-error" role="alert">
							<Icon name="warning" />
							{error}
						</p>
					)}
				</div>
				<footer className="extension-compatibility-footer">
					<button
						type="button"
						className="extension-compatibility-secondary"
						onClick={onCancel}
						disabled={busy}
					>
						{blocked ? "Close" : "Cancel"}
					</button>
					{!blocked && (
						<button
							ref={installRef}
							type="button"
							className="extension-compatibility-primary"
							onClick={() => void install()}
							disabled={busy}
						>
							{busy ? "Installing…" : "Install reviewed extension"}
						</button>
					)}
				</footer>
			</motion.div>
		</motion.div>
	);
}
