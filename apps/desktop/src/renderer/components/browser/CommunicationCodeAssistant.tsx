import {
	isLoginCodeChallenge,
	type CommunicationCodeScan,
	type CommunicationSourceStatus,
	type UserBrowserPageContext,
} from "@kestrel/shared-types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { UserBrowserController } from "../../browser/useUserBrowser";
import { Icon } from "../Icon";

function sourceSummary(sources: CommunicationSourceStatus[]): string {
	const connected = sources.filter((source) => source.state === "connected");
	return connected.length
		? `${connected.length} connected source${connected.length === 1 ? "" : "s"}`
		: "No message source connected";
}

function sourceDetail(source: CommunicationSourceStatus): string {
	if (source.state === "connected") return source.account ?? source.label;
	return source.detail;
}

export function CommunicationCodeAssistant({
	browser,
	enabled,
	onOpenConnections,
}: {
	browser: UserBrowserController;
	enabled: boolean;
	onOpenConnections(): void;
}) {
	const activeTab = browser.state?.tabs.find(
		(tab) => tab.id === browser.state?.activeTabId,
	);
	const [context, setContext] = useState<UserBrowserPageContext>();
	const [scan, setScan] = useState<CommunicationCodeScan>();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [usedCandidate, setUsedCandidate] = useState("");
	const promptKeyRef = useRef("");

	const challenge = Boolean(context && isLoginCodeChallenge(context));
	const tabKey = `${activeTab?.id ?? ""}:${activeTab?.url ?? ""}`;
	useEffect(() => {
		if (!enabled || !activeTab?.url || activeTab.loading || activeTab.error) {
			setContext(undefined);
			setScan(undefined);
			promptKeyRef.current = "";
			return;
		}
		let cancelled = false;
		const check = async () => {
			const next = await browser.pageContext(activeTab.id);
			if (cancelled) return;
			setContext(next);
			if (!next || !isLoginCodeChallenge(next)) {
				setScan(undefined);
				promptKeyRef.current = "";
				return;
			}
			const key = `${next.tabId}:${next.url}`;
			if (promptKeyRef.current !== key) {
				promptKeyRef.current = key;
				void window.kestrel
					.request({ type: "communication-code-notify", tabId: next.tabId })
					.catch(() => undefined);
			}
		};
		void check();
		const timer = window.setInterval(() => void check(), 2_000);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [activeTab?.error, activeTab?.id, activeTab?.loading, activeTab?.url, browser, enabled]);

	useEffect(() => {
		setScan(undefined);
		setError("");
		setUsedCandidate("");
	}, [tabKey]);

	const canShow = enabled && challenge && Boolean(activeTab);
	const activeSources = useMemo(
		() => scan?.sources.filter((source) => source.state === "connected") ?? [],
		[scan?.sources],
	);

	if (!canShow) return null;

	async function findCode() {
		if (!activeTab || busy) return;
		setBusy(true);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "communication-code-scan",
				tabId: activeTab.id,
			});
			if (!response.ok || !("communicationScan" in response))
				throw new Error(
					!response.ok && "error" in response
						? response.error
						: "Kestrel could not scan connected messages.",
				);
			setScan(response.communicationScan);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Kestrel could not scan connected messages.",
			);
		} finally {
			setBusy(false);
		}
	}

	async function useCode(
		candidateId: string,
	): Promise<void> {
		if (!scan || busy) return;
		setBusy(true);
		setUsedCandidate(candidateId);
		setError("");
		try {
			const response = await window.kestrel.request({
				type: "communication-code-use",
				scanId: scan.scanId,
				candidateId,
			});
			if (!response.ok || !("communicationCodeInserted" in response))
				throw new Error(
					!response.ok && "error" in response
						? response.error
						: "Kestrel could not use that code.",
				);
			setScan(undefined);
		} catch (cause) {
			setUsedCandidate("");
			setError(
				cause instanceof Error ? cause.message : "Kestrel could not use that code.",
			);
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className="communication-code-assistant" aria-label="Login code helper">
			<header>
				<div>
					<span className="communication-code-icon" aria-hidden="true">
						<Icon name="lock" />
					</span>
					<span>
						<strong>Verification code</strong>
						<small>{context?.title ?? "Current page"}</small>
					</span>
				</div>
				<span className="communication-code-live">On this page</span>
			</header>
			{!scan ? (
				<>
					<p>
						Find a recent code without sending message text to the agent. Use code
						only fills the field; it never submits.
					</p>
					<div className="communication-code-actions">
						<button className="button primary" type="button" disabled={busy} onClick={() => void findCode()}>
							{busy ? "Looking…" : "Find code"}
						</button>
						<button className="button secondary" type="button" onClick={onOpenConnections}>
							Connections
						</button>
					</div>
				</>
			) : (
				<>
					<p>{sourceSummary(scan.sources)} · last 30 minutes</p>
					{scan.candidates.length ? (
						<ul className="communication-code-results">
							{scan.candidates.map((candidate) => (
								<li key={candidate.id}>
									<div>
										<code>{candidate.code}</code>
										<small>
											{candidate.sourceLabel} · {candidate.subject || candidate.sender || "Recent message"}
										</small>
									</div>
									<button
										className="button primary"
										type="button"
										disabled={busy}
										onClick={() => void useCode(candidate.id)}
									>
										{usedCandidate === candidate.id ? "Using…" : "Use code"}
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="communication-code-empty">No recent code found in connected sources.</p>
					)}
					{activeSources.length === 0 && (
						<button className="button secondary" type="button" onClick={onOpenConnections}>
							Connect a message source
						</button>
					)}
					<button className="communication-code-rescan" type="button" disabled={busy} onClick={() => void findCode()}>
						Scan again
					</button>
				</>
			)}
			{scan?.sources.map((source) => (
				<small className={`communication-code-source ${source.state}`} key={source.id}>
					{source.label}: {sourceDetail(source)}
				</small>
			))}
			{error && <small className="communication-code-error" role="alert">{error}</small>}
		</section>
	);
}
