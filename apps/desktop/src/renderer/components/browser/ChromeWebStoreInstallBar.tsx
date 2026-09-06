import {
	parseChromeWebStoreListingUrl,
	type InstalledExtension,
} from "@kestrel/shared-types";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { chromeWebStoreInstallErrorMessage } from "./chrome-web-store-install";
import "./chrome-web-store-install-bar.css";

type InstallPhase = "idle" | "reviewing" | "error";

export function ChromeWebStoreInstallBar({
	url,
	onReview,
	installedExtension,
}: {
	url: string;
	onReview(extensionId: string): Promise<void>;
	installedExtension: InstalledExtension | null;
}) {
	const extensionId = parseChromeWebStoreListingUrl(url);
	const [phase, setPhase] = useState<InstallPhase>("idle");
	const [message, setMessage] = useState("");
	const attemptRef = useRef(0);

	useEffect(() => {
		attemptRef.current += 1;
		setPhase("idle");
		setMessage("");
	}, [extensionId]);

	if (!extensionId) return null;
	const installExtensionId = extensionId;
	const installed = installedExtension?.id === extensionId;

	async function inspect() {
		const attempt = ++attemptRef.current;
		setPhase("reviewing");
		setMessage("");
		try {
			await onReview(installExtensionId);
			if (attemptRef.current !== attempt) return;
			setPhase("idle");
		} catch (cause) {
			if (attemptRef.current !== attempt) return;
			setPhase("error");
			setMessage(chromeWebStoreInstallErrorMessage(cause));
		}
	}

	const icon = installed ? "check" : phase === "error" ? "warning" : "extensions";
	const title =
		installed
			? "Added to Kestrel"
			: phase === "reviewing"
			? "Reviewing signed package…"
			: phase === "error"
				? "Extension was not reviewed"
				: "Install this extension in Kestrel";
	const detail =
		installed
			? installedExtension?.compatibility?.summary ??
				"Installed from the reviewed Chrome Web Store package."
			: message ||
				"Google's Add to Chrome button only works in Chrome. Kestrel verifies the package, shows its declared access, then asks before installing.";

	return (
		<section
			className={`chrome-web-store-install-bar is-${installed ? "installed" : phase}`}
			aria-label="Chrome Web Store installation"
			aria-busy={phase === "reviewing"}
		>
			<span className="chrome-web-store-install-icon" aria-hidden="true">
				<Icon name={icon} />
			</span>
			<span
				className="chrome-web-store-install-copy"
				aria-live={phase === "error" ? "assertive" : "polite"}
			>
				<strong>{title}</strong>
				<small>{detail}</small>
			</span>
			{!installed && (
				<div className="chrome-web-store-install-actions">
					<button
						type="button"
						className="primary"
						disabled={phase === "reviewing"}
						onClick={() => void inspect()}
					>
						{phase === "reviewing"
							? "Reviewing…"
							: phase === "error"
								? "Try again"
								: "Review & add"}
					</button>
				</div>
			)}
		</section>
	);
}
