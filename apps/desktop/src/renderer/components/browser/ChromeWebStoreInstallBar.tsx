import {
	parseChromeWebStoreListingUrl,
	type InstalledExtension,
} from "@kestrel/shared-types";
import { useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { chromeWebStoreInstallErrorMessage, openNativeChromeWebStore } from "./chrome-web-store-install";
import "./chrome-web-store-install-bar.css";

type InstallPhase = "idle" | "reviewing" | "opening-native" | "native-opened" | "error";

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
	const pendingRef = useRef(false);

	useEffect(() => {
		attemptRef.current += 1;
		setPhase("idle");
		setMessage("");
		return () => { attemptRef.current += 1; };
	}, [extensionId]);

	if (!extensionId) return null;
	const installExtensionId = extensionId;
	const installed = installedExtension?.id === extensionId;

	async function inspect() {
		if (pendingRef.current) return;
		pendingRef.current = true;
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
		} finally {
			pendingRef.current = false;
		}
	}

	async function openNative() {
		if (pendingRef.current) return;
		pendingRef.current = true;
		const attempt = ++attemptRef.current;
		setPhase("opening-native");
		setMessage("");
		try {
			await openNativeChromeWebStore(window.kestrel.request, url);
			if (attemptRef.current !== attempt) return;
			setPhase("native-opened");
		} catch {
			if (attemptRef.current !== attempt) return;
			setPhase("error");
			setMessage("The native browser could not open. Check its availability in Extensions and try again.");
		} finally {
			pendingRef.current = false;
		}
	}
	const busy = phase === "reviewing" || phase === "opening-native";

	const icon = installed ? "check" : phase === "error" ? "warning" : "extensions";
	const title =
		phase === "error" ? "Extension action could not finish"
			: phase === "opening-native" ? "Opening native browser…"
			: phase === "native-opened" ? "Opened in native browser"
			: installed
			? "Added to embedded browser"
			: phase === "reviewing"
			? "Reviewing signed package…"
			: "Install with native Chromium";
	const detail =
		message || (installed
			? installedExtension?.compatibility?.summary ??
				"Installed from the reviewed Chrome Web Store package."
			: "Open the native browser to use Add to Chrome and Chromium's permission prompt. Extensions use its separate, persistent profile.");

	return (
		<section
			className={`chrome-web-store-install-bar is-${installed ? "installed" : phase}`}
			aria-label="Chrome Web Store installation"
			aria-busy={busy}
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
					<button type="button" className="primary" disabled={busy} onClick={() => void openNative()}>
						{phase === "opening-native" ? "Opening…" : "Open in native browser"}
					</button>
					{!installed && (
					<button
						type="button"
						disabled={busy}
						onClick={() => void inspect()}
					>
						{phase === "reviewing"
							? "Reviewing…"
							: "Review for embedded browser"}
					</button>
					)}
				</div>
		</section>
	);
}
