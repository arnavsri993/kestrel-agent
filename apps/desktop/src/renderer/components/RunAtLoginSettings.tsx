import { useCallback, useEffect, useRef, useState } from "react";

const approvalMessage = "Approve Kestrel in System Settings to finish changing run at login.";

export function RunAtLoginSettings() {
	const [login, setLogin] = useState<{ enabled: boolean; status: string } | null>(null);
	const [busy, setBusy] = useState(true);
	const [error, setError] = useState("");
	const inFlight = useRef(false);
	const mounted = useRef(false);

	const load = useCallback(async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError("");
		try {
			const response = await window.kestrel.request({ type: "get-system-state" });
			if (!mounted.current) return;
			if (!response.ok || !("launchAtLogin" in response)) {
				setError(!response.ok && "error" in response ? response.error : "Could not read run-at-login status.");
				return;
			}
			setLogin({ enabled: response.launchAtLogin, status: response.launchStatus });
			if (response.launchStatus === "requires-approval") setError(approvalMessage);
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not read run-at-login status.");
		} finally {
			inFlight.current = false;
			if (mounted.current) setBusy(false);
		}
	}, []);

	useEffect(() => {
		mounted.current = true;
		void load();
		return () => { mounted.current = false; };
	}, [load]);

	async function toggleLogin() {
		if (!login || inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setError("");
		try {
			const response = await window.kestrel.request({ type: "set-launch-at-login", enabled: !login.enabled });
			if (!mounted.current) return;
			// A failed native operation can still contain authoritative readback.
			if ("launchAtLogin" in response && typeof response.launchAtLogin === "boolean" &&
				"launchStatus" in response && typeof response.launchStatus === "string") {
				setLogin({ enabled: response.launchAtLogin, status: response.launchStatus });
				if (response.launchStatus === "requires-approval") setError(approvalMessage);
			}
			if (!response.ok) setError("error" in response ? response.error : "Could not change run at login.");
			else if (!("launchAtLogin" in response)) setError("Could not confirm run-at-login status.");
		} catch (cause) {
			if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not change run at login.");
		} finally {
			inFlight.current = false;
			if (mounted.current) setBusy(false);
		}
	}

	return (
		<article className="setting-row">
			<div>
				<strong>Run at login</strong>
				{busy && !login ? <small>Checking system status…</small> : login && <small>System status: {login.status}</small>}
				{error && <small role="alert">{error}</small>}
				{!login && !busy && <button type="button" onClick={() => void load()}>Retry</button>}
			</div>
			<button
				type="button"
				className={`switch ${login?.enabled ? "on" : ""}`}
				role="switch"
				aria-label="Run Kestrel at login"
				aria-checked={login?.enabled ?? false}
				disabled={busy || !login}
				onClick={() => void toggleLogin()}
			>
				<span />
			</button>
		</article>
	);
}
