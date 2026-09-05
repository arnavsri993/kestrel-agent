import { parseChromeWebStoreListingUrl } from "@kestrel/shared-types";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { chromeWebStoreInstallErrorMessage } from "./chrome-web-store-install";
import "./chrome-web-store-install-bar.css";

type InstallPhase = "idle" | "confirming" | "installing" | "installed" | "error";

export function ChromeWebStoreInstallBar({ url }: { url: string }) {
	const extensionId = parseChromeWebStoreListingUrl(url);
	const [phase, setPhase] = useState<InstallPhase>("idle");
	const [message, setMessage] = useState("");
	const attemptRef = useRef(0);
	const primaryActionRef = useRef<HTMLButtonElement | null>(null);

	useEffect(() => {
		attemptRef.current += 1;
		setPhase("idle");
		setMessage("");
	}, [extensionId]);

	if (!extensionId) return null;
	const installExtensionId = extensionId;

	async function install() {
		const attempt = ++attemptRef.current;
		setPhase("installing");
		setMessage("");
		try {
			const response = await window.kestrel.request({
				type: "browser-install-extension-url",
				urlOrId: installExtensionId,
			});
			if (!response.ok || !("extension" in response)) {
				throw new Error(
					"error" in response
						? String(response.error)
						: "The extension installer returned no extension.",
				);
			}
			if (attemptRef.current !== attempt) return;
			setPhase("installed");
			setMessage(`${response.extension.name} is enabled in Kestrel.`);
		} catch (cause) {
			if (attemptRef.current !== attempt) return;
			setPhase("error");
			setMessage(chromeWebStoreInstallErrorMessage(cause));
		}
	}

	const icon = phase === "installed" ? "check" : phase === "error" ? "warning" : "extensions";
	const title =
		phase === "confirming"
			? "Add this extension to Kestrel?"
			: phase === "installed"
				? "Extension installed"
				: phase === "error"
					? "Extension was not installed"
					: "Install this extension in Kestrel";
	const detail =
		phase === "confirming"
			? "Extensions can read or change data on sites you visit. Continue only if you trust it."
			: message || "Google's Add to Chrome button only works in Chrome; use Kestrel's verified installer here.";

	return (
		<section
			className={`chrome-web-store-install-bar is-${phase}`}
			aria-label="Chrome Web Store installation"
			aria-busy={phase === "installing"}
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
			<div className="chrome-web-store-install-actions">
				{phase === "confirming" && (
					<button
						type="button"
						onClick={() => {
							setPhase("idle");
							window.requestAnimationFrame(() =>
								primaryActionRef.current?.focus(),
							);
						}}
					>
						Cancel
					</button>
				)}
				<button
					ref={primaryActionRef}
					type="button"
					className="primary"
					disabled={phase === "installing" || phase === "installed"}
					onClick={() => {
						if (phase === "idle") setPhase("confirming");
						else void install();
					}}
				>
					{phase === "installing"
						? "Installing…"
						: phase === "installed"
							? "Added"
							: phase === "confirming"
								? "Install extension"
								: phase === "error"
									? "Try again"
									: "Add to Kestrel"}
				</button>
			</div>
		</section>
	);
}
