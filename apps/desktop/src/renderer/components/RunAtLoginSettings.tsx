import { useEffect, useState } from "react";

export function RunAtLoginSettings() {
	const [login, setLogin] = useState<{
		enabled: boolean;
		status: string;
	} | null>(null);

	useEffect(() => {
		void window.kestrel
			.request({ type: "get-system-state" })
			.then((response) => {
				if ("launchAtLogin" in response)
					setLogin({
						enabled: response.launchAtLogin,
						status: response.launchStatus,
					});
			});
	}, []);

	async function toggleLogin() {
		const response = await window.kestrel.request({
			type: "set-launch-at-login",
			enabled: !login?.enabled,
		});
		if ("launchAtLogin" in response)
			setLogin({
				enabled: response.launchAtLogin,
				status: response.launchStatus,
			});
	}

	return (
		<article className="setting-row">
			<div>
				<strong>Run at login</strong>
				{login && <small>System status: {login.status}</small>}
			</div>
			<button
				className={`switch ${login?.enabled ? "on" : ""}`}
				role="switch"
				aria-label="Run Kestrel at login"
				aria-checked={login?.enabled ?? false}
				onClick={() => void toggleLogin()}
			>
				<span />
			</button>
		</article>
	);
}
